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

// OAuth tokens are cached per isolate: one token call serves every
// quote until ~60s before the token's stated expiry. The cache is
// keyed by client id so a key change (or a test env) never reuses a
// token minted under different credentials.
let tokenCache = null;

async function fetchUspsToken(env) {
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
    throw new HttpError(502, `Could not reach USPS to get an access token (${err.message}).`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new HttpError(502, `USPS token request failed (HTTP ${response.status}).`);
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache = {
    clientId: env.USPS_CLIENT_ID,
    token: data.access_token,
    // Refresh a minute early so a quote never starts on a dying token.
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
  return tokenCache.token;
}

export async function getUspsToken(env) {
  if (
    tokenCache &&
    tokenCache.clientId === env.USPS_CLIENT_ID &&
    Date.now() < tokenCache.expiresAt
  ) {
    return tokenCache.token;
  }
  return fetchUspsToken(env);
}

/**
 * Quote live retail rates for one parcel. Makes one base-rates call
 * per offered mail class; a class whose call fails (HTTP error, no
 * usable price) is skipped. Returns an array of
 * { service, label, mailClass, priceCents, zone? } — zone only when
 * USPS reported one. Throws HttpError 502 only when EVERY class
 * failed, so the caller can decide whether to offer a fallback.
 */
export async function quoteUspsRates(env, { destZip, weightLb, length, width, height }) {
  const token = await getUspsToken(env);
  const mailingDate = new Date().toISOString().slice(0, 10);
  const options = [];

  for (const svc of USPS_SERVICES) {
    const body = {
      originZIPCode: String(env.USPS_ORIGIN_ZIP).slice(0, 5),
      destinationZIPCode: String(destZip).slice(0, 5),
      weight: weightLb,
      length,
      width,
      height,
      mailClass: svc.mailClass,
      priceType: 'RETAIL',
      mailingDate,
    };
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
      if (response.ok) data = await response.json().catch(() => null);
    } catch {
      data = null; // network failure — this class is skipped below
    }
    const price = data ? Number(data.totalBasePrice) : NaN;
    if (!Number.isFinite(price) || price <= 0) continue;
    const option = {
      service: svc.service,
      label: svc.label,
      mailClass: svc.mailClass,
      priceCents: Math.round(price * 100),
    };
    const firstRate = Array.isArray(data.rates) ? data.rates[0] : null;
    if (firstRate && firstRate.zone !== undefined && firstRate.zone !== null) {
      option.zone = firstRate.zone;
    }
    options.push(option);
  }

  if (options.length === 0) {
    throw new HttpError(502, 'USPS returned no usable rates for this shipment.');
  }
  return options;
}
