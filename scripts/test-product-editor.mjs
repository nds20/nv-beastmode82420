// Product editor tests (2026-11-09) — plain node, no framework:
//
//   node scripts/test-product-editor.mjs
//
// Mirrors scripts/test-inventory.mjs: an in-memory D1 stub (the
// database cannot be run here), a stub R2 bucket for product photos,
// and the REAL route handlers the admin product editor drives
// (frontend/src/services/adminApi.js calls these endpoints; the
// serialization contract under test is documented in
// docs/PRODUCT_EDITOR.md). Covers:
//   (a) create via JSON with the full field set — stockQty null
//       (Unlimited) + freeShipping true — round-trips through
//       rowToProduct: available true, freeShipping true, stockQty
//       null, effects/tile as arrays
//   (b) create via multipart (string fields + freeShipping 'true' +
//       a real PNG File) against a stubbed PRODUCT_PHOTOS bucket ->
//       201, image path set, R2 put recorded under the same key
//   (b2) the same multipart create WITHOUT the bucket -> the server's
//        clear 400 ("Photo uploads are not configured")
//   (c) edit switching tracked -> untracked via JSON null clears the
//       count; a partial PUT leaves the other fields untouched
//   (d) validation errors surface verbatim: missing name, bad
//       category, negative price — all 400 with the server's message
//   (e) DELETE removes the product (subsequent GET one -> 404, a
//       second DELETE -> 404)
//   (f) the write endpoints require admin (no token -> 401)

import {
  listProducts,
  getProduct,
} from '../functions/api/_lib/db.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import {
  onRequestGet as productsList,
  onRequestPost as productsCreate,
} from '../functions/api/products.js';
import {
  onRequestGet as productGet,
  onRequestPut as productPut,
  onRequestDelete as productDelete,
} from '../functions/api/products/[id].js';

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
// Copied from test-inventory.mjs (same generic approach), with a
// DELETE handler added for removeProduct. The stub always reports the
// full (post-shipping, post-inventory) column set, so the lazy
// ensure* passes are no-ops here; the lazy-ensure path itself is
// covered by the shipping/inventory suites.

const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in', 'height_in',
  'stock_qty', 'low_stock_threshold', 'free_shipping', 'brand', 'sizes', 'scent',
];
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
  constructor() {
    this.state = { products: [], orders: [] };
    this.alters = [];
    this.lastId = { products: 0, orders: 0 };
  }

  pragma(table) {
    const cols = table === 'products' ? PRODUCT_COLS : ORDER_COLS;
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
    if (/^DELETE FROM products/i.test(stmt)) {
      const id = Number(params[0]);
      const before = this.state.products.length;
      this.state.products = this.state.products.filter((r) => r.id !== id);
      return { meta: { changes: before - this.state.products.length } };
    }
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

// ----- Stub R2 bucket ------------------------------------------------------------

function stubPhotos() {
  const puts = [];
  return {
    puts,
    async put(key, stream, options) {
      // Drain the stream like a real store would.
      const reader = stream.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      puts.push({ key, bytes, contentType: options?.httpMetadata?.contentType });
      return { key };
    },
  };
}

// ----- Helpers --------------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';

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
  return { DB: db, BEASTMODE_ADMIN_SECRET: 'editor-test-admin-secret', ...extra };
}

async function authHeaders(env) {
  const token = (await issueToken(env, 'boss')).token;
  return { Authorization: `Bearer ${token}` };
}

// A real, minimal PNG (1x1) — photo validation checks extension +
// content type + size, so valid image bytes under an image name/type
// are what a browser's file input would deliver.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// =====================================================================================
// (a) Create via JSON — the editor's field step. Full field set, with
// the $8.24 test item's exact shape: stockQty null (Unlimited) and
// freeShipping true (No shipping).
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const body = {
    name: '⚠️ TEST ITEM — YOU WILL NOT RECEIVE ANYTHING ⚠️',
    subtitle: '⚠️ YOU WILL NOT RECEIVE ANYTHING — test listing only ⚠️',
    category: 'test-item',
    type: 'Test Item',
    price: 8.24,
    thc: null,
    strength: '⚠️ NO PRODUCT — TEST ONLY ⚠️',
    unit: 'Nothing — test item',
    effects: ['⚠️ YOU WILL NOT RECEIVE ANYTHING — TEST LISTING ONLY'],
    tile: ['#374151', '#111827'],
    weightOz: null,
    lengthIn: null,
    widthIn: null,
    heightIn: null,
    stockQty: null,
    lowStockThreshold: null,
    freeShipping: true,
  };
  const res = await productsCreate(ctx(jsonRequest(`${ORIGIN}/api/products`, 'POST', body, headers), env));
  const created = await res.json().catch(() => ({}));
  check('(a) JSON create -> 201', res.status === 201, `status ${res.status}`);
  check('(a) stockQty null (untracked) round-trips', created.stockQty === null, JSON.stringify(created.stockQty));
  check('(a) freeShipping true round-trips', created.freeShipping === true);
  check('(a) available true for an untracked product', created.available === true);
  check('(a) price round-trips as 8.24', created.price === 8.24, JSON.stringify(created.price));
  check(
    '(a) effects round-trip as an array',
    Array.isArray(created.effects) && created.effects.length === 1,
    JSON.stringify(created.effects)
  );
  check(
    '(a) clothing defaults: brand null, sizes [], scent null',
    created.brand === null && Array.isArray(created.sizes) && created.sizes.length === 0 && created.scent === null,
    JSON.stringify({ brand: created.brand, sizes: created.sizes, scent: created.scent })
  );
  check(
    '(a) tile round-trips as two colors',
    Array.isArray(created.tile) && created.tile.join(',') === '#374151,#111827',
    JSON.stringify(created.tile)
  );
  const list = await listProducts(env);
  check('(a) catalog list contains the new product', list.length === 1 && list[0].id === created.id);
}

// =====================================================================================
// (b) Create via multipart — string fields, JSON-encoded effects/tile
// (the encodings parseEffects/parseTile document), freeShipping 'true',
// stockQty '7' as a string, and a PNG photo against the stub bucket.
// =====================================================================================
{
  const db = new StubDB();
  const photos = stubPhotos();
  const env = baseEnv(db, { PRODUCT_PHOTOS: photos });
  const headers = await authHeaders(env);

  const fd = new FormData();
  fd.append('name', 'Photo Widget');
  fd.append('subtitle', 'Has a picture');
  fd.append('category', 'hoodies');
  fd.append('type', 'Merch');
  fd.append('price', '12.50');
  fd.append('brand', '824');
  fd.append('sizes', 'S,M,L,XL');
  fd.append('effects', JSON.stringify(['Calm', 'Focus']));
  fd.append('tile', JSON.stringify(['#111111', '#222222']));
  fd.append('stockQty', '7');
  fd.append('freeShipping', 'true');
  fd.append('photo', new File([PNG_BYTES], 'pixel.png', { type: 'image/png' }));

  const req = new Request(`${ORIGIN}/api/products`, { method: 'POST', headers, body: fd });
  const res = await productsCreate(ctx(req, env));
  const created = await res.json().catch(() => ({}));
  check('(b) multipart create -> 201', res.status === 201, `status ${res.status}: ${JSON.stringify(created)}`);
  const wantImage = `/api/photos/products/${created.id}-photo-widget.png`;
  check('(b) image path set from the upload', created.image === wantImage, JSON.stringify(created.image));
  check(
    '(b) R2 put recorded under the same key',
    photos.puts.length === 1 && photos.puts[0].key === `products/${created.id}-photo-widget.png`,
    JSON.stringify(photos.puts.map((p) => p.key))
  );
  check('(b) string price parsed to 12.5', created.price === 12.5, JSON.stringify(created.price));
  check('(b) string stockQty parsed to 7', created.stockQty === 7, JSON.stringify(created.stockQty));
  check("(b) freeShipping 'true' string parsed on", created.freeShipping === true);
  check('(b) brand stored from multipart', created.brand === '824', JSON.stringify(created.brand));
  check(
    '(b) comma-string sizes parsed to an array',
    Array.isArray(created.sizes) && created.sizes.join(',') === 'S,M,L,XL',
    JSON.stringify(created.sizes)
  );
  check(
    '(b) JSON-encoded effects parsed to an array',
    Array.isArray(created.effects) && created.effects.join(',') === 'Calm,Focus',
    JSON.stringify(created.effects)
  );
  const listRes = await productsList(ctx(new Request(`${ORIGIN}/api/products`), env));
  const list = await listRes.json();
  check('(b) GET list serves the product with its image', list.length === 1 && list[0].image === wantImage);
}

// =====================================================================================
// (b2) Multipart WITH a photo but NO PRODUCT_PHOTOS binding -> the
// clear 400 the editor surfaces as its form error (not a crash, and
// no row is written).
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const fd = new FormData();
  fd.append('name', 'No Bucket Widget');
  fd.append('category', 'hoodies');
  fd.append('type', 'Merch');
  fd.append('photo', new File([PNG_BYTES], 'pixel.png', { type: 'image/png' }));
  const req = new Request(`${ORIGIN}/api/products`, { method: 'POST', headers, body: fd });
  const res = await productsCreate(ctx(req, env));
  const data = await res.json().catch(() => ({}));
  check('(b2) photo without storage -> 400', res.status === 400, `status ${res.status}`);
  check(
    '(b2) error names the missing photo storage',
    typeof data.error === 'string' && data.error.includes('Photo uploads are not configured'),
    JSON.stringify(data)
  );
  check('(b2) no product row was written', db.state.products.length === 0);
}

// =====================================================================================
// (c) Edit: tracked -> untracked via JSON null (the editor's
// "Unlimited" switch — the case multipart cannot express), plus a
// partial PUT leaving untouched fields alone.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const createRes = await productsCreate(
    ctx(
      jsonRequest(
        `${ORIGIN}/api/products`,
        'POST',
        { name: 'Tracked Widget', category: 'shirts', type: 'Merch', price: 20, stockQty: 5, lowStockThreshold: 2 },
        headers
      ),
      env
    )
  );
  const created = await createRes.json();
  check('(c) setup product is tracked at 5', created.stockQty === 5 && created.available === true);

  const putRes = await productPut(
    ctx(
      jsonRequest(`${ORIGIN}/api/products/${created.id}`, 'PUT', { stockQty: null }, headers),
      env,
      { id: String(created.id) }
    )
  );
  const updated = await putRes.json().catch(() => ({}));
  check('(c) PUT -> 200', putRes.status === 200, `status ${putRes.status}`);
  check('(c) JSON null clears the count (untracked)', updated.stockQty === null, JSON.stringify(updated.stockQty));
  check('(c) untracked again -> available true', updated.available === true);
  check(
    '(c) partial PUT preserves the other fields',
    updated.name === 'Tracked Widget' && updated.price === 20 && updated.lowStockThreshold === 2,
    JSON.stringify({ name: updated.name, price: updated.price, lowStockThreshold: updated.lowStockThreshold })
  );
  const reread = await getProduct(env, created.id);
  check('(c) the clear persisted', reread.stockQty === null);
}

// =====================================================================================
// (d) Validation errors surface verbatim from the real handlers.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const attempt = async (body) => {
    const res = await productsCreate(ctx(jsonRequest(`${ORIGIN}/api/products`, 'POST', body, headers), env));
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const noName = await attempt({ category: 'shirts', type: 'Merch' });
  check('(d) missing name -> 400', noName.status === 400, `status ${noName.status}`);
  check('(d) missing name message', noName.data.error === 'name is required', JSON.stringify(noName.data));
  const badCat = await attempt({ name: 'X', category: 'merch', type: 'Merch' });
  check('(d) bad category -> 400', badCat.status === 400, `status ${badCat.status}`);
  check(
    '(d) bad category message lists the valid ids',
    typeof badCat.data.error === 'string' && badCat.data.error.startsWith('category must be one of:'),
    JSON.stringify(badCat.data)
  );
  const negPrice = await attempt({ name: 'X', category: 'shirts', type: 'Merch', price: -1 });
  check('(d) negative price -> 400', negPrice.status === 400, `status ${negPrice.status}`);
  check(
    '(d) negative price message',
    negPrice.data.error === 'price must be zero or greater',
    JSON.stringify(negPrice.data)
  );
  check('(d) failed creates wrote no rows', db.state.products.length === 0);
}

// =====================================================================================
// (e) DELETE removes the product; the read-back and a repeat delete
// both 404.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const headers = await authHeaders(env);
  const createRes = await productsCreate(
    ctx(
      jsonRequest(
        `${ORIGIN}/api/products`,
        'POST',
        { name: 'Doomed Widget', category: 'hats', type: 'Merch', price: 5 },
        headers
      ),
      env
    )
  );
  const created = await createRes.json();
  const delRes = await productDelete(
    ctx(jsonRequest(`${ORIGIN}/api/products/${created.id}`, 'DELETE', undefined, headers), env, {
      id: String(created.id),
    })
  );
  check('(e) DELETE -> 204', delRes.status === 204, `status ${delRes.status}`);
  const getRes = await productGet(
    ctx(new Request(`${ORIGIN}/api/products/${created.id}`), env, { id: String(created.id) })
  );
  const getData = await getRes.json().catch(() => ({}));
  check('(e) GET after delete -> 404', getRes.status === 404, `status ${getRes.status}`);
  check('(e) 404 message', getData.error === 'Product not found', JSON.stringify(getData));
  const delAgain = await productDelete(
    ctx(jsonRequest(`${ORIGIN}/api/products/${created.id}`, 'DELETE', undefined, headers), env, {
      id: String(created.id),
    })
  );
  check('(e) second DELETE -> 404', delAgain.status === 404, `status ${delAgain.status}`);
}

// =====================================================================================
// (f) Write endpoints require admin: no bearer token -> 401, and the
// catalog is untouched.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const res = await productsCreate(
    ctx(
      jsonRequest(`${ORIGIN}/api/products`, 'POST', { name: 'Sneaky', category: 'shirts', type: 'Merch' }),
      env
    )
  );
  check('(f) create without a token -> 401', res.status === 401, `status ${res.status}`);
  check('(f) nothing was written', db.state.products.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
