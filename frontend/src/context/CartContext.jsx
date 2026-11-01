import React, { createContext, useState, useCallback, useEffect } from 'react';

// Cart state — ported from the live shop's CartContext, with the shop's
// Price-TBD rule made explicit in the totals: an item whose price is
// null ("Price TBD") stays in the cart, is EXCLUDED from subtotal/tax/
// total, and blocks checkout until its price is confirmed. (The live
// API enforces the same rule server-side — see validate.js — so a
// TBD item can never actually be ordered.)
export const CartContext = createContext();

export const TAX_RATE = 0.102;

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

  const addToCart = useCallback((product, qty = 1) => {
    setItems((prevItems) => {
      const existing = prevItems.find((i) => i.id === product.id);
      if (existing) {
        return prevItems.map((i) =>
          i.id === product.id ? { ...i, qty: Math.min(10, i.qty + qty) } : i
        );
      }
      return [...prevItems, { ...product, qty }];
    });
  }, []);

  const removeFromCart = useCallback((productId) => {
    setItems((prevItems) => prevItems.filter((i) => i.id !== productId));
  }, []);

  const updateQty = useCallback(
    (productId, qty) => {
      if (qty <= 0) {
        removeFromCart(productId);
        return;
      }
      setItems((prevItems) =>
        prevItems.map((i) =>
          i.id === productId ? { ...i, qty: Math.min(10, Math.max(1, qty)) } : i
        )
      );
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
