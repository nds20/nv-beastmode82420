// POST /api/admin/accounts/change-password — a signed-in admin
// replaces her own stored-account password (multi-admin
// 2026-11-09). This is where the forced first change lands: an
// account the owner added signs in with the temporary password,
// this endpoint verifies it as `currentPassword`, and the new
// password she chooses clears the must_change flag.
//
// NOT owner-gated — any stored-account admin can (and must, on
// first sign-in) do this for HERSELF; the account changed is
// always the token's own username, never a body field.
//
// Sessions without a stored row — the env BEASTMODE_ADMIN_*
// sign-in, or the demo while it exists — have no password here to
// change: 400 naming the place their password actually lives.
//
// Status choice: a WRONG current password is a 400, not a 401.
// The session token is valid; the request body is what failed —
// and adminApi.js treats a 401 on an authed call as "session
// expired" and clears the token, which would log her out for a
// typo. (Asserted in scripts/test-admin-accounts.mjs.)

import { handle, json } from '../../_lib/http.js';
import { requireAdmin } from '../../_lib/auth.js';
import { findAccount, verifyAccount, upsertAdminAccount } from '../../_lib/db.js';

export const onRequestPost = handle(async (context) => {
  const payload = await requireAdmin(context);
  const env = context.env;

  const account = await findAccount(env, payload.sub);
  if (!account) {
    return json(
      { error: "This sign-in uses the site's Cloudflare credentials — change the password there." },
      400
    );
  }

  const body = await context.request.json().catch(() => ({}));
  const { currentPassword, newPassword } = body || {};

  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return json({ error: 'New password must be at least 10 characters.' }, 400);
  }
  if (!(await verifyAccount(env, account.username, currentPassword))) {
    return json({ error: 'Current password is not correct.' }, 400);
  }

  // upsertAdminAccount rewrites salt/hash and writes must_change 0
  // (the holder just chose this password herself) while preserving
  // created_at — the account's age, and thus the owner rule's
  // earliest-account ordering, is untouched.
  await upsertAdminAccount(env, account.username, newPassword);
  return json({ ok: true });
});
