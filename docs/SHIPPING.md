# Shipping — buyer-paid USPS live rates (2026-11-09)

Shop 824 shipping is **buyer-paid** and **calculated at checkout from
live USPS rates** (owner direction 2026-11-09). Until the USPS
credentials below are wired, the feature is **dormant**: no shipping
UI appears, orders charge $0 shipping, and the shop behaves exactly
as it did before. The moment the variables are set, the next checkout
starts offering real rates — no code change needed.

## How a rate is calculated

Code: `functions/api/_lib/usps.js` (USPS client) +
`functions/api/_lib/shipping.js` (package math + quoting) +
`functions/api/shipping/quote.js` (public quote endpoint) +
`functions/api/_lib/validate.js` (order placement re-quote).

1. **The parcel.** Every product has optional admin-set measurements
   (`weightOz`, `lengthIn`, `widthIn`, `heightIn` on the product,
   stored as `weight_oz` / `length_in` / `width_in` / `height_in`).
   For a cart, the parcel weight is the sum of item weights × qty,
   and the parcel box is the largest item dimension on each axis.
   Defaults when a product is unmeasured — all in one place,
   `_lib/shipping.js`:
   - weight: **16 oz** per item (`DEFAULT_WEIGHT_OZ`)
   - box: **12 × 9 × 6 in** per unset dimension
   Weight in pounds is rounded **up** to the next 0.1 lb (min 0.1 lb).
2. **The USPS calls.** USPS Prices API v3, one `base-rates/search`
   call **per mail class** (two calls per quote):
   - `USPS_GROUND_ADVANTAGE` → shown as "USPS Ground Advantage"
   - `PRIORITY_MAIL` → shown as "USPS Priority Mail"

   Each call sends origin ZIP (the shop's), destination ZIP (the
   buyer's, first 5 digits), weight (lb), the parcel dimensions,
   `priceType: 'RETAIL'`, and today's date as `mailingDate`. The
   charged price is the response's `totalBasePrice`, converted to
   integer cents. Authentication is OAuth2 client-credentials;
   the token is cached in the Worker isolate until ~60 s before
   expiry.
3. **Checkout flow.** When the buyer enters a valid 5-digit ZIP, the
   checkout page fetches `POST /api/shipping/quote` (debounced) and
   shows the services as radio choices with prices. Placing the order
   sends back **only the chosen service id** — the server re-quotes
   that service at order time and stores ITS price. A price the
   client sends is never trusted. Tax stays on the merchandise
   subtotal only; shipping is not taxed.
   Total = subtotal + tax + shipping.
4. **Stored on the order:** `shipping_cents` (**integer cents** —
   unlike the dollar REAL money columns; the name carries the unit),
   `shipping_service`, `shipping_label`, `shipping_weight_oz`. The
   Stripe Checkout session reproduces the stored total exactly:
   item lines + "Sales tax" line + one shipping line (named with the
   stored label, amount = `shippingCents` verbatim).
5. **Fallbacks.**
   - USPS configured but unreachable/errors for both classes → one
     flat option, "Standard shipping (flat rate)", at
     **`FALLBACK_FLAT_CENTS = 899` ($8.99)** — a single named
     constant in `_lib/shipping.js`.
   - One class failing → the other is still offered.
   - USPS *not* configured → `{ configured: false, options: [] }`,
     no shipping is charged. There is deliberately **no** flat
     shipping when the feature is unconfigured.

⚠️ **USPS Prices API limit: ~60 calls/hour per key.** That is why
rates are fetched only per checkout interaction (ZIP entered /
cart changed), never per page view, and why the OAuth token is
cached. A busy launch day may need a higher USPS tier.

## Configuration

Set these on the **nv-beastmode82420** Worker, in the **runtime**
"Variables and secrets" list (Settings → Variables and Secrets —
the list that also holds `SESSION_SECRET` / `BEASTMODE_ADMIN_*`;
NOT the build-time list):

| Variable | What it is |
| --- | --- |
| `USPS_CLIENT_ID` | OAuth Consumer Key from the USPS developer app |
| `USPS_CLIENT_SECRET` | OAuth Consumer Secret from the same app (add as a **Secret**) |
| `USPS_ORIGIN_ZIP` | The 5-digit ZIP orders ship from |
| `USPS_API_BASE` | Optional override (tests only) — leave unset in production |

`uspsConfigured(env)` = the first three are all present. Never commit
these values; never paste the secret into chat or code.

## Nicholas's wiring steps

1. Go to **developers.usps.com** and sign in (or create a USPS
   developer account).
2. Create an **app** for the shop (name it e.g. "Shop 824"). USPS
   issues a **Consumer Key** and **Consumer Secret** for it.
3. Make sure the app has the **Prices API** enabled.
4. In Cloudflare → Worker **nv-beastmode82420** → Settings →
   **Variables and Secrets** (the runtime list — see above), add:
   `USPS_CLIENT_ID` (the Consumer Key), `USPS_CLIENT_SECRET`
   (the Consumer Secret, stored as a secret), and `USPS_ORIGIN_ZIP`
   (your ship-from ZIP).
5. Done — live rates activate on the next checkout. No deploy or
   rebuild is required for the variables themselves.

## Honest state

- **Live rates activate only after the wiring above.** Without it,
  everything in this document is dormant and the shop is unchanged.
- Shop **card** checkout via Stripe is already switched on by the
  worker's existing Stripe key, independent of shipping.
- There is **no admin product form in the storefront UI** (products
  are managed through the admin API). Weight/dimensions are set via
  the product create/update API fields `weightOz`, `lengthIn`,
  `widthIn`, `heightIn` (validated: > 0, weight ≤ 1120 oz, dims
  ≤ 108 in).
- Existing databases gain the new columns automatically at runtime
  (`ensureShippingColumns` in `_lib/db.js`, the lazy pattern the
  donations table uses); `cloudflare/migration-shipping.sql`
  documents the same ALTERs, and `cloudflare/schema.sql` carries
  them for fresh installs.

## Tests

```
node scripts/test-shipping.mjs   # 63 checks: quoting, orders, Stripe, persistence
node scripts/test-donate.mjs     # regression: donations untouched
```
