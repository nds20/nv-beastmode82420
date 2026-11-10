# Admins — more than one sign-in for the Shop 824 admin

Owner direction, 2026-11-09: *"I need you to create a separate
login for another admin… so that she can add her products."*

Every admin gets her OWN username and password. Admins share the
same powers (products, orders, customers) — the one thing only the
**owner** can do is manage admins themselves.

## Who counts as the owner

Admin management (the Admins section, and the endpoints behind it)
is gated to owner-level identities. Owner-level means exactly one
of:

1. **The env sign-in** — the username in `BEASTMODE_ADMIN_USER`
   (the Cloudflare "Variables and secrets"), matched
   case-insensitively. This is Nicholas's primary sign-in.
2. **The earliest stored account** — the first row ever created in
   `admin_accounts` (by `created_at`). That's Nicholas's own stored
   account from first-run setup / password recovery. Without this
   half of the rule he would lock himself out of admin management
   whenever he signs in with the stored account instead of the
   Cloudflare one.

Any account the owner adds later is a regular admin: full product
and order powers, but the accounts endpoints answer
`403 — Only the owner can manage admins.` and the dashboard never
shows her the Admins section.

Implementation: `listAdminAccounts` / `isOwnerIdentity` in
`functions/api/_lib/db.js`.

## Adding an admin (the owner's walkthrough)

1. Sign in to the admin and scroll to the **Admins** section of the
   dashboard (it only exists for owner-level sign-ins).
2. Type her username and press **Add Admin**.
   - 3–40 characters; letters, numbers, dots, underscores, dashes
     and `@`.
   - **Her sign-in name can be her email address** — she'll use it
     as her username. The shop sends no email anywhere, so treat
     it as a plain name she types, nothing more.
   - `admin` is refused (that's the built-in demo sign-in's name),
     and so is any name already taken — including the owner's.
3. The page shows her **temporary password exactly once**:
   *"Temporary password for <username>: … — Copy it now, it will
   not be shown again."* It is server-generated (16 characters,
   crypto-random, look-alike characters removed), stored only as a
   PBKDF2 hash, and there is **no way to read it back** — if it's
   lost, remove the admin and add her again.
4. **Send her three things, directly** (text, DM, in person — the
   shop can't email them):
   - the sign-in page: **beastmode82420.com/shop/admin/login**
   - her username
   - the temporary password

## Her first sign-in

She signs in with the temporary password and is routed straight to
a **Set Your Password** page: *"Your admin set you a temporary
password — choose your own to continue."* She enters the temporary
password once as "current", picks her own (10+ characters), and
lands on the dashboard. The temporary password stops working the
moment she saves, and the account's `must_change` flag clears.

After that she signs in like anyone else, and can change her
password any time from the dashboard's **Change password** card.

> **Enforcement honesty note.** The forced stop is enforced by the
> client routing (login reports `mustChangePassword: true`; the UI
> routes her to the set-password page and keeps doing so on later
> visits until she changes it) plus the change endpoint, which
> verifies the current password before accepting a new one. The
> token itself is a normal, fully-valid admin token — v1 does NOT
> block the other admin APIs server-side for a flagged account. A
> holder who deliberately bypassed the web UI could use the
> temporary password against the API until she changes it (or the
> owner removes the account). That is the accepted v1 level; a
> server-side gate is a possible later hardening.

## Removing an admin

In the Admins section, **Remove** next to her name (the confirm
names her). Her account row is deleted and her password stops
working immediately. Two honest limits:

- A token she already holds is a stateless signed token — it
  **cannot be revoked** and stays valid until its 8-hour expiry.
  Removing the account stops future sign-ins, not a live session.
- The owner rows are protected: the env sign-in and the earliest
  stored account both answer
  `400 — The owner account can't be removed.`

## Changing your own password

`POST /api/admin/accounts/change-password` (dashboard → **Change
password**) works for any stored-account admin: current password
verified, new password (10+ characters) replaces it, `must_change`
clears. Two refusals:

- A wrong current password is a **400** (*"Current password is not
  correct."*) — deliberately not a 401: the session is valid, and
  the frontend treats an authed 401 as "session expired" and would
  log her out for a typo.
- The env (Cloudflare) sign-in has no stored password, so it gets
  `400 — This sign-in uses the site's Cloudflare credentials —
  change the password there.` Change `BEASTMODE_ADMIN_PASSWORD`
  in the Worker's runtime Variables and secrets instead.

## The recovery code still rules them all

`ADMIN_RECOVERY_CODE` (see `docs/ADMIN_RECOVERY.md`) resets **any**
stored admin account's password by username — including a
co-admin's. That is by design (it is the owner's master key back
into his own shop), and it is why the code must stay private:
anyone holding it can take over any admin account, owner-level or
not.

## Implementation pointers (for whoever maintains this)

- Endpoints: `functions/api/admin/accounts/index.js` (GET list /
  POST add), `functions/api/admin/accounts/[username].js`
  (DELETE), `functions/api/admin/accounts/change-password.js`;
  routes in `worker/index.js` (the literal `change-password` route
  precedes `:username`).
- Data: `ensureAdminColumns` adds `admin_accounts.must_change`
  lazily (schema in `cloudflare/schema.sql`, ALTER in
  `cloudflare/migration-admins.sql`); `createAccount` gained a
  `{ mustChange }` option; `upsertAdminAccount` always writes the
  flag 0 (recovery and change-password both end with a
  holder-chosen password); `deleteAdminAccount` removes the row.
- UI: the Admins section + Change password card in
  `frontend/src/pages/AdminDashboard.jsx`; forced/voluntary change
  page `frontend/src/pages/AdminSetPassword.jsx` (route
  `/shop/admin/set-password`); `AdminLogin.jsx` routes flagged
  sign-ins there; client helpers in
  `frontend/src/services/adminApi.js`.
- Tests: `node scripts/test-admin-accounts.mjs`.
