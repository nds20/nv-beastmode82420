// Admin Diagnostics tests (2026-11-11) — plain node, no framework:
//
//   node scripts/test-admin-diagnostics.mjs
//
// The two diagnostic ENDPOINTS already have their own suites
// (test-payments-debug.mjs and test-usps-debug.mjs). This suite is
// at the admin UI boundary, following test-error-logs.mjs's static
// wiring checks plus focused unit tests for the page's pure summary
// module (frontend/src/lib/adminDiagnostics.js):
//
//   (a) adminApi wires the exact payments-debug and shipping-debug
//       paths through adminFetch, whose existing implementation adds
//       the stored admin bearer token (verified at source level here
//       because Vite, not Node's ESM resolver, resolves this app's
//       extensionless browser imports);
//   (b) App routing + the admin nav expose Diagnostics everywhere
//       the other admin destinations are exposed;
//   (c) payments summaries distinguish already-recorded, newly
//       recorded/reconciled, still-missing, unknown, Stripe-error,
//       and Stripe-not-configured responses;
//   (d) shipping summaries distinguish healthy, partial, USPS-error,
//       and not-configured responses, and preserve the exact USPS
//       diagnostic status/code/message in a readable line;
//   (e) thrown admin errors become owner-readable messages, with
//       distinct network, bad-response, 401 and 503 cases.

import { readFileSync } from 'node:fs';
import {
  diagnosticErrorMessage,
  formatShippingDiagnostic,
  moneyFromCents,
  paymentSessionStatus,
  summarizePaymentsDiagnostics,
  summarizeShippingDiagnostics,
} from '../frontend/src/lib/adminDiagnostics.js';

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

function read(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

// =====================================================================
// (a) API boundary: exact paths + the existing admin-token plumbing.
// =====================================================================
{
  const api = read('../frontend/src/services/adminApi.js');
  const paymentsFunction = api.slice(api.indexOf('export async function fetchPaymentsDiagnostics'));
  const shippingFunction = paymentsFunction.slice(
    paymentsFunction.indexOf('export async function fetchShippingDiagnostics')
  );

  check('(a) adminFetch is the shared request path and adds the stored bearer token',
    api.includes('const token = getAdminToken();') &&
      api.includes('headers.Authorization = `Bearer ${token}`'));
  check('(a) payments diagnostics rides adminFetch to the exact endpoint',
    paymentsFunction.includes("adminFetch(") &&
      paymentsFunction.includes("'/api/admin/payments-debug'") &&
      paymentsFunction.includes("operation: 'payments-diagnostics'"));
  check('(a) shipping diagnostics rides adminFetch to the exact endpoint',
    shippingFunction.includes("adminFetch('/api/shipping/debug'") &&
      shippingFunction.includes("operation: 'shipping-diagnostics'"));
  check('(a) the page calls the two adminApi diagnostics functions',
    read('../frontend/src/pages/AdminDiagnostics.jsx').includes('fetchPaymentsDiagnostics()') &&
      read('../frontend/src/pages/AdminDiagnostics.jsx').includes('fetchShippingDiagnostics()'));
}

// =====================================================================
// (b) Route + nav + page wiring.
// =====================================================================
{
  const app = read('../frontend/src/App.jsx');
  const dashboard = read('../frontend/src/pages/AdminDashboard.jsx');
  const products = read('../frontend/src/pages/AdminProducts.jsx');
  const errorLogs = read('../frontend/src/pages/AdminErrorLogs.jsx');
  const page = read('../frontend/src/pages/AdminDiagnostics.jsx');
  const api = read('../frontend/src/services/adminApi.js');

  check('(b) App imports and routes the Diagnostics page',
    app.includes("import AdminDiagnostics from './pages/AdminDiagnostics';") &&
      app.includes('<Route path="admin/diagnostics" element={<AdminDiagnostics />} />'));
  check('(b) Dashboard nav links to Diagnostics',
    dashboard.includes('to="/shop/admin/diagnostics"') && dashboard.includes('Diagnostics'));
  check('(b) Products nav links to Diagnostics',
    products.includes('to="/shop/admin/diagnostics"') && products.includes('Diagnostics'));
  check('(b) Error Logs nav links to Diagnostics',
    errorLogs.includes('to="/shop/admin/diagnostics"') && errorLogs.includes('Diagnostics'));
  check('(b) Diagnostics page marks its own nav entry active',
    page.includes('Diagnostics') && page.includes('admin-tab is-active'));
  check('(b) adminApi names both diagnostics functions and paths',
    api.includes('fetchPaymentsDiagnostics') &&
      api.includes("'/api/admin/payments-debug'") &&
      api.includes('fetchShippingDiagnostics') &&
      api.includes("'/api/shipping/debug'"));
  check('(b) page has both exact run buttons',
    page.includes('Reconcile payments') && page.includes('Check shipping (USPS)'));
  check('(b) page has both busy states',
    page.includes('Reconciling…') && page.includes('Checking shipping…'));
  check('(b) page renders through the tested summary module',
    page.includes('summarizePaymentsDiagnostics') &&
      page.includes('summarizeShippingDiagnostics') &&
      page.includes('formatShippingDiagnostic'));
  check('(b) page carries the plain already-recorded success copy in the summary contract',
    page.includes('payments.headline') &&
      read('../frontend/src/lib/adminDiagnostics.js').includes(
        'All payments recorded — nothing missing.'
      ));
  check('(b) page names the company correctly',
    page.includes('824 BeastMode L.L.C.') && page.includes('Shop 824'));
}

// =====================================================================
// (c) Payments summaries + session states.
// =====================================================================
{
  const complete = summarizePaymentsDiagnostics({
    stripe: { configured: true, keyMode: 'live' },
    webhook: { configured: true },
    sessions: [
      {
        idPrefix: 'cs_live_done', kind: 'order', amountTotalCents: 908,
        recordedBefore: true, recordedAfter: true,
      },
    ],
    ordersSignal: { latestPaidOrderId: 9, latestPaidAt: '2026-11-11T02:00:00Z' },
    donationStats: { totalCents: 824, donationCount: 1 },
    mail: { configured: true, missing: [], token: { ok: true, status: 200, errorCode: null } },
  });
  check('(c) already-recorded response uses the exact success headline',
    complete.state === 'already-recorded' &&
      complete.headline === 'All payments recorded — nothing missing.',
    JSON.stringify(complete));
  check('(c) already-recorded counts + totals are preserved',
    complete.sessionCount === 1 && complete.alreadyRecordedCount === 1 &&
      complete.newlyRecordedCount === 0 && complete.stillMissingCount === 0 &&
      complete.donationTotalCents === 824 && complete.donationCount === 1 &&
      complete.ordersSignal.latestPaidOrderId === 9,
    JSON.stringify(complete));

  const mixedSessions = [
    {
      idPrefix: 'cs_live_dona', kind: 'donation', amountTotalCents: 824,
      recordedBefore: false, recordedAfter: true,
    },
    {
      idPrefix: 'cs_live_orde', kind: 'order', amountTotalCents: 908,
      recordedBefore: true, recordedAfter: true,
    },
    {
      idPrefix: 'cs_live_unkn', kind: 'unknown', amountTotalCents: 100,
      recordedBefore: null, recordedAfter: null, note: 'no matching order in db',
    },
  ];
  const reconciled = summarizePaymentsDiagnostics({
    stripe: { configured: true, keyMode: 'live' },
    webhook: { configured: true },
    sessions: mixedSessions,
    ordersSignal: { latestPaidOrderId: 10, latestPaidAt: '2026-11-11T03:00:00Z' },
    donationStats: { totalCents: 824, donationCount: 1 },
  });
  check('(c) reconciled response reports before/after counts separately',
    reconciled.state === 'reconciled' && reconciled.sessionCount === 3 &&
      reconciled.alreadyRecordedCount === 1 && reconciled.newlyRecordedCount === 1 &&
      reconciled.stillMissingCount === 0 && reconciled.unknownCount === 1,
    JSON.stringify(reconciled));
  check('(c) session states name newly recorded, already recorded, and unknown',
    paymentSessionStatus(mixedSessions[0]).label === 'Newly recorded' &&
      paymentSessionStatus(mixedSessions[1]).label === 'Already recorded' &&
      paymentSessionStatus(mixedSessions[2]).label === 'Not a Shop 824 checkout');
  check('(c) cents render as shop money',
    moneyFromCents(824) === '$8.24' && moneyFromCents(908) === '$9.08' &&
      moneyFromCents(null) === '—');

  const missingSession = {
    idPrefix: 'cs_live_miss', kind: 'order', amountTotalCents: 908,
    recordedBefore: false, recordedAfter: false,
  };
  const missing = summarizePaymentsDiagnostics({
    stripe: { configured: true, keyMode: 'live' },
    webhook: { configured: true },
    sessions: [missingSession],
    donationStats: { totalCents: 0, donationCount: 0 },
  });
  check('(c) a false recordedAfter remains visibly missing',
    missing.state === 'still-missing' && missing.stillMissingCount === 1 &&
      paymentSessionStatus(missingSession).label === 'Still not recorded',
    JSON.stringify(missing));

  const stripeError = summarizePaymentsDiagnostics({
    stripe: { configured: true, keyMode: 'live' },
    webhook: { configured: true },
    stripeError: { status: 401, errorCode: 'api_key_expired' },
    sessions: [],
    donationStats: { totalCents: 0, donationCount: 0 },
  });
  check('(c) Stripe error is not mistaken for a clean reconcile',
    stripeError.state === 'stripe-error' && stripeError.sessionCount === 0 &&
      stripeError.description.includes('401') &&
      stripeError.description.includes('api_key_expired'),
    JSON.stringify(stripeError));

  const unconfigured = summarizePaymentsDiagnostics({
    stripe: { configured: false, keyMode: null },
    webhook: { configured: false },
    sessions: [],
    donationStats: { totalCents: 0, donationCount: 0 },
  });
  check('(c) Stripe-not-configured has its own state',
    unconfigured.state === 'not-configured' && unconfigured.stripeConfigured === false,
    JSON.stringify(unconfigured));
}

// =====================================================================
// (d) Shipping summaries + exact USPS failure detail.
// =====================================================================
{
  const healthy = summarizeShippingDiagnostics({
    configured: true,
    tokenOk: true,
    options: [
      { service: 'ground_advantage', label: 'USPS Ground Advantage', priceCents: 931 },
      { service: 'priority_mail', label: 'USPS Priority Mail', priceCents: 1240 },
    ],
    diagnostics: [
      { stage: 'token', ok: true, httpStatus: 200, errorCode: null, message: null },
      { stage: 'rates', mailClass: 'USPS_GROUND_ADVANTAGE', ok: true, httpStatus: 200 },
    ],
  });
  check('(d) healthy shipping response is recognized',
    healthy.state === 'healthy' && healthy.tokenOk === true &&
      healthy.options.length === 2 && healthy.failedDiagnostics.length === 0,
    JSON.stringify(healthy));

  const failedDiagnostic = {
    stage: 'rates',
    mailClass: 'USPS_GROUND_ADVANTAGE',
    priceType: 'RETAIL',
    httpStatus: 403,
    errorCode: 'RATE_FORBIDDEN',
    message: 'App is not authorized for this API',
    ok: false,
  };
  const partial = summarizeShippingDiagnostics({
    configured: true,
    tokenOk: true,
    options: [{ service: 'priority_mail', label: 'USPS Priority Mail', priceCents: 1240 }],
    diagnostics: [
      { stage: 'token', ok: true, httpStatus: 200 },
      failedDiagnostic,
    ],
  });
  check('(d) one failed class + one rate is a partial verdict',
    partial.state === 'partial' && partial.failedDiagnostics.length === 1,
    JSON.stringify(partial));
  check('(d) USPS failure line preserves stage, status, code, and message',
    formatShippingDiagnostic(failedDiagnostic) ===
      'USPS Ground Advantage — retail rate: Failed · HTTP 403 · RATE_FORBIDDEN — App is not authorized for this API',
    formatShippingDiagnostic(failedDiagnostic));

  const tokenFailure = summarizeShippingDiagnostics({
    configured: true,
    tokenOk: false,
    options: [],
    diagnostics: [
      {
        stage: 'token', httpStatus: 401, errorCode: 'invalid_client',
        message: 'Client authentication failed', ok: false,
      },
    ],
    error: 'USPS token request failed (HTTP 401).',
  });
  check('(d) token failure is an error verdict with its diagnostic intact',
    tokenFailure.state === 'error' && tokenFailure.tokenOk === false &&
      tokenFailure.failedDiagnostics[0].errorCode === 'invalid_client' &&
      formatShippingDiagnostic(tokenFailure.diagnostics[0]).includes('Client authentication failed'),
    JSON.stringify(tokenFailure));

  const unconfigured = summarizeShippingDiagnostics({ configured: false });
  check('(d) USPS-not-configured makes no claim that a call ran',
    unconfigured.state === 'not-configured' && unconfigured.configured === false &&
      unconfigured.options.length === 0 && unconfigured.diagnostics.length === 0,
    JSON.stringify(unconfigured));
}

// =====================================================================
// (e) Error rendering.
// =====================================================================
{
  check('(e) 401 asks for a fresh admin sign-in',
    diagnosticErrorMessage({ status: 401 }, 'payments').includes('session has expired'));
  check('(e) 503 is identified as an unavailable configured service',
    diagnosticErrorMessage({ status: 503 }, 'shipping').includes('HTTP 503'));
  check('(e) network and bad-response failures are readable, not raw dumps',
    diagnosticErrorMessage({ code: 'network' }, 'payments').includes('could not be reached') &&
      diagnosticErrorMessage({ code: 'bad-response' }, 'shipping').includes('unreadable response'));
  check('(e) a server JSON error message is preserved',
    diagnosticErrorMessage(new Error('Diagnostics are unavailable for this account.'), 'payments') ===
      'Diagnostics are unavailable for this account.');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
