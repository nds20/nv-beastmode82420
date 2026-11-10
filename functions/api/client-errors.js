// POST /api/client-errors — the client half of the Error Logs
// airlock (2026-11-10, docs/ERROR_LOGS.md). Browsers report the two
// failure shapes only they can see:
//   kind 'network'      — fetch itself threw; the request or the
//                         response never completed.
//   kind 'bad-response' — something answered, but not with the API's
//                         JSON: the report carries the HTTP status,
//                         the content-type, and the first bytes of
//                         the actual answer (bodyExcerpt).
// This is the piece that would have named the product-photo failure
// on day one: the photo POST's non-JSON answer lands in the log
// verbatim instead of collapsing into "didn't get a usable answer".
//
// Auth: a valid ADMIN or CUSTOMER bearer token is required (either
// audience's failures are worth facts; an anonymous write-in log
// would be a spam/abuse surface behind an auth-free POST). Anon and
// garbage tokens get 401 and write nothing.
//
// Everything is validated and truncated server-side — the client is
// a witness, not a trusted scribe. The stored row is source
// 'client' (see _lib/errorLog.js for the privacy rules: no request
// bodies beyond the excerpt the client itself chose to report, no
// headers, no tokens). The intake is behind 824 Shield like every
// /api/* route, and payloads over MAX_REPORT_BYTES are refused 413
// before parsing.

import { handle, json, fail } from './_lib/http.js';
import { verifyToken, verifyCustomerToken } from './_lib/auth.js';
import { getCustomerTokenSecret } from './_lib/db.js';
import { logError, truncate } from './_lib/errorLog.js';

const MAX_REPORT_BYTES = 8 * 1024;

/** The path portion of a reported URL (full URL or bare path). */
function pathOf(url) {
  const raw = String(url || '');
  if (!raw) return '';
  try {
    return new URL(raw, 'https://placeholder.invalid').pathname;
  } catch {
    return raw.split('?')[0];
  }
}

export const onRequestPost = handle(async (context) => {
  const { request, env } = context;

  // --- Auth: admin OR customer bearer; anyone else writes nothing. ---
  const header = request.headers.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  let actor = null;
  if (scheme === 'Bearer' && token) {
    const admin = await verifyToken(env, token);
    if (admin && admin.sub) {
      actor = `admin:${admin.sub}`;
    } else {
      try {
        const customer = await verifyCustomerToken(
          token,
          await getCustomerTokenSecret(env)
        );
        if (customer && customer.sub) actor = `customer:${customer.sub}`;
      } catch {
        // An unreadable customer side proves nothing — stay anon.
      }
    }
  }
  if (!actor) fail(401, 'Authentication required');

  // --- Size gate, before parsing: declared length, then actual. ---
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    fail(413, 'Error report too large');
  }
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) fail(413, 'Error report too large');

  let body = {};
  try {
    body = JSON.parse(text || '{}');
  } catch {
    fail(400, 'Error report must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'Error report must be a JSON object');
  }

  const kind = truncate(body.kind || 'client-error', 50);
  const statusNumber = Number(body.status);
  const status =
    Number.isInteger(statusNumber) && statusNumber >= 100 && statusNumber <= 599
      ? statusNumber
      : null;

  await logError(env, {
    source: 'client',
    // The request id the client saw on the failed call, when it has
    // one — it correlates this row with the server's own row for
    // the same failure. Otherwise this request's own id.
    requestId: body.requestId ? truncate(body.requestId, 64) : context.requestId || null,
    method: body.method ? truncate(String(body.method).toUpperCase(), 10) : null,
    path: pathOf(body.url) || null,
    status,
    errorName: kind,
    errorMessage: body.message ? truncate(body.message, 500) : null,
    detail: {
      kind,
      contentType: body.contentType ? truncate(body.contentType, 100) : null,
      bodyExcerpt: body.bodyExcerpt ? truncate(body.bodyExcerpt, 500) : null,
      context: body.context === undefined ? null : body.context,
    },
    actor,
    userAgent: request.headers.get('user-agent') || '',
  });

  return json({ ok: true });
});
