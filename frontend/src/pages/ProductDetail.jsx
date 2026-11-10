import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProducts } from '../hooks/useProducts';
import { useCart } from '../hooks/useCart';
import { priceLabel } from '../components/ProductCard';
import { isSoldOut, isLowStock, qtyCapFor } from '../context/CartContext';
import { categoryLabel } from '../lib/departments';

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
  // shelf count and disable Add entirely at 0.
  const soldOut = isSoldOut(product);
  const lowStock = isLowStock(product);
  const qtyCap = qtyCapFor(product);
  const sizes = Array.isArray(product.sizes) ? product.sizes : [];
  const needsSize = sizes.length > 0;
  const addDisabled = soldOut || (needsSize && !size);

  const onAdd = () => {
    if (addDisabled) return;
    addToCart(product, qty, size);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1200);
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
                {sizes.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`size-btn${size === s ? ' selected' : ''}`}
                    aria-pressed={size === s}
                    onClick={() => setSize(s)}
                  >
                    {s}
                  </button>
                ))}
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
