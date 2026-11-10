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
  hoodies: 'Hoodies',
  hats: 'Hats',
  accessories: 'Accessories',
  fragrances: 'Fragrances',
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

// Departments group the categories for the shop page's grouped
// browsing mode (no chip selected). Order here is display order.
export const DEPARTMENTS = [
  { id: 'clothes', label: 'Clothes', categories: ['shirts', 'hoodies', 'hats', 'accessories'] },
  { id: 'fragrances', label: 'Fragrances', categories: ['fragrances'] },
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
