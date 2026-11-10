// Inventory tracking — stock counts for Shop 824 products (owner
// direction 2026-11-09).
//
// The model:
//   * A product is TRACKED when its stock_qty is set, UNTRACKED when
//     stock_qty is NULL. Untracked is the legacy behavior — sellable
//     with no count and no decrement — and every product that existed
//     before this feature stays untracked until the owner sets a
//     count, so turning inventory on can never strand the catalog.
//   * Placement is only a GATE: normalizeOrder refuses a tracked
//     product ordered past its count, but no stock moves there.
//   * The DECREMENT happens at the payment commit point, which is
//     different for the shop's two payment paths, by design:
//       - Stripe orders: the checkout.session.completed webhook —
//         the moment money is actually confirmed. An order that is
//         created but never paid (abandoned/expired checkout) must
//         not consume stock.
//       - Demo-card orders: POST /api/orders itself. The demo flow
//         has no webhook and never marks the order paid, so placement
//         — where the (demo) card is taken — is the only commit point
//         there is. Demo stock movement mirrors what the Stripe path
//         will do once real payments are wired per order.
//   * Idempotency: orders.inventory_applied is the once-only flag.
//     applyOrderInventory no-ops when it is already set, so a Stripe
//     webhook redelivery (or a duplicate call) can never decrement
//     twice.
//   * Floor: the decrement is a single atomic UPDATE ... MAX(0, ...)
//     in db.js. Two payments racing for the last unit can oversell by
//     that hair — accepted and documented here — but the stored count
//     can never go negative.
//   * Per-size mode (2026-11-10): a product whose size_inventory
//     map is set carries its stock PER SIZE instead. Its stockQty
//     reads as the map's sum (so isTracked/available/low-stock work
//     unchanged), placement gates each line against its own size's
//     count (validate.js), and the commit decrement takes only the
//     ordered size down, re-deriving the sum (db.js
//     decrementProductSizeStock). Legacy products never enter this
//     path — see docs/CLOTHING.md.
//
// Restocking / corrections are the admin's job via
// PATCH /api/admin/products/:id/stock (set an absolute count, or
// adjust by a delta) — see docs/INVENTORY.md.

import {
  getProduct,
  getOrder,
  decrementProductStock,
  decrementProductSizeStock,
  setOrderInventoryApplied,
} from './db.js';
import { DEFAULT_LOW_STOCK_THRESHOLD } from './validate.js';

export { DEFAULT_LOW_STOCK_THRESHOLD };

/** True when a rowToProduct-shaped product is stock-tracked. */
export function isTracked(product) {
  return Boolean(product) && product.stockQty !== null && product.stockQty !== undefined;
}

/** True when a tracked product is at or under its low-stock threshold. */
export function isLowStock(product) {
  if (!isTracked(product)) return false;
  const threshold = product.lowStockThreshold != null
    ? product.lowStockThreshold
    : DEFAULT_LOW_STOCK_THRESHOLD;
  return product.stockQty > 0 && product.stockQty <= threshold;
}

/**
 * Per-size stock (2026-11-10): true when the product is in per-size
 * mode — its sizeInventory map IS its stock. Shared by the order
 * gate, the offer flows and the admin stock endpoint so the mode
 * test lives in exactly one place.
 */
export function hasSizeInventory(product) {
  return (
    Boolean(product) &&
    Array.isArray(product.sizeInventory) &&
    product.sizeInventory.length > 0
  );
}

/**
 * The remaining count for ONE size of a per-size product, or null
 * when the product is not in per-size mode or does not carry that
 * size. (A carried size can legitimately read 0 — sold out.)
 */
export function sizeQtyRemaining(product, size) {
  if (!hasSizeInventory(product)) return null;
  const entry = product.sizeInventory.find((e) => e.size === size);
  return entry ? entry.qty : null;
}

/**
 * Apply an order's stock decrement exactly once. `order` is a
 * rowToOrder shape (items carry productId + qty). Returns the fresh
 * order. Safe to call from both commit points and on webhook
 * redelivery: the inventory_applied flag makes repeats no-ops.
 */
export async function applyOrderInventory(env, order) {
  if (!order || order.inventoryApplied) return order;
  for (const item of order.items || []) {
    // eslint-disable-next-line no-await-in-loop
    const product = await getProduct(env, item.productId);
    if (isTracked(product)) {
      if (hasSizeInventory(product) && item.size) {
        // Per-size mode: only the ordered size counts down (the
        // stock_qty sum follows it — see decrementProductSizeStock).
        // eslint-disable-next-line no-await-in-loop
        await decrementProductSizeStock(env, product.id, item.size, item.qty);
      } else {
        // Legacy mode — and the defensive corner of a per-size
        // product ordered without a size: unreachable through the
        // API (placement requires a size for per-size products),
        // but if a hand-made order ever lands here the total still
        // counts down, exactly as it always has.
        // eslint-disable-next-line no-await-in-loop
        await decrementProductStock(env, product.id, item.qty);
      }
    }
  }
  await setOrderInventoryApplied(env, order.id);
  const fresh = await getOrder(env, order.id);
  return fresh || { ...order, inventoryApplied: 1 };
}
