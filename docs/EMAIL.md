# Shop 824 — Email notifications

Directed by Nicholas on 2026-11-10: customers should get an email
when their order is placed, and the admin should get an email when
an offer is made on an item or an item is purchased, so he knows the
moment business happens.

## What sends, and when

All sends are **best-effort**: they run after the database writes
succeed, and a mail failure never changes an endpoint's response,
never blocks checkout, and never throws into the order path.

| Trigger | To | Subject |
| --- | --- | --- |
| Order placed (`POST /api/orders`) | **Customer** (only if an email is on file — see below) | `Your Shop 824 order #<id> is placed` — items (name/size/qty/price), subtotal, tax, shipping, total, payment-status wording, "reply to this email with questions" |
| Order placed (`POST /api/orders`) | **Admin** | `[Shop 824] New order #<id> — $<total>` — customer name/phone/email, items, totals, payment status, link to the admin dashboard |
| Offer placed (`POST /api/offers`) | **Admin only** | `[Shop 824] New offer — $<offer> on <product>` — list price vs offer, size, buyer name/email/phone, note, 72-hour expiry, admin link |
| Order **paid** (Stripe webhook `checkout.session.completed` paid transition; demo-card placements where payment applies at placement) | **Admin only** | `[Shop 824] PAID order #<id> — $<total>` |

The paid email fires inside the same `paymentStatus !== 'paid'`
guard as the inventory commit, so a redelivered webhook can never
send it twice. Donation checkout sessions never trigger it (the
webhook's order branch only). An offer being paid runs through the
normal order path, so the placed pair fires exactly once there too
(test-asserted).

This complements, and does not replace, the canary sale-alert hook
in `docs/ORDER_ALERTS.md` — email is the always-on channel; the hook
remains the test-item watchdog.

## How mail is sent

Through the **Gmail API**, as Nicholas's own Google Workspace
mailbox (`beastmode82420@beastmode82420.com`). Sending as the real
domain mailbox means SPF/DKIM alignment comes free (his Workspace
mail already sends as that domain) and messages land in his Sent
folder. No third-party mail service, no SDK — plain `fetch`, the
`_lib/usps.js` pattern: an OAuth2 refresh-token exchange against
`https://oauth2.googleapis.com/token` (access token cached per
isolate, keyed by client id, refreshed early), then
`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
with a base64url RFC 5322 message. Bodies are plain text in v1.
Headers are sanitized (CR/LF stripped) against injection.

`functions/api/_lib/mail.js`: `mailConfigured(env)`,
`mailConfigStatus(env)`, `sendMail(env, msg)` (never throws),
`sendOrderPlacedEmails`, `sendOfferPlacedEmail`, `sendOrderPaidEmail`.

## Configuration (Cloudflare runtime Variables & Secrets)

Dormant until all three secrets are set — every notify helper no-ops
quietly when unconfigured.

| Name | Type | Notes |
| --- | --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Secret | From the Google Cloud OAuth client below |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret | Same |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Secret | Minted once with scope `https://www.googleapis.com/auth/gmail.send` |
| `SHOP_FROM_EMAIL` | Variable (optional) | Default `beastmode82420@beastmode82420.com` — the sending mailbox (must be the account the refresh token belongs to) |
| `SHOP_ADMIN_EMAIL` | Variable (optional) | Default same — where admin alerts land |
| `SHOP_FROM_NAME` | Variable (optional) | Default `Shop 824` |

**⚠️ The variables must go in the RUNTIME list** — the one that
contains `BEASTMODE_ADMIN_*` — not the Build list (see AGENTS.md;
the Stripe saga proved this twice).

## Owner wiring walkthrough

Prerequisite: the Google Workspace account for
beastmode82420.com must be **active** (trial decisions/billing
settled) — a suspended mailbox cannot send.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
   and create (or pick) a project — any name, e.g. "Shop 824 Mail".
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen** → User type
   **Internal** (Workspace accounts only — keeps the app private to
   the domain) → app name "Shop 824 Mail", support email = the admin
   address → Save.
4. **APIs & Services → Credentials → Create credentials → OAuth
   client ID** → type **Web application** → add Authorized redirect
   URI `https://developers.google.com/oauthplayground` → Create.
   Copy the **Client ID** and **Client secret**.
5. Mint the refresh token: open the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   → gear icon → check **Use your own OAuth credentials** → paste
   the client ID + secret → in Step 1 enter the scope
   `https://www.googleapis.com/auth/gmail.send` → **Authorize APIs**
   → sign in as `beastmode82420@beastmode82420.com` → Step 2
   **Exchange authorization code for tokens** → copy the
   **Refresh token**.
6. In Cloudflare (Worker `nv-beastmode82420` → Settings →
   Variables and secrets, **runtime** list) add the three secrets.
7. Prove it: sign in to the shop admin, then run the test —
   `GET /api/admin/mail-debug` reports `{configured:true}` and a
   `POST` to the same path sends one "Shop 824 mail test" email to
   the admin inbox and returns Gmail's message id.

Never paste any of the three values into chat or commit them.

## Customer email on orders

Orders previously collected no email. `normalizeOrder` now accepts
an optional `customer.email` (stored in the order's customer JSON —
no schema change; a malformed value is a 400). The checkout form
requires it for guests and prefills it for signed-in customers.
Offer payments inject the offer's `buyer_email` automatically.
Orders with no email on file simply get no customer confirmation —
the admin is still alerted with whatever contact details exist.

## Tests

`scripts/test-mail.mjs` — 71 checks: MIME building + base64url
round-trip, header-injection stripping, config matrix, token-cache
reuse, every trigger's recipients/subjects/contents, failure
isolation (Gmail 500 → order still succeeds), webhook redelivery →
no duplicate paid email, demo placement paid email once, offer pay
placed-pair exactly once, checkout email validation, and the
mail-debug endpoint (401 anon; configured/missing reporting; secret
values asserted absent from every response).
