// Donate feature tests — plain node, no dependencies.
// Run: node scripts/test-donate.mjs
//
// Exercises the real route handlers (donate/checkout, donate/stats,
// stripe/webhook) with:
//   * global fetch mocked at the Stripe API base, capturing the exact
//     form fields the checkout session builder sends;
//   * an in-memory D1 stub implementing just the statements the
//     donations code and the webhook's order lookups issue
//     (prepare/bind/first/all/run, INSERT OR IGNORE uniqueness on
//     stripe_session_id, NULL order rows — so the order branch of the
//     webhook runs its real code path and finds no order);
//   * webhook signatures computed with node:crypto HMAC-SHA256, an
//     implementation independent of the WebCrypto verifier under test.
//
// Note: _lib/donations.js caches its CREATE TABLE promise per isolate,
// so across stub DBs the CREATE may only reach the first one. The stub
// tolerates writes without it (it keeps donations in an array either
// way); in production there is exactly one DB binding, so this is a
// harness artifact only.

import { createHmac } from 'node:crypto';
import { onRequestPost as donateCheckout } from '../functions/api/donate/checkout.js';
import { onRequestGet as donateStats } from '../functions/api/donate/stats.js';
import { onRequestPost as stripeWebhook } from '../functions/api/stripe/webhook.js';

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

class StubDB {
  constructor() {
    this.donations = [];
  }
  prepare(sql) {
    return new StubStatement(this, sql);
  }
  async run(sql, params) {
    if (sql.includes('INSERT OR IGNORE INTO donations')) {
      const [sessionId, amountCents, project, donorEmail, createdAt] = params;
      if (this.donations.some((d) => d.stripe_session_id === sessionId)) {
        return { meta: { changes: 0, last_row_id: 0 } };
      }
      this.donations.push({
        stripe_session_id: sessionId,
        amount_cents: amountCents,
        project,
        donor_email: donorEmail,
        created_at: createdAt,
      });
      return { meta: { changes: 1, last_row_id: this.donations.length } };
    }
    return { meta: { changes: 0, last_row_id: 0 } };
  }
  async first(sql) {
    if (sql.includes('FROM donations')) {
      return {
        totalCents: this.donations.reduce((sum, d) => sum + d.amount_cents, 0),
        donationCount: this.donations.length,
      };
    }
    return null; // orders lookups find nothing
  }
  async all() {
    return { results: [] };
  }
}

// ----- Stripe fetch mock -------------------------------------------------------

const STRIPE_BASE = 'https://stripe.test';
let stripeBehavior = { status: 200, body: { id: 'cs_test_donate', url: 'https://checkout.stripe.com/c/pay/cs_test_donate' } };
let lastStripeCall = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith(STRIPE_BASE)) {
    lastStripeCall = { url: String(url), init };
    return new Response(JSON.stringify(stripeBehavior.body), {
      status: stripeBehavior.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, init);
};

// ----- Helpers -----------------------------------------------------------------

const ORIGIN = 'https://beastmode82420.com';

function postJson(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sign(secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function webhook(env, eventObject, { secret = env.STRIPE_WEBHOOK_SECRET, badSig = false } = {}) {
  const rawBody = JSON.stringify(eventObject);
  const signature = badSig ? `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` : sign(secret, rawBody);
  const request = new Request(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: rawBody,
  });
  return stripeWebhook({ request, env, params: {} });
}

// ----- Checkout: dormant -------------------------------------------------------

console.log('checkout — dormant');
{
  const env = { DB: new StubDB(), STRIPE_API_BASE: STRIPE_BASE };
  const res = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents: 2000, project: '824-shield' }),
    env,
    params: {},
  });
  const data = await res.json();
  check('no STRIPE_SECRET_KEY -> 501', res.status === 501, `got ${res.status}`);
  check('dormant message is the plain not-open-yet text', /not open yet/i.test(data.error || ''), data.error);
  check('dormant path never calls Stripe', lastStripeCall === null);
}

// ----- Checkout: validation ------------------------------------------------------

console.log('checkout — validation');
{
  const env = { DB: new StubDB(), STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_API_BASE: STRIPE_BASE };
  const badAmounts = [0, -5, 10.5, 'abc', '2000', 1000001, 99, null];
  for (const amountCents of badAmounts) {
    const res = await donateCheckout({
      request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents, project: '824-bank' }),
      env,
      params: {},
    });
    check(`amount ${JSON.stringify(amountCents)} -> 400`, res.status === 400, `got ${res.status}`);
  }
  const resMissing = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { project: '824-bank' }),
    env,
    params: {},
  });
  check('missing amountCents -> 400', resMissing.status === 400, `got ${resMissing.status}`);
  const resProject = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents: 2000, project: 'mars' }),
    env,
    params: {},
  });
  check('unknown project -> 400', resProject.status === 400, `got ${resProject.status}`);
  check('validation failures never call Stripe', lastStripeCall === null);
}

// ----- Checkout: success + Stripe failure -----------------------------------------

console.log('checkout — stripe session');
{
  const env = { DB: new StubDB(), STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_API_BASE: STRIPE_BASE };
  stripeBehavior = { status: 200, body: { id: 'cs_test_donate', url: 'https://checkout.stripe.com/c/pay/cs_test_donate' } };
  const res = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents: 824, project: '824-shield' }),
    env,
    params: {},
  });
  const data = await res.json();
  check('valid donation -> 200 { url }', res.status === 200 && data.url === 'https://checkout.stripe.com/c/pay/cs_test_donate', `got ${res.status} ${JSON.stringify(data)}`);
  const form = new URLSearchParams(lastStripeCall.init.body);
  check('stripe endpoint is /v1/checkout/sessions', lastStripeCall.url === `${STRIPE_BASE}/v1/checkout/sessions`, lastStripeCall.url);
  check('auth header carries the secret key', lastStripeCall.init.headers.Authorization === 'Bearer sk_test_123');
  check('mode=payment', form.get('mode') === 'payment');
  check('unit_amount is integer cents', form.get('line_items[0][price_data][unit_amount]') === '824', form.get('line_items[0][price_data][unit_amount]'));
  check('currency usd', form.get('line_items[0][price_data][currency]') === 'usd');
  check('product name names the project', form.get('line_items[0][price_data][product_data][name]') === 'Donation to 824 — 824 Shield', form.get('line_items[0][price_data][product_data][name]'));
  check('session metadata kind/project', form.get('metadata[kind]') === 'donation' && form.get('metadata[project]') === '824-shield');
  check('payment_intent metadata kind/project', form.get('payment_intent_data[metadata][kind]') === 'donation' && form.get('payment_intent_data[metadata][project]') === '824-shield');
  check('client_reference_id', form.get('client_reference_id') === 'donation-824-shield');
  check('success_url', form.get('success_url') === `${ORIGIN}/?donated=1`, form.get('success_url'));
  check('cancel_url', form.get('cancel_url') === `${ORIGIN}/?donated=0`, form.get('cancel_url'));

  const resDefault = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents: 100 }),
    env,
    params: {},
  });
  const defaultForm = new URLSearchParams(lastStripeCall.init.body);
  check('omitted project defaults to where-needed', resDefault.status === 200 && defaultForm.get('metadata[project]') === 'where-needed', defaultForm.get('metadata[project]'));
  check('min amount $1 accepted with default name', defaultForm.get('line_items[0][price_data][product_data][name]') === 'Donation to 824 — Where It Is Needed Most');

  stripeBehavior = { status: 402, body: { error: { message: 'Your card was declined.' } } };
  const resFail = await donateCheckout({
    request: postJson(`${ORIGIN}/api/donate/checkout`, { amountCents: 2000, project: '824-bank' }),
    env,
    params: {},
  });
  check('stripe failure -> 502', resFail.status === 502, `got ${resFail.status}`);
  stripeBehavior = { status: 200, body: { id: 'cs_test_donate', url: 'https://checkout.stripe.com/c/pay/cs_test_donate' } };
}

// ----- Stats: empty -----------------------------------------------------------------

console.log('stats');
{
  const env = { DB: new StubDB() };
  const res = await donateStats({ request: new Request(`${ORIGIN}/api/donate/stats`), env, params: {} });
  const data = await res.json();
  check('empty table -> zeros', res.status === 200 && data.totalCents === 0 && data.donationCount === 0, JSON.stringify(data));
  check('stats exposes only the two aggregate keys', Object.keys(data).sort().join(',') === 'donationCount,totalCents', Object.keys(data).join(','));
}

// ----- Webhook ------------------------------------------------------------------------

console.log('webhook');
{
  const db = new StubDB();
  const env = { DB: db, STRIPE_WEBHOOK_SECRET: 'whsec_test_123', STRIPE_API_BASE: STRIPE_BASE };

  const resUnconfigured = await stripeWebhook({
    request: postJson(`${ORIGIN}/api/stripe/webhook`, {}),
    env: { DB: db },
    params: {},
  });
  check('no STRIPE_WEBHOOK_SECRET -> 503', resUnconfigured.status === 503, `got ${resUnconfigured.status}`);

  const donationEvent = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_donate_1',
        amount_total: 5000,
        metadata: { kind: 'donation', project: '824-bank' },
        customer_details: { email: 'donor@example.com' },
      },
    },
  };
  const resBad = await webhook(env, donationEvent, { badSig: true });
  check('bad signature -> 400', resBad.status === 400, `got ${resBad.status}`);
  check('bad signature records nothing', db.donations.length === 0);

  const resOk = await webhook(env, donationEvent);
  check('donation completed -> 200', resOk.status === 200, `got ${resOk.status}`);
  check('donation recorded', db.donations.length === 1, `rows=${db.donations.length}`);
  check('recorded fields', db.donations[0] && db.donations[0].amount_cents === 5000 && db.donations[0].project === '824-bank' && db.donations[0].donor_email === 'donor@example.com', JSON.stringify(db.donations[0]));

  const resAgain = await webhook(env, donationEvent);
  check('redelivery -> 200 and still one row (idempotent)', resAgain.status === 200 && db.donations.length === 1, `rows=${db.donations.length}`);

  const secondDonation = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_donate_2',
        amount_total: 824,
        metadata: { kind: 'donation', project: 'queen-victoria' },
        customer_email: 'second@example.com',
      },
    },
  };
  await webhook(env, secondDonation);
  const statsRes = await donateStats({ request: new Request(`${ORIGIN}/api/donate/stats`), env, params: {} });
  const stats = await statsRes.json();
  check('stats sum both gifts', stats.totalCents === 5824 && stats.donationCount === 2, JSON.stringify(stats));

  // Order sessions must behave exactly as before: looked up, not found
  // in this stub DB, acknowledged, and never recorded as donations.
  const orderEvent = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_order_1',
        amount_total: 4200,
        metadata: { order_id: '42' },
        client_reference_id: '42',
        payment_intent: 'pi_order_1',
      },
    },
  };
  const resOrder = await webhook(env, orderEvent);
  const orderData = await resOrder.json();
  check('order completed event -> 200 received', resOrder.status === 200 && orderData.received === true, `got ${resOrder.status}`);
  check('order session is NOT recorded as a donation', db.donations.length === 2, `rows=${db.donations.length}`);

  const expiredEvent = {
    type: 'checkout.session.expired',
    data: { object: { id: 'cs_order_1', metadata: { order_id: '42' }, client_reference_id: '42' } },
  };
  const resExpired = await webhook(env, expiredEvent);
  check('order expired event -> 200, donations untouched', resExpired.status === 200 && db.donations.length === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
