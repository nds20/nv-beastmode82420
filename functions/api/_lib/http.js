// Small HTTP helpers shared by the Smoke Shop Pages Functions API.
//
// Everything here is Web-standard (Request/Response) — no Node APIs — so
// the same code runs on Cloudflare's Workers runtime. Behaviour mirrors
// the Node/Express server in ../../server/: JSON bodies everywhere, and
// errors shaped as { error: "<message>" } with an HTTP status.

import { logError } from './errorLog.js';

/** Serialize `data` as a JSON response. */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** An error carrying an HTTP status — the port of the Node server's err.status. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Throw an HttpError (caught by `handle` and turned into a JSON response). */
export function fail(status, message) {
  throw new HttpError(status, message);
}

/** Rebuild `response` carrying the x-request-id header (body untouched). */
function withRequestId(response, requestId) {
  try {
    if (!response || response.headers.get('x-request-id')) return response;
    const next = new Response(response.body, response);
    next.headers.set('x-request-id', requestId);
    return next;
  } catch {
    return response;
  }
}

/**
 * Add `requestId` to a JSON error body (status >= 400), preserving the
 * status and headers. Non-JSON bodies and non-object JSON pass through
 * untouched — the header set by withRequestId still correlates them.
 */
async function injectRequestId(response, requestId) {
  try {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return response;
    const data = await response.clone().json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
    if (data.requestId) return response;
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return json({ ...data, requestId }, response.status, headers);
  } catch {
    return response;
  }
}

/**
 * Route one server-side failure into the Error Logs airlock
 * (_lib/errorLog.js, docs/ERROR_LOGS.md). waitUntil carries the write
 * when the platform offers it; otherwise it is awaited — logError
 * never rejects, so awaiting it can never break the response.
 */
async function logServerFailure(context, entry) {
  const written = logError(context && context.env, entry, context);
  if (context && typeof context.waitUntil === 'function') {
    try {
      context.waitUntil(written);
      return;
    } catch {
      // Fall through to awaiting the (never-rejecting) write.
    }
  }
  await written;
}

/**
 * Wrap a route handler so thrown HttpErrors (and unexpected errors) become
 * { error } JSON responses, exactly like the Express error middleware in
 * server/index.js.
 *
 * Error Logs (2026-11-10, docs/ERROR_LOGS.md): every request through
 * here gets a request id (context.requestId, mirrored in the
 * x-request-id response header and in JSON error bodies), and every
 * 5xx outcome — thrown or returned — is written to the error_logs
 * table with the error's name and message. Handled 4xx errors are
 * NOT logged: they are the API working as designed (validation,
 * auth gates), not failures. Logging never breaks the request.
 */
export function handle(fn) {
  return async (context) => {
    const requestId = crypto.randomUUID();
    try {
      context.requestId = requestId;
    } catch {
      // A frozen context object: the header/body correlation still works.
    }

    let response;
    try {
      response = await fn(context);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      if (status >= 500) console.error(err);
      response = json({ error: (err && err.message) || 'Server error', requestId }, status);
      if (status >= 500) {
        await logServerFailure(context, {
          requestId,
          source: 'server',
          status,
          errorName: (err && err.name) || 'Error',
          errorMessage: (err && err.message) || String(err),
          detail: { thrown: true },
        });
      }
      return withRequestId(response, requestId);
    }

    if (response && response.status >= 400) {
      // Read the error body once: the 5xx log needs its message, and
      // every JSON error body gains the requestId so a message shown
      // to the admin can cite it ("(ref: ...)") and land here.
      let errorMessage = '';
      try {
        const data = await response.clone().json();
        if (data && typeof data.error === 'string') errorMessage = data.error;
      } catch {
        // Not JSON — nothing to quote; the status still tells its story.
      }
      if (response.status >= 500) {
        await logServerFailure(context, {
          requestId,
          source: 'server',
          status: response.status,
          errorName: 'HttpResponse',
          errorMessage,
          detail: { returned: true },
        });
      }
      response = await injectRequestId(response, requestId);
    }
    return withRequestId(response, requestId);
  };
}

/** Round to 2 decimals the same way the Node server (and storefront) does. */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Same slug rules as server/index.js (used for uploaded photo names). */
export function slugify(text) {
  return (
    String(text || 'product')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'product'
  );
}

/** Parse a route param as a numeric id (Node's store does Number(id)). */
export function numericId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Constant-time comparison of two hex strings (used for webhook
 * signatures). Lengths leak, as with the byte compare in auth.js.
 */
export function timingSafeHexEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}
