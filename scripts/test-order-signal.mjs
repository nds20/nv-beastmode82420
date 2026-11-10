// Order-signal + purchase-alert canary tests (2026-11-09) — plain node,
// no framework:
//
//   node scripts/test-order-signal.mjs
//
// Covers the shop-sale alert build (owner direction 2026-11-09: "send
// me an alert whenever anybody purchases the test product"; see
// docs/ORDER_ALERTS.md):
//   (a) Part 1 PROOF: a direct POST /api/orders with the demo-card
//       payload creates a real order row and returns it — id, the
//       per-order accessToken, and payment reduced to
//       { method: 'card', last4: '4242' } (the full card number is
//       stored NOWHERE) — even while Stripe is fully configured in
//       env. orders.js applies NO Stripe gate to the card path, so
//       the alert canary needs no production-code change. The placed
//       order is then readable through the real token-gated
//       GET /api/orders/:id/status (right token -> 200, wrong -> 403).
//   (b) GET /api/orders/signal on an empty DB ->
//       { latestPaidOrderId: null, latestPaidAt: null }, and the
//       response carries EXACTLY those two fields.
//   (c) An unpaid order (the Stripe path's resting state, and the
//       canary's own state) does NOT move the signal — abandoned /
//       in-flight checkouts must never false-alarm.
//   (d) The webhook's paid-marking (updateOrderPayment, and the REAL
//       signed webhook handler end-to-end) moves the signal to that
//       order: id + the order's created_at as latestPaidAt.
//   (e) A second, HIGHER unpaid order does not move the signal.
//   (f) A second paid order advances it; an older order marked paid
//       afterwards does not move it BACK (the signal is MAX(id)).
//   (g) getLatestPaidOrder direct-call coverage of the same timeline.
//
// The StubDB below is the test-inventory.mjs pattern: an in-memory D1
// stand-in with the FULL current schema (shipping + inventory columns
// present), so the lazy ensures find nothing to ALTER.

import { createHmac } from 'node:crypto';

import {
  createProduct,
  getOrder,
  updateOrderPayment,
  getLatestPaidOrder,
} from '../functions/api/_lib/db.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import { onRequestPost as ordersPost } from '../functions/api/orders.js';
import { onRequestGet as orderStatusGet } from '../functions/api/orders/[id]/status.js';
import { onRequestGet as orderSignalGet } from '../functions/api/orders/signal.js';
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

// ----- In-memory D1 stub (inventory-suite pattern, full schema) -----------------

const PRODUCT_COLS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength', 'price',
  'unit', 'effects', 'tile', 'image', 'weight_oz', 'length_in', 'width_in',
  'height_in', 'stock_qty', 'low_stock_threshold', 'free_shipping',
  'brand', 'sizes', 'scent',
];
const ORDER_COLS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment', 'status',
  'created_at', 'seen_at', 'payment_status', 'stripe_session_id',
  'stripe_payment_intent_id', 'access_token', 'shipping_cents',
  'shipping_service', 'shipping_label', 'shipping_weight_oz',
  'inventory_applied',
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
    if (/^UPDATE products/i.test(stmt)) return this.updateRows('products', stmt, params);
    if (/^UPDATE orders/i.test(stmt)) return this.updateRows('orders', stmt, params);
    throw new Error(`StubDB: unhandled statement: ${stmt}`);
  }

  selectRows(stmt, params) {
    const table = /FROM products/i.test(stmt) ? 'products' : 'orders';
    let rows = [...this.state[table]];
    if (/payment_status = 'paid'/.test(stmt)) {
      // The signal query: paid only, highest id first, one row.
      rows = rows.filter((r) => r.payment_status === 'paid').sort((a, b) => b.id - a.id);
      rows = /LIMIT 1/i.test(stmt) ? rows.slice(0, 1) : rows;
    } else if (/stripe_session_id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.stripe_session_id === params[0]);
    } else if (/WHERE id = \?/.test(stmt)) {
      rows = rows.filter((r) => r.id === Number(params[0]));
    }
    if (/ORDER BY id DESC/i.test(stmt) && !/LIMIT 1/i.test(stmt)) {
      rows.sort((a, b) => b.id - a.id);
    }
    return rows;
  }

  first(stmt, params) {
    if (/^SELECT COUNT/i.test(stmt)) {
      const rows = this.selectRows(stmt, params);
      const m = stmt.match(/status = '(\w+)'/);
      const n = m ? rows.filter((r) => r.status === m[1]).length : rows.length;
      return { n };
    }
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

// The canary's buyer identity, exactly as docs/ORDER_ALERTS.md records
// it — the owner recognizes it instantly in the admin Orders tab.
const CANARY_CUSTOMER = {
  fullName: 'Muse Alert Canary',
  phone: '5855550100',
  address: '824 Canary Way',
  city: 'Rochester',
  zip: '14617',
  notes: 'Automated purchase-alert canary — not a real customer.',
};
const CANARY_CARD = '4242424242424242';

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

// Stripe FULLY configured — the whole point of Part 1 is that the
// demo-card order still lands in this world.
function baseEnv(db, extra = {}) {
  return {
    DB: db,
    BEASTMODE_ADMIN_SECRET: 'signal-test-admin-secret',
    STRIPE_SECRET_KEY: 'sk_test_signal_suite',
    STRIPE_WEBHOOK_SECRET: 'whsec_signal_test',
    ...extra,
  };
}

async function makeProduct(env, over = {}) {
  const data = normalizeProduct({
    name: 'Test Item',
    category: 'test-item',
    type: 'Test',
    price: 8.24,
    ...over,
  });
  return createProduct(env, data);
}

async function placeOrder(env, body) {
  const res = await ordersPost(ctx(jsonRequest(`${ORIGIN}/api/orders`, 'POST', body), env));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function readSignal(env) {
  const res = await orderSignalGet(ctx(
    new Request(`${ORIGIN}/api/orders/signal`, { method: 'GET' }),
    env
  ));
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function readStatus(env, id, token) {
  const url = `${ORIGIN}/api/orders/${id}/status?token=${encodeURIComponent(token || '')}`;
  const res = await orderStatusGet(ctx(new Request(url, { method: 'GET' }), env, { id: String(id) }));
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

// =====================================================================================
// (a) Part 1 proof: the demo-card order lands even with Stripe configured.
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env);

  const canary = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CANARY_CUSTOMER,
    payment: { cardNumber: CANARY_CARD },
  });
  check('(a) canary POST /api/orders with demo card -> 201 with Stripe configured',
    canary.status === 201, `got ${canary.status}: ${JSON.stringify(canary.data)}`);
  check('(a) order carries a numeric id', Number.isInteger(canary.data.id), `id=${canary.data.id}`);
  check('(a) order returns its per-order accessToken to the caller',
    typeof canary.data.accessToken === 'string' && canary.data.accessToken.length >= 32,
    `token=${canary.data.accessToken}`);
  check('(a) payment is reduced to { method: card, last4: 4242 }',
    canary.data.payment && canary.data.payment.method === 'card' && canary.data.payment.last4 === '4242',
    JSON.stringify(canary.data.payment));
  check('(a) the full card number is stored NOWHERE in the order',
    !JSON.stringify(canary.data).includes(CANARY_CARD) &&
    !JSON.stringify(db.state.orders).includes(CANARY_CARD));

  const stored = await getOrder(env, canary.data.id);
  check('(a) the order row persisted (getOrder reads it back)',
    stored && stored.id === canary.data.id && stored.paymentStatus === 'unpaid');
  check('(a) canary customer identity persisted for the Orders tab',
    stored.customer.fullName === 'Muse Alert Canary' && stored.customer.zip === '14617',
    JSON.stringify(stored.customer));

  const okStatus = await readStatus(env, canary.data.id, canary.data.accessToken);
  check('(a) status endpoint accepts the returned token',
    okStatus.status === 200 && okStatus.data.id === canary.data.id &&
    okStatus.data.paymentStatus === 'unpaid',
    `status ${okStatus.status}: ${JSON.stringify(okStatus.data)}`);
  const badStatus = await readStatus(env, canary.data.id, 'not-the-token');
  check('(a) status endpoint still rejects a wrong token', badStatus.status === 403, `got ${badStatus.status}`);
}

// =====================================================================================
// (b)-(g) The signal timeline (one shared database — ids are sequential).
// =====================================================================================
{
  const db = new StubDB();
  const env = baseEnv(db);
  const product = await makeProduct(env);

  // (b) Empty DB -> nulls, exactly two fields.
  const empty = await readSignal(env);
  check('(b) empty DB -> 200 with nulls',
    empty.status === 200 && empty.data.latestPaidOrderId === null && empty.data.latestPaidAt === null,
    `status ${empty.status}: ${JSON.stringify(empty.data)}`);
  check('(b) signal response carries EXACTLY the two documented fields',
    Object.keys(empty.data).sort().join(',') === 'latestPaidAt,latestPaidOrderId',
    Object.keys(empty.data).join(','));
  const emptyDirect = await getLatestPaidOrder(env);
  check('(g) getLatestPaidOrder on empty DB -> nulls',
    emptyDirect.latestPaidOrderId === null && emptyDirect.latestPaidAt === null);

  // (c) An unpaid order appears (Stripe path: no payment payload).
  const first = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CANARY_CUSTOMER,
  });
  check('(c) stripe-path order places unpaid',
    first.status === 201 && first.data.paymentStatus === 'unpaid' && first.data.payment === null,
    `status ${first.status}: ${JSON.stringify(first.data)}`);
  const afterUnpaid = await readSignal(env);
  check('(c) unpaid order does NOT move the signal',
    afterUnpaid.data.latestPaidOrderId === null && afterUnpaid.data.latestPaidAt === null,
    JSON.stringify(afterUnpaid.data));

  // (d) The webhook's paid-marking, via the db write it performs.
  await updateOrderPayment(env, first.data.id, { paymentStatus: 'paid' });
  const afterPaid = await readSignal(env);
  check('(d) paid order moves the signal to its id',
    afterPaid.data.latestPaidOrderId === first.data.id,
    JSON.stringify(afterPaid.data));
  check('(d) latestPaidAt is the order\'s created_at',
    afterPaid.data.latestPaidAt === first.data.createdAt &&
    typeof afterPaid.data.latestPaidAt === 'string',
    `${afterPaid.data.latestPaidAt} vs ${first.data.createdAt}`);

  // (e) A second, higher order left unpaid must not move it.
  const second = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CANARY_CUSTOMER,
  });
  check('(e) second order placed with a higher id',
    second.status === 201 && second.data.id > first.data.id);
  const afterSecond = await readSignal(env);
  check('(e) higher UNPAID order does not move the signal',
    afterSecond.data.latestPaidOrderId === first.data.id &&
    afterSecond.data.latestPaidAt === first.data.createdAt,
    JSON.stringify(afterSecond.data));

  // (f) Second order paid -> signal advances; back-filling an older
  // paid state never moves it back.
  await updateOrderPayment(env, second.data.id, { paymentStatus: 'paid' });
  const afterSecondPaid = await readSignal(env);
  check('(f) second PAID order advances the signal',
    afterSecondPaid.data.latestPaidOrderId === second.data.id &&
    afterSecondPaid.data.latestPaidAt === second.data.createdAt,
    JSON.stringify(afterSecondPaid.data));
  await updateOrderPayment(env, first.data.id, { paymentStatus: 'paid' });
  const afterRefill = await readSignal(env);
  check('(f) re-marking an OLDER order paid never moves the signal back',
    afterRefill.data.latestPaidOrderId === second.data.id,
    JSON.stringify(afterRefill.data));

  // (d, end-to-end) The REAL signed webhook marks a third order paid
  // exactly the way production does — and the signal follows it.
  const third = await placeOrder(env, {
    items: [{ productId: product.id, qty: 1 }],
    customer: CANARY_CUSTOMER,
  });
  const hookStatus = await deliverWebhook(env, {
    id: 'evt_signal_completed_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_signal_1',
        metadata: { order_id: String(third.data.id) },
        payment_intent: 'pi_signal_1',
      },
    },
  });
  check('(d) signed checkout.session.completed webhook -> 200', hookStatus === 200, `got ${hookStatus}`);
  const afterWebhook = await readSignal(env);
  check('(d) signal follows the webhook-paid order',
    afterWebhook.data.latestPaidOrderId === third.data.id &&
    (await getOrder(env, third.data.id)).paymentStatus === 'paid',
    JSON.stringify(afterWebhook.data));
  const directFinal = await getLatestPaidOrder(env);
  check('(g) getLatestPaidOrder agrees with the endpoint at the end',
    directFinal.latestPaidOrderId === third.data.id &&
    directFinal.latestPaidAt === third.data.createdAt);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
