// Pure request + presentation helpers for the admin Diagnostics
// page (pages/AdminDiagnostics.jsx). This module deliberately has
// no React or browser dependencies: scripts/test-admin-diagnostics.mjs
// exercises the summaries in Node, while the page supplies the real
// endpoint responses and renders the same states.
//
// The field names below are the endpoints' actual contracts:
//   GET /api/admin/payments-debug
//     { stripe, webhook, stripeError?, sessions, ordersSignal,
//       donationStats, mail }
//   GET /api/shipping/debug
//     { configured:false }
//     or { configured:true, tokenOk, options, diagnostics, error? }

export const PAYMENTS_DEBUG_PATH = '/api/admin/payments-debug';
export const SHIPPING_DEBUG_PATH = '/api/shipping/debug';

/** Cents -> the shop's usual $X.XX display; missing values stay explicit. */
export function moneyFromCents(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) {
    return '—';
  }
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function paymentSessionStatus(session = {}) {
  if (session.kind === 'unknown') {
    return {
      key: 'unknown',
      label: 'Not a Shop 824 checkout',
      description:
        session.note ||
        'Stripe reported this paid session, but it does not match a donation or order in this shop.',
    };
  }
  if (session.recordedBefore === true && session.recordedAfter === true) {
    return {
      key: 'already-recorded',
      label: 'Already recorded',
      description: 'This payment was already in the shop records before the check ran.',
    };
  }
  if (session.recordedBefore === false && session.recordedAfter === true) {
    return {
      key: 'newly-recorded',
      label: 'Newly recorded',
      description: 'This check found the payment in Stripe and recorded it in the shop.',
    };
  }
  if (session.recordedAfter !== true) {
    return {
      key: 'still-missing',
      label: 'Still not recorded',
      description: 'Stripe shows this payment, but it is still missing from the shop records.',
    };
  }
  return {
    key: 'unknown-state',
    label: 'Recording status unavailable',
    description: 'The endpoint did not report a complete before-and-after recording state.',
  };
}

/**
 * Reduce one payments-debug response to the counts and headline the
 * admin needs. recordedBefore/recordedAfter come from the endpoint;
 * unknown Stripe sessions are counted separately because they are
 * not donations or orders belonging to this shop.
 */
export function summarizePaymentsDiagnostics(data = {}) {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const recognized = sessions.filter(
    (session) => session && (session.kind === 'donation' || session.kind === 'order')
  );
  const alreadyRecorded = recognized.filter(
    (session) => session.recordedBefore === true && session.recordedAfter === true
  );
  const newlyRecorded = recognized.filter(
    (session) => session.recordedBefore === false && session.recordedAfter === true
  );
  const stillMissing = recognized.filter(
    (session) => session.recordedAfter !== true
  );
  const unknown = sessions.filter((session) => session && session.kind === 'unknown');
  const stripeConfigured = Boolean(data.stripe && data.stripe.configured);
  const stripeError = data.stripeError || null;

  let state = 'already-recorded';
  let headline = 'All payments recorded — nothing missing.';
  let description =
    sessions.length === 0
      ? 'Stripe reported no paid checkout sessions in the last 3 days.'
      : 'Every matching donation and order Stripe reported is in the shop records.';

  if (!stripeConfigured) {
    state = 'not-configured';
    headline = 'Stripe is not configured.';
    description =
      'The payments check could not look for checkout sessions because Stripe is not configured for Shop 824.';
  } else if (stripeError) {
    state = 'stripe-error';
    headline = 'Stripe could not be checked.';
    description = `Stripe returned HTTP ${stripeError.status ?? '—'}${
      stripeError.errorCode ? ` (${stripeError.errorCode})` : ''
    }, so no sessions were reconciled in this check.`;
  } else if (stillMissing.length > 0) {
    state = 'still-missing';
    headline = 'Some payments are still not recorded.';
    description = `${stillMissing.length} ${plural(stillMissing.length, 'payment')} Stripe reported ${stillMissing.length === 1 ? 'is' : 'are'} still missing from the shop records.`;
  } else if (newlyRecorded.length > 0) {
    state = 'reconciled';
    headline = 'Reconcile complete.';
    description = `${newlyRecorded.length} ${plural(newlyRecorded.length, 'payment')} ${newlyRecorded.length === 1 ? 'was' : 'were'} newly recorded; the totals below now include ${newlyRecorded.length === 1 ? 'it' : 'them'}.`;
  }

  return {
    state,
    headline,
    description,
    sessions,
    sessionCount: sessions.length,
    alreadyRecordedCount: alreadyRecorded.length,
    newlyRecordedCount: newlyRecorded.length,
    stillMissingCount: stillMissing.length,
    unknownCount: unknown.length,
    stripeConfigured,
    stripeKeyMode: data.stripe ? data.stripe.keyMode : null,
    webhookConfigured: Boolean(data.webhook && data.webhook.configured),
    stripeError,
    donationTotalCents:
      data.donationStats && Number.isFinite(Number(data.donationStats.totalCents))
        ? Number(data.donationStats.totalCents)
        : null,
    donationCount:
      data.donationStats && Number.isFinite(Number(data.donationStats.donationCount))
        ? Number(data.donationStats.donationCount)
        : null,
    ordersSignal: data.ordersSignal || { latestPaidOrderId: null, latestPaidAt: null },
    mail: data.mail || null,
  };
}

const MAIL_CLASS_LABELS = {
  USPS_GROUND_ADVANTAGE: 'USPS Ground Advantage',
  PRIORITY_MAIL: 'USPS Priority Mail',
};

export function shippingDiagnosticLabel(diagnostic = {}) {
  const service = MAIL_CLASS_LABELS[diagnostic.mailClass] || diagnostic.mailClass;
  if (diagnostic.stage === 'token') return 'USPS token request';
  if (diagnostic.stage === 'rates-commercial-fallback') {
    return `${service || 'USPS'} — commercial-rate check`;
  }
  if (diagnostic.stage === 'rates') {
    return `${service || 'USPS'} — ${diagnostic.priceType ? `${diagnostic.priceType.toLowerCase()} rate` : 'rate'}`;
  }
  return diagnostic.stage || 'USPS check';
}

/** One USPS diagnostics entry as a single readable line. */
export function formatShippingDiagnostic(diagnostic = {}) {
  const status =
    diagnostic.httpStatus === null || diagnostic.httpStatus === undefined
      ? 'no HTTP status'
      : `HTTP ${diagnostic.httpStatus}`;
  const outcome = diagnostic.ok ? 'OK' : 'Failed';
  const code = diagnostic.errorCode ? ` · ${diagnostic.errorCode}` : '';
  const message = diagnostic.message ? ` — ${diagnostic.message}` : '';
  return `${shippingDiagnosticLabel(diagnostic)}: ${outcome} · ${status}${code}${message}`;
}

/**
 * Reduce one shipping-debug response to its verdict. Three distinct
 * outcomes matter to the owner: not configured, USPS refused/failed
 * (with its own diagnostics), or only some services answered.
 */
export function summarizeShippingDiagnostics(data = {}) {
  if (!data || data.configured !== true) {
    return {
      state: 'not-configured',
      headline: 'USPS live rates are not configured.',
      description:
        'The check made no USPS call. Add the USPS client ID, client secret, and origin ZIP in the runtime settings, then run it again.',
      configured: false,
      tokenOk: false,
      options: [],
      diagnostics: [],
      failedDiagnostics: [],
      error: null,
    };
  }

  const options = Array.isArray(data.options) ? data.options : [];
  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
  const failedDiagnostics = diagnostics.filter((entry) => entry && entry.ok !== true);
  let state = 'healthy';
  let headline = 'USPS live rates are working.';
  let description = `${options.length} live ${plural(options.length, 'rate')} came back for the test shipment.`;

  if (data.error) {
    state = 'error';
    headline = 'USPS did not return live rates.';
    description = data.error;
  } else if (options.length === 0) {
    state = 'error';
    headline = 'USPS returned no live rates.';
    description = 'No usable rate came back for the test shipment. The call details below show what USPS answered.';
  } else if (failedDiagnostics.length > 0) {
    state = 'partial';
    headline = 'Some USPS rates are working.';
    description = `${options.length} live ${plural(options.length, 'rate')} came back, but ${failedDiagnostics.length} ${plural(failedDiagnostics.length, 'call')} failed. The details below show what USPS answered.`;
  }

  return {
    state,
    headline,
    description,
    configured: true,
    tokenOk: Boolean(data.tokenOk),
    options,
    diagnostics,
    failedDiagnostics,
    error: data.error || null,
  };
}

/** A thrown adminApi error as a message an owner can act on. */
export function diagnosticErrorMessage(err, surface = 'diagnostics') {
  const label = surface === 'payments' ? 'payments' : surface === 'shipping' ? 'shipping' : surface;
  if (err && err.status === 401) {
    return 'Your admin session has expired. Sign in again to run diagnostics.';
  }
  if (err && err.status === 503) {
    return `The ${label} diagnostics service is not available right now (HTTP 503). Check its configuration and try again.`;
  }
  if (err && err.code === 'network') {
    return `The ${label} diagnostics service could not be reached. Check the connection and try again.`;
  }
  if (err && err.code === 'bad-response') {
    return `The ${label} diagnostics service returned an unreadable response. Try again in a moment.`;
  }
  if (err && err.message) return err.message;
  return `Could not run the ${label} check. Please try again.`;
}
