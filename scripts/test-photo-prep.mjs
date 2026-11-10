// Photo prep tests (2026-11-10) — plain node, no framework:
//
//   node scripts/test-photo-prep.mjs
//
// The phone-photo fix (owner failure, live, 2026-11-10: an iPhone
// camera photo attached in the product editor failed its upload with
// a useless "server could not be reached"; see docs/PRODUCT_EDITOR.md
// "Phone photos"). The fix lives in frontend/src/lib/photoPrep.js:
// photos are downscaled + re-encoded as JPEG in the browser before
// upload, and photo-step failures map to truthful messages. The
// canvas work is browser-only, so this suite covers the PURE seams —
// the same import pattern as test-shop-filters.mjs:
//   (a) constants mirror the server (10 MB cap) + the 1600 px cap
//   (b) isHeicFile: extension + content-type detection, case-safe
//   (c) shouldAttemptPrep: HEIC always, big images yes, small files
//       no, SVG/GIF never, non-images never, null never
//   (d) targetDimensions: downscale math, aspect kept, never upscale
//   (e) jpegFileName: extension swap, extensionless names
//   (f) photoFailureMessage: server verbatim wins; HEIC / too-large /
//       network / bad-response / fallback each say their own truth
//   (g) preparePhotoForUpload in node (no decoder, no canvas): it
//       must RESOLVE with the original file — prep can never make an
//       upload fail — and report heicUnconverted for an HEIC it
//       could not decode here

import {
  MAX_PHOTO_BYTES,
  MAX_PHOTO_DIMENSION,
  PREP_MIN_BYTES,
  isHeicFile,
  isPassthroughPhoto,
  jpegFileName,
  photoFailureMessage,
  preparePhotoForUpload,
  shouldAttemptPrep,
  targetDimensions,
} from '../frontend/src/lib/photoPrep.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const MB = 1024 * 1024;

// (a) Constants.
check('(a) byte cap mirrors the server 10 MB', MAX_PHOTO_BYTES === 10 * MB);
check('(a) dimension cap is 1600', MAX_PHOTO_DIMENSION === 1600);
check('(a) prep threshold sits under the cap', PREP_MIN_BYTES < MAX_PHOTO_BYTES);

// (b) isHeicFile.
check('(b) .HEIC extension (uppercase)', isHeicFile({ name: 'IMG_4132.HEIC', type: '' }));
check('(b) .heif extension', isHeicFile({ name: 'photo.heif', type: '' }));
check('(b) image/heic type, .jpg name', isHeicFile({ name: 'photo.jpg', type: 'image/heic' }));
check('(b) plain jpeg is not HEIC', !isHeicFile({ name: 'photo.jpg', type: 'image/jpeg' }));
check('(b) null is not HEIC', !isHeicFile(null));

// (c) Passthrough + shouldAttemptPrep.
check('(c) svg passes through', isPassthroughPhoto({ name: 'logo.svg', type: 'image/svg+xml' }));
check('(c) gif passes through', isPassthroughPhoto({ name: 'anim.gif', type: 'image/gif' }));
check('(c) huge gif still skips prep', !shouldAttemptPrep({ name: 'anim.gif', type: 'image/gif', size: 20 * MB }));
check('(c) huge svg still skips prep', !shouldAttemptPrep({ name: 'logo.svg', type: 'image/svg+xml', size: 20 * MB }));
check('(c) tiny HEIC attempts prep (conversion is the point)',
  shouldAttemptPrep({ name: 'IMG_1.HEIC', type: 'image/heic', size: 400 * 1024 }));
check('(c) big jpeg attempts prep', shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 5 * MB }));
check('(c) small jpeg skips prep', !shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 400 * 1024 }));
check('(c) big png attempts prep', shouldAttemptPrep({ name: 'a.png', type: 'image/png', size: 3 * MB }));
check('(c) non-image never preps', !shouldAttemptPrep({ name: 'a.pdf', type: 'application/pdf', size: 5 * MB }));
check('(c) null never preps', !shouldAttemptPrep(null));

// (d) targetDimensions.
check('(d) landscape downscale', JSON.stringify(targetDimensions(4000, 3000)) === JSON.stringify({ width: 1600, height: 1200 }));
check('(d) portrait downscale', JSON.stringify(targetDimensions(3000, 4000)) === JSON.stringify({ width: 1200, height: 1600 }));
check('(d) already small is untouched', JSON.stringify(targetDimensions(800, 600)) === JSON.stringify({ width: 800, height: 600 }));
check('(d) exactly at cap is untouched', JSON.stringify(targetDimensions(1600, 900)) === JSON.stringify({ width: 1600, height: 900 }));
check('(d) custom cap honored', JSON.stringify(targetDimensions(2000, 1000, 1000)) === JSON.stringify({ width: 1000, height: 500 }));
check('(d) zero input passes through', JSON.stringify(targetDimensions(0, 500)) === JSON.stringify({ width: 0, height: 500 }));

// (e) jpegFileName.
check('(e) HEIC name becomes .jpg', jpegFileName('IMG_4132.HEIC') === 'IMG_4132.jpg');
check('(e) dotted name keeps its base', jpegFileName('my.photo.png') === 'my.photo.jpg');
check('(e) extensionless name gains .jpg', jpegFileName('photo') === 'photo.jpg');
check('(e) empty name falls back', jpegFileName('') === 'photo.jpg');

// (f) photoFailureMessage.
check('(f) server message wins verbatim',
  photoFailureMessage({ serverMessage: 'File too large', code: 'network', heicUnconverted: true, uploadBytes: 99 * MB }) === 'File too large');
const heicMsg = photoFailureMessage({ heicUnconverted: true, uploadBytes: 3 * MB });
check('(f) HEIC message names HEIC + Most Compatible',
  heicMsg.includes('HEIC') && heicMsg.includes('Most Compatible'), heicMsg);
const bigMsg = photoFailureMessage({ uploadBytes: 12 * MB });
check('(f) too-large message cites size + 10 MB limit',
  bigMsg.includes('12.0 MB') && bigMsg.includes('10 MB'), bigMsg);
check('(f) HEIC beats too-large (conversion fixes both)',
  photoFailureMessage({ heicUnconverted: true, uploadBytes: 12 * MB }).includes('HEIC'));
const netMsg = photoFailureMessage({ code: 'network' });
check('(f) network message names the photo step, not a server',
  netMsg.includes("photo upload didn't go through") && !netMsg.includes('could not be reached'), netMsg);
const badMsg = photoFailureMessage({ code: 'bad-response' });
check('(f) bad-response message is its own truth',
  badMsg.includes("didn't get a usable answer"), badMsg);
check('(f) unknown failure still says something',
  photoFailureMessage({}).length > 0);

// (g) preparePhotoForUpload graceful fallback where no decoder exists.
{
  const big = { name: 'big.jpg', type: 'image/jpeg', size: 5 * MB };
  const r1 = await preparePhotoForUpload(big);
  check('(g) undecodable-here big jpeg resolves to the original',
    r1.uploadFile === big && r1.prepped === false && r1.heicUnconverted === false);

  const heic = { name: 'IMG_9.HEIC', type: 'image/heic', size: 3 * MB };
  const r2 = await preparePhotoForUpload(heic);
  check('(g) undecodable-here HEIC resolves to the original + flags it',
    r2.uploadFile === heic && r2.prepped === false && r2.heicUnconverted === true);

  const small = { name: 'small.jpg', type: 'image/jpeg', size: 100 * 1024 };
  const r3 = await preparePhotoForUpload(small);
  check('(g) small file short-circuits to the original',
    r3.uploadFile === small && r3.prepped === false);

  const r4 = await preparePhotoForUpload(null);
  check('(g) null resolves without throwing', r4.uploadFile === null && r4.prepped === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
