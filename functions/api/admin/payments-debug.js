// GET /api/admin/payments-debug — ADMIN-ONLY payments diagnostic +
// reconcile (2026-11-10, docs/PAYMENTS_DEBUG.md). Built for the night
// Stripe collected two real payments (an $8.24 donation and a $9.08
// shop purchase) that never appeared in the shop's own records: this
// endpoint reports the FACTS about the Stripe, webhook and mail
// wiring, and — in the same call — RECONCILES what it finds, by
// replaying every recent PAID Checkout Session Stripe holds through
// the webhook's own completed-session handler
// (applyCompletedCheckoutSession). One code path, two callers: if a
// webhook delivery never landed, the records are whole again after
// one hit, and recordedBefore -> recordedAfter in the response says
// exactly which sessions needed it.
//
// Response shape:
//   {
//     stripe:  { configured, keyMode },   // keyMode from the
//             STRIPE_SECRET_KEY PREFIX only ('live'|'test'|'unknown'
//             |null) — the value never leaves the server
//     webhook: { configured },           // STRIPE_WEBHOOK_SECRET set?
//     stripeError?: { status, errorCode },  // only when the Stripe
//             list call failed; sessions is [] then
//     sessions: [ { idPrefix, kind, amountTotalCents, currency,
//             paymentStatus, sessionStatus, created,
//             recordedBefore, recordedAfter, note? } ],
//             // paid sessions from the last 3 days; idPrefix is the
//             // first 12 chars of the session id — enough to find
//             // the session in the Stripe dashboard, never the full
//             // id. kind 'unknown' = no matching order/donation in
//             // this app's records (note explains).
//     ordersSignal:  { latestPaidOrderId, latestPaidAt },  // AFTER
//             // any reconcile — getLatestPaidOrder, the same helper
//             // behind GET /api/orders/signal
//     donationStats: { totalCents, donationCount },        // AFTER
//             // any reconcile — getDonationStats
//     mail: { configured, missing, token: { ok, status, errorCode } }
//             // token = the refresh-token exchange exercised WITHOUT
//             // sending (diagnoseMailToken); 'not_configured' when
//             // the GOOGLE_OAUTH_* vars are unset
//   }
//
// SECRECY: the response carries only booleans, the key MODE, HTTP
// statuses, error CODES, session id prefixes, amounts and timestamps
// — never a secret value, a token, or a raw Stripe/Google body
// (test-asserted in scripts/test-payments-debug.mjs). Admin-gated
// with requireAdmin like every other /api/admin surface (401 without
// a valid admin bearer token). Each hit costs ONE Stripe list call.

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import {
  stripeConfigured,
  stripeWebhookConfigured,
  stripeKeyMode,
  listCheckoutSessions,
} from '../_lib/stripe.js';
import {
  getOrder,
  findOrderByStripeSessionId,
  getLatestPaidOrder,
} from '../_lib/db.js';
import { getDonationStats, donationRecorded } from '../_lib/donations.js';
import { mailConfigStatus, mailConfigured, diagnoseMailToken } from '../_lib/mail.js';
import { applyCompletedCheckoutSession } from '../stripe/webhook.js';

const THREE_DAYS_SECONDS = 3 * 24 * 60 * 60;

/**
 * Resolve a Stripe session to the order it belongs to — the same
 * two-step lookup the webhook's orderForSession performs (stored
 * session id first, then metadata.order_id / client_reference_id).
 * Used for classification and recordedBefore probing only; the
 * reconcile itself re-resolves inside the shared handler.
 */
async function resolveOrder(env, session) {
  const bySession = await findOrderByStripeSessionId(env, session.id);
  if (bySession) return bySession;
  const orderId = session.metadata && session.metadata.order_id
    ? session.metadata.order_id
    : session.client_reference_id;
  return orderId ? getOrder(env, orderId) : null;
}

/** The local recording state of one session, before/after reconcile. */
async function recordedState(env, session, kind, order) {
  if (kind === 'donation') return donationRecorded(env, session.id);
  if (kind === 'order') {
    const fresh = order ? await getOrder(env, order.id) : null;
    return fresh ? fresh.paymentStatus === 'paid' : false;
  }
  return null;
}

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  const { env } = context;

  const report = {
    stripe: {
      configured: stripeConfigured(env),
      keyMode: stripeKeyMode(env),
    },
    webhook: { configured: stripeWebhookConfigured(env) },
    sessions: [],
  };

  if (report.stripe.configured) {
    const listed = await listCheckoutSessions(env, { limit: 25 });
    if (!listed.ok) {
      report.stripeError = { status: listed.status, errorCode: listed.errorCode };
    } else {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const paid = listed.sessions.filter(
        (s) =>
          s &&
          s.payment_status === 'paid' &&
          Number.isFinite(Number(s.created)) &&
          Number(s.created) >= nowSeconds - THREE_DAYS_SECONDS
      );
      for (const session of paid) {
        // eslint-disable-next-line no-await-in-loop
        report.sessions.push(await describeSession(env, session));
      }
    }
  }

  // Post-reconcile aggregates: the same helpers the public signal
  // and stats endpoints read, so what this endpoint reports is
  // exactly what the world sees once the reconcile has run.
  report.ordersSignal = await getLatestPaidOrder(env);
  report.donationStats = await getDonationStats(env);

  const mailStatus = mailConfigStatus(env);
  report.mail = {
    configured: mailStatus.configured,
    missing: mailStatus.missing,
    token: mailConfigured(env)
      ? await diagnoseMailToken(env)
      : { ok: false, status: null, errorCode: 'not_configured' },
  };

  return json(report);
});

/**
 * Classify one paid session, snapshot its local recording state,
 * replay it through the webhook's shared handler, and snapshot the
 * state again. Classification mirrors the handler's own: metadata
 * kind 'donation' first, then the order lookup.
 */
async function describeSession(env, session) {
  const isDonation = Boolean(session.metadata && session.metadata.kind === 'donation');
  const order = isDonation ? null : await resolveOrder(env, session);
  const kind = isDonation ? 'donation' : order ? 'order' : 'unknown';

  const entry = {
    idPrefix: String(session.id || '').slice(0, 12),
    kind,
    amountTotalCents:
      session.amount_total === null || session.amount_total === undefined
        ? null
        : Number(session.amount_total),
    currency: session.currency || null,
    paymentStatus: session.payment_status || null,
    sessionStatus: session.status || null,
    created: Number.isFinite(Number(session.created)) ? Number(session.created) : null,
    recordedBefore: await recordedState(env, session, kind, order),
    recordedAfter: null,
    ...(kind === 'unknown' ? { note: 'no matching order in db' } : {}),
  };

  // The reconcile: THE production handler, not a copy of it. The
  // donation branch records via INSERT OR IGNORE; the order branch
  // runs inside its not-yet-paid guard (stamp paid, decrement via
  // the inventory_applied flag, offer flip, paid-email attempt), so
  // replaying a session that already recorded is a no-op — and an
  // 'unknown' session changes nothing at all.
  await applyCompletedCheckoutSession(env, session);
  entry.recordedAfter = await recordedState(
    env,
    session,
    kind,
    kind === 'order' ? await getOrder(env, order.id) : order
  );
  return entry;
}
