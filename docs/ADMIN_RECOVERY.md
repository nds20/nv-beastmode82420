# Admin password recovery — "Forgot password?"

For the owner of beastmode82420.com, when the Shop 824 admin password
stops working. This app has no email in it, so there is no emailed
reset link — recovery uses a **recovery code** only you hold.

## How it works, in one paragraph

You generate a long random secret (`ADMIN_RECOVERY_CODE`) and store
it in the site's Cloudflare settings. On the admin sign-in page, the
**Forgot password?** link opens a form: your username + that code +
a new password (10+ characters). A correct code sets the password
for your **stored admin account** (created on the spot if the
username is new) and signs you straight in. From then on you sign in
with that username + new password — a path that does **not** depend
on the `BEASTMODE_ADMIN_*` secrets, so it keeps working even if
those change or get lost.

## Step 1 — set the recovery code in Cloudflare (one time)

1. Go to **dash.cloudflare.com** → Workers & Pages → the
   **nv-beastmode82420** Worker → **Settings** → **Variables and
   secrets**.
2. ⚠️ **Use the RUNTIME list** — the one that already shows
   `SESSION_SECRET` and the `BEASTMODE_ADMIN_*` entries. The page
   has a second list up in the Build section; secrets saved there
   are build-time only and the live site never sees them.
3. Add a variable:
   - **Name:** `ADMIN_RECOVERY_CODE`
   - **Type:** Secret
   - **Value:** a long random string **you generate** — at least 24
     characters from a password generator. **This code is a master
     key.** Put it straight into Cloudflare and into your password
     manager; never send it in chat, email, or a screenshot.
4. Save / deploy so the Worker picks it up.

Until this exists, the Forgot form answers honestly: *"Password
recovery is not set up yet — add ADMIN_RECOVERY_CODE in the site's
Cloudflare settings."*

## Step 2 — reset your password

1. Go to **beastmode82420.com/shop/admin/login**.
2. Click **Forgot password?**
3. Enter:
   - **Username** — the admin username you want to sign in with
     (an existing stored account gets its password replaced; a new
     username creates the account).
   - **Recovery code** — the `ADMIN_RECOVERY_CODE` value from
     Step 1 (use the eye toggle to check what you pasted).
   - **New password** + **Confirm new password** — 10 characters
     minimum.
4. Submit — you land on the admin dashboard, signed in.

## Step 3 — sign in normally from now on

Use that same username + new password on the regular sign-in page.
It is checked against the site's own account store
(`authSource: 'account'`), independent of the `BEASTMODE_ADMIN_*`
secrets. You can update those secrets later, at leisure — or not at
all. (If you ever sign in with the env secrets again, that's fine
too; env credentials are simply checked first.)

## Security notes

- **The recovery code is a master key.** Anyone holding it can take
  over the admin. Store it in your password manager like a password,
  and treat a leak as a password leak.
- **Rotating it** = edit the `ADMIN_RECOVERY_CODE` secret in the
  same Cloudflare list and save. The old code stops working as soon
  as the new value is live; stored-account passwords are unaffected.
- **Guessing is throttled:** 5 wrong code attempts inside any
  rolling hour make the endpoint answer `429 — Too many tries` to
  *every* attempt (even a correct one) until the window passes. A
  successful reset clears the counter.
- A wrong code gets one generic answer — *"That recovery code is
  not correct."* — that never reveals whether a username exists.

## Implementation pointers (for whoever maintains this)

- Endpoint: `POST /api/admin/recovery/reset`
  (`functions/api/admin/recovery/reset.js`, route in
  `worker/index.js`; code compared with `timingSafeStringEqual`,
  never logged).
- Writes: `upsertAdminAccount` in `functions/api/_lib/db.js`
  (PBKDF2 salt/hash, `created_at` preserved on replace); attempt
  counter in `app_settings` under `admin_recovery_failed_attempts`.
- UI: `frontend/src/pages/AdminForgot.jsx` (route
  `/shop/admin/forgot`), linked from `AdminLogin.jsx`; both pages
  use the shared `frontend/src/components/PasswordField.jsx`
  show/hide eye toggle.
- Tests: `node scripts/test-admin-recovery.mjs`.
