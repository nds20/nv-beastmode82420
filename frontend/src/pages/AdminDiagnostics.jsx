import { useCallback, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  clearAdminToken,
  fetchPaymentsDiagnostics,
  fetchShippingDiagnostics,
  getAdminToken,
} from '../services/adminApi';
import {
  diagnosticErrorMessage,
  formatShippingDiagnostic,
  moneyFromCents,
  paymentSessionStatus,
  summarizePaymentsDiagnostics,
  summarizeShippingDiagnostics,
} from '../lib/adminDiagnostics';

// Admin Diagnostics — route "/shop/admin/diagnostics". Direct URL /
// admin tabs only, like the rest of the admin.
//
// The two buttons on this page are intentionally explicit: neither
// diagnostic runs on page load. Payments costs one Stripe list call
// and also reconciles what it finds; shipping makes live USPS calls
// against a limited Prices quota. Both use the existing adminApi
// bearer-token plumbing.
//
//   GET /api/admin/payments-debug -> the Stripe/webhook/mail report
//        documented in docs/PAYMENTS_DEBUG.md. Its sessions carry
//        recordedBefore / recordedAfter because the same call
//        replays paid sessions through the webhook handler.
//   GET /api/shipping/debug       -> { configured:false } or the
//        live verdict { configured, tokenOk, options, diagnostics,
//        error? } from USPS.
//
// A 401 from either call means the admin session is over: adminApi
// clears the token, and this page returns to sign in, matching the
// other admin pages.

const KIND_LABELS = {
  donation: 'Donation',
  order: 'Shop order',
  unknown: 'Other Stripe session',
};

function formatUnixSeconds(seconds) {
  if (!Number.isFinite(Number(seconds))) return 'Time not reported';
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? 'Time not reported' : date.toLocaleString();
}

function formatTimestamp(value) {
  if (!value) return 'No paid order recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function mailSummary(mail) {
  if (!mail) return 'Not reported';
  if (!mail.configured) {
    const missing = Array.isArray(mail.missing) ? mail.missing : [];
    return missing.length > 0
      ? `Not configured — missing ${missing.join(', ')}`
      : 'Not configured';
  }
  if (mail.token && mail.token.ok) return 'Configured — token check passed';
  const code = mail.token && mail.token.errorCode ? ` (${mail.token.errorCode})` : '';
  return `Configured — token check failed${code}`;
}

function noticeClass(state) {
  return state === 'still-missing' || state === 'stripe-error' || state === 'error'
    ? 'notice danger'
    : 'notice';
}

export default function AdminDiagnostics() {
  const navigate = useNavigate();
  const hasToken = Boolean(getAdminToken());

  const [paymentsBusy, setPaymentsBusy] = useState(false);
  const [paymentsResult, setPaymentsResult] = useState(null);
  const [paymentsError, setPaymentsError] = useState('');

  const [shippingBusy, setShippingBusy] = useState(false);
  const [shippingResult, setShippingResult] = useState(null);
  const [shippingError, setShippingError] = useState('');

  const bounceToLogin = useCallback(() => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  }, [navigate]);

  if (!hasToken) return <Navigate to="/shop/admin/login" replace />;

  const logout = () => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  };

  const runPayments = async () => {
    setPaymentsBusy(true);
    setPaymentsError('');
    try {
      const data = await fetchPaymentsDiagnostics();
      setPaymentsResult(data);
    } catch (err) {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setPaymentsError(diagnosticErrorMessage(err, 'payments'));
    } finally {
      setPaymentsBusy(false);
    }
  };

  const runShipping = async () => {
    setShippingBusy(true);
    setShippingError('');
    try {
      const data = await fetchShippingDiagnostics();
      setShippingResult(data);
    } catch (err) {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setShippingError(diagnosticErrorMessage(err, 'shipping'));
    } finally {
      setShippingBusy(false);
    }
  };

  const payments = paymentsResult ? summarizePaymentsDiagnostics(paymentsResult) : null;
  const shipping = shippingResult ? summarizeShippingDiagnostics(shippingResult) : null;

  return (
    <main className="shell">
      <div className="page-head admin-head">
        <div>
          <p className="kicker">824 BeastMode L.L.C.</p>
          <h1 className="page-title">Diagnostics</h1>
        </div>
        <button className="btn-ghost" type="button" onClick={logout}>
          Log Out
        </button>
      </div>

      <nav className="admin-tabs" aria-label="Admin">
        <Link className="admin-tab" to="/shop/admin">
          Dashboard
        </Link>
        <Link className="admin-tab admin-tab-action" to="/shop/admin/products">
          + Add Product
        </Link>
        <Link className="admin-tab" to="/shop/admin/error-logs">
          Error Logs
        </Link>
        <span className="admin-tab is-active" aria-current="page">
          Diagnostics
        </span>
      </nav>

      <p className="section-sub">
        Run a check only when you need its answer. Payments checks Stripe and
        records any paid donation or order that is missing from Shop 824;
        shipping asks USPS for a live rate and shows the answer it gives.
      </p>

      <div className="diagnostics-grid">
        <section className="diagnostic-panel" aria-labelledby="payments-diagnostics-title">
          <h2 className="section-title" id="payments-diagnostics-title">
            Payments
          </h2>
          <p className="section-sub">
            Look back over paid Stripe checkout sessions from the last 3 days.
            The check reconciles as it reads: a payment Stripe has but Shop 824
            does not is recorded before the result is shown.
          </p>
          <button
            className="btn diagnostic-run"
            type="button"
            onClick={runPayments}
            disabled={paymentsBusy}
          >
            {paymentsBusy ? 'Reconciling…' : 'Reconcile payments'}
          </button>

          {paymentsError && (
            <p className="form-error" role="alert">
              {paymentsError}
            </p>
          )}

          {payments && (
            <div className="diagnostic-result" aria-live="polite">
              <div className={noticeClass(payments.state)} role="note">
                <strong>{payments.headline}</strong> {payments.description}
              </div>

              <div className="admin-stats" aria-label="Payments diagnostic summary">
                <div className="hero-stat">
                  <div className="v">{payments.sessionCount}</div>
                  <div className="k">Sessions Found</div>
                </div>
                <div className="hero-stat">
                  <div className="v">{payments.alreadyRecordedCount}</div>
                  <div className="k">Already Recorded</div>
                </div>
                <div className="hero-stat">
                  <div className="v">{payments.newlyRecordedCount}</div>
                  <div className="k">Newly Recorded</div>
                </div>
                <div className="hero-stat">
                  <div className="v">{payments.stillMissingCount}</div>
                  <div className="k">Still Missing</div>
                </div>
              </div>

              <div className="diagnostic-facts">
                <p>
                  <strong>Stripe:</strong>{' '}
                  {payments.stripeConfigured
                    ? `Configured${payments.stripeKeyMode ? ` (${payments.stripeKeyMode} mode)` : ''}`
                    : 'Not configured'}
                </p>
                <p>
                  <strong>Stripe webhook:</strong>{' '}
                  {payments.webhookConfigured ? 'Configured' : 'Not configured'}
                </p>
                {payments.stripeError && (
                  <p>
                    <strong>Stripe error:</strong> HTTP{' '}
                    {payments.stripeError.status ?? '—'}
                    {payments.stripeError.errorCode
                      ? ` — ${payments.stripeError.errorCode}`
                      : ''}
                  </p>
                )}
                <p>
                  <strong>Donations now recorded:</strong>{' '}
                  {moneyFromCents(payments.donationTotalCents)} across{' '}
                  {payments.donationCount ?? '—'}{' '}
                  {payments.donationCount === 1 ? 'donation' : 'donations'}
                </p>
                <p>
                  <strong>Latest paid order:</strong>{' '}
                  {payments.ordersSignal.latestPaidOrderId
                    ? `#${payments.ordersSignal.latestPaidOrderId} — ${formatTimestamp(payments.ordersSignal.latestPaidAt)}`
                    : 'No paid order recorded'}
                </p>
                <p>
                  <strong>Order email:</strong> {mailSummary(payments.mail)}
                </p>
                {payments.unknownCount > 0 && (
                  <p>
                    <strong>Other Stripe sessions:</strong> {payments.unknownCount}{' '}
                    paid {payments.unknownCount === 1 ? 'session' : 'sessions'} did
                    not match a Shop 824 donation or order, so nothing was recorded
                    for {payments.unknownCount === 1 ? 'it' : 'them'}.
                  </p>
                )}
              </div>

              {payments.sessions.length > 0 && (
                <div className="diagnostic-list">
                  {payments.sessions.map((session, index) => {
                    const recording = paymentSessionStatus(session);
                    return (
                      <div
                        className="diagnostic-line"
                        key={`${session.idPrefix || 'session'}-${index}`}
                      >
                        <div>
                          <span className="ord-id">
                            {KIND_LABELS[session.kind] || 'Stripe session'}
                          </span>
                          <span
                            className={`status-pill${recording.key === 'newly-recorded' ? ' is-new' : ''}`}
                          >
                            {recording.label}
                          </span>
                          <div className="ord-meta">
                            {session.idPrefix || 'Session ID not reported'} ·{' '}
                            {formatUnixSeconds(session.created)}
                          </div>
                          <div className="ord-meta">
                            Payment {session.paymentStatus || 'not reported'} · Session{' '}
                            {session.sessionStatus || 'not reported'}
                          </div>
                          <div className="ord-meta">{recording.description}</div>
                          {session.note && session.kind === 'unknown' && (
                            <div className="ord-meta">Stripe match: {session.note}</div>
                          )}
                        </div>
                        <div className="ord-id">
                          {moneyFromCents(session.amountTotalCents)}
                          {session.currency ? ` ${String(session.currency).toUpperCase()}` : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="diagnostic-panel" aria-labelledby="shipping-diagnostics-title">
          <h2 className="section-title" id="shipping-diagnostics-title">
            Shipping (USPS)
          </h2>
          <p className="section-sub">
            Make one live USPS rate check for the standard test shipment. This
            bypasses the checkout fallback, so a failure shows what USPS said
            instead of quietly returning the flat rate.
          </p>
          <button
            className="btn diagnostic-run"
            type="button"
            onClick={runShipping}
            disabled={shippingBusy}
          >
            {shippingBusy ? 'Checking shipping…' : 'Check shipping (USPS)'}
          </button>

          {shippingError && (
            <p className="form-error" role="alert">
              {shippingError}
            </p>
          )}

          {shipping && (
            <div className="diagnostic-result" aria-live="polite">
              <div className={noticeClass(shipping.state)} role="note">
                <strong>{shipping.headline}</strong> {shipping.description}
              </div>

              <div className="admin-stats" aria-label="Shipping diagnostic summary">
                <div className="hero-stat">
                  <div className="v">{shipping.configured ? 'Yes' : 'No'}</div>
                  <div className="k">Configured</div>
                </div>
                <div className="hero-stat">
                  <div className="v">
                    {shipping.configured ? (shipping.tokenOk ? 'Yes' : 'No') : '—'}
                  </div>
                  <div className="k">Token Accepted</div>
                </div>
                <div className="hero-stat">
                  <div className="v">{shipping.options.length}</div>
                  <div className="k">Rates Returned</div>
                </div>
                <div className="hero-stat">
                  <div className="v">{shipping.failedDiagnostics.length}</div>
                  <div className="k">Calls Failed</div>
                </div>
              </div>

              {shipping.options.length > 0 && (
                <>
                  <h3 className="diagnostic-subtitle">Live rates returned</h3>
                  <div className="diagnostic-list">
                    {shipping.options.map((option, index) => (
                      <div
                        className="diagnostic-line"
                        key={`${option.service || 'rate'}-${option.priceType || ''}-${index}`}
                      >
                        <div>
                          <span className="ord-id">
                            {option.label || option.service || 'USPS rate'}
                          </span>
                          <div className="ord-meta">
                            {option.mailClass || 'Mail class not reported'}
                            {option.priceType ? ` · ${option.priceType}` : ''}
                            {option.zone ? ` · Zone ${option.zone}` : ''}
                          </div>
                        </div>
                        <div className="ord-id">{moneyFromCents(option.priceCents)}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {shipping.diagnostics.length > 0 && (
                <>
                  <h3 className="diagnostic-subtitle">What USPS answered</h3>
                  <div className="diagnostic-list">
                    {shipping.diagnostics.map((diagnostic, index) => (
                      <p
                        className="diagnostic-call"
                        key={`${diagnostic.stage || 'call'}-${diagnostic.mailClass || ''}-${index}`}
                      >
                        {formatShippingDiagnostic(diagnostic)}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
