import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

// 21+ age gate for the shop — the overlay pattern from the shop's
// static mirror (ZIP + explicit 21+ confirmation, an under-21 denial
// state), wired to the live app's AuthContext persistence
// (localStorage 'ageVerified' / 'zip').
export default function AgeGate() {
  const { ageVerified, verifyAge } = useAuth();
  const [zip, setZip] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);

  if (ageVerified) return null;

  const submit = (e) => {
    e.preventDefault();
    const digits = zip.replace(/\D/g, '');
    if (digits.length < 5) {
      setError('Please enter a valid ZIP code.');
      return;
    }
    if (!confirmed) {
      setError('Please confirm you are 21 or older to enter.');
      return;
    }
    verifyAge(digits);
  };

  return (
    <div className="age-overlay" role="dialog" aria-modal="true" aria-labelledby="ag-title">
      <section className="ag-card">
        {!denied ? (
          <>
            <p className="ag-mark">
              SMOKE SHOP <span className="num">824</span>
            </p>
            <h1 id="ag-title">Verify Your Age &amp; Location</h1>
            <p className="ag-desc">
              You must be 21 or older to enter. Please confirm your municipality to ensure
              compliance with local regulations.
            </p>
            <form onSubmit={submit} noValidate>
              <label className="sr-only" htmlFor="ageZip">
                ZIP code
              </label>
              <input
                className="ag-input"
                id="ageZip"
                type="text"
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="Enter your ZIP code"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
              />
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>I confirm I am 21 years of age or older.</span>
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="btn-green" type="submit">
                Verify &amp; Continue
              </button>
            </form>
            <button className="ag-deny" type="button" onClick={() => setDenied(true)}>
              I&apos;m under 21
            </button>
          </>
        ) : (
          <>
            <p className="ag-mark">
              SMOKE SHOP <span className="num">824</span>
            </p>
            <h1>Sorry — 21+ Only</h1>
            <p className="ag-desc">
              This shop sells nicotine products and is restricted to adults 21 and over.
              You can head back to the Beastmode 82420 hub instead.
            </p>
            <a className="btn" href="/">
              Back to the Hub
            </a>
          </>
        )}
      </section>
    </div>
  );
}
