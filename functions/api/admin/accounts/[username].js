// DELETE /api/admin/accounts/:username — remove a co-admin's
// sign-in (owner-only, multi-admin 2026-11-09). Her account row is
// deleted, so her password stops working immediately; tokens are
// stateless HMAC and cannot be revoked, so a token she already
// holds stays valid until its 8-hour expiry — the same v1 limit
// as every other sign-out in this app (see docs/ADMINS.md).
//
// Refusals, checked in this order:
//   - the target is the env owner sign-in (BEASTMODE_ADMIN_USER)
//     -> 400: it lives in Cloudflare, not in the table, and the
//     owner must never be removable from the UI.
//   - the target does not exist -> 404.
//   - the target is the earliest stored account -> 400: that row
//     is owner-level by the owner rule (see _lib/db.js), including
//     when the caller IS that account (self-removal).
//   - the target is the caller -> 400. (Nearly unreachable behind
//     the checks above — owner callers are the env sign-in or the
//     earliest account, both already refused — kept as a guard.)
// Success is a bare 204.

import { handle, json, fail } from '../../_lib/http.js';
import { requireAdmin, adminCredentials } from '../../_lib/auth.js';
import {
  isOwnerIdentity,
  findAccount,
  listAdminAccounts,
  deleteAdminAccount,
} from '../../_lib/db.js';

export const onRequestDelete = handle(async (context) => {
  const payload = await requireAdmin(context);
  const env = context.env;
  if (!(await isOwnerIdentity(env, payload.sub))) {
    fail(403, 'Only the owner can manage admins.');
  }

  const target = String(context.params.username || '').trim();

  const { user: envUser } = adminCredentials(env);
  if (envUser && target.toLowerCase() === String(envUser).trim().toLowerCase()) {
    return json({ error: "The owner account can't be removed." }, 400);
  }

  const account = await findAccount(env, target);
  if (!account) {
    return json({ error: 'Admin account not found.' }, 404);
  }

  const accounts = await listAdminAccounts(env);
  if (
    accounts.length > 0 &&
    accounts[0].username.toLowerCase() === account.username.toLowerCase()
  ) {
    return json({ error: "The owner account can't be removed." }, 400);
  }

  if (payload.sub && payload.sub.toLowerCase() === account.username.toLowerCase()) {
    return json({ error: "You can't remove your own admin account." }, 400);
  }

  await deleteAdminAccount(env, account.username);
  return new Response(null, { status: 204 });
});
