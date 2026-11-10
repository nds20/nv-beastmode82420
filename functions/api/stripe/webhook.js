// POST /api/stripe/webhook — Stripe's server-to-server payment events.
//
// The Stripe-Signature header is verified against the RAW request body
// with STRIPE_WEBHOOK_SECRET (see _lib/stripe.js) before anything is
// parsed or trusted; a bad signature is a 400 and changes nothing.
//
// Handled events (order payment lifecycle — the admin Orders tab shows
// the result):
//   checkout.session.completed        -> paymentStatus 'paid', recording
//                                        the payment intent id, AND the
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
    // A donation session is recorded and done — it has no order, and
    // the order lookups below must never see it.
    if (session.metadata && session.metadata.kind === 'donation') {
      await recordDonation(env, session);
      return json({ received: true });
    }
    const order = await orderForSession(env, session);
    if (order && order.paymentStatus !== 'paid') {
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
    }
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
