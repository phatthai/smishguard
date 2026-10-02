'use strict';

const { assessMessage, levelFor, parseLink, normalise, MAX_MESSAGE_LENGTH } = require('../../src/services/riskEngine');

const ids = (result) => result.signals.map((signal) => signal.id);

describe('risk engine: scoring and levels', () => {
  test('a normal personal message is low risk with no signals', () => {
    const result = assessMessage('Hi mum, running late. See you at 6 and dinner is on me!');
    expect(result).toMatchObject({ score: 0, level: 'low', language: 'en', linkCount: 0 });
    expect(result.signals).toEqual([]);
    expect(result.advice).toMatch(/No strong scam signals/);
  });

  test('a fake Australia Post redelivery text is high risk and explains why', () => {
    const result = assessMessage(
      'AusPost: your parcel could not be delivered. Pay the $2.99 redelivery fee within 24 hours at https://auspost-redelivery.top/track',
    );
    expect(result.level).toBe('high');
    expect(result.score).toBe(100);
    expect(ids(result)).toEqual(expect.arrayContaining([
      'link_present', 'risky_tld', 'lookalike_domain', 'brand_impersonation', 'urgency', 'payment_request', 'delivery_lure',
    ]));
    const lookalike = result.signals.find((signal) => signal.id === 'lookalike_domain');
    expect(lookalike.detail).toContain('imitates Australia Post (official site: auspost.com.au)');
  });

  test('score is capped at 100', () => {
    const result = assessMessage('URGENT final notice: verify your account and pay the fee to claim your refund at http://10.0.0.1/auspost');
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test.each([
    [0, 'low'], [29, 'low'], [30, 'medium'], [59, 'medium'], [60, 'high'], [100, 'high'],
  ])('levelFor(%i) is %s', (score, level) => {
    expect(levelFor(score)).toBe(level);
  });
});

describe('risk engine: Vietnamese support', () => {
  test('detects a Vietnamese bank scam written with accents', () => {
    const result = assessMessage('Tài khoản Vietcombank của quý khách đã bị khóa. Vui lòng đăng nhập ngay lập tức tại vcb-xacminh.top để xác minh.');
    expect(result.language).toBe('vi');
    expect(result.level).toBe('high');
    expect(ids(result)).toEqual(expect.arrayContaining(['urgency', 'credential_request', 'lookalike_domain']));
  });

  test('detects the same scam typed without accents', () => {
    const result = assessMessage('Tai khoan cua quy khach da bi khoa. Vui long dang nhap tai bit.ly/3xYz');
    expect(result.language).toBe('vi');
    expect(ids(result)).toEqual(expect.arrayContaining(['url_shortener', 'urgency', 'credential_request']));
  });

  test('normalise strips diacritics and maps đ to d', () => {
    expect(normalise('khẩn cấp đăng nhập')).toBe('khan cap dang nhap');
  });
});

describe('risk engine: link analysis', () => {
  test('flags raw IP links and plain http', () => {
    const result = assessMessage('myGov: claim your tax refund at http://192.168.10.5/mygov');
    expect(ids(result)).toEqual(expect.arrayContaining(['ip_address_link', 'insecure_link', 'brand_impersonation', 'prize_or_refund']));
  });

  test('exposes links that hide their destination behind an @ sign', () => {
    const result = assessMessage('Visit https://auspost.com.au@evil.top/login now');
    const hidden = result.signals.find((signal) => signal.id === 'hidden_destination');
    expect(hidden.detail).toBe('Shows auspost.com.au but opens evil.top');
    expect(result.level).toBe('high');
  });

  test('flags internationalised (punycode) domains that can imitate real ones', () => {
    const result = assessMessage('Check https://аuspost.com.au/track');
    expect(ids(result)).toContain('punycode_domain');
  });

  test('does not flag the official website of the brand it mentions', () => {
    const result = assessMessage('Your Telstra bill is ready. View it at telstra.com.au/mybill');
    expect(ids(result)).toEqual(['link_present']);
    expect(result.level).toBe('low');
  });

  test('words inside a link are not treated as words in the message', () => {
    const result = assessMessage('Photos from the weekend: https://example.com/login-refund-prize');
    expect(ids(result)).toEqual(['link_present']);
  });

  test.each(['1.50', 'john@gmail.com', 'mr.smith', 'hello', 'e.g', 'https://bad host.com'])('%s is not treated as a link', (token) => {
    expect(parseLink(token)).toBeNull();
  });

  test('parses a bare domain with a known TLD', () => {
    expect(parseLink('www.example.com/path')).toMatchObject({ host: 'www.example.com', explicit: false, secure: false, isIp: false });
  });

  test('malformed percent-encoding in the user part does not crash parsing', () => {
    expect(parseLink('https://%E0%A4%A@evil.top/x').disguisedAs).toBe('%E0%A4%A');
  });
});

describe('risk engine: input validation', () => {
  test.each([[''], ['   '], [null], [42]])('rejects %p', (value) => {
    expect(() => assessMessage(value)).toThrow(TypeError);
  });

  test('rejects messages over the maximum length', () => {
    expect(() => assessMessage('a'.repeat(MAX_MESSAGE_LENGTH + 1))).toThrow(RangeError);
  });
});
