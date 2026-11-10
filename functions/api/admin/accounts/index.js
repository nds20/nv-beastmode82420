// /api/admin/accounts — the owner's admin list (GET) and "add an
// admin" (POST). Multi-admin support, owner direction 2026-11-09:
// the owner adds a second admin (she gets her OWN sign-in) so she
// can add her products herself.
//
// BOTH verbs are OWNER-ONLY. requireAdmin admits any admin; the
// owner gate behind it (isOwnerIdentity in _lib/db.js — the env
// BEASTMODE_ADMIN_USER, or the earliest stored account) answers
// 403 to regular admins. The dashboard hides its Admins section
// when this GET 403s, so a co-admin never sees the controls.
//
// POST creates the account with a SERVER-GENERATED temporary
// password (16 chars, crypto-random, unambiguous alphabet — no
// 0/O/1/l/I to misread when the owner reads it out or texts it).
// The plaintext is returned in THIS response only: it is hashed
// with PBKDF2 like every account password, never stored in
// plaintext, and never listed again. The account is stamped
// must_change, so her first sign-in routes her to set her own
// password (see accounts/change-password.js and docs/ADMINS.md).
//
// Usernames are plain sign-in names — the shop sends no email, so
// an email address used as a username is just a string she types
// at the sign-in page; the charset below deliberately allows '@'.

import { handle, json, fail } from '../../_lib/http.js';
import { requireAdmin, adminCredentials, DUMMY_ADMIN_USER } from '../../_lib/auth.js';
import {
  listAdminAccounts,
  isOwnerIdentity,
  findAccount,
  createAccount,
} from '../../_lib/db.js';

const OWNER_ONLY_MESSAGE = 'Only the owner can manage admins.';

/** requireAdmin + the owner gate; returns the token payload. */
async function requireOwner(context) {
  const payload = await requireAdmin(context);
  if (!(await isOwnerIdentity(context.env, payload.sub))) {
    fail(403, OWNER_ONLY_MESSAGE);
  }
  return payload;
}

export const onRequestGet = handle(async (context) => {
  await requireOwner(context);
  const env = context.env;
  const accounts = await listAdminAccounts(env);
  const { user: envUser } = adminCredentials(env);
  const envName = envUser ? String(envUser).trim().toLowerCase() : '';
  const earliest = accounts.length > 0 ? accounts[0].username.toLowerCase() : '';
  const isOwnerRow = (name) => {
    const lowered = name.toLowerCase();
    return (envName !== '' && lowered === envName) || (earliest !== '' && lowered === earliest);
  };
  return json({
    accounts: accounts.map((a) => ({
      username: a.username,
      createdAt: a.createdAt,
      isOwner: isOwnerRow(a.username),
    })),
  });
});

// ----- Temporary passwords -----------------------------------------------------
// 16 characters from an alphabet with the look-alikes removed
// (0/O, 1/l/I, o), drawn with rejection sampling so every character
// is uniformly random. ~92 bits of entropy — far beyond guessing,
// and it only has to survive until her first sign-in replaces it.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const TEMP_LENGTH = 16;

function generateTemporaryPassword() {
  const limit = Math.floor(256 / TEMP_ALPHABET.length) * TEMP_ALPHABET.length;
  let out = '';
  while (out.length < TEMP_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(TEMP_LENGTH));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += TEMP_ALPHABET[byte % TEMP_ALPHABET.length];
      if (out.length === TEMP_LENGTH) break;
    }
  }
  return out;
}

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]+$/;

export const onRequestPost = handle(async (context) => {
  await requireOwner(context);
  const env = context.env;

  const body = await context.request.json().catch(() => ({}));
  const name = String((body || {}).username || '').trim();

  if (name.length < 3 || name.length > 40) {
    return json({ error: 'Username must be between 3 and 40 characters.' }, 400);
  }
  if (!USERNAME_PATTERN.test(name)) {
    return json(
      { error: 'Username can only use letters, numbers, dots, underscores, dashes and @.' },
      400
    );
  }
  // 'admin' is the built-in DEMO sign-in's name (login precedence:
  // the demo pair is only checked while nothing real exists, but a
  // real account wearing that name would shadow it confusingly).
  if (name.toLowerCase() === DUMMY_ADMIN_USER.toLowerCase()) {
    return json(
      { error: `'${DUMMY_ADMIN_USER}' is reserved for the built-in demo sign-in — choose another username.` },
      400
    );
  }
  const { user: envUser } = adminCredentials(env);
  if (envUser && name.toLowerCase() === String(envUser).trim().toLowerCase()) {
    return json(
      { error: 'That username is the owner sign-in — it already has admin access.' },
      409
    );
  }
  if (await findAccount(env, name)) {
    return json({ error: 'An admin account with that username already exists.' }, 409);
  }

  const temporaryPassword = generateTemporaryPassword();
  const account = await createAccount(env, name, temporaryPassword, { mustChange: 1 });
  return json(
    { username: account.username, temporaryPassword, createdAt: account.createdAt },
    201
  );
});
