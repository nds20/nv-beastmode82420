// Client for the Beastmode 82420 admin API (functions/api/admin/*).
//
// The admin token is an HMAC-signed bearer token issued by
// POST /api/admin/login (see functions/api/_lib/auth.js): 8-hour TTL,
// sent back as `Authorization: Bearer <token>` on every admin call.
// It lives in localStorage under its own key — deliberately separate
// from the customer token in customersApi.js, because shoppers and
// admins are different audiences with different tokens.
//
// Errors surface the API's own { error } message (with .status
// attached) so pages can show exactly what the server said — e.g.
// "Invalid credentials" on a failed sign-in — and can treat a 401 as
// "session over: clear the token and go back to the login page."
// Failures where the server never got a usable word in carry a
// .code instead: 'network' (fetch itself threw — the request or the
// response never completed) or 'bad-response' (something answered
// with a body that is not the API's JSON, e.g. an edge error page).
// Callers that can say something more specific than
// UNAVAILABLE_MESSAGE key off the code (the product photo step does;
// see lib/photoPrep.js photoFailureMessage).
//
// Error Logs (2026-11-10, docs/ERROR_LOGS.md): those two coded
// failures are ALSO reported, fire-and-forget, to
// POST /api/client-errors — the browser is the only witness to what
// actually came back (or didn't), and its report (status,
// content-type, the first bytes of the answer, plus the request id
// the server stamped on it) is what lands in the admin Error Logs
// instead of another round of guessing. Server-answered errors are
// not reported: the server logs its own 5xx. Errors also carry
// .requestId whenever the server provided one, so a message shown
// to the admin can cite it as "(ref: ...)".

import { preparePhotoForUpload } from '../lib/photoPrep';

const TOKEN_KEY = 'beastmode_admin_token';
const AUTH_SOURCE_KEY = 'beastmode_admin_auth_source';
// Set by a sign-in whose account still runs on a temporary password
// (multi-admin, 2026-11-09): the UI routes that admin to the
// set-password page. Advisory only in v1 — the token is fully
// valid; see docs/ADMINS.md for the enforcement honesty note.
const MUST_CHANGE_KEY = 'beastmode_admin_must_change';

const UNAVAILABLE_MESSAGE =
  'The admin server could not be reached — please try again in a moment.';

export const getAdminToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};

/** Which credential matched at sign-in: 'env' | 'account' | 'demo' | ''. */
export const getAdminAuthSource = () => {
  try {
    return localStorage.getItem(AUTH_SOURCE_KEY) || '';
  } catch {
    return '';
  }
};

export function setAdminSession(data) {
  try {
    if (data && data.token) localStorage.setItem(TOKEN_KEY, data.token);
    if (data && data.authSource) {
      localStorage.setItem(AUTH_SOURCE_KEY, data.authSource);
    }
    if (data && data.token) {
      // A fresh sign-in re-decides the flag: set it only when THIS
      // login reported mustChangePassword, so a stale flag from a
      // previous session can never strand a later admin on the
      // set-password page.
      if (data.mustChangePassword) localStorage.setItem(MUST_CHANGE_KEY, '1');
      else localStorage.removeItem(MUST_CHANGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode, quota) — sign-in itself still
    // worked; the session just won't persist across visits.
  }
}

/** True when the current session's account must set its own password. */
export const getAdminMustChange = () => {
  try {
    return localStorage.getItem(MUST_CHANGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const clearAdminToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(AUTH_SOURCE_KEY);
    localStorage.removeItem(MUST_CHANGE_KEY);
  } catch {
    // Nothing to clear.
  }
};

const CLIENT_ERRORS_PATH = '/api/client-errors';

/**
 * Fire-and-forget a browser-witnessed failure to the Error Logs
 * intake (POST /api/client-errors). NEVER throws, NEVER awaited by
 * callers, and silent on its own failure — a reporting hiccup must
 * not delay, mask, or replace the original error. The intake call
 * itself is never reported (no loops).
 */
function reportClientError(report) {
  try {
    if (!report || !report.url) return;
    if (String(report.url).includes(CLIENT_ERRORS_PATH)) return;
    const token = getAdminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const sent = fetch(CLIENT_ERRORS_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(report),
      keepalive: true,
    });
    if (sent && typeof sent.catch === 'function') sent.catch(() => {});
  } catch {
    // Reporting is best-effort by design.
  }
}

async function adminFetch(path, options = {}, { authed = true, operation = '' } = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getAdminToken();
  if (authed && token) headers.Authorization = `Bearer ${token}`;
  const method = String(options.method || 'GET').toUpperCase();
  const reportContext = operation ? { operation } : null;

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (fetchErr) {
    // The request or the response never completed. The browser is
    // the only witness — report what it saw, then surface the coded
    // error exactly as before.
    reportClientError({
      kind: 'network',
      url: path,
      method,
      status: null,
      message: (fetchErr && fetchErr.message) || 'fetch failed',
      context: reportContext,
    });
    const err = new Error(UNAVAILABLE_MESSAGE);
    err.code = 'network';
    throw err;
  }
  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  const responseRequestId =
    response.headers.get('x-request-id') || (data && data.requestId) || '';
  if (data === null) {
    // Something answered, but not the API — e.g. static hosting
    // returning the app's index.html for an unknown path, or an edge
    // error page. Distinct from a network failure: the code lets
    // callers say so truthfully instead of blaming the connection.
    // The report carries the evidence this time: the status, the
    // content-type, and the first bytes of whatever answered.
    reportClientError({
      kind: 'bad-response',
      url: path,
      method,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      bodyExcerpt: text.slice(0, 500),
      message: `Non-JSON response (HTTP ${response.status})`,
      ...(responseRequestId ? { requestId: responseRequestId } : {}),
      context: reportContext,
    });
    const err = new Error(UNAVAILABLE_MESSAGE);
    err.code = 'bad-response';
    if (responseRequestId) err.requestId = responseRequestId;
    throw err;
  }
  if (!response.ok) {
    // A 401 on an authenticated call means the token is gone or
    // expired server-side; drop it so the next visit starts clean.
    if (response.status === 401 && authed && token) clearAdminToken();
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    if (responseRequestId) err.requestId = responseRequestId;
    throw err;
  }
  return data;
}

function postJson(path, body, options) {
  return adminFetch(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options
  );
}

/**
 * Sign in with the admin credentials.
 * Resolves to { token, expiresAt, authSource } and stores the session.
 * authSource says which credential matched: 'env' (the BEASTMODE_ADMIN_*
 * secrets), 'account' (a stored account from first-run setup), or
 * 'demo' (the built-in fallback login, only while nothing real exists).
 */
export async function adminLogin(username, password) {
  const data = await postJson(
    '/api/admin/login',
    { username, password },
    { authed: false }
  );
  setAdminSession(data);
  return data;
}

/**
 * First-run setup state: { setupRequired, envConfigured, dummyActive }.
 * Drives the login page's "create the first account" offer and the
 * demo-login banner. Public endpoint (no token needed).
 */
export async function fetchSetupStatus() {
  return adminFetch('/api/admin/setup-status', {}, { authed: false });
}

/**
 * Create the FIRST stored admin account (POST /api/admin/setup).
 * Only works while no account exists (409 after that). Resolves to
 * { token, expiresAt, authSource: 'account' } and stores the session,
 * so a successful setup lands signed in.
 */
export async function adminSetup(username, password) {
  const data = await postJson(
    '/api/admin/setup',
    { username, password },
    { authed: false }
  );
  setAdminSession(data);
  return data;
}

/**
 * Password recovery (POST /api/admin/recovery/reset): the owner proves
 * ownership with the ADMIN_RECOVERY_CODE secret from the site's
 * Cloudflare settings and sets a new password for a stored admin
 * account (created by the reset when the username is new). Resolves
 * to { token, expiresAt, authSource: 'account' } and stores the
 * session, so a successful reset lands signed in. Server errors
 * surface verbatim — including the 503 that explains the code has
 * not been set up yet.
 */
export async function adminRecoveryReset(username, recoveryCode, newPassword) {
  const data = await postJson(
    '/api/admin/recovery/reset',
    { username, recoveryCode, newPassword },
    { authed: false }
  );
  setAdminSession(data);
  return data;
}

// ----- Admin accounts (multi-admin: owner management + own password) -----------
//
// The accounts endpoints (functions/api/admin/accounts/*, see
// docs/ADMINS.md):
//   GET    /api/admin/accounts                 owner-only list
//   POST   /api/admin/accounts { username }    owner-only add; the
//          response carries the one-time temporaryPassword — the
//          server hashes it and never shows it again.
//   DELETE /api/admin/accounts/:username       owner-only remove -> 204
//   POST   /api/admin/accounts/change-password any stored-account
//          admin changing HER OWN password (also clears must_change)

/** The stored admin accounts: { accounts: [{ username, createdAt, isOwner }] }. Owner-only — a 403 means "not the owner". */
export async function fetchAdminAccounts() {
  return adminFetch('/api/admin/accounts');
}

/**
 * Add an admin (POST /api/admin/accounts). Resolves to
 * { username, temporaryPassword, createdAt } — show the temporary
 * password to the owner ONCE; there is no way to read it back.
 */
export async function createAdminAccount(username) {
  return postJson('/api/admin/accounts', { username });
}

/**
 * Delete an admin (DELETE /api/admin/accounts/:username -> 204).
 * Same 204-with-no-body shape as deleteAdminProduct, so the same
 * hand-rolled fetch: adminFetch would read the empty body as
 * "server unreachable".
 */
export async function deleteAdminAccount(username) {
  const token = getAdminToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`/api/admin/accounts/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers,
    });
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  if (response.ok) return true;
  if (response.status === 401 && token) clearAdminToken();
  const data = await response.json().catch(() => null);
  const err = new Error((data && data.error) || `Request failed (${response.status})`);
  err.status = response.status;
  throw err;
}

/**
 * Change the signed-in admin's own password
 * (POST /api/admin/accounts/change-password). On success the
 * must-change flag that may have routed her here is spent — clear
 * the local copy so the dashboard stops sending her back.
 */
export async function changeAdminPassword(currentPassword, newPassword) {
  const data = await postJson('/api/admin/accounts/change-password', {
    currentPassword,
    newPassword,
  });
  try {
    localStorage.removeItem(MUST_CHANGE_KEY);
  } catch {
    // Storage unavailable — the server-side flag is cleared either way.
  }
  return data;
}

/** The admin order inbox: { orders: [...], newCount }, newest first. */
export async function fetchAdminOrders() {
  return adminFetch('/api/admin/orders');
}

// ----- Error Logs (2026-11-10 — docs/ERROR_LOGS.md) ---------------------------
//
//   GET    /api/admin/error-logs?limit=   { logs: [...] }, newest
//          first — server 5xx, client-reported browser failures and
//          824 Shield blocks, each with its actual error.
//   DELETE /api/admin/error-logs          { ok, removed } — clears
//          the whole log (the response is JSON, so unlike the 204
//          deletes this rides adminFetch normally).

/** The captured failures: { logs: [{ id, ts, requestId, source, ... }] }. */
export async function fetchErrorLogs(limit = 100) {
  return adminFetch(`/api/admin/error-logs?limit=${encodeURIComponent(limit)}`);
}

/** Clear the whole error log. Resolves to { ok: true, removed }. */
export async function clearErrorLogs() {
  return adminFetch('/api/admin/error-logs', { method: 'DELETE' });
}

// ----- Best Offer inbox (2026-11-10 — docs/OFFERS.md) -------------------------
//
//   GET  /api/admin/offers                  { offers, counts } —
//        pending first, newest first; each offer joins its product
//        name + current list price and a would-be totals preview.
//   POST /api/admin/offers/:id/accept       decision only — creates
//        no order; the buyer pays via the offer pay endpoint.
//   POST /api/admin/offers/:id/decline

/** The Best Offer inbox: { offers: [...], counts: { pending, ... } }. */
export async function fetchAdminOffers() {
  return adminFetch('/api/admin/offers');
}

/** Accept an offer (POST /api/admin/offers/:id/accept). Resolves to the updated offer. */
export async function acceptAdminOffer(id) {
  return postJson(`/api/admin/offers/${id}/accept`, {});
}

/** Decline an offer (POST /api/admin/offers/:id/decline). Resolves to the updated offer. */
export async function declineAdminOffer(id) {
  return postJson(`/api/admin/offers/${id}/decline`, {});
}

/** One order in full (GET /api/admin/orders/:id). */
export async function fetchAdminOrder(id) {
  return adminFetch(`/api/admin/orders/${id}`);
}

/**
 * Acknowledge an order (PATCH /api/admin/orders/:id/seen):
 * status 'new' -> 'seen', stamping seenAt. Resolves to the order.
 */
export async function markAdminOrderSeen(id) {
  return adminFetch(`/api/admin/orders/${id}/seen`, { method: 'PATCH' });
}

/**
 * The registered customers (GET /api/admin/customers):
 * { customers: [{ id, name, email, createdAt }] }, newest first.
 * Public fields only — the endpoint never returns credential material.
 */
export async function fetchAdminCustomers() {
  return adminFetch('/api/admin/customers');
}

/**
 * The product catalog (GET /api/products — the same public list the
 * storefront reads; there is no separate admin list endpoint).
 * Resolves to an array, possibly empty.
 */
export async function fetchAdminProducts() {
  return adminFetch('/api/products', {}, { authed: false });
}

// ----- Product writes (the admin product editor) ---------------------------
//
// Saving is ALWAYS two steps when a photo is attached, and the reason
// is null: the JSON body can say `"stockQty": null` (switch a tracked
// product back to untracked), `"price": null` (Price TBD) and clear a
// measurement with null, while a multipart form cannot express null
// at all (every field is a string; OMITTING a field on update keeps
// the old value — see normalizeProduct's pick() in _lib/validate.js).
// So:
//
//   1. The field payload goes as JSON — POST /api/products to create,
//      PUT /api/products/:id to edit. This is the authoritative save.
//   2. If a photo file was chosen, it follows as a dedicated POST to
//      /api/admin/products/:id/photo whose multipart body carries
//      ONLY the photo. That endpoint runs readProductInput ->
//      attachPhoto -> read-back verify and answers { ok, product }
//      (or { ok:false, stage, error } naming the failing stage), so
//      a photo failure always carries the server's own words.
//      (2026-11-10: the photo step used to be a second multipart PUT
//      to /api/products/:id, which in production died before reaching
//      the Worker — the client saw a non-JSON edge answer. The
//      /api/admin namespace serves every other editor write without
//      that failure; the photo step lives there now.)
//
// If step 2 fails (e.g. the deployment has no PRODUCT_PHOTOS bucket —
// the server answers a clear 400), the error is rethrown with
// `err.savedProduct` attached: the product itself IS saved, and the
// editor adopts it as an edit form so pressing Save again retries the
// photo instead of creating a duplicate. The error also carries
// `err.photoFailure` — what actually went wrong, for the editor's
// friendly message (lib/photoPrep.js photoFailureMessage): the
// server's own message when it sent one, the adminFetch .code
// ('network' / 'bad-response') when it didn't, whether the original
// was an HEIC the browser could not convert, and the size of the
// file that was actually uploaded.
//
// Before step 2, the photo is prepared in the browser
// (lib/photoPrep.js): decoded and walked down a shrink ladder
// (smaller dimensions, lower quality) until the JPEG is at most
// ~900 KB. Phone cameras shoot HEIC at several MB — the server only
// takes jpg/png/webp/gif/svg up to 10 MB, and a multi-MB upload
// from the phone kept dying in transit with a non-JSON edge answer
// (the 2026-11-10 failure this prep fixes). Prep never throws. It
// has exactly one hard stop: a photo larger than 2 MB that the
// device itself could not shrink is NOT sent — sending that
// original is precisely the upload that keeps dying — and the save
// fails with err.photoFailure.code 'too-large-unshrinkable' after
// the details have saved (same savedProduct contract as any other
// photo failure). Smaller photos prep cannot process still upload
// as the original file, exactly as before.

/** '' / whitespace -> null (clears the field); anything else trimmed. */
function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/**
 * The editor's size rows -> the payload's sizeInventory field
 * (2026-11-10, per-size stock):
 *   - rows filled in -> the [{ size, qty }] array (the server
 *     derives the product's sizes and total stock from it);
 *   - editing a product that HAD per-size stock with every row
 *     removed -> an explicit EMPTY array, which is the server's
 *     "clear back to legacy mode" signal (normalizeProduct's
 *     precedence rule in _lib/validate.js);
 *   - otherwise -> undefined: the field is OMITTED, so the stored
 *     mode (legacy or per-size) is kept exactly as it was.
 * The editor validates rows before saving (every row has a size
 * and a whole-number quantity, no duplicates), so Number() here
 * always lands on the validated integer.
 */
function sizeInventoryPayload(form) {
  const rows = (Array.isArray(form.sizeRows) ? form.sizeRows : [])
    .map((r) => ({
      size: String(r.size || '').trim(),
      qty: String(r.qty ?? '').trim(),
    }))
    .filter((r) => r.size !== '' || r.qty !== '');
  if (rows.length > 0) {
    return rows.map((r) => ({ size: r.size, qty: Number(r.qty) }));
  }
  if (form.hadSizeInventory) return [];
  return undefined;
}

/**
 * Shape the editor's form state into the JSON payload. Numeric fields
 * go as the strings the admin typed (or null when blank): the server
 * parses and range-checks them (parseOptionalNumber & friends in
 * _lib/validate.js), so a typo surfaces as the server's 400 message
 * rather than being silently coerced here.
 *
 * Clothing (2026-11-09): the payload carries brand and scent. The
 * retired smoke-shop fields (thc, strength, effects, unit) are
 * deliberately NOT sent: on update, normalizeProduct's pick() falls
 * back to the stored row for any field the body omits, so editing a
 * legacy product never wipes its stored legacy values; on create
 * they default (null / '' / []).
 *
 * Sizes (2026-11-10): the free-text `sizes` field is no longer sent
 * either — the editor's size ROWS own the size data now, through
 * sizeInventory above. Omitting `sizes` keeps a legacy product's
 * stored size run untouched on edit; a product only gains, changes
 * or clears sizes by saving size rows.
 */
function buildProductPayload(form) {
  const sizeInventory = sizeInventoryPayload(form);
  const perSize = Array.isArray(sizeInventory) && sizeInventory.length > 0;
  return {
    name: String(form.name || '').trim(),
    subtitle: String(form.subtitle || '').trim(),
    category: form.category,
    type: String(form.type || '').trim(),
    price: blankToNull(form.price),
    brand: blankToNull(form.brand),
    gender: form.gender ? form.gender : null,
    ...(sizeInventory !== undefined ? { sizeInventory } : {}),
    scent: blankToNull(form.scent),
    // Best Offer (2026-11-10): condition ('new' | 'used') and the
    // acceptsOffers switch ride the same JSON step. For a NEW item
    // the editor disables the switch and sends false — the server
    // forces offers off for 'new' regardless (docs/OFFERS.md).
    condition: form.condition || null,
    acceptsOffers: Boolean(form.acceptsOffers),
    tile: Array.isArray(form.tile) ? form.tile : undefined,
    weightOz: blankToNull(form.weightOz),
    lengthIn: blankToNull(form.lengthIn),
    widthIn: blankToNull(form.widthIn),
    heightIn: blankToNull(form.heightIn),
    // Per-size mode: the size rows are the stock, so stockQty is
    // sent null (the server derives the total from sizeInventory
    // and ignores this field for stock purposes). Legacy mode keeps
    // the radio-driven behavior.
    stockQty: perSize
      ? null
      : form.stockMode === 'tracked'
        ? blankToNull(form.stockQty)
        : null,
    lowStockThreshold: blankToNull(form.lowStockThreshold),
    freeShipping: Boolean(form.freeShipping),
  };
}

/**
 * Create or update a product from the editor's form state.
 * `form.id` absent -> create; present -> update. `photoFile` is a
 * File or null. Resolves to the saved product (with its photo, when
 * one was attached). See the two-step note above for the
 * err.savedProduct contract on photo failures.
 */
export async function saveAdminProduct(form, photoFile) {
  const payload = buildProductPayload(form);
  const saved = form.id
    ? await adminFetch(`/api/products/${form.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    : await postJson('/api/products', payload);

  if (!photoFile) return saved;

  const prep = await preparePhotoForUpload(photoFile);
  if (!prep.uploadFile) {
    // Prep's one hard stop (lib/photoPrep.js): the original is a
    // giant this device could not shrink, and uploading it as-is is
    // the exact send that keeps dying in transit — so nothing is
    // sent at all. The details above already saved; fail with the
    // same contract as a photo-step error (savedProduct for the
    // editor's adopt-and-retry, photoFailure for its message).
    const err = new Error(
      'That photo is very large, and this device could not shrink it.'
    );
    err.savedProduct = saved;
    err.photoFailure = {
      code: 'too-large-unshrinkable',
      tooLargeUnshrinkable: true,
      uploadBytes: Number(prep.originalBytes || photoFile.size || 0),
      heicUnconverted: Boolean(prep.heicUnconverted),
    };
    throw err;
  }
  const uploadFile = prep.uploadFile;
  const fd = new FormData();
  fd.append('photo', uploadFile);
  try {
    const result = await adminFetch(
      `/api/admin/products/${saved.id}/photo`,
      {
        method: 'POST',
        body: fd,
      },
      { operation: 'product-photo-upload' }
    );
    // The photo endpoint answers { ok:true, product } — unwrap to
    // the product so callers keep the saveAdminProduct contract.
    // (A failure arrives as a thrown adminFetch error carrying the
    // endpoint's { ok:false, stage, error } message verbatim.)
    return result && result.product ? result.product : saved;
  } catch (err) {
    err.savedProduct = saved;
    err.photoFailure = {
      // A .status means the server answered with its own JSON error —
      // that message is the truth and surfaces verbatim. The coded
      // failures (network / bad-response) have no server message.
      serverMessage: err.status ? err.message : '',
      code: err.code || '',
      // The request id the server stamped on the failed call, when
      // it provided one — the editor appends it as "(ref: ...)" so
      // the failure can be found in the admin Error Logs.
      requestId: err.requestId || '',
      heicUnconverted: Boolean(prep.heicUnconverted),
      uploadBytes: Number(uploadFile.size || 0),
    };
    throw err;
  }
}

/**
 * Delete a product (DELETE /api/products/:id -> 204 No Content).
 * Resolves true on success. This cannot ride adminFetch: a 204 has
 * no body, and adminFetch reads an unparseable body as "server
 * unreachable" — so the same error semantics are spelled out here.
 * The product's photo object is intentionally left in R2 (see
 * docs/PRODUCT_EDITOR.md).
 */
export async function deleteAdminProduct(id) {
  const token = getAdminToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`/api/products/${id}`, { method: 'DELETE', headers });
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  if (response.ok) return true;
  if (response.status === 401 && token) clearAdminToken();
  const data = await response.json().catch(() => null);
  const err = new Error((data && data.error) || `Request failed (${response.status})`);
  err.status = response.status;
  throw err;
}
