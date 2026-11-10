import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  adminLogin,
  adminSetup,
  fetchSetupStatus,
  getAdminToken,
} from '../services/adminApi';
import PasswordField from '../components/PasswordField';

// Admin sign in — route "/shop/admin/login". Direct URL only: nothing
// in the public header or footer links here.
//
// Two modes, decided by GET /api/admin/setup-status (the same state
// the API's login route documents for this screen):
//   - "login":  POST /api/admin/login — env credentials
//               (BEASTMODE_ADMIN_*), a stored account, or — while
//               neither exists — the built-in demo login, which this
//               page labels as such.
//   - "setup":  POST /api/admin/setup — creates the FIRST stored
//               admin account; offered only while setupRequired.
//
// Password fields use the shared PasswordField (show/hide eye
// toggle), and login mode carries a "Forgot password?" link to the
// recovery page ("/shop/admin/forgot" — see docs/ADMIN_RECOVERY.md).
export default function AdminLogin() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  // Already holding a token? Straight to the dashboard — it will
  // bounce back here if the token turns out to be expired.
  useEffect(() => {
    if (getAdminToken()) navigate('/shop/admin', { replace: true });
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        // No API behind this deploy — the plain login form still
        // renders; submitting will surface the real error.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (mode === 'setup' && password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'setup') {
        await adminSetup(username.trim(), password);
      } else {
        await adminLogin(username.trim(), password);
      }
      navigate('/shop/admin', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const isSetup = mode === 'setup';

  return (
    <main className="shell">
      <div className="page-head">
        <p className="kicker">Beastmode 82420</p>
        <h1 className="page-title">{isSetup ? 'Create Admin Account' : 'Admin'}</h1>
      </div>

      {status && status.dummyActive && !isSetup && (
        <div className="notice" role="note">
          <strong>Demo sign-in is active.</strong> No real admin credentials
          are configured on this deployment yet, so the built-in demo login
          (username <strong>admin</strong>, password <strong>admin123</strong>)
          works. Create a real account below to switch it off.
        </div>
      )}

      <form className="form-card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="adminUsername">Username</label>
          <input
            id="adminUsername"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <PasswordField
          id="adminPassword"
          label="Password"
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {isSetup && (
          <PasswordField
            id="adminConfirm"
            label="Confirm Password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn-green" type="submit" disabled={loading}>
          {loading
            ? 'Please wait…'
            : isSetup
              ? 'Create Account & Sign In'
              : 'Sign In'}
        </button>
        {!isSetup && (
          <p className="form-switch">
            <Link to="/shop/admin/forgot">Forgot password?</Link>
          </p>
        )}
        {status && status.setupRequired && (
          <p className="form-switch">
            {isSetup ? (
              <>
                Already have an admin account?{' '}
                <a
                  href="#login"
                  onClick={(e) => {
                    e.preventDefault();
                    setMode('login');
                    setError('');
                  }}
                >
                  Sign in
                </a>
              </>
            ) : (
              <>
                First time on this deployment?{' '}
                <a
                  href="#setup"
                  onClick={(e) => {
                    e.preventDefault();
                    setMode('setup');
                    setError('');
                  }}
                >
                  Create the first admin account
                </a>
              </>
            )}
          </p>
        )}
      </form>
    </main>
  );
}
