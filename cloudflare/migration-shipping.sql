-- Migration: buyer-paid USPS shipping (owner direction 2026-11-09).
--
-- Adds the product measurement columns and the order shipping columns
-- used by functions/api/_lib/shipping.js, _lib/usps.js,
-- POST /api/shipping/quote and the shipping fields in normalizeOrder.
--
-- NOTE — you do not strictly need to run this by hand:
-- functions/api/_lib/db.js (ensureShippingColumns) checks
-- PRAGMA table_info at runtime and ALTERs in any of these columns
-- that are missing, the same lazy pattern the donations table uses.
-- This file exists so the change is documented as SQL (like
-- migration-stripe.sql before it) and so a fresh database can be
-- brought to the same shape explicitly. Running it against a database
-- that already has the columns will error on the duplicate ALTERs —
-- that is expected and harmless; the runtime ensure is the authority.

ALTER TABLE products ADD COLUMN weight_oz REAL;
ALTER TABLE products ADD COLUMN length_in REAL;
ALTER TABLE products ADD COLUMN width_in REAL;
ALTER TABLE products ADD COLUMN height_in REAL;

ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_service TEXT;
ALTER TABLE orders ADD COLUMN shipping_label TEXT;
ALTER TABLE orders ADD COLUMN shipping_weight_oz REAL;
