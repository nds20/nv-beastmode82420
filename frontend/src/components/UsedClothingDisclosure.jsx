// Used-clothing disclosure (owner direction 2026-11-09): the shop's
// standing policy — all clothes are used unless a product is
// specified as NEW. The shop page renders this notice at the top AND
// the bottom so no shopper can miss it; the word NEW wears caps,
// bold and red (.used-disclosure-new in index.css) — the only red in
// the bar. This is store policy, not product data, so Products.jsx
// renders it unconditionally, empty catalog included.
export default function UsedClothingDisclosure() {
  return (
    <p className="used-disclosure" role="note">
      All clothes are used unless specified as{' '}
      <strong className="used-disclosure-new">NEW</strong>.
    </p>
  );
}
