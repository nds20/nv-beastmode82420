// Shop browsing taxonomy — the ONE source for category labels and
// departments (owner direction 2026-11-09: "chips on the shop page
// AND clear departments"). Chips, department headings, the product
// editor's category select and the product pages all read labels
// from here so they can never drift apart.
//
// Plain ESM with no JSX/imports on purpose: the node test suites
// import the grouping helper directly (scripts/test-clothing.mjs).

// Category ids mirror CATEGORIES in functions/api/_lib/validate.js
// (the API rejects anything else); labels are how shoppers see them.
export const CATEGORY_LABELS = {
  shirts: 'Shirts',
  jeans: 'Jeans',
  hoodies: 'Hoodies',
  hats: 'Hats',
  accessories: 'Accessories',
  fragrances: 'Fragrances',
  candles: 'Candles',
  'body-care': 'Body Care',
  'test-item': 'Test Item',
  other: 'Other',
};

/** Display label for a category id; unknown ids de-hyphenate + capitalize. */
export function categoryLabel(category) {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return String(category || '')
    .split('-')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Genders (2026-11-10, per-size stock build) — mirror GENDERS /
// GENDER_LABELS in functions/api/_lib/validate.js (the API stores
// exactly these ids; anything else reads as "not stated" and never
// renders). The editor's Gender select, the card and the detail
// page all read labels from here.
export const GENDERS = [
  { value: 'mens', label: "Men's" },
  { value: 'womens', label: "Women's" },
  { value: 'unisex', label: 'Unisex' },
  { value: 'kids', label: 'Kids' },
];
export const GENDER_LABELS = Object.fromEntries(GENDERS.map((g) => [g.value, g.label]));

/** Display label for a gender id; '' when unset or unrecognized. */
export function genderLabel(gender) {
  return GENDER_LABELS[gender] || '';
}

// Departments group the categories for the shop page's grouped
// browsing mode (no chip selected). Order here is display order.
export const DEPARTMENTS = [
  { id: 'clothes', label: 'Clothes', categories: ['shirts', 'jeans', 'hoodies', 'hats', 'accessories'] },
  { id: 'fragrances', label: 'Fragrances', categories: ['fragrances', 'candles'] },
  { id: 'body-care', label: 'Body Care', categories: ['body-care'] },
  { id: 'more', label: 'More', categories: ['test-item', 'other'] },
];

/** The department a category belongs to (unknown categories -> More). */
export function departmentForCategory(category) {
  return (
    DEPARTMENTS.find((d) => d.categories.includes(category)) ||
    DEPARTMENTS[DEPARTMENTS.length - 1]
  );
}

/**
 * Group an (already filtered + sorted) product list by department.
 * Returns [{ id, label, products }] in department order, containing
 * only departments that have at least one product; the input order
 * is preserved within each group. Pure — unit-tested in
 * scripts/test-clothing.mjs.
 */
export function groupByDepartment(products) {
  const groups = new Map(DEPARTMENTS.map((d) => [d.id, { ...d, products: [] }]));
  for (const product of products || []) {
    groups.get(departmentForCategory(product.category).id).products.push(product);
  }
  return [...groups.values()].filter((g) => g.products.length > 0);
}

// ----- Filtering + sorting ---------------------------------------------------
//
// The shop page's client-side filter/sort vocabulary (owner
// direction 2026-11-09: "sort by manufacturer for every single
// category… filter — like price high to low, manufacturer — build
// filtering and sorting into it"). The catalog arrives whole from
// GET /api/products, so everything here is pure and unit-tested in
// scripts/test-shop-filters.mjs.
//
// Vocabulary note: the data field is `brand`; the owner's word for
// it is "manufacturer", so the UI labels read "Manufacturer" while
// the code keeps reading `brand`. Same for the 'manufacturer' SORT
// key below — it sorts by the brand field.

// The shop page's sort choices, in display order: value -> label.
export const SORT_OPTIONS = [
  { value: 'featured', label: 'Featured' },
  { value: 'price-asc', label: 'Price: Low to High' },
  { value: 'price-desc', label: 'Price: High to Low' },
  { value: 'name-asc', label: 'Name: A to Z' },
  { value: 'name-desc', label: 'Name: Z to A' },
  { value: 'newest', label: 'Newest' },
  { value: 'manufacturer', label: 'Manufacturer' },
];

/** A product's manufacturer key: the trimmed brand, or ''. */
function brandKey(product) {
  return String((product && product.brand) || '').trim();
}

/**
 * The manufacturers present in a product list: the sorted, unique,
 * non-empty brands. Dedupe is case-insensitive ('824' and '824 '
 * and 'ACME'/'acme' collapse); the first-seen display casing wins.
 * Order is A–Z case-insensitive. Blank / whitespace-only / missing
 * brands are not manufacturers and never appear in the list.
 */
export function listManufacturers(products) {
  const seen = new Map();
  for (const product of products || []) {
    const brand = brandKey(product);
    if (!brand) continue;
    const key = brand.toLowerCase();
    if (!seen.has(key)) seen.set(key, brand);
  }
  return [...seen.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Filter a product list by { category, manufacturer, query }:
 *   - category: 'all' / null / undefined = every category; else an
 *     exact category-id match.
 *   - manufacturer: 'all' / null / undefined = every maker; else an
 *     exact brand match (compared case-insensitively, trimmed).
 *     Products with NO brand appear only under 'all manufacturers'
 *     — an unbranded product has no maker to match.
 *   - query: case-insensitive substring against name + subtitle;
 *     blank = no text filter.
 * Returns a NEW array; the input is never mutated. Pure.
 */
export function applyShopFilters(products, { category, manufacturer, query } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const maker =
    manufacturer == null || manufacturer === 'all'
      ? null
      : String(manufacturer).trim().toLowerCase();
  return (products || []).filter((p) => {
    const matchesCategory = !category || category === 'all' || p.category === category;
    const matchesMaker = maker === null || brandKey(p).toLowerCase() === maker;
    const matchesSearch =
      !q ||
      String(p.name || '').toLowerCase().includes(q) ||
      String(p.subtitle || '').toLowerCase().includes(q);
    return matchesCategory && matchesMaker && matchesSearch;
  });
}

/**
 * Sort a product list by sortKey — always a NEW, stably sorted
 * array; the input is never mutated. Keys:
 *   'featured'     the input order, unchanged (API order)
 *   'price-asc'    cheapest first
 *   'price-desc'   priciest first
 *   'name-asc'     A to Z        'name-desc'  Z to A
 *   'newest'       highest id first (ids are monotonic)
 *   'manufacturer' brand A–Z (case-insensitive), unbranded LAST,
 *                  then name A–Z within a maker
 * Price sorts put Price-TBD products (price null) LAST in BOTH
 * directions — a TBD price is unknown, not $0. Unknown keys fall
 * back to 'featured'. Array.prototype.sort is stable in every
 * runtime this ships to, so equal elements keep input order.
 */
export function sortProducts(products, sortKey) {
  const list = [...(products || [])];
  const priceOf = (p) => (p.price == null ? null : Number(p.price));
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  switch (sortKey) {
    case 'price-asc':
      return list.sort((a, b) => {
        const pa = priceOf(a);
        const pb = priceOf(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pa - pb;
      });
    case 'price-desc':
      return list.sort((a, b) => {
        const pa = priceOf(a);
        const pb = priceOf(b);
        if (pa === null && pb === null) return 0;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      });
    case 'name-asc':
      return list.sort(byName);
    case 'name-desc':
      return list.sort((a, b) => byName(b, a));
    case 'newest':
      return list.sort((a, b) => (b.id || 0) - (a.id || 0));
    case 'manufacturer':
      return list.sort((a, b) => {
        const ba = brandKey(a);
        const bb = brandKey(b);
        if (!ba && !bb) return byName(a, b);
        if (!ba) return 1;
        if (!bb) return -1;
        const byBrand = ba.toLowerCase().localeCompare(bb.toLowerCase());
        return byBrand !== 0 ? byBrand : byName(a, b);
      });
    case 'featured':
    default:
      return list;
  }
}
