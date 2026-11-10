// USPS diagnostics tests — plain node, no dependencies.
// Run: node scripts/test-usps-debug.mjs
//
// Covers the 2026-11-10 diagnostic build:
//   * _lib/usps.js diagnostics capture — token failures and per-class
//     rates failures are recorded with HTTP status + the USPS error
//     code/message parsed out of the error body, and NEVER contain
//     credential values;
//   * the debug-only COMMERCIAL price-type probe for Ground
//     Advantage (stage 'rates-commercial-fallback') — and proof the
//     production quote path (quoteShipping) never uses it;
//   * GET /api/shipping/debug — admin gate (401 like every admin
//     route), unconfigured short-circuit, happy path, token-failure
//     path;
//   * the computePackage per-axis default guarantee — a product with
//     a NULL height quotes with height 6 in the body USPS receives.

import { quoteUspsRates, extractUspsError } from '../functions/api/_lib/usps.js';
import { quoteShipping, computePackage } from '../functions/api/_lib/shipping.js';
import { onRequestGet as shippingDebug } from '../functions/api/shipping/debug.js';
import { issueToken } from '../functions/api/_lib/auth.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

// ----- Fetch mock (USPS only) ---------------------------------------------------
// Token behavior keys off the client id so each scenario gets a fresh
// token cache entry (usps.js caches per client id): ids containing
// 'bad' or 'leak' are rejected with an OAuth-shaped error body.

const USPS_BASE = 'https://usps.test';
const realFetch = globalThis.fetch;
let priceCalls = [];
let ratesBehavior = {};

function defaultRates() {
  return {
    USPS_GROUND_ADVANTAGE: { status: 200, body: { totalBasePrice: 9.31, rates: [{ price: 9.31, zone: '4' }] } },
    PRIORITY_MAIL: { status: 200, body: { totalBasePrice: 12.4, rates: [{ price: 12.4, zone: '4' }] } },
  };
}
ratesBehavior = defaultRates();

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(USPS_BASE)) {
    if (u.endsWith('/oauth2/v3/token')) {
      const body = JSON.parse(init.body);
      if (/bad|leak/.test(String(body.client_id))) {
        return new Response(
          JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ access_token: `tok-for-${body.client_id}`, expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/prices/v3/base-rates/search')) {
      const body = JSON.parse(init.body);
      priceCalls.push(body);
      const behavior = ratesBehavior[`${body.mailClass}|${body.priceType}`]
        || ratesBehavior[body.mailClass]
        || { status: 500, body: {} };
      return new Response(JSON.stringify(behavior.body), {
        status: behavior.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }
  return realFetch(url, init);
};

function uspsEnv(clientId, secret) {
  return {
    USPS_CLIENT_ID: clientId,
    USPS_CLIENT_SECRET: secret,
    USPS_ORIGIN_ZIP: '14617',
    USPS_API_BASE: USPS_BASE,
  };
}

const PARCEL = { destZip: '90210', weightLb: 1, length: 12, width: 9, height: 6 };
const ORIGIN = 'https://beastmode82420.com';

// ----- Error-body parser shapes ---------------------------------------------------

console.log('usps — error body parsing');
{
  check('oauth shape', (() => { const e = extractUspsError({ error: 'invalid_client', error_description: 'nope' }); return e.code === 'invalid_client' && e.message === 'nope'; })());
  check('object shape', (() => { const e = extractUspsError({ error: { code: 'X1', message: 'bad parcel' } }); return e.code === 'X1' && e.message === 'bad parcel'; })());
  check('errors-list shape', (() => { const e = extractUspsError({ errors: [{ code: 'X2', detail: 'denied' }] }); return e.code === 'X2' && e.message === 'denied'; })());
  check('rfc7807 shape', (() => { const e = extractUspsError({ title: 'Forbidden', detail: 'not authorized', status: 403 }); return e.code === null && e.message === 'not authorized'; })());
  check('garbage shape -> nulls', (() => { const e = extractUspsError('nope'); return e.code === null && e.message === null; })());
  check('message trimmed to 200 chars', extractUspsError({ detail: 'x'.repeat(500) }).message.length === 200);
}

// ----- Token failure captured in diagnostics ---------------------------------------

console.log('usps — token failure diagnostics');
{
  const secret = 'LEAKCHECK-SECRET-VALUE';
  let thrown = null;
  try {
    await quoteUspsRates(uspsEnv('cid-leak', secret), PARCEL);
  } catch (err) {
    thrown = err;
  }
  check('token failure throws 502', thrown && thrown.status === 502, thrown && String(thrown.status));
  const diags = thrown && thrown.diagnostics;
  check('error carries diagnostics', Array.isArray(diags) && diags.length === 1, JSON.stringify(diags));
  const d = (diags || [])[0] || {};
  check('token entry: stage/status/code', d.stage === 'token' && d.httpStatus === 401 && d.errorCode === 'invalid_client', JSON.stringify(d));
  check('token entry: message from error_description', d.message === 'Client authentication failed', JSON.stringify(d));
  check('token entry: ok is false', d.ok === false);
  check('diagnostics NEVER contain the client secret', !JSON.stringify(diags).includes(secret));
}

// ----- Rates failure captured with its code -----------------------------------------

console.log('usps — rates failure diagnostics');
{
  ratesBehavior = defaultRates();
  // USPS errors-list shape on Ground Advantage; Priority still works.
  ratesBehavior.USPS_GROUND_ADVANTAGE = {
    status: 403,
    body: { errors: [{ code: 'RATE_FORBIDDEN', detail: 'App is not authorized for this API' }] },
  };
  const result = await quoteUspsRates(uspsEnv('cid-rates', 'rates-secret'), PARCEL);
  check('returns { options, diagnostics }', result && Array.isArray(result.options) && Array.isArray(result.diagnostics));
  check('surviving class still offered', result.options.length === 1 && result.options[0].service === 'priority_mail', JSON.stringify(result.options));
  const ga = result.diagnostics.find((d) => d.mailClass === 'USPS_GROUND_ADVANTAGE');
  check(
    'failed class entry: stage/status/code/message',
    ga && ga.stage === 'rates' && ga.httpStatus === 403 && ga.errorCode === 'RATE_FORBIDDEN'
      && ga.message === 'App is not authorized for this API' && ga.ok === false,
    JSON.stringify(ga)
  );
  const pm = result.diagnostics.find((d) => d.mailClass === 'PRIORITY_MAIL');
  check('succeeding class entry: ok, 200', pm && pm.ok === true && pm.httpStatus === 200, JSON.stringify(pm));
  const tok = result.diagnostics.find((d) => d.stage === 'token');
  check('token entry: ok', tok && tok.ok === true && tok.httpStatus === 200, JSON.stringify(tok));
  ratesBehavior = defaultRates();
}

// ----- Height defaults reach the USPS request body -----------------------------------

console.log('shipping — dimension defaults');
{
  const before = priceCalls.length;
  const quote = await quoteShipping(
    uspsEnv('cid-height', 'height-secret'),
    [{ product: { weightOz: 8, lengthIn: 10, widthIn: 8, heightIn: null }, qty: 1 }],
    '90210'
  );
  check('quote succeeds', quote.configured === true && quote.options.length === 2, JSON.stringify(quote.options));
  const gaCall = priceCalls.slice(before).find((b) => b.mailClass === 'USPS_GROUND_ADVANTAGE');
  check('null product height -> body height 6', gaCall && gaCall.height === 6, JSON.stringify(gaCall));
  check('set dims pass through (10 x 8)', gaCall && gaCall.length === 10 && gaCall.width === 8, JSON.stringify(gaCall));
  const empty = computePackage([]);
  check('empty parcel still defaults every axis (12 x 9 x 6)', empty.lengthIn === 12 && empty.widthIn === 9 && empty.heightIn === 6, JSON.stringify(empty));
}

// ----- Production path never probes COMMERCIAL ----------------------------------------

console.log('usps — production stays RETAIL-only');
{
  ratesBehavior = defaultRates();
  ratesBehavior.USPS_GROUND_ADVANTAGE = { status: 400, body: { error: { code: 'RETAIL_DENIED', message: 'no retail' } } };
  const before = priceCalls.length;
  const quote = await quoteShipping(
    uspsEnv('cid-prod', 'prod-secret'),
    [{ product: { weightOz: 8 }, qty: 1 }],
    '90210'
  );
  check('failed retail class drops out of production quote', quote.options.length === 1 && quote.options[0].service === 'priority_mail', JSON.stringify(quote.options));
  const calls = priceCalls.slice(before);
  check('no COMMERCIAL call in production path', calls.every((b) => b.priceType === 'RETAIL'), JSON.stringify(calls.map((b) => b.priceType)));
  ratesBehavior = defaultRates();
}

// ----- Debug endpoint -------------------------------------------------------------------

console.log('debug endpoint — admin gate');
const ADMIN_ENV = {
  BEASTMODE_ADMIN_USER: 'boss',
  BEASTMODE_ADMIN_PASSWORD: 'boss-pw',
  BEASTMODE_ADMIN_SECRET: 'debug-test-signing',
};
const { token: adminToken } = await issueToken(ADMIN_ENV, 'boss');

async function callDebug(env, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return shippingDebug({
    request: new Request(`${ORIGIN}/api/shipping/debug`, { headers }),
    env,
    params: {},
  });
}

{
  const noAuth = await callDebug({ ...ADMIN_ENV, ...uspsEnv('cid-gate', 'gate-secret') }, null);
  check('no admin token -> 401', noAuth.status === 401, `got ${noAuth.status}`);
  const badAuth = await callDebug({ ...ADMIN_ENV, ...uspsEnv('cid-gate', 'gate-secret') }, 'not-a-token');
  check('garbage admin token -> 401', badAuth.status === 401, `got ${badAuth.status}`);

  const unconfigured = await callDebug({ ...ADMIN_ENV }, adminToken);
  const unconfiguredBody = await unconfigured.json();
  check('unconfigured -> { configured:false }', unconfigured.status === 200 && unconfiguredBody.configured === false, JSON.stringify(unconfiguredBody));
}

console.log('debug endpoint — happy path');
{
  ratesBehavior = defaultRates();
  const res = await callDebug({ ...ADMIN_ENV, ...uspsEnv('cid-debug-ok', 'debug-secret') }, adminToken);
  const body = await res.json();
  check('happy path -> 200 configured', res.status === 200 && body.configured === true, `got ${res.status}`);
  check('tokenOk true', body.tokenOk === true, JSON.stringify(body.diagnostics));
  check('both live options returned (no fallback masking)', body.options.length === 2 && body.options.every((o) => o.priceCents > 0), JSON.stringify(body.options));
  check('diagnostics cover token + both classes, all ok', body.diagnostics.length === 3 && body.diagnostics.every((d) => d.ok), JSON.stringify(body.diagnostics));
  check('no error field on success', body.error === undefined, JSON.stringify(body));
}

console.log('debug endpoint — token failure surfaces');
{
  const secret = 'DEBUG-LEAKCHECK-SECRET';
  const res = await callDebug({ ...ADMIN_ENV, ...uspsEnv('cid-debug-bad', secret) }, adminToken);
  const text = await res.text();
  const body = JSON.parse(text);
  check('token failure still answers 200 + configured', res.status === 200 && body.configured === true, `got ${res.status}`);
  check('tokenOk false', body.tokenOk === false, JSON.stringify(body));
  check('options empty + error message present', body.options.length === 0 && typeof body.error === 'string' && body.error.length > 0, JSON.stringify(body));
  const d = body.diagnostics[0] || {};
  check('diagnostics carry the USPS refusal', d.stage === 'token' && d.httpStatus === 401 && d.errorCode === 'invalid_client', JSON.stringify(d));
  check('response NEVER contains the client secret', !text.includes(secret));
}

console.log('debug endpoint — COMMERCIAL fallback probe');
{
  ratesBehavior = defaultRates();
  ratesBehavior['USPS_GROUND_ADVANTAGE|RETAIL'] = {
    status: 400,
    body: { error: { code: 'COMMERCIAL_REQUIRED', message: 'Account must quote commercial rates' } },
  };
  ratesBehavior['USPS_GROUND_ADVANTAGE|COMMERCIAL'] = {
    status: 200,
    body: { totalBasePrice: 7.77, rates: [{ price: 7.77, zone: '5' }] },
  };
  const res = await callDebug({ ...ADMIN_ENV, ...uspsEnv('cid-debug-com', 'com-secret') }, adminToken);
  const body = await res.json();
  const ga = body.options.find((o) => o.service === 'ground_advantage');
  check('commercial probe rescues ground advantage (777 cents)', ga && ga.priceCents === 777 && ga.priceType === 'COMMERCIAL', JSON.stringify(body.options));
  const fb = body.diagnostics.find((d) => d.stage === 'rates-commercial-fallback');
  check('fallback recorded as its own stage, ok', fb && fb.ok === true && fb.httpStatus === 200 && fb.priceType === 'COMMERCIAL', JSON.stringify(fb));
  const retail = body.diagnostics.find((d) => d.stage === 'rates' && d.mailClass === 'USPS_GROUND_ADVANTAGE');
  check('failed retail attempt recorded with its code', retail && retail.ok === false && retail.errorCode === 'COMMERCIAL_REQUIRED', JSON.stringify(retail));
  ratesBehavior = defaultRates();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
