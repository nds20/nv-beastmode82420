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
- **sizes** — the size run: an array of size strings, entered in the
  editor as comma-separated text (`S, M, L, XL`). Caps normalize
  (never reject): at most 12 entries, each truncated to 12 chars,
  blanks and duplicates dropped. **Empty = one-size / not
  applicable** (hats, fragrances, the test item).
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
- **Stock is per-PRODUCT, not per-size** (v1, deliberately): one
  count covers the whole size run. The cart caps the product's
  *total* quantity across its size lines, placement gates each line
  against the count, and the payment commit decrements the product
  count — exactly the inventory rules in `docs/INVENTORY.md`, just
  shared across sizes. Per-size stock is a possible later build,
  not a silent behavior.

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
the disclosure — "All clothes are used unless specified as NEW." —
**twice**: at the top (directly under the page title, before the
search/sort row) and again at the bottom, in every catalog state
including an empty one. One shared component
(`frontend/src/components/UsedClothingDisclosure.jsx`) renders both
instances identically as a dark notice bar; the word **NEW** is
styled capital letters, bold and red (`.used-disclosure-new` in
`index.css`, #b3261e — the sold-out badge red) and is the only red
in the bar.

## The $8.24 test item (nothing item) recipe

The test listing that proves checkout end-to-end, in the Add
Product form:

- Name: `⚠️ TEST ITEM — YOU WILL NOT RECEIVE ANYTHING ⚠️`
- Subtitle: the same warning, spelled out
- Category: **Test Item**
- Price: **8.24**
- **Shipping checkbox: UNCHECKED** (no shipping)
- Stock: **Unlimited**
- Brand / Sizes / Scent: blank — a test item needs nothing else

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
