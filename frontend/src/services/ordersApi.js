// Public orders client — posts a placed order to the shop API.
// (Ported from the live shop, with one addition: when a customer is
// signed in, their token rides along so the order is stamped with
// their account id and shows up under GET /api/customers/orders.)
//
// If submission fails (e.g. a static deploy with no API behind it), the
// order is kept in a local "pending" list in localStorage and checkout
// continues exactly as before — the customer always gets their
// confirmation; the order just isn't sent.

import { getCustomerToken } from './customersApi';

const PENDING_KEY = 'smokeshop_pending_orders';

export async function submitOrder(order) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getCustomerToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(order),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Order submission failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

export function queuePendingOrder(order) {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const pending = raw ? JSON.parse(raw) : [];
    pending.push({ queuedAt: new Date().toISOString(), order });
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage unavailable (private mode, quota) — nothing more we can do;
    // checkout must still complete for the customer.
  }
}

export function getPendingOrders() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ----- Shipping quotes -----------------------------------------------------
// POST /api/shipping/quote prices the cart for the buyer's ZIP using
// live USPS rates (buyer-paid shipping, 2026-11-09). The response is
// { configured, options: [{ service, label, priceCents }], weightOz }.
// When the server has no USPS credentials, configured is false and
// checkout shows no shipping UI at all — the shop behaves as before.
// Placing the order sends back only the chosen service id; the server
// re-quotes and charges its own price, never the one displayed here.

export async function fetchShippingQuote(items, zip) {
  const response = await fetch('/api/shipping/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, zip }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Shipping quote failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

// ----- Stripe payments -------------------------------------------------------
// When the server has a Stripe key configured, placing an order is
// followed by a hosted Stripe Checkout redirect; the order's accessToken
// (issued in the POST /api/orders response) authorizes both starting the
// payment and reading that one order's status afterwards. When Stripe is
// not configured, fetchPaymentsConfig reports stripeEnabled: false and
// checkout stays in demo mode — nothing below is called.

export async function fetchPaymentsConfig() {
  const response = await fetch('/api/payments/config');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Payments config failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function createCheckoutSession(orderId, accessToken) {
  const response = await fetch(`/api/orders/${orderId}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Could not start payment (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function fetchOrderStatus(orderId, accessToken) {
  const response = await fetch(
    `/api/orders/${orderId}/status?token=${encodeURIComponent(accessToken)}`
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Order status failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return data;
}
