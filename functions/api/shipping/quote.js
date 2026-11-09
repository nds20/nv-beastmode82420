// POST /api/shipping/quote — public shipping quote for the checkout
// page (buyer-paid USPS live rates, 2026-11-09). The checkout calls
// this once the buyer has entered a 5-digit ZIP, renders the returned
// options as radio choices, and sends back only the chosen `service`
// id when placing the order — order placement re-quotes server-side
// (see _lib/validate.js), so a price shown here is never trusted as
// the charged price.
//
// Body: { items: [{ productId | id, qty }], zip }
// Returns: { configured, options: [{ service, label, priceCents }],
//            weightOz }
// When USPS is not configured this is { configured: false,
// options: [] } and checkout behaves exactly as it did before.
// Price-TBD products MAY be quoted (a quote sells nothing — placement
// still blocks them); unknown products, bad quantities and bad ZIPs
// are 400s.

import { handle, json, fail } from '../_lib/http.js';
import { getProduct } from '../_lib/db.js';
import { quoteShipping } from '../_lib/shipping.js';

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await request.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? body : {};

  const rawItems = Array.isArray(data.items) ? data.items : [];
  if (rawItems.length === 0) fail(400, 'Quote must contain at least one item.');

  const zip = String(data.zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) fail(400, 'A valid 5-digit ZIP code is required for a shipping quote.');

  const entries = [];
  for (const raw of rawItems) {
    const productId = raw ? (raw.productId !== undefined ? raw.productId : raw.id) : undefined;
    // eslint-disable-next-line no-await-in-loop
    const product = await getProduct(env, productId);
    if (!product) fail(400, `Unknown product in quote (id: ${productId}).`);
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      fail(400, `Quantity for "${product.name}" must be a whole number between 1 and 10.`);
    }
    entries.push({ product, qty });
  }

  const quote = await quoteShipping(env, entries, zip);
  return json({
    configured: quote.configured,
    options: quote.options.map((o) => ({
      service: o.service,
      label: o.label,
      priceCents: o.priceCents,
    })),
    weightOz: quote.weightOz,
  });
});
