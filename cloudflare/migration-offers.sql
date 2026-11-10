-- Shop 824 — Best Offer columns + table for EXISTING databases (2026-11-10).
--
-- Adds make-an-offer support (see docs/OFFERS.md and
-- functions/api/_lib/offers.js):
--
--   products.condition       TEXT NULL — the product's stated state:
--                            'new' | 'used'. NULL = unspecified (the
--                            shop's disclosure treats unspecified
--                            clothes as used). A product marked 'new'
--                            NEVER accepts offers — new items sell
--                            at list price only (owner rule).
--   products.accepts_offers  INTEGER NULL — the admin's explicit
--                            Best Offer switch: 1 = on, 0 = off.
--                            NULL = no explicit choice, and the
--                            computed default applies (ON for priced
--                            items) — so every existing product,
--                            whose row reads NULL/NULL, becomes
--                            offer-eligible automatically with no
--                            data migration at all.
--   offers                   one row per buyer offer. offer_cents is
--                            INTEGER CENTS (the shipping_cents
--                            precedent — the name carries its unit);
--                            status walks pending -> accepted /
--                            declined / expired, and accepted -> paid
--                            when the linked order (order_id) is
--                            paid; access_token is the buyer's
--                            per-offer secret, minted like an
--                            order's.
--
-- Fresh installs get all of this from cloudflare/schema.sql. This
-- file is for a database that already exists (the live
-- beastmode82420-db).
--
-- NOTE: the application ALSO adds the product columns lazily at
-- runtime (ensureOffersColumns() in functions/api/_lib/db.js) and
-- creates the offers table lazily (ensureOffersTable()), so in
-- practice the live database gains everything on the first request
-- after this code deploys even if nobody runs this file. These
-- statements are the documented, inspectable form of the same
-- change — run them once; if a column ALTER fails with "duplicate
-- column name", the lazy ensure already did the work and that is
-- fine.
--
-- HOW TO APPLY (from the repo root, Nicholas's Cloudflare login):
--   npx wrangler d1 execute beastmode82420-db --remote --file=cloudflare/migration-offers.sql
-- or paste the statements into the D1 console for beastmode82420-db.

ALTER TABLE products ADD COLUMN condition TEXT;
ALTER TABLE products ADD COLUMN accepts_offers INTEGER;

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
