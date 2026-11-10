// Worker entry point — the Cloudflare *Worker* packaging of the shop API.
//
// This deployment is a Worker with static assets, NOT a Pages project,
// so the Pages Functions in ../functions/ never execute here. This
// module is a thin adapter: it dispatches /api/* requests to the very
// same handler functions the Pages routes use — imported unchanged,
// since the route files' exported onRequest* handlers take the standard
// { request, env, params } context, which is exactly what the router
// below builds for them — and hands every other request to the static
// assets binding (the built React app in ./build).
//
// Route table (mirrors the files under ../functions/api/):
//   GET    /api/health
//   GET    /api/products                 POST /api/products           (admin)
//   GET    /api/products/:id             PUT  /api/products/:id       (admin)
//                                        DELETE /api/products/:id     (admin)
//   POST   /api/orders
//   POST   /api/shipping/quote                                (public)
//   POST   /api/orders/:id/checkout                             (order token)
//   GET    /api/orders/:id/status                               (order token)
//   GET    /api/orders/signal                    (public: latest paid order)
//   GET    /api/payments/config
//   POST   /api/donate/checkout         GET /api/donate/stats
//   POST   /api/stripe/webhook                                  (Stripe-signed)
//   POST   /api/customers/register
//   POST   /api/customers/login
//   GET    /api/customers/me                                          (customer)
//   GET    /api/customers/orders                                      (customer)
//   POST   /api/admin/login
//   GET    /api/admin/setup-status
//   POST   /api/admin/setup
//   POST   /api/admin/recovery/reset
//   GET    /api/admin/accounts            POST /api/admin/accounts   (owner)
//   DELETE /api/admin/accounts/:username                             (owner)
//   POST   /api/admin/accounts/change-password                       (admin)
//   GET    /api/admin/orders                                          (admin)
//   GET    /api/admin/orders/:id                                      (admin)
//   PATCH  /api/admin/orders/:id/seen                                 (admin)
//   PATCH  /api/admin/products/:id/stock                              (admin)
//   GET    /api/photos/<key...>  — uploaded photos, served from R2
//
// Configuration lives in ../wrangler.toml: the D1 (`DB`) and R2
// (`PRODUCT_PHOTOS`) bindings are declared there, so no manual
// dashboard binding setup is needed on this path. Setup steps are in
// ../cloudflare/README.md ("If your project is a Worker (not Pages)").

import { json } from '../functions/api/_lib/http.js';
import { onRequestGet as healthGet } from '../functions/api/health.js';
import {
  onRequestGet as productsList,
  onRequestPost as productsCreate,
} from '../functions/api/products.js';
import {
  onRequestGet as productGet,
  onRequestPut as productUpdate,
  onRequestDelete as productDelete,
} from '../functions/api/products/[id].js';
import { onRequestPost as orderCreate } from '../functions/api/orders.js';
import { onRequestPost as shippingQuote } from '../functions/api/shipping/quote.js';
import { onRequestPost as orderCheckout } from '../functions/api/orders/[id]/checkout.js';
import { onRequestGet as orderStatus } from '../functions/api/orders/[id]/status.js';
import { onRequestGet as orderSignal } from '../functions/api/orders/signal.js';
import { onRequestGet as paymentsConfig } from '../functions/api/payments/config.js';
import { onRequestPost as donateCheckout } from '../functions/api/donate/checkout.js';
import { onRequestGet as donateStats } from '../functions/api/donate/stats.js';
import { onRequestPost as stripeWebhook } from '../functions/api/stripe/webhook.js';
import { onRequestPost as customerRegister } from '../functions/api/customers/register.js';
import { onRequestPost as customerLogin } from '../functions/api/customers/login.js';
import { onRequestGet as customerMe } from '../functions/api/customers/me.js';
import { onRequestGet as customerOrders } from '../functions/api/customers/orders.js';
import { onRequestPost as adminLogin } from '../functions/api/admin/login.js';
import { onRequestGet as adminSetupStatus } from '../functions/api/admin/setup-status.js';
import { onRequestPost as adminSetup } from '../functions/api/admin/setup.js';
import { onRequestPost as adminRecoveryReset } from '../functions/api/admin/recovery/reset.js';
import {
  onRequestGet as adminAccountsList,
  onRequestPost as adminAccountsCreate,
} from '../functions/api/admin/accounts/index.js';
import { onRequestDelete as adminAccountDelete } from '../functions/api/admin/accounts/[username].js';
import { onRequestPost as adminChangePassword } from '../functions/api/admin/accounts/change-password.js';
import { onRequestGet as adminOrdersList } from '../functions/api/admin/orders.js';
import { onRequestGet as adminOrderGet } from '../functions/api/admin/orders/[id].js';
import { onRequestPatch as adminOrderSeen } from '../functions/api/admin/orders/[id]/seen.js';
import { onRequestPatch as adminProductStock } from '../functions/api/admin/products/[id]/stock.js';
import { onRequestGet as photoServe } from '../functions/api/photos/[[path]].js';

// Fixed routes; ":name" captures one path segment into params, exactly
// like the [name].js files do under Pages routing.
const ROUTES = [
  { parts: ['api', 'health'], handlers: { GET: healthGet } },
  { parts: ['api', 'products'], handlers: { GET: productsList, POST: productsCreate } },
  {
    parts: ['api', 'products', ':id'],
    handlers: { GET: productGet, PUT: productUpdate, DELETE: productDelete },
  },
  { parts: ['api', 'orders'], handlers: { POST: orderCreate } },
  { parts: ['api', 'shipping', 'quote'], handlers: { POST: shippingQuote } },
  { parts: ['api', 'orders', ':id', 'checkout'], handlers: { POST: orderCheckout } },
  { parts: ['api', 'orders', ':id', 'status'], handlers: { GET: orderStatus } },
  // The literal 'signal' route must precede nothing in particular —
  // it is a 3-segment path (orders/:id/* routes are 4) — listed here
  // beside the other orders routes for readability.
  { parts: ['api', 'orders', 'signal'], handlers: { GET: orderSignal } },
  { parts: ['api', 'payments', 'config'], handlers: { GET: paymentsConfig } },
  { parts: ['api', 'donate', 'checkout'], handlers: { POST: donateCheckout } },
  { parts: ['api', 'donate', 'stats'], handlers: { GET: donateStats } },
  { parts: ['api', 'stripe', 'webhook'], handlers: { POST: stripeWebhook } },
  { parts: ['api', 'customers', 'register'], handlers: { POST: customerRegister } },
  { parts: ['api', 'customers', 'login'], handlers: { POST: customerLogin } },
  { parts: ['api', 'customers', 'me'], handlers: { GET: customerMe } },
  { parts: ['api', 'customers', 'orders'], handlers: { GET: customerOrders } },
  { parts: ['api', 'admin', 'login'], handlers: { POST: adminLogin } },
  { parts: ['api', 'admin', 'setup-status'], handlers: { GET: adminSetupStatus } },
  { parts: ['api', 'admin', 'setup'], handlers: { POST: adminSetup } },
  { parts: ['api', 'admin', 'recovery', 'reset'], handlers: { POST: adminRecoveryReset } },
  { parts: ['api', 'admin', 'accounts'], handlers: { GET: adminAccountsList, POST: adminAccountsCreate } },
  // The literal 'change-password' route must precede ':username',
  // which would otherwise capture it.
  { parts: ['api', 'admin', 'accounts', 'change-password'], handlers: { POST: adminChangePassword } },
  { parts: ['api', 'admin', 'accounts', ':username'], handlers: { DELETE: adminAccountDelete } },
  { parts: ['api', 'admin', 'orders'], handlers: { GET: adminOrdersList } },
  { parts: ['api', 'admin', 'orders', ':id'], handlers: { GET: adminOrderGet } },
  { parts: ['api', 'admin', 'orders', ':id', 'seen'], handlers: { PATCH: adminOrderSeen } },
  { parts: ['api', 'admin', 'products', ':id', 'stock'], handlers: { PATCH: adminProductStock } },
];

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleApi(request, env, segments) {
  const method = request.method === 'HEAD' ? 'GET' : request.method;

  // Catch-all photos route — the [[path]].js of the Pages version:
  // params.path is the array of segments after /api/photos/.
  if (segments[1] === 'photos' && segments.length > 2) {
    if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return photoServe({ request, env, params: { path: segments.slice(2) } });
  }

  let pathMatched = false;
  for (const route of ROUTES) {
    if (route.parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.parts.length; i += 1) {
      const part = route.parts[i];
      if (part.startsWith(':')) params[part.slice(1)] = segments[i];
      else if (part !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    pathMatched = true;
    const handler = route.handlers[method];
    if (handler) return handler({ request, env, params });
  }
  // Same shape the Pages version produces: a known path with the wrong
  // method is a 405; an unknown /api path is a 404.
  if (pathMatched) return json({ error: 'Method not allowed' }, 405);
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const trimmed = pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
    const segments = trimmed.split('/').filter(Boolean).map(decodeSegment);

    if (segments[0] === 'api') {
      try {
        return await handleApi(request, env, segments);
      } catch (err) {
        // Backstop: most handlers are already wrapped by _lib/http's
        // handle(); this only catches the few that are not (health,
        // photos) so an /api/* request never leaks an HTML error page.
        console.error(err);
        return json({ error: 'Server error' }, 500);
      }
    }

    // Everything else is the static site (the React build in ./build).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
