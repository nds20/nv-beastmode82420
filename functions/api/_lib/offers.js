// Best Offer — the shared offer logic (owner direction 2026-11-10,
// docs/OFFERS.md). Poshmark-style: a buyer offers below list on an
// eligible product, the seller accepts or declines, and an accepted
// offer becomes a REAL order through the normal order path when the
// buyer pays.
//
// The rules that matter:
//   * Eligibility is computed on the product (db.js
//     productAcceptsOffers): condition 'new' NEVER takes offers —
//     new items sell at list price only — an explicit admin flag
//     wins otherwise, and every pre-feature product (flag NULL)
//     defaults ON while it has a price.
//   * An offer is a promise, not a payment: creating one moves no
//     stock and no money. Accepting moves nothing either. Stock and
//     money move only when the buyer pays, at the order's own
//     existing commit points (_lib/inventory.js).
//   * Money: the offered amount is stored as INTEGER CENTS
//     (offers.offer_cents — the shipping_cents precedent). Tax is
//     the shop's one TAX_RATE on the offered subtotal only, and
//     shipping is re-quoted server-side at pay time from the buyer's
//     ZIP — an amount a client sends is never trusted (the pay route
//     takes the price from the stored offer row, not the body).
//   * The shop has no email system: the buyer watches their offer
//     through its status link (the per-offer access token), and the
//     seller works the admin Offers inbox. Nothing is emailed.

import { fail, round2 } from './http.js';
import { TAX_RATE } from './validate.js';
import { updateOffer } from './db.js';

// How long the seller has to respond before a pending offer expires.
export const OFFER_TTL_MS = 72 * 60 * 60 * 1000;
export const OFFER_TTL_HOURS = 72;

export const MAX_OFFER_NOTE_LENGTH = 500;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a POST /api/offers body against its (already loaded)
 * product. Returns { size, offerCents, buyerName, buyerEmail,
 * buyerPhone, note } or throws a 400 via fail(). Check order follows
 * the brief: eligibility, availability, price sanity, size, amount,
 * then the buyer's own fields.
 */
export function validateNewOffer(body, product) {
  const data = body && typeof body === 'object' ? body : {};

  if (!product.acceptsOffers) fail(400, "This item doesn't accept offers.");
  if (!product.available) fail(400, `"${product.name}" is sold out.`);
  if (product.price === null || product.price === undefined) {
    fail(400, `"${product.name}" cannot be offered on yet — its price is TBD.`);
  }

  // Size: the offer is for ONE item in ONE size. A sized product
  // requires a size from its run (same rule as orders — the client
  // cannot invent one); a one-size product must not carry one.
  const productSizes = Array.isArray(product.sizes) ? product.sizes : [];
  const wanted = data.size != null ? String(data.size).trim() : '';
  let size = null;
  if (productSizes.length > 0) {
    if (!wanted) fail(400, `Please choose a size for "${product.name}".`);
    if (!productSizes.includes(wanted)) {
      fail(400, `"${product.name}" is not offered in size "${wanted}".`);
    }
    size = wanted;
  } else if (wanted) {
    fail(400, `"${product.name}" doesn't come in sizes.`);
  }

  // The amount: a real number of dollars, > 0, at most 2 decimals,
  // and strictly below list — an offer AT list price is just a
  // purchase, and the message says so.
  const amount = Number(data.offerAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    fail(400, 'Offer amount must be a number greater than 0.');
  }
  const offerCents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - offerCents) > 1e-6) {
    fail(400, 'Offer amount can have at most 2 decimal places.');
  }
  if (offerCents <= 0) fail(400, 'Offer amount must be greater than 0.');
  if (amount >= product.price) {
    fail(400, "That's the list price — just add it to your cart.");
  }

  const buyerName = String(data.name || '').trim();
  if (buyerName.length < 2) fail(400, 'Please enter your name.');
  const buyerEmail = String(data.email || '').trim();
  if (!EMAIL_SHAPE.test(buyerEmail)) {
    fail(400, 'Please enter a valid email address.');
  }
  const buyerPhone =
    data.phone != null && String(data.phone).trim() !== ''
      ? String(data.phone).trim()
      : null;
  let note = null;
  if (data.note != null && String(data.note).trim() !== '') {
    note = String(data.note).trim();
    if (note.length > MAX_OFFER_NOTE_LENGTH) {
      fail(400, `Note must be ${MAX_OFFER_NOTE_LENGTH} characters or fewer.`);
    }
  }

  return { size, offerCents, buyerName, buyerEmail, buyerPhone, note };
}

/** The buyer-facing sentence for an offer's status (status endpoint). */
export function offerStatusMessage(offer) {
  switch (offer && offer.status) {
    case 'pending':
      return 'Waiting for the seller to respond to your offer.';
    case 'accepted':
      return 'Accepted! Pay to complete your purchase.';
    case 'declined':
      return 'The seller declined this offer.';
    case 'expired':
      return 'This offer has expired.';
    case 'paid':
      return 'Paid — thank you! Your purchase is complete.';
    default:
      return '';
  }
}

/**
 * The fields a buyer may see about their own offer (create response
 * and status reads): everything needed to watch and pay it, nothing
 * else. accessToken is included only in the CREATE response (it is
 * the buyer's key — the status route already required it).
 */
export function buyerOfferView(offer, { withToken = false } = {}) {
  if (!offer) return null;
  const view = {
    id: offer.id,
    productId: offer.productId,
    size: offer.size,
    offerAmount: offer.offerAmount,
    offerCents: offer.offerCents,
    status: offer.status,
    orderId: offer.orderId,
    createdAt: offer.createdAt,
    decidedAt: offer.decidedAt,
    expiresAt: offer.expiresAt,
  };
  if (withToken) view.accessToken = offer.accessToken;
  return view;
}

/**
 * Lazy expiry: a pending offer whose 72-hour window has closed flips
 * to 'expired' the first time anything reads it after the deadline.
 * Returns the (possibly updated) offer.
 */
export async function expireOfferIfPending(env, offer) {
  if (
    offer &&
    offer.status === 'pending' &&
    offer.expiresAt &&
    Date.now() > Date.parse(offer.expiresAt)
  ) {
    const updated = await updateOffer(env, offer.id, { status: 'expired' });
    return updated || { ...offer, status: 'expired' };
  }
  return offer;
}

/**
 * What accepting this offer would charge, for the admin list: the
 * offered subtotal, tax at the shop's one TAX_RATE on that subtotal
 * only (the exact code path orders use — round2 + TAX_RATE), and a
 * shipping PREVIEW. There is no destination ZIP before acceptance,
 * so a shippable product previews as "USPS rate at payment" with a
 * null shipping/total; the real quote happens server-side at pay
 * time. Free-shipping products preview exactly: $0 shipping.
 */
export function wouldBeTotals(product, offer) {
  const subtotal = round2((Number(offer.offerCents) || 0) / 100);
  const tax = round2(subtotal * TAX_RATE);
  const freeShipping = Boolean(product && product.freeShipping);
  const shippingCents = freeShipping ? 0 : null;
  return {
    subtotal,
    tax,
    shippingCents,
    shippingLabel: freeShipping ? 'Free shipping' : 'USPS rate at payment',
    total: shippingCents === null ? null : round2(subtotal + tax + shippingCents / 100),
  };
}
