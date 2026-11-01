import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useProducts } from '../hooks/useProducts';
import { useCart } from '../hooks/useCart';
import { priceLabel } from '../components/ProductCard';

// Product detail — route "/shop/product/:id".
export default function ProductDetail() {
  const { id } = useParams();
  const { getProduct, loading } = useProducts();
  const { addToCart } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

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

  const onAdd = () => {
    addToCart(product, qty);
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
          </div>
        </section>
        <section>
          <span className="pd-type">{product.type}</span>
          <h1 className="pd-name">{product.name}</h1>
          <p className="pd-subtitle">{product.subtitle}</p>
          <div className="pd-specs">
            <div className="pd-spec">
              <span className="pd-label">Strength</span>
              <span className="pd-value">{product.strength}</span>
            </div>
            {product.unit && (
              <div className="pd-spec">
                <span className="pd-label">Unit Size</span>
                <span className="pd-value">{product.unit}</span>
              </div>
            )}
            <div className="pd-spec">
              <span className="pd-label">Type</span>
              <span className="pd-value">{product.type}</span>
            </div>
            <div className="pd-spec">
              <span className="pd-label">Category</span>
              <span className="pd-value">
                {product.category === 'nic-vapes' ? 'Nicotine Vapes' : product.category}
              </span>
            </div>
          </div>
          <div className={`pd-price${tbd ? ' tbd' : ''}`}>{priceLabel(product)}</div>
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
                onClick={() => setQty((q) => Math.min(10, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          <button className={`btn pd-add${added ? ' added' : ''}`} onClick={onAdd} type="button">
            {added ? 'Added to Cart ✓' : 'Add to Cart'}
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
