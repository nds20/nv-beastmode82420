# Beastmode 82420 — brand hub + Smoke Shop 824

The new home of **beastmode82420.com**: a React app with two faces —

- **`/` — the Beastmode 82420 hub.** The owner's artwork
  (`frontend/public/images/hero-art.png`) as the hero, five real pill
  links under it (LinkedIn, Biometric Screening Research, 824 Shield,
  Smoke Shop, Unofficial Muse AI for Windows), and the owner's
  *About 824* blurb, verbatim.
- **`/shop` — Smoke Shop 824.** The storefront (products, product
  detail, cart, checkout, order confirmation, customer accounts),
  behind a 21+ age gate.

…served by **one Cloudflare Worker** that also runs the shop's API
under **824 Shield**, backed by the **existing** D1 database
(`smokeshop-db`) and the existing R2 photo bucket — every product,
order, admin account and customer from the current live shop carries
over untouched.

## Layout

```
wrangler.toml          Worker "nv-beastmode82420": assets = frontend/dist,
                       run_worker_first for /api/*, D1 + R2 bindings
worker/
  shield-entry.js      824 Shield wrapper (the Worker entry point)
  shield/              824 Shield, vendored (GPLv3, by the copyright
                       holder) — same modules as the live shop
  index.js             /api/* router -> the handlers in functions/
functions/api/         The shop API, ported from the live shop
  _lib/                auth (PBKDF2 + HMAC tokens), db (D1), validate,
                       http, photos (R2), stripe
  health.js            GET  /api/health
  products.js          GET  /api/products · POST (admin)
  products/[id].js     GET · PUT · DELETE (admin)
  orders.js            POST /api/orders (public checkout)
  orders/[id]/         checkout (Stripe, token) · status (token)
  customers/           register · login · me · orders
  admin/               login · setup · setup-status · orders inbox
  photos/[[path]].js   GET  /api/photos/<key> (R2 uploads)
  payments/config.js   GET  /api/payments/config
  stripe/webhook.js    POST /api/stripe/webhook
cloudflare/
  schema.sql, seed.sql The D1 schema/seed (already applied to the
                       existing database; kept for reference/recovery)
frontend/              Vite + React app (see below)
```

The API's behavior — endpoints, response shapes, JSON field names
(products are `id, name, subtitle, category, type, thc, strength,
price, unit, effects, tile, image`), password hashing (PBKDF2-SHA256),
token format (HMAC-SHA256, 8h, separate admin/customer audiences) and
the order flow — is a faithful port of the owner's live shop code
(`smokeshopfrontend/` in nds20/nv-full-stack-code-review-basic).

**Shop rules kept intact:** tax is 10.2%; a product whose price is
null displays **Price TBD**, is excluded from cart totals, and blocks
checkout (client-side *and* server-side — `normalizeOrder` rejects it
with a 400). Nothing about a product is ever invented: prices,
strengths and effects stay TBD until the owner confirms them. The
catalog is nicotine-only — the two Raz vapes — by the owner's call.

**One deliberate API extension:** the original API had no "my orders"
for customers. Here, when an order is placed with a valid customer
token, the order's stored customer JSON gains an `accountId`, and
`GET /api/customers/orders` lists that customer's orders (the account
page uses it). Guest orders are byte-for-byte unchanged, and no schema
migration on the live database is needed (the list reads the id back
with SQLite's `json_extract`).

**824 Shield posture (same as the live shop):** every `/api/*`
request is scored for prompt injection, classic exploits, probes, bot
signals and floods before the shop sees it; blocks answer
`403 { error: "Request blocked by 824 Shield.", reasons: [...] }`;
all responses gain Shield's security headers. Multipart photo uploads
are never payload-scanned. Reverting `main` in wrangler.toml to
`worker/index.js` unwraps Shield.

## Frontend

Vite + React 18 + React Router. Pages:

| Route | Page |
|---|---|
| `/` | Hub (hero art, pill links, About 824) |
| `/shop` | Shop home (age gate overlays all `/shop` routes) |
| `/shop/products` | Catalog with search + sort |
| `/shop/product/:id` | Product detail |
| `/shop/cart` | Cart (localStorage) |
| `/shop/checkout` | Checkout (demo card or Stripe redirect) |
| `/shop/order-confirmation` | Confirmation (+ Stripe return) |
| `/shop/login` | Sign in — and the account page (profile + orders) |
| `/shop/register` | Create account |

The look is one central stylesheet (`frontend/src/index.css`,
adapted from the black & gold design system: gloss black, gold
`#f5b921`, Bebas Neue + Inter) and presentational components, so the
final owner-supplied design can re-skin the app without touching
logic. The hub hero is a single `<img>` — drop in a replacement
`hero-art.png` and the page follows. Product data comes from
`/api/products`; if the API is unreachable, the app falls back to the
built-in two-product catalog so the shop never renders empty.

## Local dev

```bash
cd frontend && npm install && npm run build   # -> frontend/dist
npx wrangler dev                               # Worker + API on :8787
cd frontend && npm run dev                     # Vite on :5173, /api proxied to :8787
```

For a local D1, `wrangler dev` uses a local database; apply
`cloudflare/schema.sql` then `cloudflare/seed.sql` to it
(`wrangler d1 execute smokeshop-db --local --file=...`) to mirror
production data.

## Cutover notes (when the owner says go)

1. Deploy THIS Worker (`name = "nv-beastmode82420"`) — it is a **new**
   Worker; the current shop's Worker keeps serving the domain.
2. It binds the **same** D1 (`smokeshop-db`,
   `bb452b0e-8bfb-4042-8d08-4f8e902c8164`) and the **same** R2 bucket
   (`smokeshop-product-photos`), so no data moves.
3. Set the same secrets on the new Worker as the old one has
   (`SMOKESHOP_ADMIN_USER` / `SMOKESHOP_ADMIN_PASSWORD` /
   `SMOKESHOP_ADMIN_SECRET`, and Stripe keys if used) — never commit
   them.
4. Verify on the workers.dev URL (hub, shop, `/api/health`,
   `/api/products`, a Shield SQLi block).
5. Only then move the custom domains (`beastmode82420.com`, `www`)
   from the old Worker to this one. The old shop stays live until
   that moment and remains as the rollback.
