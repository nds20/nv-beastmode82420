import { Link } from 'react-router-dom';
import { useProducts } from '../hooks/useProducts';
import ProductCard from '../components/ProductCard';

// Smoke Shop 824 storefront landing — route "/shop". (The age-gate
// overlay is applied by the shop layout in App.jsx.)
export default function ShopHome() {
  const { products } = useProducts();

  return (
    <main className="shell">
      <section className="hero">
        <span className="kicker">Smoke Shop 824</span>
        <h1 className="hero-title">
          SMOKE SHOP <span className="gold">824</span>
        </h1>
        <p className="hero-lede">
          The real shelf, online: <strong>nicotine vapes</strong> — with real product
          photos and straight-up pricing. No price listed means it is genuinely still
          to be confirmed, never made up.
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
      <p className="section-sub">The current shelf — two Raz nicotine vapes.</p>
      <div className="grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>

      <h2 className="section-title">Shop by Category</h2>
      <div className="cat-strip">
        <Link className="cat-tile" to="/shop/products">
          <h3>Nicotine Vapes</h3>
          <p>Nicotine vapes — Raz in Blue Raz and Blueberry Yummy.</p>
          <span className="go">Shop now →</span>
        </Link>
      </div>

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
