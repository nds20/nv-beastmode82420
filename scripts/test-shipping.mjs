// Shipping feature tests — plain node, no dependencies.
// Run: node scripts/test-shipping.mjs
//
// Exercises the real shipping code end-to-end (in-process):
//   * _lib/usps.js + _lib/shipping.js quoting (token OAuth, per-class
//     base-rates calls, weight math, fallback),
//   * POST /api/shipping/quote and POST /api/orders route handlers,
//   * _lib/db.js product/order persistence incl. the lazy
//     ensureShippingColumns migration on a pre-shipping schema,
//   * _lib/stripe.js checkout sessions carrying the shipping line,
// with global fetch mocked at the USPS and Stripe API bases and an
// in-memory D1 stub implementing just the statements those paths
// issue (PRAGMA table_info, ALTER TABLE, product/order SELECT /
// INSERT / UPDATE with explicit column lists).
//
// Note: _lib/db.js caches its ensure promise per isolate, so the
// legacy-schema section runs FIRST and later stub DBs simply serve
// rows — same harness artifact the donate tests document.

import { onRequestPost as orderCreate } from '../functions/api/orders.js';
import { onRequestPost as shippingQuoteRoute } from '../functions/api/shipping/quote.js';
import { normalizeProduct } from '../functions/api/_lib/validate.js';
import { quoteShipping, computePackage, FALLBACK_FLAT_CENTS } from '../functions/api/_lib/shipping.js';
import { createProduct, updateProduct, rowToProduct } from '../functions/api/_lib/db.js';
import { createCheckoutSession } from '../functions/api/_lib/stripe.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

// ----- D1 stub ---------------------------------------------------------------

class StubStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  async run() {
    return this.db.run(this.sql, this.params);
  }
  async first() {
    return this.db.first(this.sql, this.params);
  }
  async all() {
    return this.db.all(this.sql, this.params);
  }
}

const BASE_PRODUCT_COLUMNS = [
  'id', 'name', 'subtitle', 'category', 'type', 'thc', 'strength',
  'price', 'unit', 'effects', 'tile', 'image', 'brand', 'sizes', 'scent',
];
const BASE_ORDER_COLUMNS = [
  'id', 'items', 'subtotal', 'tax', 'total', 'customer', 'payment',
  'status', 'created_at', 'seen_at', 'payment_status',
  'stripe_session_id', 'stripe_payment_intent_id', 'access_token',
];

function parseColumnList(sql) {
  const m = sql.match(/\(([^)]+)\)\s*VALUES/i);
  return m[1].split(',').map((s) => s.trim());
}

function parseAssignments(setPart) {
  // SET clauses are multiline (db.js formats UPDATEs across lines), so
  // collapse whitespace before splitting: a piece like
  // "\n price = ?" would otherwise keep a dirty column name.
  return setPart
    .replace(/\s+/g, ' ')
    .split(',')
    .map((piece) => {
      const [col, rhs] = piece.split('=').map((s) => s.trim());
      return { col, rhs };
    });
}

class StubDB {
  constructor({ legacySchema = false } = {}) {
    this.products = [];
    this.orders = [];
    this.nextProductId = 1;
    this.nextOrderId = 1;
    this.alters = [];
    this.pragma = {
      products: [...BASE_PRODUCT_COLUMNS],
      orders: [...BASE_ORDER_COLUMNS],
    };
    if (!legacySchema) {
      this.pragma.products.push('weight_oz', 'length_in', 'width_in', 'height_in');
      this.pragma.orders.push('shipping_cents', 'shipping_service', 'shipping_label', 'shipping_weight_oz');
    }
  }
  prepare(sql) {
    return new StubStatement(this, sql);
  }
  async run(sql, params) {
    let m;
    if ((m = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/))) {
      this.pragma[m[1]].push(m[2]);
      this.alters.push(`${m[1]}.${m[2]}`);
      return { meta: { changes: 0, last_row_id: 0 } };
    }
    if (sql.startsWith('INSERT INTO products')) {
      const cols = parseColumnList(sql);
      const row = { id: this.nextProductId++ };
      cols.forEach((col, i) => {
        row[col] = params[i];
      });
      this.products.push(row);
      return { meta: { changes: 1, last_row_id: row.id } };
    }
    if (sql.startsWith('INSERT INTO orders')) {
      const cols = parseColumnList(sql);
      const valuesPart = sql.slice(sql.indexOf('VALUES'));
      const tokens = valuesPart
        .slice(valuesPart.indexOf('(') + 1, valuesPart.lastIndexOf(')'))
        .split(',')
        .map((s) => s.trim());
      const row = { id: this.nextOrderId++ };
      let p = 0;
      cols.forEach((col, i) => {
        const tok = tokens[i];
        if (tok === '?') row[col] = params[p++];
        else if (tok === 'NULL') row[col] = null;
        else row[col] = tok.replace(/^'|'$/g, '');
      });
      this.orders.push(row);
      return { meta: { changes: 1, last_row_id: row.id } };
    }
    if ((m = sql.match(/UPDATE (products|orders)\s+SET ([\s\S]+?) WHERE id = \?/))) {
      const table = m[1];
      const rows = table === 'products' ? this.products : this.orders;
      const row = rows.find((r) => r.id === Number(params[params.length - 1]));
      if (row) {
        let p = 0;
        for (const { col, rhs } of parseAssignments(m[2])) {
          if (rhs === '?') row[col] = params[p++];
          else if (rhs === 'NULL') row[col] = null;
          else row[col] = rhs.replace(/^'|'$/g, '');
        }
      }
      return { meta: { changes: row ? 1 : 0, last_row_id: 0 } };
    }
    return { meta: { changes: 0, last_row_id: 0 } };
  }
  async first(sql, params) {
    if (sql.includes('FROM products')) {
      return this.products.find((r) => r.id === Number(params[0])) || null;
    }
    if (sql.includes('FROM orders') && sql.includes('stripe_session_id = ?')) {
      return this.orders.find((r) => r.stripe_session_id === params[0]) || null;
    }
    if (sql.includes('FROM orders')) {
      return this.orders.find((r) => r.id === Number(params[0])) || null;
    }
    return null;
  }
  async all(sql) {
    const m = sql.match(/PRAGMA table_info\((\w+)\)/);
    if (m) return { results: this.pragma[m[1]].map((name) => ({ name })) };
    if (sql.includes('FROM products')) return { results: [...this.products] };
    if (sql.includes('FROM orders')) {
      return { results: [...this.orders].sort((a, b) => b.id - a.id) };
    }
    return { results: [] };
  }
}

function seedProducts(db) {
  const base = {
    subtitle: '',
    category: 'shirts',
    type: 'Merch',
    thc: null,
    strength: 'THC TBD',
    unit: 'item',
    effects: '[]',
    tile: '["#374151","#111827"]',
    image: null,
    weight_oz: null,
    length_in: null,
    width_in: null,
    height_in: null,
  };
  db.products.push(
    { ...base, id: 1, name: '824 Tee', price: 20, weight_oz: 8, length_in: 10, width_in: 8, height_in: 2 },
    { ...base, id: 2, name: '824 Hoodie', price: 50 },
    { ...base, id: 3, name: 'Mystery Item', price: null, weight_oz: 4 }
  );
  db.nextProductId = 4;
  return db;
}

// ----- Fetch mock (USPS + Stripe) ---------------------------------------------

const USPS_BASE = 'https://usps.test';
const STRIPE_BASE = 'https://stripe.test';
let tokenCalls = 0;
let uspsPriceCalls = [];
let uspsPriceBehavior = {};
let lastStripeCall = null;
const realFetch = globalThis.fetch;

function resetUspsBehavior() {
  uspsPriceCalls = [];
  uspsPriceBehavior = {
    USPS_GROUND_ADVANTAGE: { status: 200, body: { totalBasePrice: 9.31, rates: [{ price: 9.31, zone: '4' }] } },
    PRIORITY_MAIL: { status: 200, body: { totalBasePrice: 12.4, rates: [{ price: 12.4, zone: '4' }] } },
  };
}
resetUspsBehavior();

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith(USPS_BASE)) {
    if (u.endsWith('/oauth2/v3/token')) {
      tokenCalls += 1;
      const body = JSON.parse(init.body);
      if (body.grant_type !== 'client_credentials' || !body.client_id || !body.client_secret) {
        return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: 'tok-test-1', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.endsWith('/prices/v3/base-rates/search')) {
      const body = JSON.parse(init.body);
      uspsPriceCalls.push({ body, auth: init.headers.Authorization });
      const behavior = uspsPriceBehavior[body.mailClass] || { status: 500, body: {} };
      return new Response(JSON.stringify(behavior.body), {
        status: behavior.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }
  if (u.startsWith(STRIPE_BASE)) {
    lastStripeCall = { url: u, init };
    return new Response(
      JSON.stringify({ id: 'cs_ship_test', url: 'https://checkout.stripe.com/c/pay/cs_ship_test' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return realFetch(url, init);
};

// ----- Helpers ------------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';

function postJson(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CUSTOMER = {
  fullName: 'Test Buyer',
  phone: '5855551234',
  address: '1 Main St',
  city: 'Rochester',
  zip: '14617',
};

function uspsEnv(db) {
  return {
    DB: db,
    USPS_CLIENT_ID: 'cid-test',
    USPS_CLIENT_SECRET: 'secret-test',
    USPS_ORIGIN_ZIP: '14617',
    USPS_API_BASE: USPS_BASE,
  };
}

// ----- (f) Product validation -----------------------------------------------------

console.log('products — shipping field validation');
{
  const baseBody = { name: 'Widget', category: 'shirts', type: 'Merch' };
  const ok = normalizeProduct({ ...baseBody, weightOz: 16, lengthIn: 12, widthIn: 9, heightIn: 6 }, null);
  check('valid measures pass through', ok.weightOz === 16 && ok.lengthIn === 12 && ok.widthIn === 9 && ok.heightIn === 6);
  const unset = normalizeProduct({ ...baseBody }, null);
  check('omitted measures stay null', unset.weightOz === null && unset.lengthIn === null && unset.widthIn === null && unset.heightIn === null);
  const viaStrings = normalizeProduct({ ...baseBody, weightOz: '8.5' }, null);
  check('multipart string weight parses', viaStrings.weightOz === 8.5);

  const badCases = [
    ['weightOz 0', { weightOz: 0 }],
    ['weightOz negative', { weightOz: -3 }],
    ['weightOz over 1120', { weightOz: 1121 }],
    ['lengthIn 0', { lengthIn: 0 }],
    ['widthIn negative', { widthIn: -1 }],
    ['heightIn over 108', { heightIn: 109 }],
    ['weightOz not a number', { weightOz: 'heavy' }],
  ];
  for (const [name, patch] of badCases) {
    let status = null;
    try {
      normalizeProduct({ ...baseBody, ...patch }, null);
    } catch (err) {
      status = err.status;
    }
    check(`${name} -> 400`, status === 400, `got ${status}`);
  }
}

// ----- Lazy ensure on a pre-shipping schema + (c) unconfigured order ------------

console.log('db — lazy shipping columns + unconfigured order');
{
  const db = seedProducts(new StubDB({ legacySchema: true }));
  const env = { DB: db }; // no USPS_* -> shipping dormant

  const res = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'priority_mail', // must be ignored while unconfigured
      shippingCents: 99999, // must be ignored always
    }),
    env,
    params: {},
  });
  const order = await res.json();
  // 8 shipping columns + the 4 inventory columns ensureInventoryColumns
  // adds on the same reads (inventory build, 2026-11-09).
  check('legacy schema: ensure ALTERed all 8 shipping columns', db.alters.filter((a) => !/stock_qty|low_stock_threshold|free_shipping|inventory_applied/.test(a)).length === 8, db.alters.join(','));
  check(
    'legacy schema: product + order columns both covered',
    db.alters.includes('products.weight_oz') && db.alters.includes('orders.shipping_cents')
  );
  check('unconfigured order -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(order)}`);
  check('unconfigured totals unchanged (20 + 2.04 tax)', order.subtotal === 20 && order.tax === 2.04 && order.total === 22.04, JSON.stringify(order));
  check('unconfigured shipping is zero/null', order.shippingCents === 0 && order.shippingService === null && order.shippingLabel === null);
}

// ----- (a)+(b) USPS quoting --------------------------------------------------------

console.log('usps — token caching and quote math');
{
  const env = uspsEnv(new StubDB());
  const entries = [
    { product: { weightOz: 8, lengthIn: 10, widthIn: 8, heightIn: 2 }, qty: 2 },
    { product: { weightOz: null, lengthIn: null, widthIn: null, heightIn: null }, qty: 1 },
  ];

  const before = tokenCalls;
  const q1 = await quoteShipping(env, entries, '14617');
  const q2 = await quoteShipping(env, entries, '14617');
  check('one token call serves two quotes', tokenCalls - before === 1, `delta=${tokenCalls - before}`);
  check('quote is configured', q1.configured === true);
  check('weight: 8x2 + default 16 = 32 oz', q1.weightOz === 32, `got ${q1.weightOz}`);
  check('weight in pounds is 2.0', q1.weightLb === 2, `got ${q1.weightLb}`);
  check('both classes offered', q1.options.length === 2, JSON.stringify(q1.options));
  const ga = q1.options.find((o) => o.service === 'ground_advantage');
  const pm = q1.options.find((o) => o.service === 'priority_mail');
  check('ground advantage 9.31 -> 931 cents', ga && ga.priceCents === 931 && ga.label === 'USPS Ground Advantage', JSON.stringify(ga));
  check('priority 12.40 -> 1240 cents', pm && pm.priceCents === 1240 && pm.label === 'USPS Priority Mail', JSON.stringify(pm));
  check('zone carried through', ga && ga.zone === '4');
  check('second quote identical (cache path)', q2.options.length === 2 && q2.weightOz === 32);

  const call = uspsPriceCalls[0];
  check('prices call body: origin/dest/weight', call.body.originZIPCode === '14617' && call.body.destinationZIPCode === '14617' && call.body.weight === 2, JSON.stringify(call.body));
  check('prices call body: dims = max with defaults', call.body.length === 12 && call.body.width === 9 && call.body.height === 6, JSON.stringify(call.body));
  check('prices call body: RETAIL + mailing date', call.body.priceType === 'RETAIL' && /^\d{4}-\d{2}-\d{2}$/.test(call.body.mailingDate), call.body.mailingDate);
  check('prices call carries bearer token', call.auth === 'Bearer tok-test-1');
  check('one prices call per class per quote', uspsPriceCalls.length === 4, `got ${uspsPriceCalls.length}`);

  const pkg = computePackage([{ product: { weightOz: 17 }, qty: 1 }]);
  check('weight rounds UP to next 0.1 lb', pkg.weightLb === 1.1, `got ${pkg.weightLb}`);
}

// ----- Quote degradation: one class fails, both fail ----------------------------

console.log('usps — partial and total failure');
{
  const env = uspsEnv(new StubDB());
  const entries = [{ product: { weightOz: 8 }, qty: 1 }];

  uspsPriceBehavior.PRIORITY_MAIL = { status: 500, body: { error: 'boom' } };
  const partial = await quoteShipping(env, entries, '14617');
  check('one class failing -> other still returned', partial.options.length === 1 && partial.options[0].service === 'ground_advantage', JSON.stringify(partial.options));

  uspsPriceBehavior.USPS_GROUND_ADVANTAGE = { status: 503, body: {} };
  const both = await quoteShipping(env, entries, '14617');
  check(
    'both classes failing -> flat fallback option',
    both.configured === true &&
      both.options.length === 1 &&
      both.options[0].service === 'standard' &&
      both.options[0].priceCents === FALLBACK_FLAT_CENTS &&
      FALLBACK_FLAT_CENTS === 899,
    JSON.stringify(both.options)
  );
  resetUspsBehavior();
}

// ----- Quote endpoint --------------------------------------------------------------

console.log('quote endpoint');
{
  const db = seedProducts(new StubDB());
  const env = uspsEnv(db);

  const res = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 2, qty: 1 }], zip: '14617' }),
    env,
    params: {},
  });
  const data = await res.json();
  check('quote -> 200 configured', res.status === 200 && data.configured === true, `got ${res.status}`);
  check('quote weight uses default 16 oz for unmeasured product', data.weightOz === 16, `got ${data.weightOz}`);
  check('quote options carry service/label/priceCents only', data.options.length === 2 && data.options[0].service === 'ground_advantage' && typeof data.options[0].priceCents === 'number');

  const resPlus4 = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 1, qty: 1 }], zip: '14617-1234' }),
    env,
    params: {},
  });
  check('ZIP+4 accepted via first 5 digits', resPlus4.status === 200, `got ${resPlus4.status}`);

  const resTbd = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 3, qty: 1 }], zip: '14617' }),
    env,
    params: {},
  });
  check('price-TBD product may be quoted', resTbd.status === 200, `got ${resTbd.status}`);

  const badZip = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 1, qty: 1 }], zip: '1461' }),
    env,
    params: {},
  });
  check('bad ZIP -> 400', badZip.status === 400, `got ${badZip.status}`);

  const unknown = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 999, qty: 1 }], zip: '14617' }),
    env,
    params: {},
  });
  check('unknown product -> 400', unknown.status === 400, `got ${unknown.status}`);

  const badQty = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 1, qty: 11 }], zip: '14617' }),
    env,
    params: {},
  });
  check('qty 11 -> 400', badQty.status === 400, `got ${badQty.status}`);

  const empty = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [], zip: '14617' }),
    env,
    params: {},
  });
  check('empty items -> 400', empty.status === 400, `got ${empty.status}`);

  const resOff = await shippingQuoteRoute({
    request: postJson(`${ORIGIN}/api/shipping/quote`, { items: [{ productId: 1, qty: 1 }], zip: '14617' }),
    env: { DB: db },
    params: {},
  });
  const offData = await resOff.json();
  check('unconfigured quote -> configured:false, no options', resOff.status === 200 && offData.configured === false && offData.options.length === 0, JSON.stringify(offData));
}

// ----- (d) Order placement with shipping -------------------------------------------

console.log('orders — shipping re-quote at placement');
let shippedOrder = null;
{
  const db = seedProducts(new StubDB());
  const env = uspsEnv(db);

  const res = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'priority_mail',
      shippingCents: 1, // client-named price — must be ignored
      shippingPrice: 0.01,
    }),
    env,
    params: {},
  });
  shippedOrder = await res.json();
  check('order with shipping -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(shippedOrder)}`);
  check('server re-quote wins over client price', shippedOrder.shippingCents === 1240, `got ${shippedOrder.shippingCents}`);
  check('service + label stored', shippedOrder.shippingService === 'priority_mail' && shippedOrder.shippingLabel === 'USPS Priority Mail');
  check('weight stored (8 oz)', shippedOrder.shippingWeightOz === 8, `got ${shippedOrder.shippingWeightOz}`);
  check('tax is on merchandise only (2.04, not on shipping)', shippedOrder.tax === 2.04, `got ${shippedOrder.tax}`);
  check('total = subtotal + tax + shipping dollars', shippedOrder.total === 34.44, `got ${shippedOrder.total}`);

  const noService = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, { items: [{ productId: 1, qty: 1 }], customer: CUSTOMER }),
    env,
    params: {},
  });
  check('configured + no service chosen -> 400', noService.status === 400, `got ${noService.status}`);

  const unknownService = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'express_overnight',
    }),
    env,
    params: {},
  });
  check('unknown service -> 400', unknownService.status === 400, `got ${unknownService.status}`);

  const standardWhileUp = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'standard',
    }),
    env,
    params: {},
  });
  check("'standard' while USPS is up -> 400 (fallback not offered)", standardWhileUp.status === 400, `got ${standardWhileUp.status}`);

  const badZip = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: { ...CUSTOMER, zip: '1461' },
      shippingService: 'priority_mail',
    }),
    env,
    params: {},
  });
  check('bad ZIP with service requested -> 400', badZip.status === 400, `got ${badZip.status}`);

  // USPS down at order time: the fallback becomes the only option.
  uspsPriceBehavior.USPS_GROUND_ADVANTAGE = { status: 500, body: {} };
  uspsPriceBehavior.PRIORITY_MAIL = { status: 500, body: {} };
  const fallbackOrder = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'standard',
    }),
    env,
    params: {},
  });
  const fallbackData = await fallbackOrder.json();
  // Compare in cents: dollar totals are REALs, so the cent value is
  // what must be exact — 20.00 + 2.04 tax + 8.99 shipping = 3103.
  check('USPS down + standard chosen -> flat 899 stored', fallbackOrder.status === 201 && fallbackData.shippingCents === 899 && Math.round(fallbackData.total * 100) === 3103, `got ${fallbackOrder.status} ${JSON.stringify(fallbackData)}`);
  const fallbackWrong = await orderCreate({
    request: postJson(`${ORIGIN}/api/orders`, {
      items: [{ productId: 1, qty: 1 }],
      customer: CUSTOMER,
      shippingService: 'priority_mail',
    }),
    env,
    params: {},
  });
  check('USPS down + USPS service chosen -> 400', fallbackWrong.status === 400, `got ${fallbackWrong.status}`);
  resetUspsBehavior();
}

// ----- (e) Stripe session carries shipping ------------------------------------------

console.log('stripe — shipping line');
{
  const env = { STRIPE_SECRET_KEY: 'sk_test_ship', STRIPE_API_BASE: STRIPE_BASE };
  const session = await createCheckoutSession(env, shippedOrder, ORIGIN);
  check('session created', session.id === 'cs_ship_test' && typeof session.url === 'string');
  const form = new URLSearchParams(lastStripeCall.init.body);
  const lines = [];
  for (let i = 0; ; i += 1) {
    const name = form.get(`line_items[${i}][price_data][product_data][name]`);
    if (name === null) break;
    lines.push({
      name,
      qty: Number(form.get(`line_items[${i}][quantity]`)),
      unitAmount: Number(form.get(`line_items[${i}][price_data][unit_amount]`)),
    });
  }
  const shipLine = lines.find((l) => l.name === 'USPS Priority Mail');
  check('shipping line present with label as name', Boolean(shipLine), JSON.stringify(lines));
  check('shipping line is exactly 1240 cents x1', shipLine && shipLine.unitAmount === 1240 && shipLine.qty === 1);
  const taxLine = lines.find((l) => l.name === 'Sales tax');
  check('tax line intact (204 cents)', taxLine && taxLine.unitAmount === 204);
  const sum = lines.reduce((s, l) => s + l.unitAmount * l.qty, 0);
  check('session lines sum to stored order total', sum === Math.round(shippedOrder.total * 100), `${sum} vs ${Math.round(shippedOrder.total * 100)}`);

  const noShipOrder = { ...shippedOrder, shippingCents: 0, shippingLabel: null, total: 22.04 };
  await createCheckoutSession(env, noShipOrder, ORIGIN);
  const form2 = new URLSearchParams(lastStripeCall.init.body);
  check('no shipping line when shippingCents is 0', form2.get('line_items[2][price_data][product_data][name]') === null);
}

// ----- Product persistence with measures ---------------------------------------------

console.log('products — persistence');
{
  const db = new StubDB();
  const env = { DB: db };
  const created = await createProduct(env, {
    name: 'Measured Mug',
    subtitle: '',
    category: 'shirts',
    type: 'Merch',
    thc: null,
    strength: 'THC TBD',
    price: 15,
    unit: 'mug',
    effects: [],
    tile: ['#374151', '#111827'],
    image: null,
    weightOz: 12.5,
    lengthIn: 5,
    widthIn: 5,
    heightIn: 4,
  });
  check('create stores measures', created.weightOz === 12.5 && created.lengthIn === 5 && created.widthIn === 5 && created.heightIn === 4, JSON.stringify(created));
  const updated = await updateProduct(env, created.id, { ...created, weightOz: 20, lengthIn: null });
  check('update changes + clears measures', updated.weightOz === 20 && updated.lengthIn === null, JSON.stringify(updated));
  const mapped = rowToProduct({ ...db.products[0], weight_oz: undefined });
  check('rowToProduct tolerates missing column values', mapped.weightOz === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
