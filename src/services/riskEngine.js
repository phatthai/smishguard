'use strict';

const {
  LEVEL_THRESHOLDS,
  ADVICE,
  URL_SHORTENERS,
  RISKY_TLDS,
  KNOWN_TLDS,
  BRANDS,
  KEYWORD_RULES,
  LINK_WEIGHTS,
  VIETNAMESE_HINTS,
} = require('./riskRules');

/**
 * Explainable, rule-based scam (smishing) risk engine.
 *
 * Every signal adds a weight to the score and carries a plain-language reason, so a
 * user can see exactly why a message was flagged. Text signals and link signals are
 * evaluated separately: words inside a link never count as words in the message.
 * The engine is pure (no I/O), which keeps it fast and fully unit-testable.
 */

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SCORE = 100;

const SCHEME = /^https?:\/\//;
const LEADING_PUNCTUATION = /^[(<[{'"]+/;
const TRAILING_PUNCTUATION = new Set([')', ']', '}', '>', '.', ',', ';', ':', '!', '?', "'", '"']);
const HOST_LABEL = /^[a-z0-9-]+$/;
const ALPHA_TLD = /^[a-z]{2,}$/;
const DIGITS = /^\d{1,3}$/;
const NON_WORD = /[^a-z0-9]+/;
const COMBINING_MARKS = /\p{M}+/gu;
const VIETNAMESE_LETTERS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/gu;

const LINK_LABELS = Object.freeze({
  link_present: 'Contains a link to act on',
  url_shortener: 'Uses a link shortener that hides the real website',
  ip_address_link: 'Link points to a raw IP address instead of a named website',
  insecure_link: 'Link does not use a secure (https) connection',
  risky_tld: 'Link uses a domain ending that is common in scam campaigns',
  punycode_domain: 'Link uses international characters that can imitate a real website',
  lookalike_domain: 'Link imitates a trusted brand but is not its official website',
  hidden_destination: 'Link hides its real destination behind an @ sign',
  brand_impersonation: 'Mentions a trusted brand but sends you to a different website',
});

const unique = (values) => [...new Set(values)];

/** Lower-cases, strips diacritics and maps đ to d so keywords match with or without accents. */
function normalise(text) {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').replaceAll('đ', 'd');
}

/** Turns text into " word word word " so phrases can be matched on whole-word boundaries. */
function toPhraseSpace(text) {
  const words = normalise(text).split(NON_WORD).filter(Boolean);
  return ` ${words.join(' ')} `;
}

const containsPhrase = (phraseSpace, phrase) => phraseSpace.includes(` ${phrase} `);

function isIpv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => DIGITS.test(part) && Number(part) <= 255);
}

function isPlausibleHost(host, explicit) {
  if (isIpv4(host)) {
    return true;
  }
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) {
    return false;
  }
  const tld = labels.at(-1);
  return explicit ? ALPHA_TLD.test(tld) : KNOWN_TLDS.has(tld);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeUrl(candidate) {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * Parses one whitespace-separated token as a link. Tokens without a scheme must
 * round-trip unchanged through the URL parser, so "1.50" or an email address is
 * never mistaken for a website. With a scheme, the parser's host is trusted, which
 * correctly exposes tricks such as https://auspost.com.au@evil.top.
 */
function parseLink(token) {
  if (!token.includes('.')) {
    return null;
  }
  const explicit = SCHEME.test(token);
  const url = safeUrl(explicit ? token : `http://${token}`);
  if (!url) {
    return null;
  }
  const host = url.hostname;
  const typedHost = explicit ? host : token.split(/[/:?#]/)[0];
  if (typedHost !== host || !isPlausibleHost(host, explicit || host.startsWith('www.'))) {
    return null;
  }
  return {
    host,
    tld: host.split('.').at(-1),
    explicit,
    secure: url.protocol === 'https:',
    isIp: isIpv4(host),
    disguisedAs: url.username ? safeDecode(url.username) : null,
  };
}

/** Removes trailing punctuation in linear time (a regex like /[.,!?]+$/ can backtrack quadratically). */
function trimTrailingPunctuation(token) {
  let end = token.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(token[end - 1])) {
    end -= 1;
  }
  return token.slice(0, end);
}

/** Splits text into links and the remaining words. */
function tokenise(lowerText) {
  const links = [];
  const words = [];
  for (const raw of lowerText.split(/\s+/)) {
    const token = trimTrailingPunctuation(raw.replace(LEADING_PUNCTUATION, ''));
    const link = parseLink(token);
    if (link) {
      links.push(link);
    } else {
      words.push(raw);
    }
  }
  return { links, words: words.join(' ') };
}

const isOfficial = (host, brand) => brand.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
const mentionsBrand = (phraseSpace, brand) => brand.keywords.some((keyword) => containsPhrase(phraseSpace, keyword));
const hostList = (links) => (links.length > 0 ? unique(links.map((link) => link.host)).join(', ') : null);

function lookalikeFindings(links) {
  return links.flatMap((link) => {
    const hostWords = link.host.split(/[.-]/);
    return BRANDS.filter((brand) => !isOfficial(link.host, brand) && brand.hostKeywords.some((k) => hostWords.includes(k)))
      .map((brand) => `${link.host} imitates ${brand.name} (official site: ${brand.domains[0]})`);
  });
}

function impersonationFindings(links, phraseSpace) {
  return BRANDS.filter((brand) => mentionsBrand(phraseSpace, brand) && links.some((link) => !isOfficial(link.host, brand)))
    .map((brand) => `Mentions ${brand.name} but links to ${hostList(links.filter((link) => !isOfficial(link.host, brand)))}`);
}

const LINK_DETECTORS = Object.freeze({
  link_present: (links) => hostList(links),
  url_shortener: (links) => hostList(links.filter((link) => URL_SHORTENERS.has(link.host))),
  ip_address_link: (links) => hostList(links.filter((link) => link.isIp)),
  insecure_link: (links) => hostList(links.filter((link) => link.explicit && !link.secure)),
  risky_tld: (links) => hostList(links.filter((link) => RISKY_TLDS.has(link.tld))),
  punycode_domain: (links) => hostList(links.filter((link) => link.host.split('.').some((label) => label.startsWith('xn--')))),
  lookalike_domain: (links) => unique(lookalikeFindings(links)).join('; ') || null,
  hidden_destination: (links) => links.filter((link) => link.disguisedAs)
    .map((link) => `Shows ${link.disguisedAs} but opens ${link.host}`).join('; ') || null,
  brand_impersonation: (links, phraseSpace) => impersonationFindings(links, phraseSpace).join('; ') || null,
});

function linkSignals(links, phraseSpace) {
  if (links.length === 0) {
    return [];
  }
  return Object.entries(LINK_DETECTORS)
    .map(([id, detect]) => ({ id, detail: detect(links, phraseSpace) }))
    .filter((signal) => signal.detail)
    .map(({ id, detail }) => ({ id, label: LINK_LABELS[id], weight: LINK_WEIGHTS[id], detail }));
}

function keywordSignals(phraseSpace) {
  return KEYWORD_RULES.map((rule) => ({ rule, matches: rule.keywords.filter((k) => containsPhrase(phraseSpace, k)) }))
    .filter(({ matches }) => matches.length > 0)
    .map(({ rule, matches }) => ({
      id: rule.id,
      label: rule.label,
      weight: rule.weight,
      detail: `Matched: ${matches.join(', ')}`,
    }));
}

function detectLanguage(lowerText, phraseSpace) {
  const accentedLetters = lowerText.match(VIETNAMESE_LETTERS)?.length ?? 0;
  if (accentedLetters >= 2) {
    return 'vi';
  }
  const hints = VIETNAMESE_HINTS.filter((hint) => containsPhrase(phraseSpace, hint)).length;
  return hints >= 2 ? 'vi' : 'en';
}

function levelFor(score) {
  return LEVEL_THRESHOLDS.find(({ min }) => score >= min).level;
}

function validate(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('text must be a non-empty string');
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`text must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
}

/**
 * Assesses a message and returns a 0-100 score, a risk level, the detected
 * language, every signal that fired (with reasons) and advice for the user.
 */
function assessMessage(text) {
  validate(text);
  const lowerText = text.normalize('NFC').toLowerCase();
  const { links, words } = tokenise(lowerText);
  const phraseSpace = toPhraseSpace(words);
  const signals = [...linkSignals(links, phraseSpace), ...keywordSignals(phraseSpace)];
  const score = Math.min(MAX_SCORE, signals.reduce((total, signal) => total + signal.weight, 0));
  const level = levelFor(score);
  return {
    score,
    level,
    language: detectLanguage(lowerText, phraseSpace),
    signals,
    advice: ADVICE[level],
    linkCount: links.length,
  };
}

module.exports = { assessMessage, levelFor, parseLink, normalise, MAX_MESSAGE_LENGTH };
