import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { useAuth } from '../hooks/useAuth';
import { money } from '../components/ProductCard';
import {
  submitOrder,
  queuePendingOrder,
  fetchPaymentsConfig,
  createCheckoutSession,
} from '../services/ordersApi';

// Checkout — route "/shop/checkout". Flow ported from the live shop:
// field validation (incl. Luhn on the demo card form), the order is
// posted to /api/orders, and the shopper always lands on the
// confirmation — if the API is unreachable the order is queued locally
// as "pending", exactly as before. When the server reports Stripe is
// configured, the card form is replaced by a redirect notice and the
// just-placed order continues to Stripe's hosted checkout.
const digits = (s) => String(s || '').replace(/\D/g, '');
const formatPhone = (v) => {
  const d = digits(v).slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};
const formatCard = (v) =>
  digits(v)
    .slice(0, 19)
    .replace(/(.{4})/g, '$1 ')
    .trim();
const formatExp = (v) => {
  const d = digits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)} / ${d.slice(2)}` : d;
};
const luhn = (num) => {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = +num[i];
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return num.length > 0 && sum % 10 === 0;
};

const VALIDATORS = {
  fullName: (v) => (v.trim().split(/\s+/).length >= 2 ? '' : 'Enter your first and last name.'),
  phone: (v) => (digits(v).length === 10 ? '' : 'Enter a 10-digit phone number.'),
  address: (v) => (v.trim().length >= 5 ? '' : 'Enter your street address.'),
  city: (v) => (v.trim() ? '' : 'Enter your city.'),
  zip: (v) => (/^\d{5}$/.test(v) ? '' : 'Enter a 5-digit ZIP code.'),
  cardNumber: (v) => {
    const d = digits(v);
    return d.length >= 13 && luhn(d) ? '' : 'Enter a valid card number.';
  },
  expiry: (v) => {
    const d = digits(v);
    if (d.length !== 4) return 'Use MM / YY.';
    const m = +d.slice(0, 2);
    const y = 2000 + +d.slice(2);
    if (m < 1 || m > 12) return 'Month must be 01-12.';
    const now = new Date();
    return y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth() + 1)
      ? ''
      : 'This card has expired.';
  },
  cvv: (v) => (/^\d{3,4}$/.test(v) ? '' : 'Enter the 3 or 4 digit code.'),
};

const LAST_ORDER_KEY = 'smokeshop_last_order';

export default function Checkout() {
  const { items, calculateTotals, clearCart } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const totals = useMemo(() => calculateTotals(), [calculateTotals]);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    address: '',
    city: '',
    zip: '',
    notes: '',
    cardNumber: '',
    expiry: '',
    cvv: '',
  });
  const [touched, setTouched] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Signed-in customers get their name prefilled from their account.
  useEffect(() => {
    if (user && user.name) {
      setForm((s) => (s.fullName ? s : { ...s, fullName: user.name }));
    }
  }, [user]);

  // Does this deployment take real card payments? When the API is
  // unreachable or Stripe is not configured the answer is "no" and
  // checkout runs in its original demo mode.
  useEffect(() => {
    let cancelled = false;
    fetchPaymentsConfig()
      .then((cfg) => {
        if (!cancelled && cfg && cfg.stripeEnabled) setStripeEnabled(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (items.length === 0) {
    return (
      <main className="shell">
        <div className="page-head">
          <h1 className="page-title">Checkout</h1>
        </div>
        <p className="empty-msg">Your cart is empty</p>
        <Link className="btn btn-kai" to="/shop/products">
          Continue Shopping
        </Link>
      </main>
    );
  }

  if (totals.hasTbd) {
    return (
      <main className="shell">
        <div className="page-head">
          <h1 className="page-title">Checkout</h1>
        </div>
        <div className="notice danger" role="alert">
          <strong>Checkout is blocked:</strong>{' '}
          {totals.tbdItems.map((i) => i.name).join(', ')}{' '}
          {totals.tbdItems.length === 1 ? 'has no confirmed price yet' : 'have no confirmed prices yet'}{' '}
          and can&apos;t be ordered until the price is set.
        </div>
        <Link className="btn" to="/shop/cart">
          Back to Cart
        </Link>
      </main>
    );
  }

  const fields = stripeEnabled
    ? ['fullName', 'phone', 'address', 'city', 'zip']
    : ['fullName', 'phone', 'address', 'city', 'zip', 'cardNumber', 'expiry', 'cvv'];
  const errors = Object.fromEntries(fields.map((f) => [f, VALIDATORS[f](form[f])]));
  const showErr = (f) => (touched[f] ? errors[f] : '');
  const bind = (name, format) => ({
    value: form[name],
    onChange: (e) => {
      setForm((s) => ({ ...s, [name]: format ? format(e.target.value) : e.target.value }));
      setSubmitError('');
    },
    onBlur: () => setTouched((t) => ({ ...t, [name]: true })),
  });

  const placeOrder = async (e) => {
    e.preventDefault();
    setTouched(Object.fromEntries(fields.map((f) => [f, true])));
    const firstBad = fields.find((f) => errors[f]);
    if (firstBad) {
      document.getElementById(firstBad)?.focus();
      return;
    }
    setSubmitting(true);
    const orderPayload = {
      items: items.map((i) => ({ productId: i.id, qty: i.qty })),
      customer: {
        fullName: form.fullName.trim(),
        phone: digits(form.phone),
        address: form.address.trim(),
        city: form.city.trim(),
        zip: form.zip,
        notes: form.notes.trim(),
      },
      payment: stripeEnabled ? null : { cardNumber: digits(form.cardNumber) },
    };
    try {
      let saved = null;
      try {
        saved = await submitOrder(orderPayload);
      } catch {
        queuePendingOrder(orderPayload);
      }
      const orderId = saved && saved.id != null ? `ORD-${saved.id}` : `ORD-${Date.now()}`;
      const total = saved && typeof saved.total === 'number' ? saved.total : totals.total;
      const accessToken = saved && saved.accessToken ? saved.accessToken : null;
      clearCart();

      // Stripe: pay on Stripe's hosted page; the order id + access
      // token ride along in the success URL so the return trip lands
      // on the confirmation page. Any failure falls through to the
      // normal confirmation — the order is already saved either way.
      if (saved && saved.id != null && accessToken && stripeEnabled) {
        try {
          sessionStorage.setItem(
            LAST_ORDER_KEY,
            JSON.stringify({ id: saved.id, accessToken, total })
          );
          const session = await createCheckoutSession(saved.id, accessToken);
          if (session && session.url) {
            window.location.assign(session.url);
            return;
          }
        } catch {
          // Fall through to the confirmation page.
        }
      }
      navigate('/shop/order-confirmation', {
        state: { orderId, total, accessToken, paymentStatus: saved ? saved.paymentStatus : null },
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="shell">
      <div className="page-head">
        <h1 className="page-title">Checkout</h1>
      </div>
      <form className="cart-layout" onSubmit={placeOrder} noValidate>
        <div className="form-card wide">
          <fieldset>
            <legend>Delivery Information</legend>
            <div className="field">
              <label htmlFor="fullName">Full Name *</label>
              <input id="fullName" autoComplete="name" {...bind('fullName')} />
              {showErr('fullName') && <p className="form-error">{showErr('fullName')}</p>}
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="phone">Phone *</label>
                <input id="phone" autoComplete="tel" {...bind('phone', formatPhone)} />
                {showErr('phone') && <p className="form-error">{showErr('phone')}</p>}
              </div>
              <div className="field">
                <label htmlFor="zip">ZIP Code *</label>
                <input id="zip" autoComplete="postal-code" {...bind('zip')} />
                {showErr('zip') && <p className="form-error">{showErr('zip')}</p>}
              </div>
            </div>
            <div className="field">
              <label htmlFor="address">Street Address *</label>
              <input id="address" autoComplete="street-address" {...bind('address')} />
              {showErr('address') && <p className="form-error">{showErr('address')}</p>}
            </div>
            <div className="field">
              <label htmlFor="city">City *</label>
              <input id="city" autoComplete="address-level2" {...bind('city')} />
              {showErr('city') && <p className="form-error">{showErr('city')}</p>}
            </div>
            <div className="field">
              <label htmlFor="notes">Delivery Notes</label>
              <textarea id="notes" rows="2" {...bind('notes')} />
            </div>
          </fieldset>

          <fieldset>
            <legend>Payment</legend>
            {stripeEnabled ? (
              <div className="notice">
                <strong>Pay with card via Stripe.</strong> No card details are entered on
                this page. When you place the order you&apos;ll be redirected to
                Stripe&apos;s secure checkout to pay, then brought back here for
                confirmation.
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="cardNumber">Card Number *</label>
                  <input
                    id="cardNumber"
                    inputMode="numeric"
                    autoComplete="cc-number"
                    placeholder="1234 5678 9012 3456"
                    {...bind('cardNumber', formatCard)}
                  />
                  {showErr('cardNumber') && (
                    <p className="form-error">{showErr('cardNumber')}</p>
                  )}
                </div>
                <div className="field-row">
                  <div className="field">
                    <label htmlFor="expiry">Expiry *</label>
                    <input
                      id="expiry"
                      inputMode="numeric"
                      autoComplete="cc-exp"
                      placeholder="MM / YY"
                      {...bind('expiry', formatExp)}
                    />
                    {showErr('expiry') && <p className="form-error">{showErr('expiry')}</p>}
                  </div>
                  <div className="field">
                    <label htmlFor="cvv">CVV *</label>
                    <input
                      id="cvv"
                      inputMode="numeric"
                      autoComplete="cc-csc"
                      placeholder="123"
                      {...bind('cvv')}
                    />
                    {showErr('cvv') && <p className="form-error">{showErr('cvv')}</p>}
                  </div>
                </div>
                <p className="sum-note">
                  Demo checkout — only the card&apos;s last four digits are ever sent to
                  the shop; the full number, expiry and CVV are never stored.
                </p>
              </>
            )}
          </fieldset>

          {submitError && (
            <p className="form-error" role="alert">
              {submitError}
            </p>
          )}
          <button className="btn-green" type="submit" disabled={submitting}>
            {submitting ? 'Placing Order…' : 'Place Order'}
          </button>
          <p className="form-switch">
            <Link to="/shop/cart">← Back to Cart</Link>
          </p>
        </div>

        <aside className="summary-card">
          <h3>Order Summary</h3>
          {items.map((i) => (
            <div className="sum-row" key={i.id}>
              <span>
                {i.name} × {i.qty}
              </span>
              <span>{money(i.price * i.qty)}</span>
            </div>
          ))}
          <div className="sum-row">
            <span>Subtotal</span>
            <span>{money(totals.subtotal)}</span>
          </div>
          <div className="sum-row">
            <span>Taxes (10.2%)</span>
            <span>{money(totals.taxes)}</span>
          </div>
          <div className="sum-row total">
            <span>Total</span>
            <span>{money(totals.total)}</span>
          </div>
        </aside>
      </form>
    </main>
  );
}
