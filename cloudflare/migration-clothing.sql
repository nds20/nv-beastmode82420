-- Shop 824 — clothing columns for EXISTING databases (2026-11-09).
--
-- Shop 824 is a clothing store now (owner direction 2026-11-09),
-- with fragrance & body care alongside the clothes. Products gain:
--
--   products.brand  TEXT NULL — the clothing brand ("824", a label
--                   name, …). NULL = unbranded / not stated.
--   products.sizes  TEXT NULL — a JSON array of size strings,
--                   e.g. '["S","M","L","XL"]'. NULL = one-size /
--                   sizes not applicable (hats, fragrances, the
--                   test item).
--   products.scent  TEXT NULL — free-text scent / fragrance notes
--                   for perfumes, colognes and deodorant
--                   ("sandalwood & vanilla"). NULL = no scent note.
--
-- Nothing is dropped: the legacy thc / strength / effects / unit
-- columns stay for history; the clothing model just stops using
-- them (see docs/CLOTHING.md and functions/api/_lib/validate.js).
--
-- Fresh installs get these from cloudflare/schema.sql. This file is
-- for a database that already exists (the live beastmode82420-db).
--
-- NOTE: the application ALSO adds these columns lazily at runtime
-- (ensureClothingColumns() in functions/api/_lib/db.js), so in
-- practice the live database gains them on the first request after
-- this code deploys even if nobody runs this file. These ALTERs are
-- the documented, inspectable form of the same change — run them
-- once; if they fail with "duplicate column name", the lazy ensure
-- already did the work and that is fine.
--
-- HOW TO APPLY (from the repo root, Nicholas's Cloudflare login):
--   npx wrangler d1 execute beastmode82420-db --remote --file=cloudflare/migration-clothing.sql
-- or paste the statements into the D1 console for beastmode82420-db.

ALTER TABLE products ADD COLUMN brand TEXT;
ALTER TABLE products ADD COLUMN sizes TEXT;
ALTER TABLE products ADD COLUMN scent TEXT;
