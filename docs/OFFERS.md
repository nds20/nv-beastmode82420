# Best Offer — make-an-offer for Shop 824

Owner direction (2026-11-10): *"Give people the option to buy
something at best offer. And I can accept the offer if I want to.
Kind of like Poshmark… and if it's a new item make it so they can't
make an offer on a new item — it just has to be at that price."*

Buyers offer below list price on eligible products; any shop admin
accepts or declines; an accepted offer's buyer completes the
purchase at the offered price. This document is the model; the
code lives in `functions/api/_lib/offers.js` (validation, buyer
views, totals), `functions/api/_lib/db.js` (product fields + offers
CRUD), the six routes under `functions/api/offers*` and
`functions/api/admin/offers*`, and the buyer/admin surfaces named
below. Tests: `scripts/test-offers.mjs` (91 checks).

## The product side: condition + accepts_offers

Two nullable columns on `products` (lazy-added by
`ensureOffersColumns()`, in `cloudflare/schema.sql`, documented
migration `cloudflare/migration-offers.sql`):

- `condition` TEXT — `'new'` | `'used'` | NULL (unspecified). The
  shop disclosure treats unspecified clothes as used.
- `accepts_offers` INTEGER — `1` on, `0` off, NULL = no explicit
  choice.

What buyers see is the COMPUTED `acceptsOffers` boolean
(`productAcceptsOffers()` in `db.js`, exposed by `rowToProduct`):

1. **`condition = 'new'` → always `false`**, whatever the stored
   flag says. THE NEW RULE: new items sell at list price only.
2. A stored flag wins next: `1` → true, `0` → false (the owner
   unchecked the box for this one item).
3. Flag NULL → **default ON when the product has a price**
   (`price > 0`), OFF when the price is TBD.

Rule 3 is the existing-catalog rule the owner confirmed on day one:
every product that already existed (condition NULL, flag NULL)
**automatically became offer-eligible** when this shipped — no
data migration, no admin pass over the catalog. The only ways an
item doesn't take offers are being marked NEW, being explicitly
switched off, being unpriced, or being sold out (offers also
require availability at create time).

The product editor carries both fields ("Condition & offers"): a
Condition select (Used / New — new listings default to Used, an
unspecified existing condition reads as Used) and an "Accept
offers" checkbox that is shown/enabled only when Condition isn't
New; with New selected it disables beside the note *"New items
sell at list price — no offers."* Saving writes the editor's
explicit choice (the form starts from the product's computed
state, so what the admin sees is what buyers get).

## The offer lifecycle

One `offers` row per offer (created lazily by
`ensureOffersTable()`; also in `schema.sql`):

```
pending ──accept──> accepted ──buyer pays──> paid
   │                    │
   ├──decline──> declined
   └──72h pass──> expired        (lazy: flipped on read, no cron)
```

- **pending** — created by `POST /api/offers`. Moves no stock, no
  money. Expires 72 hours after creation (`expires_at`); any read
  path (buyer status, admin list/accept/decline) flips a past-due
  pending offer to `expired` on sight.
- **accepted** — the seller's decision ONLY. Accepting creates **no
  order**, decrements **no stock**, charges **nothing**. Guards at
  accept: still pending and inside the window (past-due → expired +
  409), product still exists, and a TRACKED product that has sold
  out since the offer was made → 409 *"Sold out since the offer was
  made."*
- **paid** — set when the order the buyer minted at pay time is
  actually paid (see below).
- **declined / expired** — terminal; the buyer can always make a
  fresh offer.

## How paying works (buyer-completes-at-pay)

The chosen design (over minting an order at accept time): an offer
carries no delivery address, so shipping can't be quoted until the
buyer checks out. Accept therefore stores nothing; instead the
BUYER completes the purchase:

`POST /api/offers/:id/pay` (offer token in the body) runs the
**real order path** — `normalizeOrder` + `createOrder`, the exact
internals of `POST /api/orders` — with a single item (qty 1, the
offer's size) and one override: the product's price is replaced,
for that call only, by the **stored offer amount**. The override
comes from the offers row, never from the request body, so no
client can name its own price at pay time. Everything else is the
shop's standing math, unchanged:

- **Subtotal** = the offered price.
- **Tax** = 10.2% (`TAX_RATE`) on the offered subtotal only.
- **Shipping** = re-quoted server-side with the buyer's ZIP via
  `quoteShipping` — free-shipping products ship $0, an unknown
  `shippingService` is the same 400 as a normal order, and the
  stock gate runs too (qty 1 > stock 0 fails placement naming
  availability).
- **Payment** = exactly a normal order's two paths. Demo card in
  the body → placement is the commit point: `applyOrderInventory`
  runs and the offer flips to `paid` immediately. (The ORDER's own
  `paymentStatus` keeps the demo path's standing semantics — it is
  not marked paid; only the offer flips. See `orders.js`.) No
  payment (Stripe) → the order returns unpaid with its own access
  token, the buyer continues to `POST /api/orders/:id/checkout`
  as usual, and the Stripe webhook flips the offer to `paid` via
  `markOfferPaidByOrderId` inside the same commit block where
  inventory applies — a no-op for ordinary orders.

`offer_cents` is **integer cents** (the `shipping_cents`
precedent); every other money figure on the resulting order is the
order system's normal dollar math on the offered price.

## Double-accept semantics

Two pending offers on the same single-stock item may BOTH be
accepted — that's the seller's prerogative, and accept moves no
stock, so nothing is oversold at decision time. The stock gate
lives at pay: **first payer wins**; the second payer's pay attempt
fails placement with the order system's availability message, and
their offer stays `accepted` (unpaid, no order) — the seller can
restock and the buyer can retry, or the offer simply ages. This is
deliberate: it keeps every inventory rule in the one commit path
orders already use instead of inventing offer reservations.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/offers` | public | Create a pending offer. Body: `{productId, size?, offerAmount, name, email, phone?, note?}` → 201 buyer view **with `accessToken`**. |
| `GET /api/offers/:id/status?token=` | offer token | Buyer status: `{status, productName, productId, size, offerAmount, orderId, message}`. (`productId`/`size` ride along so the status page can quote shipping and build the pay form.) |
| `POST /api/offers/:id/pay` | offer token (body) | Accepted-only purchase at the stored offer price → 201 the created order (normal order shape, its own `accessToken` included). |
| `GET /api/admin/offers` | admin | Inbox: pending first, newest first; product name + CURRENT list price joined; per-offer **would-be totals** (tax on the offer; shipping `$0 / "Free shipping"` for free-shipping products, otherwise `null / "USPS rate at payment"` — no destination ZIP exists pre-acceptance, so USPS is never called here); counts by status. |
| `POST /api/admin/offers/:id/accept` | admin | Pending → accepted (+ `decided_at`). |
| `POST /api/admin/offers/:id/decline` | admin | Pending → declined (+ `decided_at`). |

Create-offer validations (in order): product exists → accepts
offers → available → price set → size rules (required and in the
run when the product has sizes; must be absent for one-size) →
amount (> 0, ≤ 2 decimals, **below** list price — at or above
list → 400 *"That's the list price — just add it to your cart."*)
→ name ≥ 2 chars → email shape → note ≤ 500 chars.

## Notifications

Email arrived 2026-11-10 (see `docs/EMAIL.md`): a new offer now
emails the admin immediately. Buyers still are not emailed about
offers — the status link remains their channel:

- **Buyers** get a status link, `/shop/offer/:id?token=…`, shown on
  the success panel ("Offer sent! The seller has 72 hours to
  respond."). The token is also saved on the device that sent the
  offer (`localStorage` key `shop824_offer_<id>`), so reopening
  `/shop/offer/:id` on that device just works. Losing both means
  the offer is unrecoverable — acceptable for v1, stated plainly
  on the page.
- **Sellers** work the admin dashboard's **Offers** section (any
  admin, not owner-gated): product, list vs offer, size, buyer
  name/email/phone, note, status pill, would-be totals, order #
  once paid, and Accept (with a confirm naming product + amount) /
  Decline buttons.

Buyer surfaces: product cards wear an "or Best Offer" tag under
the price (`acceptsOffers && available && priced`); the product
page grows an "or Make an Offer" button + form beside Add to Cart
(size taken from the page's size picker, required exactly like
Add); the shop disclosure's second line states the policy ("NEW
items are priced as listed — no offers. Most used items are BEST
OFFER: make an offer and the seller decides." — see
docs/CLOTHING.md).

## Tests

`scripts/test-offers.mjs` — 91 checks: lazy ensure onto a
pre-offers schema, the `acceptsOffers` truth table (including the
existing-style NULL/NULL row → ON), every create validation, token
gating + lazy expiry, admin list math and ordering, accept/decline
guards (sold-out-since, expired, product-gone), demo pay, USPS
re-quote pay + free-shipping pay, Stripe-pending pay + webhook
flip (incl. redelivery), the double-accept race, and static wiring
(route table, schema, disclosure copy). All other suites stay
green (581 checks total across 12 suites); the three amendments
made to older suites are recorded in their files (shipping's
legacy-ALTER filter now also excludes the two offers columns; the
inventory and order-signal stubs model the offers table as
existing-but-empty, as real D1 looks after the lazy ensure).
