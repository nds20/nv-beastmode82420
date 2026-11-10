import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProducts } from '../hooks/useProducts';
import { useCart } from '../hooks/useCart';
import { priceLabel } from '../components/ProductCard';
import {
  isSoldOut,
  isLowStock,
  qtyCapFor,
  qtyCapForSize,
  sizeInventoryOf,
  LOW_STOCK_THRESHOLD,
} from '../context/CartContext';
import { categoryLabel, genderLabel } from '../lib/departments';
import { submitOffer, saveOfferToken } from '../services/offersApi';

// Product detail — route "/shop/product/:id".
// Clothing (2026-11-09): when the product has a size run, a size
// picker renders and Add to Cart stays disabled until a size is
// chosen ("Pick a size"); the chosen size rides the cart line into
// the order. One-size products (empty sizes) add exactly as before.
export default function ProductDetail() {
  const { id } = useParams();
  const { getProduct, loading } = useProducts();
  const { addToCart } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [size, setSize] = useState(null);
  // Best Offer (2026-11-10): the make-an-offer form's state. The
  // size comes from the detail picker above (same state as Add to
  // Cart); submitting stores the offer's access token on this
  // device so the status page can find it again.
  const [offerOpen, setOfferOpen] = useState(false);
  const [offerForm, setOfferForm] = useState({ amount: '', name: '', email: '', phone: '', note: '' });
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerError, setOfferError] = useState('');
  const [offerSent, setOfferSent] = useState(null);

  const product = getProduct(id);

  if (!product) {
    return (
      <main className="shell">
        <Link className="back-link" to="/shop/products">
          ← Back to Products
        </Link>
        <p className="empty-msg">{loading ? 'Loading…' : 'Product not found'}</p>
      </main>
    );
  }

  const tile = Array.isArray(product.tile) ? product.tile : ['#374151', '#111827'];
  const tbd = product.price == null;
  // Inventory (2026-11-09): tracked products cap the stepper at the
  // shelf count and disable Add entirely at 0. Per-size products
  // (2026-11-10): the cap follows the SELECTED size's own count,
  // and the low-stock note is per-size too (in the picker below) —
  // the product-total note would name a number no single size has.
  const soldOut = isSoldOut(product);
  const perSize = sizeInventoryOf(product);
  const lowStock = !perSize && isLowStock(product);
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  const needsSize = sizes.length > 0;
  const qtyCap = perSize && size ? qtyCapForSize(product, size) : qtyCapFor(product);
  const lowThreshold =
    product.lowStockThreshold != null ? product.lowStockThreshold : LOW_STOCK_THRESHOLD;
  const addDisabled = soldOut || (needsSize && !size);

  const pickSize = (s) => {
    setSize(s);
    // Changing size re-caps the stepper at the new size's count.
    setQty((q) => Math.min(q, qtyCapForSize(product, s)));
  };

  const onAdd = () => {
    if (addDisabled) return;
    addToCart(product, qty, size);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1200);
  };

  // Best Offer submit (server rules in docs/OFFERS.md: below list
  // price only, size required exactly like Add, 72 hours for the
  // seller to respond). The token is saved on this device so the
  // status page can reopen the offer without an account.
  const offerable = Boolean(product.acceptsOffers) && !soldOut && !tbd;
  const setOfferField = (field) => (e) =>
    setOfferForm((f) => ({ ...f, [field]: e.target.value }));
  const onOfferSubmit = async (e) => {
    e.preventDefault();
    if (needsSize && !size) {
      setOfferError('Pick a size first.');
      return;
    }
    setOfferBusy(true);
    setOfferError('');
    try {
      const created = await submitOffer({
        productId: product.id,
        offerAmount: Number(offerForm.amount),
        name: offerForm.name,
        email: offerForm.email,
        ...(offerForm.phone.trim() ? { phone: offerForm.phone.trim() } : {}),
        ...(offerForm.note.trim() ? { note: offerForm.note.trim() } : {}),
        ...(needsSize ? { size } : {}),
      });
      saveOfferToken(created.id, created.accessToken);
      setOfferSent(created);
    } catch (err) {
      setOfferError(err.message || 'Could not send your offer.');
    } finally {
      setOfferBusy(false);
    }
  };

  return (
    <main className="shell">
      <Link className="back-link" to="/shop/products">
        ← Back to Products
      </Link>
      <div className="pd-layout">
        <section>
          <div
            className="pd-main-image"
            style={{ background: `linear-gradient(135deg, ${tile[0]}, ${tile[1]})` }}
          >
            <img src={product.image} alt={product.name} />
            {soldOut && <span className="stock-badge">Sold Out</span>}
          </div>
        </section>
        <section>
          {product.type ? <span className="pd-type">{product.type}</span> : null}
          <h1 className="pd-name">{product.name}</h1>
          <p className="pd-subtitle">{product.subtitle}</p>
          <div className="pd-specs">
            {product.brand && (
              <div className="pd-spec">
                <span className="pd-label">Brand</span>
                <span className="pd-value">{product.brand}</span>
              </div>
            )}
            {genderLabel(product.gender) && (
              <div className="pd-spec">
                <span className="pd-label">Gender</span>
                <span className="pd-value">{genderLabel(product.gender)}</span>
              </div>
            )}
            {product.scent && (
              <div className="pd-spec">
                <span className="pd-label">Scent</span>
                <span className="pd-value">{product.scent}</span>
              </div>
            )}
            {product.type && (
              <div className="pd-spec">
                <span className="pd-label">Type</span>
                <span className="pd-value">{product.type}</span>
              </div>
            )}
            <div className="pd-spec">
              <span className="pd-label">Category</span>
              <span className="pd-value">{categoryLabel(product.category)}</span>
            </div>
          </div>
          <div className={`pd-price${tbd ? ' tbd' : ''}`}>{priceLabel(product)}</div>
          {soldOut && <p className="stock-note">Sold out</p>}
          {lowStock && <p className="stock-note">Only {product.stockQty} left</p>}
          {needsSize && (
            <div className="pd-sizes">
              <span className="pd-label">Size</span>
              <div className="size-picker" role="group" aria-label="Choose a size">
                {sizes.map((s) => {
                  // Per-size stock (2026-11-10): a size at 0 is
                  // disabled and labeled Sold out; a size at or
                  // under the low-stock threshold shows its count.
                  // Legacy products have no per-size counts — their
                  // buttons render exactly as before.
                  const entry = perSize
                    ? perSize.find((e) => e.size === s)
                    : null;
                  const remaining = entry ? entry.qty : null;
                  const sizeOut = remaining !== null && remaining <= 0;
                  const sizeLow =
                    remaining !== null && remaining > 0 && remaining <= lowThreshold;
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`size-btn${size === s ? ' selected' : ''}`}
                      aria-pressed={size === s}
                      disabled={sizeOut}
                      onClick={() => pickSize(s)}
                    >
                      {s}
                      {sizeOut
                        ? ' · Sold out'
                        : sizeLow
                          ? ` · Only ${remaining} left`
                          : ''}
                    </button>
                  );
                })}
              </div>
              {!size && <p className="form-error">Pick a size</p>}
            </div>
          )}
          <div className="pd-qty">
            <label htmlFor="pdQtyVal">Quantity:</label>
            <div className="qty-control">
              <button
                type="button"
                aria-label="Decrease quantity"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="qty-val" id="pdQtyVal">
                {qty}
              </span>
              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => setQty((q) => Math.min(qtyCap, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          <button
            className={`btn pd-add${added ? ' added' : ''}`}
            onClick={onAdd}
            type="button"
            disabled={addDisabled}
          >
            {soldOut ? 'Sold Out' : added ? 'Added to Cart ✓' : 'Add to Cart'}
          </button>
          {offerable && (
            <div className="pd-offer">
              {offerSent ? (
                <div className="checkout-success">
                  <h3>Offer sent!</h3>
                  <p>
                    The seller has 72 hours to respond. Save this page — it is the only
                    place to check the answer and pay if your offer is accepted (the
                    shop does not send email).
                  </p>
                  <Link
                    className="btn"
                    to={`/shop/offer/${offerSent.id}?token=${encodeURIComponent(offerSent.accessToken || '')}`}
                  >
                    Check your offer →
                  </Link>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary pd-offer-btn"
                    onClick={() => setOfferOpen((o) => !o)}
                    aria-expanded={offerOpen}
                  >
                    or Make an Offer
                  </button>
                  {offerOpen && (
                    <form className="offer-form" onSubmit={onOfferSubmit}>
                      <div className="field">
                        <label htmlFor="of-amount">Your offer ($)</label>
                        <input
                          id="of-amount"
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          value={offerForm.amount}
                          onChange={setOfferField('amount')}
                          placeholder={`List price is ${priceLabel(product)}`}
                        />
                        <p className="hint">
                          Below the list price — at list price, just add it to your cart.
                        </p>
                      </div>
                      {needsSize && (
                        <p className="hint">
                          Size: <strong>{size || 'pick a size above first'}</strong>
                        </p>
                      )}
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="of-name">Your name</label>
                          <input
                            id="of-name"
                            required
                            value={offerForm.name}
                            onChange={setOfferField('name')}
                            autoComplete="name"
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="of-email">Email</label>
                          <input
                            id="of-email"
                            type="email"
                            required
                            value={offerForm.email}
                            onChange={setOfferField('email')}
                            autoComplete="email"
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="of-phone">Phone (optional)</label>
                        <input
                          id="of-phone"
                          type="tel"
                          value={offerForm.phone}
                          onChange={setOfferField('phone')}
                          autoComplete="tel"
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="of-note">Note for the seller (optional)</label>
                        <textarea
                          id="of-note"
                          rows="2"
                          maxLength="500"
                          value={offerForm.note}
                          onChange={setOfferField('note')}
                        />
                      </div>
                      {offerError && <p className="form-error">{offerError}</p>}
                      <button className="btn" type="submit" disabled={offerBusy}>
                        {offerBusy ? 'Sending…' : 'Send Offer'}
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
          )}
          {product.about && (
            <div className="pd-about">
              <h3>About This Product</h3>
              <p>{product.about}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
