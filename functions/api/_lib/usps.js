// USPS Prices API v3 client — live shipping rates for Shop 824 checkout
// (owner direction 2026-11-09: buyer-paid shipping, calculated at
// checkout from real USPS rates). Plain fetch, no SDK, mirroring
// _lib/stripe.js: configuration comes only from environment variables,
// and the feature is DORMANT until they are set.
//
// Configuration (Worker secrets / variables — never code):
//   USPS_CLIENT_ID      OAuth2 Consumer Key from developers.usps.com.
//   USPS_CLIENT_SECRET  OAuth2 Consumer Secret from the same USPS app.
//   USPS_ORIGIN_ZIP     The 5-digit ZIP orders ship FROM.
//   USPS_API_BASE       Optional override of https://apis.usps.com
//                       (used by tests; not needed in production).
//
// API shape (USPS Prices API v3, per USPS's official examples):
//   POST {BASE}/oauth2/v3/token
//        { grant_type: 'client_credentials', client_id, client_secret }
//        -> { access_token, expires_in } (expires_in is seconds)
//   POST {BASE}/prices/v3/base-rates/search   (Bearer <token>)
//        one call PER MAIL CLASS:
//        { originZIPCode, destinationZIPCode, weight (pounds),
//          length, width, height (inches), mailClass,
//          priceType: 'RETAIL', mailingDate: 'YYYY-MM-DD' }
//        -> { totalBasePrice, rates: [...] }
//
// USPS allows only ~60 Prices calls/hour per key, so rates are quoted
// per checkout interaction (one quote = up to two class calls), never
// per page view.
//
// Diagnostics (2026-11-10): every USPS call in a quote records one
// entry in a caller-supplied diagnostics array:
//   { stage: 'token' | 'rates' | 'rates-commercial-fallback',
//     mailClass: string | null, priceType: string | null,
//     httpStatus: number | null (null when fetch itself threw),
//     errorCode: string | null (parsed from the USPS error body),
//     message: string | null (trimmed to 200 chars),
//     ok: boolean }
// Diagnostics NEVER contain credential values, tokens, or raw
// response bodies — only statuses and parsed error code/message
// fields. quoteUspsRates returns { options, diagnostics } and, when
// it throws, the HttpError carries the same array on `.diagnostics`.
// GET /api/shipping/debug surfaces them; see docs/SHIPPING.md
// ("Diagnosing live rates").

import { HttpError } from './http.js';

export const USPS_API_BASE_DEFAULT = 'https://apis.usps.com';

// The two retail services the shopfront offers, cheapest first. `key`
// is the stable service id stored on orders and sent by the client;
// `mailClass` is the USPS Prices API mail class for the rate call.
export const USPS_SERVICES = [
  { service: 'ground_advantage', label: 'USPS Ground Advantage', mailClass: 'USPS_GROUND_ADVANTAGE' },
  { service: 'priority_mail', label: 'USPS Priority Mail', mailClass: 'PRIORITY_MAIL' },
];

/** True only when every USPS credential the rate calls need is set. */
export function uspsConfigured(env) {
  return Boolean(
    env &&
      env.USPS_CLIENT_ID &&
      env.USPS_CLIENT_SECRET &&
      env.USPS_ORIGIN_ZIP
  );
}

function uspsBase(env) {
  return env.USPS_API_BASE || USPS_API_BASE_DEFAULT;
}

const trimMessage = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 200) : null;
};

const trimCode = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 64) : null;
};

/**
 * Defensively pull an error code + message out of a USPS v3 error
 * body. USPS has used several shapes:
 *   OAuth:        { error: 'invalid_client', error_description }
 *   Object error: { error: { code, message } }
 *   Error list:   { errors: [{ code, title, detail }] }
 *   RFC 7807:     { title, detail, status }
 * Returns { code, message }, either possibly null. Only these scalar
 * fields are read — the raw body is never copied anywhere.
 */
export function extractUspsError(data) {
  if (!data || typeof data !== 'object') return { code: null, message: null };
  let code = null;
  let message = null;
  if (typeof data.error === 'string') {
    code = trimCode(data.error);
  } else if (data.error && typeof data.error === 'object') {
    code = trimCode(data.error.code || data.error.errorCode);
    message = trimMessage(data.error.message || data.error.description);
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0] || {};
    if (!code) code = trimCode(first.code || first.errorCode);
    if (!message) message = trimMessage(first.detail || first.title || first.message);
  }
  if (!code) code = trimCode(data.code || data.errorCode);
  if (!message) {
    message = trimMessage(data.error_description || data.detail || data.title || data.message);
  }
  return { code, message };
}

function newDiagnostic(stage, mailClass, priceType) {
  return {
    stage,
    mailClass: mailClass || null,
    priceType: priceType || null,
    httpStatus: null,
    errorCode: null,
    message: null,
    ok: false,
  };
}

// OAuth tokens are cached per isolate: one token call serves every
// quote until ~60s before the token's stated expiry. The cache is
// keyed by client id so a key change (or a test env) never reuses a
// token minted under different credentials.
let tokenCache = null;

async function fetchUspsToken(env, diagnostics) {
  const entry = newDiagnostic('token', null, null);
  let response;
  try {
    response = await fetch(`${uspsBase(env)}/oauth2/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: env.USPS_CLIENT_ID,
        client_secret: env.USPS_CLIENT_SECRET,
      }),
    });
  } catch (err) {
    entry.message = trimMessage(`network error: ${err && err.message ? err.message : 'fetch failed'}`);
    if (diagnostics) diagnostics.push(entry);
    const wrapped = new HttpError(502, `Could not reach USPS to get an access token (${err.message}).`);
    wrapped.diagnostics = diagnostics || [entry];
    throw wrapped;
  }
  entry.httpStatus = response.status;
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const parsed = extractUspsError(data);
    entry.errorCode = parsed.code;
    entry.message = parsed.message
      || (response.ok ? 'response contained no access_token' : null);
    if (diagnostics) diagnostics.push(entry);
    const wrapped = new HttpError(502, `USPS token request failed (HTTP ${response.status}).`);
    wrapped.diagnostics = diagnostics || [entry];
    throw wrapped;
  }
  entry.ok = true;
  if (diagnostics) diagnostics.push(entry);
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache = {
    clientId: env.USPS_CLIENT_ID,
    token: data.access_token,
    // Refresh a minute early so a quote never starts on a dying token.
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
  return tokenCache.token;
}

export async function getUspsToken(env, diagnostics) {
  if (
    tokenCache &&
    tokenCache.clientId === env.USPS_CLIENT_ID &&
    Date.now() < tokenCache.expiresAt
  ) {
    if (diagnostics) {
      const entry = newDiagnostic('token', null, null);
      entry.ok = true;
      entry.message = 'served from isolate token cache — no USPS call made';
      diagnostics.push(entry);
    }
    return tokenCache.token;
  }
  return fetchUspsToken(env, diagnostics);
}

/**
 * One base-rates call for one mail class at one priceType. Records a
 * diagnostics entry (stage is 'rates' for the production RETAIL call,
 * 'rates-commercial-fallback' for the debug-only COMMERCIAL probe) and
 * returns the option on success or null on any failure — the failure
 * detail lives in the diagnostics entry, not in a swallowed null.
 */
async function quoteOneClass(env, token, svc, parcel, priceType, stage, diagnostics) {
  const { destZip, weightLb, length, width, height } = parcel;
  const body = {
    originZIPCode: String(env.USPS_ORIGIN_ZIP).slice(0, 5),
    destinationZIPCode: String(destZip).slice(0, 5),
    weight: weightLb,
    length,
    width,
    height,
    mailClass: svc.mailClass,
    priceType,
    mailingDate: new Date().toISOString().slice(0, 10),
  };
  const entry = newDiagnostic(stage, svc.mailClass, priceType);
  let data = null;
  try {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(`${uspsBase(env)}/prices/v3/base-rates/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    entry.httpStatus = response.status;
    data = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = extractUspsError(data);
      entry.errorCode = parsed.code;
      entry.message = parsed.message;
      diagnostics.push(entry);
      return null;
    }
  } catch (err) {
    entry.message = trimMessage(`network error: ${err && err.message ? err.message : 'fetch failed'}`);
    diagnostics.push(entry);
    return null;
  }
  const price = data ? Number(data.totalBasePrice) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    entry.message = 'response contained no usable totalBasePrice';
    diagnostics.push(entry);
    return null;
  }
  entry.ok = true;
  diagnostics.push(entry);
  const option = {
    service: svc.service,
    label: svc.label,
    mailClass: svc.mailClass,
    priceType,
    priceCents: Math.round(price * 100),
  };
  const firstRate = Array.isArray(data.rates) ? data.rates[0] : null;
  if (firstRate && firstRate.zone !== undefined && firstRate.zone !== null) {
    option.zone = firstRate.zone;
  }
  return option;
}

/**
 * Quote live retail rates for one parcel. Makes one base-rates call
 * per offered mail class (priceType 'RETAIL'); a class whose call
 * fails (HTTP error, no usable price) is skipped, with the reason
 * recorded in diagnostics.
 *
 * Returns { options, diagnostics } — options are
 * { service, label, mailClass, priceType, priceCents, zone? }.
 * Throws HttpError 502 only when EVERY class failed; the error
 * carries the same diagnostics array on `.diagnostics`.
 *
 * Options:
 *   diagnostics        array to append entries to (a fresh one is
 *                      created when omitted).
 *   commercialFallback debug-only (default false): when the Ground
 *                      Advantage RETAIL call fails, ALSO try that
 *                      class at priceType 'COMMERCIAL', recorded with
 *                      stage 'rates-commercial-fallback'. Production
 *                      quoting (shipping.js) never sets this.
 */
export async function quoteUspsRates(env, parcel, { diagnostics = [], commercialFallback = false } = {}) {
  const token = await getUspsToken(env, diagnostics);
  const options = [];

  for (const svc of USPS_SERVICES) {
    // eslint-disable-next-line no-await-in-loop
    const option = await quoteOneClass(env, token, svc, parcel, 'RETAIL', 'rates', diagnostics);
    if (option) {
      options.push(option);
      continue;
    }
    if (commercialFallback && svc.service === 'ground_advantage') {
      // eslint-disable-next-line no-await-in-loop
      const commercial = await quoteOneClass(
        env, token, svc, parcel, 'COMMERCIAL', 'rates-commercial-fallback', diagnostics
      );
      if (commercial) options.push(commercial);
    }
  }

  if (options.length === 0) {
    const err = new HttpError(502, 'USPS returned no usable rates for this shipment.');
    err.diagnostics = diagnostics;
    throw err;
  }
  return { options, diagnostics };
}
