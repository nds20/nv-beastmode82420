import { Link, NavLink } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { useAuth } from '../hooks/useAuth';

// Global header for the whole app (hub + shop). Presentational only —
// the look lives in index.css (.site-header and friends).
export default function Header() {
  const { itemCount } = useCart();
  const { user } = useAuth();

  return (
    <header className="site-header">
      <div className="shell header-in">
        <Link className="brand" to="/">
          <span className="over">BEASTMODE</span>
          Beastmode <span className="num">82420</span>
        </Link>
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/" end>
            Hub
          </NavLink>
          <NavLink to="/shop">Shop</NavLink>
          <NavLink to="/shop/products">Products</NavLink>
          <NavLink to="/shop/cart">
            Cart
            {itemCount > 0 && <span className="cart-badge">{itemCount}</span>}
          </NavLink>
          <NavLink to="/shop/login">{user ? user.name.split(' ')[0] : 'Log In'}</NavLink>
        </nav>
      </div>
    </header>
  );
}
