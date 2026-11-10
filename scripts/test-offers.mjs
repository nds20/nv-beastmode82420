// Best Offer tests (2026-11-10) — plain node, no framework:
//
//   node scripts/test-offers.mjs
//
// Mirrors scripts/test-inventory.mjs: an in-memory D1 stub (extended
// for the offers table and the products condition/accepts_offers
// columns), a mocked fetch for USPS, signed Stripe webhooks, and the
// REAL route handlers + _lib modules. Covers docs/OFFERS.md:
//   (a) lazy ensure onto a pre-offers schema (columns + table) —
//       MUST RUN FIRST (per-isolate ensure cache)
//   (b) productAcceptsOffers truth table + condition/flag
//       normalization, incl. the owner's existing-products rule:
//       condition NULL + accepts_offers NULL + price set -> ON
//   (c) POST /api/offers validations + happy path
//   (d) GET /api/offers/:id/status: token gate, lazy expiry
//   (e) GET /api/admin/offers: auth, would-be totals math, ordering
//   (f) accept / decline: state guards, sold-out-since, expiry
//   (g) POST /api/offers/:id/pay — demo card, no-USPS deployment
//   (h) pay with USPS configured: re-quote, unknown service 400,
//       free-shipping product pays $0
//   (i) pay Stripe-pending, then the webhook flips offer -> 'paid'
//   (j) double-accept race: second pay blocked at 0 stock
//   (k) static wiring: worker routes, schema, disclosure copy

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  getOrder,
  getOffer,
  setProductStock,
  rowToProduct,
  productAcceptsOffers,
} from '../functions/api/_lib/db.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import { round2 } from '../functions/api/_lib/http.js';
import { quoteShipping } from '../functions/api/_lib/shipping.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import { onRequestPost as offerCreate } from '../functions/api/offers.js';
import { onRequestGet as offerStatus } from '../functions/api/offers/[id]/status.js';
import { onRequestPost as offerPay } from '../functions/api/offers/[id]/pay.js';
import { onRequestGet as adminOffers } from '../functions/api/admin/offers.js';
import { onRequestPost as adminAccept } from '../functions/api/admin/offers/[id]/accept.js';
import { onRequestPost as adminDecline } from '../functions/api/admin/offers/[id]/decline.js';
import { onRequestPost as webhookPost } from '../functions/api/stripe/webhook.js';

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
// test-inventory.mjs's generic approach, extended: an `offers` table
// (INSERT/SELECT/UPDATE incl. the pending-first list order and the
// markOfferPaidByOrderId shape), a CREATE TABLE no-op for
// ensureOffersTable, and `includeOffersCols: false` producing a
// PRE-offers products table for the lazy-ensure section.

const PRODUCT_COLS_BASE = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'brand', 'sizes', 'scent',
  'stock_qty', 'low_stock_threshold', 'free_shipping',
];
const OFFERS_PRODUCT_COLS = ['condition', 'accepts_offers'];
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
  constructor({ includeOffersCols = true } = {}) {
    this.includeOffersCols = includeOffersCols;
    this.state = { products: [], orders: [], offers: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0, offers: 0 };
  }

  pragma(table) {
    let cols;
    if (table === 'products') {
      cols = [...PRODUCT_COLS_BASE, ...(this.includeOffersCols ? OFFERS_PRODUCT_COLS : [])];
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
    // markOfferPaidByOrderId's shape.
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
    let m = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
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
    if (/FROM offers/i.test(stmt) && /ORDER BY/i.test(stmt)) {
      // CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC
      rows.sort((a, b) => {
        const pa = a.status === 'pending' ? 0 : 1;
        const pb = b.status === 'pending' ? 0 : 1;
        return pa - pb || b.id - a.id;
      });
    } else if (/ORDER BY id DESC/i.test(stmt)) {
      rows.sort((a, b) => b.id - a.id);
    }
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
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(USPS_BASE)) {
    if (u.endsWith('/oauth2/v3/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tok-offer-1', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/prices/v3/base-rates/search')) {
      const body = JSON.parse(init.body);
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
  return { DB: db, BEASTMODE_ADMIN_SECRET: 'offer-test-admin-secret', ...extra };
}

function uspsEnv(db) {
  return baseEnv(db, {
    USPS_CLIENT_ID: 'cid-offer',
    USPS_CLIENT_SECRET: 'csecret-offer',
    USPS_API_BASE: USPS_BASE,
    USPS_ORIGIN_ZIP: '14617',
  });
}

const webhookEnv = (db) => baseEnv(db, { STRIPE_WEBHOOK_SECRET: 'whsec_offer_test' });

async function makeProduct(env, over = {}) {
  const data = normalizeProduct({
    name: 'Offerable Widget',
    category: 'shirts',
    type: 'Test',
    price: 50,
    ...over,
  });
  return createProduct(env, data);
}

async function postOffer(env, body) {
  const res = await offerCreate(ctx(jsonRequest(`${ORIGIN}/api/offers`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function getStatus(env, id, token) {
  const url = `${ORIGIN}/api/offers/${id}/status${token !== undefined ? `?token=${encodeURIComponent(token)}` : ''}`;
  const res = await offerStatus(ctx(new Request(url), env, { id: String(id) }));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function postPay(env, id, body) {
  const res = await offerPay(
    ctx(jsonRequest(`${ORIGIN}/api/offers/${id}/pay`, 'POST', body), env, { id: String(id) })
  );
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function adminCall(env, handler, id) {
  const token = (await issueToken(env, 'boss')).token;
  const headers = { Authorization: `Bearer ${token}` };
  const url = id
    ? `${ORIGIN}/api/admin/offers/${id}/x`
    : `${ORIGIN}/api/admin/offers`;
  const req = handler === adminOffers
    ? new Request(url, { headers })
    : jsonRequest(url, 'POST', {}, headers);
  const res = await handler(ctx(req, env, id ? { id: String(id) } : {}));
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

/** Create an offer and accept it; returns the created offer view (with token). */
async function acceptedOffer(env, product, amount, extra = {}) {
  const created = await postOffer(env, {
    productId: product.id,
    offerAmount: amount,
    name: 'Test Buyer',
    email: 'buyer@example.com',
    ...(product.sizes && product.sizes.length ? { size: product.sizes[0] } : {}),
    ...extra,
  });
  if (created.status !== 201) {
    throw new Error(`acceptedOffer setup failed: ${JSON.stringify(created)}`);
  }
  const acc = await adminCall(env, adminAccept, created.data.id);
  if (acc.status !== 200) {
    throw new Error(`acceptedOffer accept failed: ${JSON.stringify(acc)}`);
  }
  return created.data;
}

// =====================================================================================
// (a) Lazy ensure onto a pre-offers schema — MUST RUN FIRST (per-isolate
// ensure cache; see the note above the stub).
// =====================================================================================
{
  const db = new StubDB({ includeOffersCols: false });
  const env = baseEnv(db);
  await listProducts(env);
  check('(a) lazy ensure adds products.condition', db.alters.includes('products.condition'),
    `alters: ${db.alters.join(', ')}`);
  check('(a) lazy ensure adds products.accepts_offers', db.alters.includes('products.accepts_offers'));

  // The offers table is created on first use (CREATE TABLE via run()).
  const product = await makeProduct(env, { price: 30 });
  const created = await postOffer(env, {
    productId: product.id, offerAmount: 20, name: 'Early Bird', email: 'early@example.com',
  });
  check('(a) first offer creates against the lazily-made table',
    created.status === 201 && created.data.status === 'pending',
    `got ${created.status}: ${JSON.stringify(created.data)}`);
}

// =====================================================================================
// (b) acceptsOffers truth table + normalization. The owner rule
// (confirmed 2026-11-10): an EXISTING product — condition NULL,
// accepts_offers NULL — comes up with offers ON automatically; only
// an explicit 'new' condition or a stored 0 turns them off.
// =====================================================================================
{
  check('(b) OWNER RULE: existing-style row (condition NULL, flag NULL, priced) -> offers ON',
    productAcceptsOffers({ condition: null, accepts_offers: null, price: 20 }) === true);
  check('(b) rowToProduct on a pre-offers row (no condition keys at all) -> acceptsOffers true, condition null',
    (() => {
      const p = rowToProduct({
        id: 9, name: 'Legacy', subtitle: '', category: 'shirts', type: '', thc: null,
        strength: '', price: 25, unit: 'each', effects: '[]', tile: '[]', image: null,
        weight_oz: null, length_in: null, width_in: null, height_in: null,
        brand: null, sizes: null, scent: null,
        stock_qty: null, low_stock_threshold: null, free_shipping: 0,
      });
      return p.acceptsOffers === true && p.condition === null;
    })());
  check('(b) NEW forces offers off even with stored flag 1',
    productAcceptsOffers({ condition: 'new', accepts_offers: 1, price: 20 }) === false);
  check('(b) used + flag 1 -> on',
    productAcceptsOffers({ condition: 'used', accepts_offers: 1, price: 20 }) === true);
  check('(b) used + flag 0 -> off (owner unchecked the box)',
    productAcceptsOffers({ condition: 'used', accepts_offers: 0, price: 20 }) === false);
  check('(b) null condition + flag 0 -> off',
    productAcceptsOffers({ condition: null, accepts_offers: 0, price: 20 }) === false);
  check('(b) priced default: null/null + price -> on; price TBD -> off; price 0 -> off',
    productAcceptsOffers({ condition: null, accepts_offers: null, price: null }) === false &&
    productAcceptsOffers({ condition: null, accepts_offers: null, price: 0 }) === false);
  check('(b) explicit flag 1 wins even for a TBD price',
    productAcceptsOffers({ condition: 'used', accepts_offers: 1, price: null }) === true);

  const throws400 = (fn) => {
    try { fn(); return false; } catch (err) { return err && err.status === 400; }
  };
  const base = { name: 'W', category: 'shirts', type: 'T' };
  check('(b) condition "New" normalizes to lowercase "new"',
    normalizeProduct({ ...base, condition: 'New' }).condition === 'new');
  check('(b) condition "USED" normalizes to "used"',
    normalizeProduct({ ...base, condition: 'USED' }).condition === 'used');
  check('(b) condition absent -> null', normalizeProduct({ ...base }).condition === null);
  check('(b) condition "mint" -> 400',
    throws400(() => normalizeProduct({ ...base, condition: 'mint' })));
  check('(b) acceptsOffers true -> 1, false -> 0, absent -> null',
    normalizeProduct({ ...base, acceptsOffers: true }).acceptsOffers === 1 &&
    normalizeProduct({ ...base, acceptsOffers: false }).acceptsOffers === 0 &&
    normalizeProduct({ ...base }).acceptsOffers === null);
  check('(b) acceptsOffers "banana" -> 400',
    throws400(() => normalizeProduct({ ...base, acceptsOffers: 'banana' })));

  // Persistence: a product created with NO condition/flag input (the
  // existing-products shape) stores NULL/NULL and reads offers ON.
  const db = new StubDB();
  const env = baseEnv(db);
  const legacy = await makeProduct(env, { price: 44 });
  const raw = db.state.products.find((r) => r.id === legacy.id);
  check('(b) create with no condition/flag stores NULL/NULL and reads offers ON',
    raw.condition === null && raw.accepts_offers === null && legacy.acceptsOffers === true,
    `raw: ${JSON.stringify(raw)}`);
  const newItem = await makeProduct(env, { price: 44, condition: 'new', acceptsOffers: true });
  check('(b) a NEW product persists condition and reads offers OFF despite flag 1 input',
    newItem.condition === 'new' && newItem.acceptsOffers === false);
  const updated = await updateProduct(env, legacy.id, {
    ...normalizeProduct({ name: 'Offerable Widget', category: 'shirts', type: 'Test', price: 44, condition: 'used', acceptsOffers: false }),
  });
  check('(b) update can switch offers off explicitly',
    updated.acceptsOffers === false && updated.condition === 'used');
}

// =====================================================================================
// (c) POST /api/offers validations + happy path.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const shirt = await makeProduct(env, { price: 50, sizes: ['S', 'M', 'L'] });
  const oneSize = await makeProduct(env, { name: 'One Size', price: 20 });
  const newItem = await makeProduct(env, { name: 'Brand New', price: 60, condition: 'new' });
  const optedOut = await makeProduct(env, { name: 'Opted Out', price: 60, acceptsOffers: false });
  const soldOut = await makeProduct(env, { name: 'Gone', price: 60, stockQty: 0 });
  const tbd = await makeProduct(env, { name: 'Unpriced', price: null });
  const buyer = { name: 'Test Buyer', email: 'buyer@example.com' };

  check('(c) unknown product -> 400',
    (await postOffer(env, { productId: 9999, offerAmount: 5, ...buyer })).status === 400);
  const atList = await postOffer(env, { productId: oneSize.id, offerAmount: 20, ...buyer });
  check('(c) offer AT list price -> 400 with the list-price message',
    atList.status === 400 && atList.data.error === "That's the list price — just add it to your cart.",
    `got ${atList.status}: ${JSON.stringify(atList.data)}`);
  check('(c) offer ABOVE list price -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 25, ...buyer })).status === 400);
  const onNew = await postOffer(env, { productId: newItem.id, offerAmount: 30, ...buyer });
  check('(c) NEW item -> 400 "doesn\'t accept offers"',
    onNew.status === 400 && onNew.data.error === "This item doesn't accept offers.");
  check('(c) opted-out item -> 400',
    (await postOffer(env, { productId: optedOut.id, offerAmount: 30, ...buyer })).status === 400);
  check('(c) sold-out item -> 400',
    (await postOffer(env, { productId: soldOut.id, offerAmount: 30, ...buyer })).status === 400);
  check('(c) price-TBD item -> 400 (no offers without a price)',
    (await postOffer(env, { productId: tbd.id, offerAmount: 30, ...buyer })).status === 400);
  check('(c) sized product without a size -> 400',
    (await postOffer(env, { productId: shirt.id, offerAmount: 30, ...buyer })).status === 400);
  check('(c) sized product with a size outside the run -> 400',
    (await postOffer(env, { productId: shirt.id, offerAmount: 30, size: 'XXL', ...buyer })).status === 400);
  check('(c) one-size product WITH a size -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 10, size: 'M', ...buyer })).status === 400);
  check('(c) bad email -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 10, name: 'Test Buyer', email: 'nope' })).status === 400);
  check('(c) one-letter name -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 10, name: 'A', email: 'a@b.co' })).status === 400);
  check('(c) note over 500 chars -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 10, note: 'x'.repeat(501), ...buyer })).status === 400);
  check('(c) 3-decimal amount -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 10.999, ...buyer })).status === 400);
  check('(c) zero amount -> 400',
    (await postOffer(env, { productId: oneSize.id, offerAmount: 0, ...buyer })).status === 400);

  const ok = await postOffer(env, {
    productId: shirt.id, offerAmount: 35.5, size: 'M', phone: '5855550100', note: 'Love it', ...buyer,
  });
  check('(c) happy path -> 201 pending with cents + token + 72h expiry',
    ok.status === 201 && ok.data.status === 'pending' && ok.data.offerCents === 3550 &&
    ok.data.offerAmount === 35.5 && ok.data.size === 'M' &&
    typeof ok.data.accessToken === 'string' && ok.data.accessToken.length >= 16 &&
    Math.abs(new Date(ok.data.expiresAt).getTime() - (Date.now() + 72 * 3600 * 1000)) < 60 * 1000,
    `got ${ok.status}: ${JSON.stringify(ok.data)}`);
  const stored = await getOffer(env, ok.data.id);
  check('(c) stored row keeps buyer contact + note, no order yet',
    stored.buyerEmail === 'buyer@example.com' && stored.buyerPhone === '5855550100' &&
    stored.note === 'Love it' && stored.orderId === null && stored.decidedAt === null);
}

// =====================================================================================
// (d) Status reads: token gate + lazy expiry.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, { price: 40 });
  const created = await postOffer(env, {
    productId: product.id, offerAmount: 25, name: 'Test Buyer', email: 'buyer@example.com',
  });
  const { id, accessToken } = created.data;

  check('(d) status without token -> 403', (await getStatus(env, id)).status === 403);
  check('(d) status with wrong token -> 403', (await getStatus(env, id, 'wrong-token')).status === 403);
  check('(d) unknown offer id -> 404', (await getStatus(env, 9999, accessToken)).status === 404);
  const ok = await getStatus(env, id, accessToken);
  check('(d) status with token -> pending + guidance + pay-flow fields',
    ok.status === 200 && ok.data.status === 'pending' &&
    ok.data.message === 'Waiting for the seller to respond to your offer.' &&
    ok.data.productName === 'Offerable Widget' && ok.data.productId === product.id &&
    ok.data.offerAmount === 25 && ok.data.orderId === null,
    `got ${ok.status}: ${JSON.stringify(ok.data)}`);

  const rawRow = db.state.offers.find((r) => r.id === id);
  rawRow.expires_at = new Date(Date.now() - 60 * 1000).toISOString();
  const expired = await getStatus(env, id, accessToken);
  check('(d) reading a past-due pending offer flips it to expired',
    expired.status === 200 && expired.data.status === 'expired' &&
    db.state.offers.find((r) => r.id === id).status === 'expired');
}

// =====================================================================================
// (e) Admin list: auth, would-be totals, ordering, counts.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const noAuthRes = await adminOffers(ctx(new Request(`${ORIGIN}/api/admin/offers`), env));
  check('(e) admin list without token -> 401', noAuthRes.status === 401);

  const freeShip = await makeProduct(env, { name: 'Free Ship Shirt', price: 40, freeShipping: true });
  const plain = await makeProduct(env, { name: 'Plain Shirt', price: 30 });
  await postOffer(env, { productId: freeShip.id, offerAmount: 25, name: 'Ann A', email: 'ann@example.com' });
  const plainOffer = await postOffer(env, { productId: plain.id, offerAmount: 20, name: 'Bob B', email: 'bob@example.com' });
  await adminCall(env, adminAccept, plainOffer.data.id);

  const list = await adminCall(env, adminOffers);
  check('(e) list returns both offers, pending first',
    list.status === 200 && list.data.offers.length === 2 &&
    list.data.offers[0].status === 'pending' && list.data.offers[1].status === 'accepted',
    `got ${list.status}: ${JSON.stringify(list.data).slice(0, 200)}`);
  check('(e) counts by status', list.data.counts.pending === 1 && list.data.counts.accepted === 1);
  const freeRow = list.data.offers.find((o) => o.productId === freeShip.id);
  check('(e) free-shipping would-be: tax on offer only, shipping 0, total complete',
    freeRow.wouldBe.subtotal === 25 && freeRow.wouldBe.tax === 2.55 &&
    freeRow.wouldBe.shippingCents === 0 && freeRow.wouldBe.shippingLabel === 'Free shipping' &&
    freeRow.wouldBe.total === 27.55 && freeRow.listPrice === 40,
    `wouldBe: ${JSON.stringify(freeRow.wouldBe)}`);
  const plainRow = list.data.offers.find((o) => o.productId === plain.id);
  check('(e) non-free would-be: shipping unknown until payment (no USPS call pre-acceptance)',
    plainRow.wouldBe.tax === round2(20 * 0.102) && plainRow.wouldBe.shippingCents === null &&
    plainRow.wouldBe.shippingLabel === 'USPS rate at payment' && plainRow.wouldBe.total === null);
  check('(e) admin rows never carry the buyer access token',
    list.data.offers.every((o) => o.accessToken === undefined));

  // listPrice is the CURRENT list price, not the price at offer time.
  await updateProduct(env, plain.id, normalizeProduct({
    name: 'Plain Shirt', category: 'shirts', type: 'Test', price: 33,
  }));
  const list2 = await adminCall(env, adminOffers);
  check('(e) list price follows later product edits',
    list2.data.offers.find((o) => o.productId === plain.id).listPrice === 33);
}

// =====================================================================================
// (f) Accept / decline guards.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, { price: 50, stockQty: 1 });
  const mk = () => postOffer(env, {
    productId: product.id, offerAmount: 30, name: 'Test Buyer', email: 'buyer@example.com',
  });

  const noAuth = await adminAccept(ctx(jsonRequest(`${ORIGIN}/api/admin/offers/1/accept`, 'POST', {}), env, { id: '1' }));
  check('(f) accept without admin token -> 401', noAuth.status === 401);

  const o1 = await mk();
  const acc = await adminCall(env, adminAccept, o1.data.id);
  check('(f) accept happy path -> accepted + decidedAt',
    acc.status === 200 && acc.data.status === 'accepted' && Boolean(acc.data.decidedAt),
    `got ${acc.status}: ${JSON.stringify(acc.data)}`);
  check('(f) accept again -> 409', (await adminCall(env, adminAccept, o1.data.id)).status === 409);
  check('(f) decline an accepted offer -> 409', (await adminCall(env, adminDecline, o1.data.id)).status === 409);

  const o2 = await mk();
  const dec = await adminCall(env, adminDecline, o2.data.id);
  check('(f) decline happy path -> declined + decidedAt',
    dec.status === 200 && dec.data.status === 'declined' && Boolean(dec.data.decidedAt));
  check('(f) decline again -> 409', (await adminCall(env, adminDecline, o2.data.id)).status === 409);

  // Sold out since the offer was made.
  const o3 = await mk();
  await setProductStock(env, product.id, 0);
  const soldOutAcc = await adminCall(env, adminAccept, o3.data.id);
  check('(f) accept after sell-out -> 409 with the exact message',
    soldOutAcc.status === 409 && soldOutAcc.data.error === 'Sold out since the offer was made.',
    `got ${soldOutAcc.status}: ${JSON.stringify(soldOutAcc.data)}`);
  await setProductStock(env, product.id, 1);

  // Expired before the decision.
  const o4 = await mk();
  db.state.offers.find((r) => r.id === o4.data.id).expires_at =
    new Date(Date.now() - 1000).toISOString();
  const expAcc = await adminCall(env, adminAccept, o4.data.id);
  check('(f) accept past expiry -> 409 and the row flips to expired',
    expAcc.status === 409 &&
    db.state.offers.find((r) => r.id === o4.data.id).status === 'expired');
  const o5 = await mk();
  db.state.offers.find((r) => r.id === o5.data.id).expires_at =
    new Date(Date.now() - 1000).toISOString();
  check('(f) decline past expiry -> 409', (await adminCall(env, adminDecline, o5.data.id)).status === 409);

  // Product deleted since the offer.
  const o6 = await mk();
  db.state.products = db.state.products.filter((r) => r.id !== product.id);
  check('(f) accept with the product gone -> 409',
    (await adminCall(env, adminAccept, o6.data.id)).status === 409);
  check('(f) unknown offer -> 404', (await adminCall(env, adminAccept, 9999)).status === 404);
}

// =====================================================================================
// (g) Pay — demo card, no USPS configured.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, { price: 50, stockQty: 2 });
  const offer = await acceptedOffer(env, product, 35);

  check('(g) pay with a wrong token -> 403',
    (await postPay(env, offer.id, { accessToken: 'nope', customer: CUSTOMER, payment: DEMO_CARD })).status === 403);

  const pendingProduct = await makeProduct(env, { name: 'Pending One', price: 50 });
  const pending = await postOffer(env, {
    productId: pendingProduct.id, offerAmount: 30, name: 'Test Buyer', email: 'buyer@example.com',
  });
  check('(g) pay while still pending -> 409',
    (await postPay(env, pending.data.id, { accessToken: pending.data.accessToken, customer: CUSTOMER, payment: DEMO_CARD })).status === 409);

  check('(g) pay with an incomplete customer -> 400',
    (await postPay(env, offer.id, { accessToken: offer.accessToken, customer: { fullName: 'Test Buyer' }, payment: DEMO_CARD })).status === 400);

  const paid = await postPay(env, offer.id, {
    accessToken: offer.accessToken, customer: CUSTOMER, payment: DEMO_CARD,
  });
  // Money shape mirrors POST /api/orders exactly — including its
  // documented demo-path quirk: the ORDER's own paymentStatus stays
  // 'unpaid' (that flow never marks orders paid; see orders.js),
  // while the OFFER flips to 'paid' and inventory applies.
  check('(g) demo pay -> 201 order at the OFFER price (subtotal 35, tax 10.2% of offer, total 38.57)',
    paid.status === 201 && paid.data.subtotal === 35 && paid.data.tax === 3.57 &&
    paid.data.shippingCents === 0 && paid.data.total === 38.57 &&
    paid.data.payment && paid.data.payment.last4 === '4242' &&
    paid.data.paymentStatus === 'unpaid' && paid.data.inventoryApplied === 1 &&
    Boolean(paid.data.accessToken),
    `got ${paid.status}: ${JSON.stringify(paid.data)}`);
  const offerAfter = await getOffer(env, offer.id);
  check('(g) offer flips to paid and links the order',
    offerAfter.status === 'paid' && offerAfter.orderId === paid.data.id);
  check('(g) stock decremented exactly once',
    (await getProduct(env, product.id)).stockQty === 1);
  check('(g) paying the same offer again -> 409',
    (await postPay(env, offer.id, { accessToken: offer.accessToken, customer: CUSTOMER, payment: DEMO_CARD })).status === 409);
  check('(g) the minted order line carries the offer price, qty 1',
    paid.data.items.length === 1 && paid.data.items[0].unitPrice === 35 && paid.data.items[0].qty === 1);
}

// =====================================================================================
// (h) Pay with USPS configured: shipping re-quoted server-side,
// unknown service 400s, free-shipping products pay $0 shipping.
// =====================================================================================
{
  const db = new StubDB();
  const env = uspsEnv(db);
  const product = await makeProduct(env, {
    price: 80, stockQty: 3, weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 6,
  });
  const offer = await acceptedOffer(env, product, 60);

  const quote = await quoteShipping(env, [{ product: await getProduct(env, product.id), qty: 1 }], '14617');
  check('(h) quote is configured with options', quote.configured === true && quote.options.length >= 1,
    JSON.stringify(quote).slice(0, 160));
  const chosen = quote.options[0];

  check('(h) pay with an unknown shipping service -> 400',
    (await postPay(env, offer.id, {
      accessToken: offer.accessToken, customer: CUSTOMER,
      shippingService: 'carrier-pigeon', payment: DEMO_CARD,
    })).status === 400);

  const paid = await postPay(env, offer.id, {
    accessToken: offer.accessToken, customer: CUSTOMER,
    shippingService: chosen.service, payment: DEMO_CARD,
  });
  check('(h) pay re-quotes shipping (never trusts the client): cents match the live quote',
    paid.status === 201 && paid.data.shippingCents === chosen.priceCents &&
    paid.data.subtotal === 60 && paid.data.tax === 6.12 &&
    paid.data.total === round2(60 + 6.12 + chosen.priceCents / 100),
    `got ${paid.status}: ${JSON.stringify(paid.data)}`);
  check('(h) stock decremented once on the USPS path too',
    (await getProduct(env, product.id)).stockQty === 2);

  const freeProduct = await makeProduct(env, { name: 'Free Ship', price: 45, freeShipping: true });
  const freeOffer = await acceptedOffer(env, freeProduct, 30);
  const freePaid = await postPay(env, freeOffer.id, {
    accessToken: freeOffer.accessToken, customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(h) free-shipping product pays $0 shipping with USPS configured, no service needed',
    freePaid.status === 201 && freePaid.data.shippingCents === 0 &&
    freePaid.data.total === round2(30 + round2(30 * 0.102)),
    `got ${freePaid.status}: ${JSON.stringify(freePaid.data)}`);
}

// =====================================================================================
// (i) Pay Stripe-pending: the offer stays 'accepted' until the
// webhook for ITS order lands, then flips to 'paid'.
// =====================================================================================
{
  const db = new StubDB();
  const env = webhookEnv(db);
  const product = await makeProduct(env, { price: 50, stockQty: 2 });
  const offer = await acceptedOffer(env, product, 40);

  const placed = await postPay(env, offer.id, {
    accessToken: offer.accessToken, customer: CUSTOMER,
  });
  check('(i) stripe-path pay -> 201 unpaid order; offer stays accepted; stock untouched',
    placed.status === 201 && placed.data.paymentStatus === 'unpaid' &&
    (await getOffer(env, offer.id)).status === 'accepted' &&
    (await getProduct(env, product.id)).stockQty === 2,
    `got ${placed.status}: ${JSON.stringify(placed.data)}`);

  const completed = {
    id: 'evt_offer_completed',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_offer_1',
        metadata: { order_id: String(placed.data.id) },
        payment_intent: 'pi_offer_1',
      },
    },
  };
  check('(i) completed webhook -> 200', (await deliverWebhook(env, completed)) === 200);
  check('(i) webhook flips the offer to paid and decrements once',
    (await getOffer(env, offer.id)).status === 'paid' &&
    (await getOrder(env, placed.data.id)).paymentStatus === 'paid' &&
    (await getProduct(env, product.id)).stockQty === 1);
  check('(i) webhook redelivery stays consistent (no double decrement)',
    (await deliverWebhook(env, completed)) === 200 &&
    (await getProduct(env, product.id)).stockQty === 1);
}

// =====================================================================================
// (j) Double-accept race: both offers on a single-stock item are
// accepted (the seller's choice); the first payer wins, the second
// pay is blocked by the placement stock gate.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env, { price: 30, stockQty: 1 });
  const first = await acceptedOffer(env, product, 20);
  const second = await acceptedOffer(env, product, 22);
  check('(j) both offers accepted on one single-stock item',
    (await getOffer(env, first.id)).status === 'accepted' &&
    (await getOffer(env, second.id)).status === 'accepted');

  const paidFirst = await postPay(env, first.id, {
    accessToken: first.accessToken, customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(j) first payer wins', paidFirst.status === 201 &&
    (await getProduct(env, product.id)).stockQty === 0);

  const paidSecond = await postPay(env, second.id, {
    accessToken: second.accessToken, customer: CUSTOMER, payment: DEMO_CARD,
  });
  check('(j) second pay blocked at 0 stock, naming availability',
    paidSecond.status === 400 && /only has 0 left/.test(paidSecond.data.error || ''),
    `got ${paidSecond.status}: ${JSON.stringify(paidSecond.data)}`);
  const secondAfter = await getOffer(env, second.id);
  check('(j) losing offer stays accepted with no order minted',
    secondAfter.status === 'accepted' && secondAfter.orderId === null);
}

// =====================================================================================
// (k) Static wiring: worker route table, schema, disclosure copy.
// =====================================================================================
{
  const workerSrc = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  for (const needle of [
    "parts: ['api', 'offers']",
    "'status'], handlers: { GET: offerStatus }",
    "'pay'], handlers: { POST: offerPay }",
    "parts: ['api', 'admin', 'offers']",
    "'accept'], handlers: { POST: adminOfferAccept }",
    "'decline'], handlers: { POST: adminOfferDecline }",
  ]) {
    check(`(k) worker registers ${needle}`, workerSrc.includes(needle));
  }
  const schema = readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8');
  check('(k) schema.sql carries the offers table + product columns',
    schema.includes('CREATE TABLE IF NOT EXISTS offers') &&
    schema.includes('condition TEXT') && schema.includes('accepts_offers INTEGER'));
  const migration = readFileSync(new URL('../cloudflare/migration-offers.sql', import.meta.url), 'utf8');
  check('(k) migration-offers.sql mirrors the change',
    migration.includes('ALTER TABLE products ADD COLUMN condition TEXT') &&
    migration.includes('CREATE TABLE IF NOT EXISTS offers'));
  const disclosure = readFileSync(
    new URL('../frontend/src/components/UsedClothingDisclosure.jsx', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');
  check('(k) disclosure line one is EXACT',
    disclosure.includes('All clothes are used unless specified as'));
  check('(k) disclosure line two states the pricing policy',
    disclosure.includes('priced as listed — no offers') &&
    disclosure.includes('used-disclosure-best-offer') &&
    disclosure.includes('BEST OFFER') &&
    disclosure.includes('make an offer and the seller decides'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
