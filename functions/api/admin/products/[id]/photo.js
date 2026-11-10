// POST /api/admin/products/:id/photo — ADMIN-ONLY photo-only update
// (2026-11-10). Runs the EXACT code path the editor's photo step
// needs — requireAdmin -> readProductInput (multipart parse + photo
// validation) -> assertPhotoStorage -> attachPhoto (R2 put + image
// update) — but answers with a stage-by-stage report instead of the
// bare product JSON, so when a phone photo save fails we can see
// WHICH stage breaks in production:
//
//   parse   — the multipart body was read; reports the photo's
//             name / type / size as the server received them.
//   store   — the R2 put + product image update completed.
//   verify  — the object was read back from the bucket (proves the
//             write is durable, not just accepted).
//
// Lives under /api/admin/products/:id/photo — the admin namespace,
// deliberately NOT /api/products/:id/photo: a bare /api/products
// POST route is reachable by Cloudflare's bot-management layer in
// a way this deployment's admin routes are not observed to be
// (see the investigation notes in docs/PRODUCT_EDITOR.md).
//
// Why this endpoint exists beyond diagnosis: the editor's photo
// step calls IT (not the generic PUT /api/products/:id) — same
// behavior, but a failure here returns { ok:false, stage, error }
// JSON with the real underlying message instead of letting the
// client guess. Success returns { ok:true, product } — the product
// exactly as attachPhoto produced it.
//
// Fields in the multipart body are ignored: the editor saves fields
// in its JSON step first; this endpoint is photo-only by contract.

import { handle, json } from '../../../_lib/http.js';
import { requireAdmin } from '../../../_lib/auth.js';
import { getProduct } from '../../../_lib/db.js';
import { readProductInput, assertPhotoStorage, attachPhoto } from '../../../_lib/photos.js';

export const onRequestPost = handle(async (context) => {
  await requireAdmin(context);
  const { env } = context;
  const product = await getProduct(env, context.params.id);
  if (!product) {
    return json({ ok: false, stage: 'lookup', error: 'Product not found' }, 404);
  }

  const stages = [];
  const failAt = (stageName, err, status = 500) => json(
    {
      ok: false,
      stage: stageName,
      error: String((err && err.message) || err).slice(0, 300),
      stages,
    },
    (err && err.status) || status
  );

  // Stage 1 — parse the multipart body exactly like the PUT does.
  let photo = null;
  try {
    const parsed = await readProductInput(context.request);
    photo = parsed.photo;
    stages.push({
      stage: 'parse',
      ok: true,
      photo: photo
        ? { name: photo.name, type: photo.type, size: photo.size }
        : null,
    });
  } catch (err) {
    return failAt('parse', err);
  }
  if (!photo) {
    return json(
      { ok: false, stage: 'parse', error: 'No photo file was received in the upload.', stages },
      400
    );
  }

  // Stage 2 — storage config + the put itself.
  let updated;
  try {
    assertPhotoStorage(env, photo);
    updated = await attachPhoto(env, product, photo);
    stages.push({ stage: 'store', ok: true, image: updated.image });
  } catch (err) {
    return failAt('store', err);
  }

  // Stage 3 — read the object back: the write must be durable.
  try {
    const key = String(updated.image || '').replace(/^\/api\/photos\//, '');
    const object = key ? await env.PRODUCT_PHOTOS.get(key) : null;
    if (!object) throw new Error(`read-back found no object at ${key || '(no key)'}`);
    stages.push({ stage: 'verify', ok: true, size: object.size });
  } catch (err) {
    return failAt('verify', err);
  }

  return json({ ok: true, product: updated, stages });
});
