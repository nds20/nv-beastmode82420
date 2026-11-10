import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { isSoldOut, isLowStock } from '../context/CartContext';

export const money = (n) => `$${Number(n).toFixed(2)}`;
export const priceLabel = (p) => (p.price == null ? 'Price TBD' : money(p.price));

// One product card — used by the shop home and the products grid.
// Presentational: all styling is in index.css (.card and friends); the
// only inline style is the product's own tile gradient, which is data.
// Inventory (2026-11-09): tracked products show a SOLD OUT badge /
// disabled Add at 0, and an "Only X left" note at low stock;
// untracked products render exactly as before.
export default function ProductCard({ product }) {
  const { addToCart } = useCart();
  const [added, setAdded] = useState(false);
  const tile = Array.isArray(product.tile) ? product.tile : ['#374151', '#111827'];
  const tbd = product.price == null;
  const soldOut = isSoldOut(product);
  const lowStock = isLowStock(product);

  const onAdd = () => {
    if (soldOut) return;
    addToCart(product, 1);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1200);
  };

  return (
    <article className="card">
      <div
        className="thumb"
        style={{ background: `linear-gradient(135deg, ${tile[0]}, ${tile[1]})` }}
      >
        <img src={product.image} alt={product.name} loading="lazy" />
        {soldOut && <span className="stock-badge">Sold Out</span>}
        <Link className="view-btn" to={`/shop/product/${product.id}`}>
          View Details
        </Link>
      </div>
      <div className="card-info">
        <p className="card-type">{product.type}</p>
        <h3 className="card-name">{product.name}</h3>
        <p className="card-sub">{product.subtitle}</p>
        <p className="card-strength">{product.strength}</p>
        {lowStock && <p className="stock-note">Only {product.stockQty} left</p>}
        <div className="card-footer">
          <span className={`card-price${tbd ? ' tbd' : ''}`}>{priceLabel(product)}</span>
          <button
            className={`add-btn${added ? ' added' : ''}`}
            onClick={onAdd}
            type="button"
            disabled={soldOut}
          >
            {soldOut ? 'Sold Out' : added ? 'Added ✓' : 'Add'}
          </button>
        </div>
      </div>
    </article>
  );
}
