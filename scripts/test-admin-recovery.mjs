// Admin password recovery tests (2026-11-09) — plain node, no framework:
//
//   node scripts/test-admin-recovery.mjs
//
// Mirrors the other suites: an in-memory D1 stub (the database cannot
// be run here) and the REAL route handlers + _lib modules. The stub
// covers exactly the tables this flow touches — admin_accounts,
// app_settings, and an empty orders table for the protected-route
// check. Covers the spec's list:
//   (a) ADMIN_RECOVERY_CODE unset -> 503 with the setup guidance
//   (b) wrong code -> generic 403; no account created or changed
//   (c) correct code on a NEW username -> success + token; the new
//       password then signs in via authSource 'account' even though
//       the env credentials are set to something else, and env login
//       still wins its own precedence
//   (d) correct code on an EXISTING stored username replaces the
//       password (old one dies, new one works, created_at kept)
//   (e) rate limit: 5 failed attempts -> the 6th is 429 even with the
//       CORRECT code; timestamps older than the 60-minute window are
//       pruned, so the correct code succeeds again afterwards
//   (f) new password under 10 characters -> 400 (and username < 3)
//   (g) the token the reset issues is accepted by requireAdmin
//       (GET /api/admin/orders -> 200; without it -> 401)
//   (h) a successful reset clears the failure counter

import {
  createAccount,
  findAccount,
  hasAccounts,
  getRecoveryFailures,
  setSetting,
  RECOVERY_ATTEMPT_KEY,
} from '../functions/api/_lib/db.js';
import { onRequestPost as resetPost } from '../functions/api/admin/recovery/reset.js';
import { onRequestPost as loginPost } from '../functions/api/admin/login.js';
import { onRequestGet as adminOrdersGet } from '../functions/api/admin/orders.js';

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

// ----- In-memory D1 stub -------------------------------------------------------
// Statements are matched by shape; anything unhandled throws, like the
// other suites, so a new SQL shape in the code fails loudly here.

const ORDER_COLS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz', 'inventory_applied',
];
const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'brand', 'sizes', 'scent', 'weight_oz', 'length_in', 'width_in',
  'height_in', 'stock_qty', 'low_stock_threshold', 'free_shipping',
];

class StubDB {
  constructor() {
    this.state = { accounts: [], settings: new Map(), orders: [] };
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

  accountByName(username) {
    const wanted = String(username || '').trim().toLowerCase();
    return this.state.accounts.find((r) => r.username.toLowerCase() === wanted) || null;
  }

  insertAccount(stmt, params) {
    // Both the plain INSERT (createAccount) and the recovery upsert
    // bind (username, salt, hash, created_at) in column order.
    const [username, salt, hash, createdAt] = params;
    const existing = this.accountByName(username);
    if (/ON CONFLICT/i.test(stmt) && existing) {
      existing.salt = salt;
      existing.hash = hash;
      return { meta: { changes: 1 } };
    }
    this.state.accounts.push({ username, salt, hash, created_at: createdAt });
    return { meta: { last_row_id: this.state.accounts.length, changes: 1 } };
  }

  run(stmt, params) {
    if (/^INSERT INTO admin_accounts/i.test(stmt)) return this.insertAccount(stmt, params);
    if (/^INSERT INTO app_settings/i.test(stmt)) {
      this.state.settings.set(params[0], String(params[1]));
      return { meta: { changes: 1 } };
    }
    if (/^ALTER TABLE/i.test(stmt)) return { meta: { changes: 0 } };
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  first(stmt, params) {
    if (/^SELECT COUNT\(\*\) AS n FROM admin_accounts/i.test(stmt)) {
      return { n: this.state.accounts.length };
    }
    if (/FROM admin_accounts WHERE username = \?/i.test(stmt)) {
      return this.accountByName(params[0]);
    }
    if (/^SELECT value FROM app_settings WHERE key = \?/i.test(stmt)) {
      const value = this.state.settings.get(params[0]);
      return value === undefined ? null : { value };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM orders/i.test(stmt)) {
      return { n: this.state.orders.length };
    }
    throw new Error(`StubDB: unhandled first(): ${stmt}`);
  }

  all(stmt) {
    const pragma = stmt.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragma) {
      const cols = pragma[1] === 'products' ? PRODUCT_COLS : ORDER_COLS;
      return { results: cols.map((name) => ({ name })) };
    }
    if (/FROM orders/i.test(stmt)) return { results: [...this.state.orders] };
    throw new Error(`StubDB: unhandled all(): ${stmt}`);
  }
}

// ----- Helpers -----------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';
const CODE = 'test-recovery-code-0123456789abcdef';

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

function baseEnv(db, extra = {}) {
  return {
    DB: db,
    BEASTMODE_ADMIN_SECRET: 'recovery-test-signing-secret',
    BEASTMODE_ADMIN_USER: 'bossman',
    BEASTMODE_ADMIN_PASSWORD: 'the-env-password',
    ADMIN_RECOVERY_CODE: CODE,
    ...extra,
  };
}

async function callReset(env, body) {
  const res = await resetPost(ctx(jsonRequest(`${ORIGIN}/api/admin/recovery/reset`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function callLogin(env, username, password) {
  const res = await loginPost(ctx(jsonRequest(`${ORIGIN}/api/admin/login`, 'POST', { username, password }), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// =====================================================================================
// (a) No recovery code configured -> 503 with the owner-actionable guidance.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  delete env.ADMIN_RECOVERY_CODE;
  const res = await callReset(env, { username: 'nicholas', recoveryCode: 'whatever', newPassword: 'long-enough-pass' });
  check('(a) unset code -> 503', res.status === 503, `got ${res.status}`);
  check(
    '(a) 503 names the Cloudflare fix',
    typeof res.data.error === 'string' && res.data.error.includes('ADMIN_RECOVERY_CODE') && res.data.error.includes('not set up'),
    res.data.error || ''
  );
  check('(a) 503 creates nothing', (await hasAccounts(env)) === false);
}

// =====================================================================================
// (b) Wrong code -> one generic 403; nothing is created or changed.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const res = await callReset(env, { username: 'ghost', recoveryCode: 'not-the-code', newPassword: 'long-enough-pass' });
  check('(b) wrong code -> 403', res.status === 403, `got ${res.status}`);
  check('(b) 403 is the generic message', res.data.error === 'That recovery code is not correct.', res.data.error || '');
  check('(b) no account created', (await findAccount(env, 'ghost')) === null);
  check('(b) failure was counted', (await getRecoveryFailures(env)).length === 1);
}

// =====================================================================================
// (c) Correct code, NEW username -> stored account + token; login via
// 'account' despite different env credentials. (g) rides along here.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const res = await callReset(env, { username: 'nicholas', recoveryCode: CODE, newPassword: 'brand-new-pass-1' });
  check('(c) new username reset -> 201', res.status === 201, `got ${res.status}`);
  check('(c) authSource is account', res.data.authSource === 'account', res.data.authSource || '');
  check('(c) a token came back', typeof res.data.token === 'string' && res.data.token.length > 10);

  const login = await callLogin(env, 'nicholas', 'brand-new-pass-1');
  check('(c) new password signs in', login.status === 200, `got ${login.status}`);
  check('(c) sign-in source is the stored account', login.data.authSource === 'account', login.data.authSource || '');

  const wrong = await callLogin(env, 'nicholas', 'the-env-password');
  check('(c) env password does NOT sign in as nicholas', wrong.status === 401, `got ${wrong.status}`);

  const envLogin = await callLogin(env, 'bossman', 'the-env-password');
  check('(c) env credentials still sign in as env', envLogin.status === 200 && envLogin.data.authSource === 'env');

  // (g) The reset's token passes requireAdmin on a protected route.
  const okRes = await adminOrdersGet(
    ctx(jsonRequest(`${ORIGIN}/api/admin/orders`, 'GET', undefined, { Authorization: `Bearer ${res.data.token}` }), env)
  );
  check('(g) reset token opens a protected route', okRes.status === 200, `got ${okRes.status}`);
  const noRes = await adminOrdersGet(ctx(jsonRequest(`${ORIGIN}/api/admin/orders`, 'GET'), env));
  check('(g) no token -> 401', noRes.status === 401, `got ${noRes.status}`);
}

// =====================================================================================
// (d) Correct code on an EXISTING stored username replaces the password.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const seeded = await createAccount(env, 'olduser', 'old-password-99');
  const res = await callReset(env, { username: 'olduser', recoveryCode: CODE, newPassword: 'replacement-pass-2' });
  check('(d) existing username reset -> 200', res.status === 200, `got ${res.status}`);
  check('(d) authSource is account', res.data.authSource === 'account');
  const after = await findAccount(env, 'olduser');
  check('(d) created_at is preserved', after.created_at === seeded.createdAt, `${after.created_at} vs ${seeded.createdAt}`);
  check('(d) still exactly one account row', db.state.accounts.length === 1);

  const oldLogin = await callLogin(env, 'olduser', 'old-password-99');
  check('(d) old password is dead', oldLogin.status === 401, `got ${oldLogin.status}`);
  const newLogin = await callLogin(env, 'olduser', 'replacement-pass-2');
  check('(d) new password signs in', newLogin.status === 200 && newLogin.data.authSource === 'account');
}

// =====================================================================================
// (e) Rate limit: 5 failures lock the endpoint (even the correct code
// gets 429) until the rolling window prunes the old attempts.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await callReset(env, { username: 'nicholas', recoveryCode: `wrong-${i}`, newPassword: 'long-enough-pass' });
    check(`(e) wrong attempt ${i} -> 403`, res.status === 403, `got ${res.status}`);
  }
  const locked = await callReset(env, { username: 'nicholas', recoveryCode: CODE, newPassword: 'long-enough-pass' });
  check('(e) 6th attempt with the CORRECT code -> 429', locked.status === 429, `got ${locked.status}`);
  check('(e) 429 message', locked.data.error === 'Too many tries — wait an hour and try again.', locked.data.error || '');
  check('(e) lockout created no account', (await findAccount(env, 'nicholas')) === null);

  // Simulate the hour passing: every recorded failure is now stale.
  const stale = Date.now() - 61 * 60 * 1000;
  await setSetting(env, RECOVERY_ATTEMPT_KEY, JSON.stringify([stale, stale, stale, stale, stale]));
  const after = await callReset(env, { username: 'nicholas', recoveryCode: CODE, newPassword: 'long-enough-pass' });
  check('(e) after the window the correct code succeeds', after.status === 201, `got ${after.status}`);
  check('(e) success cleared the counter', (await getRecoveryFailures(env)).length === 0);
}

// =====================================================================================
// (f) Field validation: short new password -> 400; short username -> 400.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const short = await callReset(env, { username: 'nicholas', recoveryCode: CODE, newPassword: 'short' });
  check('(f) new password under 10 chars -> 400', short.status === 400, `got ${short.status}`);
  check('(f) 400 explains the minimum', (short.data.error || '').includes('at least 10 characters'), short.data.error || '');
  const tiny = await callReset(env, { username: 'ab', recoveryCode: CODE, newPassword: 'long-enough-pass' });
  check('(f) username under 3 chars -> 400', tiny.status === 400, `got ${tiny.status}`);
  check('(f) validation created nothing', (await hasAccounts(env)) === false);
  check('(f) validation failures do not spend the code budget', (await getRecoveryFailures(env)).length === 0);
}

// =====================================================================================
// (h) A successful reset clears a partially spent failure counter.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  await callReset(env, { username: 'nicholas', recoveryCode: 'nope-1', newPassword: 'long-enough-pass' });
  await callReset(env, { username: 'nicholas', recoveryCode: 'nope-2', newPassword: 'long-enough-pass' });
  check('(h) two failures recorded', (await getRecoveryFailures(env)).length === 2);
  const res = await callReset(env, { username: 'nicholas', recoveryCode: CODE, newPassword: 'long-enough-pass' });
  check('(h) reset succeeds under the limit', res.status === 201, `got ${res.status}`);
  check('(h) counter cleared by success', (await getRecoveryFailures(env)).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
