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
export const qtyCapFor = (item) =>
  isTrackedItem(item) ? Math.max(1, Math.min(10, item.stockQty)) : 10;
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
export const lineKey = (item) => `${item.id}::${item.size || ''}`;
export const sameLine = (a, b) => a.id === b.id && (a.size || '') === (b.size || '');

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
  // the line's identity and rides into the order payload. The cap is
  // the product TOTAL across its size lines: what's already in the
  // cart for this product nets out of what's left to add.
  const addToCart = useCallback((product, qty = 1, size = null) => {
    if (isSoldOut(product)) return; // sold-out items can't enter the cart
    const lineSize = size ? String(size) : null;
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
        // Per-product total cap: this line may grow only into what
        // the product's other size lines leave of the cap.
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
