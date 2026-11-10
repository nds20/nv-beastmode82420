// Payments debug + reconcile tests (2026-11-10) — plain node, no
// framework:
//
//   node scripts/test-payments-debug.mjs
//
// Mirrors scripts/test-order-signal.mjs / test-mail.mjs: an
// in-memory D1 stub, a stubbed global fetch (Stripe + Google only),
// the REAL handler modules, and signed Stripe webhooks. Covers
// docs/PAYMENTS_DEBUG.md — the incident build: Stripe collected two
// real payments that never landed in the shop's records.
//
//   (a) admin gate: anonymous / garbage token -> 401.
//   (b) unconfigured env: configured:false shapes, keyMode null,
//       sessions [], NO Stripe call attempted, mail token
//       'not_configured' with all three vars missing.
//   (c) DONATION reconcile: a paid $8.24 donation session in
//       Stripe's list is classified 'donation', recordedBefore
//       false -> the endpoint records it through the webhook's
//       production path -> recordedAfter true and the reported
//       stats read { 824, 1 }. A SECOND call is a pure no-op
//       (recordedBefore true, stats still { 824, 1 }).
//   (d) ORDER reconcile: a placed (unpaid) order whose stored
//       session Stripe now reports paid flips to 'paid', tracked
//       stock decrements EXACTLY once across two endpoint calls,
//       and the reported ordersSignal follows it.
//   (e) UNKNOWN session: a paid session matching no order reads
//       kind 'unknown' with recorded* nulls + the explanatory note
//       and changes nothing.
//   (f) FILTER: unpaid and >3-day-old sessions never appear.
//   (g) keyMode: sk_live_ -> 'live', sk_test_ -> 'test',
//       unparseable prefix -> 'unknown'.
//   (h) STRIPE ERROR: a failing list call surfaces stripeError
//       { status, errorCode } with sessions [] — no raw body, no
//       throw.
//   (i) MAIL TOKEN: configured + Google refusing the refresh token
//       -> token { ok:false, status, errorCode:'invalid_grant' },
//       and the diagnostic sends NO email.
//   (j) SECRECY: the serialized response never contains any stub
//       secret value (Stripe keys, webhook secret, Google client
//       secret, refresh token, minted access token).

import {
  createProduct,
  getProduct,
  getOrder,
  createOrder,
  updateOrderPayment,
  getLatestPaidOrder,
} from '../functions/api/_lib/db.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import { getDonationStats } from '../functions/api/_lib/donations.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import { onRequestGet as paymentsDebugGet } from '../functions/api/admin/payments-debug.js';

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

// ----- Secrets (asserted absent from every response below) ----------------------

const STRIPE_LIVE_KEY = 'sk_live_DEBUGKEY-SECRET-VALUE';
const STRIPE_TEST_KEY = 'sk_test_DEBUGKEY-SECRET-VALUE';
const WEBHOOK_SECRET_VALUE = 'whsec_DEBUG-SECRET-VALUE';
const GOOGLE_SECRET_VALUE = 'GOOGLE-CLIENT-SECRET-VALUE';
const GOOGLE_REFRESH_VALUE = 'GOOGLE-REFRESH-TOKEN-VALUE';
const GOOGLE_ACCESS_VALUE = 'GOOGLE-ACCESS-TOKEN-VALUE';
const ALL_SECRET_VALUES = [
  STRIPE_LIVE_KEY,
  STRIPE_TEST_KEY,
  WEBHOOK_SECRET_VALUE,
  GOOGLE_SECRET_VALUE,
  GOOGLE_REFRESH_VALUE,
  GOOGLE_ACCESS_VALUE,
];

// ----- In-memory D1 stub (test-order-signal.mjs pattern, full schema) -----------
//
// The donations table is handled with the donations-aware extensions
// of the mail suite's stub (INSERT OR IGNORE by session id + the
// aggregate stats read + the payments-debug presence probe).

const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in',
  'height_in', 'stock_qty', 'low_stock_threshold', 'free_shipping',
  'brand', 'sizes', 'scent', 'condition', 'accepts_offers',
  'gender', 'size_inventory',
];
const ORDER_COLS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz',
  'inventory_applied',
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
    const cols = table === 'products' ? PRODUCT_COLS : ORDER_COLS;
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
    const isIgnore = /INSERT OR IGNORE/i.test(stmt);
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
    // INSERT OR IGNORE semantics for the donations UNIQUE index on
    // stripe_session_id: a duplicate insert changes nothing.
    if (isIgnore && table === 'donations') {
      if (this.state.donations.some((d) => d.stripe_session_id === row.stripe_session_id)) {
        return { meta: { last_row_id: 0, changes: 0 } };
      }
      row.id = ++this.lastId.donations;
      this.state.donations.push(row);
      return { meta: { last_row_id: row.id, changes: 1 } };
    }
    row.id = ++this.lastId[table];
    this.state[table].push(row);
    return { meta: { last_row_id: row.id, changes: 1 } };
  }

  updateRows(table, stmt, params) {
    // The inventory decrement is its own SQL shape (scalar MAX).
    if (/SET stock_qty = MAX\(0, stock_qty - \?\)/.test(stmt)) {
      const [qty, id] = params;
      const row = this.state.products.find((r) => r.id === Number(id));
      if (row && row.stock_qty != null) {
        row.stock_qty = Math.max(0, row.stock_qty - Number(qty));
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    // Best Offer flip (markOfferPaidByOrderId): no offers exist in
    // this suite, exactly the ordinary-order case.
    if (table === 'offers' && /WHERE order_id = \? AND status = 'accepted'/.test(stmt)) {
      return { meta: { changes: 0 } };
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
    if (/^CREATE TABLE IF NOT EXISTS (offers|donations)/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^INSERT INTO products/i.test(stmt)) return this.insertRow('products', stmt, params);
    if (/^INSERT INTO orders/i.test(stmt)) return this.insertRow('orders', stmt, params);
    if (/^INSERT OR IGNORE INTO donations/i.test(stmt)) return this.insertRow('donations', stmt, params);
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    if (/^UPDATE offers/i.test(stmt)) return this.updateRows('offers', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM offers/i.test(stmt)
      ? 'offers'
      : /FROM donations/i.test(stmt)
        ? 'donations'
        : /FROM products/i.test(stmt) ? 'products' : 'orders';
    let rows = [...this.state[table]];
    if (/FROM donations/i.test(stmt)) {
      // The aggregate stats read (getDonationStats).
      if (/^SELECT COALESCE\(SUM\(amount_cents\)/i.test(stmt)) {
        return [{
          totalCents: rows.reduce((sum, r) => sum + (Number(r.amount_cents) || 0), 0),
          donationCount: rows.length,
        }];
      }
      // The recorded-presence probe (donationRecorded).
      if (/stripe_session_id = \?/.test(stmt)) {
        return rows.filter((r) => r.stripe_session_id === params[0]);
      }
      return rows;
    }
    if (/payment_status = 'paid'/.test(stmt)) {
      // The signal query: paid only, highest id first, one row.
      rows = rows.filter((r) => r.payment_status === 'paid').sort((a, b) => b.id - a.id);
      rows = /LIMIT 1/i.test(stmt) ? rows.slice(0, 1) : rows;
    } else if (/stripe_session_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.stripe_session_id === params[0]);
    } else if (/WHERE id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.id === Number(params[0]));
    }
    if (/ORDER BY id DESC/i.test(stmt) && !/LIMIT 1/i.test(stmt)) {
      rows.sort((a, b) => b.id - a.id);
    }
    return rows;
  }

  first(stmt, params) {
    if (/^SELECT COUNT/i.test(stmt)) {
      const rows = this.selectRows(stmt, params);
      const m = stmt.match(/status = '(\w+)'/);
      const n = m ? rows.filter((r) => r.status === m[1]).length : rows.length;
      return { n };
    }
    return this.selectRows(stmt, params)[0] || null;
  }

  all(stmt, params) {
    if (/^PRAGMA table_info\((\w+)\)/.test(stmt)) {
      return this.pragma(stmt.match(/PRAGMA table_info\((\w+)\)/)[1]);
    }
    return { results: this.selectRows(stmt, params) };
  }
}

// ----- Fetch mock (Stripe + Google only) -----------------------------------------

const STRIPE_BASE = 'https://stripe.test';
const stripe = {
  sessions: [],
  listCalls: 0,
  mode: 'ok', // 'ok' | 'http401' | 'throw'
  lastAuth: null,
  reset() {
    this.sessions = [];
    this.listCalls = 0;
    this.mode = 'ok';
    this.lastAuth = null;
  },
};
const google = {
  tokenCalls: 0,
  sendCalls: 0,
  tokenMode: 'ok', // 'ok' | 'invalid_grant'
  reset() {
    this.tokenCalls = 0;
    this.sendCalls = 0;
    this.tokenMode = 'ok';
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(`${STRIPE_BASE}/v1/checkout/sessions`)) {
    stripe.listCalls += 1;
    stripe.lastAuth = (init.headers && init.headers.Authorization) || null;
    if (stripe.mode === 'throw') throw new Error('stripe network boom');
    if (stripe.mode === 'http401') {
      return new Response(
        JSON.stringify({
          error: {
            code: 'api_key_expired',
            message: 'RAW-STRIPE-BODY-MARKER: Expired API Key provided.',
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ object: 'list', data: stripe.sessions }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (u === 'https://oauth2.googleapis.com/token') {
    google.tokenCalls += 1;
    if (google.tokenMode === 'invalid_grant') {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ access_token: GOOGLE_ACCESS_VALUE, expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (u.startsWith('https://gmail.googleapis.com/')) {
    google.sendCalls += 1;
    return new Response(
      JSON.stringify({ id: 'gmail-msg-debug', threadId: 'thread-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return realFetch(url, init);
};

// ----- Helpers ----------------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';
const nowSec = () => Math.floor(Date.now() / 1000);

function ctx(request, env, params = {}) {
  return { request, env, params, waitUntil() {} };
}

const ADMIN_CREDS = {
  BEASTMODE_ADMIN_USER: 'boss',
  BEASTMODE_ADMIN_PASSWORD: ['payments', 'debug', 'pass'].join('-'),
  BEASTMODE_ADMIN_SECRET: ['payments-debug', 'token', 'secret'].join('-'),
};

async function callDebug(env, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await paymentsDebugGet(ctx(
    new Request(`${ORIGIN}/api/admin/payments-debug`, { method: 'GET', headers }),
    env
  ));
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* secrecy checks read the raw text */ }
  return { status: res.status, data, text };
}

function fullEnv(db, extra = {}) {
  return {
    DB: db,
    ...ADMIN_CREDS,
    STRIPE_SECRET_KEY: STRIPE_LIVE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET_VALUE,
    STRIPE_API_BASE: STRIPE_BASE,
    GOOGLE_OAUTH_CLIENT_ID: 'payments-debug-client',
    GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE_SECRET_VALUE,
    GOOGLE_OAUTH_REFRESH_TOKEN: GOOGLE_REFRESH_VALUE,
    ...extra,
  };
}

// A googleEnv is a fullEnv with a SCENARIO-SPECIFIC client id: the
// mail lib's token cache is isolate-wide, keyed by client id (the
// test-mail.mjs convention), so scenarios that exercise different
// token outcomes must never share one — a cached success would
// otherwise mask a later scenario's refused refresh token.
let googleClientSeq = 0;
function googleEnv(db, extra = {}) {
  googleClientSeq += 1;
  return fullEnv(db, {
    GOOGLE_OAUTH_CLIENT_ID: `payments-debug-client-${googleClientSeq}`,
    ...extra,
  });
}

function paidDonationSession(over = {}) {
  return {
    id: 'cs_live_donation_824',
    object: 'checkout.session',
    amount_total: 824,
    currency: 'usd',
    payment_status: 'paid',
    status: 'complete',
    created: nowSec() - 3600,
    metadata: { kind: 'donation', project: 'project-gamma' },
    customer_details: { email: 'donor@example.com' },
    payment_intent: 'pi_donation_824',
    ...over,
  };
}

async function makeProduct(env, over = {}) {
  const data = normalizeProduct({
    name: 'Test Item',
    category: 'test-item',
    type: 'Test',
    price: 8.24,
    ...over,
  });
  return createProduct(env, data);
}

// =====================================================================================
// (a) Admin gate.
// =====================================================================================
{
  const db = new StubDB();
  const env = fullEnv(db);
  const anon = await callDebug(env, null);
  check('(a) payments-debug without admin auth -> 401', anon.status === 401, `got ${anon.status}`);
  const garbage = await callDebug(env, 'not-a-token');
  check('(a) payments-debug with a garbage token -> 401', garbage.status === 401, `got ${garbage.status}`);
  check('(a) the gate fires before ANY Stripe or Google call',
    stripe.listCalls === 0 && google.tokenCalls === 0,
    `stripe=${stripe.listCalls} google=${google.tokenCalls}`);
}

// =====================================================================================
// (b) Unconfigured env.
// =====================================================================================
{
  stripe.reset();
  const db = new StubDB();
  const env = { DB: db, ...ADMIN_CREDS };
  const { token } = await issueToken(env, 'boss');
  const res = await callDebug(env, token);
  check('(b) unconfigured env still answers 200 to an admin', res.status === 200, `got ${res.status}`);
  check('(b) stripe.configured false and keyMode null',
    res.data.stripe && res.data.stripe.configured === false && res.data.stripe.keyMode === null,
    JSON.stringify(res.data.stripe));
  check('(b) webhook.configured false',
    res.data.webhook && res.data.webhook.configured === false,
    JSON.stringify(res.data.webhook));
  check('(b) sessions [] and NO list call attempted',
    Array.isArray(res.data.sessions) && res.data.sessions.length === 0 && stripe.listCalls === 0,
    `listCalls=${stripe.listCalls}`);
  check('(b) aggregates read as empty',
    res.data.donationStats && res.data.donationStats.totalCents === 0 &&
    res.data.donationStats.donationCount === 0 &&
    res.data.ordersSignal && res.data.ordersSignal.latestPaidOrderId === null &&
    res.data.ordersSignal.latestPaidAt === null,
    JSON.stringify(res.data));
  check('(b) mail token is not_configured with all three vars missing',
    res.data.mail && res.data.mail.configured === false &&
    res.data.mail.missing.join(',') ===
      'GOOGLE_OAUTH_CLIENT_ID,GOOGLE_OAUTH_CLIENT_SECRET,GOOGLE_OAUTH_REFRESH_TOKEN' &&
    res.data.mail.token.ok === false && res.data.mail.token.status === null &&
    res.data.mail.token.errorCode === 'not_configured',
    JSON.stringify(res.data.mail));
  check('(b) the report carries exactly the documented top-level fields',
    Object.keys(res.data).sort().join(',') === 'donationStats,mail,ordersSignal,sessions,stripe,webhook',
    Object.keys(res.data).join(','));
}

// =====================================================================================
// (c)+(f) Donation reconcile + session filter.
// =====================================================================================
{
  stripe.reset();
  google.reset();
  const db = new StubDB();
  const env = googleEnv(db);
  const { token } = await issueToken(env, 'boss');

  const tooOld = nowSec() - 4 * 24 * 60 * 60;
  stripe.sessions = [
    paidDonationSession(),
    // An unpaid session and an old paid one must never be reported.
    paidDonationSession({ id: 'cs_live_unpaid_1', payment_status: 'unpaid', status: 'open', amount_total: 2000 }),
    paidDonationSession({ id: 'cs_live_old_1', created: tooOld, amount_total: 5000 }),
  ];

  const first = await callDebug(env, token);
  check('(c) call answers 200 with the live key mode',
    first.status === 200 && first.data.stripe.configured === true && first.data.stripe.keyMode === 'live',
    `status ${first.status}: ${JSON.stringify(first.data.stripe)}`);
  check('(c) the list call carried the configured key as bearer auth',
    stripe.lastAuth === `Bearer ${STRIPE_LIVE_KEY}`);
  check('(f) unpaid and >3-day-old sessions are filtered out',
    first.data.sessions.length === 1, JSON.stringify(first.data.sessions));
  const entry = first.data.sessions[0] || {};
  check('(c) donation session classified + projected',
    entry.kind === 'donation' && entry.amountTotalCents === 824 &&
    entry.currency === 'usd' && entry.paymentStatus === 'paid' &&
    entry.sessionStatus === 'complete' && entry.idPrefix === 'cs_live_dona' &&
    Number.isInteger(entry.created),
    JSON.stringify(entry));
  check('(c) recordedBefore false — the incident state',
    entry.recordedBefore === false, JSON.stringify(entry));
  check('(c) recordedAfter true — reconcile recorded the gift',
    entry.recordedAfter === true, JSON.stringify(entry));
  check('(c) reported donationStats read { 824, 1 }',
    first.data.donationStats.totalCents === 824 && first.data.donationStats.donationCount === 1,
    JSON.stringify(first.data.donationStats));
  const stats = await getDonationStats(env);
  check('(c) the donations table really holds the gift',
    stats.totalCents === 824 && stats.donationCount === 1 &&
    db.state.donations.length === 1 && db.state.donations[0].project === 'project-gamma',
    JSON.stringify(db.state.donations));

  const second = await callDebug(env, token);
  const entry2 = second.data.sessions[0] || {};
  check('(c) second call: recordedBefore true (already whole)',
    entry2.recordedBefore === true, JSON.stringify(entry2));
  check('(c) second call is a no-op: still exactly one donation of 824',
    second.data.donationStats.totalCents === 824 &&
    second.data.donationStats.donationCount === 1 && db.state.donations.length === 1,
    JSON.stringify(second.data.donationStats));
}

// =====================================================================================
// (d) Order reconcile — paid flip + exactly-once stock decrement.
// =====================================================================================
{
  stripe.reset();
  google.reset();
  const db = new StubDB();
  const env = googleEnv(db);
  const { token } = await issueToken(env, 'boss');

  const product = await makeProduct(env, { stockQty: 5 });
  check('(d) fixture product is tracked at 5',
    (await getProduct(env, product.id)).stockQty === 5);

  // The shop's real placement shape (no payment payload), then the
  // checkout route's stamp: pending + the Stripe session id.
  const order = await createOrder(env, {
    items: [{ productId: product.id, name: 'Test Item', qty: 2, unitPrice: 8.24, lineTotal: 16.48 }],
    subtotal: 16.48,
    tax: 1.68,
    total: 18.16,
    customer: { fullName: 'Test Buyer', email: 'buyer@example.com' },
    payment: null,
  });
  await updateOrderPayment(env, order.id, {
    paymentStatus: 'pending',
    stripeSessionId: 'cs_live_order_908',
  });
  check('(d) fixture order rests pending with its session id',
    (await getOrder(env, order.id)).paymentStatus === 'pending');

  stripe.sessions = [{
    id: 'cs_live_order_908',
    object: 'checkout.session',
    amount_total: 1816,
    currency: 'usd',
    payment_status: 'paid',
    status: 'complete',
    created: nowSec() - 7200,
    metadata: { order_id: String(order.id) },
    client_reference_id: String(order.id),
    payment_intent: 'pi_order_908',
  }];

  const first = await callDebug(env, token);
  const entry = first.data.sessions[0] || {};
  check('(d) order session classified + projected',
    first.data.sessions.length === 1 && entry.kind === 'order' &&
    entry.amountTotalCents === 1816 && entry.idPrefix === 'cs_live_orde',
    JSON.stringify(first.data.sessions));
  check('(d) recordedBefore false (order not yet paid)',
    entry.recordedBefore === false, JSON.stringify(entry));
  check('(d) recordedAfter true (reconcile stamped it paid)',
    entry.recordedAfter === true, JSON.stringify(entry));
  const paidOrder = await getOrder(env, order.id);
  check('(d) the order row is paid with Stripe ids recorded',
    paidOrder.paymentStatus === 'paid' && paidOrder.stripeSessionId === 'cs_live_order_908' &&
    paidOrder.stripePaymentIntentId === 'pi_order_908' && paidOrder.inventoryApplied === 1,
    JSON.stringify({ s: paidOrder.paymentStatus, inv: paidOrder.inventoryApplied }));
  check('(d) tracked stock decremented by the ordered qty (5 -> 3)',
    (await getProduct(env, product.id)).stockQty === 3,
    `stock=${(await getProduct(env, product.id)).stockQty}`);
  check('(d) reported ordersSignal follows the reconciled order',
    first.data.ordersSignal.latestPaidOrderId === order.id &&
    first.data.ordersSignal.latestPaidAt === order.createdAt,
    JSON.stringify(first.data.ordersSignal));

  const second = await callDebug(env, token);
  const entry2 = second.data.sessions[0] || {};
  check('(d) second call: recordedBefore true, no double work',
    entry2.recordedBefore === true && entry2.recordedAfter === true,
    JSON.stringify(entry2));
  check('(d) stock decremented EXACTLY once across both calls (still 3)',
    (await getProduct(env, product.id)).stockQty === 3,
    `stock=${(await getProduct(env, product.id)).stockQty}`);
  const signal = await getLatestPaidOrder(env);
  check('(d) getLatestPaidOrder agrees throughout',
    signal.latestPaidOrderId === order.id && signal.latestPaidAt === order.createdAt);
}

// =====================================================================================
// (e) Unknown session.
// =====================================================================================
{
  stripe.reset();
  google.reset();
  const db = new StubDB();
  const env = googleEnv(db);
  const { token } = await issueToken(env, 'boss');
  stripe.sessions = [{
    id: 'cs_live_stranger_1',
    object: 'checkout.session',
    amount_total: 4200,
    currency: 'usd',
    payment_status: 'paid',
    status: 'complete',
    created: nowSec() - 1800,
    metadata: {},
    client_reference_id: 'not-an-order',
    payment_intent: 'pi_stranger_1',
  }];
  const res = await callDebug(env, token);
  const entry = res.data.sessions[0] || {};
  check('(e) unmatched paid session reads kind unknown',
    res.data.sessions.length === 1 && entry.kind === 'unknown', JSON.stringify(res.data.sessions));
  check('(e) unknown carries recorded nulls + the explanatory note',
    entry.recordedBefore === null && entry.recordedAfter === null &&
    entry.note === 'no matching order in db',
    JSON.stringify(entry));
  check('(e) the unknown session changed nothing',
    db.state.orders.length === 0 && db.state.donations.length === 0 &&
    res.data.donationStats.donationCount === 0 &&
    res.data.ordersSignal.latestPaidOrderId === null,
    JSON.stringify(res.data));
}

// =====================================================================================
// (g) keyMode from prefix only.
// =====================================================================================
{
  stripe.reset();
  const db = new StubDB();
  const testEnv = googleEnv(db, { STRIPE_SECRET_KEY: STRIPE_TEST_KEY });
  const { token } = await issueToken(testEnv, 'boss');
  const testRes = await callDebug(testEnv, token);
  check('(g) sk_test_ key -> keyMode test',
    testRes.data.stripe.configured === true && testRes.data.stripe.keyMode === 'test',
    JSON.stringify(testRes.data.stripe));
  const weirdEnv = googleEnv(db, { STRIPE_SECRET_KEY: 'pk_live_not-a-secret-key' });
  const weirdRes = await callDebug(weirdEnv, token);
  check('(g) unparseable prefix -> keyMode unknown (still configured)',
    weirdRes.data.stripe.configured === true && weirdRes.data.stripe.keyMode === 'unknown',
    JSON.stringify(weirdRes.data.stripe));
}

// =====================================================================================
// (h) Stripe list failure -> stripeError, never a raw body.
// =====================================================================================
{
  stripe.reset();
  stripe.mode = 'http401';
  const db = new StubDB();
  const env = googleEnv(db);
  const { token } = await issueToken(env, 'boss');
  const res = await callDebug(env, token);
  check('(h) Stripe 401 -> endpoint still answers 200 with sessions []',
    res.status === 200 && Array.isArray(res.data.sessions) && res.data.sessions.length === 0,
    `status ${res.status}: ${JSON.stringify(res.data)}`);
  check('(h) stripeError carries status + error CODE only',
    res.data.stripeError && res.data.stripeError.status === 401 &&
    res.data.stripeError.errorCode === 'api_key_expired',
    JSON.stringify(res.data.stripeError));
  check('(h) the raw Stripe error body never reaches the response',
    !res.text.includes('RAW-STRIPE-BODY-MARKER') && !res.text.includes('Expired API Key'));
}

// =====================================================================================
// (i)+(j) Mail token diagnostics + secrecy across a fully-wired call.
// =====================================================================================
{
  stripe.reset();
  google.reset();
  const db = new StubDB();
  const env = googleEnv(db);
  const { token } = await issueToken(env, 'boss');

  google.tokenMode = 'invalid_grant';
  stripe.sessions = [paidDonationSession()];
  const bad = await callDebug(env, token);
  check('(i) refused refresh token -> token { ok:false, 400, invalid_grant }',
    bad.data.mail.configured === true && bad.data.mail.missing.length === 0 &&
    bad.data.mail.token.ok === false && bad.data.mail.token.status === 400 &&
    bad.data.mail.token.errorCode === 'invalid_grant',
    JSON.stringify(bad.data.mail));
  check('(i) the token diagnostic sends NO email',
    google.sendCalls === 0, `sendCalls=${google.sendCalls}`);

  google.tokenMode = 'ok';
  const good = await callDebug(env, token);
  check('(i) healthy token exchange -> token { ok:true, 200, null }',
    good.data.mail.token.ok === true && good.data.mail.token.status === 200 &&
    good.data.mail.token.errorCode === null,
    JSON.stringify(good.data.mail));
  check('(j) NO secret value appears anywhere in either serialized response',
    ALL_SECRET_VALUES.every((v) => !bad.text.includes(v) && !good.text.includes(v)),
    'a stub secret leaked into the response');
  check('(j) the response is otherwise complete (donation reconciled in this call too)',
    good.data.donationStats.totalCents === 824 && good.data.donationStats.donationCount === 1,
    JSON.stringify(good.data.donationStats));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
