// GET /api/orders/signal — the public, privacy-safe "a sale happened"
// signal behind the owner's purchase alerts (docs/ORDER_ALERTS.md).
//
// Returns exactly two fields:
//   { latestPaidOrderId: <int|null>, latestPaidAt: <ISO|null> }
// — the highest order id whose paymentStatus is 'paid' (stamped by
// the Stripe webhook on checkout.session.completed) and that order's
// creation timestamp. Deliberately NOTHING else: no customer data, no
// totals, no items, no counts. Order ids are already sequential
// integers and per-order reads still require the order's secret
// access token, so the max paid id alone reveals nothing actionable —
// it exists so an unauthenticated poller (the alert hook, which holds
// no secrets) can notice "a new paid order exists since last check".
//
// Paid-only by design: unpaid/'pending' orders are abandoned or
// in-flight checkouts and must never trip the alert.

import { handle, json } from '../_lib/http.js';
import { getLatestPaidOrder } from '../_lib/db.js';

export const onRequestGet = handle(async ({ env }) => json(await getLatestPaidOrder(env)));
