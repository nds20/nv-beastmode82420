// Shop filter + sort tests (2026-11-09) — plain node, no framework:
//
//   node scripts/test-shop-filters.mjs
//
// The storefront filtering + sorting build (owner direction
// 2026-11-09: "sort by manufacturer for every single category…
// filter — like price high to low, manufacturer — build filtering
// and sorting into it"; see docs/CLOTHING.md "Filtering & sorting").
// Purely client-side: the catalog arrives whole from
// GET /api/products, so this suite unit-tests the pure helpers in
// frontend/src/lib/departments.js directly — no D1 stub, no routes.
// Covers:
//   (a) listManufacturers: uniqueness, case-insensitive dedupe with
//       first-seen casing kept, blanks/nulls excluded, A–Z order
//   (b) applyShopFilters: category / manufacturer / query compose;
//       unbranded products appear ONLY under All manufacturers;
//       maker matching is exact (no partial), case-insensitive
//   (c) sortProducts: every key — featured identity, price both
//       directions with Price-TBD (null) ALWAYS last, name both
//       directions, newest by id desc, manufacturer (brand A–Z,
//       unbranded last, name breaks ties) — plus non-mutation of
//       the input for every sort
//   (d) filter -> sort composition: the pipeline the shop page runs

import {
  SORT_OPTIONS,
  applyShopFilters,
  listManufacturers,
  sortProducts,
} from '../frontend/src/lib/departments.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const ids = (list) => list.map((p) => p.id).join(',');

// A mixed catalog: three makers (one duplicated with sloppy casing),
// unbranded items (null AND empty-string brand), Price-TBD items,
// two departments' worth of categories.
const CATALOG = [
  { id: 1, name: 'Beast Hoodie', subtitle: 'Heavyweight fleece', category: 'hoodies', brand: '824', price: 60 },
  { id: 2, name: 'Alpha Tee', subtitle: '', category: 'shirts', brand: 'acme', price: 25 },
  { id: 3, name: 'Zulu Tee', subtitle: 'Soft cotton', category: 'shirts', brand: 'ACME', price: null },
  { id: 4, name: 'No. 20 Parfum', subtitle: 'Sandalwood & vanilla', category: 'fragrances', brand: ' 824 ', price: 68 },
  { id: 5, name: 'Plain Cap', subtitle: '', category: 'hats', brand: null, price: 20 },
  { id: 6, name: 'Mystery Candle', subtitle: 'Cedar & amber', category: 'candles', brand: '', price: 24 },
  { id: 7, name: 'Beta Hoodie', subtitle: '', category: 'hoodies', brand: 'Zenith', price: 45 },
  { id: 8, name: 'Gamma Hoodie', subtitle: '', category: 'hoodies', brand: 'Zenith', price: null },
];

// =====================================================================================
// (a) listManufacturers
// =====================================================================================
{
  const makers = listManufacturers(CATALOG);
  check('(a) makers are unique, non-empty, A–Z (case-insensitive)',
    makers.join('|') === '824|acme|Zenith',
    JSON.stringify(makers));
  check('(a) dedupe keeps FIRST-SEEN display casing (acme before ACME)',
    makers.includes('acme') && !makers.includes('ACME'));
  check('(a) whitespace-padded brand trims into its maker (no second 824)',
    makers.filter((m) => m.toLowerCase() === '824').length === 1);
  check('(a) unbranded-only list has no manufacturers',
    listManufacturers([{ brand: null }, { brand: '' }, { brand: '   ' }, {}]).length === 0);
  check('(a) empty / missing input yields []',
    listManufacturers([]).length === 0 && listManufacturers().length === 0);
}

// =====================================================================================
// (b) applyShopFilters
// =====================================================================================
{
  check('(b) no filters returns the whole catalog in order',
    ids(applyShopFilters(CATALOG, {})) === '1,2,3,4,5,6,7,8' &&
    ids(applyShopFilters(CATALOG, { category: 'all', manufacturer: 'all', query: '' })) === '1,2,3,4,5,6,7,8');

  check('(b) category filter is exact',
    ids(applyShopFilters(CATALOG, { category: 'hoodies' })) === '1,7,8');

  const maker824 = applyShopFilters(CATALOG, { manufacturer: '824' });
  check('(b) manufacturer filter matches the brand field, trimmed',
    ids(maker824) === '1,4', ids(maker824));
  check('(b) manufacturer match is case-insensitive',
    ids(applyShopFilters(CATALOG, { manufacturer: 'ACME' })) === '2,3');
  check('(b) manufacturer match is EXACT, not partial',
    applyShopFilters(CATALOG, { manufacturer: 'Zen' }).length === 0 &&
    applyShopFilters(CATALOG, { manufacturer: '82' }).length === 0);

  check('(b) unbranded products appear ONLY under All manufacturers',
    ids(applyShopFilters(CATALOG, { category: 'hats' })) === '5' &&
    applyShopFilters(CATALOG, { category: 'hats', manufacturer: '824' }).length === 0 &&
    applyShopFilters(CATALOG, { category: 'candles', manufacturer: 'Zenith' }).length === 0);

  check('(b) query searches name AND subtitle, case-insensitively',
    ids(applyShopFilters(CATALOG, { query: 'sandalwood' })) === '4' &&
    ids(applyShopFilters(CATALOG, { query: 'TEE' })) === '2,3');

  check('(b) category + manufacturer + query compose',
    ids(applyShopFilters(CATALOG, { category: 'hoodies', manufacturer: 'zenith', query: 'gamma' })) === '8' &&
    ids(applyShopFilters(CATALOG, { category: 'hoodies', query: 'hoodie' })) === '1,7,8' &&
    applyShopFilters(CATALOG, { category: 'shirts', manufacturer: 'Zenith' }).length === 0);

  const input = [...CATALOG];
  applyShopFilters(input, { category: 'hoodies' });
  check('(b) filtering never mutates the input array',
    input.length === CATALOG.length && ids(input) === '1,2,3,4,5,6,7,8');
}

// =====================================================================================
// (c) sortProducts
// =====================================================================================
{
  check('(c) SORT_OPTIONS carries the full owner set, in display order',
    SORT_OPTIONS.map((o) => o.value).join(',') ===
      'featured,price-asc,price-desc,name-asc,name-desc,newest,manufacturer' &&
    SORT_OPTIONS.map((o) => o.label).join('|') ===
      'Featured|Price: Low to High|Price: High to Low|Name: A to Z|Name: Z to A|Newest|Manufacturer',
    JSON.stringify(SORT_OPTIONS));

  check('(c) featured returns the input order unchanged',
    ids(sortProducts(CATALOG, 'featured')) === '1,2,3,4,5,6,7,8');
  check('(c) unknown sort keys fall back to featured',
    ids(sortProducts(CATALOG, 'bogus')) === '1,2,3,4,5,6,7,8');

  check('(c) price-asc: cheapest first, Price-TBD LAST',
    ids(sortProducts(CATALOG, 'price-asc')) === '5,6,2,7,1,4,3,8',
    ids(sortProducts(CATALOG, 'price-asc')));
  check('(c) price-desc: priciest first, Price-TBD STILL last (TBD is not $0)',
    ids(sortProducts(CATALOG, 'price-desc')) === '4,1,7,2,6,5,3,8',
    ids(sortProducts(CATALOG, 'price-desc')));

  check('(c) name-asc / name-desc',
    ids(sortProducts(CATALOG, 'name-asc')) === '2,1,7,8,6,4,5,3' &&
    ids(sortProducts(CATALOG, 'name-desc')) === '3,5,4,6,8,7,1,2',
    `${ids(sortProducts(CATALOG, 'name-asc'))} / ${ids(sortProducts(CATALOG, 'name-desc'))}`);

  check('(c) newest: highest id first',
    ids(sortProducts(CATALOG, 'newest')) === '8,7,6,5,4,3,2,1');

  // Makers: 824 -> ids 1,4 (name order: Beast Hoodie, No. 20 Parfum);
  // acme -> 2,3; Zenith -> 7,8; unbranded LAST (5,6 by name).
  check('(c) manufacturer: brand A–Z, name breaks ties, unbranded last',
    ids(sortProducts(CATALOG, 'manufacturer')) === '1,4,2,3,7,8,6,5',
    ids(sortProducts(CATALOG, 'manufacturer')));

  for (const key of ['featured', 'price-asc', 'price-desc', 'name-asc', 'name-desc', 'newest', 'manufacturer']) {
    const input = [...CATALOG];
    const out = sortProducts(input, key);
    check(`(c) sort '${key}' returns a new array and never mutates the input`,
      out !== input && ids(input) === '1,2,3,4,5,6,7,8');
  }
}

// =====================================================================================
// (d) The shop page's pipeline: filter, then sort (grouping reads the
// sorted result — covered for grouping itself in test-clothing (i)).
// =====================================================================================
{
  const shelf = sortProducts(
    applyShopFilters(CATALOG, { category: 'hoodies', manufacturer: 'all' }),
    'price-desc'
  );
  check('(d) category scope + price-desc compose (TBD last)',
    ids(shelf) === '1,7,8', ids(shelf));

  const zenith = sortProducts(
    applyShopFilters(CATALOG, { manufacturer: 'Zenith' }),
    'price-asc'
  );
  check('(d) manufacturer scope + price-asc compose (TBD last)',
    ids(zenith) === '7,8', ids(zenith));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
