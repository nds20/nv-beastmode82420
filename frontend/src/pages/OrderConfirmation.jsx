import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { money } from '../components/ProductCard';
import { fetchOrderStatus } from '../services/ordersApi';

// Order confirmation — route "/shop/order-confirmation".
// Reached two ways (ported from the live shop):
//  - in-app navigation after placing an order (order details arrive in
//    router state), or
//  - returning from Stripe's hosted checkout with
//    ?payment=return&order=<id>&token=<accessToken> in the URL — the
//    token is stripped from the address bar right away.
// When an access token is available, the page polls the order's
// payment status a few times so a just-completed payment shows up.
const LAST_ORDER_KEY = 'smokeshop_last_order';

export default function OrderConfirmation() {
  const location = useLocation();
  const [info] = useState(() => {
    const state = location.state || {};
    if (state.orderId) return state;
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'return') {
      const id = params.get('order');
      const token = params.get('token');
      if (id && token) {
        let total = null;
        try {
          const raw = sessionStorage.getItem(LAST_ORDER_KEY);
          const last = raw ? JSON.parse(raw) : null;
          if (last && String(last.id) === String(id)) total = last.total;
        } catch {
          // No backup — the confirmation still shows the order + status.
        }
        window.history.replaceState({}, '', window.location.pathname);
        return { orderId: `ORD-${id}`, total, accessToken: token, numericId: id };
      }
    }
    return state;
  });
  const [paymentStatus, setPaymentStatus] = useState(info.paymentStatus || null);

  const numericId =
    info.numericId ||
    (info.orderId ? String(info.orderId).replace(/^ORD-/, '') : null);

  useEffect(() => {
    if (!numericId || !info.accessToken) return undefined;
    let cancelled = false;
    let tries = 0;
    const poll = () => {
      fetchOrderStatus(numericId, info.accessToken)
        .then((s) => {
          if (cancelled) return;
          if (s && s.paymentStatus) setPaymentStatus(s.paymentStatus);
          tries += 1;
          if (tries < 5 && (!s || s.paymentStatus === 'pending' || s.paymentStatus === 'unpaid')) {
            window.setTimeout(poll, 2000);
          }
        })
        .catch(() => {});
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="shell">
      <div className="confirm-wrap">
        <div className="confirm-check">✓</div>
        <span className="kicker">Order Confirmed</span>
        <div className="order-num">{info.orderId || 'ORD-—'}</div>
        <p className="section-sub" style={{ margin: '0 auto 8px' }}>
          Thank you — your order has been received. A confirmation summary is below;
          the shop will reach out if anything needs a second look.
        </p>
        {typeof info.total === 'number' && (
          <p>
            Order total: <strong>{money(info.total)}</strong>
          </p>
        )}
        {paymentStatus && (
          <p>
            Payment status: <strong>{paymentStatus}</strong>
          </p>
        )}
        <p style={{ marginTop: 26 }}>
          <Link className="btn" to="/shop/products">
            Continue Shopping
          </Link>
        </p>
      </div>
    </main>
  );
}
