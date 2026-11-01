// POST /api/orders — place an order (public; this is the storefront
// checkout). Validation (including the Price-TBD block) and totals happen
// here, never on the client's say-so — same as the Node server.
//
// Extension for the beastmode82420 rebuild: when the request carries a
// valid CUSTOMER bearer token, the order's stored customer JSON gains
// an `accountId`, which is what GET /api/customers/orders reads back.
// Guest checkout is unchanged in every other way.

import { handle, json } from './_lib/http.js';
import { getProduct, createOrder, getCustomerTokenSecret } from './_lib/db.js';
import { normalizeOrder } from './_lib/validate.js';
import { verifyCustomerToken } from './_lib/auth.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await request.json().catch(() => ({}));
  const data = await normalizeOrder(body || {}, (id) => getProduct(env, id));

  const header = request.headers.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    const payload = await verifyCustomerToken(token, await getCustomerTokenSecret(env));
    if (payload) data.customer = { ...data.customer, accountId: Number(payload.sub) };
  }

  const order = await createOrder(env, data);
  return json(order, 201);
});
