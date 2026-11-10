# Shop 824 — Inventory Tracking

Owner direction 2026-11-09. Code: `functions/api/_lib/inventory.js`
(the decrement engine), `_lib/db.js` (columns + stock writes),
`_lib/validate.js` (field parsing + the placement gate), the admin
stock endpoint, and the storefront components. Tests:
`node scripts/test-inventory.mjs` (62 checks).

## The model

**NULL = untracked.** A product's `stock_qty` is nullable, and NULL
means the product is *untracked*: it sells exactly as products always
have — no count shown, no placement limit beyond the shop-wide
per-line max of 10, no decrement. Every product that existed before
this feature stays NULL until the owner sets a count, so turning
inventory on can never strand the existing catalog.

A product becomes **tracked** the moment `stockQty` is set (at
create, at update, or via the stock endpoint). Tracked products:

- refuse orders past their count at placement
  (`"Widget" only has 2 left.`),
- show **SOLD OUT** on the storefront at 0 (Add disabled),
- show **"Only X left"** at or under their low-stock threshold,
- decrement when payment commits (below).

`low_stock_threshold` is per-product and also nullable; NULL means
the default, `DEFAULT_LOW_STOCK_THRESHOLD = 3` (one constant in
`_lib/validate.js`, mirrored by the storefront/admin).

`rowToProduct` computes `available` server-side so every client
agrees: `stockQty === null → true`, otherwise `stockQty > 0`.

**Per-size products (2026-11-10):** a product with a
`size_inventory` map (see `docs/CLOTHING.md`, "Sizes, gender &
per-size stock") is tracked PER SIZE: `stockQty` reads as the sum
of the size counts, placement gates each line against its own
size's count, and the commit decrements only the ordered size
(`stock_qty` follows as the new sum). Everything below applies to
both modes; the per-size differences are placement/commit details,
not a second engine.

## When stock moves — the two commit points

Placement is only a gate; **no stock moves when an order is placed**.
The decrement happens at the payment commit point, which differs by
payment path, deliberately:

| Path | Commit point | Why |
| --- | --- | --- |
| Stripe checkout | The `checkout.session.completed` webhook, inside the existing not-yet-paid guard | That is the moment money is confirmed. An order created but never paid (abandoned/expired session) must not consume stock. `checkout.session.expired` and `async_payment_failed` never decrement. |
| Demo card | `POST /api/orders` itself, when the created order carries demo payment | The demo flow has no webhook and never marks the order paid — placement, where the (demo) card is taken, is the only commit point that exists. |

**Idempotency:** `orders.inventory_applied` (0/1) is set when the
decrement is applied; `applyOrderInventory` no-ops when it is
already set. A Stripe webhook redelivery can never double-count.

**Floor rule:** the decrement is one atomic
`UPDATE products SET stock_qty = MAX(0, stock_qty - ?) ...`, so the
count can never go negative. Two payments racing for the last unit
can oversell by that hair — the placement gate is the real control —
and this is accepted and documented rather than papered over.

## Free shipping (per-product flag)

`freeShipping: true` on a product (create/update API field, stored
as `free_shipping` 0/1) excludes the product from the shipping
package math entirely — its weight and dimensions never enter the
parcel. A cart made **only** of free-shipping products ships for
$0: the quote returns no options, checkout shows no shipping UI,
and order placement requires no `shippingService` even when USPS is
configured. Mixed carts are weighed and priced from the remaining
items only. (Added for the owner's $0.50 buyable test product, which
must carry no shipping cost.)

## Admin stock endpoint — the restock tool

The admin dashboard's Products list is read-only by design (it now
shows each product's stock state — `Untracked` / `Sold out` /
`N in stock` + `Low`, plus a `Free shipping` tag). Stock is managed
through the API, like the products themselves:

```
PATCH /api/admin/products/:id/stock
Authorization: Bearer <admin token>
Content-Type: application/json
```

Set an absolute count:

```json
{ "stockQty": 25 }
```

Or adjust by a delta (an untracked product is treated as starting
from 0, so an adjust also starts tracking it):

```json
{ "adjustBy": -3 }
```

Exactly one of the two is required (both or neither → 400). Counts
are whole numbers 0–100000; `adjustBy` must be nonzero. The result
is floored at 0. The response is the updated product.

## Tonight's workflow (owner adding real inventory)

1. Create each real product through the product API
   (`POST /api/products`, admin token) with its real price and
   `stockQty` set to the real count — plus `weightOz` / dimensions
   for shipping, and `freeShipping: true` where it applies.
2. Restock or correct counts any time with the PATCH above.
3. The $0.50 test product: create it with `price: 0.5`,
   `stockQty: 1`, and `freeShipping: true`.

## Schema

Existing databases gain the columns lazily at runtime
(`ensureInventoryColumns` in `_lib/db.js`, the same pattern as
shipping/donations); `cloudflare/migration-inventory.sql` documents
the same ALTERs and `cloudflare/schema.sql` carries them for fresh
installs:

- `products.stock_qty INTEGER NULL`
- `products.low_stock_threshold INTEGER NULL`
- `products.free_shipping INTEGER NOT NULL DEFAULT 0`
- `orders.inventory_applied INTEGER NOT NULL DEFAULT 0`
