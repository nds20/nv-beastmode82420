// POST /api/admin/offers/:id/decline — decline a pending offer
// (admin; Best Offer, 2026-11-10 — docs/OFFERS.md). Pending only: a
// past-due pending offer flips to 'expired' first (lazy expiry) and
// then 409s like any other non-pending state. Declining stamps
// decided_at; nothing else moves — no order exists, no stock was
// ever touched.

import { handle, json, fail, numericId } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getOffer, updateOffer } from '../../../_lib/db.js';
import { expireOfferIfPending } from '../../../_lib/offers.js';

export const onRequestPost = handle(async (context) => {
  await requireAdmin(context);
  const { env, params } = context;
  const id = numericId(params.id);
  const found = id === null ? null : await getOffer(env, id);
  if (!found) fail(404, 'Offer not found');

  const offer = await expireOfferIfPending(env, found);
  if (offer.status !== 'pending') {
    fail(409, `This offer is ${offer.status} and can't be declined.`);
  }

  const updated = await updateOffer(env, offer.id, {
    status: 'declined',
    decidedAt: new Date().toISOString(),
  });
  return json({ ...updated, accessToken: undefined });
});
