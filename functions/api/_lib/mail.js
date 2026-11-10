// Email notifications — Gmail API over plain fetch (owner direction
// 2026-11-10, docs/EMAIL.md). The shop's mail sends AS the owner's
// Google Workspace mailbox (beastmode82420@beastmode82420.com) via an
// OAuth2 refresh token: no SDK, no SMTP, mirroring _lib/usps.js and
// _lib/stripe.js — configuration comes only from environment
// variables, and the feature is DORMANT until they are set.
//
// Configuration (Worker secrets / variables — never code):
//   GOOGLE_OAUTH_CLIENT_ID      OAuth client id (Google Cloud).
//   GOOGLE_OAUTH_CLIENT_SECRET  OAuth client secret.
//   GOOGLE_OAUTH_REFRESH_TOKEN  Refresh token minted for the
//                               Workspace mailbox with the
//                               gmail.send scope (docs/EMAIL.md).
//   SHOP_FROM_EMAIL   Optional. From / sender address
//                     (default beastmode82420@beastmode82420.com).
//   SHOP_ADMIN_EMAIL  Optional. Where admin alerts go
//                     (default the same address).
//   SHOP_FROM_NAME    Optional. Sender display name
//                     (default "Shop 824").
//   GMAIL_API_BASE / GOOGLE_TOKEN_URL  Optional overrides (tests).
//
// API shape:
//   POST https://oauth2.googleapis.com/token
//        { grant_type: 'refresh_token', client_id, client_secret,
//          refresh_token } -> { access_token, expires_in }
//   POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
//        Authorization: Bearer <token>, body { raw: <base64url MIME> }
//
// FAILURE ISOLATION is the contract: every export here is
// best-effort. sendMail NEVER throws — config, token, network and
// Gmail API failures all come back as { ok: false, ... } — and the
// notify* helpers swallow everything, so an email problem can never
// change an order, offer or webhook response. Bodies are plain text
// only (no HTML in v1) and never contain card data beyond the last4
// the order itself already stores.

import { round2 } from './http.js';

export const GMAIL_API_BASE_DEFAULT = 'https://gmail.googleapis.com';
export const GOOGLE_TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
export const DEFAULT_SHOP_EMAIL = 'beastmode82420@beastmode82420.com';
export const DEFAULT_FROM_NAME = 'Shop 824';
export const ADMIN_PANEL_URL = 'https://beastmode82420.com/shop/admin';

// The OAuth variables that must all be present before anything can
// send. The SHOP_* values have defaults and are never "missing".
export const MAIL_REQUIRED_ENV = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
];

// The same email shape the rest of the codebase validates with
// (customers/register.js, _lib/offers.js).
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True only when every Google OAuth credential mail needs is set. */
export function mailConfigured(env) {
  return Boolean(
    env &&
      env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

export function shopFromEmail(env) {
  return String((env && env.SHOP_FROM_EMAIL) || DEFAULT_SHOP_EMAIL).trim();
}

export function shopAdminEmail(env) {
  return String((env && env.SHOP_ADMIN_EMAIL) || DEFAULT_SHOP_EMAIL).trim();
}

export function shopFromName(env) {
  return String((env && env.SHOP_FROM_NAME) || DEFAULT_FROM_NAME).trim();
}

/**
 * The /api/admin/mail-debug view of the configuration: which of the
 * required variables are still unset, and the resolved sender/admin
 * addresses. NEVER includes any secret VALUE — names only.
 */
export function mailConfigStatus(env) {
  const missing = MAIL_REQUIRED_ENV.filter((name) => !(env && env[name]));
  return {
    configured: missing.length === 0,
    missing,
    from: shopFromEmail(env),
    fromName: shopFromName(env),
    adminEmail: shopAdminEmail(env),
  };
}

function gmailBase(env) {
  return (env && env.GMAIL_API_BASE) || GMAIL_API_BASE_DEFAULT;
}

function googleTokenUrl(env) {
  return (env && env.GOOGLE_TOKEN_URL) || GOOGLE_TOKEN_URL_DEFAULT;
}

// ----- OAuth access tokens ------------------------------------------------------
//
// Cached per isolate, keyed by client id (the usps.js pattern): one
// token call serves every send until ~60s before the token's stated
// expiry, and a key change never reuses a token minted under other
// credentials. Failures are NOT cached — the next send retries.

let tokenCache = null;

async function fetchGmailAccessToken(env) {
  let response;
  try {
    response = await fetch(googleTokenUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      }).toString(),
    });
  } catch {
    return { token: null, status: null, errorCode: 'network' };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return {
      token: null,
      status: response.status,
      errorCode:
        (typeof data.error === 'string' && data.error) || 'token_failed',
    };
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache = {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    token: data.access_token,
    // Refresh a minute early so a send never starts on a dying token.
    expiresAt: Date.now() + Math.max(0, expiresIn - 60) * 1000,
  };
  return { token: tokenCache.token };
}

async function obtainGmailToken(env) {
  if (
    tokenCache &&
    tokenCache.clientId === env.GOOGLE_OAUTH_CLIENT_ID &&
    Date.now() < tokenCache.expiresAt
  ) {
    return { token: tokenCache.token };
  }
  return fetchGmailAccessToken(env);
}

/**
 * Diagnostic (docs/PAYMENTS_DEBUG.md): run the SAME refresh-token
 * exchange a send would perform — through the shared
 * fetchGmailAccessToken, cache and all — WITHOUT sending anything,
 * and report only { ok, status, errorCode }. Lets the owner prove
 * the GOOGLE_OAUTH_* wiring (a bad refresh token answers
 * invalid_grant here) without a test email. When mail is not
 * configured no network call happens at all.
 */
export async function diagnoseMailToken(env) {
  if (!mailConfigured(env)) {
    return { ok: false, status: null, errorCode: 'not_configured' };
  }
  const result = await obtainGmailToken(env);
  if (result.token) return { ok: true, status: 200, errorCode: null };
  return {
    ok: false,
    status: result.status !== undefined ? result.status : null,
    errorCode: result.errorCode || 'token_failed',
  };
}
/** The current Gmail access token, or null when unconfigured/failed. */
export async function getGmailAccessToken(env) {
  if (!mailConfigured(env)) return null;
  const result = await obtainGmailToken(env);
  return result.token;
}

// ----- MIME building --------------------------------------------------------------

/** Header values can never carry a line break — strip, never trust. */
const stripHeader = (value) =>
  String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .trim();

/** UTF-8-safe base64 (Workers has btoa but not Buffer). */
function base64Encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64url of a string — the Gmail API `raw` field's encoding. */
export function base64UrlEncode(text) {
  return base64Encode(text)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * RFC 2047: ASCII subjects ride as-is; anything else (the admin
 * subjects carry an em dash) becomes UTF-8 B-encoded word(s).
 */
function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  const b64 = base64Encode(subject);
  const words = [];
  for (let i = 0; i < b64.length; i += 60) {
    words.push(`=?UTF-8?B?${b64.slice(i, i + 60)}?=`);
  }
  return words.join(' ');
}

/**
 * Build an RFC 5322 plain-text message (CRLF line endings, base64
 * body) from { from, fromName, to, subject, text }. All header
 * inputs are stripped of CR/LF first, so a crafted product name or
 * buyer name can never inject a header.
 */
export function buildMimeMessage({ from, fromName, to, subject, text }) {
  const cleanFrom = stripHeader(from);
  const cleanTo = stripHeader(to);
  const cleanName = stripHeader(fromName).replace(/"/g, '');
  const cleanSubject = stripHeader(subject);
  const headers = [
    cleanName ? `From: "${cleanName}" <${cleanFrom}>` : `From: ${cleanFrom}`,
    `To: ${cleanTo}`,
    `Subject: ${encodeSubject(cleanSubject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = base64Encode(text === null || text === undefined ? '' : text)
    .replace(/(.{76})/g, '$1\r\n')
    .replace(/\r\n$/, '');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

// ----- Sending ----------------------------------------------------------------------

function gmailErrorCode(data) {
  if (!data || typeof data !== 'object') return null;
  const err = data.error;
  if (err && typeof err === 'object') {
    return err.status || (err.code ? String(err.code) : null);
  }
  return typeof err === 'string' ? err : null;
}

/**
 * Send one plain-text email through the Gmail API. Returns
 * { ok: true, id } on success or { ok: false, status, errorCode }
 * on any failure — config, recipient shape, token, network or API.
 * NEVER throws.
 */
export async function sendMail(env, message) {
  try {
    if (!mailConfigured(env)) {
      return { ok: false, status: null, errorCode: 'not_configured' };
    }
    const to = stripHeader(message && message.to);
    if (!EMAIL_SHAPE.test(to)) {
      return { ok: false, status: null, errorCode: 'bad_recipient' };
    }
    const tok = await obtainGmailToken(env);
    if (!tok.token) {
      return {
        ok: false,
        status: tok.status !== undefined ? tok.status : null,
        errorCode: tok.errorCode || 'token_failed',
      };
    }
    const raw = base64UrlEncode(
      buildMimeMessage({
        from: shopFromEmail(env),
        fromName: shopFromName(env),
        to,
        subject: message.subject,
        text: message.text,
      })
    );
    let response;
    try {
      response = await fetch(`${gmailBase(env)}/gmail/v1/users/me/messages/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });
    } catch {
      return { ok: false, status: null, errorCode: 'network' };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorCode: gmailErrorCode(data) || 'send_failed',
      };
    }
    return { ok: true, id: data.id || null };
  } catch {
    return { ok: false, status: null, errorCode: 'unexpected' };
  }
}

// ----- Body builders ------------------------------------------------------------------

const money = (n) => `$${round2(Number(n) || 0).toFixed(2)}`;

function itemLines(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  if (items.length === 0) return ['(no items)'];
  return items.map((item) => {
    const size = item.size ? ` — Size: ${item.size}` : '';
    const qty = Number(item.qty) || 1;
    const line =
      item.lineTotal !== null && item.lineTotal !== undefined
        ? Number(item.lineTotal)
        : (Number(item.unitPrice) || 0) * qty;
    return `- ${item.name || 'Item'}${size} x${qty} — ${money(line)}`;
  });
}

function totalsLines(order) {
  return [
    `Subtotal: ${money(order.subtotal)}`,
    `Tax: ${money(order.tax)}`,
    `Shipping: ${money((Number(order.shippingCents) || 0) / 100)}` +
      (order.shippingLabel ? ` (${order.shippingLabel})` : ''),
    `Total: ${money(order.total)}`,
  ];
}

/**
 * How the order's payment reads in an email. 'paid' is the webhook's
 * word; a stored demo card means placement WAS the payment commit
 * (the orders.js demo path); anything else is a Stripe checkout the
 * buyer still has to finish.
 */
function paymentWording(order) {
  if (order.paymentStatus === 'paid') return 'Paid';
  if (order.payment) {
    return order.payment.last4
      ? `Paid (card ••••${order.payment.last4})`
      : 'Paid (card)';
  }
  return 'Payment pending — completing at Stripe checkout';
}

function customerContactLines(order) {
  const c = (order && order.customer) || {};
  return [
    `Customer: ${c.fullName || '—'}`,
    `Phone: ${c.phone || '—'}`,
    `Email: ${c.email || 'no email on file'}`,
    `Ship to: ${[c.address, c.city, c.zip].filter(Boolean).join(', ') || '—'}`,
  ];
}

// ----- Notify helpers (best-effort; each returns its send results) ---------------------

/**
 * (a) An order was PLACED: the customer's confirmation (only when
 * the order carries a usable email — orders without one simply skip
 * it) AND the admin's new-order alert. Fired from POST /api/orders
 * and from the offer pay endpoint, exactly once per created order.
 */
export async function sendOrderPlacedEmails(env, order) {
  const results = { customer: null, admin: null };
  try {
    if (!order) return results;
    const email =
      order.customer && order.customer.email
        ? String(order.customer.email).trim()
        : '';
    if (email && EMAIL_SHAPE.test(email)) {
      const text = [
        `Hi ${String(order.customer.fullName || '').trim() || 'there'},`,
        '',
        `Thanks for shopping at Shop 824! Your order #${order.id} is placed.`,
        '',
        ...itemLines(order),
        '',
        ...totalsLines(order),
        '',
        `Payment: ${paymentWording(order)}`,
        '',
        'Questions? Reply to this email.',
        '',
        '— Shop 824',
      ].join('\n');
      results.customer = await sendMail(env, {
        to: email,
        subject: `Your Shop 824 order #${order.id} is placed`,
        text,
      });
    }
    const adminText = [
      'A new order was placed at Shop 824.',
      '',
      `Order #${order.id}`,
      ...customerContactLines(order),
      '',
      ...itemLines(order),
      '',
      ...totalsLines(order),
      '',
      `Payment status: ${paymentWording(order)}`,
      '',
      `Manage it in the admin: ${ADMIN_PANEL_URL}`,
    ].join('\n');
    results.admin = await sendMail(env, {
      to: shopAdminEmail(env),
      subject: `[Shop 824] New order #${order.id} — ${money(order.total)}`,
      text: adminText,
    });
  } catch {
    // Best-effort by contract — a mail problem never reaches the
    // order response. Partial results (if any) still return.
  }
  return results;
}

/**
 * (b) An OFFER was placed: admin only — the seller decides in the
 * admin Offers inbox. Fired from POST /api/offers.
 */
export async function sendOfferPlacedEmail(env, offer, product) {
  let result = null;
  try {
    if (!offer) return result;
    const offerAmount =
      offer.offerAmount !== null && offer.offerAmount !== undefined
        ? Number(offer.offerAmount)
        : (Number(offer.offerCents) || 0) / 100;
    const lines = [
      'A buyer made an offer at Shop 824.',
      '',
      `Product: ${product ? product.name : `Product #${offer.productId}`}`,
      `List price: ${product && product.price !== null && product.price !== undefined ? money(product.price) : 'TBD'}`,
      `Offer: ${money(offerAmount)}`,
      `Size: ${offer.size || '—'}`,
      '',
      `Buyer: ${offer.buyerName || '—'}`,
      `Email: ${offer.buyerEmail || '—'}`,
      `Phone: ${offer.buyerPhone || '—'}`,
      `Note: ${offer.note || '—'}`,
      `Expires: ${offer.expiresAt || '—'}`,
      '',
      `Review it in the admin: ${ADMIN_PANEL_URL}`,
    ];
    result = await sendMail(env, {
      to: shopAdminEmail(env),
      subject: `[Shop 824] New offer — ${money(offerAmount)} on ${product ? product.name : `product #${offer.productId}`}`,
      text: lines.join('\n'),
    });
  } catch {
    // Best-effort by contract.
  }
  return result;
}

/**
 * (c) An order was PAID: admin only. Fired at the real payment
 * commit points only — the Stripe webhook's paid transition and
 * demo-card placements (where placement applies payment) — exactly
 * where _lib/inventory.js's commit fires.
 */
export async function sendOrderPaidEmail(env, order) {
  let result = null;
  try {
    if (!order) return result;
    const paidWording =
      order.payment && order.payment.last4
        ? `Paid (card ••••${order.payment.last4})`
        : 'Paid';
    const lines = [
      `Order #${order.id} has been PAID.`,
      '',
      ...customerContactLines(order),
      '',
      ...itemLines(order),
      '',
      ...totalsLines(order),
      '',
      `Payment: ${paidWording}`,
      '',
      `Manage it in the admin: ${ADMIN_PANEL_URL}`,
    ];
    result = await sendMail(env, {
      to: shopAdminEmail(env),
      subject: `[Shop 824] PAID order #${order.id} — ${money(order.total)}`,
      text: lines.join('\n'),
    });
  } catch {
    // Best-effort by contract.
  }
  return result;
}
