# Shop 824 — Admin Product Editor

Owner direction 2026-11-09 ("make an add product that includes an
option that says shipping or no shipping when creating the product";
refined the same day: "make an add product page with a tab so I can
add products easily… have a check mark box for whether or not it's
shipping").

The editor lives on its **own page, `/shop/admin/products`**,
reached from the **Products tab** on the admin dashboard (the
dashboard's Products section is now a read-only summary with an
"Open the Products page" button). The page opens with the Add
product form already on it; the catalog list below has Edit (swaps
the form into edit mode and scrolls to it) and Delete per row.

Code: `frontend/src/pages/AdminProducts.jsx` (the page),
`frontend/src/components/ProductEditor.jsx` (the form),
`frontend/src/pages/AdminDashboard.jsx` (the tab + summary),
`frontend/src/services/adminApi.js` (`saveAdminProduct` /
`deleteAdminProduct`). The backend needed no changes — it reuses the
existing endpoints:

| Action | Call |
| --- | --- |
| Create | `POST /api/products` (admin) |
| Edit | `PUT /api/products/:id` (admin) |
| Delete | `DELETE /api/products/:id` (admin) |
| List | `GET /api/products` (public list, same as the storefront) |

Field validation and normalization live in
`functions/api/_lib/validate.js` (`normalizeProduct`) — the editor
never re-implements a rule; a bad value comes back as the server's
400 and is shown verbatim at the top of the form. Tests:
`node scripts/test-product-editor.mjs` (38 checks).

## How the form maps to the API

- **Name** (required), **Subtitle**, **Type** (required free text) —
  sent trimmed, exactly as `normalizeProduct` expects.
- **Category** — a select over the API's `CATEGORIES`
  (`flower, vapes, gummies, pouches, nic-vapes`; legacy ids the API
  validates against). Labels reuse the storefront's rule
  (`pages/Products.jsx`): capitalize, except `nic-vapes` →
  "Nicotine Vapes". The storefront derives its filter chips from
  whatever categories exist in the data, so a product in any of
  these shows up under its chip.
- **Price** — blank → `null` → **Price TBD**: the product displays
  but cannot be ordered. Negative → the server's 400.
- **THC %** — blank → `null`. With no explicit **Strength label**,
  the server derives `"<thc>% THC"`; with neither, strength reads
  "THC TBD".
- **Unit** — blank → `null`.
- **Effects** — one comma-separated text input in the form; the
  client splits it into the array the API stores (the API also
  accepts a raw comma string or a JSON-encoded array in multipart —
  `parseEffects`).
- **Tile colors** — two color inputs, sent as the `[c1, c2]` array
  (defaults `#374151` / `#111827`, the API's `DEFAULT_TILE`).
- **Photo** — a file input; see the two-step save below. The
  server's "Photo uploads are not configured…" 400 (no
  `PRODUCT_PHOTOS` R2 binding on the deployment) surfaces as the
  form's error, not a crash.

## Shipping vs No shipping (the headline choice)

The Shipping control is **one checkbox** over the product's
`freeShipping` flag (see `docs/SHIPPING.md` / `docs/INVENTORY.md`
for the math):

- **Shipping — checkbox CHECKED** (`freeShipping: false`) — the
  item joins the parcel: its weight/dimensions feed the USPS quote
  and the buyer pays the rate at checkout.
- **No shipping — checkbox UNCHECKED** (`freeShipping: true`) — the
  item is excluded from the package entirely. For test items,
  digital items, or anything that ships free. If **every** item in
  a cart is no-shipping, the order proceeds with $0 shipping and no
  service choice required, even when USPS is configured.

On edit, the checkbox starts checked exactly when the product's
`freeShipping` is false. Weight (oz) and Length/Width/Height (in)
sit under the checkbox. While it is unchecked they are shown dimmed
with a note — the values are **kept, just ignored** (not cleared),
so re-checking restores the measurements. Blank measurements are
fine either way: the shipping defaults in `_lib/shipping.js` apply.

## Inventory group

Two radios over `stockQty`:

- **Unlimited (don't track stock)** — `stockQty: null`. The product
  sells as products always have: no count, no sold-out, no
  decrement.
- **Track stock** — reveals **Stock quantity** and **Low-stock
  warning at** (blank → `null` → the shop default of 3). The form
  refuses to save "Track stock" with an empty quantity rather than
  silently turning the product Unlimited.

Quick count changes between full edits can still go through
`PATCH /api/admin/products/:id/stock` (see `docs/INVENTORY.md`).

## The tracked → untracked + photo edge

Saving is **always JSON first, photo second** (implemented in
`saveAdminProduct`):

1. The full field payload goes as JSON (`POST` create / `PUT`
   edit). JSON is the only body that can express `null` — and null
   is how you switch a tracked product back to Unlimited, blank a
   price back to Price TBD, or clear a measurement. A multipart
   form cannot say null: omitting a field on update makes
   `normalizeProduct`'s `pick()` **keep the old value**, which
   would silently keep the old stock count.
2. If a photo was chosen, a second `PUT` follows whose multipart
   body carries **only** the photo. `readProductInput` then yields
   no fields, every `pick()` falls back to the just-saved product,
   and `attachPhoto` swaps the image. Nothing else changes.

If step 2 fails (e.g. photo storage not configured), the product is
still saved: `saveAdminProduct` rethrows with `err.savedProduct`
attached, the editor adopts the saved product as an edit form and
keeps the chosen file, so pressing Save again retries the photo
instead of creating a duplicate.

## Delete policy

Delete asks for confirmation naming the product, calls
`DELETE /api/products/:id`, and refreshes the list. The product's
photo object is **intentionally left in R2** — the same policy the
API handler documents: an object may be referenced by the committed
catalog, and deleting stored assets is destructive. Orphaned photos
cost storage only; they are never served once the product is gone
(the catalog no longer links to them).

## Recipe: add the $8.24 test item

Admin dashboard → **Products tab** (or straight to
`/shop/admin/products`) — the Add product form is already open at
the top of the page:

1. **Name:** `⚠️ TEST ITEM — YOU WILL NOT RECEIVE ANYTHING ⚠️`
2. **Subtitle:** `⚠️ YOU WILL NOT RECEIVE ANYTHING. This is a test
   listing to verify our checkout. No product will be shipped and
   nothing will be delivered. ⚠️`
3. **Type:** `Test Item` (Category: any — the catalog starts empty,
   so it will be the only chip either way)
4. **Price:** `8.24`
5. **Strength label:** `⚠️ NO PRODUCT — TEST ONLY ⚠️`
6. **Unit:** `Nothing — test item`
7. **Effects:** `⚠️ YOU WILL NOT RECEIVE ANYTHING — TEST LISTING ONLY`
8. **Shipping:** leave the checkbox **UNCHECKED** (no shipping —
   free shipping)
9. **Inventory:** choose **Unlimited (don't track stock)**
10. **Add product.**

Then buy it once from the storefront: the checkout total is
$8.24 + tax with **$0 shipping**, the order lands in Admin → Orders,
and the stock model stays Unlimited (nothing counts down — the
countdown proof comes from the first tracked product).
