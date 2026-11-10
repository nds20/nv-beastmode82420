// GET /api/products/photo-debug — ADMIN-ONLY product-photo storage
// diagnostics (2026-11-10). The owner-visible symptom this endpoint
// exists to explain: saving a product WITH a photo from the admin
// editor fails with a generic client message ("didn't get a usable
// answer back") while saving WITHOUT a photo works — i.e. the
// multipart PUT dies somewhere the normal JSON error handling never
// sees. This probe walks the exact storage path attachPhoto walks,
// in stages, and reports the first stage that breaks, INCLUDING the
// raw error name/message when the platform throws one:
//
//   env          — is the PRODUCT_PHOTOS binding present at runtime?
//   probe-put    — can we write a tiny text object to the bucket?
//   probe-get    — can we read it back?
//   probe-delete — cleanup so probes never accumulate.
//
// The probe object is a few dozen bytes under a diagnostics/ prefix;
// it is deleted in a finally block even when a stage fails. The
// response carries binding presence, per-stage outcomes, timings and
// error text only — never credentials. Admin-gated with requireAdmin
// (401 without a valid admin bearer token), like /api/shipping/debug.

import { handle, json } from '../_lib/http.js';
import { requireAdmin } from '../_lib/auth.js';

export const onRequestGet = handle(async (context) => {
  await requireAdmin(context);
  const { env } = context;

  const report = {
    bindingPresent: Boolean(env && env.PRODUCT_PHOTOS),
    bindingType: env && env.PRODUCT_PHOTOS ? typeof env.PRODUCT_PHOTOS : null,
    stages: [],
  };
  if (!report.bindingPresent) {
    report.conclusion =
      'PRODUCT_PHOTOS binding is ABSENT at runtime. The deployed Worker has no R2 bucket attached under that name — check the Worker\'s Settings > Bindings (a wrangler.toml change only takes effect when the deployment actually carries it).';
    return json(report);
  }

  const key = `diagnostics/photo-probe-${Date.now()}.txt`;
  const payload = `photo-debug probe ${new Date().toISOString()}`;
  const stage = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      report.stages.push({ stage: name, ok: true, ms: Date.now() - started, ...(detail || {}) });
      return true;
    } catch (err) {
      report.stages.push({
        stage: name,
        ok: false,
        ms: Date.now() - started,
        errorName: (err && err.name) || 'Error',
        errorMessage: String((err && err.message) || err).slice(0, 300),
      });
      return false;
    }
  };

  try {
    const putOk = await stage('probe-put', async () => {
      await env.PRODUCT_PHOTOS.put(key, payload, {
        httpMetadata: { contentType: 'text/plain' },
      });
      return { key };
    });
    if (putOk) {
      await stage('probe-get', async () => {
        const object = await env.PRODUCT_PHOTOS.get(key);
        if (!object) throw new Error('get returned null for the object just written');
        const text = await object.text();
        if (text !== payload) throw new Error('round-trip body mismatch');
        return { size: object.size };
      });
    }
  } finally {
    // Cleanup is best-effort and never masks the real result.
    try {
      await env.PRODUCT_PHOTOS.delete(key);
      report.stages.push({ stage: 'probe-delete', ok: true });
    } catch (err) {
      report.stages.push({
        stage: 'probe-delete',
        ok: false,
        errorMessage: String((err && err.message) || err).slice(0, 300),
      });
    }
  }

  const failed = report.stages.find((s) => !s.ok);
  report.conclusion = failed
    ? `Storage path breaks at stage "${failed.stage}": ${failed.errorMessage || 'see stages'}`
    : 'Storage path is healthy end-to-end (binding present, put/get/delete all succeed). The upload failure is then in the request path itself (body size / multipart handling), not in R2.';
  return json(report);
});
