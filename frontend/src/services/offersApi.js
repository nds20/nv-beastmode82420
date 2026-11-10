// Public Best Offer client (2026-11-10 — docs/OFFERS.md).
//
// The buyer's side of make-an-offer:
//   submitOffer        POST /api/offers — creates a pending offer
//                      and returns it WITH its accessToken. The
//                      caller MUST persist that token (the status
//                      page reads it back from localStorage key
//                      `shop824_offer_<id>`, or from ?token= in the
//                      URL) — it is the buyer's only key; the shop
//                      has no email system to recover it with.
//   fetchOfferStatus   GET /api/offers/:id/status?token= — the
//                      offer's state + the seller-facing message.
//   payOffer           POST /api/offers/:id/pay — an accepted
//                      offer's buyer completes the purchase; the
//                      response is a normal order (with its own
//                      accessToken), after which the standard
//                      /api/orders/:id/checkout Stripe step applies
//                      (services/ordersApi.js createCheckoutSession).

async function offerFetch(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function postJson(path, body) {
  return offerFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Create an offer: { productId, size?, offerAmount, name, email, phone?, note? }. */
export async function submitOffer(offer) {
  return postJson('/api/offers', offer);
}

/** Read one offer's status with its access token. */
export async function fetchOfferStatus(id, token) {
  return offerFetch(`/api/offers/${id}/status?token=${encodeURIComponent(token || '')}`);
}

/**
 * Complete an accepted offer's purchase. `body` carries
 * { accessToken, customer, shippingService?, payment? } exactly as
 * the pay endpoint expects; resolves to the created order.
 */
export async function payOffer(id, body) {
  return postJson(`/api/offers/${id}/pay`, body);
}

/** localStorage key holding one offer's access token on this device. */
export const offerTokenKey = (id) => `shop824_offer_${id}`;

export function saveOfferToken(id, token) {
  try {
    if (id && token) localStorage.setItem(offerTokenKey(id), token);
  } catch {
    // Storage unavailable — the buyer can still use the ?token= link.
  }
}

export function readOfferToken(id) {
  try {
    return localStorage.getItem(offerTokenKey(id)) || '';
  } catch {
    return '';
  }
}
