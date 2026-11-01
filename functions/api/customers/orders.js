// GET /api/customers/orders — the signed-in customer's own orders,
// newest first. Added for the beastmode82420 rebuild (the original
// shop's API had no customer order list): an order belongs to a
// customer when it was placed with their token, which stamps
// `accountId` into the order's customer JSON (see ../orders.js and
// _lib/db.js listOrdersForCustomer). Guest orders never appear here.

import { handle, json } from '../_lib/http.js';
import { verifyCustomerToken } from '../_lib/auth.js';
import { getCustomerById, getCustomerTokenSecret, listOrdersForCustomer } from '../_lib/db.js';

export const onRequestGet = handle(async ({ request, env }) => {
  const header = request.headers.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  const payload =
    scheme === 'Bearer'
      ? await verifyCustomerToken(token, await getCustomerTokenSecret(env))
      : null;
  if (!payload) return json({ error: 'Customer authentication required' }, 401);
  const customer = await getCustomerById(env, payload.sub);
  if (!customer) return json({ error: 'Customer authentication required' }, 401);
  return json({ orders: await listOrdersForCustomer(env, customer.id) });
});
