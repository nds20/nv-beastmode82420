import { Link } from 'react-router-dom';
import { useProducts } from '../hooks/useProducts';
import ProductCard from '../components/ProductCard';

// Shop 824 storefront landing — route "/shop". (The age-gate
// overlay is applied by the shop layout in App.jsx.)
export default function ShopHome() {
  const { products } = useProducts();

  return (
    <main className="shell">
      <section className="hero">
        <span className="kicker">Shop 824</span>
        <h1 className="hero-title">
          SHOP <span className="gold">824</span>
        </h1>
        <p className="hero-lede">
          The 824 storefront — real products, real photos, and straight-up
          pricing. No price listed means it is genuinely still to be
          confirmed, never made up.
        </p>
        <div className="hero-actions">
          <Link className="btn" to="/shop/products">
            Shop Products
          </Link>
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="v">100%</div>
            <div className="k">Real Photos</div>
          </div>
          <div className="hero-stat">
            <div className="v">0</div>
            <div className="k">Made-Up Prices</div>
          </div>
        </div>
      </section>

      <h2 className="section-title">Featured Products</h2>
      <p className="section-sub">The current shelf.</p>
      {products.length === 0 ? (
        <p className="empty-msg">
          Nothing on the shelf yet — 824 merchandise is on the way.
        </p>
      ) : (
        <div className="grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}

      <div className="badges">
        <div className="badge-card">
          <div className="badge-icon">🔒</div>
          <h3>Secure Checkout</h3>
          <p>Your data is protected</p>
        </div>
        <div className="badge-card">
          <div className="badge-icon">🌿</div>
          <h3>Quality Guaranteed</h3>
          <p>Tested. Trusted. Transparent.</p>
        </div>
        <div className="badge-card">
          <div className="badge-icon">🚚</div>
          <h3>Discreet Delivery</h3>
          <p>Fast and discreet shipping</p>
        </div>
      </div>
    </main>
  );
}
