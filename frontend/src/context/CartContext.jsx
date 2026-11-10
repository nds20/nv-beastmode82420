import React, { createContext, useState, useCallback, useEffect } from 'react';

// Cart state — ported from the live shop's CartContext, with the shop's
// Price-TBD rule made explicit in the totals: an item whose price is
// null ("Price TBD") stays in the cart, is EXCLUDED from subtotal/tax/
// total, and blocks checkout until its price is confirmed. (The live
// API enforces the same rule server-side — see validate.js — so a
// TBD item can never actually be ordered.)
export const CartContext = createContext();

export const TAX_RATE = 0.102;

// Mirrors DEFAULT_LOW_STOCK_THRESHOLD in functions/api/_lib/validate.js.
export const LOW_STOCK_THRESHOLD = 3;

// Inventory helpers (2026-11-09): a cart line carries the product's
// fields, so stockQty rides along. Untracked items (stockQty null)
// have no cap beyond the shop-wide per-line max of 10; tracked items
// cap at what's actually on the shelf.
export const isTrackedItem = (item) => item && item.stockQty !== null && item.stockQty !== undefined;
export const qtyCapFor = (item) => {
  // Per-size mode (2026-11-10): an item that names a size (a cart
  // line, or the detail page's selection) caps at THAT size's
  // remaining count, not the product total.
  const inv = sizeInventoryOf(item);
  if (inv && item.size) {
    const entry = inv.find((e) => e.size === item.size);
    return Math.max(1, Math.min(10, entry ? entry.qty : 0));
  }
  return isTrackedItem(item) ? Math.max(1, Math.min(10, item.stockQty)) : 10;
};
export const isSoldOut = (item) => isTrackedItem(item) && item.stockQty <= 0;
export const isLowStock = (item) =>
  isTrackedItem(item) &&
  item.stockQty > 0 &&
  item.stockQty <=
    (item.lowStockThreshold !== null && item.lowStockThreshold !== undefined
      ? item.lowStockThreshold
      : LOW_STOCK_THRESHOLD);

// Clothing sizes (2026-11-09): a cart LINE is one product in one
// size — the same hoodie in M and L is two lines. Line identity is
// therefore (id + size); a size-less line uses ''. Stock is tracked
// per PRODUCT, not per size, so qtyCapFor caps the TOTAL quantity
// across all of a product's size lines (enforced in addToCart /
// updateQty below by netting out the other lines).
//
// Per-size stock (2026-11-10): a product in per-size mode
// (sizeInventory present) carries its stock PER SIZE instead — the
// total-across-lines rule does not apply to it. Its lines cap at
// their OWN size's remaining count (qtyCapFor reads the line's
// size; qtyCapForSize is the detail page's version), and addToCart /
// updateQty branch on the mode via the helpers below. Legacy
// products never enter the per-size branches.
export const lineKey = (item) => `${item.id}::${item.size || ''}`;
export const sameLine = (a, b) => a.id === b.id && (a.size || '') === (b.size || '');

/** The product's per-size map as [{ size, qty }], or null in legacy mode. */
export const sizeInventoryOf = (item) =>
  item && Array.isArray(item.sizeInventory) && item.sizeInventory.length > 0
    ? item.sizeInventory
    : null;

/** Remaining count for one size of a per-size product; null when N/A. */
export const sizeQtyFor = (item, size) => {
  const inv = sizeInventoryOf(item);
  if (!inv) return null;
  const entry = inv.find((e) => e.size === size);
  return entry ? entry.qty : null;
};

/** Quantity cap for buying `size` of a product (per-size aware). */
export const qtyCapForSize = (product, size) => {
  const remaining = sizeQtyFor(product, size);
  if (remaining === null) return qtyCapFor(product);
  return Math.max(1, Math.min(10, remaining));
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const isTbd = (item) => item.price === null || item.price === undefined;

export const CartProvider = ({ children }) => {
  const [items, setItems] = useState(() => {
    try {
      const saved = localStorage.getItem('cart');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('cart', JSON.stringify(items));
    } catch {
      // Storage unavailable — cart just won't persist.
    }
  }, [items]);

  // addToCart(product, qty, size): size is the buyer's chosen size
  // for sized clothing (ProductDetail's picker); it becomes part of
  // the line's identity and rides into the order payload. Legacy
  // products: the cap is the product TOTAL across its size lines —
  // what's already in the cart for this product nets out of what's
  // left to add. Per-size products (2026-11-10): the cap is the
  // chosen size's own remaining count, and only this line nets out.
  const addToCart = useCallback((product, qty = 1, size = null) => {
    if (isSoldOut(product)) return; // sold-out items can't enter the cart
    const lineSize = size ? String(size) : null;
    const perSize = sizeInventoryOf(product);
    if (perSize && lineSize) {
      const remaining = sizeQtyFor(product, lineSize);
      if (remaining === null || remaining <= 0) return; // that size is sold out
      setItems((prevItems) => {
        const existing = prevItems.find(
          (i) => i.id === product.id && (i.size || null) === lineSize
        );
        const inLine = existing ? existing.qty : 0;
        const room = Math.max(0, Math.min(10, remaining) - inLine);
        if (room === 0) return prevItems;
        const addQty = Math.min(room, Math.max(1, qty));
        if (existing) {
          return prevItems.map((i) =>
            i === existing ? { ...i, qty: i.qty + addQty } : i
          );
        }
        return [...prevItems, { ...product, size: lineSize, qty: addQty }];
      });
      return;
    }
    setItems((prevItems) => {
      const cap = qtyCapFor(product);
      const inCart = prevItems
        .filter((i) => i.id === product.id)
        .reduce((sum, i) => sum + i.qty, 0);
      const room = Math.max(0, cap - inCart);
      if (room === 0) return prevItems;
      const addQty = Math.min(room, Math.max(1, qty));
      const existing = prevItems.find((i) => i.id === product.id && (i.size || null) === lineSize);
      if (existing) {
        return prevItems.map((i) =>
          i === existing ? { ...i, qty: i.qty + addQty } : i
        );
      }
      return [...prevItems, { ...product, size: lineSize, qty: addQty }];
    });
  }, []);

  const removeFromCart = useCallback((productId, size = null) => {
    setItems((prevItems) =>
      prevItems.filter((i) => !(i.id === productId && (i.size || null) === (size || null)))
    );
  }, []);

  const updateQty = useCallback(
    (productId, qty, size = null) => {
      if (qty <= 0) {
        removeFromCart(productId, size);
        return;
      }
      setItems((prevItems) => {
        const line = prevItems.find(
          (i) => i.id === productId && (i.size || null) === (size || null)
        );
        if (!line) return prevItems;
        // Per-size lines (2026-11-10) cap at their own size's
        // remaining count (qtyCapFor reads the line's size); legacy
        // lines share the product-total cap, so this line may grow
        // only into what the product's other size lines leave of it.
        if (sizeInventoryOf(line) && line.size) {
          const maxForLine = qtyCapFor(line);
          return prevItems.map((i) =>
            i === line ? { ...i, qty: Math.min(maxForLine, Math.max(1, qty)) } : i
          );
        }
        const othersQty = prevItems
          .filter((i) => i.id === productId && i !== line)
          .reduce((sum, i) => sum + i.qty, 0);
        const maxForLine = Math.max(1, qtyCapFor(line) - othersQty);
        return prevItems.map((i) =>
          i === line ? { ...i, qty: Math.min(maxForLine, Math.max(1, qty)) } : i
        );
      });
    },
    [removeFromCart]
  );

  const clearCart = useCallback(() => {
    setItems([]);
  }, []);

  const calculateTotals = useCallback(() => {
    const tbdItems = items.filter(isTbd);
    const subtotal = round2(
      items.reduce((sum, item) => sum + (isTbd(item) ? 0 : item.price * item.qty), 0)
    );
    const taxes = round2(subtotal * TAX_RATE);
    return {
      subtotal,
      discount: 0,
      taxes,
      total: round2(subtotal + taxes),
      hasTbd: tbdItems.length > 0,
      tbdItems,
    };
  }, [items]);

  const value = {
    items,
    taxRate: TAX_RATE,
    addToCart,
    removeFromCart,
    updateQty,
    clearCart,
    calculateTotals,
    itemCount: items.reduce((sum, i) => sum + i.qty, 0),
    isEmpty: items.length === 0,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};
