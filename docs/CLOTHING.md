# Shop 824 — the clothing store model

Owner direction, 2026-11-09: *"We're no longer selling weed we're
selling clothes"* — and, the same evening, *"we can also sell
perfumes and deodorant and colognes and things like that as well."*

Shop 824 is now a clothing store with fragrance & body care. This
document is the model: categories, the product fields, sizes and
stock, browsing, and what retired.

## Categories

The category carries the kind of product now (the old free-text
`type` no longer does). `CATEGORIES` in
`functions/api/_lib/validate.js` — the API rejects anything else:

| id           | Chip / label | Department  |
| ------------ | ------------ | ----------- |
| `shirts`     | Shirts       | Clothes     |
| `hoodies`    | Hoodies      | Clothes     |
| `hats`       | Hats         | Clothes     |
| `accessories`| Accessories  | Clothes     |
| `fragrances` | Fragrances   | Fragrances  |
| `candles`    | Candles      | Fragrances  |
| `body-care`  | Body Care    | Body Care   |
| `test-item`  | Test Item    | More        |
| `other`      | Other        | More        |

Labels and departments live in ONE shared place —
`frontend/src/lib/departments.js` — so the chips, department
headings, editor select and product pages can never drift apart.

## Product fields (the clothing shape)

- **name** — the only always-required field.
- **category** — one of the ids above (required; it defaults to the
  first option in the editor).
- **price** — dollars; blank = Price TBD (shows, can't be bought).
- **brand** — optional text (≤ 80 chars), e.g. `824`. Shown on the
  card, the detail page and the admin lists.
- **sizes** — the size run: an array of size strings. Historically
  entered as comma-separated text; since 2026-11-10 the editor
  manages sizes through the per-size rows below, and a legacy
  product's stored run is left exactly as it is until the owner
  switches it (see "Sizes, gender & per-size stock"). Caps
  normalize (never reject): at most 12 entries, each truncated to
  12 chars, blanks and duplicates dropped. **Empty = one-size /
  not applicable** (hats, fragrances, the test item).
- **gender** — optional: `mens` | `womens` | `unisex` | `kids` |
  null. Shown as a label ("Women's") on the card, the detail page
  and the admin lists. Validated forgivingly in normalizeProduct
  (unknown value → null). See the per-size section below.
- **scent** — optional free-text scent / fragrance notes
  (≤ 120 chars), e.g. `Sandalwood & vanilla`. For perfumes, colognes,
  candles and deodorant; shown on the card and detail page as
  "Scent: …". Fragrance, candle and body-care items are one-size by
  nature — leave their sizes blank.
- **type** — optional free-text style note ("Classic fit",
  "Graphic", …). Never required; the category is the kind now.
- subtitle, tile colors, photo, weight/dims, the Shipping checkbox,
  and the inventory fields (stock count / low-stock threshold /
  free-shipping) are unchanged — see `docs/PRODUCT_EDITOR.md`,
  `docs/SHIPPING.md`, `docs/INVENTORY.md`.

Storage: `products.brand` / `products.sizes` (JSON array in TEXT) /
`products.scent`, added by `cloudflare/migration-clothing.sql` and
lazily at runtime by `ensureClothingColumns()` in
`functions/api/_lib/db.js`. `rowToProduct` exposes `brand`
(string|null), `sizes` (array, `[]` when unset) and `scent`
(string|null).

## Sizes and orders

- The detail page shows a **size picker** when a product has sizes,
  and Add to Cart stays disabled until a size is chosen
  ("Pick a size"). Product cards for sized items link to the detail
  page ("Pick a Size") instead of quick-adding.
- A cart line is **(product + size)**: the same hoodie in M and L is
  two lines. The size shows in the cart, at checkout, on the
  customer's order history and in the admin order views.
- The chosen size is snapshotted onto the order item
  (`items[].size`) server-side; a size the product doesn't offer is
  rejected with a 400. One-size products take no size.
- **Stock for legacy products is per-PRODUCT**: one count covers
  the whole size run. The cart caps the product's *total* quantity
  across its size lines, placement gates each line against the
  count, and the payment commit decrements the product count —
  exactly the inventory rules in `docs/INVENTORY.md`, just shared
  across sizes. Products the owner has switched to per-size stock
  (next section) count each size separately instead.

## Sizes, gender & per-size stock

Added 2026-11-10 at the owner's direction: "when adding product
allow me to select a size allow me to select a gender and then
allow me to enter a quantity for each size" — Small ×2, Medium ×2,
Large ×2, all on ONE product, each size counting down and selling
out on its own.

**Data model** (`cloudflare/migration-size-stock.sql`, lazily at
runtime via `ensureSizeStockColumns()` in `_lib/db.js`):

- `products.gender TEXT` — `'mens' | 'womens' | 'unisex' |
  'kids' | NULL`. `parseGender` in `_lib/validate.js` normalizes
  case-insensitively and maps anything unknown to null (forgiving,
  like sizes — never a 400). Exposed as `product.gender`; display
  labels live in `GENDER_LABELS` (server) and
  `frontend/src/lib/departments.js` (`GENDERS` / `genderLabel()`).
  Gender is independent of stock mode — it can be set on any
  product, including legacy ones, without touching stock.
- `products.size_inventory TEXT` — a JSON object mapping size
  label → quantity, e.g. `{"S":2,"M":2,"L":2}`; NULL = legacy
  mode. The API shape is `sizeInventory`: an array
  `[{ size, qty }]` in canonical size order (XXS…5XL, then "One
  Size", then other labels in entry order). `parseSizeInventory`
  accepts an array, an object map, or either JSON-encoded (the
  multipart form); sizes are trimmed and deduped
  case-insensitively (first casing wins); a quantity must be an
  integer 0–9999 or its entry is dropped (0 is legitimate — a
  sold-out size); at most 12 entries; an empty result normalizes
  to null.

**Derived fields**: when a map is present, `rowToProduct` derives
`sizes` = the map's keys in canonical order, `stockQty` = the sum
of quantities, and `available` = sum > 0. The `stock_qty` column
is kept equal to that sum on create/update (and by every
decrement), so the admin lists and low-stock logic keep working
unchanged.

**Precedence (normalizeProduct)**: a payload that CONTAINS
`sizeInventory` wins — `sizes`/`stockQty` inputs are then ignored
for stock purposes — and an explicitly EMPTY `sizeInventory`
(`[]` / `{}`) clears the product back to legacy mode. A payload
that omits `sizeInventory` keeps the product's stored mode
exactly. **Nothing auto-converts a legacy product**: live product
id 2 ("Button down shirt", sizes `["Women's L"]`, stock 1) still
reports exactly that until the owner edits it into the new mode.

**Orders & inventory**:

- Placement (`normalizeOrder`): for a per-size product the size is
  REQUIRED (missing → 400 "Please choose a size…"), must be one of
  the product's sizes, and the quantity may not exceed THAT SIZE's
  remaining count — `'"M" only has 2 left.'` Legacy products keep
  the previous behavior exactly.
- Commit (`applyOrderInventory`, same two commit points as always
  — Stripe webhook paid + demo-card placement): the ordered size's
  count decrements (floored at 0) and `stock_qty` follows as the
  new sum, via `decrementProductSizeStock` in `_lib/db.js`;
  idempotent via `orders.inventory_applied`. Expired /
  async-failed events never decrement.
- Best Offer: accepting an offer checks the OFFER's size count
  (sold out → the same 409 "Sold out since the offer was made.");
  paying runs through the normal order + inventory path, so the
  offer's size is what counts down. The helpers
  (`hasSizeInventory`, `sizeQtyRemaining` in `_lib/inventory.js`)
  are shared — no forked logic.
- Admin stock endpoint (`PATCH /api/admin/products/:id/stock`):
  an optional `size` targets one size of a per-size product
  (`stockQty` sets it, `adjustBy` adjusts it, floored at 0;
  unknown size → 400). For a per-size product WITHOUT a size, both
  operations are 400 ("pick a size…") — a whole-product number is
  ambiguous when sizes carry their own counts. Sending `size` for
  a legacy product is a 400; legacy calls without `size` are
  unchanged.

**Storefront**: the editor's size rows + Gender select are
documented in `docs/PRODUCT_EDITOR.md`. The detail page's size
picker disables sold-out sizes (labeled "Sold out") and shows
"Only X left" at or under the low-stock threshold; the quantity
stepper and the cart cap at the SELECTED size's count
(`qtyCapForSize` in `CartContext.jsx`). Admin product lists show
the breakdown ("S:2 · M:0 · L:2") for per-size products. Tests:
`scripts/test-size-stock.mjs`.

**"No size" — the sizeless entry** (2026-11-10, owner direction:
fragrances, colognes and deodorants need a quantity with no
clothing size): `"No size"` is a first-class size-inventory key,
not a mode of its own. It sorts FIRST in canonical order (before
XXS — it means the absence of size variants) and
`parseSizeInventory` normalizes any casing variant ("no size",
"NO SIZE") to exactly `"No size"` — the one place the parser
recases instead of keeping first-seen casing. In every other
respect it behaves like "M": orders must name it (the per-size
size-required rule applies), it caps, counts down, sells out,
restocks through the admin stock endpoint's `size` field, and
carries through Best Offer accept/pay. The one buyer-side
difference: a product whose ONLY entry is `"No size"` renders no
size picker on the detail page — the stepper caps at that entry's
count and Add submits the size automatically. Mixed with other
sizes, it is simply one more picker entry, in first position.

## Browsing: chips + departments

The shop page (`frontend/src/pages/Products.jsx`) offers both, per
the owner's pick:

- **Chips** — unchanged: All Products + one chip per category
  actually present in the catalog. Tapping a chip filters to that
  category, rendered as a flat grid.
- **Departments** — with no chip selected (All Products) and a
  catalog spanning more than one department, the grid groups under
  department headings: **Clothes** (shirts, hoodies, hats,
  accessories), **Fragrances**, **Body Care**, **More** (test-item,
  other). One section per department that has products; empty
  departments never render; a single-department catalog renders
  flat, exactly as before. Search and sort apply first, then what's
  left is grouped, with the sort order preserved inside each
  section.

## Filtering & sorting

The shop page composes three filters and one sort, all client-side
(the catalog arrives whole from `GET /api/products`; the pure logic
lives in `frontend/src/lib/departments.js` — `applyShopFilters`,
`listManufacturers`, `sortProducts` — and is unit-tested in
`scripts/test-shop-filters.mjs`):

- **Manufacturer filter** — a dropdown beside Sort. Field note:
  "manufacturer" is the owner's word; the data field is the
  product's **Brand** — the control reads `brand` and labels itself
  *Manufacturer*. Options are the makers present in the set being
  browsed: scoped by the active category chip **and** the search
  text (tap Candles and you pick from candle makers; All Products
  lists everyone), recomputed from the data, never a fixed list.
  Matching is exact (case-insensitive) — and a product with **no
  brand appears only under "All manufacturers"**: it has no maker
  to match. The control is **hidden when the scoped set has fewer
  than two manufacturers** — a one-answer filter is a no-op, and a
  hidden control can never strand a shopper. If a selected maker
  has nothing in a newly chosen scope (chip switch or search edit),
  the filter quietly resets to All manufacturers instead of showing
  an unexplained empty page.
- **Sort** — Featured (catalog order, unchanged) · Price: Low to
  High · Price: High to Low · Name: A to Z · Name: Z to A · Newest
  (highest id first) · Manufacturer (brand A–Z, unbranded last,
  then name). **Price-TBD products (`price` null) sort last in both
  price directions** — a TBD price is unknown, not $0.
- **Composition** — search, chip, manufacturer and sort all apply
  together; department grouping runs last, on what's left, with
  the chosen sort order preserved inside each section. A subtle
  "X products" line shows the filtered count, and an empty result
  offers a **Clear filters** action (resets manufacturer, search
  and chip).

## Used-clothing disclosure

Owner policy (2026-11-09): **all clothes are used unless specified
as NEW.** The shop page (`frontend/src/pages/Products.jsx`) shows
the disclosure **twice**: at the top (directly under the page
title, before the search/sort row) and again at the bottom, in
every catalog state including an empty one. One shared component
(`frontend/src/components/UsedClothingDisclosure.jsx`) renders both
instances identically as a dark notice bar. Since 2026-11-10 the
disclosure is two lines:

1. "All clothes are used unless specified as NEW." — the word
   **NEW** is styled capital letters, bold and red
   (`.used-disclosure-new` in `index.css`, #b3261e — the sold-out
   badge red) and is the only red in the bar.
2. "NEW items are priced as listed — no offers. Most used items
   are **BEST OFFER**: make an offer and the seller decides." —
   the pricing policy that arrived with Best Offer (below):
   **BEST OFFER** is styled bold gold (`.used-disclosure-best-offer`).
   "Most" is the honest word — a seller can switch offers off on
   an individual used item, while a NEW item NEVER takes offers.

## Best Offer

Make-an-offer (Poshmark-style) is part of the clothing model:
products carry a `condition` ('new' | 'used' | unspecified) and an
`accepts_offers` switch, buyers offer below list price, and the
seller accepts or declines in the admin Offers inbox. The full
model — eligibility rules (existing unmarked products default to
offers ON; NEW never), endpoints, money/tax/shipping treatment,
the 72-hour expiry and the double-accept semantics — lives in
**docs/OFFERS.md**.

## The $8.24 test item (nothing item) recipe

The test listing that proves checkout end-to-end, in the Add
Product form:

- Name: `⚠️ TEST ITEM — YOU WILL NOT RECEIVE ANYTHING ⚠️`
- Subtitle: the same warning, spelled out
- Category: **Test Item**
- Price: **8.24**
- **Shipping checkbox: UNCHECKED** (no shipping)
- Stock: **Unlimited**
- Brand / Sizes / Scent / Gender: blank — a test item needs nothing else

Untracked stock proves the Stripe checkout + order flow; it cannot
prove the stock countdown — that comes with the first real tracked
product's first sale.

## What retired

The smoke-shop model is gone from validation and every shopper /
admin surface:

- Categories `flower`, `vapes`, `gummies`, `pouches`, `nic-vapes`
  are rejected by the API (400).
- `type` is no longer required.
- `thc`, `strength`, `effects`, `unit` are no longer collected in
  the editor, no longer rendered on cards / detail / cart / admin,
  and validation **never derives** one from another (the old
  "strength = `<thc>% THC`" invention is deleted).
- The **columns stay** (`products.thc/strength/effects/unit`) —
  additive-only schema, history remains readable, and the API still
  accepts and stores those fields when a client explicitly sends
  them. The editor's payload omits them on purpose: on edit, omitted
  fields fall back to the stored row, so saving a product from the
  clothing form never wipes legacy values it no longer shows.
  (Proven in `scripts/test-clothing.mjs` section (j).)

## Tests

`scripts/test-clothing.mjs` covers the whole model: the lazy column
ensure, the hoodie, the nothing item end-to-end, legacy-category
rejection, size normalization, sized orders + stock decrement,
perfume + deodorant, the department grouping helpers, and the
non-destructive legacy edit. `scripts/test-shop-filters.mjs` covers
the filtering + sorting helpers (manufacturers, filter composition,
every sort key, Price-TBD placement, non-mutation).
`scripts/test-size-stock.mjs` covers per-size stock + gender:
normalization, precedence, the legacy id-2 guarantee, per-size
placement gates and decrements on both commit paths, the admin
stock endpoint's per-size mode, and the offer flow's size checks.
