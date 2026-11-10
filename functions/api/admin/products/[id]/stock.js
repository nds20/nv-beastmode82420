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
//
// Per-size products (2026-11-10): a product in per-size mode (its
// size_inventory map is set) has no single count to set — the count
// lives per size. For those, the body must ALSO name the size:
//   { size: "Medium", stockQty: 4 }   set Medium's count
//   { size: "Medium", adjustBy: -1 }  adjust Medium's count
// and the product's stock_qty sum follows the map (db.js
// setProductSizeStock). Omitting `size` for a per-size product is a
// 400 that says to pick a size — a bare total would be ambiguous
// about which sizes it belongs to. Sending `size` for a product
// that is NOT in per-size mode is likewise a 400, as is a size the
// product does not carry.

import { handle, json, fail } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getProduct, setProductStock, setProductSizeStock } from '../../../_lib/db.js';
import { hasSizeInventory, sizeQtyRemaining } from '../../../_lib/inventory.js';
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

  // Validate the amount once — the legacy and per-size paths below
  // differ only in WHAT the count belongs to (the product, or one
  // of its sizes), never in what counts are legal.
  let amount;
  if (hasSet) {
    const qty = Number(body.stockQty);
    if (!Number.isInteger(qty) || qty < 0 || qty > MAX_STOCK_QTY) {
      fail(400, `stockQty must be a whole number between 0 and ${MAX_STOCK_QTY}`);
    }
    amount = qty;
  } else {
    const delta = Number(body.adjustBy);
    if (!Number.isInteger(delta) || delta === 0 || delta < -MAX_STOCK_QTY || delta > MAX_STOCK_QTY) {
      fail(400, `adjustBy must be a nonzero whole number between -${MAX_STOCK_QTY} and ${MAX_STOCK_QTY}`);
    }
    amount = delta;
  }

  // Per-size branching (2026-11-10): the mode test is the shared
  // hasSizeInventory helper, so this endpoint can never disagree
  // with the order gate or the offer flows about which mode a
  // product is in.
  const size = body && body.size != null ? String(body.size).trim() : '';
  if (hasSizeInventory(product)) {
    if (!size) {
      fail(
        400,
        `"${product.name}" tracks stock per size — pick a size and send it as "size" with stockQty or adjustBy to change one size's count.`
      );
    }
    const current = sizeQtyRemaining(product, size);
    if (current === null) {
      fail(400, `"${product.name}" is not offered in size "${size}".`);
    }
    const next = hasSet ? amount : Math.max(0, current + amount);
    const updated = await setProductSizeStock(context.env, product.id, size, next);
    return json(updated);
  }
  if (size) {
    fail(400, `"${product.name}" does not track stock per size — leave "size" out to change its total count.`);
  }

  const next = hasSet
    ? amount
    : Math.max(0, (product.stockQty != null ? product.stockQty : 0) + amount);
  const updated = await setProductStock(context.env, product.id, next);
  return json(updated);
});
