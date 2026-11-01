# beastmode82420 — Smoke Shop 824 (custom website)

The permanent home of the Smoke Shop 824 website for **beastmode82420.com**.
This is a brand-new custom design (v1, built 2026-11-01), not a copy of the
shop code that previously lived inside the `nv-full-stack-code-review-basic`
demo repo.

## Design

"Beastmode" identity drawn from the owner's 824 concept car: gloss-black
base, gold accents (`#f5b921` family), bold condensed display type for
headings, clean sans for body. Product color pops come from the products
themselves — sky blue for Blue Raz, bright green for Blueberry Yummy.

## Structure

```
site/                      Self-contained static site — no build step
  index.html               Landing: 21+ age-gate overlay, hero, featured
                           products, category strip, trust badges
  products.html            Product grid with search + sort (data-driven)
  product-raz-nicotine-vape.html      Product detail (Blue Raz)
  product-raz-blueberry-yummy.html    Product detail (Blueberry Yummy)
  cart.html                Cart (localStorage), 10.2% tax on priced items
  checkout.html            Checkout — blocked while a Price-TBD item is in
                           the cart, per shop rule
  order-confirmation.html  Post-order confirmation
  login.html               Sign-in / register placeholder (accounts are a
                           later phase)
  css/styles.css           The full design system
  js/products.js           Product catalog data (single source of truth)
  js/main.js               Cart, cart badge, age-gate handling
  images/products/         Product photo SVGs
```

## Catalog rules (do not break)

- The shop is **nicotine-only, 21+**. Exactly two products today.
- Prices are `null` in `js/products.js` until the owner confirms them;
  `null` always displays as **Price TBD** — never invent a price, potency,
  effect, or rating.
- Price-TBD items can be added to the cart, are excluded from totals, and
  **block checkout** with a clear message.
- Tax is **10.2%**, applied to priced items only.

## Next phase (planned)

Wire this front end to the production backend: a Cloudflare Worker serving
these pages and the shop APIs, backed by the **same D1 database**
(`smokeshop-db`) the current live shop uses — products, customer accounts,
and orders — so the catalog and accounts carry over with no data move.
The old repo stays untouched as the running backup until cutover.
