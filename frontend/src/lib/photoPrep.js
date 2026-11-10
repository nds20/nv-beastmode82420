// Phone-photo preparation for the admin product editor
// (frontend/src/services/adminApi.js calls preparePhotoForUpload
// before the photo step of a product save; docs/PRODUCT_EDITOR.md
// "Phone photos").
//
// Why this module exists (owner failure, live, 2026-11-10): a photo
// snapped on an iPhone is usually HEIC and several MB. The server
// (functions/api/_lib/photos.js) only accepts jpg/png/webp/gif/svg
// up to 10 MB, and a multi-MB upload from the phone kept dying
// mid-flight with a non-JSON edge answer (the editor's
// "bad-response") — while a 68-byte test image through the very
// same multipart path sailed through. So the photo is prepared IN
// THE BROWSER before upload: decoded, downscaled, and re-encoded
// as JPEG, small enough that the send itself is boring.
//
// THE SHRINK GUARANTEE (owner directive, 2026-11-10: "make the
// change for too large a picture to shrink it"): prep is no longer
// one hopeful pass. The encoder walks SHRINK_LADDER — smaller
// dimensions, lower quality — and stops at the first result at or
// under TARGET_UPLOAD_BYTES (~900 KB). If no step gets there, the
// SMALLEST result produced is what uploads: a shrunken photo that
// is merely bigger than the target still beats the original.
//
// THE FALLBACK CONTRACT (changed 2026-11-10): preparePhotoForUpload
// still NEVER throws. But it no longer always hands back the
// original file when prep fails. A giant original is exactly the
// file that dies in transit, so sending it anyway is not a
// fallback — it is the failure, repeated. When the original is
// larger than HARD_SEND_CAP (2 MB) and no decode/encode path
// produced a shrunken file, prep resolves with
// { uploadFile: null, tooLargeUnshrinkable: true, ... } and
// saveAdminProduct does NOT send anything; the editor shows the
// tooLargeUnshrinkable message (see photoFailureMessage) and the
// already-saved product details stay saved. When the original is
// at or under HARD_SEND_CAP and prep fails, the original is still
// returned as before — a file that size has always sent fine.
// Prep is skipped entirely for SVG and GIF (vector/animation would
// be destroyed by a raster re-encode).
//
// Decode tries createImageBitmap with EXIF orientation applied
// ('from-image') first, then a plain bitmap, then an <img> element
// fed by an object URL (the path that works where createImageBitmap
// is missing or refuses the file — some mobile browsers); the
// object URL is revoked after use. Orientation on the fallback
// paths is the platform decoder's business — prep never blocks
// on it.
//
// The pure helpers (isHeicFile, shouldAttemptPrep,
// targetDimensions, jpegFileName, SHRINK_LADDER /
// chooseShrinkResult, photoFailureMessage) are node-tested by
// scripts/test-photo-prep.mjs; the canvas path itself is
// browser-only.

// Mirrors MAX_PHOTO_BYTES in functions/api/_lib/photos.js.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Longest-side cap for the first (best-quality) ladder step, px.
export const MAX_PHOTO_DIMENSION = 1600;

// Files at or under this size (and not HEIC) upload as-is: they are
// already cheap to send, and leaving them untouched preserves PNG
// transparency and encoder details a JPEG re-encode would flatten.
// Lowered from 1 MB (2026-11-10): everything bigger than this gets
// the guaranteed-shrink treatment below.
export const PREP_MIN_BYTES = 256 * 1024;

// The shrink aims here: a prepared upload at or under ~900 KB has
// repeatedly proven to send cleanly from the owner's phone, where
// multi-MB originals kept dying in transit.
export const TARGET_UPLOAD_BYTES = 900 * 1000;

// Above this size, an unshrinkable original is NOT sent at all
// (see the fallback contract in the header): 2 MB is where phone
// uploads of originals have proven unreliable, and a file this
// big that the device itself could not shrink needs the owner's
// help (a smaller copy), not another doomed send.
export const HARD_SEND_CAP = 2 * 1024 * 1024;

// The shrink ladder, in the order the encoder tries it: each step
// caps the longest side lower and encodes at lower quality than
// the one before. Pure data — node-tested.
export const SHRINK_LADDER = [
  { maxDim: MAX_PHOTO_DIMENSION, quality: 0.85 },
  { maxDim: 1200, quality: 0.8 },
  { maxDim: 900, quality: 0.75 },
  { maxDim: 700, quality: 0.7 },
];

function extensionOf(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot === -1 ? '' : s.slice(dot).toLowerCase();
}

/** iPhone HEIC/HEIF, by extension (.heic/.heif) or content type. */
export function isHeicFile(file) {
  if (!file) return false;
  const ext = extensionOf(file.name);
  if (ext === '.heic' || ext === '.heif') return true;
  const type = String(file.type || '').toLowerCase();
  return type.startsWith('image/heic') || type.startsWith('image/heif');
}

/** SVG and GIF pass through untouched — never rasterize them. */
export function isPassthroughPhoto(file) {
  if (!file) return false;
  const ext = extensionOf(file.name);
  if (ext === '.svg' || ext === '.gif') return true;
  const type = String(file.type || '').toLowerCase();
  return type === 'image/svg+xml' || type === 'image/gif';
}

/**
 * Is browser prep worth attempting for this file? True for HEIC at
 * any size (the server rejects the .heic extension outright, so
 * conversion is the only path) and for image files over
 * PREP_MIN_BYTES (the ones whose upload can stall or fail). False
 * for passthrough formats, non-images, and small files.
 */
export function shouldAttemptPrep(file) {
  if (!file) return false;
  if (isPassthroughPhoto(file)) return false;
  if (isHeicFile(file)) return true;
  const type = String(file.type || '');
  if (type && !type.startsWith('image/')) return false;
  return Number(file.size || 0) > PREP_MIN_BYTES;
}

/**
 * Scale (width, height) so the longest side is at most `max`,
 * preserving aspect ratio. Never upscales; non-positive input comes
 * back as-is for the caller to reject.
 */
export function targetDimensions(width, height, max = MAX_PHOTO_DIMENSION) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return { width: w, height: h };
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** 'IMG_4132.HEIC' -> 'IMG_4132.jpg' — the upload's name as a JPEG. */
export function jpegFileName(name) {
  const base = String(name || 'photo').replace(/\.[^.]*$/, '');
  return `${base || 'photo'}.jpg`;
}

/**
 * Pick which ladder encode (if any) should be uploaded, from the
 * results the encoder produced — each an object carrying at least
 * a byte `size`, in ladder order. Pure — node-tested.
 *
 * Rules:
 *   - an original already at/under target needs no rescue: only an
 *     encode that is BOTH under target and smaller than the
 *     original beats it (the smallest such encode wins); otherwise
 *     null — send the original.
 *   - an original over target (or an HEIC, whose original can never
 *     be sent at all): the FIRST encode at/under target wins; if
 *     none reached target, the smallest encode wins — a shrink
 *     that merely helps still beats the original.
 *   - except: for a non-HEIC original, an encode that came out no
 *     smaller than the original is never an improvement — if the
 *     smallest encode is still >= the original, null (no useful
 *     shrink was produced).
 */
export function chooseShrinkResult(results, options = {}) {
  const target = Number(options.target || TARGET_UPLOAD_BYTES);
  const originalBytes = Number(options.originalBytes || 0);
  const heic = Boolean(options.heic);
  const usable = (Array.isArray(results) ? results : []).filter(
    (r) => r && Number(r.size) > 0
  );
  if (!usable.length) return null;

  if (!heic && originalBytes > 0 && originalBytes <= target) {
    const better = usable.filter(
      (r) => Number(r.size) <= target && Number(r.size) < originalBytes
    );
    if (!better.length) return null;
    return better.reduce((a, b) => (Number(b.size) < Number(a.size) ? b : a));
  }

  const underTarget = usable.find((r) => Number(r.size) <= target);
  if (underTarget) return underTarget;
  const smallest = usable.reduce((a, b) =>
    Number(b.size) < Number(a.size) ? b : a
  );
  if (!heic && originalBytes > 0 && Number(smallest.size) >= originalBytes) {
    return null;
  }
  return smallest;
}

/**
 * The truthful one-liner for a failed photo step, mapped from what
 * actually happened (assembled by saveAdminProduct into
 * err.photoFailure; rendered by ProductEditor above its saved-details
 * suffix). Pure — node-tested.
 *
 * info: {
 *   serverMessage,        // the server's own { error } text, when it sent one
 *   code,                 // 'network' | 'bad-response' |
 *                         // 'too-large-unshrinkable' | '' from adminFetch/prep
 *   tooLargeUnshrinkable, // prep produced nothing sendable for a
 *                         // giant original, so nothing was sent
 *   heicUnconverted,      // original was HEIC and prep could not decode it
 *   uploadBytes,          // size of the file that was (or would be) uploaded
 *   maxBytes,             // the server's cap (MAX_PHOTO_BYTES)
 * }
 *
 * A server JSON error is the most specific truth there is, so it
 * wins verbatim. The too-large-unshrinkable case is next: prep
 * itself reported it, before any network was involved. The
 * friendly cases only replace the old bare "server could not be
 * reached" for failures where the server never got a usable word
 * in.
 */
export function photoFailureMessage(info = {}) {
  const maxBytes = info.maxBytes || MAX_PHOTO_BYTES;
  if (info.serverMessage) return info.serverMessage;
  if (info.tooLargeUnshrinkable || info.code === 'too-large-unshrinkable') {
    return (
      "That photo is very large, and this device couldn't shrink it " +
      'to a sendable size. Try picking a smaller copy of the photo, ' +
      'taking a screenshot of it, or exporting it as a JPEG — then ' +
      'save again.'
    );
  }
  if (info.heicUnconverted) {
    return (
      "That photo looks like an iPhone HEIC photo, and this browser couldn't " +
      'convert it to a regular JPEG. Try picking the photo again — or open it ' +
      'in Photos and share/export it as a JPEG — or switch Settings → Camera ' +
      '→ Formats to "Most Compatible" so new photos are JPEGs.'
    );
  }
  if (Number(info.uploadBytes || 0) > maxBytes) {
    const mb = (Number(info.uploadBytes) / (1024 * 1024)).toFixed(1);
    return (
      `That photo is ${mb} MB — over the ${Math.round(maxBytes / (1024 * 1024))} MB ` +
      'limit even after shrinking. Try a smaller photo, or crop it, and press ' +
      'Save again.'
    );
  }
  if (info.code === 'network') {
    return (
      "The photo upload didn't go through — the connection dropped before " +
      'it finished.'
    );
  }
  if (info.code === 'bad-response') {
    return (
      "The photo upload didn't get a usable answer back from the server."
    );
  }
  return 'The photo could not be uploaded.';
}

// ----- Browser decode + re-encode (never throws) ------------------------------

/**
 * Decode an image file to a drawable handle. Prefers
 * createImageBitmap with EXIF orientation applied ('from-image');
 * falls back to a plain bitmap, then to an <img> element fed by an
 * object URL (revoked on dispose / on error). Whether orientation
 * is honored on the fallback paths is the platform decoder's
 * business (modern Safari/Chrome apply EXIF orientation when
 * drawing) — prep never blocks on it.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        bitmap = null;
      }
    }
    if (bitmap) {
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
        dispose: () => {
          if (typeof bitmap.close === 'function') bitmap.close();
        },
      };
    }
  }
  if (
    typeof document !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      return {
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        dispose: () => URL.revokeObjectURL(url),
      };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
  throw new Error('This browser cannot decode images.');
}

/**
 * One ladder step: draw the decoded image at the step's dimensions
 * and encode it as JPEG at the step's quality. Resolves to the
 * Blob, or null when anything about the step is unavailable —
 * a failed step never aborts the ladder, the next step is smaller
 * still. JPEG has no alpha: flatten onto white (the product-photo
 * convention) instead of the black a bare canvas would give.
 */
async function encodeLadderStep(decoded, step) {
  try {
    if (typeof document === 'undefined') return null;
    const { width, height } = targetDimensions(
      decoded.width,
      decoded.height,
      step.maxDim
    );
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    decoded.draw(ctx, width, height);
    const blob = await new Promise((resolve) => {
      try {
        canvas.toBlob(resolve, 'image/jpeg', step.quality);
      } catch {
        resolve(null);
      }
    });
    return blob && blob.size ? blob : null;
  } catch {
    return null;
  }
}

/**
 * The result when prep produced nothing sendable. Small originals
 * (<= HARD_SEND_CAP) still upload untouched, exactly as before.
 * A giant original (> HARD_SEND_CAP) is NOT handed back: it is the
 * file that dies in transit, so prep reports it unshrinkable and
 * the caller sends nothing (see the header contract).
 */
function unshrinkableResult(file, heic) {
  const size = Number((file && file.size) || 0);
  if (size > HARD_SEND_CAP) {
    return {
      uploadFile: null,
      prepped: false,
      heicUnconverted: heic,
      tooLargeUnshrinkable: true,
      originalBytes: size,
    };
  }
  return { uploadFile: file, prepped: false, heicUnconverted: heic };
}

/**
 * Prepare a chosen product photo for upload: decode it in the
 * browser and walk the shrink ladder (see the module header).
 * Resolves to an object and NEVER rejects:
 *   uploadFile      the file to actually send — the re-encoded JPEG
 *                   when the ladder produced one, the original when
 *                   it is small enough to send as-is, or NULL when
 *                   the original is a giant this device could not
 *                   shrink (then nothing must be sent)
 *   prepped         true when uploadFile is the re-encoded JPEG
 *   heicUnconverted true when the original was HEIC/HEIF and prep
 *                   could not decode it — the editor turns a failed
 *                   upload of that file into the HEIC-specific
 *                   message via photoFailureMessage.
 *   tooLargeUnshrinkable / originalBytes — present when uploadFile
 *                   is null: the original's size, for the message.
 * The ladder stops early at the first encode at/under
 * TARGET_UPLOAD_BYTES when the original itself is over target (or
 * HEIC — its original can never be sent); otherwise every step
 * runs and chooseShrinkResult picks the winner. A re-encode larger
 * than the original is discarded in favor of the original ONLY
 * when the original is already at/under target; for HEIC, a
 * conversion is kept at any size, because the server rejects the
 * .heic extension no matter the size.
 */
export async function preparePhotoForUpload(file) {
  try {
    if (!file || !shouldAttemptPrep(file)) {
      return { uploadFile: file, prepped: false, heicUnconverted: false };
    }
    const heic = isHeicFile(file);

    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch {
      return unshrinkableResult(file, heic);
    }

    try {
      const results = [];
      let chosen = null;
      for (const step of SHRINK_LADDER) {
        const blob = await encodeLadderStep(decoded, step);
        if (!blob) continue;
        const entry = {
          blob,
          size: blob.size,
          maxDim: step.maxDim,
          quality: step.quality,
        };
        results.push(entry);
        if (
          entry.size <= TARGET_UPLOAD_BYTES &&
          (heic || Number(file.size || 0) > TARGET_UPLOAD_BYTES)
        ) {
          chosen = entry;
          break;
        }
      }
      if (!chosen) {
        chosen = chooseShrinkResult(results, {
          originalBytes: Number(file.size || 0),
          heic,
        });
      }
      if (!chosen || !chosen.blob) return unshrinkableResult(file, heic);
      return {
        uploadFile: new File([chosen.blob], jpegFileName(file.name), {
          type: 'image/jpeg',
          lastModified: Date.now(),
        }),
        prepped: true,
        heicUnconverted: false,
      };
    } finally {
      if (decoded && typeof decoded.dispose === 'function') decoded.dispose();
    }
  } catch {
    // Prep never throws, even here: a surprise while shrinking a
    // giant is the unshrinkable case, not a reason to send it.
    return unshrinkableResult(file, isHeicFile(file));
  }
}
