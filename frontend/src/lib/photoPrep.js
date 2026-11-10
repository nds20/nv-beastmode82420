// Phone-photo preparation for the admin product editor
// (frontend/src/services/adminApi.js calls preparePhotoForUpload
// before the photo step of a product save; docs/PRODUCT_EDITOR.md
// "Phone photos").
//
// Why this module exists (owner failure, live, 2026-11-10): a photo
// snapped on an iPhone is usually HEIC and several MB. The server
// (functions/api/_lib/photos.js) only accepts jpg/png/webp/gif/svg
// up to 10 MB, and a multi-MB upload on cellular can drop mid-flight
// — the editor then had nothing truthful to say beyond "server could
// not be reached". So the photo is prepared IN THE BROWSER before
// upload: decoded, downscaled to at most 1600 px on the longest
// side, and re-encoded as JPEG. Safari decodes HEIC natively, which
// makes the conversion free exactly on the phones that shoot HEIC.
//
// The contract that keeps this safe: preparePhotoForUpload NEVER
// throws and NEVER blocks an upload that would have worked before.
// Any prep failure — undecodable format, no canvas, encoder error —
// returns the original file untouched, and saveAdminProduct uploads
// it exactly as it used to. Prep is also skipped entirely for SVG
// and GIF (vector/animation would be destroyed by a raster
// re-encode) and for small files that need no help.
//
// The pure helpers (isHeicFile, shouldAttemptPrep, targetDimensions,
// jpegFileName, photoFailureMessage) are node-tested by
// scripts/test-photo-prep.mjs; the canvas path itself is
// browser-only.

// Mirrors MAX_PHOTO_BYTES in functions/api/_lib/photos.js.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Longest-side cap for the re-encoded upload, px.
export const MAX_PHOTO_DIMENSION = 1600;

// Files at or under this size (and not HEIC) upload as-is: they are
// already cheap to send, and leaving them untouched preserves PNG
// transparency and encoder details a JPEG re-encode would flatten.
export const PREP_MIN_BYTES = 1024 * 1024;

const JPEG_QUALITY = 0.85;

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
 * The truthful one-liner for a failed photo step, mapped from what
 * actually happened (assembled by saveAdminProduct into
 * err.photoFailure; rendered by ProductEditor above its saved-details
 * suffix). Pure — node-tested.
 *
 * info: {
 *   serverMessage,    // the server's own { error } text, when it sent one
 *   code,             // 'network' | 'bad-response' | '' from adminFetch
 *   heicUnconverted,  // original was HEIC and prep could not decode it
 *   uploadBytes,      // size of the file that was actually uploaded
 *   maxBytes,         // the server's cap (MAX_PHOTO_BYTES)
 * }
 *
 * A server JSON error is the most specific truth there is, so it
 * wins verbatim — the friendly cases only replace the old bare
 * "server could not be reached" for failures where the server never
 * got a usable word in.
 */
export function photoFailureMessage(info = {}) {
  const maxBytes = info.maxBytes || MAX_PHOTO_BYTES;
  if (info.serverMessage) return info.serverMessage;
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
 * falls back to a plain bitmap, then to an <img> element. Whether
 * orientation is honored on the fallback paths is the platform
 * decoder's business (modern Safari/Chrome apply EXIF orientation
 * when drawing) — prep never blocks on it.
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
 * Prepare a chosen product photo for upload: downscale + JPEG
 * re-encode in the browser (see the module header). Resolves to
 * { uploadFile, prepped, heicUnconverted } and NEVER rejects:
 *   uploadFile      the file to actually send (prepped or original)
 *   prepped         true when uploadFile is the re-encoded JPEG
 *   heicUnconverted true when the original was HEIC/HEIF and prep
 *                   could not decode it — the editor turns a failed
 *                   upload of that file into the HEIC-specific
 *                   message via photoFailureMessage.
 * The re-encode is only used when it helps: smaller than the
 * original — or, for HEIC, whenever it exists at all, because the
 * server rejects the .heic extension no matter the size.
 */
export async function preparePhotoForUpload(file) {
  const original = { uploadFile: file, prepped: false, heicUnconverted: false };
  try {
    if (!file || !shouldAttemptPrep(file)) return original;
    const heic = isHeicFile(file);

    let decoded;
    try {
      decoded = await decodeImage(file);
    } catch {
      return { uploadFile: file, prepped: false, heicUnconverted: heic };
    }

    try {
      const { width, height } = targetDimensions(decoded.width, decoded.height);
      if (!width || !height || typeof document === 'undefined') return original;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return original;
      // JPEG has no alpha: flatten onto white (the product-photo
      // convention) instead of the black a bare canvas would give.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      decoded.draw(ctx, width, height);
      const blob = await new Promise((resolve) => {
        try {
          canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
        } catch {
          resolve(null);
        }
      });
      if (!blob || !blob.size) return original;
      if (!heic && blob.size >= Number(file.size || 0)) return original;
      return {
        uploadFile: new File([blob], jpegFileName(file.name), {
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
    // Prep is an optimization, never a gate: any surprise at all
    // falls back to uploading the original file unchanged.
    return { uploadFile: file, prepped: false, heicUnconverted: isHeicFile(file) };
  }
}
