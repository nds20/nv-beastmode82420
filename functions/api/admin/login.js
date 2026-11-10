// POST /api/admin/login — admin sign-in.
//
// Precedence, identical to the Node server: (1) env-var credentials,
// (2) a stored account created via setup, (3) the built-in DEMO login —
// only while neither of the above exists. The first match wins; the
// response says which one matched (authSource) so the UI can warn when
// the demo login was used.

import { handle, json } from '../_lib/http.js';
import {
  isConfigured,
  checkCredentials,
  checkDummyCredentials,
  issueToken,
} from '../_lib/auth.js';
import { hasAccounts, verifyAccount, findAccount } from '../_lib/db.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await request.json().catch(() => ({}));
  const { username, password } = body || {};

  const envReady = isConfigured(env);
  const accountsExist = await hasAccounts(env);
  const dummyEnabled = !envReady && !accountsExist;

  let authSource = null;
  if (envReady && checkCredentials(env, username, password)) {
    authSource = 'env';
  } else if (await verifyAccount(env, username, password)) {
    authSource = 'account';
  } else if (dummyEnabled && checkDummyCredentials(username, password)) {
    authSource = 'demo';
  }

  if (!authSource) return json({ error: 'Invalid credentials' }, 401);
  const token = await issueToken(env, String(username).trim());

  // Forced first change (multi-admin, 2026-11-09): an account the
  // owner added still runs on his TEMPORARY password until its
  // holder sets her own. The token is issued either way — the flag
  // is reported here and the client routes her to the set-password
  // page; v1 enforcement is that client routing plus the change
  // endpoint, NOT an API block (see docs/ADMINS.md).
  if (authSource === 'account') {
    const account = await findAccount(env, username);
    if (account && Number(account.must_change) === 1) {
      return json({ ...token, authSource, mustChangePassword: true });
    }
  }
  return json({ ...token, authSource });
});
