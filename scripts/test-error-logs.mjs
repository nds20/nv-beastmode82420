// Error Logs tests (2026-11-10) — plain node, no framework:
//
//   node scripts/test-error-logs.mjs
//
// Mirrors scripts/test-payments-debug.mjs: an in-memory D1 stub (only
// the statements the airlock issues, plus app_settings for customer
// token secrets), the REAL modules, and the REAL route handlers.
// Covers docs/ERROR_LOGS.md — the airlock built so a failure like
// the product-photo "didn't get a usable answer" can never again be
// a mystery:
//
//   (a) a thrown handler error -> a source 'server' row (name +
//       message + actor resolved from the bearer), the JSON response
//       carries requestId, and x-request-id matches it.
//   (b) a returned 5xx JSON response -> a row (error_name
//       'HttpResponse', the body's own message); requestId injected.
//   (c) handled 4xx (thrown fail(400) AND returned 400 JSON) -> NO
//       row; the thrown one still carries requestId for the UI ref.
//   (d) a 200 success -> NO row, x-request-id still stamped.
//   (e) client-errors intake: admin token ok, customer token ok,
//       anon 401 (and writes nothing), garbage token 401, invalid
//       JSON 400, oversized report 413, long fields truncated
//       server-side (message 500, detail 1000, excerpt 500).
//   (f) admin list: anon 401 (and that 401 is NOT itself logged),
//       newest first, ?limit honored, detail arrives parsed.
//   (g) admin DELETE: clears everything and reports the count.
//   (h) retention: 505 writes leave exactly 500 rows, oldest pruned.
//   (i) SECRECY: an Authorization header and a request body carrying
//       fake secret strings go through failing routes; neither the
//       token, the body content, nor any env secret value appears in
//       any stored row or any response.
//   (j) resilience: a DB whose every statement throws — a healthy
//       handler still answers 200, a throwing handler still answers
//       its 500 JSON with requestId, the client intake still
//       answers { ok: true }. Logging never breaks the request.
//   (k) 824 Shield: a SQL-injection login attempt through the REAL
//       shield-entry fetch is blocked 403 with the Shield JSON, and
//       a source 'shield' row lands with the reasons + scores.
//   (l) static wiring: worker route table, schema.sql, the client
//       reporting in adminApi.js, and the admin page + route exist.

import { readFileSync } from 'node:fs';
import { handle, json, fail } from '../functions/api/_lib/http.js';
import {
  logError,
  listErrorLogs,
  clearErrorLogs,
  ensureErrorLogsTable,
} from '../functions/api/_lib/errorLog.js';
import { issueToken, issueCustomerToken } from '../functions/api/_lib/auth.js';
import { getCustomerTokenSecret } from '../functions/api/_lib/db.js';
import { onRequestPost as clientErrorsPost } from '../functions/api/client-errors.js';
import {
  onRequestGet as errorLogsGet,
  onRequestDelete as errorLogsDelete,
} from '../functions/api/admin/error-logs.js';
import shieldedWorker from '../worker/shield-entry.js';

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

// ----- Secrets (asserted absent from every row and response below) -------------

const ADMIN_PASSWORD_VALUE = 'test-admin-password-SECRET';
const ADMIN_SECRET_VALUE = 'test-signing-secret-SECRET';
const BODY_SECRET = 'BODY-SECRET-VALUE-12345';
const ALL_SECRET_VALUES = [ADMIN_PASSWORD_VALUE, ADMIN_SECRET_VALUE, BODY_SECRET];

const ADMIN_ENV = {
  BEASTMODE_ADMIN_USER: 'boss',
  BEASTMODE_ADMIN_PASSWORD: ADMIN_PASSWORD_VALUE,
  BEASTMODE_ADMIN_SECRET: ADMIN_SECRET_VALUE,
};

const ORIGIN = 'https://beastmode82420.com';

// ----- In-memory D1 stub (error_logs + app_settings only) -----------------------

class StubDB {
  constructor() {
    this.rows = [];
    this.settings = new Map();
    this.nextId = 1;
  }

  prepare(sql) {
    const db = this;
    const stmt = sql.trim().replace(/\s+/g, ' ');
    let params = [];
    const api = {
      bind(...args) {
        params = args;
        return api;
      },
      async run() {
        return db.run(stmt, params);
      },
      async first() {
        return db.first(stmt, params);
      },
      async all() {
        return db.all(stmt, params);
      },
    };
    return api;
  }

  run(stmt, params) {
    if (/^CREATE TABLE IF NOT EXISTS error_logs/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^INSERT INTO error_logs/i.test(stmt)) {
      const cols = stmt
        .match(/\(([^)]+)\) VALUES/i)[1]
        .split(',')
        .map((s) => s.trim());
      const row = { id: this.nextId++ };
      cols.forEach((col, i) => {
        row[col] = params[i];
      });
      this.rows.push(row);
      return { meta: { last_row_id: row.id, changes: 1 } };
    }
    if (/^DELETE FROM error_logs WHERE id <=/i.test(stmt)) {
      // Retention semantics: drop everything older than the newest 500.
      if (this.rows.length > 500) {
        const keep = [...this.rows].sort((a, b) => b.id - a.id).slice(0, 500);
        const keepIds = new Set(keep.map((r) => r.id));
        const before = this.rows.length;
        this.rows = this.rows.filter((r) => keepIds.has(r.id));
        return { meta: { changes: before - this.rows.length } };
      }
      return { meta: { changes: 0 } };
    }
    if (/^DELETE FROM error_logs$/i.test(stmt)) {
      const changes = this.rows.length;
      this.rows = [];
      return { meta: { changes } };
    }
    if (/^INSERT OR IGNORE INTO app_settings/i.test(stmt)) {
      if (!this.settings.has('customer_token_secret')) {
        this.settings.set('customer_token_secret', params[0]);
      }
      return { meta: { changes: 1 } };
    }
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  first(stmt) {
    if (/^SELECT value FROM app_settings/i.test(stmt)) {
      return this.settings.has('customer_token_secret')
        ? { value: this.settings.get('customer_token_secret') }
        : null;
    }
    throw new Error(`StubDB: unhandled first(): ${stmt}`);
  }

  all(stmt, params) {
    if (/^SELECT[\s\S]*FROM error_logs[\s\S]*ORDER BY id DESC/i.test(stmt)) {
      const limit = Number(params[0]) || 50;
      const rows = [...this.rows].sort((a, b) => b.id - a.id).slice(0, limit);
      return { results: rows };
    }
    throw new Error(`StubDB: unhandled all(): ${stmt}`);
  }
}

class BrokenDB {
  prepare() {
    throw new Error('stub DB is completely broken');
  }
}

function ctx(request, env, params = {}) {
  // waitUntil captures the airlock writes handle() schedules, so a
  // scenario can await them before asserting on the stub's rows —
  // the production isolate staying alive for waitUntil is what the
  // capture stands in for.
  const waits = [];
  return {
    request,
    env,
    params,
    waits,
    waitUntil(p) {
      waits.push(p);
    },
  };
}

function envWith(db, extra = {}) {
  return { DB: db, ...ADMIN_ENV, ...extra };
}

async function bodyJson(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

const adminToken = (await issueToken(ADMIN_ENV, 'boss')).token;

// =====================================================================
// (a) Thrown handler error -> server row + requestId in body + header
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const handler = handle(async () => {
    throw new Error('kaboom in the widget factory');
  });
  const req = new Request(`${ORIGIN}/api/widgets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ErrorLogsTest/1.0',
    },
    body: JSON.stringify({ note: BODY_SECRET }),
  });
  const c = ctx(req, env);
  const res = await handler(c);
  await Promise.all(c.waits);
  const { data } = await bodyJson(res);
  check('(a) thrown error answers 500', res.status === 500);
  check('(a) response error text is the thrown message', data.error === 'kaboom in the widget factory');
  check('(a) response JSON carries requestId', typeof data.requestId === 'string' && data.requestId.length >= 8);
  check(
    '(a) x-request-id header matches the body requestId',
    res.headers.get('x-request-id') === data.requestId
  );
  check('(a) exactly one row written', db.rows.length === 1, `rows=${db.rows.length}`);
  const row = db.rows[0];
  check('(a) row source is server', row.source === 'server');
  check('(a) row status is 500', row.status === 500);
  check('(a) row error_name is the error class', row.error_name === 'Error');
  check('(a) row error_message is the thrown message', row.error_message === 'kaboom in the widget factory');
  check('(a) row path + method come from the request', row.path === '/api/widgets' && row.method === 'POST');
  check('(a) row actor resolved from the bearer', row.actor === 'admin:boss', `actor=${row.actor}`);
  check('(a) row request_id matches the response', row.request_id === data.requestId);
  check('(a) row user_agent truncated copy stored', row.user_agent === 'ErrorLogsTest/1.0');
}

// =====================================================================
// (b) Returned 5xx JSON -> row with the body's own message
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const handler = handle(async () => json({ error: 'database exploded politely' }, 503));
  const c = ctx(new Request(`${ORIGIN}/api/flaky`), env);
  const res = await handler(c);
  await Promise.all(c.waits);
  const { data } = await bodyJson(res);
  check('(b) returned 503 passes through', res.status === 503);
  check('(b) requestId injected into the returned error body', typeof data.requestId === 'string');
  check('(b) exactly one row written', db.rows.length === 1);
  const row = db.rows[0];
  check('(b) row error_name marks a returned response', row.error_name === 'HttpResponse');
  check('(b) row message is the body error text', row.error_message === 'database exploded politely');
  check('(b) row status is 503', row.status === 503);
  check('(b) anonymous request logs actor anon', row.actor === 'anon');
}

// =====================================================================
// (c) Handled 4xx -> NOT logged (thrown and returned)
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const thrown = handle(async () => fail(400, 'Name is required'));
  const res1 = await thrown(ctx(new Request(`${ORIGIN}/api/products`, { method: 'POST' }), env));
  const { data: d1 } = await bodyJson(res1);
  check('(c) thrown 400 answers 400 with its message', res1.status === 400 && d1.error === 'Name is required');
  check('(c) thrown 400 still carries requestId for the UI ref', typeof d1.requestId === 'string');

  const returned = handle(async () => json({ error: 'Also handled' }, 422));
  const res2 = await returned(ctx(new Request(`${ORIGIN}/api/products`, { method: 'POST' }), env));
  const { data: d2 } = await bodyJson(res2);
  check('(c) returned 422 gains requestId too', typeof d2.requestId === 'string');
  check('(c) NO rows written for handled 4xx', db.rows.length === 0, `rows=${db.rows.length}`);
}

// =====================================================================
// (d) Success -> no row, header stamped
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const handler = handle(async () => json({ ok: true }));
  const res = await handler(ctx(new Request(`${ORIGIN}/api/health`), env));
  check('(d) success passes through', res.status === 200);
  check('(d) success still carries x-request-id', Boolean(res.headers.get('x-request-id')));
  check('(d) NO row written for a success', db.rows.length === 0);
}

// =====================================================================
// (e) Client-errors intake
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const post = (headers, body) =>
    clientErrorsPost(
      ctx(
        new Request(`${ORIGIN}/api/client-errors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        env
      )
    );

  // Admin reporter — the photo-failure shape: bad-response with evidence.
  const resAdmin = await post(
    { Authorization: `Bearer ${adminToken}` },
    {
      kind: 'bad-response',
      url: '/api/admin/products/2/photo',
      method: 'POST',
      status: 403,
      contentType: 'text/html; charset=UTF-8',
      bodyExcerpt: '<!DOCTYPE html><title>Attention Required</title>',
      message: 'Non-JSON response (HTTP 403)',
      requestId: 'req-from-the-failed-call',
      context: { operation: 'product-photo-upload' },
    }
  );
  check('(e) admin report accepted', resAdmin.status === 200);
  check('(e) one client row written', db.rows.length === 1);
  const row = db.rows[0];
  check('(e) row source is client', row.source === 'client');
  check('(e) row kind is the error_name', row.error_name === 'bad-response');
  check('(e) row path is the reported url path', row.path === '/api/admin/products/2/photo');
  check('(e) row status is the reported status', row.status === 403);
  check('(e) row actor is the reporting admin', row.actor === 'admin:boss');
  check('(e) row request_id is the failed call\u2019s id', row.request_id === 'req-from-the-failed-call');
  const detail = JSON.parse(row.detail);
  check('(e) detail carries the content-type', detail.contentType === 'text/html; charset=UTF-8');
  check('(e) detail carries the body excerpt', detail.bodyExcerpt.includes('Attention Required'));
  check('(e) detail carries the operation context', detail.context.operation === 'product-photo-upload');

  // Customer reporter — network kind, null status.
  const secret = await getCustomerTokenSecret(env);
  const customerToken = (await issueCustomerToken(7, secret)).token;
  const resCust = await post(
    { Authorization: `Bearer ${customerToken}` },
    { kind: 'network', url: 'https://beastmode82420.com/api/products', method: 'GET', message: 'Load failed' }
  );
  check('(e) customer report accepted', resCust.status === 200);
  const crow = db.rows[1];
  check('(e) customer row actor', crow.actor === 'customer:7', `actor=${crow.actor}`);
  check('(e) customer network row has null status', crow.status === null);
  check('(e) customer row path parsed from a full URL', crow.path === '/api/products');

  // Anonymous + garbage -> 401 and nothing written.
  const before = db.rows.length;
  const resAnon = await post({}, { kind: 'network', url: '/api/x', method: 'GET' });
  check('(e) anonymous report refused 401', resAnon.status === 401);
  const resGarbage = await post(
    { Authorization: 'Bearer not-a-real-token' },
    { kind: 'network', url: '/api/x', method: 'GET' }
  );
  check('(e) garbage token refused 401', resGarbage.status === 401);
  check('(e) refused reports write nothing', db.rows.length === before);

  // Invalid JSON -> 400.
  const resBadJson = await post({ Authorization: `Bearer ${adminToken}` }, '{not json');
  check('(e) invalid JSON refused 400', resBadJson.status === 400);

  // Oversized -> 413 (declared length gate).
  const bigBody = JSON.stringify({ kind: 'network', url: '/api/x', method: 'GET', message: 'x'.repeat(9000) });
  const resBig = await post({ Authorization: `Bearer ${adminToken}` }, bigBody);
  check('(e) oversized report refused 413', resBig.status === 413, `status=${resBig.status}`);
  check('(e) oversized report wrote nothing', db.rows.length === before);

  // Truncation: a long message + excerpt are cut server-side.
  const resLong = await post(
    { Authorization: `Bearer ${adminToken}` },
    {
      kind: 'bad-response',
      url: '/api/y',
      method: 'POST',
      status: 500,
      message: 'm'.repeat(2000),
      bodyExcerpt: 'b'.repeat(2000),
      contentType: 'text/html',
    }
  );
  check('(e) long-field report accepted', resLong.status === 200);
  const lrow = db.rows[db.rows.length - 1];
  check('(e) stored message truncated to 500', lrow.error_message.length === 500);
  check('(e) stored detail truncated to <=1000', lrow.detail.length <= 1000, `len=${lrow.detail.length}`);
  const ldetail = JSON.parse(lrow.detail.slice(0, lrow.detail.length));
  check('(e) detail still parses or fails soft', ldetail === null || typeof ldetail === 'object' || typeof ldetail === 'string');
}

// =====================================================================
// (f) Admin list: gating, order, limit, parsed detail
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  await logError(env, { source: 'server', path: '/api/first', status: 500, errorName: 'Error', errorMessage: 'first failure' });
  await logError(env, { source: 'client', path: '/api/second', status: null, errorName: 'network', errorMessage: 'second failure', detail: { kind: 'network' } });
  await logError(env, { source: 'shield', path: '/api/third', status: 403, errorName: 'ShieldBlock', errorMessage: 'third failure', detail: { bot: 1, injection: 2, exploit: 195 } });

  const resAnon = await errorLogsGet(ctx(new Request(`${ORIGIN}/api/admin/error-logs`), env));
  check('(f) list refuses anonymous 401', resAnon.status === 401);
  check('(f) the gating 401 is NOT itself logged', db.rows.length === 3);

  const res = await errorLogsGet(
    ctx(
      new Request(`${ORIGIN}/api/admin/error-logs`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env
    )
  );
  const { data } = await bodyJson(res);
  check('(f) list answers 200 for an admin', res.status === 200);
  check('(f) all three rows listed', data.logs.length === 3);
  check(
    '(f) newest first',
    data.logs[0].errorMessage === 'third failure' && data.logs[2].errorMessage === 'first failure'
  );
  check('(f) detail arrives parsed', data.logs[0].detail && data.logs[0].detail.exploit === 195);
  check('(f) fields are camelCased for the UI', data.logs[0].errorName === 'ShieldBlock' && 'requestId' in data.logs[0]);

  const resLimited = await errorLogsGet(
    ctx(
      new Request(`${ORIGIN}/api/admin/error-logs?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env
    )
  );
  const { data: limited } = await bodyJson(resLimited);
  check('(f) ?limit=2 honored', limited.logs.length === 2 && limited.logs[0].errorMessage === 'third failure');
}

// =====================================================================
// (g) Admin DELETE clears + counts
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  await logError(env, { source: 'server', path: '/api/a', status: 500, errorMessage: 'one' });
  await logError(env, { source: 'server', path: '/api/b', status: 500, errorMessage: 'two' });

  const resAnon = await errorLogsDelete(
    ctx(new Request(`${ORIGIN}/api/admin/error-logs`, { method: 'DELETE' }), env)
  );
  check('(g) DELETE refuses anonymous 401', resAnon.status === 401);
  check('(g) rows survive an anonymous DELETE', db.rows.length === 2);

  const res = await errorLogsDelete(
    ctx(
      new Request(`${ORIGIN}/api/admin/error-logs`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env
    )
  );
  const { data } = await bodyJson(res);
  check('(g) DELETE answers ok with the count', data.ok === true && data.removed === 2, JSON.stringify(data));
  check('(g) the log is empty after DELETE', db.rows.length === 0);
  const remaining = await listErrorLogs(env, 50);
  check('(g) list confirms empty', remaining.length === 0);
}

// =====================================================================
// (h) Retention: newest 500 survive
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  for (let i = 1; i <= 505; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await logError(env, { source: 'server', path: '/api/flood', status: 500, errorMessage: `flood ${i}` });
  }
  check('(h) 505 writes leave exactly 500 rows', db.rows.length === 500, `rows=${db.rows.length}`);
  const messages = new Set(db.rows.map((r) => r.error_message));
  check('(h) the oldest five were pruned', !messages.has('flood 1') && !messages.has('flood 5'));
  check('(h) the newest survived', messages.has('flood 505') && messages.has('flood 6'));
}

// =====================================================================
// (i) Secrecy: headers + bodies + env secrets never reach a row
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const handler = handle(async () => {
    throw new Error('a perfectly ordinary failure');
  });
  const req = new Request(`${ORIGIN}/api/secret-keeper`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
      Cookie: `session=${BODY_SECRET}`,
    },
    body: JSON.stringify({ password: BODY_SECRET, note: ADMIN_PASSWORD_VALUE }),
  });
  const c = ctx(req, env);
  const res = await handler(c);
  await Promise.all(c.waits);
  const { text: resText } = await bodyJson(res);
  const rowsText = JSON.stringify(db.rows);
  for (const secret of [...ALL_SECRET_VALUES, adminToken]) {
    check(`(i) rows never contain ${secret.slice(0, 12)}…`, !rowsText.includes(secret));
    check(`(i) response never contains ${secret.slice(0, 12)}…`, !resText.includes(secret));
  }
  check('(i) the row still captured the failure', db.rows.length === 1 && db.rows[0].error_message === 'a perfectly ordinary failure');
}

// =====================================================================
// (j) Resilience: a broken DB never breaks a request
// =====================================================================
{
  const env = envWith(new BrokenDB());
  const healthy = handle(async () => json({ ok: true }));
  const resOk = await healthy(ctx(new Request(`${ORIGIN}/api/health`), env));
  check('(j) healthy handler answers 200 with a broken log DB', resOk.status === 200);

  const throwing = handle(async () => {
    throw new Error('still answers');
  });
  const resErr = await throwing(ctx(new Request(`${ORIGIN}/api/boom`), env));
  const { data } = await bodyJson(resErr);
  check('(j) throwing handler still answers its 500 JSON', resErr.status === 500 && data.error === 'still answers');
  check('(j) the 500 still carries requestId', typeof data.requestId === 'string');

  const resIntake = await clientErrorsPost(
    ctx(
      new Request(`${ORIGIN}/api/client-errors`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ kind: 'network', url: '/api/z', method: 'GET', message: 'down' }),
      }),
      env
    )
  );
  check('(j) client intake still answers ok with a broken log DB', resIntake.status === 200);
}

// =====================================================================
// (k) 824 Shield blocks land in the log
// =====================================================================
{
  const db = new StubDB();
  const env = envWith(db);
  const waits = [];
  const shieldCtx = {
    waitUntil(p) {
      waits.push(p);
    },
  };
  const req = new Request(`${ORIGIN}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
      'Accept-Language': 'en-US',
      'CF-Connecting-IP': '203.0.113.9',
    },
    body: JSON.stringify({
      username: "admin' UNION SELECT * FROM users -- ",
      password: "x' OR '1'='1",
    }),
  });
  const res = await shieldedWorker.fetch(req, env, shieldCtx);
  await Promise.all(waits);
  const { data } = await bodyJson(res);
  check('(k) the SQLi attempt is blocked 403', res.status === 403, `status=${res.status}`);
  check('(k) the Shield JSON shape is unchanged', data.error === 'Request blocked by 824 Shield.' && Array.isArray(data.reasons));
  const shieldRows = db.rows.filter((r) => r.source === 'shield');
  check('(k) exactly one shield row written', shieldRows.length === 1, `rows=${db.rows.length}`);
  if (shieldRows.length === 1) {
    const row = shieldRows[0];
    check('(k) shield row status is 403', row.status === 403);
    check('(k) shield row names the block', row.error_name === 'ShieldBlock');
    check('(k) shield row message carries the reasons', /UNION SELECT/i.test(row.error_message), row.error_message);
    const scores = JSON.parse(row.detail);
    check('(k) shield row detail is the scores', typeof scores.exploit === 'number' && scores.exploit >= 60, row.detail);
    check('(k) shield row path + method recorded', row.path === '/api/admin/login' && row.method === 'POST');
  }
}

// =====================================================================
// (l) Static wiring
// =====================================================================
{
  const workerSrc = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  check('(l) worker registers client-errors', workerSrc.includes("parts: ['api', 'client-errors']"));
  check('(l) worker registers admin error-logs', workerSrc.includes("parts: ['api', 'admin', 'error-logs']"));
  const schema = readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');
  check('(l) schema.sql carries error_logs', schema.includes('CREATE TABLE IF NOT EXISTS error_logs'));
  const adminApi = readFileSync(new URL('../frontend/src/services/adminApi.js', import.meta.url), 'utf8');
  check('(l) adminApi reports coded failures to the intake', adminApi.includes("const CLIENT_ERRORS_PATH = '/api/client-errors'") && adminApi.includes('reportClientError'));
  check('(l) adminApi reads the x-request-id stamp', adminApi.includes("response.headers.get('x-request-id')"));
  check('(l) adminApi exposes the log reads', adminApi.includes('fetchErrorLogs') && adminApi.includes('clearErrorLogs'));
  const appSrc = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');
  check('(l) App routes the Error Logs page', appSrc.includes('admin/error-logs') && appSrc.includes('AdminErrorLogs'));
  const pageSrc = readFileSync(new URL('../frontend/src/pages/AdminErrorLogs.jsx', import.meta.url), 'utf8');
  check('(l) the page has refresh + clear + empty state', pageSrc.includes('Refresh') && pageSrc.includes('Clear logs') && pageSrc.includes('No errors logged'));
  const shieldEntry = readFileSync(new URL('../worker/shield-entry.js', import.meta.url), 'utf8');
  check('(l) shield-entry writes blocks to the log', shieldEntry.includes("source: 'shield'") && shieldEntry.includes('errorLog.js'));
  await ensureErrorLogsTable(envWith(new StubDB()));
  check('(l) the table ensure resolves against a fresh DB', true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
