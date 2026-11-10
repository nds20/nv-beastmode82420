import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  clearAdminToken,
  fetchAdminCustomers,
  fetchAdminOrder,
  fetchAdminOrders,
  fetchAdminProducts,
  getAdminAuthSource,
  getAdminToken,
  markAdminOrderSeen,
} from '../services/adminApi';
import { money, priceLabel } from '../components/ProductCard';

// Admin dashboard — route "/shop/admin". Direct URL only: nothing in
// the public header or footer links here.
//
// Everything on this page comes from the real admin API:
//   - GET   /api/admin/orders           -> { orders, newCount }
//   - GET   /api/admin/orders/:id       -> one order in full
//   - PATCH /api/admin/orders/:id/seen  -> the only status change the
//     API supports ('new' -> 'seen'); there is deliberately no other
//     status control here because no endpoint backs one.
//   - GET   /api/admin/customers        -> { customers }, newest first,
//     public fields only (never salt/hash)
//   - GET   /api/products               -> the shared catalog list
//     (a read-only summary below; adding, editing and deleting
//     products lives on the Products page, /shop/admin/products,
//     behind the Products tab — see docs/PRODUCT_EDITOR.md)
//
// A 401 from any call means the token expired or was revoked:
// adminApi clears it, and this page sends the admin back to sign in.

// Mirrors DEFAULT_LOW_STOCK_THRESHOLD in functions/api/_lib/validate.js.
const ADMIN_LOW_STOCK_DEFAULT = 3;

export default function AdminDashboard() {
  const navigate = useNavigate();
  const hasToken = Boolean(getAdminToken());
  const authSource = getAdminAuthSource();

  const [orders, setOrders] = useState(null);
  const [newCount, setNewCount] = useState(0);
  const [ordersError, setOrdersError] = useState('');
  const [products, setProducts] = useState(null);
  const [productsError, setProductsError] = useState('');
  const [customers, setCustomers] = useState(null);
  const [customersError, setCustomersError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [details, setDetails] = useState({});
  const [detailError, setDetailError] = useState('');
  const [seenBusyId, setSeenBusyId] = useState(null);

  const bounceToLogin = useCallback(() => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  }, [navigate]);

  const handleError = useCallback(
    (err, setLocalError) => {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setLocalError(err.message);
    },
    [bounceToLogin]
  );

  useEffect(() => {
    if (!hasToken) return undefined;
    let cancelled = false;
    fetchAdminOrders()
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data.orders) ? data.orders : [];
        setOrders(list);
        setNewCount(
          typeof data.newCount === 'number'
            ? data.newCount
            : list.filter((o) => o.status === 'new').length
        );
      })
      .catch((err) => {
        if (!cancelled) handleError(err, setOrdersError);
      });
    fetchAdminProducts()
      .then((data) => {
        if (!cancelled) setProducts(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) handleError(err, setProductsError);
      });
    fetchAdminCustomers()
      .then((data) => {
        if (!cancelled) {
          setCustomers(Array.isArray(data.customers) ? data.customers : []);
        }
      })
      .catch((err) => {
        if (!cancelled) handleError(err, setCustomersError);
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken, handleError]);

  if (!hasToken) return <Navigate to="/shop/admin/login" replace />;

  const logout = () => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  };

  const toggleDetail = async (order) => {
    if (expandedId === order.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(order.id);
    setDetailError('');
    if (details[order.id]) return;
    try {
      const full = await fetchAdminOrder(order.id);
      setDetails((prev) => ({ ...prev, [order.id]: full }));
    } catch (err) {
      // The list already carries the full order shape, so a failed
      // detail fetch falls back to what the list returned.
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setDetails((prev) => ({ ...prev, [order.id]: order }));
      setDetailError('Could not refresh this order — showing the list copy.');
    }
  };

  const markSeen = async (order) => {
    setSeenBusyId(order.id);
    try {
      const updated = await markAdminOrderSeen(order.id);
      setOrders((prev) => {
        const next = (prev || []).map((o) => (o.id === updated.id ? updated : o));
        setNewCount(next.filter((o) => o.status === 'new').length);
        return next;
      });
      setDetails((prev) => ({ ...prev, [updated.id]: updated }));
    } catch (err) {
      handleError(err, setOrdersError);
    } finally {
      setSeenBusyId(null);
    }
  };

  return (
    <main className="shell">
      <div className="page-head admin-head">
        <div>
          <p className="kicker">Beastmode 82420</p>
          <h1 className="page-title">Admin</h1>
        </div>
        <button className="btn-ghost" type="button" onClick={logout}>
          Log Out
        </button>
      </div>

      <nav className="admin-tabs" aria-label="Admin">
        <span className="admin-tab is-active" aria-current="page">
          Dashboard
        </span>
        <Link className="admin-tab" to="/shop/admin/products">
          Products
        </Link>
      </nav>

      {authSource === 'demo' && (
        <div className="notice danger" role="note">
          <strong>You are signed in with the DEMO login.</strong> It only
          works while no real admin credentials exist. Set the
          BEASTMODE_ADMIN_* secrets (or create an account from the sign-in
          page) to turn it off.
        </div>
      )}

      <div className="admin-stats" aria-label="Overview">
        <div className="hero-stat">
          <div className="v">{newCount}</div>
          <div className="k">New Orders</div>
        </div>
        <div className="hero-stat">
          <div className="v">{orders ? orders.length : '—'}</div>
          <div className="k">Orders Total</div>
        </div>
        <div className="hero-stat">
          <div className="v">{products ? products.length : '—'}</div>
          <div className="k">Products In Catalog</div>
        </div>
      </div>

      <h2 className="section-title">Orders</h2>
      {ordersError && (
        <p className="form-error" role="alert">
          {ordersError}
        </p>
      )}
      {orders === null && !ordersError && <p className="card-sub">Loading orders…</p>}
      {orders !== null && orders.length === 0 && (
        <p className="empty-msg">
          No orders yet. When a customer checks out, their order lands here.
        </p>
      )}
      {orders !== null && orders.length > 0 && (
        <div className="orders-list">
          {orders.map((order) => {
            const expanded = expandedId === order.id;
            const detail = details[order.id];
            return (
              <div className="order-row admin-order" key={order.id}>
                <div>
                  <div className="ord-id">
                    ORD-{order.id}{' '}
                    <span
                      className={`status-pill${order.status === 'new' ? ' is-new' : ''}`}
                    >
                      {order.status}
                    </span>
                  </div>
                  <div className="ord-meta">
                    {new Date(order.createdAt).toLocaleString()} ·{' '}
                    {order.customer && order.customer.fullName
                      ? order.customer.fullName
                      : 'Guest'}
                    {' · '}
                    {order.items
                      .map((i) => `${i.name}${i.size ? ` (Size: ${i.size})` : ''} × ${i.qty}`)
                      .join(', ')}
                  </div>
                </div>
                <div className="admin-order-side">
                  <div>
                    <div className="ord-id">{money(order.total)}</div>
                    <div className="ord-meta">
                      {order.paymentStatus || 'unpaid'}
                      {order.payment
                        ? ` · ${order.payment.method} ····${order.payment.last4}`
                        : ''}
                    </div>
                  </div>
                  <div className="admin-order-actions">
                    {order.status === 'new' && (
                      <button
                        className="btn-ghost"
                        type="button"
                        disabled={seenBusyId === order.id}
                        onClick={() => markSeen(order)}
                      >
                        {seenBusyId === order.id ? 'Marking…' : 'Mark Seen'}
                      </button>
                    )}
                    <button
                      className="btn-ghost"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleDetail(order)}
                    >
                      {expanded ? 'Hide' : 'Details'}
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="order-detail">
                    {detailError && <p className="form-error">{detailError}</p>}
                    {!detail && !detailError && (
                      <p className="card-sub">Loading order…</p>
                    )}
                    {detail && <OrderDetail order={detail} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h2 className="section-title" style={{ marginTop: 44 }}>
        Customers
      </h2>
      <p className="section-sub">
        Every registered shopper, newest first — the read-back of who
        has an account.
      </p>
      {customersError && (
        <p className="form-error" role="alert">
          {customersError}
        </p>
      )}
      {customers === null && !customersError && (
        <p className="card-sub">Loading customers…</p>
      )}
      {customers !== null && customers.length === 0 && (
        <p className="empty-msg">
          No customers yet. When a shopper registers an account, they
          appear here.
        </p>
      )}
      {customers !== null && customers.length > 0 && (
        <div className="orders-list">
          {customers.map((customer) => (
            <div className="order-row" key={customer.id}>
              <div>
                <div className="ord-id">{customer.name}</div>
                <div className="ord-meta">{customer.email}</div>
              </div>
              <div>
                <div className="ord-meta">
                  Joined{' '}
                  {new Date(customer.createdAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="products-head">
        <h2 className="section-title">Products</h2>
        <Link className="btn" to="/shop/admin/products">
          Open the Products page
        </Link>
      </div>
      <p className="section-sub">
        The live catalog at a glance, exactly as the storefront serves
        it. Add, edit and delete products on the Products page.
      </p>
      {productsError && (
        <p className="form-error" role="alert">
          {productsError}
        </p>
      )}
      {products === null && !productsError && (
        <p className="card-sub">Loading products…</p>
      )}
      {products !== null && products.length === 0 && (
        <p className="empty-msg">
          The catalog is empty right now — there are no products on the
          shelf. That is the real state of the shop, not a loading error.
          Use the Products page to put the first one on it.
        </p>
      )}
      {products !== null && products.length > 0 && (
        <div className="orders-list">
          {products.map((p) => {
            // Inventory (2026-11-09): stock state at a glance, read-only
            // here — counts are managed on the Products page (or the
            // stock PATCH endpoint — see docs/INVENTORY.md).
            const threshold =
              p.lowStockThreshold != null ? p.lowStockThreshold : ADMIN_LOW_STOCK_DEFAULT;
            const stockLabel =
              p.stockQty == null
                ? 'Untracked'
                : p.stockQty === 0
                  ? 'Sold out'
                  : `${p.stockQty} in stock${p.stockQty <= threshold ? ' · Low' : ''}`;
            return (
              <div className="order-row" key={p.id}>
                <div>
                  <div className="ord-id">{p.name}</div>
                  <div className="ord-meta">
                    {p.subtitle} · {p.category}
                    {p.brand ? ` · ${p.brand}` : ''}
                  </div>
                  <div className="ord-meta">
                    Stock: {stockLabel}
                    {p.freeShipping ? ' · Free shipping' : ''}
                  </div>
                </div>
                <div>
                  <div className="ord-id">{priceLabel(p)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function OrderDetail({ order }) {
  const c = order.customer || {};
  const addressLines = [
    c.address,
    [c.city, c.zip].filter(Boolean).join(' '),
  ].filter(Boolean);
  return (
    <>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit</th>
            <th>Line</th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={`${item.productId}::${item.size || ''}`}>
              <td>
                {item.name}
                {item.size ? ` — Size: ${item.size}` : ''}
              </td>
              <td>{item.qty}</td>
              <td>{money(item.unitPrice)}</td>
              <td>{money(item.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="detail-totals">
        <div className="sum-row">
          <span>Subtotal</span>
          <span>{money(order.subtotal)}</span>
        </div>
        <div className="sum-row">
          <span>Tax</span>
          <span>{money(order.tax)}</span>
        </div>
        {Number(order.shippingCents) > 0 && (
          <div className="sum-row">
            <span>Shipping: {order.shippingLabel || order.shippingService || 'Shipping'}</span>
            <span>{money(order.shippingCents / 100)}</span>
          </div>
        )}
        <div className="sum-row total">
          <span>Total</span>
          <span>{money(order.total)}</span>
        </div>
      </div>
      <div className="detail-grid">
        <div>
          <h3>Customer</h3>
          <p>{c.fullName || '—'}</p>
          {c.phone && <p>{c.phone}</p>}
          {addressLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {c.accountId != null && <p>Account customer #{c.accountId}</p>}
          {c.notes && <p className="card-sub">Notes: {c.notes}</p>}
        </div>
        <div>
          <h3>Payment &amp; Status</h3>
          <p>
            Order status: {order.status}
            {order.seenAt
              ? ` (seen ${new Date(order.seenAt).toLocaleString()})`
              : ''}
          </p>
          <p>Payment status: {order.paymentStatus || 'unpaid'}</p>
          {Number(order.shippingCents) > 0 && (
            <p>
              Shipping: {order.shippingLabel || order.shippingService} —{' '}
              {money(order.shippingCents / 100)}
              {order.shippingWeightOz != null ? ` · ${order.shippingWeightOz} oz` : ''}
            </p>
          )}
          {order.payment && (
            <p>
              {order.payment.method} ending in {order.payment.last4}
            </p>
          )}
          {order.stripePaymentIntentId && (
            <p className="card-sub">Stripe: {order.stripePaymentIntentId}</p>
          )}
        </div>
      </div>
    </>
  );
}
