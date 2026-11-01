import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { fetchCustomerOrders } from '../services/customersApi';
import { money } from '../components/ProductCard';

// Sign in — route "/shop/login". When already signed in this page is
// the account view: profile, the customer's orders (from
// GET /api/customers/orders), and sign-out.
export default function Login() {
  const { user, login, logout, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [orders, setOrders] = useState(null);
  const [ordersError, setOrdersError] = useState('');

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchCustomerOrders()
      .then((data) => {
        if (!cancelled) setOrders(Array.isArray(data.orders) ? data.orders : []);
      })
      .catch((err) => {
        if (!cancelled) setOrdersError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (user) {
    return (
      <main className="shell">
        <div className="page-head">
          <h1 className="page-title">Your Account</h1>
        </div>
        <div className="form-card wide">
          <div className="account-head">
            <div>
              <p>
                <strong>{user.name}</strong>
              </p>
              <p className="card-sub">{user.email}</p>
              <p className="card-sub">Customer #{user.id}</p>
            </div>
            <button
              className="btn-ghost"
              type="button"
              onClick={() => {
                logout();
                navigate('/shop');
              }}
            >
              Sign Out
            </button>
          </div>

          <h2 className="section-title" style={{ fontSize: 30, marginTop: 34 }}>
            Your Orders
          </h2>
          {ordersError && <p className="form-error">{ordersError}</p>}
          {orders === null && !ordersError && <p className="card-sub">Loading orders…</p>}
          {orders !== null && orders.length === 0 && (
            <p className="card-sub">
              No orders yet — orders you place while signed in will show up here.
            </p>
          )}
          {orders !== null && orders.length > 0 && (
            <div className="orders-list">
              {orders.map((o) => (
                <div className="order-row" key={o.id}>
                  <div>
                    <div className="ord-id">ORD-{o.id}</div>
                    <div className="ord-meta">
                      {new Date(o.createdAt).toLocaleString()} ·{' '}
                      {o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}
                    </div>
                  </div>
                  <div>
                    <div className="ord-id">{money(o.total)}</div>
                    <div className="ord-meta">
                      {o.status}
                      {o.paymentStatus ? ` · ${o.paymentStatus}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate('/shop');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="shell">
      <div className="page-head">
        <h1 className="page-title">Log In</h1>
      </div>
      <form className="form-card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="loginEmail">Email</label>
          <input
            id="loginEmail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="loginPassword">Password</label>
          <input
            id="loginPassword"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn-green" type="submit" disabled={loading}>
          {loading ? 'Signing In…' : 'Sign In'}
        </button>
        <p className="form-switch">
          New to Shop 824? <Link to="/shop/register">Create an account</Link>
        </p>
      </form>
    </main>
  );
}
