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
//   (a) constants mirror the server (10 MB cap) + the 1600 px cap,
//       the 256 KB prep threshold, the ~900 KB target, the 2 MB
//       hard send cap, and the shrink ladder's shape
//   (b) isHeicFile: extension + content-type detection, case-safe
//   (c) shouldAttemptPrep: HEIC always, images over 256 KB yes,
//       small files no, SVG/GIF never, non-images never, null never
//   (d) targetDimensions: downscale math, aspect kept, never upscale
//   (e) jpegFileName: extension swap, extensionless names
//   (f) photoFailureMessage: server verbatim wins; too-large-
//       unshrinkable / HEIC / too-large / network / bad-response /
//       fallback each say their own truth
//   (g) preparePhotoForUpload in node (no decoder, no canvas): it
//       must RESOLVE, never throw — a >2 MB file it cannot shrink
//       comes back uploadFile:null + tooLargeUnshrinkable (the new
//       never-send-a-giant contract), a <=2 MB file still resolves
//       to the original, and an undecoded HEIC reports
//       heicUnconverted
//   (h) chooseShrinkResult: the pure ladder pick — first under
//       target wins for a big original, smallest wins when nothing
//       reaches target, a no-smaller encode is no shrink at all,
//       an already-small original only loses to a smaller encode

import {
  HARD_SEND_CAP,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_DIMENSION,
  PREP_MIN_BYTES,
  SHRINK_LADDER,
  TARGET_UPLOAD_BYTES,
  chooseShrinkResult,
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
check('(a) prep threshold is 256 KB', PREP_MIN_BYTES === 256 * 1024);
check('(a) upload target is ~900 KB', TARGET_UPLOAD_BYTES === 900 * 1000);
check('(a) hard send cap is 2 MB', HARD_SEND_CAP === 2 * MB);
check('(a) target sits between threshold and hard cap',
  PREP_MIN_BYTES < TARGET_UPLOAD_BYTES && TARGET_UPLOAD_BYTES < HARD_SEND_CAP);
check('(a) ladder has four steps', SHRINK_LADDER.length === 4);
check('(a) ladder opens at 1600px / q0.85',
  SHRINK_LADDER[0].maxDim === 1600 && SHRINK_LADDER[0].quality === 0.85);
check('(a) ladder closes at 700px / q0.7',
  SHRINK_LADDER[3].maxDim === 700 && SHRINK_LADDER[3].quality === 0.7);
check('(a) ladder strictly descends in dimension and quality',
  SHRINK_LADDER.every((s, i, a) =>
    i === 0 || (s.maxDim < a[i - 1].maxDim && s.quality < a[i - 1].quality)));

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
check('(c) 400 KB jpeg now attempts prep (threshold is 256 KB)',
  shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 400 * 1024 }));
check('(c) just-over-threshold jpeg attempts prep',
  shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 256 * 1024 + 1 }));
check('(c) at-threshold jpeg skips prep',
  !shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 256 * 1024 }));
check('(c) small jpeg skips prep', !shouldAttemptPrep({ name: 'a.jpg', type: 'image/jpeg', size: 200 * 1024 }));
check('(c) big png attempts prep', shouldAttemptPrep({ name: 'a.png', type: 'image/png', size: 3 * MB }));
check('(c) 300 KB png attempts prep', shouldAttemptPrep({ name: 'a.png', type: 'image/png', size: 300 * 1024 }));
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
const unshrinkMsg = photoFailureMessage({ tooLargeUnshrinkable: true, uploadBytes: 6 * MB });
check('(f) unshrinkable message is plain + names the remedies',
  unshrinkMsg.includes('very large') && unshrinkMsg.includes("couldn't shrink") &&
    unshrinkMsg.includes('smaller copy') && unshrinkMsg.includes('screenshot') &&
    unshrinkMsg.includes('JPEG'), unshrinkMsg);
check('(f) unshrinkable fires off the code alone',
  photoFailureMessage({ code: 'too-large-unshrinkable' }).includes("couldn't shrink"));
check('(f) unshrinkable beats the HEIC case (it is the fuller truth)',
  photoFailureMessage({ tooLargeUnshrinkable: true, heicUnconverted: true }).includes("couldn't shrink"));
check('(f) server message still beats unshrinkable',
  photoFailureMessage({ serverMessage: 'File too large', tooLargeUnshrinkable: true }) === 'File too large');
const netMsg = photoFailureMessage({ code: 'network' });
check('(f) network message names the photo step, not a server',
  netMsg.includes("photo upload didn't go through") && !netMsg.includes('could not be reached'), netMsg);
const badMsg = photoFailureMessage({ code: 'bad-response' });
check('(f) bad-response message is its own truth',
  badMsg.includes("didn't get a usable answer"), badMsg);
check('(f) unknown failure still says something',
  photoFailureMessage({}).length > 0);

// (g) preparePhotoForUpload where no decoder exists (node): the
// new fallback contract — a giant it cannot shrink is NOT handed
// back for sending; a file at/under the hard cap still is.
{
  const big = { name: 'big.jpg', type: 'image/jpeg', size: 5 * MB };
  const r1 = await preparePhotoForUpload(big);
  check('(g) undecodable >2 MB jpeg resolves unshrinkable, sends nothing',
    r1.uploadFile === null && r1.prepped === false &&
      r1.tooLargeUnshrinkable === true && r1.heicUnconverted === false &&
      r1.originalBytes === 5 * MB, JSON.stringify(r1));

  const heic = { name: 'IMG_9.HEIC', type: 'image/heic', size: 3 * MB };
  const r2 = await preparePhotoForUpload(heic);
  check('(g) undecodable >2 MB HEIC resolves unshrinkable + flags the HEIC',
    r2.uploadFile === null && r2.prepped === false &&
      r2.tooLargeUnshrinkable === true && r2.heicUnconverted === true &&
      r2.originalBytes === 3 * MB, JSON.stringify(r2));

  const mid = { name: 'mid.jpg', type: 'image/jpeg', size: 1.5 * MB };
  const rMid = await preparePhotoForUpload(mid);
  check('(g) undecodable 1.5 MB jpeg still resolves to the original',
    rMid.uploadFile === mid && rMid.prepped === false && !rMid.tooLargeUnshrinkable);

  const atCap = { name: 'cap.jpg', type: 'image/jpeg', size: 2 * MB };
  const rCap = await preparePhotoForUpload(atCap);
  check('(g) undecodable file exactly at the 2 MB cap still sends the original',
    rCap.uploadFile === atCap && !rCap.tooLargeUnshrinkable);

  const smallHeic = { name: 'IMG_2.HEIC', type: 'image/heic', size: 900 * 1024 };
  const rHeicSmall = await preparePhotoForUpload(smallHeic);
  check('(g) undecodable under-cap HEIC resolves to the original + flags it',
    rHeicSmall.uploadFile === smallHeic && rHeicSmall.prepped === false &&
      rHeicSmall.heicUnconverted === true && !rHeicSmall.tooLargeUnshrinkable);

  const small = { name: 'small.jpg', type: 'image/jpeg', size: 100 * 1024 };
  const r3 = await preparePhotoForUpload(small);
  check('(g) small file short-circuits to the original',
    r3.uploadFile === small && r3.prepped === false);

  const r4 = await preparePhotoForUpload(null);
  check('(g) null resolves without throwing', r4.uploadFile === null && r4.prepped === false);
}

// (h) chooseShrinkResult — the pure ladder pick.
{
  const T = TARGET_UPLOAD_BYTES;
  const R = (...sizes) => sizes.map((size) => ({ size }));

  check('(h) no results -> null', chooseShrinkResult([], { originalBytes: 5 * MB }) === null);
  check('(h) empty-size results are unusable',
    chooseShrinkResult([{ size: 0 }, null], { originalBytes: 5 * MB }) === null);

  const first = chooseShrinkResult(R(1.4 * MB, 800 * 1000, 500 * 1000), { originalBytes: 5 * MB });
  check('(h) big original: FIRST under-target encode wins (ladder order)',
    first && first.size === 800 * 1000, JSON.stringify(first));

  const smallest = chooseShrinkResult(R(1.4 * MB, 1.1 * MB, 1.8 * MB), { originalBytes: 5 * MB });
  check('(h) big original, none under target: smallest encode wins',
    smallest && smallest.size === 1.1 * MB, JSON.stringify(smallest));

  check('(h) big original, encode no smaller than original: no shrink',
    chooseShrinkResult(R(5.5 * MB), { originalBytes: 5 * MB }) === null);
  check('(h) big original, encode equal to original: no shrink',
    chooseShrinkResult(R(5 * MB), { originalBytes: 5 * MB }) === null);

  const heicPick = chooseShrinkResult(R(6 * MB), { originalBytes: 5 * MB, heic: true });
  check('(h) HEIC keeps its conversion even when it grew',
    heicPick && heicPick.size === 6 * MB, JSON.stringify(heicPick));

  const smallOrig = chooseShrinkResult(R(500 * 1000, 300 * 1000), { originalBytes: 800 * 1000 });
  check('(h) under-target original: smallest smaller encode wins',
    smallOrig && smallOrig.size === 300 * 1000, JSON.stringify(smallOrig));
  check('(h) under-target original: a larger encode is discarded',
    chooseShrinkResult(R(850 * 1000), { originalBytes: 800 * 1000 }) === null);
  check('(h) under-target original: an equal encode is discarded',
    chooseShrinkResult(R(800 * 1000), { originalBytes: 800 * 1000 }) === null);

  const bigTarget = chooseShrinkResult(R(1200, 1100), { originalBytes: 5000, target: 1000 });
  check('(h) explicit target honored (nothing under -> smallest)',
    bigTarget && bigTarget.size === 1100, JSON.stringify(bigTarget));
  const underT = chooseShrinkResult(R(1500, 900), { originalBytes: 5000, target: 1000 });
  check('(h) explicit target honored (first under target)',
    underT && underT.size === 900, JSON.stringify(underT));
  check('(h) sizes are bytes against the default ~900 KB target',
    T === 900 * 1000 && chooseShrinkResult(R(T + 1), { originalBytes: 5 * MB }).size === T + 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
