// GET /api/admin/customers — the admin customer list that powers the
// dashboard's Customers section: every registered shopper, newest
// first, public fields only (credential material is never selected
// in the data layer — see listCustomers in ../_lib/db.js).

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';
import { listCustomers } from '../_lib/db.js';

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  return json({ customers: await listCustomers(context.env) });
});
