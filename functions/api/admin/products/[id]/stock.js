// PATCH /api/admin/products/:id/stock — the owner's restock tool
// (admin only, 2026-11-09). The admin dashboard's Products list is
// read-only by design, so stock is managed here, at the API level,
// the same way products themselves are added and edited.
//
// Body (JSON) — exactly ONE of:
//   { stockQty: <int 0..100000> }   set the tracked count absolutely
//   { adjustBy: <nonzero int> }     add/subtract from the current
//                                   count (an untracked product is
//                                   treated as starting from 0, so an
//                                   adjust also STARTS tracking it)
// Both or neither is a 400. The result is floored at 0 — an adjustment
// can empty the shelf but never drive it negative. Returns the
// updated product (rowToProduct shape, incl. the computed
// `available`).

import { handle, json, fail } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getProduct, setProductStock } from '../../../_lib/db.js';
import { MAX_STOCK_QTY } from '../../../_lib/validate.js';

export const onRequestPatch = handle(async (context) => {
  await requireAdmin(context);
  const product = await getProduct(context.env, context.params.id);
  if (!product) fail(404, 'Product not found');

  const body = await context.request.json().catch(() => ({}));
  const hasSet = body && body.stockQty !== undefined && body.stockQty !== null;
  const hasAdjust = body && body.adjustBy !== undefined && body.adjustBy !== null;
  if (hasSet === hasAdjust) {
    fail(400, 'Send exactly one of stockQty (set an absolute count) or adjustBy (adjust the count).');
  }

  let next;
  if (hasSet) {
    const qty = Number(body.stockQty);
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_STOCK_QTY) {
      fail(400, `stockQty must be a whole number between 0 and ${MAX_STOCK_QTY}`);
    }
    next = qty;
  } else {
    const delta = Number(body.adjustBy);
    if (!Number.isInteger(delta) || delta === 0 || delta < -MAX_STOCK_QTY || delta > MAX_STOCK_QTY) {
      fail(400, `adjustBy must be a nonzero whole number between -${MAX_STOCK_QTY} and ${MAX_STOCK_QTY}`);
    }
    next = Math.max(0, (product.stockQty != null ? product.stockQty : 0) + delta);
  }

  const updated = await setProductStock(context.env, product.id, next);
  return json(updated);
});
