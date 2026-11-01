import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell">
        <nav aria-label="Footer">
          <Link to="/">Hub</Link>
          <Link to="/shop">Shop</Link>
          <Link to="/shop/products">Products</Link>
          <Link to="/shop/login">Log In</Link>
          <Link to="/shop/cart">Cart</Link>
        </nav>
        <p className="fine">
          Smoke Shop 824 is the storefront of 824. Prices are shown only where confirmed;
          everything else is listed as Price TBD — never made up.
        </p>
        <p className="copyright">© 824 · Beastmode 82420</p>
      </div>
    </footer>
  );
}
