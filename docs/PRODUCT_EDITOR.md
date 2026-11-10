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

## Gender + size rows (per-size stock, 2026-11-10)

Owner direction: pick a gender, and enter a quantity FOR EACH SIZE
on one product (Small ×2, Medium ×2, Large ×2). The model behind
it — `products.gender`, `products.size_inventory`, the derived
fields, the precedence rules and the order/inventory semantics —
is documented in `docs/CLOTHING.md` ("Sizes, gender & per-size
stock"). What the form does:

- **Gender** — a select next to Brand: `— None —`, **Men's**,
  **Women's**, **Unisex**, **Kids**. It is shown ALWAYS, for every
  category (one optional field; showing/hiding it by category
  would only add surprise), and it never interacts with stock.
  Payload: `gender` (the value or null).
- **Size rows** replace the old comma-separated Sizes text input.
  Each row is [size label][quantity][Remove], with an
  **＋ Add a size** button and quick-add chips (**XS S M L XL
  2XL**) that append a row (a chip for a size that already has a
  row does nothing). A one-size product is just a single row
  labeled "One Size". The rows ARE the stock: when at least one
  row is filled in, the product is in per-size mode and the
  Inventory radios below are replaced by a note (plus the
  low-stock threshold, which then applies per size). With NO
  rows, the product uses the legacy stock controls and the
  payload omits `sizeInventory` entirely.
- **Save-time validation** (clear errors at the top of the form,
  before anything is sent): a row with a size but an empty
  quantity → "Give every size a quantity — 0 is fine for sold
  out."; a quantity that isn't a whole number names its size; a
  size listed twice → an error naming the size; a row with a
  quantity but no size name → finish it or remove it.
- **Payload** (`buildProductPayload` / `sizeInventoryPayload` in
  `adminApi.js`): filled rows → `sizeInventory: [{ size, qty }]`
  (the server derives sizes + total stock; `stockQty` is sent
  null). The free-text `sizes` field is no longer sent at all —
  omitting it keeps a legacy product's stored size run untouched
  on edit.
- **Editing a legacy sized product** (sizes but no per-size map):
  its sizes show as a read-only note — "Current sizes: Women's L
  — add quantity rows to switch this product to per-size stock" —
  and the rows start EMPTY. Switching modes is the deliberate act
  of filling rows in; an unrelated edit can never convert the
  product. Editing a per-size product prefills its rows from the
  map. Removing EVERY row from a per-size product and saving
  sends an explicit empty `sizeInventory`, which clears it back
  to legacy mode (the legacy stock controls reappear, prefilled
  with the last total).

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

Applies when the product has NO size rows (with rows, the rows are
the stock — see "Gender + size rows" above). Two radios over
`stockQty`:

- **Unlimited (don't track stock)** — `stockQty: null`. The product
  sells as products always have: no count, no sold-out, no
  decrement.
- **Track stock** — reveals **Stock quantity** and **Low-stock
  warning at** (blank → `null` → the shop default of 3). The form
  refuses to save "Track stock" with an empty quantity rather than
  silently turning the product Unlimited.

Quick count changes between full edits can still go through
`PATCH /api/admin/products/:id/stock` (see `docs/INVENTORY.md`) —
for a per-size product that endpoint requires a `size` (see
`docs/CLOTHING.md`).

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

## Phone photos

**Update 2026-11-10 (later that night) — the photo step moved.**
Storage was exonerated by the `/api/products/photo-debug` probe
run live from the owner's signed-in browser: binding present,
R2 put/get/delete all succeed in 63–197 ms. The failing request
was the editor's step-2 **multipart PUT to `/api/products/:id`**
— in production it dies before the Worker's own JSON error
handling can answer (the client records a `bad-response`: a
non-JSON edge answer), while every link of the same chain tested
in isolation (router smoke tests, the staged parse/store path,
the probe) works. The photo step now posts to
**`POST /api/admin/products/:id/photo`** — a staged endpoint
(parse → store → verify read-back) in the `/api/admin` namespace
that serves every other editor write without this failure. It
answers `{ ok:true, product, stages }` or
`{ ok:false, stage, error }` with the real underlying message, so
any future photo failure names its stage instead of guessing.
The generic multipart PUT on `/api/products/:id` still exists
(it is the Pages-ported API contract); the editor no longer
uses it for photos.

Original note (2026-11-10, earlier): after a live failure — the
owner attached a photo
snapped on his iPhone, the details saved, and the photo step died
with a bare "The admin server could not be reached". Two things
were wrong: iPhone camera photos are usually **HEIC** (which the
server's extension list rejects) and **several MB** (a multi-MB
upload on cellular can drop mid-flight, before any server message
exists).

The fix is client-side, in `frontend/src/lib/photoPrep.js`
(`preparePhotoForUpload`, called by `saveAdminProduct` before
step 2):

- The chosen photo is decoded in the browser, drawn to a canvas
  scaled so the **longest side is at most 1600 px** (never
  upscaled), and re-encoded as **JPEG at quality 0.85**, uploaded
  as `<name>.jpg`. Safari decodes HEIC natively, so the conversion
  is free exactly on the phones that shoot HEIC; a 5 MB camera shot
  lands as a few hundred KB that sails under the server's 10 MB
  cap. Transparency flattens onto white (JPEG has no alpha).
  Orientation uses `createImageBitmap` with
  `imageOrientation: 'from-image'` where the platform offers it;
  the fallback decode paths rely on the decoder's own EXIF
  handling.
- **Prep only when it helps.** SVG and GIF pass through untouched;
  files at or under 1 MB pass through untouched; a re-encode that
  comes out larger than the original is discarded (the one
  exception is HEIC, whose re-encode is kept at any size — the
  server rejects the `.heic` extension outright, so conversion is
  the only path).
- **The fallback rule: prep never fails an upload.** It never
  throws; any decode/canvas/encode problem returns the original
  file and the upload proceeds exactly as it did before this
  existed.
- **Friendly failures.** `adminFetch` now tags the failures where
  the server never got a usable word in with a `.code` (`network`
  when fetch itself threw, `bad-response` when the answer wasn't
  the API's JSON), and `saveAdminProduct` attaches an
  `err.photoFailure` summary to the rethrown error.
  `photoFailureMessage` (same module) turns it into the editor's
  lead sentence: the server's own JSON error still surfaces
  verbatim; an HEIC the browser couldn't convert gets the
  pick-again / export-as-JPEG / "Most Compatible" guidance; a file
  still over 10 MB after shrinking is named as too large; a dropped
  connection says the photo upload didn't go through — all above
  the standing "details were saved, press Save again" suffix.

Tests: `node scripts/test-photo-prep.mjs` — the pure helpers
(HEIC detection, prep gating, dimension math, filename mapping,
message mapping) plus the guarantee that prep resolves to the
original file where no decoder exists. The canvas path itself is
browser-only and covered by bundle inspection instead.

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
