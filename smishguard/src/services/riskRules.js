'use strict';

/**
 * Rule data for the risk engine, kept separate from the scoring logic so rules can
 * be reviewed and extended without touching code paths. Keywords are written in
 * lower case without diacritics because the engine normalises text the same way
 * (so "khẩn cấp" and "khan cap" both match "khan cap").
 */

const LEVEL_THRESHOLDS = Object.freeze([
  { level: 'high', min: 60 },
  { level: 'medium', min: 30 },
  { level: 'low', min: 0 },
]);

const ADVICE = Object.freeze({
  high: 'Very likely a scam. Do not tap links, reply or call back. Contact the organisation using details from its official website or app, then report and delete the message.',
  medium: 'Be careful. Do not share codes, passwords or payment details. Check the request through an official channel before you act.',
  low: 'No strong scam signals found. Stay alert: if a message asks for money or personal details, verify it through an official channel first.',
});

const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'cutt.ly', 'rebrand.ly',
  'shorturl.at', 'rb.gy', 'tiny.cc', 's.id', 'shorturl.com', 't.ly',
]);

const RISKY_TLDS = new Set([
  'top', 'xyz', 'icu', 'click', 'buzz', 'cyou', 'rest', 'monster', 'sbs', 'cfd',
  'live', 'shop', 'info', 'vip', 'online', 'site', 'lol', 'mom', 'tk', 'ml', 'ga', 'cf', 'gq',
]);

// Bare domains (typed without http:// or www.) only count as links when they end in a
// known TLD. This stops ordinary text such as "Mr.Smith" being treated as a link.
const KNOWN_TLDS = new Set([
  ...RISKY_TLDS,
  'com', 'net', 'org', 'au', 'vn', 'uk', 'nz', 'us', 'io', 'co', 'me', 'app', 'link', 'ly', 'gl',
  'at', 'gy', 'cc', 'id', 'gov', 'edu', 'biz', 'ru', 'cn', 'in', 'ca', 'de', 'eu', 'ws', 'pw',
  'club', 'store', 'support', 'help', 'services', 'center', 'digital', 'network', 'today', 'world',
]);

// Brands frequently impersonated in scam texts sent to people in Australia,
// including Vietnamese banks used for remittances by the Vietnamese community.
const BRANDS = Object.freeze([
  { name: 'Australia Post', keywords: ['auspost', 'australia post'], domains: ['auspost.com.au'] },
  { name: 'Australian Taxation Office', keywords: ['ato', 'tax office', 'taxation office'], domains: ['ato.gov.au'] },
  { name: 'myGov', keywords: ['mygov'], domains: ['my.gov.au'] },
  { name: 'Linkt', keywords: ['linkt'], domains: ['linkt.com.au'] },
  { name: 'Commonwealth Bank', keywords: ['commbank', 'commonwealth bank', 'cba'], domains: ['commbank.com.au'] },
  { name: 'NAB', keywords: ['nab'], domains: ['nab.com.au'] },
  { name: 'Westpac', keywords: ['westpac'], domains: ['westpac.com.au'] },
  { name: 'ANZ', keywords: ['anz'], domains: ['anz.com.au', 'anz.com'] },
  { name: 'Telstra', keywords: ['telstra'], domains: ['telstra.com.au', 'telstra.com'] },
  { name: 'Optus', keywords: ['optus'], domains: ['optus.com.au'] },
  { name: 'Services Australia', keywords: ['centrelink', 'medicare', 'services australia'], domains: ['servicesaustralia.gov.au', 'my.gov.au'] },
  { name: 'Vietcombank', keywords: ['vietcombank', 'vcb'], domains: ['vietcombank.com.vn'] },
  { name: 'Techcombank', keywords: ['techcombank', 'tcb'], domains: ['techcombank.com', 'techcombank.com.vn'] },
].map((brand) => Object.freeze({
  ...brand,
  // Host names cannot contain spaces, so multi-word keywords are matched joined up.
  hostKeywords: brand.keywords.map((keyword) => keyword.replaceAll(' ', '')),
})));

const KEYWORD_RULES = Object.freeze([
  {
    id: 'urgency',
    weight: 15,
    label: 'Creates urgency or threatens a consequence',
    keywords: [
      'urgent', 'urgently', 'immediately', 'act now', 'final notice', 'final reminder', 'final warning',
      'suspended', 'blocked', 'locked', 'deactivated', 'within 24 hours', 'within 24h', 'expires today',
      'last chance', 'overdue', 'unusual activity', 'restricted',
      'khan cap', 'ngay lap tuc', 'bi khoa', 'tam khoa', 'het han', 'trong 24 gio', 'lan cuoi', 'canh bao',
    ],
  },
  {
    id: 'credential_request',
    weight: 25,
    label: 'Asks for passwords or codes, or asks you to log in and verify details',
    keywords: [
      'password', 'passcode', 'pin', 'otp', 'one time code', 'one time password', 'verification code',
      'security code', 'verify your account', 'verify your identity', 'confirm your identity',
      'confirm your details', 'update your details', 'log in', 'login', 'sign in', 'card number', 'cvv',
      'mat khau', 'dang nhap', 'xac minh', 'xac thuc', 'cap nhat thong tin', 'so the',
    ],
  },
  {
    id: 'payment_request',
    weight: 20,
    label: 'Asks you to pay a fee, fine or toll, or to transfer money',
    keywords: [
      'pay', 'payment', 'fee', 'unpaid', 'outstanding', 'toll', 'unpaid fine', 'transfer', 'bank transfer',
      'gift card', 'gift cards', 'bitcoin', 'crypto', 'invoice', 'settle',
      'chuyen tien', 'chuyen khoan', 'thanh toan', 'nop phat', 'le phi', 'dong phi', 'phi van chuyen',
    ],
  },
  {
    id: 'prize_or_refund',
    weight: 15,
    label: 'Promises a prize, refund or reward',
    keywords: [
      'congratulations', 'you have won', 'you won', 'winner', 'prize', 'reward', 'refund', 'rebate',
      'cashback', 'claim your', 'tax refund',
      'trung thuong', 'qua tang', 'hoan tien', 'nhan thuong', 'phan thuong',
    ],
  },
  {
    id: 'delivery_lure',
    weight: 10,
    label: 'Claims a parcel or delivery needs your action',
    keywords: [
      'parcel', 'package', 'delivery', 'redelivery', 'redeliver', 'shipment', 'courier',
      'unable to deliver', 'address incomplete', 'tracking',
      'buu kien', 'giao hang', 'don hang', 'buu pham',
    ],
  },
]);

const LINK_WEIGHTS = Object.freeze({
  link_present: 10,
  url_shortener: 20,
  ip_address_link: 25,
  insecure_link: 5,
  risky_tld: 15,
  punycode_domain: 20,
  lookalike_domain: 30,
  hidden_destination: 35,
  brand_impersonation: 15,
});

// Common Vietnamese words (without diacritics) used to recognise Vietnamese text
// that was typed without accents.
const VIETNAMESE_HINTS = Object.freeze([
  'tai khoan', 'quy khach', 'vui long', 'ngan hang', 'cua ban', 'lien he', 'xin chao',
  'khong', 'duoc', 'chung toi', 'cua quy', 'thong bao', 'so tien',
]);

module.exports = {
  LEVEL_THRESHOLDS,
  ADVICE,
  URL_SHORTENERS,
  RISKY_TLDS,
  KNOWN_TLDS,
  BRANDS,
  KEYWORD_RULES,
  LINK_WEIGHTS,
  VIETNAMESE_HINTS,
};
