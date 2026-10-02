'use strict';

/*
 * SmishGuard browser client. All user-controlled text is rendered with textContent
 * (never innerHTML), which keeps the page safe from XSS together with the strict
 * Content-Security-Policy sent by the server.
 */
(function main() {
  const EXAMPLES = {
    en: 'AusPost: Your parcel could not be delivered due to an incomplete address. Pay the $2.99 redelivery fee within 24 hours at https://auspost-redelivery.top/track',
    vi: 'Tài khoản Vietcombank của quý khách đã bị khóa. Vui lòng đăng nhập ngay lập tức tại vcb-xacminh.top để xác minh.',
  };
  const LANGUAGES = { en: 'English', vi: 'Vietnamese' };
  const state = { token: null, user: null, lastMessage: '' };

  const $ = (id) => document.getElementById(id);
  const show = (node, visible) => node.classList.toggle('hidden', !visible);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = String(text);
    }
    return node;
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    const response = await fetch(path, { ...options, headers });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.error?.message || `Request failed (${response.status})`);
    }
    return body;
  }

  function renderSignals(signals) {
    const list = $('signals');
    list.replaceChildren();
    if (signals.length === 0) {
      const item = el('li', 'none');
      item.append(el('strong', '', 'No scam signals detected'));
      list.append(item);
      return;
    }
    for (const signal of signals) {
      const item = el('li');
      item.append(el('strong', '', `${signal.label} (+${signal.weight})`), el('span', '', signal.detail));
      list.append(item);
    }
  }

  function renderResult(result) {
    const box = $('result');
    box.className = `result ${result.level}`;
    $('score-value').textContent = String(result.score);
    $('meter-fill').style.width = `${result.score}%`;
    $('level-chip').className = `chip ${result.level}`;
    $('level-chip').textContent = `${result.level} risk`;
    $('lang-chip').textContent = LANGUAGES[result.language] || result.language;
    $('advice').textContent = result.advice;
    renderSignals(result.signals);
    $('report-status').textContent = '';
    show(box, true);
  }

  async function onCheck(event) {
    event.preventDefault();
    $('check-error').textContent = '';
    const message = $('message').value.trim();
    if (!message) {
      $('check-error').textContent = 'Paste a message to check.';
      return;
    }
    try {
      state.lastMessage = message;
      renderResult(await api('/api/check', { method: 'POST', body: JSON.stringify({ message }) }));
    } catch (err) {
      $('check-error').textContent = err.message;
    }
  }

  function renderStats(stats) {
    $('stats-total').textContent = String(stats.total);
    const max = Math.max(1, stats.byLevel.high, stats.byLevel.medium, stats.byLevel.low);
    const bars = $('stats-bars');
    bars.replaceChildren();
    for (const level of ['high', 'medium', 'low']) {
      const row = el('div', 'bar-row');
      const track = el('div', 'bar-track');
      const fill = el('div', `bar-fill ${level}`);
      fill.style.width = `${(stats.byLevel[level] / max) * 100}%`;
      track.append(fill);
      row.append(el('span', '', level), track, el('span', '', stats.byLevel[level]));
      bars.append(row);
    }
  }

  async function refreshStats() {
    try {
      renderStats(await api('/api/stats'));
    } catch {
      $('stats-total').textContent = '-';
    }
  }

  function reportRow(report) {
    const row = el('tr');
    const riskCell = el('td');
    riskCell.append(el('span', `chip ${report.riskLevel}`, `${report.riskLevel} ${report.riskScore}`));
    const actions = el('td');
    const remove = el('button', 'btn ghost small', 'Delete');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteReport(report.id));
    actions.append(remove);
    row.append(
      el('td', '', new Date(report.createdAt).toLocaleString()),
      riskCell,
      el('td', 'message', report.message),
      el('td', '', report.status.replace('_', ' ')),
      actions,
    );
    return row;
  }

  async function refreshReports() {
    if (!state.token) {
      return;
    }
    const level = $('reports-filter').value;
    const query = level ? `?level=${encodeURIComponent(level)}` : '';
    const { items } = await api(`/api/reports${query}`);
    $('reports-body').replaceChildren(...items.map(reportRow));
    show($('reports-empty'), items.length === 0);
  }

  async function deleteReport(id) {
    await api(`/api/reports/${id}`, { method: 'DELETE' });
    await Promise.all([refreshReports(), refreshStats()]);
  }

  function renderAccount() {
    const signedIn = Boolean(state.user);
    show($('signed-out'), !signedIn);
    show($('signed-in'), signedIn);
    show($('reports-card'), signedIn);
    show($('report-form'), signedIn);
    show($('report-hint'), !signedIn);
    if (signedIn) {
      $('user-email').textContent = state.user.email;
      $('user-role').textContent = state.user.role;
    }
  }

  async function onAuth(event) {
    event.preventDefault();
    $('auth-error').textContent = '';
    const action = event.submitter?.dataset.action === 'register' ? 'register' : 'login';
    const body = JSON.stringify({ email: $('email').value.trim(), password: $('password').value });
    try {
      const result = await api(`/api/auth/${action}`, { method: 'POST', body });
      state.token = result.token;
      state.user = result.user;
      $('password').value = '';
      renderAccount();
      await refreshReports();
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  }

  function signOut() {
    state.token = null;
    state.user = null;
    renderAccount();
  }

  async function onReport(event) {
    event.preventDefault();
    const payload = {
      message: state.lastMessage,
      channel: $('report-channel').value,
      sender: $('report-sender').value.trim() || undefined,
    };
    try {
      await api('/api/reports', { method: 'POST', body: JSON.stringify(payload) });
      $('report-status').textContent = 'Thanks! Your report helps protect others.';
      await Promise.all([refreshReports(), refreshStats()]);
    } catch (err) {
      $('report-status').textContent = err.message;
    }
  }

  async function loadBuildInfo() {
    try {
      const info = await api('/version');
      const badge = $('env-badge');
      badge.textContent = `${info.environment} v${info.version}`;
      badge.classList.add(info.environment);
      $('build-info').textContent = `SmishGuard v${info.version} | commit ${info.commit.slice(0, 7)} | ${info.environment}`;
    } catch {
      $('env-badge').textContent = 'offline';
    }
  }

  function useExample(language) {
    $('message').value = EXAMPLES[language];
    $('message').focus();
  }

  $('check-form').addEventListener('submit', onCheck);
  $('auth-form').addEventListener('submit', onAuth);
  $('report-form').addEventListener('submit', onReport);
  $('sign-out').addEventListener('click', signOut);
  $('reports-filter').addEventListener('change', refreshReports);
  $('example-en').addEventListener('click', () => useExample('en'));
  $('example-vi').addEventListener('click', () => useExample('vi'));

  renderAccount();
  loadBuildInfo();
  refreshStats();
})();
