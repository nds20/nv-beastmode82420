// POST /api/stripe/webhook — Stripe's server-to-server payment events.
//
// The Stripe-Signature header is verified against the RAW request body
// with STRIPE_WEBHOOK_SECRET (see _lib/stripe.js) before anything is
// parsed or trusted; a bad signature is a 400 and changes nothing.
//
// Handled events (order payment lifecycle — the admin Orders tab shows
// the result):
//   checkout.session.completed        -> handled by the shared
//                                        applyCompletedCheckoutSession
//                                        below (exported for the admin
//                                        payments diagnostic, which
//                                        replays what Stripe holds
//                                        through this same code —
//                                        docs/PAYMENTS_DEBUG.md):
//                                        paymentStatus 'paid', the
//                                        payment intent id, AND the
//                                        order's stock decrement (the
//                                        payment commit point for
//                                        inventory — _lib/inventory.js;
//                                        idempotent via the order's
//                                        inventory_applied flag, so
//                                        redeliveries never double-count)
//   checkout.session.expired          -> a 'pending' order returns to
//                                        'unpaid' (the buyer can retry);
//                                        a paid order is never downgraded
//   checkout.session.async_payment_failed -> 'payment_failed'
// Donation sessions (metadata.kind === 'donation', created by
// /api/donate/checkout) are recorded into the `donations` table on
// checkout.session.completed and never enter the order flow below —
// the two kinds share this endpoint but nothing else. Anything else
// is acknowledged (200) and ignored, so Stripe does not retry events
// we do not use. Handling is idempotent: Stripe retries deliveries,
// and re-applying an event leaves the order (or donation) in the same
// state. Orders are matched by their stored Checkout Session id, with
// the session metadata's order_id as a fallback.

import { handle, json, fail } from '../_lib/http.js';
import {
  getOrder,
  updateOrderPayment,
  findOrderByStripeSessionId,
  markOfferPaidByOrderId,
} from '../_lib/db.js';
import { recordDonation } from '../_lib/donations.js';
import { applyOrderInventory } from '../_lib/inventory.js';
import { sendOrderPaidEmail } from '../_lib/mail.js';
import { stripeWebhookConfigured, verifyWebhookSignature } from '../_lib/stripe.js';

async function orderForSession(env, session) {
  const bySession = await findOrderByStripeSessionId(env, session.id);
  if (bySession) return bySession;
  const orderId = session.metadata && session.metadata.order_id
    ? session.metadata.order_id
    : session.client_reference_id;
  return orderId ? getOrder(env, orderId) : null;
}

/**
 * Handle a VERIFIED checkout.session.completed event's session —
 * the single recording path for completed payments, shared by the
 * webhook route below and the admin payments diagnostic
 * (docs/PAYMENTS_DEBUG.md), which replays the sessions Stripe holds
 * through this exact code when a webhook delivery never landed.
 * One code path, two callers: any fix here fixes both.
 *
 * Donation sessions (metadata.kind === 'donation') are recorded into
 * the donations table and NEVER enter the order flow. Order sessions
 * are matched by their stored Checkout Session id, with the session
 * metadata's order_id (then client_reference_id) as a fallback, and
 * — inside the same not-yet-paid guard the webhook has always used —
 * are stamped paid, decremented (the inventory commit point), their
 * offer flipped if any, and the admin PAID email attempted
 * (best-effort). Every step is idempotent, so redeliveries and
 * diagnostic replays leave the world in the same state.
 *
 * Returns a small outcome summary for the diagnostic's reporting:
 *   { kind: 'donation', recorded } |
 *   { kind: 'order', orderId, recorded } |
 *   { kind: 'unknown' }   (no matching order in the db)
 * The webhook ignores the return value — its response contract is
 * unchanged ({ received: true }).
 */
export async function applyCompletedCheckoutSession(env, session) {
  // A donation session is recorded and done — it has no order, and
  // the order lookups below must never see it.
  if (session.metadata && session.metadata.kind === 'donation') {
    const recorded = await recordDonation(env, session);
    return { kind: 'donation', recorded };
  }
  const order = await orderForSession(env, session);
  if (!order) return { kind: 'unknown', recorded: false };
  if (order.paymentStatus === 'paid') {
    return { kind: 'order', orderId: order.id, recorded: false };
  }
  await updateOrderPayment(env, order.id, {
    paymentStatus: 'paid',
    stripeSessionId: session.id || order.stripeSessionId,
    stripePaymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : order.stripePaymentIntentId,
  });
  // Payment confirmed = the inventory commit point for Stripe
  // orders. Inside this same not-yet-paid guard, and itself
  // idempotent (inventory_applied), so webhook retries are safe.
  await applyOrderInventory(env, order);
  // Best Offer (2026-11-10): if this order came from an accepted
  // offer, the offer is now paid too. Guarded to offers still in
  // 'accepted' and a no-op for ordinary orders (docs/OFFERS.md).
  await markOfferPaidByOrderId(env, order.id);
  // Email (2026-11-10, docs/EMAIL.md): the admin's PAID alert
  // fires at this same commit point — inside the not-yet-paid
  // guard, so a redelivered event never double-sends. The order
  // copy carries its fresh 'paid' status (the row above was just
  // stamped). Best-effort: mail can never fail the webhook.
  // Donation sessions returned earlier and never reach here.
  await sendOrderPaidEmail(env, { ...order, paymentStatus: 'paid' });
  return { kind: 'order', orderId: order.id, recorded: true };
}

export const onRequestPost = handle(async ({ request, env }) => {
  if (!stripeWebhookConfigured(env)) {
    fail(503, 'Stripe webhook is not configured (STRIPE_WEBHOOK_SECRET is not set).');
  }
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature') || '';
  const valid = await verifyWebhookSignature(env.STRIPE_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) fail(400, 'Invalid Stripe signature.');

  const event = JSON.parse(rawBody);
  const session = (event.data && event.data.object) || {};

  if (event.type === 'checkout.session.completed') {
    // The recording itself lives in applyCompletedCheckoutSession
    // above (shared with the payments diagnostic) — behavior here
    // is unchanged: donations recorded, orders stamped paid, and
    // anything unmatched simply acknowledged.
    await applyCompletedCheckoutSession(env, session);
  } else if (event.type === 'checkout.session.expired') {
    const order = await orderForSession(env, session);
    if (order && order.paymentStatus === 'pending') {
      await updateOrderPayment(env, order.id, { paymentStatus: 'unpaid' });
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    const order = await orderForSession(env, session);
    if (order && order.paymentStatus !== 'paid') {
      await updateOrderPayment(env, order.id, { paymentStatus: 'payment_failed' });
    }
  }

  return json({ received: true });
});
