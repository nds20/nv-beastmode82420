// Photo-upload path tests (2026-11-10) — plain node, no framework:
//
//   node scripts/test-photo-upload.mjs
//
// Covers the diagnosis of 2026-11-10: storage (R2 binding, put/get)
// was proven HEALTHY by the /api/products/photo-debug probe, while
// multipart product saves kept failing client-side with a non-JSON
// ("bad-response") error. These tests drive the REAL route handlers
// (create + update) through multipart bodies with a stub R2 bucket
// and the test-mail StubDB pattern:
//
//   (a) create with a small JPEG succeeds end-to-end (201, image set)
//   (b) update with a ~3 MB JPEG (typical prepared iPhone photo)
//       succeeds (200, image replaced)
//   (c) update with NO photo still works (JSON-less multipart,
//       fields only)
//   (d) update with a non-image file -> clean JSON 400 with the
//       allowlist message (a validation answer, never a crash)
//   (e) create with an 11 MB photo -> clean JSON 400 'File too
//       large'
//   (f) attachPhoto surfaces an R2 put failure as a 500 whose JSON
//       body NAMES the underlying error (no silent swallowing)
//   (g) update of a missing product -> 404 JSON

import {
  createProduct,
} from '../functions/api/_lib/db.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import { issueToken } from '../functions/api/_lib/auth.js';
import { onRequestPost as productsCreate } from '../functions/api/products.js';
import { onRequestPut as productUpdate } from '../functions/api/products/[id].js';

// ----- tiny harness ------------------------------------------------------------
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

// ----- In-memory D1 stub (same approach as scripts/test-mail.mjs) --------------
const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'description', 'image', 'image_ext', 'tile', 'sort',
  'stock_qty', 'low_stock_threshold', 'free_shipping', 'weight_oz',
  'length_in', 'width_in', 'height_in', 'brand', 'sizes', 'scent',
  'condition', 'accepts_offers', 'created_at', 'updated_at',
];

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") { cur += s[i + 1]; i += 1; } else inStr = false;
      }
    } else if (ch === "'") { inStr = true; cur += ch; }
    else if (ch === '(') { depth += 1; cur += ch; }
    else if (ch === ')') { depth -= 1; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class StubDB {
  constructor() {
    this.state = { products: [] };
    this.lastId = { products: 0 };
  }

  pragma(table) {
    const cols = table === 'products' ? PRODUCT_COLS : [];
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
    const m = stmt.match(/INSERT(?: OR IGNORE)? INTO \w+ \(([^)]+)\) VALUES \(([\s\S]+)\)/i);
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
    const m = stmt.match(/SET ([\s\S]+?) WHERE/i);
    if (!m) return { meta: { changes: 0 } };
    const sets = splitTopLevel(m[1]);
    const idMatch = stmt.match(/WHERE id = \?/i);
    let changes = 0;
    for (const row of this.state[table]) {
      if (idMatch && row.id !== params[params.length - 1]) continue;
      let p = 0;
      for (const s of sets) {
        const eq = s.indexOf('=');
        const col = s.slice(0, eq).trim();
        const expr = s.slice(eq + 1).trim();
        if (expr === '?') row[col] = params[p++];
        else if (/^MAX\(0/i.test(expr)) row[col] = Math.max(0, (row[col] || 0) - params[p++]);
        else if (/^'[\s\S]*'$/.test(expr)) row[col] = expr.slice(1, -1);
        else if (/^-?\d+(\.\d+)?$/.test(expr)) row[col] = Number(expr);
      }
      changes += 1;
    }
    return { meta: { changes } };
  }

  run(stmt, params) {
    if (/^PRAGMA/i.test(stmt)) return { results: [] };
    if (/CREATE|ALTER/i.test(stmt)) return { meta: { changes: 0 } };
    if (/^INSERT INTO products/i.test(stmt)) return this.insertRow('products', stmt, params);
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^DELETE FROM products/i.test(stmt)) {
      const id = params[params.length - 1];
      const before = this.state.products.length;
      this.state.products = this.state.products.filter((r) => r.id !== id);
      return { meta: { changes: before - this.state.products.length } };
    }
    return { meta: { changes: 0 } };
  }

  first(stmt, params) {
    if (/^PRAGMA/i.test(stmt)) return null;
    if (/FROM products/i.test(stmt)) {
      const row = this.state.products.find((r) => r.id === params[params.length - 1]);
      return row ? { ...row } : null;
    }
    return null;
  }

  all(stmt, params) {
    if (/^PRAGMA table_info/i.test(stmt)) return this.pragma('products');
    if (/FROM products/i.test(stmt)) return { results: this.state.products.map((r) => ({ ...r })) };
    return { results: [] };
  }
}

// ----- Stub R2 -----------------------------------------------------------------
function makeBucket() {
  return {
    objects: new Map(),
    async put(key, value) {
      const buf = value && typeof value.arrayBuffer === 'function'
        ? Buffer.from(await value.arrayBuffer())
        : Buffer.from(String(value));
      this.objects.set(key, buf);
    },
    async get(key) {
      const buf = this.objects.get(key);
      if (!buf) return null;
      return { body: buf, size: buf.length, httpMetadata: {}, httpEtag: '"stub"' };
    },
    async delete(key) { this.objects.delete(key); },
  };
}

function makeEnv() {
  const db = new StubDB();
  return {
    DB: db,
    BEASTMODE_ADMIN_SECRET: '<redacted>',
    PRODUCT_PHOTOS: makeBucket(),
  };
}

function ctx(request, env, params = {}) {
  return { request, env, params, waitUntil() {} };
}

const ORIGIN = 'https://beastmode82420.com';

async function adminAuth(env) {
  const { token } = await issueToken(env, 'boss');
  return { Authorization: `Bearer ${token}` };
}

function multipartRequest(url, method, fields, file) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('photo', file, file.name);
  return new Request(url, { method, body: form });
}

function jpegBytes(size) {
  const buf = new Uint8Array(size);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; // SOI — cosmetic; server checks name/type only
  return buf;
}

const BASE_FIELDS = {
  name: 'Photo Test Shirt',
  category: 'shirts',
  type: 'Button down',
  price: '20',
};

// (a) create with a small JPEG
{
  const env = makeEnv();
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(2048)], 'shirt.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/products`, 'POST', BASE_FIELDS, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productsCreate(ctx(req, env));
  const data = await res.json().catch(() => ({}));
  check('(a) create with photo -> 201', res.status === 201, `got ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  check('(a) product image points at the photo route', typeof data.image === 'string' && data.image.startsWith('/api/photos/products/'), JSON.stringify(data.image));
  check('(a) object landed in the bucket', env.PRODUCT_PHOTOS.objects.size === 1, `size ${env.PRODUCT_PHOTOS.objects.size}`);
}

// (b) update with a ~3 MB JPEG (prepared iPhone photo size)
{
  const env = makeEnv();
  const created = await createProduct(env, normalizeProduct({ name: 'Button down shirt', category: 'shirts', price: 20 }));
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(3 * 1024 * 1024)], 'IMG_4242.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/products/${created.id}`, 'PUT', { ...BASE_FIELDS, name: 'Button down shirt' }, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productUpdate(ctx(req, env, { id: String(created.id) }));
  const data = await res.json().catch(() => ({}));
  check('(b) update with ~3MB photo -> 200', res.status === 200, `got ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  check('(b) image replaced with the new photo', typeof data.image === 'string' && data.image.includes('button-down-shirt'), JSON.stringify(data.image));
}

// (c) update with no photo (fields only)
{
  const env = makeEnv();
  const created = await createProduct(env, normalizeProduct({ name: 'Plain Shirt', category: 'shirts', price: 15 }));
  const auth = await adminAuth(env);
  const req = multipartRequest(`${ORIGIN}/api/products/${created.id}`, 'PUT', { name: 'Plain Shirt', category: 'shirts', price: '16' }, null);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productUpdate(ctx(req, env, { id: String(created.id) }));
  const data = await res.json().catch(() => ({}));
  check('(c) update without photo -> 200', res.status === 200, `got ${res.status}`);
  check('(c) price updated, image untouched', data.price === 16 && !data.image, JSON.stringify({ price: data.price, image: data.image }));
}

// (d) non-image file -> clean JSON 400
{
  const env = makeEnv();
  const created = await createProduct(env, normalizeProduct({ name: 'Doc Shirt', category: 'shirts', price: 15 }));
  const auth = await adminAuth(env);
  const file = new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' });
  const req = multipartRequest(`${ORIGIN}/api/products/${created.id}`, 'PUT', BASE_FIELDS, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productUpdate(ctx(req, env, { id: String(created.id) }));
  const data = await res.json().catch(() => ({}));
  check('(d) non-image file -> 400', res.status === 400, `got ${res.status}`);
  check('(d) error is the allowlist message', /photo must be an image file/.test(data.error || ''), JSON.stringify(data));
}

// (e) 11 MB photo -> clean JSON 400 'File too large'
{
  const env = makeEnv();
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(11 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/products`, 'POST', BASE_FIELDS, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productsCreate(ctx(req, env));
  const data = await res.json().catch(() => ({}));
  check('(e) 11MB photo -> 400', res.status === 400, `got ${res.status}: ${JSON.stringify(data).slice(0, 120)}`);
  check('(e) error is File too large', data.error === 'File too large', JSON.stringify(data));
}

// (f) R2 put failure surfaces as a 500 naming the error
{
  const env = makeEnv();
  env.PRODUCT_PHOTOS = {
    async put() { throw new Error('stub r2 exploded'); },
    async get() { return null; },
    async delete() {},
  };
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(1024)], 'shirt.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/products`, 'POST', BASE_FIELDS, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productsCreate(ctx(req, env));
  const data = await res.json().catch(() => ({}));
  check('(f) put failure -> 500 JSON', res.status === 500 && typeof data.error === 'string', `got ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
  check('(f) 500 body names the underlying error', /stub r2 exploded/.test(data.error || ''), JSON.stringify(data));
}

// (g) missing product -> 404 JSON
{
  const env = makeEnv();
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(1024)], 'shirt.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/products/999`, 'PUT', BASE_FIELDS, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await productUpdate(ctx(req, env, { id: '999' }));
  const data = await res.json().catch(() => ({}));
  check('(g) missing product -> 404 JSON', res.status === 404 && data.error === 'Product not found', `got ${res.status}: ${JSON.stringify(data).slice(0, 120)}`);
}

// (h) the editor's photo step: POST /api/admin/products/:id/photo —
// the staged endpoint (parse -> store -> verify) the client now uses.
{
  const { onRequestPost: adminPhoto } = await import('../functions/api/admin/products/[id]/photo.js');

  // happy path
  const env = makeEnv();
  const created = await createProduct(env, normalizeProduct({ name: 'Button down shirt', category: 'shirts', price: 20 }));
  const auth = await adminAuth(env);
  const file = new File([jpegBytes(3 * 1024 * 1024)], 'IMG_4242.jpg', { type: 'image/jpeg' });
  const req = multipartRequest(`${ORIGIN}/api/admin/products/${created.id}/photo`, 'POST', {}, file);
  Object.entries(auth).forEach(([k, v]) => req.headers.set(k, v));
  const res = await adminPhoto(ctx(req, env, { id: String(created.id) }));
  const data = await res.json().catch(() => ({}));
  check('(h) admin photo POST -> 200 ok:true', res.status === 200 && data.ok === true, `got ${res.status}: ${JSON.stringify(data).slice(0, 220)}`);
  check('(h) stages parse/store/verify all ok', Array.isArray(data.stages) && data.stages.length === 3 && data.stages.every((s) => s.ok), JSON.stringify(data.stages));
  check('(h) parse stage reports the received file', data.stages && data.stages[0].photo && data.stages[0].photo.size === 3 * 1024 * 1024, JSON.stringify(data.stages && data.stages[0]));
  check('(h) product carries the photo', data.product && typeof data.product.image === 'string' && data.product.image.includes('button-down-shirt'), JSON.stringify(data.product && data.product.image));

  // no photo in the body -> 400 naming the parse stage
  const env2 = makeEnv();
  const created2 = await createProduct(env2, normalizeProduct({ name: 'Plain', category: 'shirts', price: 10 }));
  const auth2 = await adminAuth(env2);
  const req2 = multipartRequest(`${ORIGIN}/api/admin/products/${created2.id}/photo`, 'POST', {}, null);
  Object.entries(auth2).forEach(([k, v]) => req2.headers.set(k, v));
  const res2 = await adminPhoto(ctx(req2, env2, { id: String(created2.id) }));
  const data2 = await res2.json().catch(() => ({}));
  check('(h) no photo -> 400 at parse stage', res2.status === 400 && data2.ok === false && data2.stage === 'parse', `got ${res2.status}: ${JSON.stringify(data2).slice(0, 160)}`);

  // missing product -> 404 at lookup stage
  const req3 = multipartRequest(`${ORIGIN}/api/admin/products/999/photo`, 'POST', {}, new File([jpegBytes(64)], 'x.jpg', { type: 'image/jpeg' }));
  Object.entries(auth2).forEach(([k, v]) => req3.headers.set(k, v));
  const res3 = await adminPhoto(ctx(req3, env2, { id: '999' }));
  const data3 = await res3.json().catch(() => ({}));
  check('(h) missing product -> 404 at lookup stage', res3.status === 404 && data3.ok === false && data3.stage === 'lookup', `got ${res3.status}`);

  // store failure names the store stage + underlying error
  const env4 = makeEnv();
  const created4 = await createProduct(env4, normalizeProduct({ name: 'Boom', category: 'shirts', price: 10 }));
  env4.PRODUCT_PHOTOS = { async put() { throw new Error('stub r2 exploded'); }, async get() { return null; }, async delete() {} };
  const auth4 = await adminAuth(env4);
  const req4 = multipartRequest(`${ORIGIN}/api/admin/products/${created4.id}/photo`, 'POST', {}, new File([jpegBytes(64)], 'x.jpg', { type: 'image/jpeg' }));
  Object.entries(auth4).forEach(([k, v]) => req4.headers.set(k, v));
  const res4 = await adminPhoto(ctx(req4, env4, { id: String(created4.id) }));
  const data4 = await res4.json().catch(() => ({}));
  check('(h) put failure -> stage store + error named', res4.status === 500 && data4.stage === 'store' && /stub r2 exploded/.test(data4.error || ''), `got ${res4.status}: ${JSON.stringify(data4).slice(0, 180)}`);

  // unauthenticated -> 401
  const req5 = multipartRequest(`${ORIGIN}/api/admin/products/${created.id}/photo`, 'POST', {}, new File([jpegBytes(64)], 'x.jpg', { type: 'image/jpeg' }));
  const res5 = await adminPhoto(ctx(req5, env, { id: String(created.id) }));
  check('(h) no admin token -> 401', res5.status === 401, `got ${res5.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
