// Shop disclosure (owner direction 2026-11-09, pricing line added
// 2026-11-10): the shop's standing policy, rendered at the top AND
// the bottom of the shop page so no shopper can miss it.
//
//   Line one — condition: all clothes are used unless a product is
//   specified as NEW; the word NEW wears caps, bold and red
//   (.used-disclosure-new in index.css) — the only red in the bar.
//   Line two — pricing (Best Offer): NEW items are priced as
//   listed, no offers; used items are Best Offer — the buyer offers
//   and the seller decides. BEST OFFER wears gold
//   (.used-disclosure-best-offer). "Most" is the honest word: the
//   seller can switch offers off on an individual used item, while
//   NEW items NEVER take offers (docs/OFFERS.md).
//
// This is store policy, not product data, so Products.jsx renders
// it unconditionally, empty catalog included.
export default function UsedClothingDisclosure() {
  return (
    <div className="used-disclosure" role="note">
      <p>
        All clothes are used unless specified as{' '}
        <strong className="used-disclosure-new">NEW</strong>.
      </p>
      <p>
        <strong className="used-disclosure-new">NEW</strong> items are priced as listed — no
        offers. Most used items are{' '}
        <strong className="used-disclosure-best-offer">BEST OFFER</strong>: make an offer and
        the seller decides.
      </p>
    </div>
  );
}
