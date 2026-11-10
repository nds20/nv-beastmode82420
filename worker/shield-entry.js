/*
 * 824 Shield entry point for Smoke Shop 824.
 *
 * Wraps the shop Worker (./index.js) with 824 Shield
 * (https://github.com/nds20/824-shield, GPLv3, vendored under
 * ./shield/ by the copyright holder): every /api/* request is scored
 * for prompt injection, classic cyber exploits, vulnerability
 * probes, bot signals, and floods before the shop sees it, and every
 * response gains defensive headers. wrangler.toml's `main` points
 * here; reverting that one line restores the unwrapped Worker.
 *
 * Multipart bodies (admin product-photo uploads to R2) are never
 * payload-scanned: they are large, binary, and handled by the
 * dedicated photo route.
 */

import appWorker from './index.js';
import { Shield } from './shield/guard.js';
import { applySecurityHeaders } from './shield/headers.js';
import { logError } from '../functions/api/_lib/errorLog.js';

const shield = new Shield({
  // Generous for real storefront traffic (pages fan out into many
  // asset and API calls); floods still drain the bucket and block.
  rate: { capacity: 120, refillPerSec: 2 },
  onDecision: (decision) => {
    if (decision.action !== 'allow') console.warn('[824-shield]', JSON.stringify(decision));
  },
});

const appFetch = appWorker.fetch.bind(appWorker);

async function shieldedFetch(request, env, ctx) {
  const contentType = request.headers.get('content-type') || '';
  let bodyText = '';
  if (['POST', 'PUT', 'PATCH'].includes(request.method) && !contentType.includes('multipart/form-data')) {
    try { bodyText = await request.clone().text(); } catch { bodyText = ''; }
  }
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  const decision = shield.evaluate({
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    method: request.method,
    path: new URL(request.url).pathname,
    headers,
    bodyText,
  });

  if (decision.action === 'block') {
    // Error Logs (2026-11-10, docs/ERROR_LOGS.md): every Shield BLOCK
    // also lands in the error_logs table (source 'shield'), so "is
    // Shield too strong?" is answerable from facts — the reasons and
    // scores of every block, next to the server/client rows. The
    // write is best-effort with the airlock's never-break discipline
    // (logError swallows its own failures); the 403 response below is
    // byte-identical to before. onDecision's console.warn above
    // stays as the live-tail copy.
    const logged = logError(env, {
      source: 'shield',
      requestId: crypto.randomUUID(),
      method: decision.method,
      path: decision.path,
      status: 403,
      errorName: 'ShieldBlock',
      errorMessage: (decision.reasons || []).join('; '),
      detail: decision.scores || {},
      actor: 'anon',
      userAgent: request.headers.get('user-agent') || '',
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      try {
        ctx.waitUntil(logged);
      } catch {
        await logged;
      }
    } else {
      await logged;
    }
    return new Response(
      JSON.stringify({ error: 'Request blocked by 824 Shield.', reasons: decision.reasons }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const response = await appFetch(request, env, ctx);
  if (decision.action === 'challenge') {
    const flagged = new Response(response.body, response);
    flagged.headers.set('X-824-Shield', 'challenge');
    return applySecurityHeaders(flagged);
  }
  return applySecurityHeaders(response);
}

export default { ...appWorker, fetch: shieldedFetch };
