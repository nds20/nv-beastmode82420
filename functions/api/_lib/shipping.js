// Shipping math + quoting shared by POST /api/shipping/quote and by
// order placement (functions/api/orders.js via _lib/validate.js).
//
// Rules (owner direction 2026-11-09 — buyer-paid, USPS live rates):
//   * Rates come from the USPS Prices API (see _lib/usps.js) and are
//     re-quoted SERVER-side at order time; a price the client sends is
//     never trusted.
//   * Products carry optional weight/dimensions (admin-set). Anything
//     unset falls back to the defaults below — a product with no
//     weight ships at DEFAULT_WEIGHT_OZ, a product with no dimensions
//     at the default parcel size — so the catalog works before the
//     admin has measured anything, and the fallback is visible here
//     rather than invented per product.
//   * When USPS is not configured at all, quoting answers
//     { configured: false, options: [] } and orders charge $0
//     shipping — the shop behaves exactly as it did before this
//     feature existed.
//   * When USPS IS configured but unreachable at quote time, the shop
//     offers ONE flat-rate fallback (FALLBACK_FLAT_CENTS) instead of
//     blocking the sale.

import { uspsConfigured, quoteUspsRates } from './usps.js';

// A product with no admin-set weight ships as a 1 lb item.
export const DEFAULT_WEIGHT_OZ = 16;

// Default parcel dimensions (inches) used per-dimension when a
// product has none set: a modest 12 x 9 x 6 box.
export const DEFAULT_LENGTH_IN = 12;
export const DEFAULT_WIDTH_IN = 9;
export const DEFAULT_HEIGHT_IN = 6;

// Flat-rate fallback offered when USPS is configured but its Prices
// API cannot be reached: $8.99. One constant, one place to change it.
export const FALLBACK_FLAT_CENTS = 899;

export const FALLBACK_OPTION = {
  service: 'standard',
  label: 'Standard shipping (flat rate)',
  priceCents: FALLBACK_FLAT_CENTS,
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Turn [{ product, qty }] entries (products as rowToProduct shapes)
 * into the single parcel the order ships as:
 *   weightOz  total ounces (product weight or DEFAULT_WEIGHT_OZ, x qty)
 *   weightLb  the same weight in pounds, rounded UP to the next 0.1 lb
 *             (USPS bills by weight steps; min 0.1 lb)
 *   length/width/height  the largest item dimension in each axis —
 *             an item with no dimension set uses the default box size
 *             for that axis.
 */
export function computePackage(entries) {
  let weightOz = 0;
  let lengthIn = 0;
  let widthIn = 0;
  let heightIn = 0;
  for (const { product, qty } of entries) {
    const oz = Number(product && product.weightOz) > 0 ? Number(product.weightOz) : DEFAULT_WEIGHT_OZ;
    weightOz += oz * qty;
    lengthIn = Math.max(lengthIn, Number(product && product.lengthIn) > 0 ? Number(product.lengthIn) : DEFAULT_LENGTH_IN);
    widthIn = Math.max(widthIn, Number(product && product.widthIn) > 0 ? Number(product.widthIn) : DEFAULT_WIDTH_IN);
    heightIn = Math.max(heightIn, Number(product && product.heightIn) > 0 ? Number(product.heightIn) : DEFAULT_HEIGHT_IN);
  }
  const weightLb = Math.max(0.1, Math.ceil((weightOz / 16) * 10) / 10);
  return { weightOz: round1(weightOz), weightLb, lengthIn, widthIn, heightIn };
}

/**
 * Quote the shipping options for a set of entries to a destination ZIP.
 * Returns:
 *   { configured: false, options: [], weightOz, weightLb }
 *     — USPS not configured; caller charges no shipping.
 *   { configured: true, options: [...], weightOz, weightLb }
 *     — live USPS options, or the single flat-rate fallback when the
 *       USPS call failed (the fallback option's service is 'standard').
 * Never throws for a USPS outage; callers may still validate the ZIP.
 */
export async function quoteShipping(env, entries, destZip) {
  const parcel = computePackage(entries);
  if (!uspsConfigured(env)) {
    return { configured: false, options: [], ...parcel };
  }
  try {
    const options = await quoteUspsRates(env, {
      destZip,
      weightLb: parcel.weightLb,
      length: parcel.lengthIn,
      width: parcel.widthIn,
      height: parcel.heightIn,
    });
    return { configured: true, options, ...parcel };
  } catch {
    return { configured: true, options: [{ ...FALLBACK_OPTION }], ...parcel };
  }
}
