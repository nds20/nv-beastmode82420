// Clothing store tests (2026-11-09) — plain node, no framework:
//
//   node scripts/test-clothing.mjs
//
// Shop 824's conversion from the legacy smoke-shop model to clothing
// + fragrance & body care (owner direction 2026-11-09 — see
// docs/CLOTHING.md). Mirrors the other suites' harness: an in-memory
// D1 stub and the REAL route handlers. Covers:
//   (0) brand/sizes/scent lazy-ensure onto a pre-clothing schema
//       (MUST RUN FIRST — the ensure promises cache per isolate)
//   (a) a hoodie with brand + comma-string sizes and NO type/thc/etc
//       creates clean; sizes parse to an array, brand round-trips
//   (b) the NOTHING item (name + $8.24 + test-item + freeShipping,
//       stockQty null, literally nothing else) creates AND orders
//   (c) a retired legacy category ('flower') -> 400
//   (d) sizes as an array; over-cap input NORMALIZES (12-entry cap,
//       12-char entries, duplicates dropped) — the documented choice
//   (e) order flow: size 'L' snapshots onto the order item and the
//       demo-card commit decrements the per-product stock once; an
//       un-offered size -> 400; one-size items carry no size key
//   (g) a perfume (fragrances + brand + scent, no sizes/type) -> 201
//   (h) a deodorant (body-care + scent) -> 201
//   (k) a candle (candles + scent, owner addition 2026-11-09) -> 201
//       and groups into the Fragrances department
//   (l) jeans (owner addition 2026-11-10): creates via the route,
//       sizes round-trip, groups into Clothes; the editor's label
//       keys and the server allowlist cannot drift apart
//   (i) departments: categoryLabel map + groupByDepartment grouping
//       (the pure helpers Products.jsx renders from)
//   (j) editing a legacy row WITHOUT the retired keys in the payload
//       preserves its stored thc/strength/effects/unit (the editor's
//       non-destructive save)

import {
  listProducts,
  getProduct,
  createProduct,
} from '../functions/api/_lib/db.js';
import { CATEGORIES, normalizeProduct } from '../functions/api/_lib/validate.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import {
  onRequestPost as productsCreate,
} from '../functions/api/products.js';
import {
  onRequestPut as productPut,
} from '../functions/api/products/[id].js';
import { onRequestPost as ordersPost } from '../functions/api/orders.js';
import {
  CATEGORY_LABELS,
  categoryLabel,
  groupByDepartment,
} from '../frontend/src/lib/departments.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ----- In-memory D1 stub -------------------------------------------------------
//
// Same generic approach as test-product-editor.mjs / test-inventory.mjs,
// with the inventory decrement's MAX() shape special-cased (copied from
// test-inventory). `includeClothing: false` produces a PRE-clothing
// database (brand/sizes/scent absent) for the lazy-ensure section.

const PRODUCT_COLS_BASE = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'stock_qty', 'low_stock_threshold', 'free_shipping',
];
const CLOTHING_COLS = ['brand', 'sizes', 'scent'];
const ORDER_COLS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
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
  constructor({ includeClothing = true } = {}) {
    this.includeClothing = includeClothing;
    this.state = { products: [], orders: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0 };
  }

  pragma(table) {
    let cols;
    if (table === 'products') {
      cols = [...PRODUCT_COLS_BASE, ...(this.includeClothing ? CLOTHING_COLS : [])];
    } else {
      cols = ORDER_COLS;
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
    let m = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (m) {
      this.alters.push(`${m[1]}.${m[2]}`);
      return { meta: { changes: 0 } };
    }
    if (/^INSERT INTO products/i.test(stmt)) return this.insertRow('products', stmt, params);
    if (/^INSERT INTO orders/i.test(stmt)) return this.insertRow('orders', stmt, params);
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM products/i.test(stmt) ? 'products' : 'orders';
    let rows = [...this.state[table]];
    if (/WHERE id = \?/.test(stmt)) {
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

// ----- Helpers --------------------------------------------------------------------

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
  return { DB: db, BEASTMODE_ADMIN_SECRET: 'clothing-test-admin-secret', ...extra };
}

async function authHeaders(env) {
  const token = (await issueToken(env, 'boss')).token;
  return { Authorization: `Bearer ${token}` };
}

async function createViaRoute(env, headers, body) {
  const res = await productsCreate(
    ctx(jsonRequest(`${ORIGIN}/api/products`, 'POST', body, headers), env)
  );
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function placeOrder(env, body) {
  const res = await ordersPost(ctx(jsonRequest(`${ORIGIN}/api/orders`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// =====================================================================================
// (0) Lazy ensure onto a pre-clothing schema — MUST RUN FIRST.
// =====================================================================================
{
  const db = new StubDB({ includeClothing: false });
  const env = baseEnv(db);
  await listProducts(env);
  for (const col of ['products.brand', 'products.sizes', 'products.scent']) {
    check(`(0) lazy ensure adds ${col}`, db.alters.includes(col), `alters: ${db.alters.join(', ')}`);
  }
}

// =====================================================================================
// (a) The hoodie: brand + comma-string sizes, NO type/thc/effects/unit.
// =====================================================================================
let hoodie;
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const { status, data } = await createViaRoute(env, headers, {
    name: '824 Hoodie',
    category: 'hoodies',
    brand: '824',
    sizes: 'S,M,L,XL',
    price: 50,
    stockQty: 5,
  });
  hoodie = data;
  check('(a) hoodie create -> 201', status === 201, `status ${status}: ${JSON.stringify(data)}`);
  check('(a) brand stored', data.brand === '824', JSON.stringify(data.brand));
  check(
    '(a) comma-string sizes parsed to an array',
    Array.isArray(data.sizes) && data.sizes.join(',') === 'S,M,L,XL',
    JSON.stringify(data.sizes)
  );
  check('(a) no type required — stored empty', data.type === '', JSON.stringify(data.type));
  check('(a) retired fields default clean (thc null, strength "", effects [])',
    data.thc === null && data.strength === '' && Array.isArray(data.effects) && data.effects.length === 0,
    JSON.stringify({ thc: data.thc, strength: data.strength, effects: data.effects }));
  check('(a) scent defaults null', data.scent === null);
}

// =====================================================================================
// (b) The NOTHING item: name + price + test-item + freeShipping +
// unlimited stock — literally nothing else — and it ORDERS.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const { status, data } = await createViaRoute(env, headers, {
    name: '⚠️ TEST ITEM — YOU WILL NOT RECEIVE ANYTHING ⚠️',
    price: 8.24,
    category: 'test-item',
    stockQty: null,
    freeShipping: true,
  });
  check('(b) nothing item create -> 201', status === 201, `status ${status}: ${JSON.stringify(data)}`);
  check('(b) nothing item is untracked + free-shipping + available',
    data.stockQty === null && data.freeShipping === true && data.available === true);
  check('(b) nothing item needs no sizes/brand/scent',
    Array.isArray(data.sizes) && data.sizes.length === 0 && data.brand === null && data.scent === null);

  const order = await placeOrder(env, {
    items: [{ productId: data.id, qty: 1 }],
    customer: CUSTOMER,
    payment: DEMO_CARD,
  });
  check('(b) nothing item orders -> 201', order.status === 201, `status ${order.status}: ${JSON.stringify(order.data)}`);
  check('(b) order total is 8.24 + 10.2% tax = 9.08, $0 shipping',
    order.data.total === 9.08 && order.data.shippingCents === 0,
    JSON.stringify({ total: order.data.total, shippingCents: order.data.shippingCents }));
  check('(b) order item carries NO size key (one-size product)',
    order.data.items.length === 1 && !('size' in order.data.items[0]),
    JSON.stringify(order.data.items));
}

// =====================================================================================
// (c) Retired legacy categories are rejected.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  for (const legacy of ['flower', 'vapes', 'gummies', 'pouches', 'nic-vapes']) {
    // eslint-disable-next-line no-await-in-loop
    const { status, data } = await createViaRoute(env, headers, {
      name: 'Legacy',
      category: legacy,
      price: 5,
    });
    check(`(c) category '${legacy}' -> 400 naming the clothing list`,
      status === 400 && typeof data.error === 'string' && data.error.includes('fragrances'),
      `status ${status}: ${JSON.stringify(data)}`);
  }
  check('(c) no legacy rows were written', db.state.products.length === 0);
}

// =====================================================================================
// (d) Sizes: array input works; over-cap input NORMALIZES (documented
// choice — parseSizes drops past 12 entries, truncates entries to 12
// chars, de-duplicates; it never 400s on a size list).
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const arr = await createViaRoute(env, headers, {
    name: 'Array Sizes Tee',
    category: 'shirts',
    price: 25,
    sizes: ['XS', 'S', 'M'],
  });
  check('(d) sizes as an array -> stored as-is',
    arr.status === 201 && arr.data.sizes.join(',') === 'XS,S,M',
    JSON.stringify(arr.data.sizes));

  const many = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'];
  const capped = normalizeProduct({
    name: 'Many Sizes', category: 'shirts', price: 10, sizes: many,
  });
  check('(d) 14 sizes normalize to the 12-entry cap', capped.sizes.length === 12, JSON.stringify(capped.sizes));
  const messy = normalizeProduct({
    name: 'Messy Sizes', category: 'shirts', price: 10,
    sizes: 'S, S, , EXTRA-LONG-SIZE-NAME, M',
  });
  check('(d) duplicates + blanks dropped, long entry truncated to 12 chars',
    messy.sizes.join(',') === 'S,EXTRA-LONG-S,M',
    JSON.stringify(messy.sizes));
  const longBrand = normalizeProduct({
    name: 'Brand Cap', category: 'shirts', price: 10, brand: 'B'.repeat(100),
  });
  check('(d) brand truncates to 80 chars', longBrand.brand.length === 80);
}

// =====================================================================================
// (e) Order flow with sizes: the chosen size snapshots onto the order
// item; the demo-card commit decrements the per-product stock once;
// an un-offered size is a 400.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const { data: sized } = await createViaRoute(env, headers, {
    name: 'Sized Hoodie',
    category: 'hoodies',
    brand: '824',
    sizes: ['S', 'M', 'L', 'XL'],
    price: 50,
    stockQty: 5,
  });

  const bad = await placeOrder(env, {
    items: [{ productId: sized.id, qty: 1, size: 'XXL' }],
    customer: CUSTOMER,
    payment: DEMO_CARD,
  });
  check('(e) un-offered size -> 400', bad.status === 400, `status ${bad.status}`);
  check('(e) 400 names the size problem',
    typeof bad.data.error === 'string' && bad.data.error.includes('not offered in size "XXL"'),
    JSON.stringify(bad.data));
  check('(e) rejected order moved no stock', (await getProduct(env, sized.id)).stockQty === 5);

  const order = await placeOrder(env, {
    items: [{ productId: sized.id, qty: 2, size: 'L' }],
    customer: CUSTOMER,
    payment: DEMO_CARD,
  });
  check('(e) sized order -> 201', order.status === 201, `status ${order.status}: ${JSON.stringify(order.data)}`);
  check('(e) order item snapshots size "L"',
    order.data.items.length === 1 && order.data.items[0].size === 'L',
    JSON.stringify(order.data.items));
  check('(e) demo-card commit decremented per-product stock 5 -> 3',
    (await getProduct(env, sized.id)).stockQty === 3);
  check('(e) the order is flagged inventoryApplied', order.data.inventoryApplied === 1);
}

// =====================================================================================
// (g) Perfume: fragrances + brand + scent, no sizes, no type.
// (h) Deodorant: body-care + scent.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const perfume = await createViaRoute(env, headers, {
    name: '824 No. 20 Parfum',
    category: 'fragrances',
    brand: '824',
    scent: 'Sandalwood & vanilla',
    price: 68,
  });
  check('(g) perfume create -> 201', perfume.status === 201, `status ${perfume.status}: ${JSON.stringify(perfume.data)}`);
  check('(g) scent round-trips', perfume.data.scent === 'Sandalwood & vanilla', JSON.stringify(perfume.data.scent));
  check('(g) perfume is one-size (sizes []) and typeless',
    Array.isArray(perfume.data.sizes) && perfume.data.sizes.length === 0 && perfume.data.type === '');

  const deo = await createViaRoute(env, headers, {
    name: '824 Deodorant',
    category: 'body-care',
    scent: 'Fresh linen',
    price: 12,
  });
  check('(h) deodorant create -> 201', deo.status === 201, `status ${deo.status}: ${JSON.stringify(deo.data)}`);
  check('(h) deodorant scent round-trips, brand null',
    deo.data.scent === 'Fresh linen' && deo.data.brand === null,
    JSON.stringify({ scent: deo.data.scent, brand: deo.data.brand }));

  // (k) Candle: its own category on the scented-goods shelf (owner
  // addition 2026-11-09) — scent carries, one-size like the perfume.
  const candle = await createViaRoute(env, headers, {
    name: '824 Candle No. 8',
    category: 'candles',
    scent: 'Cedar & amber',
    price: 24,
  });
  check('(k) candle create -> 201', candle.status === 201, `status ${candle.status}: ${JSON.stringify(candle.data)}`);
  check('(k) candle scent round-trips', candle.data.scent === 'Cedar & amber', JSON.stringify(candle.data.scent));
  check('(k) candle is one-size (sizes [])',
    Array.isArray(candle.data.sizes) && candle.data.sizes.length === 0);
}

// =====================================================================================
// (l) Jeans: the clothes shelf's fifth category (owner addition
// 2026-11-10) — validates through the real route, waist sizes and
// all, exactly like a shirt does.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const jeans = await createViaRoute(env, headers, {
    name: 'Slim Jeans',
    category: 'jeans',
    brand: '824 Denim',
    price: 45,
    sizes: ['30', '32', '34'],
  });
  check('(l) jeans create -> 201', jeans.status === 201, `status ${jeans.status}: ${JSON.stringify(jeans.data)}`);
  check('(l) jeans category round-trips', jeans.data.category === 'jeans', JSON.stringify(jeans.data.category));
  check('(l) jeans sizes round-trip',
    Array.isArray(jeans.data.sizes) && jeans.data.sizes.join(',') === '30,32,34',
    JSON.stringify(jeans.data.sizes));
}

// =====================================================================================
// (i) Departments + labels: the pure helpers the shop page renders.
// =====================================================================================
{
  check('(i) every category id has a clean label',
    Object.entries(CATEGORY_LABELS).every(([, label]) => typeof label === 'string' && label.length > 0) &&
    categoryLabel('shirts') === 'Shirts' &&
    categoryLabel('jeans') === 'Jeans' &&
    categoryLabel('fragrances') === 'Fragrances' &&
    categoryLabel('candles') === 'Candles' &&
    categoryLabel('body-care') === 'Body Care' &&
    categoryLabel('test-item') === 'Test Item' &&
    categoryLabel('other') === 'Other',
    JSON.stringify(CATEGORY_LABELS));

  const catalog = [
    { id: 1, category: 'hoodies' },
    { id: 2, category: 'fragrances' },
    { id: 3, category: 'shirts' },
    { id: 4, category: 'test-item' },
    { id: 5, category: 'body-care' },
  ];
  const groups = groupByDepartment(catalog);
  check('(i) grouping yields departments in display order',
    groups.map((g) => g.label).join(',') === 'Clothes,Fragrances,Body Care,More',
    JSON.stringify(groups.map((g) => g.label)));
  check('(i) within-department order is the input order',
    groups[0].products.map((p) => p.id).join(',') === '1,3',
    JSON.stringify(groups[0].products.map((p) => p.id)));
  check('(i) editor list and server allowlist cannot drift (label keys === CATEGORIES)',
    Object.keys(CATEGORY_LABELS).join(',') === CATEGORIES.join(','),
    `${Object.keys(CATEGORY_LABELS).join(',')} vs ${CATEGORIES.join(',')}`);
  const jeansGroup = groupByDepartment([{ id: 12, category: 'jeans' }]);
  check('(i) jeans group into the Clothes department',
    jeansGroup.length === 1 && jeansGroup[0].label === 'Clothes',
    JSON.stringify(jeansGroup.map((g) => g.label)));
  const candleGroup = groupByDepartment([{ id: 11, category: 'candles' }]);
  check('(i) candles group into the Fragrances department',
    candleGroup.length === 1 && candleGroup[0].label === 'Fragrances',
    JSON.stringify(candleGroup.map((g) => g.label)));
  const single = groupByDepartment([{ id: 9, category: 'hats' }]);
  check('(i) single-department catalog groups to exactly one section',
    single.length === 1 && single[0].label === 'Clothes');
  const unknown = groupByDepartment([{ id: 10, category: 'mystery' }]);
  check('(i) unknown categories land in More',
    unknown.length === 1 && unknown[0].label === 'More');
  check('(i) empty catalog groups to nothing', groupByDepartment([]).length === 0);
}

// =====================================================================================
// (j) Non-destructive edit: a clothing payload that OMITS the retired
// keys leaves a legacy row's stored thc/strength/effects/unit intact
// (normalizeProduct pick() falls back to the stored row), while the
// clothing fields update.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const legacy = await createProduct(env, normalizeProduct({
    name: 'Legacy Row',
    category: 'other',
    type: 'Old Merch',
    price: 15,
    thc: 12,
    strength: 'Legacy Label',
    effects: ['Calm'],
    unit: 'each',
  }));
  check('(j) setup: legacy values stored',
    legacy.strength === 'Legacy Label' && legacy.thc === 12 && legacy.unit === 'each');

  const res = await productPut(
    ctx(
      jsonRequest(
        `${ORIGIN}/api/products/${legacy.id}`,
        'PUT',
        { name: 'Legacy Row, Renamed', brand: '824', sizes: 'S,M' },
        headers
      ),
      env,
      { id: String(legacy.id) }
    )
  );
  const updated = await res.json().catch(() => ({}));
  check('(j) clothing PUT -> 200', res.status === 200, `status ${res.status}: ${JSON.stringify(updated)}`);
  check('(j) clothing fields updated',
    updated.name === 'Legacy Row, Renamed' && updated.brand === '824' && updated.sizes.join(',') === 'S,M',
    JSON.stringify({ name: updated.name, brand: updated.brand, sizes: updated.sizes }));
  check('(j) retired values PRESERVED (not wiped)',
    updated.thc === 12 && updated.strength === 'Legacy Label' &&
    updated.unit === 'each' && Array.isArray(updated.effects) && updated.effects.join(',') === 'Calm',
    JSON.stringify({ thc: updated.thc, strength: updated.strength, unit: updated.unit, effects: updated.effects }));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
