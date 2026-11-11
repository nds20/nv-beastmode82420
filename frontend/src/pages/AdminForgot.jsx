import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminRecoveryReset } from '../services/adminApi';
import PasswordField from '../components/PasswordField';

// Admin password recovery — route "/shop/admin/forgot", linked from
// the admin sign-in page ("Forgot password?").
//
// There is no email in this app, so there is no emailed reset link:
// the owner proves ownership with the ADMIN_RECOVERY_CODE secret from
// the site's Cloudflare settings and sets a new password for a stored
// admin account (the reset creates the account when the username is
// new). On success the API returns a session and this page lands on
// the dashboard, signed in — see docs/ADMIN_RECOVERY.md. Server
// errors surface verbatim, including the 503 that explains the code
// has not been set up yet.
export default function AdminForgot() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }
    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await adminRecoveryReset(username.trim(), recoveryCode, newPassword);
      navigate('/shop/admin', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="shell">
      <div className="page-head">
        <p className="kicker">824 BeastMode L.L.C.</p>
        <h1 className="page-title">Forgot Password</h1>
      </div>

      <div className="notice" role="note">
        Enter the recovery code from the site's Cloudflare settings
        (ADMIN_RECOVERY_CODE) and choose a new password. This creates
        your admin sign-in in the site's own account store, so it keeps
        working even if the Cloudflare secrets change.
      </div>

      <form className="form-card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="recoveryUsername">Username</label>
          <input
            id="recoveryUsername"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <PasswordField
          id="recoveryCode"
          label="Recovery Code"
          autoComplete="off"
          value={recoveryCode}
          onChange={(e) => setRecoveryCode(e.target.value)}
          required
          showLabel="Show recovery code"
          hideLabel="Hide recovery code"
        />
        <PasswordField
          id="recoveryNewPassword"
          label="New Password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <PasswordField
          id="recoveryConfirm"
          label="Confirm New Password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn-green" type="submit" disabled={loading}>
          {loading ? 'Please wait…' : 'Reset Password & Sign In'}
        </button>
        <p className="form-switch">
          Remembered it after all?{' '}
          <Link to="/shop/admin/login">Back to sign in</Link>
        </p>
      </form>
    </main>
  );
}
