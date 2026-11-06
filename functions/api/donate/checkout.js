// POST /api/donate/checkout — start a one-time donation to an 824
// project through Stripe-hosted Checkout (owner direction 2026-11-06).
//
// Body: { amountCents, project }. Amounts are integer cents, validated
// server-side in _lib/donations.js ($1–$10,000, no coercion); the
// project must be one of the listed slugs. Dormant by default: with no
// STRIPE_SECRET_KEY on the deployment this answers 501 and the hub
// shows the donate button disabled under its UNDER CONSTRUCTION tag —
// setting the key is the only switch, exactly like the FWB pattern.
// Success returns { url } and the browser redirects to Stripe; the
// gift itself is recorded later by the webhook, never here.

import { handle, json, fail } from '../_lib/http.js';
import { validateDonationInput } from '../_lib/donations.js';
import { createDonationCheckoutSession, stripeConfigured } from '../_lib/stripe.js';

export const onRequestPost = handle(async ({ request, env }) => {
  if (!stripeConfigured(env)) {
    fail(501, 'Donations are not open yet — Stripe is still being hooked up. Please check back very soon.');
  }
  const body = await request.json().catch(() => ({}));
  const { amountCents, project } = validateDonationInput(body);
  const origin = new URL(request.url).origin;
  const session = await createDonationCheckoutSession(env, { amountCents, project, origin });
  return json({ url: session.url });
});
