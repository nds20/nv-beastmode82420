import { useEffect, useMemo, useState } from 'react';
import { useProducts } from '../hooks/useProducts';
import ProductCard from '../components/ProductCard';
import {
  SORT_OPTIONS,
  applyShopFilters,
  categoryLabel,
  groupByDepartment,
  listManufacturers,
  sortProducts,
} from '../lib/departments';

// Products grid — route "/shop/products". Ported from the shop's
// previous storefronts; category chips are derived from the catalog
// data.
//
// Browsing (owner direction 2026-11-09: "chips AND departments"):
//   * The chips stay exactly as they were — All + one per category
//     present in the catalog; a tapped chip filters to a flat grid.
//   * With NO chip selected, a catalog spanning more than one
//     department renders GROUPED under department headings (Clothes /
//     Fragrances / Body Care / More — see lib/departments.js), with
//     filtering + sorting applied first, order preserved within each
//     section.
//   * A single-department catalog, or any chip selection, renders
//     the flat grid exactly as before.
//
// Filtering + sorting (owner direction 2026-11-09: "sort by
// manufacturer for every single category… filter — like price high
// to low, manufacturer — build filtering and sorting into it"):
//   * A Manufacturer dropdown sits beside Sort. "Manufacturer" is
//     the owner's word for the product `brand` field. Its options
//     are the makers present in the set the shopper is browsing —
//     scoped by the active category chip + search text (in All, that
//     is everyone) — recomputed from the data, never a fixed list.
//   * The control is HIDDEN when the scoped set has fewer than two
//     manufacturers: a filter with one possible answer is a no-op,
//     and a hidden control can never strand a shopper (documented
//     choice, docs/CLOTHING.md "Filtering & sorting").
//   * If a manufacturer filter is active and the shopper switches
//     chips into a scope where that maker has nothing, the filter
//     resets to All manufacturers — never a dead-end empty page
//     whose cause is invisible. The same guard covers the search
//     text narrowing the scope out from under the filter.
//   * Price sorts put Price-TBD products last in both directions
//     (a TBD price is unknown, not $0) — see sortProducts in
//     lib/departments.js, where all the pure logic lives.
export default function Products() {
  const { products, loading } = useProducts();
  const [term, setTerm] = useState('');
  const [sortBy, setSortBy] = useState('featured');
  const [category, setCategory] = useState('all');
  const [manufacturer, setManufacturer] = useState('all');

  const categories = useMemo(() => {
    const seen = new Map();
    for (const p of products) {
      if (p.category && !seen.has(p.category)) seen.set(p.category, p.category);
    }
    return [...seen.values()];
  }, [products]);

  // The manufacturers a shopper can pick from RIGHT NOW: the makers
  // in the set scoped by the active chip + search text, before the
  // manufacturer filter itself is applied.
  const scopedMakers = useMemo(
    () => listManufacturers(applyShopFilters(products, { category, query: term })),
    [products, category, term]
  );

  // Dead-end guard: a maker selected in one scope may not exist in
  // the next (chip switch, search edit). Reset to All rather than
  // filtering the new scope down to nothing.
  useEffect(() => {
    if (manufacturer === 'all') return;
    const stillThere = scopedMakers.some(
      (m) => m.toLowerCase() === manufacturer.toLowerCase()
    );
    if (!stillThere) setManufacturer('all');
  }, [manufacturer, scopedMakers]);

  const filtered = useMemo(
    () => sortProducts(applyShopFilters(products, { category, manufacturer, query: term }), sortBy),
    [products, term, sortBy, category, manufacturer]
  );

  // Grouped mode only when browsing everything (no chip) and what's
  // left after filtering/sorting actually spans multiple departments.
  const groups = useMemo(
    () => (category === 'all' ? groupByDepartment(filtered) : []),
    [category, filtered]
  );
  const grouped = groups.length > 1;

  const hasActiveFilters = manufacturer !== 'all' || term.trim() !== '' || category !== 'all';
  const clearFilters = () => {
    setManufacturer('all');
    setTerm('');
    setCategory('all');
  };

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
        {scopedMakers.length > 1 && (
          <div className="shop-sort">
            <select
              aria-label="Filter by manufacturer"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
            >
              <option value="all">All manufacturers</option>
              {scopedMakers.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="shop-sort">
          <select
            aria-label="Sort products"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
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
      ) : (
        <>
          <p className="result-count" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'product' : 'products'}
          </p>
          {filtered.length === 0 ? (
            <div className="empty-msg">
              <p>No products match those filters.</p>
              {hasActiveFilters && (
                <button type="button" className="btn" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
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
        </>
      )}
    </main>
  );
}
