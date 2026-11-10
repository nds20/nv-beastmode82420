import { useMemo, useState } from 'react';
import { useProducts } from '../hooks/useProducts';
import ProductCard from '../components/ProductCard';
import { categoryLabel, groupByDepartment } from '../lib/departments';

// Products grid — route "/shop/products". Search + sort, ported from
// the shop's previous storefronts: price sorts always put Price-TBD
// products last, and category chips are derived from the catalog data.
//
// Browsing (owner direction 2026-11-09: "chips AND departments"):
//   * The chips stay exactly as they were — All + one per category
//     present in the catalog; a tapped chip filters to a flat grid.
//   * With NO chip selected, a catalog spanning more than one
//     department renders GROUPED under department headings (Clothes /
//     Fragrances / Body Care / More — see lib/departments.js), search
//     + sort applied first, order preserved within each section.
//   * A single-department catalog, or any chip selection, renders
//     the flat grid exactly as before.
export default function Products() {
  const { products, loading } = useProducts();
  const [term, setTerm] = useState('');
  const [sortBy, setSortBy] = useState('featured');
  const [category, setCategory] = useState('all');

  const categories = useMemo(() => {
    const seen = new Map();
    for (const p of products) {
      if (p.category && !seen.has(p.category)) seen.set(p.category, p.category);
    }
    return [...seen.values()];
  }, [products]);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    const list = products.filter((p) => {
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.subtitle || '').toLowerCase().includes(q);
      const matchesCategory = category === 'all' || p.category === category;
      return matchesSearch && matchesCategory;
    });
    const priceKey = (p) => (p.price == null ? Number.POSITIVE_INFINITY : p.price);
    if (sortBy === 'price-low') list.sort((a, b) => priceKey(a) - priceKey(b));
    if (sortBy === 'price-high')
      list.sort((a, b) => (a.price == null ? -1 : b.price == null ? 1 : b.price - a.price));
    if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [products, term, sortBy, category]);

  // Grouped mode only when browsing everything (no chip) and what's
  // left after search/sort actually spans multiple departments.
  const groups = useMemo(
    () => (category === 'all' ? groupByDepartment(filtered) : []),
    [category, filtered]
  );
  const grouped = groups.length > 1;

  const grid = (list) => (
    <div className="grid">
      {list.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );

  return (
    <main className="shell">
      <div className="page-head">
        <h1 className="page-title">Shop Products</h1>
      </div>

      <div className="shop-controls">
        <div className="shop-search">
          <input
            type="text"
            placeholder="Search products..."
            aria-label="Search products"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
        <div className="shop-sort">
          <select
            aria-label="Sort products"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="featured">Featured</option>
            <option value="price-low">Price: Low to High</option>
            <option value="price-high">Price: High to Low</option>
            <option value="name">Name: A–Z</option>
          </select>
        </div>
      </div>

      {categories.length > 1 && (
        <div className="chip-row" role="group" aria-label="Category">
          <button
            type="button"
            className={`chip${category === 'all' ? ' active' : ''}`}
            onClick={() => setCategory('all')}
          >
            All Products
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${category === c ? ' active' : ''}`}
              onClick={() => setCategory(c)}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>
      )}

      {loading && products.length === 0 ? (
        <p className="empty-msg">Loading products…</p>
      ) : filtered.length === 0 ? (
        <p className="empty-msg">No products found</p>
      ) : grouped ? (
        groups.map((g) => (
          <section className="dept-section" key={g.id} aria-label={g.label}>
            <h2 className="dept-title">{g.label}</h2>
            {grid(g.products)}
          </section>
        ))
      ) : (
        grid(filtered)
      )}
    </main>
  );
}
