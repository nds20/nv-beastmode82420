// Per-size stock + gender tests (2026-11-10, owner direction:
// "when adding product allow me to select a size allow me to select
// a gender and then allow me to enter a quantity for each size").
//
// Covers: the parseSizeInventory / parseGender normalizers and
// normalizeProduct's precedence rules; the derived sizes /
// stockQty / available in rowToProduct; the LEGACY guarantee (live
// product id 2 — sizes ["Women's L"], stock_qty 1, no gender —
// reads and edits exactly as before until the owner deliberately
// switches it); placement gates (missing size, unknown size, qty
// above THAT SIZE's count); commit decrements hitting only the
// ordered size on BOTH commit paths (demo-card placement and the
// Stripe webhook), floored and idempotent; the admin stock
// endpoint's per-size mode; the Best Offer flow checking and
// decrementing the offer's size; the "No size" sizeless entry
// (fragrances/colognes/deodorant — canonical first, casing-
// normalized, proven through the same gates); and the explicit
// clear-back-to-legacy update. Drives the REAL handlers with a
// StubDB modeled on test-inventory / test-offers. No network, no
// wrangler.
//
// Run: node scripts/test-size-stock.mjs

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

import {
  normalizeProduct,
  parseGender,
  parseSizeInventory,
  GENDERS,
} from '../functions/api/_lib/validate.js';
import {
  createProduct,
  getProduct,
  updateProduct,
} from '../functions/api/_lib/db.js';
import { applyOrderInventory } from '../functions/api/_lib/inventory.js';
import { onRequestPost as ordersPost } from '../functions/api/orders.js';
import { onRequestPost as webhookPost } from '../functions/api/stripe/webhook.js';
import { onRequestPatch as stockPatch } from '../functions/api/admin/products/[id]/stock.js';
import { onRequestPost as offerCreate } from '../functions/api/offers.js';
import { onRequestPost as offerAccept } from '../functions/api/admin/offers/[id]/accept.js';
import { onRequestPost as offerPay } from '../functions/api/offers/[id]/pay.js';
import { issueToken } from '../functions/api/_lib/auth.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`FAIL: ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ----- StubDB (modeled on test-offers.mjs) ---------------------------------

const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'price', 'thc', 'strength',
  'effects', 'unit', 'image', 'tile', 'stock_qty', 'low_stock_threshold',
  'free_shipping', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'brand', 'sizes', 'scent', 'condition', 'accepts_offers',
  'gender', 'size_inventory',
];

const ORDER_COLS = [
  'id', 'items', 'customer', 'subtotal', 'tax', 'total', 'notes', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz', 'inventory_applied',
];

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (const ch of s) {
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((t) => t.trim());
}

class StubDB {
  constructor({ sizeStockCols = true } = {}) {
    this.sizeStockCols = sizeStockCols;
    this.state = { products: [], orders: [], offers: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0, offers: 0 };
  }

  pragma(table) {
    let cols;
    if (table === 'products') {
      cols = this.sizeStockCols
        ? PRODUCT_COLS
        : PRODUCT_COLS.filter((c) => c !== 'gender' && c !== 'size_inventory');
    } else if (table === 'orders') {
      cols = [...ORDER_COLS];
    } else {
      cols = [];
    }
    return { results: cols.map((name) => ({ name })) };
  }

  prepare(sql) {
    const db = this;
    const stmt = sql.trim().replace(/\s+/g, ' ');
    let params = [];
    const api = {
      bind(...args) { params = args; return api; },
      async run() { return db.run(stmt, params); },
      async first() { return db.first(stmt, params); },
      async all() { return db.all(stmt, params); },
    };
    return api;
  }

  insertRow(table, stmt, params) {
    const m = stmt.match(/INSERT INTO \w+ \(([^)]+)\) VALUES \(([\s\S]+)\)/i);
    const cols = m[1].split(',').map((s) => s.trim());
    const tokens = splitTopLevel(m[2]);
    const row = {};
    let p = 0;
    cols.forEach((col, i) => {
      const tok = tokens[i];
      if (tok === '?') row[col] = params[p++];
      else if (/^NULL$/i.test(tok)) row[col] = null;
      else if (/^'[\s\S]*'$/.test(tok)) row[col] = tok.slice(1, -1).replace(/''/g, "'");
      else if (/^-?\d+(\.\d+)?$/.test(tok)) row[col] = Number(tok);
      else row[col] = tok;
    });
    row.id = ++this.lastId[table];
    this.state[table].push(row);
    return { meta: { last_row_id: row.id, changes: 1 } };
  }

  updateRows(table, stmt, params) {
    if (/SET stock_qty = MAX\(0, stock_qty - \?\)/.test(stmt)) {
      const [qty, id] = params;
      const row = this.state.products.find((r) => r.id === Number(id));
      if (row && row.stock_qty != null) {
        row.stock_qty = Math.max(0, row.stock_qty - Number(qty));
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (table === 'offers' && /WHERE order_id = \? AND status = 'accepted'/.test(stmt)) {
      const row = this.state.offers.find(
        (r) => r.order_id === Number(params[0]) && r.status === 'accepted'
      );
      if (row) row.status = 'paid';
      return { meta: { changes: row ? 1 : 0 } };
    }
    const m = stmt.match(/UPDATE \w+ SET ([\s\S]+?) WHERE id = \?/);
    if (!m) throw new Error(`StubDB: unhandled UPDATE: ${stmt}`);
    const assignments = splitTopLevel(m[1]);
    let p = 0;
    const set = {};
    for (const a of assignments) {
      const am = a.match(/^(\w+) = ([\s\S]+)$/);
      const rhs = am[2].trim();
      if (rhs === '?') set[am[1]] = params[p++];
      else if (/^-?\d+$/.test(rhs)) set[am[1]] = Number(rhs);
      else set[am[1]] = rhs;
    }
    const id = Number(params[p]);
    const row = this.state[table].find((r) => r.id === id);
    if (row) Object.assign(row, set);
    return { meta: { changes: row ? 1 : 0 } };
  }

  run(stmt, params) {
    const m = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (m) {
      this.alters.push(`${m[1]}.${m[2]}`);
      return { meta: { changes: 0 } };
    }
    if (/^CREATE TABLE IF NOT EXISTS offers/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^INSERT INTO products/i.test(stmt)) return this.insertRow('products', stmt, params);
    if (/^INSERT INTO orders/i.test(stmt)) return this.insertRow('orders', stmt, params);
    if (/^INSERT INTO offers/i.test(stmt)) return this.insertRow('offers', stmt, params);
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    if (/^UPDATE offers/i.test(stmt)) return this.updateRows('offers', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM products/i.test(stmt)
      ? 'products'
      : /FROM offers/i.test(stmt)
        ? 'offers'
        : 'orders';
    let rows = [...this.state[table]];
    if (/stripe_session_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.stripe_session_id === params[0]);
    } else if (/WHERE order_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.order_id === Number(params[0]));
    } else if (/WHERE id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.id === Number(params[0]));
    }
    if (/ORDER BY id DESC/i.test(stmt)) rows.sort((a, b) => b.id - a.id);
    return rows;
  }

  first(stmt, params) {
    return this.selectRows(stmt, params)[0] || null;
  }

  all(stmt, params) {
    if (/^PRAGMA table_info\((\w+)\)/.test(stmt)) {
      return this.pragma(stmt.match(/PRAGMA table_info\((\w+)\)/)[1]);
    }
    return { results: this.selectRows(stmt, params) };
  }
}

// ----- Helpers ---------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';
const CUSTOMER = {
  fullName: 'Test Buyer',
  phone: '5855550100',
  address: '1 Main St',
  city: 'Rochester',
  zip: '14617',
};
const DEMO_CARD = { cardNumber: '4242424242424242' };

function ctx(request, env, params = {}) {
  return { request, env, params, waitUntil() {} };
}

function jsonRequest(url, method, body, headers = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function baseEnv(db, extra = {}) {
  return { DB: db, BEASTMODE_ADMIN_SECRET: ['size-stock', 'admin', 'secret'].join('-'), ...extra };
}

const webhookEnv = (db) => baseEnv(db, { STRIPE_WEBHOOK_SECRET: ['size-stock', 'webhook', 'secret'].join('-') });

async function adminHeaders(env) {
  const { token } = await issueToken(env, 'boss');
  return { Authorization: `Bearer ${token}` };
}

/** Create the canonical per-size product: S:2 · M:2 · L:2, womens. */
async function makePerSize(env, over = {}) {
  const data = normalizeProduct({
    name: 'Per-Size Tee',
    category: 'shirts',
    price: 50,
    gender: 'womens',
    sizeInventory: [
      { size: 'S', qty: 2 },
      { size: 'M', qty: 2 },
      { size: 'L', qty: 2 },
    ],
    ...over,
  });
  return createProduct(env, data);
}

async function placeOrder(env, body) {
  const res = await ordersPost(ctx(jsonRequest(`${ORIGIN}/api/orders`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function deliverWebhook(env, event) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
  const req = new Request(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${ts},v1=${sig}` },
    body: raw,
  });
  const res = await webhookPost(ctx(req, env));
  return res.status;
}

const sizeQty = (product, size) =>
  (product.sizeInventory || []).find((e) => e.size === size)?.qty;

// =====================================================================================
// (a) parseSizeInventory + parseGender — pure normalization.
// =====================================================================================
{
  check('(a) array form parses', JSON.stringify(parseSizeInventory([
    { size: 'M', qty: 2 }, { size: 'S', qty: 2 }, { size: 'L', qty: 2 },
  ])) === JSON.stringify([
    { size: 'S', qty: 2 }, { size: 'M', qty: 2 }, { size: 'L', qty: 2 },
  ]), JSON.stringify(parseSizeInventory([{ size: 'M', qty: 2 }, { size: 'S', qty: 2 }, { size: 'L', qty: 2 }])));

  check('(a) object-map form parses (string qty coerced)', JSON.stringify(parseSizeInventory({ M: 2, S: '2' })) ===
    JSON.stringify([{ size: 'S', qty: 2 }, { size: 'M', qty: 2 }]));

  check('(a) JSON-string form parses (multipart)', JSON.stringify(parseSizeInventory('{"M":2}')) ===
    JSON.stringify([{ size: 'M', qty: 2 }]));

  check('(a) dedupe is case-insensitive, first casing wins',
    JSON.stringify(parseSizeInventory([{ size: 'm', qty: 1 }, { size: 'M', qty: 9 }])) ===
    JSON.stringify([{ size: 'm', qty: 1 }]));

  check('(a) bad qty entries are dropped (negative, fractional, huge, text)',
    JSON.stringify(parseSizeInventory([
      { size: 'A', qty: -1 }, { size: 'B', qty: 1.5 }, { size: 'C', qty: 10000 },
      { size: 'D', qty: 'two' }, { size: 'E', qty: 3 },
    ])) === JSON.stringify([{ size: 'E', qty: 3 }]));

  check('(a) qty 0 is legitimate (a sold-out size)', JSON.stringify(parseSizeInventory([{ size: 'S', qty: 0 }])) ===
    JSON.stringify([{ size: 'S', qty: 0 }]));

  check('(a) empty / absent / garbage -> null (legacy mode)',
    parseSizeInventory([]) === null && parseSizeInventory({}) === null &&
    parseSizeInventory(null) === null && parseSizeInventory(undefined) === null &&
    parseSizeInventory('not json') === null);

  check('(a) at most 12 entries', (() => {
    const many = {};
    for (let i = 0; i < 15; i += 1) many[`Size${i}`] = 1;
    return parseSizeInventory(many).length === 12;
  })());

  check('(a) canonical order, unknown labels after, stable', (() => {
    const out = parseSizeInventory([{ size: "Women's L", qty: 1 }, { size: 'XL', qty: 1 }, { size: 'S', qty: 1 }]);
    return JSON.stringify(out.map((e) => e.size)) === JSON.stringify(['S', 'XL', "Women's L"]);
  })());

  check('(a) GENDERS is the four allowed values',
    JSON.stringify(GENDERS) === JSON.stringify(['mens', 'womens', 'unisex', 'kids']));
  check('(a) parseGender accepts the four, case-insensitively',
    parseGender('WOMENS') === 'womens' && parseGender(' kids ') === 'kids');
  check('(a) parseGender is forgiving: unknown/blank -> null',
    parseGender('alien') === null && parseGender('') === null && parseGender(null) === null &&
    parseGender(42) === null);
}

// =====================================================================================
// (b) normalizeProduct — precedence + gender + derived fields.
// =====================================================================================
{
  const perSize = normalizeProduct({
    name: 'Tee', category: 'shirts', price: 50,
    sizeInventory: [{ size: 'M', qty: 2 }, { size: 'S', qty: 3 }],
    sizes: ['One Size'], stockQty: 99,
  });
  check('(b) sizeInventory wins: derived sizes in canonical order',
    JSON.stringify(perSize.sizes) === JSON.stringify(['S', 'M']));
  check('(b) sizeInventory wins: stockQty is the sum, inputs ignored',
    perSize.stockQty === 5, `got ${perSize.stockQty}`);
  check('(b) sizeInventory carried as canonical array',
    JSON.stringify(perSize.sizeInventory) === JSON.stringify([{ size: 'S', qty: 3 }, { size: 'M', qty: 2 }]));

  const legacy = normalizeProduct({
    name: 'Tee', category: 'shirts', price: 50, sizes: 'S, M', stockQty: 4,
  });
  check('(b) no sizeInventory -> legacy sizes + stockQty untouched',
    JSON.stringify(legacy.sizes) === JSON.stringify(['S', 'M']) && legacy.stockQty === 4 &&
    legacy.sizeInventory === null);

  const stored = {
    name: 'Tee', category: 'shirts', price: 50, sizes: ['S', 'M'], stockQty: 7,
    sizeInventory: [{ size: 'S', qty: 4 }, { size: 'M', qty: 3 }], gender: 'mens',
  };
  const kept = normalizeProduct({ name: 'Tee Renamed' }, stored);
  check('(b) update WITHOUT sizeInventory keeps the stored map + derived fields',
    JSON.stringify(kept.sizeInventory) === JSON.stringify(stored.sizeInventory) &&
    kept.stockQty === 7 && JSON.stringify(kept.sizes) === JSON.stringify(['S', 'M']));

  const cleared = normalizeProduct(
    { name: 'Tee', sizes: ['One Size'], stockQty: 2, sizeInventory: [] }, stored
  );
  check('(b) explicit empty sizeInventory clears back to legacy',
    cleared.sizeInventory === null && JSON.stringify(cleared.sizes) === JSON.stringify(['One Size']) &&
    cleared.stockQty === 2);

  const gendered = normalizeProduct({ name: 'Tee', category: 'shirts', gender: 'KIDS' });
  check('(b) gender normalizes (case-insensitive)', gendered.gender === 'kids');
  const badGender = normalizeProduct({ name: 'Tee', category: 'shirts', gender: 'alien' });
  check('(b) unknown gender -> null, never a 400', badGender.gender === null);
  const keptGender = normalizeProduct({ name: 'Tee Renamed' }, stored);
  check('(b) gender preserved through an update that omits it', keptGender.gender === 'mens');
}

// =====================================================================================
// (c0) Lazy migration on a pre-feature schema. NOTE: this block
// must stay the FIRST database use in the file — ensureSizeStock-
// Columns memoizes per isolate (the ensureOffersTable pattern), so
// the first env it ever sees is the one whose ALTERs are observable.
// =====================================================================================
{
  const legacyDb = new StubDB({ sizeStockCols: false });
  const legacyEnv = baseEnv(legacyDb);
  await createProduct(legacyEnv, normalizeProduct({ name: 'X', category: 'other' }));
  check('(c0) legacy schema gains BOTH columns via lazy ALTER',
    legacyDb.alters.includes('products.gender') && legacyDb.alters.includes('products.size_inventory'),
    legacyDb.alters.join(','));
}

// =====================================================================================
// (c) Create + read-back: derived fields and the stored row shape.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const created = await makePerSize(env);
  check('(c) create derives sizes from the map',
    JSON.stringify(created.sizes) === JSON.stringify(['S', 'M', 'L']), created.sizes);
  check('(c) create derives stockQty as the sum', created.stockQty === 6, `got ${created.stockQty}`);
  check('(c) available when the sum is positive', created.available === true);
  check('(c) gender exposed', created.gender === 'womens');
  check('(c) sizeInventory exposed as canonical array',
    JSON.stringify(created.sizeInventory) ===
    JSON.stringify([{ size: 'S', qty: 2 }, { size: 'M', qty: 2 }, { size: 'L', qty: 2 }]));

  const row = db.state.products.find((r) => r.id === created.id);
  check('(c) stored stock_qty column is the sum (admin list keeps working)',
    row.stock_qty === 6, `got ${row.stock_qty}`);
  check('(c) stored size_inventory is a JSON object map',
    row.size_inventory === '{"S":2,"M":2,"L":2}', row.size_inventory);
  check('(c) stored sizes column mirrors the map keys',
    row.sizes === '["S","M","L"]', row.sizes);

  const read = await getProduct(env, created.id);
  check('(c) read-back is stable', JSON.stringify(read.sizeInventory) === JSON.stringify(created.sizeInventory) &&
    read.stockQty === 6 && read.gender === 'womens');

  // All-zero map: a real product, out of stock.
  const zero = await makePerSize(env, { sizeInventory: [{ size: 'S', qty: 0 }] });
  check('(c) all-zero map: sizeInventory present, available false',
    zero.sizeInventory !== null && zero.available === false && zero.stockQty === 0);
}

// =====================================================================================
// (d) LEGACY GUARANTEE — the live product id 2 shape must not move.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  // Seed the row exactly as production holds it (created before this
  // feature existed): legacy sizes JSON, stock_qty 1, no new columns.
  db.state.products.push({
    id: 2, name: 'Button down shirt', subtitle: '', category: 'shirts',
    type: '', price: 20, thc: null, strength: '', effects: '[]', unit: '',
    image: null, tile: '["#374151","#111827"]', stock_qty: 1,
    low_stock_threshold: null, free_shipping: 0, weight_oz: 2,
    length_in: 8, width_in: 6, height_in: null, brand: "Madison d'Amélie",
    sizes: '["Women\'s L"]', scent: null, condition: null, accepts_offers: null,
    gender: null, size_inventory: null,
  });
  db.lastId.products = 2;

  const read = await getProduct(env, 2);
  check('(d) legacy read: sizes unchanged', JSON.stringify(read.sizes) === JSON.stringify(["Women's L"]), read.sizes);
  check('(d) legacy read: stockQty unchanged', read.stockQty === 1);
  check('(d) legacy read: gender null, sizeInventory null, available true',
    read.gender === null && read.sizeInventory === null && read.available === true);

  // An unrelated-field edit (brand tweak) with NO size data at all.
  const edited = await updateProduct(env, 2, normalizeProduct({
    name: 'Button down shirt', category: 'shirts', brand: 'Madison',
  }, read));
  check('(d) unrelated edit keeps legacy sizes + stock',
    JSON.stringify(edited.sizes) === JSON.stringify(["Women's L"]) && edited.stockQty === 1 &&
    edited.sizeInventory === null);

  // Gender alone can be set without touching the stock mode.
  const gendered = await updateProduct(env, 2, normalizeProduct({
    name: 'Button down shirt', category: 'shirts', gender: 'womens',
  }, edited));
  check('(d) gender set independently: stock mode untouched',
    gendered.gender === 'womens' && JSON.stringify(gendered.sizes) === JSON.stringify(["Women's L"]) &&
    gendered.stockQty === 1 && gendered.sizeInventory === null);
}

// =====================================================================================
// (e) Placement gates — per-size products.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makePerSize(env);

  const noSize = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }], customer: CUSTOMER,
  });
  check('(e) per-size order with NO size -> 400 asking for a size',
    noSize.status === 400 && /choose a size/i.test(noSize.data.error || ''), JSON.stringify(noSize.data));

  const badSize = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'XXL' }], customer: CUSTOMER,
  });
  check('(e) unknown size -> 400 naming it',
    badSize.status === 400 && (badSize.data.error || '').includes('not offered in size "XXL"'),
    badSize.data.error);

  const over = await placeOrder(env, {
    items: [{ productId: product.id, qty: 3, size: 'M' }], customer: CUSTOMER,
  });
  check('(e) qty above THAT SIZE\'s count -> 400 naming the size',
    over.status === 400 && (over.data.error || '') === '"M" only has 2 left.',
    over.data.error);

  const fits = await placeOrder(env, {
    items: [{ productId: product.id, qty: 2, size: 'M' }], customer: CUSTOMER,
  });
  check('(e) qty within the size count places (unpaid, no commit yet)',
    fits.status === 201 && fits.data.paymentStatus === 'unpaid' &&
    fits.data.items[0].size === 'M', JSON.stringify(fits.data));
  check('(e) placement alone never decrements',
    sizeQty(await getProduct(env, product.id), 'M') === 2);
}

// =====================================================================================
// (f) Demo-card commit: only the ordered size moves; floor; idempotent.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makePerSize(env);

  const order = await placeOrder(env, {
    items: [{ productId: product.id, qty: 2, size: 'M' }],
    customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(f) demo order places', order.status === 201, `got ${order.status}`);
  let after = await getProduct(env, product.id);
  check('(f) demo commit decrements ONLY the ordered size',
    sizeQty(after, 'M') === 0 && sizeQty(after, 'S') === 2 && sizeQty(after, 'L') === 2,
    JSON.stringify(after.sizeInventory));
  check('(f) stock_qty sum follows', after.stockQty === 4);
  check('(f) product still available (other sizes remain)', after.available === true);

  // Re-applying the same order's inventory is a no-op (the
  // inventory_applied flag is the idempotency key, as for legacy).
  // Shape the order the way the real callers do — read back from
  // the DB, flag and all.
  const orderRow = db.state.orders.find((r) => r.id === order.data.id);
  const stored = {
    id: orderRow.id,
    items: JSON.parse(orderRow.items),
    inventoryApplied: orderRow.inventory_applied,
  };
  check('(f) the placed order carries the applied flag', stored.inventoryApplied === 1);
  check('(f) re-apply short-circuits on the flag (returns the order untouched)',
    (await applyOrderInventory(env, stored)) === stored);
  after = await getProduct(env, product.id);
  check('(f) counts unchanged after re-apply', sizeQty(after, 'M') === 0 && after.stockQty === 4);

  const soldOutSize = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'M' }],
    customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(f) the sold-out size now rejects at placement, naming the size',
    soldOutSize.status === 400 && (soldOutSize.data.error || '') === '"M" only has 0 left.',
    soldOutSize.data.error);
}

// =====================================================================================
// (g) Webhook commit: only the ordered size moves; failure events never move it.
// =====================================================================================
{
  const db = new StubDB();
  const env = webhookEnv(db);
  const product = await makePerSize(env);
  const placed = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'L' }], customer: CUSTOMER,
  });
  check('(g) stripe-path order places unpaid', placed.status === 201 && placed.data.paymentStatus === 'unpaid');

  const completed = {
    id: 'evt_sz_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_sz_1', metadata: { order_id: String(placed.data.id) }, payment_intent: 'pi_sz_1' } },
  };
  check('(g) completed webhook 200', (await deliverWebhook(env, completed)) === 200);
  let after = await getProduct(env, product.id);
  check('(g) webhook decrements ONLY the ordered size',
    sizeQty(after, 'L') === 1 && sizeQty(after, 'S') === 2 && sizeQty(after, 'M') === 2 &&
    after.stockQty === 5, JSON.stringify(after.sizeInventory));
  check('(g) redelivered completed webhook 200', (await deliverWebhook(env, completed)) === 200);
  after = await getProduct(env, product.id);
  check('(g) redelivery does NOT decrement twice', sizeQty(after, 'L') === 1 && after.stockQty === 5);

  const doomed = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'S' }], customer: CUSTOMER,
  });
  const expiredStatus = await deliverWebhook(env, {
    id: 'evt_sz_exp', type: 'checkout.session.expired',
    data: { object: { id: 'cs_sz_exp', metadata: { order_id: String(doomed.data.id) } } },
  });
  after = await getProduct(env, product.id);
  check('(g) expired event never decrements',
    expiredStatus === 200 && sizeQty(after, 'S') === 2 && after.stockQty === 5);
}

// =====================================================================================
// (h) Admin stock endpoint — per-size mode.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await adminHeaders(env);
  const product = await makePerSize(env);

  const patchStock = async (id, body) => {
    const res = await stockPatch(ctx(
      jsonRequest(`${ORIGIN}/api/admin/products/${id}/stock`, 'PATCH', body, headers),
      env, { id: String(id) }
    ));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const set = await patchStock(product.id, { size: 'M', stockQty: 5 });
  check('(h) per-size SET writes that size only',
    set.status === 200 && sizeQty(set.data, 'M') === 5 && sizeQty(set.data, 'S') === 2 &&
    set.data.stockQty === 9, JSON.stringify(set.data));

  const adj = await patchStock(product.id, { size: 'M', adjustBy: -2 });
  check('(h) per-size ADJUST moves that size',
    adj.status === 200 && sizeQty(adj.data, 'M') === 3, JSON.stringify(adj.data));

  const floor = await patchStock(product.id, { size: 'M', adjustBy: -99 });
  check('(h) per-size adjust floors at 0', floor.status === 200 && sizeQty(floor.data, 'M') === 0);

  const unknown = await patchStock(product.id, { size: 'XXL', stockQty: 1 });
  check('(h) unknown size -> 400', unknown.status === 400, `got ${unknown.status}`);

  const noSizeSet = await patchStock(product.id, { stockQty: 9 });
  check('(h) per-size product + stockQty without size -> 400 pick-a-size',
    noSizeSet.status === 400 && /pick a size/i.test(noSizeSet.data.error || ''), noSizeSet.data.error);
  const noSizeAdj = await patchStock(product.id, { adjustBy: 1 });
  check('(h) per-size product + adjustBy without size -> 400 pick-a-size',
    noSizeAdj.status === 400 && /pick a size/i.test(noSizeAdj.data.error || ''), noSizeAdj.data.error);

  // Legacy product: a size param is meaningless -> 400; the plain
  // whole-product call keeps working exactly as before.
  const legacy = await createProduct(env, normalizeProduct({
    name: 'Legacy', category: 'shirts', sizes: ['One Size'], stockQty: 4,
  }));
  const legacySize = await patchStock(legacy.id, { size: 'One Size', stockQty: 2 });
  check('(h) size on a legacy product -> 400', legacySize.status === 400, `got ${legacySize.status}`);
  const legacySet = await patchStock(legacy.id, { stockQty: 7 });
  check('(h) legacy whole-product set unchanged',
    legacySet.status === 200 && legacySet.data.stockQty === 7);
}

// =====================================================================================
// (i) Best Offer — accept gates on the offer's size; pay decrements it.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await adminHeaders(env);
  const product = await makePerSize(env, {
    sizeInventory: [{ size: 'S', qty: 0 }, { size: 'M', qty: 2 }],
  });

  const postOffer = async (size, amount) => {
    const res = await offerCreate(ctx(jsonRequest(`${ORIGIN}/api/offers`, 'POST', {
      productId: product.id, offerAmount: amount, size,
      name: 'Test Buyer', email: 'buyer@example.com',
    }), env));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const accept = async (id) => {
    const res = await offerAccept(ctx(
      jsonRequest(`${ORIGIN}/api/admin/offers/${id}/accept`, 'POST', {}, headers),
      env, { id: String(id) }
    ));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const soldOutOffer = await postOffer('S', 40);
  check('(i) offer on a sold-out SIZE of an available product is created',
    soldOutOffer.status === 201, `got ${soldOutOffer.status}: ${JSON.stringify(soldOutOffer.data)}`);
  const soldOutAccept = await accept(soldOutOffer.data.id);
  check('(i) accept refuses when the OFFER\'S SIZE is sold out (409)',
    soldOutAccept.status === 409 && /sold out/i.test(soldOutAccept.data.error || ''),
    JSON.stringify(soldOutAccept.data));

  const goodOffer = await postOffer('M', 40);
  const goodAccept = await accept(goodOffer.data.id);
  check('(i) accept succeeds for an in-stock size', goodAccept.status === 200, `got ${goodAccept.status}`);

  const buyerToken = goodOffer.data.accessToken;
  const payRes = await offerPay(ctx(jsonRequest(
    `${ORIGIN}/api/offers/${goodOffer.data.id}/pay`, 'POST',
    { accessToken: buyerToken, customer: CUSTOMER, payment: DEMO_CARD }
  ), env, { id: String(goodOffer.data.id) }));
  const payData = await payRes.json().catch(() => ({}));
  check('(i) demo pay succeeds', payRes.status === 201, `got ${payRes.status}: ${JSON.stringify(payData)}`);
  const after = await getProduct(env, product.id);
  check('(i) pay decrements ONLY the offer\'s size',
    sizeQty(after, 'M') === 1 && sizeQty(after, 'S') === 0 && after.stockQty === 1,
    JSON.stringify(after.sizeInventory));
  const offerRow = db.state.offers.find((r) => r.id === goodOffer.data.id);
  check('(i) offer flipped to paid', offerRow.status === 'paid', offerRow.status);
}

// =====================================================================================
// (j) Sell-through: one size gone, others buyable; available until sum = 0.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makePerSize(env, {
    sizeInventory: [{ size: 'S', qty: 1 }, { size: 'M', qty: 1 }],
  });
  await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'S' }], customer: CUSTOMER, payment: DEMO_CARD,
  });
  let after = await getProduct(env, product.id);
  check('(j) one size sold out: product still available', after.available === true && sizeQty(after, 'S') === 0);
  const mOrder = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1, size: 'M' }], customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(j) the other size still buys', mOrder.status === 201, `got ${mOrder.status}`);
  after = await getProduct(env, product.id);
  check('(j) sum at 0: product unavailable', after.available === false && after.stockQty === 0);
}

// =====================================================================================
// (k) Frontend + schema wiring (string-level, like the other suites).
// =====================================================================================
{
  const editor = readFileSync(new URL('../frontend/src/components/ProductEditor.jsx', import.meta.url), 'utf8');
  check('(k) editor has the Gender select', editor.includes('id="pe-gender"') && editor.includes('— None —') &&
    editor.includes("Men's") && editor.includes("Women's") && editor.includes('Unisex') && editor.includes('Kids'));
  check('(k) editor has size rows + add button + quick chips',
    editor.includes('＋ Add a size') && editor.includes('QUICK_SIZES') && editor.includes('sizeRows'));
  check('(k) editor quantity-required message is the owner-facing one',
    editor.includes('Give every size a quantity — 0 is fine for sold out.'));
  check('(k) editor duplicate-size error names the size',
    editor.includes('is listed twice'));
  check('(k) editor shows the legacy sizes read-only note',
    editor.includes('Current sizes:') && editor.includes('switch this product to per-size stock'));
  check('(k) editor drops the free-text sizes input', !editor.includes('sizesText') && !editor.includes('pe-sizes'));

  const api = readFileSync(new URL('../frontend/src/services/adminApi.js', import.meta.url), 'utf8');
  check('(k) adminApi sends gender + sizeInventory',
    api.includes('gender: form.gender') && api.includes('sizeInventoryPayload') &&
    api.includes('hadSizeInventory'));

  const detail = readFileSync(new URL('../frontend/src/pages/ProductDetail.jsx', import.meta.url), 'utf8');
  check('(k) detail picker: sold-out sizes disabled + labeled, low counts shown',
    detail.includes('disabled={sizeOut}') && detail.includes('Sold out') &&
    detail.includes('Only ${remaining} left') && detail.includes('qtyCapForSize'));
  check('(k) detail shows the gender row', detail.includes('genderLabel(product.gender)'));

  const card = readFileSync(new URL('../frontend/src/components/ProductCard.jsx', import.meta.url), 'utf8');
  check('(k) card shows the gender label', card.includes('genderLabel(product.gender)'));

  const cart = readFileSync(new URL('../frontend/src/context/CartContext.jsx', import.meta.url), 'utf8');
  check('(k) cart caps per size', cart.includes('qtyCapForSize') && cart.includes('sizeQtyFor'));

  const dash = readFileSync(new URL('../frontend/src/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
  const adminProducts = readFileSync(new URL('../frontend/src/pages/AdminProducts.jsx', import.meta.url), 'utf8');
  check('(k) admin lists show the per-size breakdown',
    dash.includes('`${e.size}:${e.qty}`') && adminProducts.includes('`${e.size}:${e.qty}`'));

  const schema = readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../cloudflare/migration-size-stock.sql', import.meta.url), 'utf8');
  check('(k) schema.sql carries both columns',
    /gender TEXT/.test(schema) && /size_inventory TEXT/.test(schema));
  check('(k) migration file carries both ALTERs',
    migration.includes('ADD COLUMN gender TEXT') && migration.includes('ADD COLUMN size_inventory TEXT'));

  const workerIndex = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  check('(k) no new routes were needed (worker/index.js untouched by this feature)',
    !workerIndex.includes('size-stock'));
}

// =====================================================================================
// (l) "No size" — the sizeless per-size entry (owner direction
// 2026-11-10: "make sure there's an option that says no size" so
// fragrances, colognes and deodorants can carry a quantity with NO
// clothing size). A normal size-inventory key in every respect —
// canonical FIRST, casing-normalized to exactly "No size" — proven
// here through parse, create, placement gates, the demo commit,
// the admin stock endpoint and the offer flow.
// =====================================================================================
{
  // Parse: canonical first position + casing normalization.
  check('(l) "No size" sorts FIRST, before XXS',
    JSON.stringify(parseSizeInventory([
      { size: 'M', qty: 1 }, { size: 'No size', qty: 3 }, { size: 'XXS', qty: 1 },
    ]).map((e) => e.size)) === JSON.stringify(['No size', 'XXS', 'M']));
  check('(l) casing variants normalize to exactly "No size"',
    JSON.stringify(parseSizeInventory([{ size: 'no size', qty: 2 }])) ===
      JSON.stringify([{ size: 'No size', qty: 2 }]) &&
    JSON.stringify(parseSizeInventory([{ size: 'NO SIZE', qty: 2 }])) ===
      JSON.stringify([{ size: 'No size', qty: 2 }]));
  check('(l) casing variants dedupe into ONE canonical entry (first qty wins)',
    JSON.stringify(parseSizeInventory([
      { size: 'no size', qty: 2 }, { size: 'No Size', qty: 9 },
    ])) === JSON.stringify([{ size: 'No size', qty: 2 }]));
  check('(l) "One Size" untouched: still canonical after clothing sizes',
    JSON.stringify(parseSizeInventory([
      { size: 'One Size', qty: 1 }, { size: 'No size', qty: 1 }, { size: 'S', qty: 1 },
    ]).map((e) => e.size)) === JSON.stringify(['No size', 'S', 'One Size']));

  // A fragrance-shaped product: category fragrances, only {"No size": 3}.
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await adminHeaders(env);
  const fragrance = await createProduct(env, normalizeProduct({
    name: 'Vince Camuto Cologne', category: 'fragrances', price: 40,
    brand: 'Vince Camuto', scent: 'bergamot & leather',
    sizeInventory: [{ size: 'No size', qty: 3 }],
  }));
  check('(l) fragrance create: single "No size" entry, derived fields follow',
    JSON.stringify(fragrance.sizeInventory) === JSON.stringify([{ size: 'No size', qty: 3 }]) &&
    JSON.stringify(fragrance.sizes) === JSON.stringify(['No size']) &&
    fragrance.stockQty === 3 && fragrance.available === true,
    JSON.stringify(fragrance.sizeInventory));
  const storedRow = db.state.products.find((r) => r.id === fragrance.id);
  check('(l) stored map key is exactly "No size"',
    storedRow.size_inventory === '{"No size":3}', storedRow.size_inventory);

  // Placement gates: the size-required rule is satisfied BY
  // "No size"; unknown sizes still reject; oversell names the size.
  const missing = await placeOrder(env, {
    items: [{ productId: fragrance.id, qty: 1 }], customer: CUSTOMER,
  });
  check('(l) per-size rule still applies: NO size at all -> 400 choose-a-size',
    missing.status === 400 && /choose a size/i.test(missing.data.error || ''),
    JSON.stringify(missing.data));
  const unknown = await placeOrder(env, {
    items: [{ productId: fragrance.id, qty: 1, size: 'M' }], customer: CUSTOMER,
  });
  check('(l) a clothing size on a No size product -> 400 not offered',
    unknown.status === 400 && (unknown.data.error || '').includes('not offered in size "M"'),
    unknown.data.error);
  const over = await placeOrder(env, {
    items: [{ productId: fragrance.id, qty: 4, size: 'No size' }], customer: CUSTOMER,
  });
  check('(l) oversell -> 400 naming "No size"',
    over.status === 400 && (over.data.error || '') === '"No size" only has 3 left.',
    over.data.error);

  // Commit: qty 2 with size "No size" decrements to 1.
  const bought = await placeOrder(env, {
    items: [{ productId: fragrance.id, qty: 2, size: 'No size' }],
    customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(l) demo order with size "No size" places', bought.status === 201, `got ${bought.status}`);
  check('(l) order line snapshots size "No size"', bought.data.items[0].size === 'No size');
  let after = await getProduct(env, fragrance.id);
  check('(l) commit decrements "No size" 3 -> 1 and stockQty follows',
    sizeQty(after, 'No size') === 1 && after.stockQty === 1 && after.available === true,
    JSON.stringify(after.sizeInventory));

  // Admin stock endpoint restocks "No size" like any size.
  const patchStock = async (id, body) => {
    const res = await stockPatch(ctx(
      jsonRequest(`${ORIGIN}/api/admin/products/${id}/stock`, 'PATCH', body, headers),
      env, { id: String(id) }
    ));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const restock = await patchStock(fragrance.id, { size: 'No size', adjustBy: 2 });
  check('(l) admin stock endpoint restocks "No size" by name',
    restock.status === 200 && sizeQty(restock.data, 'No size') === 3, JSON.stringify(restock.data));

  // Offers carry "No size" through create, accept and pay.
  const offerRes = await offerCreate(ctx(jsonRequest(`${ORIGIN}/api/offers`, 'POST', {
    productId: fragrance.id, offerAmount: 30, size: 'No size',
    name: 'Test Buyer', email: 'buyer@example.com',
  }), env));
  const offerData = await offerRes.json().catch(() => ({}));
  check('(l) offer on a No size product is created carrying the size',
    offerRes.status === 201 && offerData.size === 'No size',
    `got ${offerRes.status}: ${JSON.stringify(offerData)}`);
  const acceptRes = await offerAccept(ctx(
    jsonRequest(`${ORIGIN}/api/admin/offers/${offerData.id}/accept`, 'POST', {}, headers),
    env, { id: String(offerData.id) }
  ));
  check('(l) offer accept succeeds', acceptRes.status === 200, `got ${acceptRes.status}`);
  const payRes = await offerPay(ctx(jsonRequest(
    `${ORIGIN}/api/offers/${offerData.id}/pay`, 'POST',
    { accessToken: offerData.accessToken, customer: CUSTOMER, payment: DEMO_CARD }
  ), env, { id: String(offerData.id) }));
  check('(l) offer pay succeeds', payRes.status === 201, `got ${payRes.status}`);
  after = await getProduct(env, fragrance.id);
  check('(l) offer pay decrements "No size" (3 -> 2)',
    sizeQty(after, 'No size') === 2 && after.stockQty === 2, JSON.stringify(after.sizeInventory));
  const offerRow = db.state.offers.find((r) => r.id === offerData.id);
  check('(l) offer flipped to paid with its size intact',
    offerRow.status === 'paid' && offerRow.size === 'No size', JSON.stringify(offerRow));

  // Frontend wiring: the chip, the helper sentence, the no-picker path.
  const editorSrc = readFileSync(new URL('../frontend/src/components/ProductEditor.jsx', import.meta.url), 'utf8');
  check('(l) editor quick-add chips lead with "No size"',
    editorSrc.includes("const QUICK_SIZES = ['No size', 'XS', 'S', 'M', 'L', 'XL', '2XL'];"));
  check('(l) editor helper names the fragrance path',
    editorSrc.includes('For fragrances, colognes and deodorant, add the No size row with how many you have.'));
  const detailSrc = readFileSync(new URL('../frontend/src/pages/ProductDetail.jsx', import.meta.url), 'utf8');
  check('(l) detail page: single-No-size products skip the picker and auto-submit the size',
    detailSrc.includes('noSizeOnly') && detailSrc.includes('showSizePicker') &&
    detailSrc.includes('effectiveSize'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
