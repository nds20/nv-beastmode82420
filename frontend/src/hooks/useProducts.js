import { useState, useEffect, useCallback } from 'react';

// The catalog comes from the product API only. There is deliberately NO
// bundled fallback list: the owner emptied the catalog on 2026-11-01 (the
// shop is being kept for future 824 merchandise), and a previous fallback
// array kept deleted products on display even when the API returned an
// empty list. An empty response from the API means an empty shelf.
export const useProducts = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/products');
      if (!response.ok) throw new Error('Failed to fetch products');
      const data = await response.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) {
      // API unreachable: show the empty shelf rather than invented stock.
      setError(err.message);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const getProduct = (id) => products.find((p) => p.id === Number(id));

  return { products, loading, error, fetchProducts, getProduct };
};
