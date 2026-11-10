// POST /api/admin/offers/:id/accept — accept a pending offer
// (admin; Best Offer, 2026-11-10 — docs/OFFERS.md).
//
// Accepting is a DECISION, not a sale: it creates no order, moves no
// stock and charges nothing. The buyer completes the purchase via
// POST /api/offers/:id/pay, which mints the real order at the
// offered price. That split is what lets two offers on the same
// single item both be accepted — the stock gate lives at pay time,
// first payer wins (see docs/OFFERS.md).
//
// Guards: only 'pending' and inside its 72-hour window (past-due
// flips to 'expired' and 409s); the product must still exist; a
// TRACKED product that has sold out since the offer was made 409s
// with the brief's exact message instead of accepting a promise the
// shop cannot keep.

import { handle, json, fail, numericId } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getOffer, updateOffer, getProduct } from '../../../_lib/db.js';
import { expireOfferIfPending } from '../../../_lib/offers.js';

export const onRequestPost = handle(async (context) => {
  await requireAdmin(context);
  const { env, params } = context;
  const id = numericId(params.id);
  const found = id === null ? null : await getOffer(env, id);
  if (!found) fail(404, 'Offer not found');

  const offer = await expireOfferIfPending(env, found);
  if (offer.status === 'expired' && found.status === 'pending') {
    fail(409, 'This offer has expired.');
  }
  if (offer.status !== 'pending') {
    fail(409, `This offer is ${offer.status} and can't be accepted.`);
  }

  const product = await getProduct(env, offer.productId);
  if (!product) fail(409, 'The product for this offer no longer exists.');
  if (product.stockQty !== null && product.stockQty !== undefined && product.stockQty < 1) {
    fail(409, 'Sold out since the offer was made.');
  }

  const updated = await updateOffer(env, offer.id, {
    status: 'accepted',
    decidedAt: new Date().toISOString(),
  });
  return json({ ...updated, accessToken: undefined });
});
