// POST /api/offers/:id/pay — an ACCEPTED offer's buyer completes
// the purchase (Best Offer, 2026-11-10 — docs/OFFERS.md).
//
// Authorization: the offer's per-offer access token in the JSON body
// ({ accessToken }, or { token } — the checkout endpoint's pattern),
// timing-safe compared. Only an 'accepted' offer with no order yet
// can be paid.
//
// The order is minted by the REAL order path — normalizeOrder +
// createOrder, the same internals POST /api/orders uses — with a
// single item (qty 1, the offer's size) and ONE override: the
// product's price is replaced by the STORED offer amount for this
// call only. The override comes from the offers row, never from the
// request body, so a client cannot name its own price; tax (10.2%
// on the offered subtotal only), the stock gate and the server-side
// shipping re-quote all run exactly as they do for a normal order
// (an unknown shippingService is the same 400; a tracked product
// that has since sold out fails placement naming availability).
//
// Payment, mirroring POST /api/orders:
//   - Demo card in the body: placement is the commit point — stock
//     is applied via applyOrderInventory and the offer flips to
//     'paid' immediately.
//   - No payment (Stripe): the order returns unpaid with its own
//     accessToken; the buyer continues to POST
//     /api/orders/:id/checkout as usual, and the Stripe webhook
//     flips this offer to 'paid' when the money lands
//     (markOfferPaidByOrderId).
// The response is the created order, byte-for-byte the POST
// /api/orders shape (accessToken included).

import { handle, json, fail, numericId } from '../../_lib/http.js';
import { getOffer, updateOffer, getProduct, createOrder } from '../../_lib/db.js';
import { timingSafeStringEqual } from '../../_lib/auth.js';
import { normalizeOrder } from '../../_lib/validate.js';
import { quoteShipping } from '../../_lib/shipping.js';
import { applyOrderInventory } from '../../_lib/inventory.js';
import { sendOrderPlacedEmails, sendOrderPaidEmail } from '../../_lib/mail.js';

export const onRequestPost = handle(async ({ request, env, params }) => {
  const id = numericId(params.id);
  const offer = id === null ? null : await getOffer(env, id);
  if (!offer) fail(404, 'Offer not found');

  const body = await request.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? body : {};
  const token = data.accessToken
    ? String(data.accessToken)
    : data.token
      ? String(data.token)
      : '';
  if (!offer.accessToken || !timingSafeStringEqual(token, offer.accessToken)) {
    fail(403, 'A valid offer access token is required to pay for this offer.');
  }
  if (offer.status !== 'accepted') {
    fail(
      409,
      offer.status === 'pending'
        ? "This offer hasn't been accepted yet — the seller is still deciding."
        : `This offer is ${offer.status} and can't be paid.`
    );
  }
  if (offer.orderId) {
    fail(409, `This offer was already completed — see order #${offer.orderId}.`);
  }

  // The price override: for THIS normalizeOrder call, the offer's
  // product reads at the offered price (stored cents -> dollars).
  // Every other product id resolves normally (there is only the one
  // item, but the wrapper stays honest if that ever changes).
  const offerPrice = offer.offerCents / 100;
  const getWithOfferPrice = async (productId) => {
    const product = await getProduct(env, productId);
    if (product && Number(product.id) === Number(offer.productId)) {
      return { ...product, price: offerPrice };
    }
    return product;
  };

  const orderData = await normalizeOrder(
    {
      items: [
        {
          productId: offer.productId,
          qty: 1,
          ...(offer.size ? { size: offer.size } : {}),
        },
      ],
      customer: {
        ...(data.customer || {}),
        // Email (2026-11-10, docs/EMAIL.md): the order's customer
        // block carries the OFFER's buyer email — the address the
        // buyer gave with the offer — so the order confirmation
        // reaches them. It wins over any email in the pay body: the
        // offer's address is the one tied to this purchase.
        email: offer.buyerEmail,
      },
      ...(data.shippingService !== undefined
        ? { shippingService: data.shippingService }
        : {}),
      ...(data.payment !== undefined ? { payment: data.payment } : {}),
    },
    getWithOfferPrice,
    (entries, destZip) => quoteShipping(env, entries, destZip)
  );

  let order = await createOrder(env, orderData);
  await updateOffer(env, offer.id, { orderId: order.id });

  // Demo-card commit point (mirrors POST /api/orders): the order
  // carries demo payment, so placement IS the payment — apply stock
  // once and mark the offer paid. Stripe-path orders carry no
  // payment here and leave the offer 'accepted' until the webhook.
  if (order.payment) {
    order = await applyOrderInventory(env, order);
    await updateOffer(env, offer.id, { status: 'paid' });
  }
  // Email notifications (2026-11-10, docs/EMAIL.md): this endpoint
  // mints the order itself rather than going through POST
  // /api/orders, so the placed pair fires HERE — exactly once (the
  // orders handler is not also invoked). The buyer's confirmation
  // goes to the offer's email, injected into the order above. A
  // demo-card pay is a payment commit, so the admin's PAID alert
  // fires too; a Stripe pay leaves that to the webhook.
  await sendOrderPlacedEmails(env, order);
  if (order.payment) {
    await sendOrderPaidEmail(env, order);
  }
  return json(order, 201);
});
