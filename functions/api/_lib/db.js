// Data access for the Cloudflare port — the same stores as the Node
// server (server/src/store.js, ordersStore.js, accounts.js), backed by a
// D1 database bound as `DB` instead of JSON files on disk.
//
// Table/column mapping (see ../../cloudflare/schema.sql):
//   products        one row per product; the JSON-ish fields `effects`
//                   and `tile` are TEXT columns holding JSON strings and
//                   are parsed back into arrays here, so API responses are
//                   byte-for-byte the same shape as the Node server's.
//                   Shipping adds four nullable REAL columns (weight_oz,
//                   length_in, width_in, height_in) — NULL means the
//                   admin has not measured the product and _lib/shipping.js
//                   uses its documented defaults. Inventory (2026-11-09)
//                   adds `stock_qty` / `low_stock_threshold` (INTEGER,
//                   NULL = untracked / default threshold — see
//                   _lib/inventory.js) and `free_shipping` (0/1).
//   orders          one row per order; `items`, `customer` and `payment`
//                   are TEXT columns holding JSON (payment is NULL or a
//                   JSON object with only { method, last4 } — full card
//                   data is never stored, same rule as Node). Stripe
//                   payments add flat columns (migration-stripe.sql):
//                   `payment_status` ('unpaid' | 'pending' | 'paid' |
//                   'payment_failed'), `stripe_session_id`,
//                   `stripe_payment_intent_id`, and `access_token` — a
//                   random per-order secret the buyer's browser holds so
//                   it can read that one order's status and start its
//                   checkout without an account. Shipping (2026-11-09)
//                   adds `shipping_cents` (INTEGER cents — the order's
//                   other money columns are dollars, so the name carries
//                   its unit), `shipping_service`, `shipping_label` and
//                   `shipping_weight_oz`. Inventory adds
//                   `inventory_applied` (0/1: stock has been decremented
//                   for this order — see _lib/inventory.js).
//   admin_accounts  username (case-insensitive PK), salt, hash, created_at
//                   — passwords only ever as PBKDF2 hashes (see auth.js).
//   customers       shopper accounts: incrementing id, name, unique
//                   case-insensitive email, PBKDF2 salt/hash, created_at.
//                   Never seeded — the first registration is customer 1.
//   app_settings    key/value rows; currently holds the generated
//                   customer-token signing secret (see
//                   getCustomerTokenSecret below).
//
// Ids are INTEGER AUTOINCREMENT, matching the Node stores' incrementing
// integer ids.

import {
  newPasswordRecord,
  verifyPassword,
  hashPassword,
  base64Encode,
} from './auth.js';

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// ----- Shipping columns (lazy ensure) -----------------------------------------
//
// The products/orders tables predate shipping (2026-11-09), and this
// tree has no migration runner — the stripe columns landed via a
// hand-run migration-stripe.sql, and donations went further and made
// its table lazily at runtime. Shipping follows the donations pattern:
// every product/order read and write first passes through
// ensureShippingColumns(), which checks PRAGMA table_info and ALTERs
// in any missing column (cached per isolate; cloudflare/schema.sql
// carries the columns for fresh installs and
// cloudflare/migration-shipping.sql documents the same ALTERs for a
// hand-run migration).

const SHIPPING_COLUMNS = {
  products: [
    ['weight_oz', 'REAL'],
    ['length_in', 'REAL'],
    ['width_in', 'REAL'],
    ['height_in', 'REAL'],
  ],
  orders: [
    ['shipping_cents', 'INTEGER NOT NULL DEFAULT 0'],
    ['shipping_service', 'TEXT'],
    ['shipping_label', 'TEXT'],
    ['shipping_weight_oz', 'REAL'],
  ],
};

let shippingColumnsPromise = null;

export function ensureShippingColumns(env) {
  if (!shippingColumnsPromise) {
    shippingColumnsPromise = (async () => {
      for (const [table, columns] of Object.entries(SHIPPING_COLUMNS)) {
        // eslint-disable-next-line no-await-in-loop
        const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const existing = new Set((results || []).map((row) => row.name));
        for (const [name, type] of columns) {
          if (!existing.has(name)) {
            // eslint-disable-next-line no-await-in-loop
            await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
          }
        }
      }
      return true;
    })().catch((err) => {
      // Do not poison the isolate on a transient failure — the next
      // request retries the check (same rule as donations).
      shippingColumnsPromise = null;
      throw err;
    });
  }
  return shippingColumnsPromise;
}

// ----- Inventory columns (lazy ensure) ----------------------------------------
//
// Same lazy pattern as shipping above (owner direction 2026-11-09):
// products gain stock_qty / low_stock_threshold / free_shipping and
// orders gain inventory_applied. NULL stock_qty means the product is
// UNTRACKED — it sells exactly as products always have, with no count
// and no decrement — so every product that exists today stays
// untracked until the owner sets a count. cloudflare/schema.sql
// carries the columns for fresh installs and
// cloudflare/migration-inventory.sql documents the same ALTERs.

const INVENTORY_COLUMNS = {
  products: [
    ['stock_qty', 'INTEGER'],
    ['low_stock_threshold', 'INTEGER'],
    ['free_shipping', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  orders: [
    ['inventory_applied', 'INTEGER NOT NULL DEFAULT 0'],
  ],
};

let inventoryColumnsPromise = null;

export function ensureInventoryColumns(env) {
  if (!inventoryColumnsPromise) {
    inventoryColumnsPromise = (async () => {
      for (const [table, columns] of Object.entries(INVENTORY_COLUMNS)) {
        // eslint-disable-next-line no-await-in-loop
        const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const existing = new Set((results || []).map((row) => row.name));
        for (const [name, type] of columns) {
          if (!existing.has(name)) {
            // eslint-disable-next-line no-await-in-loop
            await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
          }
        }
      }
      return true;
    })().catch((err) => {
      // Same retry rule as the shipping ensure: never poison the isolate.
      inventoryColumnsPromise = null;
      throw err;
    });
  }
  return inventoryColumnsPromise;
}

// ----- Products ---------------------------------------------------------------

export function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    category: row.category,
    type: row.type,
    thc: row.thc,
    strength: row.strength,
    price: row.price,
    unit: row.unit,
    effects: parseJsonColumn(row.effects, []),
    tile: parseJsonColumn(row.tile, ['#374151', '#111827']),
    image: row.image,
    // Shipping measurements (nullable; NULL = unmeasured, the
    // shipping defaults in _lib/shipping.js apply).
    weightOz: row.weight_oz != null ? row.weight_oz : null,
    lengthIn: row.length_in != null ? row.length_in : null,
    widthIn: row.width_in != null ? row.width_in : null,
    heightIn: row.height_in != null ? row.height_in : null,
    // Inventory (nullable; NULL stock = untracked, sells as always).
    // `available` is computed here so every client agrees: untracked
    // products are always available; tracked ones are available while
    // at least one unit remains.
    stockQty: row.stock_qty != null ? Number(row.stock_qty) : null,
    lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : null,
    available: row.stock_qty == null ? true : Number(row.stock_qty) > 0,
    // Free shipping (0/1 in the table): the product is excluded from
    // the shipping package math entirely (see _lib/shipping.js).
    freeShipping: row.free_shipping ? true : false,
  };
}

const PRODUCT_COLUMNS =
  'id, name, subtitle, category, type, thc, strength, price, unit, effects, tile, image, weight_oz, length_in, width_in, height_in, stock_qty, low_stock_threshold, free_shipping';

export async function listProducts(env) {
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const { results } = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY id ASC`
  ).all();
  return results.map(rowToProduct);
}

export async function getProduct(env, id) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return null;
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const row = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`
  )
    .bind(pid)
    .first();
  return rowToProduct(row);
}

function productParams(data) {
  return [
    data.name,
    data.subtitle,
    data.category,
    data.type,
    data.thc,
    data.strength,
    data.price,
    data.unit,
    JSON.stringify(data.effects),
    JSON.stringify(data.tile),
    data.image,
    data.weightOz != null ? data.weightOz : null,
    data.lengthIn != null ? data.lengthIn : null,
    data.widthIn != null ? data.widthIn : null,
    data.heightIn != null ? data.heightIn : null,
    data.stockQty != null ? data.stockQty : null,
    data.lowStockThreshold != null ? data.lowStockThreshold : null,
    data.freeShipping ? 1 : 0,
  ];
}

export async function createProduct(env, data) {
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const result = await env.DB.prepare(
    `INSERT INTO products (name, subtitle, category, type, thc, strength, price, unit, effects, tile, image, weight_oz, length_in, width_in, height_in, stock_qty, low_stock_threshold, free_shipping)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(...productParams(data))
    .run();
  return getProduct(env, result.meta.last_row_id);
}

export async function updateProduct(env, id, data) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return null;
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  await env.DB.prepare(
    `UPDATE products
     SET name = ?, subtitle = ?, category = ?, type = ?, thc = ?, strength = ?,
         price = ?, unit = ?, effects = ?, tile = ?, image = ?,
         weight_oz = ?, length_in = ?, width_in = ?, height_in = ?,
         stock_qty = ?, low_stock_threshold = ?, free_shipping = ?
     WHERE id = ?`
  )
    .bind(...productParams(data), pid)
    .run();
  return getProduct(env, pid);
}

/**
 * Set a product's tracked stock count to an absolute value (the admin
 * stock endpoint's SET mode and its restock path). The caller
 * validates; this writes and returns the fresh product.
 */
export async function setProductStock(env, id, stockQty) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return null;
  await ensureInventoryColumns(env);
  await env.DB.prepare('UPDATE products SET stock_qty = ? WHERE id = ?')
    .bind(Math.max(0, Math.trunc(Number(stockQty)) || 0), pid)
    .run();
  return getProduct(env, pid);
}

/**
 * Decrement a tracked product's stock by `qty`, floored at 0 — one
 * atomic UPDATE, so concurrent payments can oversell by a hair (the
 * placement check in validate.js is the real gate) but can never
 * drive the count negative. Untracked rows (stock_qty NULL) are
 * untouched by the IS NOT NULL guard. See _lib/inventory.js.
 */
export async function decrementProductStock(env, id, qty) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return;
  await ensureInventoryColumns(env);
  await env.DB.prepare(
    'UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ? AND stock_qty IS NOT NULL'
  )
    .bind(Math.max(0, Math.trunc(Number(qty)) || 0), pid)
    .run();
}

/** Point a product at a new image URL (used after an R2 photo upload). */
export async function updateProductImage(env, id, image) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return null;
  await env.DB.prepare('UPDATE products SET image = ? WHERE id = ?')
    .bind(image, pid)
    .run();
  return getProduct(env, pid);
}

export async function removeProduct(env, id) {
  const pid = Number(id);
  if (!Number.isFinite(pid)) return false;
  const result = await env.DB.prepare('DELETE FROM products WHERE id = ?')
    .bind(pid)
    .run();
  return result.meta.changes > 0;
}

// ----- Orders -----------------------------------------------------------------

export function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    items: parseJsonColumn(row.items, []),
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    customer: parseJsonColumn(row.customer, {}),
    payment: parseJsonColumn(row.payment, null),
    status: row.status,
    createdAt: row.created_at,
    seenAt: row.seen_at,
    // Stripe payment lifecycle (columns added by migration-stripe.sql;
    // orders from before it read as 'unpaid' with no session).
    paymentStatus: row.payment_status || 'unpaid',
    stripeSessionId: row.stripe_session_id || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    accessToken: row.access_token || null,
    // Shipping (migration-shipping.sql + lazy ensure above).
    // shipping_cents is INTEGER CENTS in the database — unlike the
    // dollar REALs above — and the API keeps that unit: shippingCents.
    // It is converted to dollars only where it joins the dollar total
    // (validate.js) and back to cents for Stripe (stripe.js reads the
    // field directly). Orders from before shipping read as 0/null.
    shippingCents: row.shipping_cents != null ? Number(row.shipping_cents) : 0,
    shippingService: row.shipping_service || null,
    shippingLabel: row.shipping_label || null,
    shippingWeightOz: row.shipping_weight_oz != null ? Number(row.shipping_weight_oz) : null,
    // Inventory (migration-inventory.sql + lazy ensure): 1 once the
    // order's stock decrement has been applied at its payment commit
    // point — the idempotency flag for _lib/inventory.js. Orders from
    // before inventory read as 0.
    inventoryApplied: row.inventory_applied ? 1 : 0,
  };
}

const ORDER_COLUMNS =
  'id, items, subtotal, tax, total, customer, payment, status, created_at, seen_at, payment_status, stripe_session_id, stripe_payment_intent_id, access_token, shipping_cents, shipping_service, shipping_label, shipping_weight_oz, inventory_applied';

/** All orders, newest first — same as the Node orders store. */
export async function listOrders(env) {
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const { results } = await env.DB.prepare(
    `SELECT ${ORDER_COLUMNS} FROM orders ORDER BY id DESC`
  ).all();
  return results.map(rowToOrder);
}

export async function getOrder(env, id) {
  const oid = Number(id);
  if (!Number.isFinite(oid)) return null;
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const row = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
    .bind(oid)
    .first();
  return rowToOrder(row);
}

/** A random per-order access token (hex) — see the orders mapping note. */
export function newOrderAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createOrder(env, data) {
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const result = await env.DB.prepare(
    `INSERT INTO orders (items, subtotal, tax, total, customer, payment, status, created_at, seen_at, payment_status, stripe_session_id, stripe_payment_intent_id, access_token, shipping_cents, shipping_service, shipping_label, shipping_weight_oz, inventory_applied)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?, NULL, 'unpaid', NULL, NULL, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      JSON.stringify(data.items),
      data.subtotal,
      data.tax,
      data.total,
      JSON.stringify(data.customer),
      data.payment ? JSON.stringify(data.payment) : null,
      new Date().toISOString(),
      newOrderAccessToken(),
      // Shipping money is integer cents end-to-end (see rowToOrder).
      data.shippingCents != null ? Math.round(Number(data.shippingCents)) || 0 : 0,
      data.shippingService || null,
      data.shippingLabel || null,
      data.shippingWeightOz != null ? Number(data.shippingWeightOz) : null,
      // Stock is decremented at the payment commit point, never at
      // insert — every order starts un-applied (see _lib/inventory.js).
      0
    )
    .run();
  return getOrder(env, result.meta.last_row_id);
}

/** Stamp an order's inventory decrement as applied (idempotency flag). */
export async function setOrderInventoryApplied(env, id) {
  const oid = Number(id);
  if (!Number.isFinite(oid)) return;
  await ensureInventoryColumns(env);
  await env.DB.prepare('UPDATE orders SET inventory_applied = 1 WHERE id = ?')
    .bind(oid)
    .run();
}

/**
 * Patch an order's Stripe payment fields. Only the keys present in
 * `patch` are written (camelCase in, snake_case columns out):
 * { paymentStatus, stripeSessionId, stripePaymentIntentId }.
 * Returns the updated order, or null when it does not exist.
 */
export async function updateOrderPayment(env, id, patch) {
  const existing = await getOrder(env, id);
  if (!existing) return null;
  const sets = [];
  const values = [];
  if (patch.paymentStatus !== undefined) {
    sets.push('payment_status = ?');
    values.push(patch.paymentStatus);
  }
  if (patch.stripeSessionId !== undefined) {
    sets.push('stripe_session_id = ?');
    values.push(patch.stripeSessionId);
  }
  if (patch.stripePaymentIntentId !== undefined) {
    sets.push('stripe_payment_intent_id = ?');
    values.push(patch.stripePaymentIntentId);
  }
  if (sets.length === 0) return existing;
  await env.DB.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values, existing.id)
    .run();
  return getOrder(env, existing.id);
}

/** Find the order a Stripe Checkout Session belongs to (webhook lookup). */
export async function findOrderByStripeSessionId(env, sessionId) {
  if (!sessionId) return null;
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const row = await env.DB.prepare(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE stripe_session_id = ?`
  )
    .bind(String(sessionId))
    .first();
  return rowToOrder(row);
}

/**
 * Acknowledge an order: status 'new' -> 'seen', stamping seenAt the first
 * time. Idempotent, like the Node store. Returns null when missing.
 */
export async function markOrderSeen(env, id) {
  const existing = await getOrder(env, id);
  if (!existing) return null;
  if (existing.status !== 'seen') {
    await env.DB.prepare(
      "UPDATE orders SET status = 'seen', seen_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), existing.id)
      .run();
    return getOrder(env, existing.id);
  }
  return existing;
}

/**
 * Orders placed by one signed-in customer, newest first. The link is
 * the `accountId` stamped into the order's customer JSON at placement
 * time when a valid customer token was presented (see ../orders.js) —
 * the live database's orders table has no customer_id column, and this
 * keeps guest orders byte-for-byte what they have always been.
 * (Extension added for the beastmode82420 rebuild; the original shop's
 * API had no customer order list.)
 */
export async function listOrdersForCustomer(env, customerId) {
  const cid = Number(customerId);
  if (!Number.isFinite(cid)) return [];
  await ensureShippingColumns(env);
  await ensureInventoryColumns(env);
  const { results } = await env.DB.prepare(
    `SELECT ${ORDER_COLUMNS} FROM orders
     WHERE json_extract(customer, '$.accountId') = ?
     ORDER BY id DESC`
  )
    .bind(cid)
    .all();
  return results.map(rowToOrder);
}

export async function countNewOrders(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'new'"
  ).first();
  return row ? row.n : 0;
}

// ----- Admin accounts -----------------------------------------------------------

export async function hasAccounts(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_accounts').first();
  return row ? row.n > 0 : false;
}

export async function findAccount(env, username) {
  const wanted = String(username || '').trim();
  if (!wanted) return null;
  // The username column is COLLATE NOCASE, so this match is case-insensitive
  // exactly like the Node accounts store's find().
  return env.DB.prepare(
    'SELECT username, salt, hash, created_at FROM admin_accounts WHERE username = ?'
  )
    .bind(wanted)
    .first();
}

export async function createAccount(env, username, password) {
  const name = String(username || '').trim();
  const { salt, hash } = await newPasswordRecord(password);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO admin_accounts (username, salt, hash, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(name, salt, hash, createdAt)
    .run();
  return { username: name, createdAt };
}

/**
 * Create OR replace a stored admin account — the write path behind
 * password recovery (admin/recovery/reset.js). Same row shape as
 * createAccount; when the username already exists (the primary key is
 * COLLATE NOCASE, so the match is case-insensitive) only its salt/hash
 * are replaced and the original created_at is kept. Returns
 * { username, createdAt, created } — `created` says which happened.
 */
export async function upsertAdminAccount(env, username, password) {
  const name = String(username || '').trim();
  const existing = await findAccount(env, name);
  const { salt, hash } = await newPasswordRecord(password);
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_accounts (username, salt, hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`
  )
    .bind(name, salt, hash, createdAt)
    .run();
  const saved = await findAccount(env, name);
  return {
    username: saved ? saved.username : name,
    createdAt: saved ? saved.created_at : createdAt,
    created: !existing,
  };
}

/** Constant-time credential check against the stored (hashed) accounts. */
export async function verifyAccount(env, username, password) {
  const account = await findAccount(env, username);
  if (!account) {
    // Burn a comparable amount of work so unknown usernames are not
    // trivially distinguishable by timing (same trick as the Node store).
    await hashPassword(password || '', new TextEncoder().encode('unknown-user-salt'));
    return false;
  }
  return verifyPassword(password || '', account.salt, account.hash);
}

// ----- Customers ------------------------------------------------------------------
// The shopper-facing counterpart of the admin accounts above, mirroring
// server/src/customers.js: emails are stored trimmed + lowercased and are
// unique case-insensitively, passwords are PBKDF2 hashes, and NOTHING is
// seeded — the first registration is customer 1.

export function rowToCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Raw row (includes salt/hash) for credential checks; null when absent. */
export async function findCustomerRowByEmail(env, email) {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  return env.DB.prepare(
    'SELECT id, name, email, salt, hash, created_at FROM customers WHERE email = ?'
  )
    .bind(wanted)
    .first();
}

/** Existence check used by registration (duplicate email -> 409). */
export async function findCustomerByEmail(env, email) {
  const row = await findCustomerRowByEmail(env, email);
  return rowToCustomer(row);
}

export async function getCustomerById(env, id) {
  const cid = Number(id);
  if (!Number.isFinite(cid)) return null;
  const row = await env.DB.prepare(
    'SELECT id, name, email, created_at FROM customers WHERE id = ?'
  )
    .bind(cid)
    .first();
  return rowToCustomer(row);
}

/**
 * All customers, newest first — the admin customer list. Only the
 * public columns are selected: salt/hash are never read here, so they
 * can never leak into the response.
 */
export async function listCustomers(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, name, email, created_at FROM customers ORDER BY id DESC'
  ).all();
  return results.map(rowToCustomer);
}

export async function createCustomer(env, { name, email, password }) {
  const { salt, hash } = await newPasswordRecord(password);
  const createdAt = new Date().toISOString();
  const result = await env.DB.prepare(
    'INSERT INTO customers (name, email, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(String(name || '').trim(), normalizeEmail(email), salt, hash, createdAt)
    .run();
  return getCustomerById(env, result.meta.last_row_id);
}

/**
 * Credential check for customer sign-in. Returns the public customer on
 * success, null on any failure — unknown email and wrong password are
 * indistinguishable (no account enumeration).
 */
export async function verifyCustomerCredentials(env, email, password) {
  const row = await findCustomerRowByEmail(env, email);
  if (!row) {
    // Burn a comparable amount of work, same trick as verifyAccount.
    await hashPassword(password || '', new TextEncoder().encode('unknown-customer-salt'));
    return null;
  }
  const ok = await verifyPassword(password || '', row.salt, row.hash);
  return ok ? rowToCustomer(row) : null;
}

// ----- App settings (key/value) ---------------------------------------------------

/** Read one app_settings value; null when the key has never been set. */
export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first();
  return row ? row.value : null;
}

/** Write one app_settings value (insert, or overwrite the existing row). */
export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, String(value))
    .run();
}

// ----- Admin password recovery attempts -----------------------------------------
//
// The failed-attempt counter behind POST /api/admin/recovery/reset: a
// JSON array of epoch-ms timestamps under one app_settings key, pruned
// to a rolling 60-minute window on every read. Deliberately global
// rather than per-username — the recovery code is a single master
// secret, so the guesses worth throttling are guesses at the code.

export const RECOVERY_ATTEMPT_KEY = 'admin_recovery_failed_attempts';
export const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
export const RECOVERY_MAX_FAILURES = 5;

/** Failed recovery-code attempts still inside the rolling window. */
export async function getRecoveryFailures(env, now = Date.now()) {
  const raw = await getSetting(env, RECOVERY_ATTEMPT_KEY);
  let parsed = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) parsed = [];
  return parsed.filter((t) => typeof t === 'number' && now - t < RECOVERY_WINDOW_MS);
}

/** Record one failed attempt (window-pruned); returns the new count. */
export async function recordRecoveryFailure(env, now = Date.now()) {
  const recent = await getRecoveryFailures(env, now);
  recent.push(now);
  await setSetting(env, RECOVERY_ATTEMPT_KEY, JSON.stringify(recent));
  return recent.length;
}

/** A successful reset wipes the counter — the lockout is for guessers. */
export async function clearRecoveryFailures(env) {
  await setSetting(env, RECOVERY_ATTEMPT_KEY, '[]');
}

/**
 * The random secret that signs customer session tokens. It is generated
 * on first use and persisted in the `app_settings` table, so customer
 * tokens work with zero configuration yet cannot be forged from the
 * public source code. Deliberately independent of the admin signing key:
 * the two token audiences never share key material.
 */
export async function getCustomerTokenSecret(env) {
  const read = () =>
    env.DB.prepare("SELECT value FROM app_settings WHERE key = 'customer_token_secret'").first();
  const existing = await read();
  if (existing && existing.value) return existing.value;
  const secret = base64Encode(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('customer_token_secret', ?)"
  )
    .bind(secret)
    .run();
  const saved = await read();
  return saved.value;
}
