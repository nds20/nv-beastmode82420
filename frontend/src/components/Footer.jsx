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
        <p className="copyright">© 824 BeastMode L.L.C.</p>
      </div>
    </footer>
  );
}
