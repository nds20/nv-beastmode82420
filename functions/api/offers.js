// POST /api/offers — make an offer on a product (public; Best Offer,
// 2026-11-10 — see docs/OFFERS.md and _lib/offers.js).
//
// The buyer names a price below list on an offer-eligible product
// (condition 'new' never takes offers; see db.js
// productAcceptsOffers). Creating an offer moves NO stock and NO
// money — it is a promise the seller can accept or decline within
// 72 hours. The response is the buyer's view of the offer plus its
// accessToken: that token is the buyer's key to the offer, used by
// GET /api/offers/:id/status and POST /api/offers/:id/pay. (The
// admin also gets an email alert when mail is configured —
// docs/EMAIL.md — but the buyer still watches the offer here.)

import { handle, json, fail } from './_lib/http.js';
import { getProduct, createOffer } from './_lib/db.js';
import { validateNewOffer, buyerOfferView, OFFER_TTL_MS } from './_lib/offers.js';
import { sendOfferPlacedEmail } from './_lib/mail.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await request.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? body : {};

  const productId = data.productId !== undefined ? data.productId : data.id;
  const product = await getProduct(env, productId);
  if (!product) fail(400, `Unknown product in offer (id: ${productId}).`);

  const offer = validateNewOffer(data, product);
  const created = await createOffer(env, {
    productId: product.id,
    size: offer.size,
    offerCents: offer.offerCents,
    buyerName: offer.buyerName,
    buyerEmail: offer.buyerEmail,
    buyerPhone: offer.buyerPhone,
    note: offer.note,
    expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
  });
  // Email (2026-11-10, docs/EMAIL.md): the admin's new-offer alert,
  // fired now the offer is saved. Best-effort and dormant until the
  // GOOGLE_OAUTH_* secrets are set — it cannot change this response.
  await sendOfferPlacedEmail(env, created, product);
  return json(buyerOfferView(created, { withToken: true }), 201);
});
