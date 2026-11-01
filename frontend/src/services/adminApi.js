// Client for the Beastmode 82420 admin API (functions/api/admin/*).
//
// The admin token is an HMAC-signed bearer token issued by
// POST /api/admin/login (see functions/api/_lib/auth.js): 8-hour TTL,
// sent back as `Authorization: Bearer <token>` on every admin call.
// It lives in localStorage under its own key — deliberately separate
// from the customer token in customersApi.js, because shoppers and
// admins are different audiences with different tokens.
//
// Errors surface the API's own { error } message (with .status
// attached) so pages can show exactly what the server said — e.g.
// "Invalid credentials" on a failed sign-in — and can treat a 401 as
// "session over: clear the token and go back to the login page."

const TOKEN_KEY = 'beastmode_admin_token';
const AUTH_SOURCE_KEY = 'beastmode_admin_auth_source';

const UNAVAILABLE_MESSAGE =
  'The admin server could not be reached — please try again in a moment.';

export const getAdminToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};

/** Which credential matched at sign-in: 'env' | 'account' | 'demo' | ''. */
export const getAdminAuthSource = () => {
  try {
    return localStorage.getItem(AUTH_SOURCE_KEY) || '';
  } catch {
    return '';
  }
};

function setAdminSession(data) {
  try {
    if (data && data.token) localStorage.setItem(TOKEN_KEY, data.token);
    if (data && data.authSource) {
      localStorage.setItem(AUTH_SOURCE_KEY, data.authSource);
    }
  } catch {
    // Storage unavailable (private mode, quota) — sign-in itself still
    // worked; the session just won't persist across visits.
  }
}

export const clearAdminToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(AUTH_SOURCE_KEY);
  } catch {
    // Nothing to clear.
  }
};

async function adminFetch(path, options = {}, { authed = true } = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getAdminToken();
  if (authed && token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  const data = await response.json().catch(() => null);
  if (data === null) {
    // Something answered, but not the API — e.g. static hosting
    // returning the app's index.html for an unknown path.
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  if (!response.ok) {
    // A 401 on an authenticated call means the token is gone or
    // expired server-side; drop it so the next visit starts clean.
    if (response.status === 401 && authed && token) clearAdminToken();
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function postJson(path, body, options) {
  return adminFetch(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options
  );
}

/**
 * Sign in with the admin credentials.
 * Resolves to { token, expiresAt, authSource } and stores the session.
 * authSource says which credential matched: 'env' (the BEASTMODE_ADMIN_*
 * secrets), 'account' (a stored account from first-run setup), or
 * 'demo' (the built-in fallback login, only while nothing real exists).
 */
export async function adminLogin(username, password) {
  const data = await postJson(
    '/api/admin/login',
    { username, password },
    { authed: false }
  );
  setAdminSession(data);
  return data;
}

/**
 * First-run setup state: { setupRequired, envConfigured, dummyActive }.
 * Drives the login page's "create the first account" offer and the
 * demo-login banner. Public endpoint (no token needed).
 */
export async function fetchSetupStatus() {
  return adminFetch('/api/admin/setup-status', {}, { authed: false });
}

/**
 * Create the FIRST stored admin account (POST /api/admin/setup).
 * Only works while no account exists (409 after that). Resolves to
 * { token, expiresAt, authSource: 'account' } and stores the session,
 * so a successful setup lands signed in.
 */
export async function adminSetup(username, password) {
  const data = await postJson(
    '/api/admin/setup',
    { username, password },
    { authed: false }
  );
  setAdminSession(data);
  return data;
}

/** The admin order inbox: { orders: [...], newCount }, newest first. */
export async function fetchAdminOrders() {
  return adminFetch('/api/admin/orders');
}

/** One order in full (GET /api/admin/orders/:id). */
export async function fetchAdminOrder(id) {
  return adminFetch(`/api/admin/orders/${id}`);
}

/**
 * Acknowledge an order (PATCH /api/admin/orders/:id/seen):
 * status 'new' -> 'seen', stamping seenAt. Resolves to the order.
 */
export async function markAdminOrderSeen(id) {
  return adminFetch(`/api/admin/orders/${id}/seen`, { method: 'PATCH' });
}

/**
 * The registered customers (GET /api/admin/customers):
 * { customers: [{ id, name, email, createdAt }] }, newest first.
 * Public fields only — the endpoint never returns credential material.
 */
export async function fetchAdminCustomers() {
  return adminFetch('/api/admin/customers');
}

/**
 * The product catalog (GET /api/products — the same public list the
 * storefront reads; there is no separate admin list endpoint).
 * Resolves to an array, possibly empty.
 */
export async function fetchAdminProducts() {
  return adminFetch('/api/products', {}, { authed: false });
}
