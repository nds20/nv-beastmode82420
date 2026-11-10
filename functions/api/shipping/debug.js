// GET /api/shipping/debug — ADMIN-ONLY USPS live-rate diagnostics
// (2026-11-10). Runs ONE live quote attempt for a canonical parcel
// (shop origin ZIP -> 90210, 1 lb, 12 x 9 x 6 in) calling
// _lib/usps.js quoteUspsRates DIRECTLY — bypassing the shipping.js
// flat-rate fallback, which would mask exactly the failure this
// endpoint exists to explain — and returns what USPS actually said:
//
//   { configured: false }
//     — any of USPS_CLIENT_ID / USPS_CLIENT_SECRET / USPS_ORIGIN_ZIP
//       is missing; nothing was called.
//   { configured: true, tokenOk, options, diagnostics, error? }
//     — diagnostics holds one entry per USPS call (token, then one
//       per mail class): HTTP status, parsed USPS error code +
//       trimmed message, ok flag. If the Ground Advantage RETAIL
//       call fails, the class is ALSO probed at priceType
//       'COMMERCIAL' (stage 'rates-commercial-fallback') so an
//       account that must quote commercial rates is visible here.
//       Production quoting stays RETAIL-only regardless.
//
// The response contains only statuses, error codes and prices —
// never credential values, tokens, or raw USPS bodies. Admin-gated
// with requireAdmin like every other /api/admin surface (401 without
// a valid admin bearer token). Each hit costs at most 3 USPS calls
// against the ~60/hour Prices quota — a diagnostic tool, not a
// health check to poll.

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { uspsConfigured, quoteUspsRates } from '../_lib/usps.js';

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  const { env } = context;
  if (!uspsConfigured(env)) return json({ configured: false });

  const diagnostics = [];
  let options = [];
  let error = null;
  try {
    const result = await quoteUspsRates(
      env,
      { destZip: '90210', weightLb: 1, length: 12, width: 9, height: 6 },
      { diagnostics, commercialFallback: true }
    );
    options = result.options;
  } catch (err) {
    error = (err && err.message) || 'USPS quote failed';
    // The token-failure path throws from inside getUspsToken: the
    // entries were already pushed into `diagnostics`, but if a
    // future throw path ever bypasses the shared array, fall back to
    // the copy attached to the error.
    if (diagnostics.length === 0 && err && Array.isArray(err.diagnostics)) {
      diagnostics.push(...err.diagnostics);
    }
  }

  const tokenEntry = diagnostics.find((d) => d.stage === 'token');
  return json({
    configured: true,
    tokenOk: Boolean(tokenEntry && tokenEntry.ok),
    options,
    diagnostics,
    ...(error ? { error } : {}),
  });
});
