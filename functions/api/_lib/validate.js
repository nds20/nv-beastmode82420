// Validation/normalization — a line-for-line port of the rules in
// ../../server/index.js (normalizeProduct / normalizeOrder). If you change
// a rule here, change it there too: the two runtimes share one contract.

import { fail, round2 } from './http.js';

// The storefront's filter list (ProductsPage.jsx) — a product only shows up
// in a category filter if its category is one of these ids.
// Clothing store (owner direction 2026-11-09): Shop 824 sells clothes
// now, not smoke-shop goods — plus fragrance & body care (perfumes,
// colognes, deodorant), added by the owner the same evening.
// 'candles' joined the scented-goods shelf later that night.
// The legacy ids (flower / vapes / gummies / pouches / nic-vapes) are
// retired — the API rejects them. 'test-item' is a first-class
// category for listings that need nothing beyond a name and a price
// (the $8.24 nothing item — see docs/CLOTHING.md).
export const CATEGORIES = [
  'shirts', 'hoodies', 'hats', 'accessories',
  'fragrances', 'candles', 'body-care', 'test-item', 'other',
];

// Decorative card-gradient defaults for products created without colors.
// (UI chrome, not product data.)
export const DEFAULT_TILE = ['#374151', '#111827'];

// Same 10.2% sales tax the storefront applies (CartContext / CheckoutPage).
export const TAX_RATE = 0.102;

function parseOptionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) fail(400, `${field} must be a number`);
  return num;
}

// Shipping measurement fields (2026-11-09): all optional — an unset
// field stays null and _lib/shipping.js applies its documented
// defaults at quote time. A SET field must be a positive number within
// the USPS envelope (70 lb max parcel weight = 1120 oz; 108 in max
// dimension); anything else is a 400, never silently clamped.
function parseShippingMeasure(value, field, max) {
  const num = parseOptionalNumber(value, field);
  if (num === null) return null;
  if (num <= 0 || num > max) {
    fail(400, `${field} must be greater than 0 and at most ${max}`);
  }
  return num;
}

// Inventory fields (2026-11-09): stockQty / lowStockThreshold are
// integer counts. An unset stockQty stays null — the product is
// UNTRACKED and sells exactly as products always have (see
// _lib/inventory.js). A set value must be a whole number in range;
// anything else is a 400, never rounded into place.
export const MAX_STOCK_QTY = 100000;

function parseStockInteger(value, field, max) {
  const num = parseOptionalNumber(value, field);
  if (num === null) return null;
  if (!Number.isInteger(num) || num < 0 || num > max) {
    fail(400, `${field} must be a whole number between 0 and ${max}`);
  }
  return num;
}

// A tracked product at or below this many units reads as "low stock"
// when it has no threshold of its own. One constant, one place —
// _lib/inventory.js re-exports it and the storefront mirrors it.
export const DEFAULT_LOW_STOCK_THRESHOLD = 3;

// Free-shipping flag: boolean-ish admin input (true / 1 / '1' / 'true'
// count as on — multipart forms send strings); anything else is off.
function parseFreeShipping(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseEffects(value) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    // Multipart forms send the array JSON-encoded (see buildProductBody).
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((e) => String(e).trim()).filter(Boolean);
    } catch { /* fall through to comma-split */ }
  }
  if (Array.isArray(value)) return value.map((e) => String(e).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((e) => e.trim()).filter(Boolean);
  return [];
}

// Clothing fields (2026-11-09): brand is an optional label string;
// sizes is the product's size run. Both are forgiving at the edges —
// the caps below NORMALIZE (extra entries / over-long entries are
// dropped) rather than 400, because a size list is display data the
// admin typed by hand, not money or stock. The result is stored as a
// JSON array by db.js; an empty result means one-size / not
// applicable.
export const MAX_BRAND_LENGTH = 80;
export const MAX_SIZES = 12;
export const MAX_SIZE_LENGTH = 12;

function parseBrand(value) {
  if (value === undefined || value === null) return null;
  const brand = String(value).trim().slice(0, MAX_BRAND_LENGTH);
  return brand === '' ? null : brand;
}

function parseSizes(value) {
  let list = [];
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    // Multipart forms send the array JSON-encoded (same convention
    // as effects — see parseEffects).
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* fall through to comma-split */ }
  }
  if (list.length === 0) {
    if (Array.isArray(value)) list = value;
    else if (typeof value === 'string') list = value.split(',');
    else return [];
  }
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const size = String(entry).trim().slice(0, MAX_SIZE_LENGTH);
    if (!size || seen.has(size)) continue;
    seen.add(size);
    out.push(size);
    if (out.length >= MAX_SIZES) break;
  }
  return out;
}

// Scent (fragrance & body care, 2026-11-09): an optional free-text
// note ("sandalwood & vanilla"). Trim + cap, never required, null
// when blank — same treatment as brand.
export const MAX_SCENT_LENGTH = 120;

function parseScent(value) {
  if (value === undefined || value === null) return null;
  const scent = String(value).trim().slice(0, MAX_SCENT_LENGTH);
  return scent === '' ? null : scent;
}

// Best Offer fields (2026-11-10): condition is the product's stated
// state — 'new' | 'used' | null (unspecified). The shop's standing
// disclosure is "All clothes are used unless specified as NEW", so
// null reads as used for display; the value only becomes load-bearing
// for offers: a product marked 'new' NEVER accepts offers (owner
// rule — new items sell at list price only). Input is forgiving on
// case ('New', 'USED' store lowercase); anything else is a 400.
function parseCondition(value) {
  if (value === undefined || value === null || value === '') return null;
  const condition = String(value).trim().toLowerCase();
  if (condition === 'new' || condition === 'used') return condition;
  fail(400, 'condition must be "new" or "used"');
  return null;
}

// acceptsOffers flag: the admin's explicit on/off for Best Offer.
// Stored as 1 / 0 / NULL — NULL means "no explicit choice", and
// rowToProduct (db.js) applies the default (ON for priced items
// that are not marked new). Boolean-ish input like freeShipping's:
// true / 1 / '1' / 'true' -> 1, false / 0 / '0' / 'false' -> 0,
// absent -> null; anything else is a 400.
function parseAcceptsOffers(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  fail(400, 'acceptsOffers must be true or false');
  return null;
}

function parseTile(value) {
  let tile = value;
  if (typeof tile === 'string') {
    try { tile = JSON.parse(tile); } catch { tile = null; }
  }
  if (
    Array.isArray(tile) && tile.length === 2 &&
    tile.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))
  ) {
    return tile;
  }
  return DEFAULT_TILE;
}

/**
 * Normalize + validate a product coming from the admin form (multipart
 * fields arrive as strings; JSON bodies arrive typed — both are handled
 * here). Data honesty rule: price stays null ("TBD") when the admin
 * leaves it empty. Nothing is invented for it.
 *
 * Clothing model (2026-11-09): the product kind is the CATEGORY now;
 * `type` is an optional free-text style note and is never required —
 * a 'test-item' needs nothing beyond name + price. Brand, sizes and
 * scent are the clothing/fragrance fields. The retired smoke-shop
 * fields (thc, strength, effects, unit) are still ACCEPTED and stored
 * when explicitly sent — old rows and old clients keep working — but
 * validation never requires them and never derives one from another
 * (the old "strength = <thc>% THC" invention is gone).
 */
export function normalizeProduct(body, existing) {
  const base = existing || {};
  const pick = (field) => (body[field] !== undefined ? body[field] : base[field]);

  const name = String(pick('name') || '').trim();
  if (!name) fail(400, 'name is required');

  const category = String(pick('category') || '').trim();
  if (!CATEGORIES.includes(category)) {
    fail(400, `category must be one of: ${CATEGORIES.join(', ')}`);
  }

  // Optional since the clothing conversion: the category carries the
  // kind. Stored as '' when absent (the column is NOT NULL).
  const type = String(pick('type') || '').trim();

  const price = parseOptionalNumber(pick('price'), 'price');
  if (price !== null && price < 0) fail(400, 'price must be zero or greater');

  const thc = parseOptionalNumber(pick('thc'), 'thc');
  if (thc !== null && (thc < 0 || thc > 100)) fail(400, 'thc must be between 0 and 100');

  // Retired-field pass-through: an explicit strength label is kept
  // exactly as sent; nothing is derived from thc any more, and an
  // unset strength is just ''.
  const strength = String(pick('strength') || '').trim();

  const unitInput = pick('unit');
  const unit = unitInput === undefined || unitInput === null || String(unitInput).trim() === ''
    ? null
    : String(unitInput).trim();

  return {
    name,
    subtitle: String(pick('subtitle') || '').trim(),
    category,
    type,
    thc,
    strength,
    price,
    unit,
    effects: parseEffects(pick('effects')),
    tile: parseTile(pick('tile')),
    image: pick('image') !== undefined ? pick('image') : (base.image || null),
    weightOz: parseShippingMeasure(pick('weightOz'), 'weightOz', 1120),
    lengthIn: parseShippingMeasure(pick('lengthIn'), 'lengthIn', 108),
    widthIn: parseShippingMeasure(pick('widthIn'), 'widthIn', 108),
    heightIn: parseShippingMeasure(pick('heightIn'), 'heightIn', 108),
    stockQty: parseStockInteger(pick('stockQty'), 'stockQty', MAX_STOCK_QTY),
    lowStockThreshold: parseStockInteger(pick('lowStockThreshold'), 'lowStockThreshold', MAX_STOCK_QTY),
    freeShipping: parseFreeShipping(pick('freeShipping')),
    brand: parseBrand(pick('brand')),
    sizes: parseSizes(pick('sizes')),
    scent: parseScent(pick('scent')),
    // Best Offer (2026-11-10): condition round-trips raw ('new' /
    // 'used' / null). acceptsOffers falls back to the existing
    // product's COMPUTED boolean on update (rowToProduct's shape) —
    // true/false map back to the stored 1/0, so an unrelated edit
    // preserves the owner's choice; the one lossy corner is a
    // price-TBD product whose flag was never set (computed false
    // stores 0), which matches what every client displays anyway.
    condition: parseCondition(pick('condition')),
    acceptsOffers: parseAcceptsOffers(pick('acceptsOffers')),
  };
}

/**
 * Validate + normalize an incoming order. Prices and totals are recomputed
 * from the catalog — a client cannot name its own prices — and the shop's
 * standing rule is enforced server-side too: a product whose price is null
 * ("Price TBD") can never be ordered. Payment card data is reduced to its
 * last four digits; the full number, expiry and CVV are never stored.
 *
 * `getProductById` is the D1 lookup (db.js getProduct) — the only change
 * from the Node version, where the in-memory store lookup was synchronous.
 *
 * Shipping (2026-11-09, buyer-paid USPS live rates): the optional third
 * argument `quoteShippingFn(entries, destZip)` is _lib/shipping.js's
 * quoteShipping bound to the request env by the route. When it reports
 * USPS is configured, the order MUST name a `shippingService` from the
 * body; the price is taken from a fresh server-side re-quote of that
 * service — any amount the client sends is ignored. When USPS is not
 * configured (or no quote function is supplied), shipping fields are
 * ignored and shipping is 0, exactly as before this feature. Tax stays
 * on the merchandise subtotal only — shipping is never taxed — and the
 * total is subtotal + tax + shipping.
 */
export async function normalizeOrder(body, getProductById, quoteShippingFn) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) fail(400, 'Order must contain at least one item.');

  const items = [];
  const entries = [];
  for (const raw of rawItems) {
    const productId = raw ? (raw.productId !== undefined ? raw.productId : raw.id) : undefined;
    // eslint-disable-next-line no-await-in-loop
    const product = await getProductById(productId);
    if (!product) fail(400, `Unknown product in order (id: ${productId}).`);
    if (product.price === null || product.price === undefined) {
      fail(400, `"${product.name}" cannot be ordered yet — its price is TBD.`);
    }
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      fail(400, `Quantity for "${product.name}" must be a whole number between 1 and 10.`);
    }
    // Inventory gate (2026-11-09): a TRACKED product (stockQty set)
    // can never be ordered past its count. This is a placement-time
    // check only — the count itself is decremented at the payment
    // commit point (see _lib/inventory.js). Untracked products
    // (stockQty null) skip this entirely, as they always have.
    if (product.stockQty !== null && product.stockQty !== undefined && qty > product.stockQty) {
      fail(400, `"${product.name}" only has ${product.stockQty} left.`);
    }
    // Clothing sizes (2026-11-09): when the product HAS a size run,
    // the buyer's chosen size is snapshotted onto the order item so
    // the shop knows which size to pull. A size the product does not
    // offer is a 400 — the client cannot invent one. Products with
    // no size run ignore any sent size (one-size items). Stock stays
    // per-PRODUCT across sizes (see docs/CLOTHING.md).
    const productSizes = Array.isArray(product.sizes) ? product.sizes : [];
    let size = null;
    if (productSizes.length > 0) {
      const wanted = raw && raw.size != null ? String(raw.size).trim() : '';
      if (wanted) {
        if (!productSizes.includes(wanted)) {
          fail(400, `"${product.name}" is not offered in size "${wanted}".`);
        }
        size = wanted;
      }
    }
    const unitPrice = round2(product.price);
    items.push({
      productId: product.id,
      name: product.name,
      qty,
      unitPrice,
      lineTotal: round2(unitPrice * qty),
      ...(size ? { size } : {}),
    });
    entries.push({ product, qty });
  }

  const customer = body.customer || body.delivery || {};
  for (const field of ['fullName', 'phone', 'address', 'city', 'zip']) {
    if (!String(customer[field] || '').trim()) fail(400, `Customer ${field} is required.`);
  }

  const subtotal = round2(items.reduce((sum, i) => sum + i.lineTotal, 0));
  const tax = round2(subtotal * TAX_RATE);

  // ----- Shipping -------------------------------------------------------------
  // Shipping money is INTEGER CENTS (shippingCents) while subtotal/tax/
  // total are dollars — the conversion to dollars happens exactly once,
  // in the total below, and is commented there.
  let shippingCents = 0;
  let shippingService = null;
  let shippingLabel = null;
  let shippingWeightOz = null;
  const requestedService =
    body.shippingService !== undefined && body.shippingService !== null && body.shippingService !== ''
      ? String(body.shippingService)
      : null;
  const destZip = String(customer.zip || '').trim().slice(0, 5);
  if (requestedService && !/^\d{5}$/.test(destZip)) {
    fail(400, 'A valid 5-digit ZIP code is required to ship this order.');
  }
  if (typeof quoteShippingFn === 'function') {
    const quote = await quoteShippingFn(entries, destZip);
    if (quote && quote.configured) {
      if (!/^\d{5}$/.test(destZip)) {
        fail(400, 'A valid 5-digit ZIP code is required to ship this order.');
      }
      if (!requestedService) {
        fail(400, 'Please choose a shipping option for this order.');
      }
      // Re-quote wins: the stored price is the one USPS (or the flat
      // fallback) returned for this service just now, never a
      // client-supplied amount. 'standard' is only present in the
      // options when USPS itself failed and the fallback was offered.
      const chosen = (quote.options || []).find((o) => o.service === requestedService);
      if (!chosen) {
        fail(400, `Shipping option "${requestedService}" is not available for this order.`);
      }
      shippingCents = Math.round(Number(chosen.priceCents)) || 0;
      shippingService = chosen.service;
      shippingLabel = chosen.label || null;
      shippingWeightOz = quote.weightOz != null ? Number(quote.weightOz) : null;
    }
  }

  let payment = null;
  const cardDigits = body.payment && body.payment.cardNumber
    ? String(body.payment.cardNumber).replace(/\D/g, '')
    : '';
  if (cardDigits) payment = { method: 'card', last4: cardDigits.slice(-4) };

  return {
    items,
    subtotal,
    tax,
    // shippingCents (cents) -> dollars at this single boundary.
    total: round2(subtotal + tax + shippingCents / 100),
    shippingCents,
    shippingService,
    shippingLabel,
    shippingWeightOz,
    customer: {
      fullName: String(customer.fullName).trim(),
      phone: String(customer.phone).trim(),
      address: String(customer.address).trim(),
      city: String(customer.city).trim(),
      zip: String(customer.zip).trim(),
      notes: String(customer.notes || '').trim(),
    },
    payment,
  };
}
