// GET /api/admin/offers — the seller's Best Offer inbox (admin;
// 2026-11-10 — docs/OFFERS.md). Newest first, pending first (the
// db.js list order). Each row joins its product's name and CURRENT
// list price plus a would-be totals preview (wouldBeTotals in
// _lib/offers.js): tax at the shop rate on the offered subtotal
// only; shipping previews as an exact $0 for free-shipping products
// and as "USPS rate at payment" otherwise — no destination ZIP
// exists before acceptance, so USPS is never called here.
// Past-due pending offers are lazily flipped to 'expired' before
// listing so the inbox never shows a dead offer as actionable.
// Counts by status ride along for the dashboard badges.

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { listOffers, getProduct } from '../_lib/db.js';
import { expireOfferIfPending, wouldBeTotals } from '../_lib/offers.js';

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  const env = context.env;

  const offers = [];
  for (const raw of await listOffers(env)) {
    // eslint-disable-next-line no-await-in-loop
    const offer = await expireOfferIfPending(env, raw);
    // eslint-disable-next-line no-await-in-loop
    const product = await getProduct(env, offer.productId);
    offers.push({
      ...offer,
      // The buyer's key never belongs in an admin payload.
      accessToken: undefined,
      productName: product ? product.name : null,
      listPrice: product ? product.price : null,
      productAvailable: product ? product.available : false,
      wouldBe: wouldBeTotals(product, offer),
    });
  }

  const counts = { pending: 0, accepted: 0, declined: 0, expired: 0, paid: 0 };
  for (const offer of offers) {
    if (counts[offer.status] !== undefined) counts[offer.status] += 1;
  }
  return json({ offers, counts });
});
