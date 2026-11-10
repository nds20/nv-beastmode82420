# Order alerts — how Nicholas hears about a sale

Owner direction, 2026-11-09: *"Can you send me an alert whenever
anybody purchases the test product please?"*

The alert is **poll-based**: a Muse hook wakes every few minutes,
reads two public signals (the hook holds **no secrets** — it can only
curl public endpoints), and messages Nicholas when something changed.
This document is the shop-side half: the two signals the hook reads,
why they exist, and how the whole loop fits together.

## The two signals

### 1. The canary order (keeps the watch warm + proves checkout works)

Every ~3 hours the hook places one real order through the real API —
a **direct `POST /api/orders` with the demo-card payload**:

```json
{
  "items": [{ "productId": 1, "qty": 1 }],
  "customer": {
    "fullName": "Muse Alert Canary",
    "phone": "5855550100",
    "address": "824 Canary Way",
    "city": "Rochester",
    "zip": "14617",
    "notes": "Automated purchase-alert canary — not a real customer."
  },
  "payment": { "cardNumber": "4242424242424242" }
}
```

(`productId` = the $8.24 test item — the first product in the shop;
the hook reads `GET /api/products` to find it rather than assuming.)

Why this works, and why it needs **no special code**: `orders.js`
applies no Stripe gate to the card path. `normalizeOrder` reduces any
submitted card number to `payment = { method: 'card', last4 }` — only
the last four digits ever persist, the full number is stored nowhere —
and placement returns the full created order, **including its secret
per-order `accessToken`**, to the caller (201). That holds even while
Stripe is fully configured: the storefront *page* hides its demo-card
form when `stripeEnabled` is true, but the API path itself is
unchanged (proven by `scripts/test-order-signal.mjs` §a, which places
the order with `STRIPE_SECRET_KEY` set in env). No production code was
changed for the canary.

The hook remembers the canary's `id` + `accessToken` and re-reads it
through the token-gated `GET /api/orders/:id/status?token=…`. A new
canary order appearing (and reading back healthy) is itself an alert
event — and a canary that *fails* to place or read back is an alert
of a different kind: checkout is broken, which the owner wants to
know just as much.

**Recognizing the canary:** in the admin Orders tab it is the order
from **"Muse Alert Canary"**, Rochester NY 14617, phone
585-555-0100, card `····4242`, for one $8.24 Test Item, roughly every
3 hours. It is a demo-card order: no money moves, and nothing ships.
It is *not* a real customer — ignore it for fulfillment; it's the
watch proving it can still see.

### 2. The paid-order signal (catches REAL sales between canaries)

```
GET /api/orders/signal
→ { "latestPaidOrderId": 17, "latestPaidAt": "2026-11-09T23:41:07.123Z" }
→ { "latestPaidOrderId": null, "latestPaidAt": null }   // no sale yet
```

- `latestPaidOrderId` — the highest order id whose `paymentStatus`
  is `'paid'` (the state the Stripe webhook stamps on
  `checkout.session.completed`; see `functions/api/stripe/webhook.js`).
- `latestPaidAt` — that order's `created_at`. Orders carry no
  separate paid-at column; checkout completes seconds after
  placement, so the creation time is the sale time for alert
  purposes.

The hook compares the id against the last one it saw; a higher id =
a new real sale = alert Nicholas. The query lives in
`functions/api/_lib/db.js` (`getLatestPaidOrder`); the handler is
`functions/api/orders/signal.js`, registered in `worker/index.js`.

**Paid-only is the rule.** Unpaid and `pending` orders are abandoned
or in-flight checkouts — they appear constantly and complete rarely.
A watch that fired on them would cry wolf on every abandoned cart, so
the signal ignores them entirely (`test-order-signal.mjs` §c/§e).

**Privacy note.** The endpoint is unauthenticated on purpose — the
hook has no credentials to give it — so it returns *exactly* those
two fields: no customer data, no totals, no items, no counts. Order
ids are already sequential integers, and reading any actual order
still requires its secret per-order access token, so the max paid id
+ its timestamp leaks nothing actionable. It is the same posture as
`GET /api/donate/stats` (public aggregate, rows never exposed).

## Turning it off

Disable the hook (`shop-sale-alert`) in Muse's hook settings. The
canary orders stop immediately; nothing else changes — the signal
endpoint stays (it is inert data unless someone polls it). To remove
the endpoint itself, delete `functions/api/orders/signal.js`, its
route + import in `worker/index.js`, and `getLatestPaidOrder` in
`functions/api/_lib/db.js`.

## Tests

`scripts/test-order-signal.mjs` (plain node, in-memory D1 stub):
§a the canary proof (demo-card order + accessToken + last4-only, with
Stripe configured; status endpoint accepts the token, rejects a wrong
one), §b empty-DB nulls + the exact two-field shape, §c/§e unpaid
orders never move the signal, §d the paid-marking moves it — via
`updateOrderPayment` (the write the webhook performs) and via the
real signed webhook handler end-to-end, §f a second paid order
advances it and back-fills never move it backward, §g direct
`getLatestPaidOrder` coverage.

---

**Update 2026-11-10:** the shop now also sends real email — order
confirmations to customers and new-order / new-offer / PAID alerts
to the admin — via the Gmail API (see `docs/EMAIL.md`). Email is
the always-on channel; this hook remains the test-item canary and
checkout watchdog.
