// Admin accounts (multi-admin) tests (2026-11-09) — plain node:
//
//   node scripts/test-admin-accounts.mjs
//
// Mirrors the other suites: an in-memory D1 stub and the REAL route
// handlers + _lib modules. The stub starts admin_accounts WITHOUT
// the must_change column so the lazy ensureAdminColumns ALTER is
// exercised, and carries the products table for the "a co-admin can
// still do product work" check. Covers the spec's list:
//   (a) a non-owner admin's token -> GET/POST/DELETE accounts = 403
//       (and no token at all -> 401)
//   (b) the env owner adds an admin -> 201 + a 16-char temporary
//       password returned exactly once (absent from the list)
//   (c) she signs in with the temp -> mustChangePassword true;
//       change-password: wrong current -> 400, weak new -> 400,
//       correct -> flag cleared, new password signs in, temp dead
//   (d) a non-owner admin CAN create products (201) but cannot list
//       accounts (403)
//   (e) delete protections: env owner -> 400, earliest stored ->
//       400, self -> 400, nonexistent -> 404, a normal co-admin ->
//       204 and her sign-in then fails; plus the env session's
//       change-password -> 400 naming Cloudflare
//   (f) duplicate usernames (exact, case variant, env name) -> 409;
//       invalid usernames (short/long/bad chars/'admin') -> 400
//   (g) owner-level via the EARLIEST stored account when no stored
//       username matches the env one: earliest manages, later can't
//
// Status-choice note (also in docs/ADMINS.md): change-password with
// a wrong current password is a 400, deliberately NOT a 401 — the
// session is valid, and adminApi clears the token on any authed
// 401, which would log her out for a typo.

import {
  createAccount,
  findAccount,
  listAdminAccounts,
} from '../functions/api/_lib/db.js';
import { onRequestPost as loginPost } from '../functions/api/admin/login.js';
import {
  onRequestGet as accountsGet,
  onRequestPost as accountsPost,
} from '../functions/api/admin/accounts/index.js';
import { onRequestDelete as accountDelete } from '../functions/api/admin/accounts/[username].js';
import { onRequestPost as changePasswordPost } from '../functions/api/admin/accounts/change-password.js';
import { onRequestPost as productsCreate } from '../functions/api/products.js';

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
// admin_accounts is tracked as row objects (username/salt/hash/
// created_at/must_change once added); products reuse the generic
// column-parsing insert from the clothing/product-editor suites.
// The stub's PRAGMA starts admin_accounts at its pre-multi-admin
// shape — ensureAdminColumns' ALTER lands in `alters` and the
// column joins the reported set from then on.

const ACCOUNT_BASE_COLS = ['username', 'salt', 'hash', 'created_at'];
const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'brand', 'sizes', 'scent', 'weight_oz', 'length_in', 'width_in',
  'height_in', 'stock_qty', 'low_stock_threshold', 'free_shipping',
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
    this.state = { accounts: [], products: [] };
    this.accountCols = [...ACCOUNT_BASE_COLS];
    this.alters = [];
    this.lastProductId = 0;
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
    // createAccount binds (username, salt, hash, created_at,
    // must_change); the upsert binds the first four and carries
    // must_change as a SQL literal 0. Both arrive here.
    const [username, salt, hash, createdAt] = params;
    const mustChange = /ON CONFLICT/i.test(stmt) ? 0 : (params[4] ? 1 : 0);
    const existing = this.accountByName(username);
    if (/ON CONFLICT/i.test(stmt) && existing) {
      existing.salt = salt;
      existing.hash = hash;
      existing.must_change = 0;
      return { meta: { changes: 1 } };
    }
    const row = { username, salt, hash, created_at: createdAt };
    if (this.accountCols.includes('must_change')) row.must_change = mustChange;
    else row.must_change = mustChange; // stub rows carry it regardless; PRAGMA is what varies
    this.state.accounts.push(row);
    return { meta: { last_row_id: this.state.accounts.length, changes: 1 } };
  }

  insertProduct(stmt, params) {
    const m = stmt.match(/INSERT INTO products \(([^)]+)\) VALUES \(([\s\S]+)\)/i);
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
    row.id = ++this.lastProductId;
    this.state.products.push(row);
    return { meta: { last_row_id: row.id, changes: 1 } };
  }

  run(stmt, params) {
    const alter = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (alter) {
      this.alters.push(`${alter[1]}.${alter[2]}`);
      if (alter[1] === 'admin_accounts' && !this.accountCols.includes(alter[2])) {
        this.accountCols.push(alter[2]);
        // A real ALTER ... DEFAULT 0 backfills existing rows.
        for (const row of this.state.accounts) {
          if (row[alter[2]] === undefined) row[alter[2]] = 0;
        }
      }
      return { meta: { changes: 0 } };
    }
    if (/^INSERT INTO admin_accounts/i.test(stmt)) return this.insertAccount(stmt, params);
    if (/^INSERT INTO products/i.test(stmt)) return this.insertProduct(stmt, params);
    if (/^DELETE FROM admin_accounts/i.test(stmt)) {
      const before = this.state.accounts.length;
      const wanted = String(params[0] || '').trim().toLowerCase();
      this.state.accounts = this.state.accounts.filter(
        (r) => r.username.toLowerCase() !== wanted
      );
      return { meta: { changes: before - this.state.accounts.length } };
    }
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  first(stmt, params) {
    if (/^SELECT COUNT\(\*\) AS n FROM admin_accounts/i.test(stmt)) {
      return { n: this.state.accounts.length };
    }
    if (/FROM admin_accounts WHERE username = \?/i.test(stmt)) {
      return this.accountByName(params[0]);
    }
    if (/FROM products/i.test(stmt)) {
      const row = this.state.products.find((r) => r.id === Number(params[0]));
      return row || null;
    }
    throw new Error(`StubDB: unhandled first(): ${stmt}`);
  }

  all(stmt) {
    const pragma = stmt.match(/^PRAGMA table_info\((\w+)\)/i);
    if (pragma) {
      const table = pragma[1];
      const cols = table === 'admin_accounts'
        ? this.accountCols
        : table === 'products'
          ? PRODUCT_COLS
          : ORDER_COLS;
      return { results: cols.map((name) => ({ name })) };
    }
    if (/FROM admin_accounts/i.test(stmt)) {
      const rows = [...this.state.accounts].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        const an = a.username.toLowerCase();
        const bn = b.username.toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      return { results: rows };
    }
    if (/FROM products/i.test(stmt)) return { results: [...this.state.products] };
    throw new Error(`StubDB: unhandled all(): ${stmt}`);
  }
}

// ----- Helpers -----------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';

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
    BEASTMODE_ADMIN_SECRET: 'accounts-test-signing-secret',
    BEASTMODE_ADMIN_USER: 'bossman',
    BEASTMODE_ADMIN_PASSWORD: 'the-env-password',
    ...extra,
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function callLogin(env, username, password) {
  const res = await loginPost(ctx(jsonRequest(`${ORIGIN}/api/admin/login`, 'POST', { username, password }), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function callList(env, token) {
  const res = await accountsGet(ctx(jsonRequest(`${ORIGIN}/api/admin/accounts`, 'GET', undefined, token ? bearer(token) : {}), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function callAdd(env, token, username) {
  const res = await accountsPost(ctx(jsonRequest(`${ORIGIN}/api/admin/accounts`, 'POST', { username }, bearer(token)), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function callDelete(env, token, username) {
  const res = await accountDelete(
    ctx(jsonRequest(`${ORIGIN}/api/admin/accounts/x`, 'DELETE', undefined, bearer(token)), env, { username })
  );
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

async function callChangePassword(env, token, currentPassword, newPassword) {
  const res = await changePasswordPost(
    ctx(jsonRequest(`${ORIGIN}/api/admin/accounts/change-password`, 'POST', { currentPassword, newPassword }, bearer(token)), env)
  );
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/**
 * Seed a stored account with a FORCED created_at, so "earliest" is
 * deterministic instead of depending on wall-clock milliseconds.
 */
async function seedAccount(env, db, username, password, createdAt, options) {
  const created = await createAccount(env, username, password, options);
  const row = db.state.accounts.find((r) => r.username === created.username);
  if (row) row.created_at = createdAt;
  return created;
}

// =====================================================================================
// (b) + (c) + (d): the owner's happy path — add her, she signs in
// with the temp, sets her own password, and does product work.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);

  // Production shape: the owner's OWN stored account (his recovery
  // sign-in) exists first, so it is the earliest stored account and
  // owner-level — the co-admin added below is not. (Seeding nobody
  // would make HER the earliest account, and the owner rule would
  // rightly treat her as owner-level.)
  await seedAccount(env, db, 'boss', 'boss-stored-pass-1', '2026-01-01T00:00:00.000Z');

  const owner = await callLogin(env, 'bossman', 'the-env-password');
  check('(b) env owner signs in', owner.status === 200 && owner.data.authSource === 'env');
  const ownerToken = owner.data.token;

  const bossLogin = await callLogin(env, 'boss', 'boss-stored-pass-1');
  check('(b) the earliest stored account is not must-change flagged',
    bossLogin.status === 200 && bossLogin.data.mustChangePassword === undefined);

  const added = await callAdd(env, ownerToken, 'helper@example.com');
  check('(b) owner adds an admin -> 201', added.status === 201, `got ${added.status}: ${JSON.stringify(added.data)}`);
  check('(b) username round-trips (email-shaped names allowed)',
    added.data.username === 'helper@example.com', added.data.username || '');
  const temp = added.data.temporaryPassword;
  check('(b) a 16-char temporary password comes back',
    typeof temp === 'string' && temp.length === 16, JSON.stringify(temp));
  check('(b) temp uses the unambiguous alphabet (no 0/O/1/l/I/o)',
    typeof temp === 'string' && !/[0O1lIo]/.test(temp), temp || '');
  check('(b) the lazy ensure added must_change to admin_accounts',
    db.alters.includes('admin_accounts.must_change'), JSON.stringify(db.alters));
  const stored = await findAccount(env, 'helper@example.com');
  check('(b) the stored row is flagged must_change', stored && Number(stored.must_change) === 1);

  const list = await callList(env, ownerToken);
  check('(b) owner lists accounts -> 200', list.status === 200, `got ${list.status}`);
  check('(b) the list shows her after the owner account, not flagged owner',
    Array.isArray(list.data.accounts) && list.data.accounts.length === 2 &&
    list.data.accounts[0].username === 'boss' && list.data.accounts[0].isOwner === true &&
    list.data.accounts[1].username === 'helper@example.com' && list.data.accounts[1].isOwner === false,
    JSON.stringify(list.data.accounts));
  check('(b) the temp password is NOT in the list response',
    !JSON.stringify(list.data).includes(temp));

  // (c) Her first sign-in + forced change.
  const first = await callLogin(env, 'helper@example.com', temp);
  check('(c) temp password signs her in', first.status === 200 && first.data.authSource === 'account',
    `got ${first.status}`);
  check('(c) sign-in reports mustChangePassword: true', first.data.mustChangePassword === true,
    JSON.stringify(first.data));
  const herToken = first.data.token;

  const wrongCurrent = await callChangePassword(env, herToken, 'not-the-temp-1', 'her-own-password-1');
  check('(c) wrong current password -> 400 (documented choice, not 401)',
    wrongCurrent.status === 400, `got ${wrongCurrent.status}`);
  check('(c) wrong-current message', wrongCurrent.data.error === 'Current password is not correct.',
    wrongCurrent.data.error || '');
  const weak = await callChangePassword(env, herToken, temp, 'short');
  check('(c) weak new password -> 400', weak.status === 400 &&
    (weak.data.error || '').includes('at least 10 characters'), `got ${weak.status}`);
  const changed = await callChangePassword(env, herToken, temp, 'her-own-password-1');
  check('(c) correct change -> 200 ok', changed.status === 200 && changed.data.ok === true,
    `got ${changed.status}: ${JSON.stringify(changed.data)}`);
  const afterRow = await findAccount(env, 'helper@example.com');
  check('(c) the flag is cleared in the row', afterRow && Number(afterRow.must_change) === 0);

  const tempLogin = await callLogin(env, 'helper@example.com', temp);
  check('(c) the temp password is dead', tempLogin.status === 401, `got ${tempLogin.status}`);
  const ownLogin = await callLogin(env, 'helper@example.com', 'her-own-password-1');
  check('(c) her own password signs in', ownLogin.status === 200, `got ${ownLogin.status}`);
  check('(c) no mustChangePassword once changed', ownLogin.data.mustChangePassword === undefined,
    JSON.stringify(ownLogin.data));

  // (d) Product powers yes, admin management no.
  const productRes = await productsCreate(
    ctx(jsonRequest(`${ORIGIN}/api/products`, 'POST', {
      name: 'Her First Hoodie', category: 'hoodies', brand: '824', price: 42,
    }, bearer(ownLogin.data.token)), env)
  );
  check('(d) a co-admin can create products -> 201', productRes.status === 201,
    `got ${productRes.status}`);
  const coList = await callList(env, ownLogin.data.token);
  check('(d) a co-admin cannot list accounts -> 403', coList.status === 403, `got ${coList.status}`);
  check('(d) 403 message', coList.data.error === 'Only the owner can manage admins.',
    coList.data.error || '');
}

// =====================================================================================
// (a) Non-owner gate on all three management verbs + no-token 401.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  await seedAccount(env, db, 'founder', 'founder-pass-123', '2026-01-01T00:00:00.000Z');
  await seedAccount(env, db, 'regular', 'regular-pass-123', '2026-06-01T00:00:00.000Z');

  const regular = await callLogin(env, 'regular', 'regular-pass-123');
  check('(a) the later stored account is NOT owner-flagged at sign-in',
    regular.status === 200 && regular.data.mustChangePassword === undefined);
  const token = regular.data.token;

  const list = await callList(env, token);
  check('(a) non-owner GET accounts -> 403', list.status === 403 &&
    list.data.error === 'Only the owner can manage admins.', `got ${list.status}`);
  const add = await callAdd(env, token, 'sneaky');
  check('(a) non-owner POST accounts -> 403', add.status === 403, `got ${add.status}`);
  const del = await callDelete(env, token, 'founder');
  check('(a) non-owner DELETE account -> 403', del.status === 403, `got ${del.status}`);
  check('(a) the refused DELETE removed nothing',
    (await listAdminAccounts(env)).length === 2);

  const anon = await callList(env, null);
  check('(a) no token -> 401', anon.status === 401, `got ${anon.status}`);
}

// =====================================================================================
// (e) Delete protections + the env session's change-password refusal.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  await seedAccount(env, db, 'firstowner', 'first-owner-pass', '2026-01-01T00:00:00.000Z');
  const owner = await callLogin(env, 'bossman', 'the-env-password');
  const ownerToken = owner.data.token;
  const added = await callAdd(env, ownerToken, 'coadmin');
  check('(e) setup: co-admin added', added.status === 201, `got ${added.status}`);

  const delEnv = await callDelete(env, ownerToken, 'bossman');
  check('(e) deleting the env owner -> 400', delEnv.status === 400, `got ${delEnv.status}`);
  check('(e) env-owner refusal message', delEnv.data.error === "The owner account can't be removed.",
    delEnv.data.error || '');

  const delEarliest = await callDelete(env, ownerToken, 'firstowner');
  check('(e) deleting the earliest stored account -> 400', delEarliest.status === 400,
    `got ${delEarliest.status}`);
  check('(e) earliest refusal message', delEarliest.data.error === "The owner account can't be removed.",
    delEarliest.data.error || '');

  // Self-removal: the earliest account is owner-level, so it can
  // call DELETE — on itself it still gets refused (400).
  const first = await callLogin(env, 'firstowner', 'first-owner-pass');
  const delSelf = await callDelete(env, first.data.token, 'firstowner');
  check('(e) deleting yourself -> 400', delSelf.status === 400, `got ${delSelf.status}`);

  const delGhost = await callDelete(env, ownerToken, 'ghost');
  check('(e) deleting a nonexistent account -> 404', delGhost.status === 404, `got ${delGhost.status}`);

  const delCo = await callDelete(env, ownerToken, 'coadmin');
  check('(e) deleting a normal co-admin -> 204', delCo.status === 204, `got ${delCo.status}`);
  check('(e) the row is gone', (await findAccount(env, 'coadmin')) === null);
  const coLogin = await callLogin(env, 'coadmin', added.data.temporaryPassword);
  check('(e) her sign-in now fails', coLogin.status === 401, `got ${coLogin.status}`);

  const envChange = await callChangePassword(env, ownerToken, 'the-env-password', 'a-brand-new-one-1');
  check('(e) env session change-password -> 400', envChange.status === 400, `got ${envChange.status}`);
  check('(e) env refusal names Cloudflare',
    envChange.data.error === "This sign-in uses the site's Cloudflare credentials — change the password there.",
    envChange.data.error || '');
}

// =====================================================================================
// (f) Duplicates -> 409; invalid usernames -> 400.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const owner = await callLogin(env, 'bossman', 'the-env-password');
  const token = owner.data.token;

  const firstAdd = await callAdd(env, token, 'teammate');
  check('(f) setup add -> 201', firstAdd.status === 201, `got ${firstAdd.status}`);
  const dup = await callAdd(env, token, 'teammate');
  check('(f) exact duplicate -> 409', dup.status === 409, `got ${dup.status}`);
  const dupCase = await callAdd(env, token, 'TEAMMATE');
  check('(f) case-variant duplicate -> 409', dupCase.status === 409, `got ${dupCase.status}`);
  const dupEnv = await callAdd(env, token, 'BossMan');
  check('(f) the env owner name -> 409', dupEnv.status === 409, `got ${dupEnv.status}`);
  check('(f) duplicates created nothing extra',
    (await listAdminAccounts(env)).length === 1);

  const short = await callAdd(env, token, 'ab');
  check('(f) 2-char username -> 400', short.status === 400, `got ${short.status}`);
  const long = await callAdd(env, token, 'a'.repeat(41));
  check('(f) 41-char username -> 400', long.status === 400, `got ${long.status}`);
  const spaced = await callAdd(env, token, 'has space');
  check('(f) username with a space -> 400', spaced.status === 400, `got ${spaced.status}`);
  const bang = await callAdd(env, token, 'bad!name');
  check('(f) username with ! -> 400', bang.status === 400, `got ${bang.status}`);
  const demo = await callAdd(env, token, 'admin');
  check('(f) the demo name -> 400', demo.status === 400, `got ${demo.status}`);
  const demoCase = await callAdd(env, token, 'Admin');
  check('(f) the demo name, any case -> 400', demoCase.status === 400, `got ${demoCase.status}`);
  check('(f) invalid attempts created nothing',
    (await listAdminAccounts(env)).length === 1);
}

// =====================================================================================
// (g) Owner-level via the earliest stored account, in a world whose
// env sign-in matches NO stored account.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db, {
    BEASTMODE_ADMIN_USER: 'cloudflare-only-name',
    BEASTMODE_ADMIN_PASSWORD: 'cloudflare-only-pass',
  });
  await seedAccount(env, db, 'founder', 'founder-pass-123', '2026-01-01T00:00:00.000Z');
  await seedAccount(env, db, 'second', 'second-pass-1234', '2026-06-01T00:00:00.000Z');

  const founder = await callLogin(env, 'founder', 'founder-pass-123');
  check('(g) earliest stored account signs in via account', founder.status === 200 &&
    founder.data.authSource === 'account', `got ${founder.status}`);
  const founderList = await callList(env, founder.data.token);
  check('(g) earliest stored account CAN list accounts', founderList.status === 200,
    `got ${founderList.status}`);
  check('(g) the list flags her as owner and not the later account',
    founderList.data.accounts.length === 2 &&
    founderList.data.accounts[0].username === 'founder' &&
    founderList.data.accounts[0].isOwner === true &&
    founderList.data.accounts[1].isOwner === false,
    JSON.stringify(founderList.data.accounts));
  const founderAdd = await callAdd(env, founder.data.token, 'third-admin');
  check('(g) earliest stored account CAN add admins', founderAdd.status === 201,
    `got ${founderAdd.status}`);

  const second = await callLogin(env, 'second', 'second-pass-1234');
  const secondList = await callList(env, second.data.token);
  check('(g) a later stored account cannot manage admins', secondList.status === 403,
    `got ${secondList.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
