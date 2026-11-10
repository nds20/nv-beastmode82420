-- Smoke Shop API — D1 schema for the Cloudflare port (Pages Functions).
--
-- Run this ONCE in the D1 console for your database (see README.md in
-- this folder for the full step-by-step), then run seed.sql.
--
-- The tables mirror the Node server's JSON stores one-for-one:
--   products        <- server/data/products.json (seeded from products.seed.json)
--   orders          <- server/data/orders.json
--   admin_accounts  <- server/data/admin-accounts.json
--   customers       <- server/data/customers.json (registered shoppers)
--   app_settings    <- key/value; holds the generated secret that signs
--                      customer session tokens (the Node server keeps the
--                      equivalent inside customers.json)
--
-- Mapping notes:
--   * Ids are INTEGER PRIMARY KEY AUTOINCREMENT, matching the Node
--     stores' incrementing integer ids.
--   * JSON-ish product fields are TEXT columns holding JSON strings:
--       effects  JSON array of strings, e.g. '["Relaxed","Happy"]'
--       tile     JSON array of two hex colors, e.g. '["#ff8c1a","#f5b921"]'
--     The API parses them back into arrays, so responses match the Node
--     server exactly.
--   * price / thc are REAL and NULL means "TBD" — nothing is invented.
--   * Order payloads are TEXT columns holding JSON:
--       items    JSON array of { productId, name, qty, unitPrice, lineTotal }
--       customer JSON object { fullName, phone, address, city, zip, notes }
--                plus, since 2026-11-10, an optional `email` (the
--                order-confirmation address — docs/EMAIL.md); orders
--                without one simply have no email on file.
--       payment  NULL, or JSON { method: 'card', last4 } — ONLY the last
--                four digits are ever stored, never a full card number.
--   * admin_accounts stores PBKDF2-SHA256 password hashes with a
--     per-account salt (base64). Plaintext passwords are never stored.
--     (The Node server uses scrypt; hashes are not interchangeable
--     between the two runtimes.)

CREATE TABLE IF NOT EXISTS products (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  type     TEXT NOT NULL,
  thc      REAL,
  strength TEXT NOT NULL DEFAULT 'THC TBD',
  price    REAL,
  unit     TEXT,
  effects  TEXT NOT NULL DEFAULT '[]',
  tile     TEXT NOT NULL DEFAULT '["#374151","#111827"]',
  image    TEXT,
  -- Shipping measurements (2026-11-09): admin-set, all NULL-able —
  -- NULL means unmeasured and _lib/shipping.js uses its defaults.
  weight_oz REAL,
  length_in REAL,
  width_in  REAL,
  height_in REAL,
  -- Inventory (2026-11-09): stock_qty NULL = UNTRACKED (sells with no
  -- count/decrement — the pre-inventory behavior);
  -- low_stock_threshold NULL = DEFAULT_LOW_STOCK_THRESHOLD (3) in
  -- _lib/validate.js; free_shipping 1 = excluded from the shipping
  -- package math entirely (see _lib/shipping.js).
  stock_qty           INTEGER,
  low_stock_threshold INTEGER,
  free_shipping       INTEGER NOT NULL DEFAULT 0,
  -- Clothing + fragrance & body care (2026-11-09): brand NULL = no
  -- brand; sizes is a JSON array of size strings, NULL = one-size /
  -- not applicable; scent NULL = no scent note. See docs/CLOTHING.md.
  -- (thc/strength/unit/effects above are legacy smoke-shop columns,
  -- kept for history; the clothing model no longer uses them.)
  brand TEXT,
  sizes TEXT,
  scent TEXT,
  -- Best Offer (2026-11-10): condition NULL = unspecified ('new' |
  -- 'used' when set — a product marked 'new' NEVER accepts offers);
  -- accepts_offers NULL = no explicit choice (the computed default
  -- in _lib/db.js applies: ON for priced items), 1 = offers on,
  -- 0 = offers off. See docs/OFFERS.md.
  condition TEXT,
  accepts_offers INTEGER,
  -- Per-size stock + gender (2026-11-10): gender NULL = not stated
  -- ('mens' | 'womens' | 'unisex' | 'kids' when set);
  -- size_inventory is a JSON object mapping size label -> quantity
  -- ('{"Small":2,"Medium":2}'), NULL = legacy stock mode (the sizes
  -- list + the single stock_qty rule the product). See
  -- docs/CLOTHING.md "Sizes, gender & per-size stock".
  gender TEXT,
  size_inventory TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  items      TEXT NOT NULL,
  subtotal   REAL NOT NULL,
  tax        REAL NOT NULL,
  total      REAL NOT NULL,
  customer   TEXT NOT NULL,
  payment    TEXT,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  seen_at    TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  access_token TEXT,
  -- Shipping (2026-11-09): shipping_cents is INTEGER CENTS (the other
  -- money columns are dollar REALs — the name carries the unit);
  -- service/label record what the buyer chose; weight is the quoted
  -- parcel weight in ounces.
  shipping_cents    INTEGER NOT NULL DEFAULT 0,
  shipping_service  TEXT,
  shipping_label    TEXT,
  shipping_weight_oz REAL,
  -- Inventory (2026-11-09): 1 once the order's stock decrement has
  -- been applied at its payment commit point — the idempotency flag
  -- for _lib/inventory.js.
  inventory_applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  username   TEXT PRIMARY KEY COLLATE NOCASE,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Multi-admin (2026-11-09): 1 while the account still runs on an
  -- owner-issued temporary password; login then asks the holder to
  -- set her own (see docs/ADMINS.md). DEFAULT 0 — accounts that
  -- chose their own password are never flagged.
  must_change INTEGER NOT NULL DEFAULT 0
);

-- Customer (shopper) accounts. Ids AUTOINCREMENT from 1 and NO rows are
-- seeded: the first person to register is customer 1. Emails are stored
-- lowercased; the UNIQUE + COLLATE NOCASE combination also enforces
-- case-insensitive uniqueness at the database level. Passwords are
-- PBKDF2-SHA256 salt/hash pairs, never plaintext (see admin note above).
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Key/value settings. Currently one row: the generated
-- 'customer_token_secret' used to sign customer session tokens
-- (created lazily on first register/login — no manual step needed).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Donations (owner direction 2026-11-06): one row per completed
-- Stripe donation to an 824 project, written by the Stripe webhook
-- (metadata.kind = 'donation') and read back ONLY as an aggregate by
-- GET /api/donate/stats. Amounts are integer cents. The session id is
-- UNIQUE so webhook redeliveries record a gift once. The table is
-- also created lazily at runtime (functions/api/_lib/donations.js),
-- so existing databases gain it with no migration step.
CREATE TABLE IF NOT EXISTS donations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT UNIQUE,
  amount_cents      INTEGER NOT NULL,
  project           TEXT NOT NULL,
  donor_email       TEXT,
  created_at        TEXT NOT NULL
);

-- Best Offer (owner direction 2026-11-10): one row per buyer offer
-- on a product (see docs/OFFERS.md and functions/api/_lib/offers.js).
-- offer_cents is INTEGER CENTS (the orders.shipping_cents precedent —
-- the other money columns are dollar REALs, so the name carries its
-- unit). status walks pending -> accepted / declined / expired, and
-- accepted -> paid when the order it produced (order_id) is paid.
-- access_token is the buyer's per-offer secret, minted like an
-- order's. The table is also created lazily at runtime
-- (ensureOffersTable in functions/api/_lib/db.js), so existing
-- databases gain it with no migration step.
CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL,
  size        TEXT,
  offer_cents INTEGER NOT NULL,
  buyer_name  TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  buyer_phone TEXT,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  access_token TEXT,
  order_id    INTEGER,
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  expires_at  TEXT NOT NULL
);

-- Error Logs (owner directive 2026-11-10): the airlock table — one
-- row per captured failure (server 5xx, client-reported browser
-- failures, 824 Shield blocks), read by admins at
-- /shop/admin/error-logs. Facts only: NO request bodies, NO
-- headers, NO tokens or secrets are ever stored (see
-- functions/api/_lib/errorLog.js and docs/ERROR_LOGS.md). Retention
-- is the newest 500 rows, pruned on write. The table is also
-- created lazily at runtime (ensureErrorLogsTable in
-- functions/api/_lib/errorLog.js), so existing databases gain it
-- with no migration step.
CREATE TABLE IF NOT EXISTS error_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  request_id    TEXT,
  source        TEXT NOT NULL,
  method        TEXT,
  path          TEXT,
  status        INTEGER,
  error_name    TEXT,
  error_message TEXT,
  detail        TEXT,
  actor         TEXT,
  user_agent    TEXT
);
