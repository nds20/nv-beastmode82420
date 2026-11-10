// GET /api/offers/:id/status?token=<accessToken> — the buyer's
// window into their own offer (Best Offer, 2026-11-10). Mirrors the
// order status endpoint: an offer id alone (small, guessable
// integers) reveals nothing; the per-offer access token issued at
// creation is required, compared timing-safe.
//
// Reading a PENDING offer past its 72-hour expiry flips it to
// 'expired' here (lazy expiry — there is no cron) and reports it as
// such. productId and size ride along beyond the brief's core fields
// because the status page needs them to run the shipping quote and
// the pay form for the accepted state.

import { handle, json, fail, numericId } from '../../_lib/http.js';
import { getOffer, getProduct } from '../../_lib/db.js';
import { timingSafeStringEqual } from '../../_lib/auth.js';
import { expireOfferIfPending, offerStatusMessage } from '../../_lib/offers.js';

export const onRequestGet = handle(async ({ request, env, params }) => {
  const id = numericId(params.id);
  const found = id === null ? null : await getOffer(env, id);
  if (!found) fail(404, 'Offer not found');

  const token = new URL(request.url).searchParams.get('token') || '';
  if (!found.accessToken || !timingSafeStringEqual(token, found.accessToken)) {
    fail(403, 'A valid offer access token is required to read this offer.');
  }

  const offer = await expireOfferIfPending(env, found);
  const product = await getProduct(env, offer.productId);
  return json({
    id: offer.id,
    status: offer.status,
    productId: offer.productId,
    productName: product ? product.name : null,
    size: offer.size,
    offerAmount: offer.offerAmount,
    orderId: offer.orderId,
    message: offerStatusMessage(offer),
  });
});
