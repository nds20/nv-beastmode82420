// Error Logs — the shop's airlock (owner directive 2026-11-10,
// docs/ERROR_LOGS.md). Every failure that used to vanish into a
// generic client message ("didn't get a usable answer back") now
// leaves a factual row in the error_logs table: what errored, where,
// with what status, and what the server (or the client's browser)
// actually saw. The admin reads them at /shop/admin/error-logs.
//
// Three sources feed the one table:
//   'server' — _lib/http.js handle(): a handler threw a 5xx, or a
//              handler returned a 5xx response.
//   'client' — POST /api/client-errors: the browser reporting the
//              failures only it can see (fetch threw = 'network';
//              a non-JSON answer = 'bad-response', WITH the status,
//              content-type and the first bytes of that answer —
//              the exact facts the photo-upload hunt never had).
//   'shield' — worker/shield-entry.js: an 824 Shield BLOCK (403),
//              so "is Shield too strong?" is answerable from facts.
//
// PRIVACY (test-asserted in scripts/test-error-logs.mjs): a row
// carries NO request body, NO Authorization header, NO cookie, NO
// token, NO secret value — ever. Only: timestamp, request id,
// source, method, path, status, error name, error message
// (truncated), a small JSON detail (stage/context fields), the
// actor (admin:<username> / customer:<id> / 'anon' — resolved from
// the bearer token's verified payload, never the token itself) and
// the user agent (truncated).
//
// DISCIPLINE: logging NEVER breaks the request it describes. Every
// function here swallows its own failures and resolves a boolean;
// handle() additionally routes the write through waitUntil when
// the platform offers it.

export const ERROR_LOG_RETENTION = 500;
export const MAX_ERROR_MESSAGE_CHARS = 500;
export const MAX_DETAIL_CHARS = 1000;
export const MAX_USER_AGENT_CHARS = 200;

/** Truncate any value to a string of at most `max` characters. */
export function truncate(value, max) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

// ----- Lazy table ensure (the donations/offers pattern in db.js) -------------

let errorLogsTablePromise = null;

export function ensureErrorLogsTable(env) {
  if (!errorLogsTablePromise) {
    errorLogsTablePromise = env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS error_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        request_id TEXT,
        source TEXT NOT NULL,
        method TEXT,
        path TEXT,
        status INTEGER,
        error_name TEXT,
        error_message TEXT,
        detail TEXT,
        actor TEXT,
        user_agent TEXT
      )`
    )
      .run()
      .then(() => true)
      .catch((err) => {
        // Same retry rule as the other ensures: never poison the isolate.
        errorLogsTablePromise = null;
        throw err;
      });
  }
  return errorLogsTablePromise;
}

// ----- Actor resolution ------------------------------------------------------
// Who made the request, from the VERIFIED bearer payload only:
// 'admin:<username>' for an admin token, 'customer:<id>' for a
// customer token, 'anon' otherwise (including garbage tokens). The
// token itself is never stored. Auth/db are imported lazily so this
// module stays import-cycle-free (auth.js imports http.js, and
// http.js imports this module) and so a broken auth path can never
// take logging down with it — every failure lands on 'anon'.

export async function describeActor(context) {
  try {
    const request = context && context.request;
    if (!request) return 'anon';
    const header = request.headers.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return 'anon';
    const { verifyToken, verifyCustomerToken } = await import('./auth.js');
    const admin = await verifyToken(context.env, token);
    if (admin && admin.sub) return truncate(`admin:${admin.sub}`, 120);
    try {
      const { getCustomerTokenSecret } = await import('./db.js');
      const secret = await getCustomerTokenSecret(context.env);
      const customer = await verifyCustomerToken(token, secret);
      if (customer && customer.sub) return truncate(`customer:${customer.sub}`, 120);
    } catch {
      // Customer side unreadable — the actor stays 'anon', never a guess.
    }
    return 'anon';
  } catch {
    return 'anon';
  }
}

// ----- The write -------------------------------------------------------------
//
// logError(env, entry, context?) — entry fields (all optional except
// source): { requestId, source, method, path, status, errorName,
// errorMessage, detail (object or string), actor, userAgent }.
// When a route context is passed, any missing method / path /
// userAgent / actor is filled from the request. Resolves true when
// the row landed, false when anything at all went wrong — and NEVER
// rejects.

export async function logError(env, entry = {}, context = null) {
  try {
    if (!env || !env.DB) return false;

    let { method, path, userAgent, actor } = entry;
    if (context && context.request) {
      const request = context.request;
      if (!method) method = request.method;
      if (!path) {
        try {
          path = new URL(request.url).pathname;
        } catch {
          path = '';
        }
      }
      if (!userAgent) userAgent = request.headers.get('user-agent') || '';
      if (!actor) actor = await describeActor(context);
    }

    let detailText = '';
    if (entry.detail !== null && entry.detail !== undefined && entry.detail !== '') {
      detailText =
        typeof entry.detail === 'string'
          ? entry.detail
          : JSON.stringify(entry.detail) || '';
    }

    await ensureErrorLogsTable(env);
    await env.DB.prepare(
      `INSERT INTO error_logs
        (ts, request_id, source, method, path, status, error_name,
         error_message, detail, actor, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        new Date().toISOString(),
        entry.requestId ? truncate(entry.requestId, 64) : null,
        truncate(entry.source || 'server', 20),
        method ? truncate(method, 10) : null,
        path ? truncate(path, 300) : null,
        Number.isFinite(Number(entry.status)) && entry.status !== null && entry.status !== undefined
          ? Math.floor(Number(entry.status))
          : null,
        entry.errorName ? truncate(entry.errorName, 100) : null,
        entry.errorMessage ? truncate(entry.errorMessage, MAX_ERROR_MESSAGE_CHARS) : null,
        detailText ? truncate(detailText, MAX_DETAIL_CHARS) : null,
        actor ? truncate(actor, 120) : 'anon',
        userAgent ? truncate(userAgent, MAX_USER_AGENT_CHARS) : null
      )
      .run();

    // Retention: keep only the newest ERROR_LOG_RETENTION rows. The
    // subquery is empty (NULL) while the table is at or under the
    // cap, so the delete is a no-op then. Best-effort: a retention
    // failure never fails the insert that already landed.
    try {
      await env.DB.prepare(
        `DELETE FROM error_logs
         WHERE id <= (SELECT id FROM error_logs ORDER BY id DESC LIMIT 1 OFFSET ${
           ERROR_LOG_RETENTION - 1
         })`
      ).run();
    } catch {
      // The row is in; pruning can wait for the next write.
    }
    return true;
  } catch {
    return false;
  }
}

// ----- Reads (admin surface) ---------------------------------------------------

/** Newest-first rows for the admin Error Logs page. */
export async function listErrorLogs(env, limit = 50) {
  await ensureErrorLogsTable(env);
  const { results } = await env.DB.prepare(
    `SELECT id, ts, request_id, source, method, path, status,
            error_name, error_message, detail, actor, user_agent
     FROM error_logs
     ORDER BY id DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return results || [];
}

/** Clear the whole log; resolves to the number of rows removed. */
export async function clearErrorLogs(env) {
  await ensureErrorLogsTable(env);
  const result = await env.DB.prepare('DELETE FROM error_logs').run();
  return result && result.meta ? Number(result.meta.changes || 0) : 0;
}
