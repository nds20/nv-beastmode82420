import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { money } from '../components/ProductCard';
import {
  fetchOfferStatus,
  payOffer,
  readOfferToken,
  saveOfferToken,
} from '../services/offersApi';
import {
  fetchPaymentsConfig,
  fetchShippingQuote,
  createCheckoutSession,
} from '../services/ordersApi';

// Offer status — route "/shop/offer/:id" (Best Offer, 2026-11-10 —
// docs/OFFERS.md).
//
// The buyer's home for one offer. The shop has no accounts-for-offers,
// so the per-offer access token IS the key: it
// arrives as ?token= in the link shown when the offer is sent and is
// also saved on the device that made the offer (localStorage
// `shop824_offer_<id>`). The page polls nothing — it loads once and
// offers a manual refresh.
//
// When the seller accepts, this page grows the pay form: the same
// delivery fields and shipping picker as Checkout (the server
// re-quotes shipping; only the chosen service id is submitted), and
// payment completes exactly like a normal order — demo card inline,
// or a redirect to Stripe's hosted checkout via the created order's
// own checkout endpoint. The order's price is the ACCEPTED OFFER,
// fixed server-side; nothing on this page can change it.
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
const TAX_RATE_DISPLAY = 0.102;

export default function OfferStatus() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const fromUrl = searchParams.get('token') || '';
    const saved = readOfferToken(id);
    const t = fromUrl || saved;
    if (fromUrl) saveOfferToken(id, fromUrl);
    return t;
  });

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

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
  const [shipQuote, setShipQuote] = useState(null);
  const [shipService, setShipService] = useState(null);
  const [shipConfigured, setShipConfigured] = useState(false);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipError, setShipError] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');

  const load = () => {
    if (!token) {
      setLoading(false);
      setLoadError(
        'This page needs the offer key from when the offer was sent. Open the link shown after you sent the offer, or check the offer from the device you sent it on.'
      );
      return;
    }
    setLoading(true);
    fetchOfferStatus(id, token)
      .then((d) => {
        setData(d);
        setLoadError('');
      })
      .catch((err) => {
        setLoadError(
          err.status === 403
            ? 'That offer key does not match this offer. Open the exact link shown after you sent the offer.'
            : err.message || 'Could not load your offer.'
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [id, token]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Shipping quote once the ZIP is valid — same debounce + service
  // selection rules as Checkout.jsx (USPS rate budget).
  const accepted = data && data.status === 'accepted';
  useEffect(() => {
    if (!accepted || !data.productId || !/^\d{5}$/.test(form.zip)) return undefined;
    let cancelled = false;
    setShipLoading(true);
    const timer = window.setTimeout(() => {
      fetchShippingQuote([{ productId: data.productId, qty: 1 }], form.zip)
        .then((quote) => {
          if (cancelled) return;
          setShipQuote(quote);
          setShipError('');
          if (quote && quote.configured) {
            setShipConfigured(true);
            const options = Array.isArray(quote.options) ? quote.options : [];
            setShipService((prev) =>
              options.some((o) => o.service === prev)
                ? prev
                : options.length > 0
                  ? options[0].service
                  : null
            );
          } else {
            setShipService(null);
          }
        })
        .catch(() => {
          if (!cancelled) setShipError('Could not load shipping options — please check your ZIP.');
        })
        .finally(() => {
          if (!cancelled) setShipLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.zip, accepted, data && data.productId]);

  if (loading) {
    return (
      <main className="shell">
        <p className="empty-msg">Loading your offer…</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="shell">
        <Link className="back-link" to="/shop/products">
          ← Back to Products
        </Link>
        <div className="notice danger" role="alert">
          {loadError || 'Offer not found.'}
        </div>
      </main>
    );
  }

  const shipOptions =
    shipQuote && shipQuote.configured && Array.isArray(shipQuote.options) ? shipQuote.options : [];
  const selectedShipOption = shipOptions.find((o) => o.service === shipService) || null;
  const shippingDollars = selectedShipOption ? selectedShipOption.priceCents / 100 : 0;
  const taxPreview = Math.round(data.offerAmount * TAX_RATE_DISPLAY * 100) / 100;
  const displayTotal = Math.round((data.offerAmount + taxPreview + shippingDollars) * 100) / 100;
  const shippingBlocked = shipConfigured && !selectedShipOption;

  const bind = (name, format) => ({
    value: form[name],
    onChange: (e) => {
      setForm((s) => ({ ...s, [name]: format ? format(e.target.value) : e.target.value }));
      setPayError('');
    },
  });

  const pay = async (e) => {
    e.preventDefault();
    // Client-side checks mirror Checkout.jsx; the server re-validates
    // everything and its word is final.
    if (form.fullName.trim().split(/\s+/).length < 2) return setPayError('Enter your first and last name.');
    if (digits(form.phone).length !== 10) return setPayError('Enter a 10-digit phone number.');
    if (form.address.trim().length < 5) return setPayError('Enter your street address.');
    if (!form.city.trim()) return setPayError('Enter your city.');
    if (!/^\d{5}$/.test(form.zip)) return setPayError('Enter a 5-digit ZIP code.');
    if (shippingBlocked) {
      return setPayError(shipError || 'Please choose a shipping option before paying.');
    }
    if (!stripeEnabled) {
      const d = digits(form.cardNumber);
      if (!(d.length >= 13 && luhn(d))) return setPayError('Enter a valid card number.');
    }
    setPaying(true);
    setPayError('');
    try {
      const order = await payOffer(id, {
        accessToken: token,
        customer: {
          fullName: form.fullName.trim(),
          phone: digits(form.phone),
          address: form.address.trim(),
          city: form.city.trim(),
          zip: form.zip,
          notes: form.notes.trim(),
        },
        ...(selectedShipOption ? { shippingService: selectedShipOption.service } : {}),
        payment: stripeEnabled ? null : { cardNumber: digits(form.cardNumber) },
      });
      // Stripe: hand off to the order's hosted checkout, exactly
      // like Checkout.jsx; any failure still lands on confirmation
      // because the order itself is saved.
      if (stripeEnabled && order && order.id != null && order.accessToken) {
        try {
          sessionStorage.setItem(
            'smokeshop_last_order',
            JSON.stringify({ id: order.id, accessToken: order.accessToken, total: order.total })
          );
          const session = await createCheckoutSession(order.id, order.accessToken);
          if (session && session.url) {
            window.location.assign(session.url);
            return;
          }
        } catch {
          // Fall through to the confirmation page.
        }
      }
      navigate('/shop/order-confirmation', {
        state: {
          orderId: `ORD-${order.id}`,
          total: order.total,
          accessToken: order.accessToken,
          paymentStatus: order.paymentStatus,
        },
      });
    } catch (err) {
      // A 409 here carries a plain story (already completed, or the
      // item sold to another accepted offer first) — show it as-is.
      setPayError(err.message || 'Could not complete the purchase.');
      setPaying(false);
    }
  };

  return (
    <main className="shell">
      <Link className="back-link" to="/shop/products">
        ← Back to Products
      </Link>
      <div className="page-head">
        <h1 className="page-title">Your Offer</h1>
      </div>

      <div className="form-card wide">
        <div className="offer-status-head">
          <div>
            <h2 className="offer-status-product">
              {data.productName || 'Product'}
              {data.size ? ` — Size: ${data.size}` : ''}
            </h2>
            <p className="offer-status-amount">
              Your offer: <strong>{money(data.offerAmount)}</strong>
            </p>
          </div>
          <span className={`status offer-${data.status}`}>{data.status}</span>
        </div>
        <p>{data.message}</p>
        {data.orderId ? (
          <p className="sum-note">Order #{data.orderId} was created from this offer.</p>
        ) : null}
        {data.status === 'pending' && (
          <button type="button" className="btn btn-secondary" onClick={load}>
            Refresh status
          </button>
        )}
      </div>

      {accepted && (
        <form className="cart-layout" onSubmit={pay} noValidate>
          <div className="form-card wide">
            <fieldset>
              <legend>Delivery Information</legend>
              <div className="field">
                <label htmlFor="os-fullName">Full Name *</label>
                <input id="os-fullName" autoComplete="name" {...bind('fullName')} />
              </div>
              <div className="field">
                <label htmlFor="os-email">Order Confirmation Email</label>
                <input id="os-email" type="email" value={data.buyerEmail || ''} readOnly />
                <p className="sum-note">
                  Your order confirmation will be sent to the email on your offer.
                </p>
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="os-phone">Phone *</label>
                  <input id="os-phone" autoComplete="tel" {...bind('phone', formatPhone)} />
                </div>
                <div className="field">
                  <label htmlFor="os-zip">ZIP Code *</label>
                  <input id="os-zip" autoComplete="postal-code" {...bind('zip')} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="os-address">Street Address *</label>
                <input id="os-address" autoComplete="street-address" {...bind('address')} />
              </div>
              <div className="field">
                <label htmlFor="os-city">City *</label>
                <input id="os-city" autoComplete="address-level2" {...bind('city')} />
              </div>
              <div className="field">
                <label htmlFor="os-notes">Delivery Notes</label>
                <textarea id="os-notes" rows="2" {...bind('notes')} />
              </div>
            </fieldset>

            {/^\d{5}$/.test(form.zip) && (shipConfigured || shipError) && (
              <fieldset>
                <legend>Shipping</legend>
                {shipLoading && <p className="sum-note">Getting shipping rates…</p>}
                {shipOptions.map((option) => (
                  <div className="field" key={option.service}>
                    <label>
                      <input
                        type="radio"
                        name="offerShippingService"
                        value={option.service}
                        checked={shipService === option.service}
                        onChange={() => setShipService(option.service)}
                      />{' '}
                      {option.label} — {money(option.priceCents / 100)}
                    </label>
                  </div>
                ))}
                {shipError && (
                  <p className="form-error" role="alert">
                    {shipError}
                  </p>
                )}
              </fieldset>
            )}

            <fieldset>
              <legend>Payment</legend>
              {stripeEnabled ? (
                <div className="notice">
                  <strong>Pay with card via Stripe.</strong> When you pay you&apos;ll be
                  redirected to Stripe&apos;s secure checkout, then brought back for
                  confirmation.
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="os-cardNumber">Card Number *</label>
                    <input
                      id="os-cardNumber"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="1234 5678 9012 3456"
                      {...bind('cardNumber', formatCard)}
                    />
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="os-expiry">Expiry *</label>
                      <input
                        id="os-expiry"
                        inputMode="numeric"
                        autoComplete="cc-exp"
                        placeholder="MM / YY"
                        {...bind('expiry', formatExp)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="os-cvv">CVV *</label>
                      <input
                        id="os-cvv"
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        placeholder="123"
                        {...bind('cvv')}
                      />
                    </div>
                  </div>
                  <p className="sum-note">
                    Demo checkout — only the card&apos;s last four digits are ever sent to
                    the shop.
                  </p>
                </>
              )}
            </fieldset>

            {payError && (
              <p className="form-error" role="alert">
                {payError}
              </p>
            )}
            <button className="btn-green" type="submit" disabled={paying}>
              {paying ? 'Processing…' : `Pay ${money(displayTotal)}`}
            </button>
          </div>

          <aside className="summary-card">
            <h3>Offer Summary</h3>
            <div className="sum-row">
              <span>Accepted offer</span>
              <span>{money(data.offerAmount)}</span>
            </div>
            <div className="sum-row">
              <span>Taxes (10.2%)</span>
              <span>{money(taxPreview)}</span>
            </div>
            {selectedShipOption && (
              <div className="sum-row">
                <span>{selectedShipOption.label}</span>
                <span>{money(shippingDollars)}</span>
              </div>
            )}
            <div className="sum-row total">
              <span>Total</span>
              <span>{money(displayTotal)}</span>
            </div>
            <p className="sum-note">
              The offer price is fixed — shipping is quoted fresh for your ZIP, exactly
              like a normal order.
            </p>
          </aside>
        </form>
      )}
    </main>
  );
}
