// Inventory tracking tests (2026-11-09) — plain node, no framework:
//
//   node scripts/test-inventory.mjs
//
// Mirrors scripts/test-shipping.mjs: an in-memory D1 stub (the task
// says the database cannot be run here), a mocked fetch for the USPS
// calls in the free-shipping sections, and the REAL route handlers +
// _lib modules. Covers the spec's list:
//   (a) inventory columns lazy-ensure onto a pre-inventory schema
//   (b) product create/update validation of stockQty (+ freeShipping
//       parsing, PUT route acceptance)
//   (c) order placement gate: qty > stock 400s naming availability;
//       qty == stock is fine; placement alone never decrements
//   (d) demo-card order decrements exactly once (repeat apply no-ops)
//   (e) webhook completed decrements once across redelivery;
//       expired / async_payment_failed never decrement
//   (f) untracked products never block and never decrement
//   (g) the decrement floors at 0 when payment lands after a restock
//       race (stock lowered between placement and payment)
//   (h) admin PATCH /api/admin/products/:id/stock — set/adjust,
//       validation, floor, auth
//   (i) rowToProduct availability: 0 -> false, null -> true, 2 -> true
//   (j) free shipping: package math excludes free items; an all-free
//       order charges $0 with no service required even with USPS
//       configured; a mixed order is weighed without the free item.

import { createHmac } from 'node:crypto';

import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  getOrder,
  updateOrderPayment,
  setProductStock,
  rowToProduct,
} from '../functions/api/_lib/db.js';
import { normalizeProduct, DEFAULT_LOW_STOCK_THRESHOLD } from '../functions/api/_lib/validate.js';
import { applyOrderInventory } from '../functions/api/_lib/inventory.js';
import { computePackage, quoteShipping } from '../functions/api/_lib/shipping.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import { onRequestPost as ordersPost } from '../functions/api/orders.js';
import { onRequestPost as webhookPost } from '../functions/api/stripe/webhook.js';
import { onRequestPut as productPut } from '../functions/api/products/[id].js';
import { onRequestPatch as stockPatch } from '../functions/api/admin/products/[id]/stock.js';

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
// Same generic approach as test-shipping.mjs. `includeInventory:
// false` produces a PRE-inventory database (shipping columns present,
// inventory columns absent) for the lazy-ensure section — which must
// run FIRST in this file, because the ensure promises are cached per
// isolate (same caveat as the shipping suite).

const PRODUCT_COLS_BASE = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'brand', 'sizes', 'scent',
];
const INVENTORY_PRODUCT_COLS = ['stock_qty', 'low_stock_threshold', 'free_shipping'];
const ORDER_COLS_BASE = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz',
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
  constructor({ includeInventory = true } = {}) {
    this.includeInventory = includeInventory;
    // offers (Best Offer, 2026-11-10): this suite never creates
    // offers, but the Stripe webhook now also flips a paid order's
    // offer via markOfferPaidByOrderId — the stub models the table
    // as existing-but-empty, exactly what real D1 looks like after
    // ensureOffersTable runs on a shop with no offers.
    this.state = { products: [], orders: [], offers: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0 };
  }

  pragma(table) {
    let cols;
    if (table === 'products') {
      cols = [...PRODUCT_COLS_BASE, ...(this.includeInventory ? INVENTORY_PRODUCT_COLS : [])];
    } else {
      cols = [...ORDER_COLS_BASE, ...(this.includeInventory ? ['inventory_applied'] : [])];
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
    // The inventory decrement is its own SQL shape (scalar MAX).
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
    if (/^CREATE TABLE IF NOT EXISTS offers/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^UPDATE offers/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM offers/i.test(stmt)
      ? 'offers'
      : /FROM products/i.test(stmt) ? 'products' : 'orders';
    let rows = [...this.state[table]];
    if (/stripe_session_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.stripe_session_id === params[0]);
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

// ----- Fetch mock (USPS only) ---------------------------------------------------

const USPS_BASE = 'https://usps.test';
let uspsPriceCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(USPS_BASE)) {
    if (u.endsWith('/oauth2/v3/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok-inv-1', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/prices/v3/base-rates/search')) {
      const body = JSON.parse(init.body);
      uspsPriceCalls.push(body);
      const price = body.mailClass === 'PRIORITY_MAIL' ? 12.4 : 9.31;
      return new Response(
        JSON.stringify({ totalBasePrice: price, rates: [{ price, zone: '4' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  }
  return realFetch(url, init);
};

// ----- Helpers --------------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';
const CUSTOMER = {
  fullName: 'Test Buyer',
  phone: '5855550100',
  address: '1 Main St',
  city: 'Rochester',
  zip: '14617',
};

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
  return { DB: db, BEASTMODE_ADMIN_SECRET: 'inv-test-admin-secret', ...extra };
}

function uspsEnv(db) {
  return baseEnv(db, {
    USPS_CLIENT_ID: 'cid-inv',
    USPS_CLIENT_SECRET: 'csecret-inv',
    USPS_API_BASE: USPS_BASE,
    USPS_ORIGIN_ZIP: '14617',
  });
}

async function makeProduct(env, over = {}) {
  const data = normalizeProduct({
    name: 'Widget',
    category: 'hoodies',
    type: 'Test',
    price: 10,
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

const webhookEnv = (db) => baseEnv(db, { STRIPE_WEBHOOK_SECRET: 'whsec_inv_test' });

// =====================================================================================
// (a) Lazy ensure onto a pre-inventory schema — MUST RUN FIRST (per-isolate
// ensure cache; see the note above the stub).
// =====================================================================================
{
  const db = new StubDB({ includeInventory: false });
  const env = baseEnv(db);
  await listProducts(env);
  for (const col of ['products.stock_qty', 'products.low_stock_threshold', 'products.free_shipping', 'orders.inventory_applied']) {
    check(`(a) lazy ensure adds ${col}`, db.alters.includes(col), `alters: ${db.alters.join(', ')}`);
  }
}

// =====================================================================================
// (i) rowToProduct availability — pure mapping.
// =====================================================================================
{
  const baseRow = {
    id: 1, name: 'W', subtitle: '', category: 'hoodies', type: 'T', thc: null,
    strength: '', price: 5, unit: 'each', effects: '[]', tile: '[]', image: null,
    weight_oz: null, length_in: null, width_in: null, height_in: null,
    stock_qty: 0, low_stock_threshold: null, free_shipping: 0,
  };
  check('(i) stock 0 -> available false', rowToProduct(baseRow).available === false);
  check('(i) stock null -> available true', rowToProduct({ ...baseRow, stock_qty: null }).available === true);
  check('(i) stock 2 -> available true', rowToProduct({ ...baseRow, stock_qty: 2 }).available === true);
  check('(i) stockQty/lowStockThreshold exposed as numbers/null',
    rowToProduct({ ...baseRow, stock_qty: 2 }).stockQty === 2 &&
    rowToProduct({ ...baseRow, stock_qty: 2 }).lowStockThreshold === null);
  check('(i) freeShipping maps 1 -> true, 0 -> false',
    rowToProduct({ ...baseRow, free_shipping: 1 }).freeShipping === true &&
    rowToProduct(baseRow).freeShipping === false);
  check('(i) DEFAULT_LOW_STOCK_THRESHOLD is 3', DEFAULT_LOW_STOCK_THRESHOLD === 3);
}

// =====================================================================================
// (b) Product validation + create/update persistence + PUT route.
// =====================================================================================
{
  const throws400 = (fn) => {
    try { fn(); return false; } catch (err) { return err && err.status === 400; }
  };
  const base = { name: 'W', category: 'hoodies', type: 'T' };
  check('(b) stockQty -1 -> 400', throws400(() => normalizeProduct({ ...base, stockQty: -1 })));
  check('(b) stockQty 2.5 -> 400', throws400(() => normalizeProduct({ ...base, stockQty: 2.5 })));
  check('(b) stockQty 100001 -> 400', throws400(() => normalizeProduct({ ...base, stockQty: 100001 })));
  check('(b) stockQty 0 is fine', normalizeProduct({ ...base, stockQty: 0 }).stockQty === 0);
  check('(b) stockQty absent -> null (untracked)', normalizeProduct({ ...base }).stockQty === null);
  check('(b) stockQty "4" (form string) -> 4', normalizeProduct({ ...base, stockQty: '4' }).stockQty === 4);
  check('(b) lowStockThreshold -1 -> 400', throws400(() => normalizeProduct({ ...base, lowStockThreshold: -1 })));
  check('(b) lowStockThreshold absent -> null', normalizeProduct({ ...base }).lowStockThreshold === null);
  check('(b) freeShipping true -> 1-ish true', normalizeProduct({ ...base, freeShipping: true }).freeShipping === true);
  check('(b) freeShipping "1" -> true', normalizeProduct({ ...base, freeShipping: '1' }).freeShipping === true);
  check('(b) freeShipping absent -> false', normalizeProduct({ ...base }).freeShipping === false);

  const db = new StubDB();
  const env = baseEnv(db);
  const created = await makeProduct(env, { stockQty: 12, lowStockThreshold: 4 });
  check('(b) create persists stock fields',
    created.stockQty === 12 && created.lowStockThreshold === 4 && created.available === true);

  const updated = await updateProduct(env, created.id, normalizeProduct(
    { stockQty: 3 },
    await getProduct(env, created.id)
  ));
  check('(b) update changes stockQty, preserves the rest',
    updated.stockQty === 3 && updated.name === 'Widget' && updated.lowStockThreshold === 4);
  const preserved = await updateProduct(env, created.id, normalizeProduct(
    { name: 'Widget II' },
    await getProduct(env, created.id)
  ));
  check('(b) update without stockQty preserves the count', preserved.stockQty === 3);

  // The real PUT route accepts the fields like create does.
  const token = (await issueToken(env, 'boss')).token;
  const putRes = await productPut(ctx(
    jsonRequest(`${ORIGIN}/api/products/${created.id}`, 'PUT', { stockQty: 9, freeShipping: true }, { Authorization: `Bearer ${token}` }),
    env,
    { id: String(created.id) }
  ));
  const putData = await putRes.json();
  check('(b) PUT route applies stockQty + freeShipping',
    putRes.status === 200 && putData.stockQty === 9 && putData.freeShipping === true,
    `status ${putRes.status}: ${JSON.stringify(putData)}`);
}

// =====================================================================================
// (c)+(d) Placement gate + demo-card commit point.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, { stockQty: 2 });

  const over = await placeOrder(env, {
    items: [{ productId: product.id, qty: 3 }],
    customer: CUSTOMER,
  });
  check('(c) qty > stock -> 400', over.status === 400, `got ${over.status}`);
  check('(c) 400 names the product and availability',
    typeof over.data.error === 'string' && over.data.error.includes('"Widget" only has 2 left.'),
    over.data.error);

  const exact = await placeOrder(env, {
    items: [{ productId: product.id, qty: 2 }],
    customer: CUSTOMER,
  });
  check('(c) qty == stock places fine', exact.status === 201, `got ${exact.status}: ${JSON.stringify(exact.data)}`);
  check('(c) placement alone does NOT decrement (Stripe path waits for payment)',
    (await getProduct(env, product.id)).stockQty === 2 &&
    exact.data.inventoryApplied === 0);

  // (d) demo card: placement IS the commit point.
  const demo = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CUSTOMER,
    payment: { cardNumber: '4242424242424242' },
  });
  check('(d) demo-card order places', demo.status === 201, `got ${demo.status}`);
  check('(d) demo-card order decrements at placement',
    (await getProduct(env, product.id)).stockQty === 1);
  check('(d) demo order is flagged inventoryApplied', demo.data.inventoryApplied === 1);
  const again = await applyOrderInventory(env, await getOrder(env, demo.data.id));
  check('(d) repeat applyOrderInventory is a no-op',
    again.inventoryApplied === 1 && (await getProduct(env, product.id)).stockQty === 1);
}

// =====================================================================================
// (e)+(g) Webhook commit point: once-only, failure events inert, floor at 0.
// =====================================================================================
{
  const db = new StubDB();
  const env = webhookEnv(db);
  const product = await makeProduct(env, { stockQty: 5 });

  const placed = await placeOrder(env, {
    items: [{ productId: product.id, qty: 2 }],
    customer: CUSTOMER,
  });
  check('(e) stripe-path order places unpaid', placed.status === 201 && placed.data.paymentStatus === 'unpaid');

  const completed = {
    id: 'evt_completed_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_inv_1', metadata: { order_id: String(placed.data.id) }, payment_intent: 'pi_inv_1' } },
  };
  check('(e) completed webhook 200', (await deliverWebhook(env, completed)) === 200);
  check('(e) completed decrements', (await getProduct(env, product.id)).stockQty === 3);
  check('(e) redelivered completed webhook 200', (await deliverWebhook(env, completed)) === 200);
  check('(e) redelivery does NOT decrement twice',
    (await getProduct(env, product.id)).stockQty === 3 &&
    (await getOrder(env, placed.data.id)).inventoryApplied === 1);

  // Failure events on fresh pending orders: no decrement, ever.
  for (const [type, expectedStatus] of [
    ['checkout.session.expired', 'unpaid'],
    ['checkout.session.async_payment_failed', 'payment_failed'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const o = await placeOrder(env, { items: [{ productId: product.id, qty: 1 }], customer: CUSTOMER });
    // eslint-disable-next-line no-await-in-loop
    await updateOrderPayment(env, o.data.id, { paymentStatus: 'pending' });
    // eslint-disable-next-line no-await-in-loop
    const status = await deliverWebhook(env, {
      id: `evt_${type}`,
      type,
      data: { object: { id: `cs_${type}`, metadata: { order_id: String(o.data.id) } } },
    });
    // eslint-disable-next-line no-await-in-loop
    const after = await getOrder(env, o.data.id);
    check(`(e) ${type} flips status, never decrements`,
      status === 200 && after.paymentStatus === expectedStatus && after.inventoryApplied === 0 &&
      (await getProduct(env, product.id)).stockQty === 3);
  }

  // (g) Floor: qty-3 order placed at stock 3+ (currently 3 after the
  // decrements above — place at exactly 3), then the owner lowers the
  // shelf to 1 before the payment lands. MAX(0, 1-3) = 0.
  const race = await placeOrder(env, {
    items: [{ productId: product.id, qty: 3 }],
    customer: CUSTOMER,
  });
  check('(g) race order placed at full stock', race.status === 201, `got ${race.status}`);
  await setProductStock(env, product.id, 1);
  await deliverWebhook(env, {
    id: 'evt_completed_race',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_inv_race', metadata: { order_id: String(race.data.id) }, payment_intent: 'pi_race' } },
  });
  check('(g) decrement floors at 0, never negative',
    (await getProduct(env, product.id)).stockQty === 0);
}

// =====================================================================================
// (f) Untracked products: never blocked, never decremented.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, {}); // stockQty absent -> untracked
  check('(f) product starts untracked', product.stockQty === null && product.available === true);
  const order = await placeOrder(env, {
    items: [{ productId: product.id, qty: 10 }],
    customer: CUSTOMER,
    payment: { cardNumber: '4242424242424242' },
  });
  check('(f) untracked demo order at max qty places', order.status === 201, `got ${order.status}`);
  const after = await getProduct(env, product.id);
  check('(f) untracked product is never decremented', after.stockQty === null);
}

// =====================================================================================
// (h) Admin stock PATCH.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, {});
  const token = (await issueToken(env, 'boss')).token;
  const patch = (id, body, headers = {}) =>
    stockPatch(ctx(
      jsonRequest(`${ORIGIN}/api/admin/products/${id}/stock`, 'PATCH', body, headers),
      env,
      { id: String(id) }
    ));

  const noAuth = await patch(product.id, { stockQty: 5 });
  check('(h) PATCH without admin token -> 401', noAuth.status === 401, `got ${noAuth.status}`);

  const auth = { Authorization: `Bearer ${token}` };
  const setRes = await patch(product.id, { stockQty: 7 }, auth);
  const setData = await setRes.json();
  check('(h) SET stockQty on untracked product starts tracking',
    setRes.status === 200 && setData.stockQty === 7 && setData.available === true,
    `status ${setRes.status}: ${JSON.stringify(setData)}`);
  const adjRes = await patch(product.id, { adjustBy: -10 }, auth);
  check('(h) adjustBy floors at 0', adjRes.status === 200 && (await adjRes.json()).stockQty === 0);
  const adj2Res = await patch(product.id, { adjustBy: 3 }, auth);
  check('(h) adjustBy adds back', adj2Res.status === 200 && (await adj2Res.json()).stockQty === 3);
  check('(h) both fields -> 400', (await patch(product.id, { stockQty: 1, adjustBy: 1 }, auth)).status === 400);
  check('(h) neither field -> 400', (await patch(product.id, {}, auth)).status === 400);
  check('(h) stockQty -1 -> 400', (await patch(product.id, { stockQty: -1 }, auth)).status === 400);
  check('(h) stockQty 2.5 -> 400', (await patch(product.id, { stockQty: 2.5 }, auth)).status === 400);
  check('(h) adjustBy 0 -> 400', (await patch(product.id, { adjustBy: 0 }, auth)).status === 400);
  check('(h) unknown product -> 404', (await patch(9999, { stockQty: 1 }, auth)).status === 404);
}

// =====================================================================================
// (j) Free shipping.
// =====================================================================================
{
  const heavyFree = { name: 'Free Heavy', weightOz: 100, freeShipping: true };
  const lightPaid = { name: 'Paid Light', weightOz: 10, freeShipping: false };
  const parcel = computePackage([
    { product: heavyFree, qty: 2 },
    { product: lightPaid, qty: 3 },
  ]);
  check('(j) computePackage excludes free-shipping items from weight',
    parcel.weightOz === 30, `got ${parcel.weightOz}`);

  const db = new StubDB();
  const env = uspsEnv(db);
  const freeProduct = await makeProduct(env, { name: 'Test Trinket', price: 0.5, freeShipping: true, weightOz: 100 });
  const paidProduct = await makeProduct(env, { name: 'Paid Widget', price: 10, weightOz: 10 });

  uspsPriceCalls = [];
  const freeQuote = await quoteShipping(env, [{ product: freeProduct, qty: 1 }], '14617');
  check('(j) all-free quote: not configured, no options, no USPS price calls',
    freeQuote.configured === false && freeQuote.options.length === 0 &&
    freeQuote.freeShippingOnly === true && uspsPriceCalls.length === 0,
    JSON.stringify(freeQuote));

  const freeOrder = await placeOrder(env, {
    items: [{ productId: freeProduct.id, qty: 1 }],
    customer: CUSTOMER,
    payment: { cardNumber: '4242424242424242' },
  });
  check('(j) all-free order with USPS configured: $0 shipping, no service required',
    freeOrder.status === 201 && freeOrder.data.shippingCents === 0 && freeOrder.data.shippingService === null,
    `status ${freeOrder.status}: ${JSON.stringify(freeOrder.data)}`);

  uspsPriceCalls = [];
  const mixed = await placeOrder(env, {
    items: [
      { productId: freeProduct.id, qty: 1 },
      { productId: paidProduct.id, qty: 2 },
    ],
    customer: CUSTOMER,
    shippingService: 'ground_advantage',
    payment: { cardNumber: '4242424242424242' },
  });
  check('(j) mixed order places with the paid item\'s service',
    mixed.status === 201, `got ${mixed.status}: ${JSON.stringify(mixed.data)}`);
  check('(j) mixed order weight excludes the free item',
    mixed.data.shippingWeightOz === 20, `got ${mixed.data.shippingWeightOz}`);
  check('(j) mixed order charged the quoted rate',
    mixed.data.shippingCents === 931, `got ${mixed.data.shippingCents}`);
  check('(j) USPS was priced at the reduced weight (1.3 lb for 20 oz)',
    uspsPriceCalls.length > 0 && uspsPriceCalls.every((c) => Number(c.weight) === 1.3),
    JSON.stringify(uspsPriceCalls.map((c) => c.weight)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
