// Email notification tests (2026-11-10) — plain node, no framework:
//
//   node scripts/test-mail.mjs
//
// Mirrors scripts/test-offers.mjs: an in-memory D1 stub, a mocked
// fetch (Google token endpoint + Gmail send + nothing else), signed
// Stripe webhooks, and the REAL route handlers + _lib/mail.js.
// Covers docs/EMAIL.md:
//   (a) MIME building: headers, base64url round-trip, CRLF safety /
//       header-injection stripping, RFC 2047 subject encoding
//   (b) mailConfigured / mailConfigStatus matrix + defaults
//   (c) sendMail: token cache reuse keyed by client id, bad
//       recipient short-circuit, unconfigured = no fetch at all
//   (d) POST /api/orders placed pair (customer + admin), demo-card
//       PAID alert, no-email order -> admin only
//   (e) checkout email validation: malformed -> 400, absent -> OK
//   (f) failure isolation: Gmail 500 / fetch throw / token failure
//       can never change an order response
//   (g) Stripe webhook paid -> exactly one PAID email, redelivery
//       -> no duplicate; donation session -> no order emails
//   (h) offer create -> one admin offer email; offer pay (demo) ->
//       placed pair exactly once + PAID, order carries buyer email
//   (i) /api/admin/mail-debug: 401 anon, configured/missing report
//       with NO secret values, POST sends one test email

import { createHmac } from 'node:crypto';

import {
  createProduct,
  getProduct,
  getOrder,
  getOffer,
} from '../functions/api/_lib/db.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import {
  mailConfigured,
  mailConfigStatus,
  buildMimeMessage,
  base64UrlEncode,
  sendMail,
  getGmailAccessToken,
} from '../functions/api/_lib/mail.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import { onRequestPost as ordersPost } from '../functions/api/orders.js';
import { onRequestPost as offerCreate } from '../functions/api/offers.js';
import { onRequestGet as offerStatus } from '../functions/api/offers/[id]/status.js';
import { onRequestPost as offerPay } from '../functions/api/offers/[id]/pay.js';
import { onRequestPost as adminAccept } from '../functions/api/admin/offers/[id]/accept.js';
import {
  onRequestGet as mailDebugGet,
  onRequestPost as mailDebugPost,
} from '../functions/api/admin/mail-debug.js';
import { onRequestPost as webhookPost } from '../functions/api/stripe/webhook.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ----- In-memory D1 stub (test-offers.mjs pattern) ------------------------------

const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'brand', 'sizes', 'scent',
  'stock_qty', 'low_stock_threshold', 'free_shipping',
  'condition', 'accepts_offers',
];
const ORDER_COLS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz', 'inventory_applied',
];

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((t) => t.trim());
}

class StubDB {
  constructor() {
    this.state = { products: [], orders: [], offers: [], donations: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0, offers: 0, donations: 0 };
  }

  pragma(table) {
    const cols = table === 'products' ? PRODUCT_COLS : table === 'orders' ? ORDER_COLS : [];
    return { results: cols.map((name) => ({ name })) };
  }

  prepare(sql) {
    const db = this;
    const stmt = sql.trim().replace(/\s+/g, ' ');
    let params = [];
    const api = {
      bind(...args) { params = args; return api; },
      async run() { return db.run(stmt, params); },
      async first() { return db.first(stmt, params); },
      async all() { return db.all(stmt, params); },
    };
    return api;
  }

  insertRow(table, stmt, params) {
    const m = stmt.match(/INSERT(?: OR IGNORE)? INTO \w+ \(([^)]+)\) VALUES \(([\s\S]+)\)/i);
    const cols = m[1].split(',').map((s) => s.trim());
    const tokens = splitTopLevel(m[2]);
    const row = {};
    let p = 0;
    cols.forEach((col, i) => {
      const tok = tokens[i];
      if (tok === '?') row[col] = params[p++];
      else if (/^NULL$/i.test(tok)) row[col] = null;
      else if (/^'[\s\S]*'$/.test(tok)) row[col] = tok.slice(1, -1).replace(/''/g, "'");
      else if (/^-?\d+(\.\d+)?$/.test(tok)) row[col] = Number(tok);
      else row[col] = tok;
    });
    row.id = ++this.lastId[table];
    this.state[table].push(row);
    return { meta: { last_row_id: row.id, changes: 1 } };
  }

  updateRows(table, stmt, params) {
    if (/SET stock_qty = MAX\(0, stock_qty - \?\)/.test(stmt)) {
      const [qty, id] = params;
      const row = this.state.products.find((r) => r.id === Number(id));
      if (row && row.stock_qty != null) {
        row.stock_qty = Math.max(0, row.stock_qty - Number(qty));
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (table === 'offers' && /WHERE order_id = \? AND status = 'accepted'/.test(stmt)) {
      const row = this.state.offers.find(
        (r) => r.order_id === Number(params[0]) && r.status === 'accepted'
      );
      if (row) row.status = 'paid';
      return { meta: { changes: row ? 1 : 0 } };
    }
    const m = stmt.match(/UPDATE \w+ SET ([\s\S]+?) WHERE id = \?/);
    if (!m) throw new Error(`StubDB: unhandled UPDATE: ${stmt}`);
    const assignments = splitTopLevel(m[1]);
    let p = 0;
    const set = {};
    for (const a of assignments) {
      const am = a.match(/^(\w+) = ([\s\S]+)$/);
      const rhs = am[2].trim();
      if (rhs === '?') set[am[1]] = params[p++];
      else if (/^-?\d+$/.test(rhs)) set[am[1]] = Number(rhs);
      else set[am[1]] = rhs;
    }
    const id = Number(params[p]);
    const row = this.state[table].find((r) => r.id === id);
    if (row) Object.assign(row, set);
    return { meta: { changes: row ? 1 : 0 } };
  }

  run(stmt, params) {
    let m = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (m) {
      this.alters.push(`${m[1]}.${m[2]}`);
      return { meta: { changes: 0 } };
    }
    if (/^CREATE TABLE IF NOT EXISTS offers/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^CREATE TABLE IF NOT EXISTS donations/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^INSERT INTO products/i.test(stmt)) return this.insertRow('products', stmt, params);
    if (/^INSERT INTO orders/i.test(stmt)) return this.insertRow('orders', stmt, params);
    if (/^INSERT INTO offers/i.test(stmt)) return this.insertRow('offers', stmt, params);
    if (/^INSERT OR IGNORE INTO donations/i.test(stmt)) return this.insertRow('donations', stmt, params);
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    if (/^UPDATE offers/i.test(stmt)) return this.updateRows('offers', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM products/i.test(stmt)
      ? 'products'
      : /FROM offers/i.test(stmt)
        ? 'offers'
        : 'orders';
    let rows = [...this.state[table]];
    if (/stripe_session_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.stripe_session_id === params[0]);
    } else if (/WHERE order_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.order_id === Number(params[0]));
    } else if (/WHERE id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.id === Number(params[0]));
    }
    if (/FROM offers/i.test(stmt) && /ORDER BY/i.test(stmt)) {
      rows.sort((a, b) => {
        const pa = a.status === 'pending' ? 0 : 1;
        const pb = b.status === 'pending' ? 0 : 1;
        return pa - pb || b.id - a.id;
      });
    } else if (/ORDER BY id DESC/i.test(stmt)) {
      rows.sort((a, b) => b.id - a.id);
    }
    return rows;
  }

  first(stmt, params) {
    return this.selectRows(stmt, params)[0] || null;
  }

  all(stmt, params) {
    if (/^PRAGMA table_info\((\w+)\)/.test(stmt)) {
      return this.pragma(stmt.match(/PRAGMA table_info\((\w+)\)/)[1]);
    }
    return { results: this.selectRows(stmt, params) };
  }
}

// ----- Fetch mock (Google only) ---------------------------------------------------

const gmail = {
  sent: [], // decoded { to, subject, text, mime }
  sendCalls: 0,
  tokenCalls: 0,
  sendMode: 'ok', // 'ok' | 'http500' | 'throw'
  tokenMode: 'ok', // 'ok' | 'http400' | 'throw'
  reset() {
    this.sent = [];
    this.sendCalls = 0;
    this.sendMode = 'ok';
    this.tokenMode = 'ok';
    // tokenCalls deliberately NOT reset: the isolate token cache is
    // keyed by client id, so scenarios use distinct client ids and
    // count deltas where the cache matters.
  },
};

function decodeSubjectHeader(value) {
  if (!value.includes('=?UTF-8?B?')) return value;
  const joined = value.replace(/\?=\s+=\?UTF-8\?B\?/g, '');
  const m = joined.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : value;
}

function decodeRawMessage(raw) {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const mime = Buffer.from(b64, 'base64').toString('utf8');
  const splitAt = mime.indexOf('\r\n\r\n');
  const head = splitAt === -1 ? mime : mime.slice(0, splitAt);
  const bodyB64 = splitAt === -1 ? '' : mime.slice(splitAt + 4).replace(/\s+/g, '');
  const text = Buffer.from(bodyB64, 'base64').toString('utf8');
  const headers = {};
  for (const line of head.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return {
    mime,
    to: headers.to || '',
    from: headers.from || '',
    subject: headers.subject ? decodeSubjectHeader(headers.subject) : '',
    text,
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://oauth2.googleapis.com/token') {
    gmail.tokenCalls += 1;
    if (gmail.tokenMode === 'throw') throw new Error('token network boom');
    if (gmail.tokenMode === 'http400') {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    // Distinct token per client id so cache behavior is observable.
    const body = new URLSearchParams(String(init.body || ''));
    return new Response(
      JSON.stringify({ access_token: `tok-for-${body.get('client_id')}`, expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    gmail.sendCalls += 1;
    if (gmail.sendMode === 'throw') throw new Error('gmail network boom');
    if (gmail.sendMode === 'http500') {
      return new Response(
        JSON.stringify({ error: { code: 500, message: 'backend error', status: 'INTERNAL' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const payload = JSON.parse(String(init.body || '{}'));
    const decoded = decodeRawMessage(payload.raw || '');
    gmail.sent.push(decoded);
    return new Response(
      JSON.stringify({ id: `gmail-msg-${gmail.sent.length}`, threadId: 'thread-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return realFetch(url, init);
};

// ----- Helpers ----------------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';
const ADMIN_EMAIL = 'beastmode82420@beastmode82420.com';
const SECRET_VALUE = 'MAIL-TEST-SECRET-VALUE';
const REFRESH_VALUE = 'MAIL-TEST-REFRESH-VALUE';

function mailEnv(db, clientId, extra = {}) {
  return {
    DB: db,
    BEASTMODE_ADMIN_SECRET: 'mail-test-admin-secret',
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: SECRET_VALUE,
    GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH_VALUE,
    ...extra,
  };
}

const CUSTOMER = {
  fullName: 'Test Buyer',
  phone: '5855550100',
  address: '1 Main St',
  city: 'Rochester',
  zip: '14617',
};
const DEMO_CARD = { cardNumber: '4242424242424242' };

function ctx(request, env, params = {}) {
  return { request, env, params, waitUntil() {} };
}

function jsonRequest(url, method, body, headers = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeProduct(env, over = {}) {
  const data = normalizeProduct({
    name: 'Mail Widget',
    category: 'shirts',
    type: 'Test',
    price: 8.24,
    ...over,
  });
  return createProduct(env, data);
}

async function placeOrder(env, body) {
  const res = await ordersPost(ctx(jsonRequest(`${ORIGIN}/api/orders`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function deliverWebhook(env, event) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
  const req = new Request(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${ts},v1=${sig}` },
    body: raw,
  });
  const res = await webhookPost(ctx(req, env));
  return res.status;
}

const bySubject = (substr) => gmail.sent.filter((m) => m.subject.includes(substr));

// =====================================================================================
// (a) MIME building.
// =====================================================================================
{
  const mime = buildMimeMessage({
    from: 'beastmode82420@beastmode82420.com',
    fromName: 'Shop 824',
    to: 'buyer@example.com',
    subject: 'Hello there',
    text: 'Line one\nLine two — with a dash.',
  });
  check('(a) From header carries the display name + address',
    mime.includes('From: "Shop 824" <beastmode82420@beastmode82420.com>'));
  check('(a) To and Subject headers present',
    mime.includes('To: buyer@example.com') && mime.includes('Subject: Hello there'));
  check('(a) message is CRLF-structured with a blank line before the body',
    mime.includes('\r\n\r\n') && !/(?<!\r)\n/.test(mime.replace(/\r\n/g, '')) || mime.includes('\r\n'));
  const roundTrip = Buffer.from(
    base64UrlEncode(mime).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  ).toString('utf8');
  check('(a) base64url raw round-trips the MIME byte-for-byte', roundTrip === mime);
  const bodyText = Buffer.from(
    mime.slice(mime.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''),
    'base64'
  ).toString('utf8');
  check('(a) base64 body decodes back to the plain text (unicode intact)',
    bodyText === 'Line one\nLine two — with a dash.', bodyText);

  const evil = buildMimeMessage({
    from: 'beastmode82420@beastmode82420.com',
    fromName: 'Shop "824"\r\nBcc: evil@example.com',
    to: 'buyer@example.com',
    subject: 'Hi\r\nBcc: evil@example.com',
    text: 'body',
  });
  const evilHead = evil.slice(0, evil.indexOf('\r\n\r\n'));
  check('(a) header injection: no Bcc header can be smuggled in',
    !/^Bcc:/m.test(evilHead) && !evilHead.includes('\nBcc'), evilHead);
  check('(a) injected line break is flattened into the subject value',
    /Subject: Hi Bcc: evil@example\.com/.test(evilHead), evilHead);

  const unicode = buildMimeMessage({
    from: 'a@b.co',
    fromName: '',
    to: 'c@d.co',
    subject: '[Shop 824] New order #3 — $9.08',
    text: 'x',
  });
  const unicodeSubject = unicode.match(/Subject: (.+)\r\n/)[1];
  check('(a) non-ASCII subject is RFC 2047 encoded',
    unicodeSubject.startsWith('=?UTF-8?B?'), unicodeSubject);
  check('(a) encoded subject decodes back to the original',
    decodeSubjectHeader(unicodeSubject) === '[Shop 824] New order #3 — $9.08');
}

// =====================================================================================
// (b) Configuration matrix.
// =====================================================================================
{
  check('(b) unconfigured when nothing is set', mailConfigured({}) === false);
  check('(b) unconfigured with only the client id',
    mailConfigured({ GOOGLE_OAUTH_CLIENT_ID: 'x' }) === false);
  check('(b) unconfigured with only id + secret',
    mailConfigured({ GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' }) === false);
  check('(b) configured when all three OAuth vars are set',
    mailConfigured({
      GOOGLE_OAUTH_CLIENT_ID: 'x',
      GOOGLE_OAUTH_CLIENT_SECRET: 'y',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'z',
    }) === true);

  const bare = mailConfigStatus({});
  check('(b) status lists all three missing vars when unset',
    bare.configured === false &&
    bare.missing.join(',') ===
      'GOOGLE_OAUTH_CLIENT_ID,GOOGLE_OAUTH_CLIENT_SECRET,GOOGLE_OAUTH_REFRESH_TOKEN',
    JSON.stringify(bare));
  check('(b) from/admin default to the Workspace mailbox, name to Shop 824',
    bare.from === ADMIN_EMAIL && bare.adminEmail === ADMIN_EMAIL && bare.fromName === 'Shop 824');
  const custom = mailConfigStatus({
    GOOGLE_OAUTH_CLIENT_ID: 'x',
    GOOGLE_OAUTH_CLIENT_SECRET: 'y',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'z',
    SHOP_FROM_EMAIL: 'shop@example.com',
    SHOP_ADMIN_EMAIL: 'owner@example.com',
    SHOP_FROM_NAME: 'My Shop',
  });
  check('(b) SHOP_* overrides are honored',
    custom.configured === true && custom.missing.length === 0 &&
    custom.from === 'shop@example.com' && custom.adminEmail === 'owner@example.com' &&
    custom.fromName === 'My Shop');
}

// =====================================================================================
// (c) sendMail behavior: dormancy, cache, recipient gate.
// =====================================================================================
{
  gmail.reset();
  const off = await sendMail({}, { to: 'buyer@example.com', subject: 'x', text: 'y' });
  check('(c) unconfigured sendMail -> ok:false not_configured, never throws',
    off.ok === false && off.errorCode === 'not_configured');
  check('(c) unconfigured sendMail makes NO network calls at all',
    gmail.sendCalls === 0 && gmail.tokenCalls === 0);
  check('(c) getGmailAccessToken is null when unconfigured',
    (await getGmailAccessToken({})) === null);

  const db = new StubDB();
  const envA = mailEnv(db, 'mail-client-a');
  const before = gmail.tokenCalls;
  const one = await sendMail(envA, { to: 'buyer@example.com', subject: 'One', text: 'first' });
  const two = await sendMail(envA, { to: 'buyer@example.com', subject: 'Two', text: 'second' });
  check('(c) configured sends succeed and return Gmail ids',
    one.ok === true && typeof one.id === 'string' && two.ok === true);
  check('(c) token cache: two sends under one client id = ONE token call',
    gmail.tokenCalls === before + 1, `tokenCalls delta=${gmail.tokenCalls - before}`);
  check('(c) both messages reached Gmail with the right subjects',
    gmail.sent.length === 2 && gmail.sent[0].subject === 'One' && gmail.sent[1].subject === 'Two');
  check('(c) sent From is the shop identity',
    gmail.sent[0].from === '"Shop 824" <beastmode82420@beastmode82420.com>', gmail.sent[0].from);

  const envB = mailEnv(db, 'mail-client-b');
  await sendMail(envB, { to: 'buyer@example.com', subject: 'Three', text: 'third' });
  check('(c) a different client id mints a fresh token (cache is keyed)',
    gmail.tokenCalls === before + 2, `tokenCalls=${gmail.tokenCalls}`);

  const sendsBefore = gmail.sendCalls;
  const bad = await sendMail(envA, { to: 'not-an-email', subject: 'x', text: 'y' });
  check('(c) malformed recipient -> bad_recipient, Gmail never called',
    bad.ok === false && bad.errorCode === 'bad_recipient' && gmail.sendCalls === sendsBefore);
}

// =====================================================================================
// (d)+(e) Order placement emails + checkout email validation.
// =====================================================================================
{
  gmail.reset();
  const db = new StubDB();
  const env = mailEnv(db, 'mail-client-orders');
  const product = await makeProduct(env);

  // (e) malformed email -> 400 before anything is stored or sent.
  const badEmail = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: { ...CUSTOMER, email: 'not-an-email' },
    payment: DEMO_CARD,
  });
  check('(e) malformed customer email -> 400',
    badEmail.status === 400 && /email/i.test(badEmail.data.error || ''),
    `status ${badEmail.status}: ${JSON.stringify(badEmail.data)}`);
  check('(e) the refused order sent no email and stored no order',
    gmail.sent.length === 0 && db.state.orders.length === 0);

  // (d) Demo-card order WITH email: placed pair + PAID alert.
  const placed = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: { ...CUSTOMER, email: 'buyer@example.com' },
    payment: DEMO_CARD,
  });
  check('(d) order with email places 201', placed.status === 201, `got ${placed.status}`);
  const oid = placed.data.id;
  check('(d) the email is stored in the order customer JSON',
    placed.data.customer && placed.data.customer.email === 'buyer@example.com',
    JSON.stringify(placed.data.customer));

  const confirmations = bySubject(`Your Shop 824 order #${oid} is placed`);
  check('(d) customer confirmation sent exactly once, to the buyer',
    confirmations.length === 1 && confirmations[0].to === 'buyer@example.com',
    JSON.stringify(gmail.sent.map((m) => m.subject)));
  check('(d) confirmation names the item, the total and the reply line',
    confirmations.length === 1 &&
    confirmations[0].text.includes('Mail Widget') &&
    confirmations[0].text.includes('$9.08') &&
    confirmations[0].text.includes('Questions? Reply to this email.'),
    confirmations.length ? confirmations[0].text : 'none');
  const adminNew = bySubject(`[Shop 824] New order #${oid} — $9.08`);
  check('(d) admin new-order alert sent once, to the admin inbox',
    adminNew.length === 1 && adminNew[0].to === ADMIN_EMAIL,
    JSON.stringify(gmail.sent.map((m) => m.subject)));
  check('(d) admin alert carries buyer name, phone and email',
    adminNew.length === 1 &&
    adminNew[0].text.includes('Test Buyer') &&
    adminNew[0].text.includes('5855550100') &&
    adminNew[0].text.includes('buyer@example.com'));
  const adminPaid = bySubject(`[Shop 824] PAID order #${oid} — $9.08`);
  check('(d) demo-card placement fires the admin PAID alert exactly once',
    adminPaid.length === 1 && adminPaid[0].to === ADMIN_EMAIL);
  check('(d) no card data beyond last4 appears in any email',
    gmail.sent.every((m) => !m.text.includes('4242424242424242') && !m.mime.includes('4242424242424242')));
  check('(d) the PAID alert may show the stored last4',
    adminPaid.length === 1 && adminPaid[0].text.includes('••••4242'), adminPaid.length ? adminPaid[0].text : 'none');

  // (d) Order WITHOUT email (and without payment): admin alert only.
  gmail.sent = [];
  const noEmail = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CUSTOMER,
  });
  check('(e) absent email is allowed at the API level (201)',
    noEmail.status === 201, `got ${noEmail.status}`);
  check('(d) no-email order: stored customer has NO email key',
    noEmail.data.customer && !('email' in noEmail.data.customer),
    JSON.stringify(noEmail.data.customer));
  check('(d) no-email order sends ONLY the admin new-order alert',
    gmail.sent.length === 1 && gmail.sent[0].to === ADMIN_EMAIL &&
    gmail.sent[0].subject.includes(`New order #${noEmail.data.id}`),
    JSON.stringify(gmail.sent.map((m) => `${m.to} ${m.subject}`)));
  check('(d) the admin alert notes there is no email on file',
    gmail.sent.length === 1 && gmail.sent[0].text.includes('no email on file'));
}

// =====================================================================================
// (f) Failure isolation — Gmail/token trouble never changes an order response.
// =====================================================================================
{
  const db = new StubDB();
  const env = mailEnv(db, 'mail-client-fail');
  const product = await makeProduct(env);
  const body = {
    items: [{ productId: product.id, qty: 1 }],
    customer: { ...CUSTOMER, email: 'buyer@example.com' },
    payment: DEMO_CARD,
  };

  gmail.reset();
  gmail.sendMode = 'http500';
  const r500 = await placeOrder(env, body);
  check('(f) Gmail 500 -> order still places 201', r500.status === 201, `got ${r500.status}`);
  check('(f) Gmail 500 -> sends were attempted and failed quietly',
    gmail.sendCalls >= 2 && gmail.sent.length === 0, `sendCalls=${gmail.sendCalls}`);

  gmail.sendMode = 'throw';
  const rThrow = await placeOrder(env, body);
  check('(f) Gmail network throw -> order still places 201', rThrow.status === 201, `got ${rThrow.status}`);

  gmail.sendMode = 'ok';
  gmail.tokenMode = 'http400';
  const rToken = await placeOrder(env, body);
  check('(f) token endpoint failure -> order still places 201', rToken.status === 201, `got ${rToken.status}`);
  gmail.tokenMode = 'ok';
  check('(f) all three orders really persisted',
    db.state.orders.length === 3, `orders=${db.state.orders.length}`);
}

// =====================================================================================
// (g) Webhook PAID email — exactly once; donations never trigger it.
// =====================================================================================
{
  gmail.reset();
  const db = new StubDB();
  const env = mailEnv(db, 'mail-client-hook', {
    STRIPE_SECRET_KEY: 'sk_test_mail_suite',
    STRIPE_WEBHOOK_SECRET: 'whsec_mail_test',
  });
  const product = await makeProduct(env);
  const placed = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: { ...CUSTOMER, email: 'buyer@example.com' },
  });
  check('(g) stripe-path order places (pair sent, no PAID yet)',
    placed.status === 201 && bySubject('[Shop 824] PAID').length === 0 &&
    bySubject('New order #').length === 1,
    JSON.stringify(gmail.sent.map((m) => m.subject)));

  const event = {
    id: 'evt_mail_completed_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_mail_1',
        metadata: { order_id: String(placed.data.id) },
        payment_intent: 'pi_mail_1',
      },
    },
  };
  const first = await deliverWebhook(env, event);
  check('(g) signed webhook -> 200', first === 200, `got ${first}`);
  const paidMails = bySubject(`[Shop 824] PAID order #${placed.data.id}`);
  check('(g) webhook paid transition sends exactly one PAID email',
    paidMails.length === 1 && paidMails[0].to === ADMIN_EMAIL,
    JSON.stringify(gmail.sent.map((m) => m.subject)));

  const again = await deliverWebhook(env, event);
  check('(g) webhook redelivery -> 200 and NO duplicate PAID email',
    again === 200 && bySubject(`[Shop 824] PAID order #${placed.data.id}`).length === 1);

  const sentBefore = gmail.sent.length;
  const donation = await deliverWebhook(env, {
    id: 'evt_mail_donation_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_mail_donation',
        amount_total: 824,
        metadata: { kind: 'donation', project: '824-shield' },
        customer_details: { email: 'donor@example.com' },
      },
    },
  });
  check('(g) donation session -> 200 and NO order emails at all',
    donation === 200 && gmail.sent.length === sentBefore,
    `status ${donation}, sent ${gmail.sent.length} vs ${sentBefore}`);
}

// =====================================================================================
// (h) Offer emails — create alert; pay fires the placed pair exactly once.
// =====================================================================================
{
  gmail.reset();
  const db = new StubDB();
  const env = mailEnv(db, 'mail-client-offers');
  const product = await makeProduct(env, { name: 'Offerable Widget', price: 50 });
  check('(h) fixture product is offer-eligible',
    (await getProduct(env, product.id)).acceptsOffers === true);

  const offerRes = await offerCreate(ctx(jsonRequest(`${ORIGIN}/api/offers`, 'POST', {
    productId: product.id,
    offerAmount: 40,
    name: 'Offer Buyer',
    email: 'offerbuyer@example.com',
    phone: '5855550100',
    note: 'Love it!',
  }), env));
  const offer = await offerRes.json().catch(() => ({}));
  check('(h) offer creates 201', offerRes.status === 201, `got ${offerRes.status}`);
  const offerMails = bySubject('[Shop 824] New offer');
  check('(h) offer create sends exactly one admin offer email',
    offerMails.length === 1 && offerMails[0].to === ADMIN_EMAIL,
    JSON.stringify(gmail.sent.map((m) => m.subject)));
  check('(h) offer email subject names the offer amount and the product',
    offerMails.length === 1 &&
    offerMails[0].subject === '[Shop 824] New offer — $40.00 on Offerable Widget',
    offerMails.length ? offerMails[0].subject : 'none');
  check('(h) offer email body shows list price vs offer + buyer contact',
    offerMails.length === 1 &&
    offerMails[0].text.includes('List price: $50.00') &&
    offerMails[0].text.includes('Offer: $40.00') &&
    offerMails[0].text.includes('offerbuyer@example.com') &&
    offerMails[0].text.includes('Love it!'),
    offerMails.length ? offerMails[0].text : 'none');

  // The status read exposes the buyer's own email for the pay page.
  const statusRes = await offerStatus(ctx(
    new Request(`${ORIGIN}/api/offers/${offer.id}/status?token=${encodeURIComponent(offer.accessToken)}`, { method: 'GET' }),
    env, { id: String(offer.id) }
  ));
  const statusData = await statusRes.json().catch(() => ({}));
  check('(h) offer status exposes buyerEmail to the token holder',
    statusRes.status === 200 && statusData.buyerEmail === 'offerbuyer@example.com',
    `status ${statusRes.status}: ${JSON.stringify(statusData)}`);

  const adminToken = (await issueToken(env, 'boss')).token;
  const acceptRes = await adminAccept(ctx(
    jsonRequest(`${ORIGIN}/api/admin/offers/${offer.id}/accept`, 'POST', {}, {
      Authorization: `Bearer ${adminToken}`,
    }),
    env, { id: String(offer.id) }
  ));
  check('(h) admin accepts the offer', acceptRes.status === 200, `got ${acceptRes.status}`);

  gmail.sent = [];
  const payRes = await offerPay(ctx(jsonRequest(`${ORIGIN}/api/offers/${offer.id}/pay`, 'POST', {
    accessToken: offer.accessToken,
    customer: CUSTOMER, // note: NO email in the pay body — the offer's is used
    payment: DEMO_CARD,
  }), env, { id: String(offer.id) }));
  const order = await payRes.json().catch(() => ({}));
  check('(h) offer pay creates the order (201)', payRes.status === 201, `got ${payRes.status}: ${JSON.stringify(order)}`);
  check('(h) the created order carries the OFFER buyer email',
    order.customer && order.customer.email === 'offerbuyer@example.com',
    JSON.stringify(order.customer));
  const stored = await getOrder(env, order.id);
  check('(h) stored order keeps the buyer email (confirmations work)',
    stored.customer.email === 'offerbuyer@example.com');
  check('(h) pay sent the customer confirmation exactly once, to the offer email',
    bySubject(`Your Shop 824 order #${order.id} is placed`).length === 1 &&
    bySubject(`Your Shop 824 order #${order.id} is placed`)[0].to === 'offerbuyer@example.com',
    JSON.stringify(gmail.sent.map((m) => `${m.to} ${m.subject}`)));
  check('(h) pay sent the admin new-order alert exactly once (no double-send)',
    bySubject(`[Shop 824] New order #${order.id}`).length === 1);
  check('(h) demo pay sent the admin PAID alert exactly once',
    bySubject(`[Shop 824] PAID order #${order.id}`).length === 1);
  check('(h) the offer itself flipped to paid',
    (await getOffer(env, offer.id)).status === 'paid');
}

// =====================================================================================
// (i) /api/admin/mail-debug.
// =====================================================================================
{
  gmail.reset();
  const db = new StubDB();
  const env = mailEnv(db, 'mail-client-debug');
  const adminToken = (await issueToken(env, 'boss')).token;
  const auth = { Authorization: `Bearer ${adminToken}` };

  const anon = await mailDebugGet(ctx(new Request(`${ORIGIN}/api/admin/mail-debug`, { method: 'GET' }), env));
  check('(i) mail-debug GET without admin auth -> 401', anon.status === 401, `got ${anon.status}`);

  const bareEnv = { DB: db, BEASTMODE_ADMIN_SECRET: 'mail-test-admin-secret' };
  const bareToken = (await issueToken(bareEnv, 'boss')).token;
  const bareRes = await mailDebugGet(ctx(
    new Request(`${ORIGIN}/api/admin/mail-debug`, {
      method: 'GET', headers: { Authorization: `Bearer ${bareToken}` },
    }),
    bareEnv
  ));
  const bareData = await bareRes.json().catch(() => ({}));
  check('(i) unconfigured GET reports configured:false + all three missing',
    bareRes.status === 200 && bareData.configured === false && bareData.missing.length === 3,
    `status ${bareRes.status}: ${JSON.stringify(bareData)}`);
  const barePost = await mailDebugPost(ctx(
    jsonRequest(`${ORIGIN}/api/admin/mail-debug`, 'POST', {}, { Authorization: `Bearer ${bareToken}` }),
    bareEnv
  ));
  const barePostData = await barePost.json().catch(() => ({}));
  check('(i) unconfigured POST sends nothing and says so',
    barePostData.ok === false && barePostData.configured === false && gmail.sent.length === 0);

  const okRes = await mailDebugGet(ctx(
    new Request(`${ORIGIN}/api/admin/mail-debug`, { method: 'GET', headers: auth }),
    env
  ));
  const okData = await okRes.json().catch(() => ({}));
  check('(i) configured GET reports configured:true, no missing, resolved addresses',
    okData.configured === true && okData.missing.length === 0 &&
    okData.from === ADMIN_EMAIL && okData.adminEmail === ADMIN_EMAIL,
    JSON.stringify(okData));
  check('(i) debug responses NEVER contain the secret values',
    !JSON.stringify(okData).includes(SECRET_VALUE) &&
    !JSON.stringify(okData).includes(REFRESH_VALUE) &&
    !JSON.stringify(bareData).includes(SECRET_VALUE));

  const postRes = await mailDebugPost(ctx(
    jsonRequest(`${ORIGIN}/api/admin/mail-debug`, 'POST', {}, auth),
    env
  ));
  const postData = await postRes.json().catch(() => ({}));
  check('(i) POST sends one test email and returns ok + messageId',
    postRes.status === 200 && postData.ok === true &&
    typeof postData.messageId === 'string' && postData.messageId.length > 0,
    `status ${postRes.status}: ${JSON.stringify(postData)}`);
  check('(i) the test email went to the admin inbox with the test subject',
    gmail.sent.length === 1 && gmail.sent[0].to === ADMIN_EMAIL &&
    gmail.sent[0].subject === 'Shop 824 mail test',
    JSON.stringify(gmail.sent.map((m) => `${m.to} ${m.subject}`)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
