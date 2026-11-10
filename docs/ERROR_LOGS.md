# Error Logs — the airlock

Owner directive 2026-11-10: when anything errors, the specific
error and what happened must be captured and visible, ending
diagnostic guessing. The motivating case was the product-photo
failure: for a full day the only fact available was the client's
generic "didn't get a usable answer back from the server," because
the failure — a non-JSON answer arriving from somewhere upstream —
was visible ONLY to the browser, and the browser kept no record.
Now every failure leaves a factual row, and the admin reads them
at **Admin → Error Logs** (`/shop/admin/error-logs`).

## What gets captured

One table, `error_logs`, three sources:

| source   | written by | when |
|----------|------------|------|
| `server` | `_lib/http.js` `handle()` | a handler throws a 5xx, or returns a 5xx response |
| `client` | `POST /api/client-errors` | the browser reports a failure only it can see: `network` (fetch threw) or `bad-response` (a non-JSON answer — with its status, content-type, and the first ≤500 bytes of the body) |
| `shield` | `worker/shield-entry.js` | 824 Shield returns a BLOCK (403) |

Each row: `ts`, `request_id`, `source`, `method`, `path`,
`status`, `error_name`, `error_message` (≤500 chars), `detail`
(JSON, ≤1000 chars — stage/context fields: the client's report
parts, a Shield block's scores), `actor`, `user_agent` (≤200
chars).

**Request ids.** Every request through `handle()` is stamped with
a `crypto.randomUUID()` request id: handlers see it as
`context.requestId`, every response carries it in the
`x-request-id` header, and JSON error bodies gain a `requestId`
field. When an admin screen shows a server error message that
carried one, it appends `(ref: <first 8 chars>)` — the
product editor does this today — and the row is findable by that
ref on the Error Logs page. A client report also carries the
request id of the FAILED call when the browser saw one, so the
client row and the server row for the same failure correlate.

**Actor.** Resolved from the VERIFIED bearer payload only:
`admin:<username>`, `customer:<id>`, or `anon`. The token itself
is never stored.

**Handled 4xx errors are NOT logged** — validation failures and
auth gates are the API working as designed. The log is for
failures, not traffic.

**Shield blocks.** `worker/shield-entry.js` imports
`_lib/errorLog.js` (the same relative-import shape
`worker/index.js` already bundles) and, on a `block` decision,
writes a row with `status 403`, `error_name 'ShieldBlock'`,
`error_message` = the decision's reasons joined, and `detail` =
the decision's scores — so "is 824 Shield too strong?" is
answerable from the log: every block, with its reasons, next to
the server and client rows. The write rides `ctx.waitUntil` when
available and the 403 response is byte-identical to before;
`onDecision`'s `console.warn` remains as the live-tail copy.

## Privacy rules (non-negotiable, test-asserted)

A row NEVER contains:

- a request body (the one exception is the `bodyExcerpt` a
  CLIENT chooses to report about a RESPONSE it received — the
  first ≤500 bytes of the non-JSON answer, stored inside
  `detail`),
- an `Authorization` header, a cookie, or any token,
- any secret value (Stripe keys, admin credentials, OAuth
  material) — error messages are the error's own `message`
  string, and the tests push fake secrets through failing routes
  via headers and bodies and assert they appear in no row and no
  response.

## Never-break discipline

Logging can never break the request it describes. `logError()`
swallows all of its own failures and resolves a boolean;
`handle()` routes the write through `context.waitUntil` when the
platform offers it (the Pages shape) and otherwise awaits the
never-rejecting write (the Worker router passes no `waitUntil`).
`scripts/test-error-logs.mjs` scenario (j) proves it against a
database whose every statement throws: healthy handlers still
answer 200, throwing handlers still answer their 500 JSON with a
requestId, and the client intake still answers `{ ok: true }`.

## The pieces

Server:

- `functions/api/_lib/errorLog.js` — the module: lazy table
  ensure (`ensureErrorLogsTable`, the donations/offers pattern),
  `logError` (write + truncation + retention), `describeActor`,
  `listErrorLogs`, `clearErrorLogs`. It imports NOTHING at module
  level; auth/db are imported lazily inside `describeActor` so
  the module stays cycle-free (`auth.js` → `http.js` →
  `errorLog.js`) and importable from `worker/shield-entry.js`.
- `functions/api/_lib/http.js` — `handle()` stamps the request
  id, logs thrown/returned 5xx, injects `requestId` into JSON
  error bodies (≥400), and sets `x-request-id` on every response.
- `functions/api/client-errors.js` — the intake. Requires a valid
  admin OR customer bearer (anon/garbage → 401, nothing written);
  payloads over 8 KB → 413 before parsing; every field validated
  and truncated server-side. Behind 824 Shield like every
  `/api/*` route.
- `functions/api/admin/error-logs.js` — `GET` (requireAdmin;
  `?limit=` default 50, clamped 1..200; newest first; `detail`
  arrives parsed) and `DELETE` (requireAdmin; clears all, answers
  `{ ok, removed }`).
- `worker/index.js` — both routes registered in the Worker route
  table (the deployment is a Worker, not Pages — a route that
  exists only as a file under `functions/` does not exist here).
- `worker/shield-entry.js` — the Shield block write (above).
- `cloudflare/schema.sql` + `cloudflare/migration-error-logs.sql`
  — the table for fresh installs / documentation; at runtime it
  is created lazily, so no migration step is required.

Client:

- `frontend/src/services/adminApi.js` — `adminFetch` reports its
  two coded failures (`network`, `bad-response`) fire-and-forget
  to the intake, with method + URL, the caller's `operation` when
  a caller names one (the photo step passes
  `product-photo-upload`), the answer's status/content-type/body
  excerpt, and the failed call's request id. Reporting never
  throws, is never awaited, and the intake call itself is never
  reported. Errors also gain `.requestId` whenever the server
  provided one (header or body).
- `frontend/src/pages/AdminErrorLogs.jsx` — the page: newest
  first, source badge (SERVER gold / CLIENT / SHIELD), method +
  path, status pill, message; expandable detail (error name,
  request id, actor, user agent, detail JSON); Refresh and
  Clear-logs (with confirm) buttons; an honest empty state.
  Linked from the admin tabs on the Dashboard and Products pages;
  route in `frontend/src/App.jsx`.
- `frontend/src/components/ProductEditor.jsx` — appends
  `(ref: <first 8 of requestId>)` to error messages that carried
  a request id (both the photo-step partial-save message and the
  plain failure message).

## Retention

Newest **500 rows**. Every insert opportunistically prunes the
rest (`DELETE … WHERE id <= (… OFFSET 499)`), so the table is
self-limiting with no cron and no maintenance. Clearing by hand
(the admin page's Clear logs) is for after a fix lands.

## Tests

`scripts/test-error-logs.mjs` — 99 checks: thrown/returned 5xx
capture, 4xx exclusion, request-id plumbing (body + header +
context), intake auth (admin/customer/anon/garbage), 413/400
gates, server-side truncation, list gating + order + limit,
DELETE counts, 500-row retention, the secrecy sweep, the
broken-DB resilience trio, a live Shield-block capture through
the real `shield-entry` fetch (SQLi login → 403 + a `shield`
row), and static wiring checks (worker routes, schema, client
reporting, page + route).

## Rollout checklist — porting the airlock to the other 824 apps

The pattern is deliberately portable. Per app (Friends With
Benefits, nv-sports-app, 824 Bank, SmokeShop — all React +
Workers + D1 apps with a `handle()`-style wrapper and bearer
auth):

1. **Copy the module.** `functions/api/_lib/errorLog.js` goes in
   as-is. Its only app-specific seams are inside
   `describeActor`: the admin verify function and the customer
   token secret source. FWB / sports-app / 824 Bank use
   session-based auth rather than Shop 824's two token families —
   adapt `describeActor` to resolve their session cookie/token to
   their member id, keeping the contract (`admin:`/`customer:`/
   `anon` labels can become `member:` etc. — the page renders the
   string verbatim). SmokeShop is a clone of this engine: the
   file copies unchanged (its admin env names differ, but those
   live in `auth.js`, not here).
2. **Hook the wrapper.** In the app's `handle()` equivalent
   (FWB/sports/bank each have one in their `_lib/http.js` or
   router), add: request-id stamping (`context.requestId`,
   `x-request-id` header, `requestId` in JSON error bodies) +
   the 5xx-only `logError` call with the same waitUntil/await
   discipline. Copy Shop 824's `handle()` body as the reference —
   the delta is ~70 lines and touches nothing else.
3. **Add the two routes** — `functions/api/client-errors.js` and
   `functions/api/admin/error-logs.js` — AND register them in the
   app's Worker router if it has one (sports-app and 824 Bank use
   the same `worker/index.js` route-table shape as this app; FWB
   likewise). Adjust the intake's auth check to the app's admin +
   member tokens.
4. **Shield rows (where Shield wraps the app).** FWB,
   beastmode82420 and the oncology app are Shield-wrapped: add
   the same block-branch write in their `shield-entry.js`
   equivalents (import path identical). Apps without the Shield
   entry simply never produce `shield` rows — the page tolerates
   any source string.
5. **Client reporting.** Port the `adminApi.js` delta: the
   fire-and-forget `reportClientError`, the body-text read in
   place of `.json()` (needed to capture a non-JSON answer's
   excerpt), `.requestId` on errors, and the `operation` option.
   In apps whose client service has a different name, the pattern
   is what matters: report ONLY the two coded failure shapes,
   never server-answered errors, never the intake call itself.
6. **The page.** Copy `AdminErrorLogs.jsx`, retarget its imports
   to the app's client service (`fetchErrorLogs` /
   `clearErrorLogs` helpers come with step 5's port), add the
   route + nav tab in the app's admin shell, and copy the small
   `.error-log-detail` CSS block.
7. **Ref plumbing (optional, per surface).** Wherever the app
   shows a server error to the owner, append `(ref: …)` when the
   error carries a requestId — the editor change here is the
   template.
8. **Schema.** Add the `error_logs` table to the app's
   `cloudflare/schema.sql` (documentation parity — runtime
   creation is lazy, so this is not a deploy gate).
9. **Tests.** Port `scripts/test-error-logs.mjs`, adjusting:
   the StubDB statement set (identical — the module's SQL is
   app-independent), the token issuers in the auth scenarios,
   and the app's own route paths in the static-wiring section.
   Keep the secrecy and broken-DB scenarios verbatim; they are
   the point.

No new secrets, bindings, or infrastructure are needed in any
app: the table is lazy, the intake rides existing auth, and the
whole feature is code-only.
