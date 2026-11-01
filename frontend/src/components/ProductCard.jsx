import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../hooks/useCart';

export const money = (n) => `$${Number(n).toFixed(2)}`;
export const priceLabel = (p) => (p.price == null ? 'Price TBD' : money(p.price));

// One product card — used by the shop home and the products grid.
// Presentational: all styling is in index.css (.card and friends); the
// only inline style is the product's own tile gradient, which is data.
export default function ProductCard({ product }) {
  const { addToCart } = useCart();
  const [added, setAdded] = useState(false);
  const tile = Array.isArray(product.tile) ? product.tile : ['#374151', '#111827'];
  const tbd = product.price == null;

  const onAdd = () => {
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
        <Link className="view-btn" to={`/shop/product/${product.id}`}>
          View Details
        </Link>
      </div>
      <div className="card-info">
        <p className="card-type">{product.type}</p>
        <h3 className="card-name">{product.name}</h3>
        <p className="card-sub">{product.subtitle}</p>
        <p className="card-strength">{product.strength}</p>
        <div className="card-footer">
          <span className={`card-price${tbd ? ' tbd' : ''}`}>{priceLabel(product)}</span>
          <button className={`add-btn${added ? ' added' : ''}`} onClick={onAdd} type="button">
            {added ? 'Added ✓' : 'Add'}
          </button>
        </div>
      </div>
    </article>
  );
}
