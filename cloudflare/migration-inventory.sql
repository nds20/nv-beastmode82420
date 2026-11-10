-- Shop 824 — inventory columns for EXISTING databases (2026-11-09).
--
-- Adds stock tracking to products and the decrement bookkeeping flag
-- to orders (see docs/INVENTORY.md and functions/api/_lib/inventory.js):
--
--   products.stock_qty            INTEGER NULL — units on hand.
--                                 NULL = UNTRACKED: the product sells
--                                 exactly as products always have, with
--                                 no count and no decrement. Every
--                                 existing product stays NULL until the
--                                 owner sets a count.
--   products.low_stock_threshold  INTEGER NULL — per-product "low
--                                 stock" cutoff. NULL = the default in
--                                 _lib/validate.js
--                                 (DEFAULT_LOW_STOCK_THRESHOLD = 3).
--   products.free_shipping        INTEGER NOT NULL DEFAULT 0 — 1 = the
--                                 product is excluded from the shipping
--                                 package math entirely; a cart of only
--                                 free-shipping products ships for $0.
--   orders.inventory_applied      INTEGER NOT NULL DEFAULT 0 — 1 once
--                                 the order's stock decrement has been
--                                 applied at its payment commit point.
--                                 The idempotency flag that makes
--                                 webhook redeliveries safe.
--
-- Fresh installs get these from cloudflare/schema.sql. This file is
-- for a database that already exists (the live beastmode82420-db).
--
-- NOTE: the application ALSO adds these columns lazily at runtime
-- (ensureInventoryColumns() in functions/api/_lib/db.js), so in
-- practice the live database gains them on the first request after
-- this code deploys even if nobody runs this file. These ALTERs are
-- the documented, inspectable form of the same change — run them
-- once; if they fail with "duplicate column name", the lazy ensure
-- already did the work and that is fine.
--
-- HOW TO APPLY (from the repo root, Nicholas's Cloudflare login):
--   npx wrangler d1 execute beastmode82420-db --remote --file=cloudflare/migration-inventory.sql
-- or paste the statements into the D1 console for beastmode82420-db.

ALTER TABLE products ADD COLUMN stock_qty INTEGER;
ALTER TABLE products ADD COLUMN low_stock_threshold INTEGER;
ALTER TABLE products ADD COLUMN free_shipping INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN inventory_applied INTEGER NOT NULL DEFAULT 0;
