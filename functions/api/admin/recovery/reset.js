// POST /api/admin/recovery/reset — admin "forgot password" recovery.
//
// This app has no email anywhere in it, so recovery cannot mail a
// reset link. Instead the OWNER proves ownership out-of-band with a
// recovery code only he holds: ADMIN_RECOVERY_CODE, a long random
// secret he generates himself and stores in the Worker's RUNTIME
// Variables and secrets (the same list as BEASTMODE_ADMIN_* — see
// docs/ADMIN_RECOVERY.md). A correct code sets a new password for a
// STORED admin account (admin_accounts), creating the account on the
// spot when the username is new, and the response carries a session
// token so he lands signed in, exactly like first-run setup.
//
// Why a stored account: login precedence is (1) env secrets, (2) a
// stored account, (3) demo. The stored account is an INDEPENDENT path
// back in — it keeps working even if the env secrets are later
// changed, lost, or were never the ones he remembers typing.
//
// Honesty rules for this endpoint:
//   - The code is never logged and is compared in constant time.
//   - A wrong code returns ONE generic 403 — the response never hints
//     whether the username exists or which part failed.
//   - Failed code attempts are counted in app_settings (rolling
//     hour); at RECOVERY_MAX_FAILURES the endpoint refuses EVERY
//     attempt with 429 until the window passes. A successful reset
//     clears the counter.
//   - Until ADMIN_RECOVERY_CODE exists, the endpoint answers 503
//     with the exact owner action that enables it — never a fake
//     "check your email" success.

import { handle, json } from '../../_lib/http.js';
import { issueToken, timingSafeStringEqual } from '../../_lib/auth.js';
import {
  upsertAdminAccount,
  getRecoveryFailures,
  recordRecoveryFailure,
  clearRecoveryFailures,
  RECOVERY_MAX_FAILURES,
} from '../../_lib/db.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const expected = env.ADMIN_RECOVERY_CODE || '';
  if (!expected) {
    return json(
      {
        error:
          "Password recovery is not set up yet — add ADMIN_RECOVERY_CODE in the site's Cloudflare settings.",
      },
      503
    );
  }

  const body = await request.json().catch(() => ({}));
  const { username, recoveryCode, newPassword } = body || {};

  const name = String(username || '').trim();
  if (name.length < 3) {
    return json({ error: 'Username must be at least 3 characters.' }, 400);
  }
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return json({ error: 'New password must be at least 10 characters.' }, 400);
  }

  // Rate limit BEFORE the code is checked: after the failure budget is
  // spent inside the window, even the correct code has to wait.
  const failures = await getRecoveryFailures(env);
  if (failures.length >= RECOVERY_MAX_FAILURES) {
    return json({ error: 'Too many tries — wait an hour and try again.' }, 429);
  }

  if (!timingSafeStringEqual(recoveryCode || '', expected)) {
    await recordRecoveryFailure(env);
    return json({ error: 'That recovery code is not correct.' }, 403);
  }

  const account = await upsertAdminAccount(env, name, newPassword);
  await clearRecoveryFailures(env);
  const token = await issueToken(env, account.username);
  return json({ ...token, authSource: 'account' }, account.created ? 201 : 200);
});
