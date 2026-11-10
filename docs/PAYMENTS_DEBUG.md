# Shop 824 — Payments debug + reconcile

Admin-only diagnostic built 2026-11-10 for the incident where Stripe
collected two real payments — an $8.24 donation and a $9.08 shop
purchase, receipts emailed by Stripe — that never appeared in the
shop's own records: `GET /api/donate/stats` read `{0, 0}`,
`GET /api/orders/signal` read null, and no order emails arrived.
The endpoint answers two questions at once: **what does the wiring
actually look like**, and **what is missing from the local records**
— and in the same call it repairs the second one.

## The endpoint

`GET /api/admin/payments-debug` — gated by `requireAdmin` like every
other `/api/admin` surface (401 without a valid admin bearer token).
Each hit costs one Stripe list call.

### Response

```jsonc
{
  "stripe":  { "configured": true, "keyMode": "live" },
  "webhook": { "configured": true },
  // "stripeError": { "status": 401, "errorCode": "api_key_expired" }
  //   — present ONLY when the Stripe list call failed; sessions
  //   is [] then. Status + error CODE only, never a raw body.
  "sessions": [
    {
      "idPrefix": "cs_live_ab12",     // first 12 chars of the id
      "kind": "donation",             // "donation" | "order" | "unknown"
      "amountTotalCents": 824,
      "currency": "usd",
      "paymentStatus": "paid",
      "sessionStatus": "complete",
      "created": 1794300000,          // unix seconds, as Stripe sent
      "recordedBefore": false,
      "recordedAfter": true
      // "note": "no matching order in db"  — kind "unknown" only;
      // recordedBefore/After are null there
    }
  ],
  "ordersSignal":  { "latestPaidOrderId": 7, "latestPaidAt": "…" },
  "donationStats": { "totalCents": 824, "donationCount": 1 },
  "mail": {
    "configured": true,
    "missing": [],
    "token": { "ok": true, "status": 200, "errorCode": null }
  }
}
```

### What each part means

- **`stripe.configured` / `keyMode`** — whether `STRIPE_SECRET_KEY`
  is set, and its mode from the key **prefix only** (`sk_live_` →
  `live`, `sk_test_` → `test`, anything else → `unknown`, no key →
  `null`). The key value never appears. A `test` mode here while
  real customers pay means the live key is not the one wired.
- **`webhook.configured`** — whether `STRIPE_WEBHOOK_SECRET` is set.
  (Signature *correctness* is a different question — see the runbook.)
- **`sessions`** — Checkout Sessions retrieved live from Stripe
  (`GET /v1/checkout/sessions?limit=25`), filtered to
  `payment_status: "paid"` and created within the **last 3 days**.
  Classification mirrors the webhook: `metadata.kind === "donation"`
  → donation; otherwise the order lookup (stored session id, then
  `metadata.order_id` / `client_reference_id`) → order when found,
  else `unknown`.
- **The reconcile** — every listed session is replayed through the
  webhook's own completed-session handler
  (`applyCompletedCheckoutSession` in `functions/api/stripe/webhook.js`,
  shared — one code path, two callers): donations record via
  `INSERT OR IGNORE`; orders are stamped paid inside the
  not-yet-paid guard, decremented via the `inventory_applied` flag,
  their offer flipped if any, and the admin PAID email attempted
  (best-effort, exactly as the webhook does it). Already-recorded
  sessions are no-ops. `recordedBefore` / `recordedAfter` snapshot
  the local state around the replay (donation row present? / order
  `paymentStatus === 'paid'`?), and `ordersSignal` /
  `donationStats` are read **after** the reconcile, through the same
  helpers behind `GET /api/orders/signal` and `GET /api/donate/stats`
  — so what this endpoint reports is exactly what the world sees
  once it has run.
- **`mail`** — `mailConfigStatus` (names-only `missing` list) plus
  `token`: the refresh-token exchange exercised **without sending
  anything** (`diagnoseMailToken` in `_lib/mail.js`, sharing the
  production `obtainGmailToken` path). `{ ok: false, status: null,
  errorCode: "not_configured" }` when the `GOOGLE_OAUTH_*` vars are
  unset.

### Secrecy

The response contains only booleans, the key mode, HTTP statuses,
error codes, session id **prefixes** (12 chars), amounts and
timestamps — never the Stripe secret key, the webhook secret, any
Google OAuth value, any access/refresh token, or a raw Stripe/Google
error body. `scripts/test-payments-debug.mjs` asserts this against
the serialized response.

## Runbook — readout → fix

| Readout | What it means | Fix |
| --- | --- | --- |
| A session shows `recordedBefore: false` → `recordedAfter: true` | The money was real and the records are whole **now** — but the webhook delivery for that payment never landed (or never fired). The reconcile repaired the symptom, not the cause. | In the Stripe dashboard open the webhook endpoint **"Beastmode82420 - Donations"** (`https://beastmode82420.com/api/stripe/webhook`): confirm the URL is exactly that, confirm its event list includes `checkout.session.completed` (plus `checkout.session.expired` and `checkout.session.async_payment_failed`), and read its **delivery attempts** for the missed payments — the attempt log shows whether Stripe never sent it, or sent it and got an error back. |
| `kind: "unknown"` on a paid session | The session did not come from this app's flows (not a hub donation, not a shop checkout) — e.g. a session created in the Stripe dashboard, a payment link, or another app sharing the account. Nothing to reconcile; it is informational only. | No action, unless the money *should* have been the shop's — then check which surface created it. |
| `mail.configured: false` (missing names listed) | The order/offer emails were never wired — every notify helper no-ops silently. This is configuration state, not a mail failure. | Add the named `GOOGLE_OAUTH_*` secrets to the **runtime** Variables & secrets list on `nv-beastmode82420`, following the walkthrough in `docs/EMAIL.md`. |
| `mail.token.errorCode: "invalid_grant"` or `"invalid_client"` (status 400/401) | The refresh token is revoked/expired, or one of the three OAuth values is wrong — Google refused the exchange, so nothing can send. | Re-mint the refresh token (OAuth Playground step in `docs/EMAIL.md`) and re-check all three `GOOGLE_OAUTH_*` values in the **runtime** list — a value pasted in the Build list is invisible to the live app. |
| Webhook deliveries in the Stripe log failing with signature errors (our 400 "Invalid Stripe signature."), while `webhook.configured` reads true *here* | The endpoint's signing secret in Stripe and `STRIPE_WEBHOOK_SECRET` on the Worker disagree — the var is set, but to the wrong value (a common slip: the secret of a *different* endpoint, or of the test-mode endpoint). | In the Stripe dashboard open the live endpoint → **Signing secret** → reveal/copy, and re-paste it into `STRIPE_WEBHOOK_SECRET` in the **runtime** list. Then watch the next delivery succeed — or hit this endpoint to reconcile in the meantime. |
| `stripeError` with 401 / `api_key_expired` | The wired `STRIPE_SECRET_KEY` itself is refused by Stripe — the list (and every checkout creation) fails. | Replace the key in the runtime list with a current restricted/live key from the Stripe dashboard (Developers → API keys). |
| `stripe.keyMode: "test"` | A test-mode key is wired where live money moves (or the reverse when developing). | Wire the key of the intended mode in the runtime list. |

## Tests

`scripts/test-payments-debug.mjs` — 44 checks: admin gate (401 anon
/ garbage, and no Stripe or Google call behind it), unconfigured
shapes, the donation reconcile (824 cents recorded, second call a
no-op, stats `{824, 1}`), the order reconcile (pending → paid,
tracked stock decremented exactly once across two calls, signal
follows), unknown sessions changing nothing, the paid + 3-day
filter, keyMode from prefix, Stripe list failure → `stripeError`
with no raw body, the mail token diagnostic (invalid_grant surfaced,
nothing sent), and secrecy scans of the serialized responses.
