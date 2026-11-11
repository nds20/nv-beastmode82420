import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  changeAdminPassword,
  getAdminMustChange,
  getAdminToken,
} from '../services/adminApi';
import PasswordField from '../components/PasswordField';

// Set / change your own admin password — route
// "/shop/admin/set-password" (multi-admin, 2026-11-09).
//
// Two ways an admin lands here:
//   - FORCED: the owner added her with a temporary password; her
//     sign-in reported mustChangePassword and the login page routed
//     her here to choose her own before anything else. The notice
//     says exactly that.
//   - VOLUNTARY: the "Change password" card on the dashboard links
//     here for any stored-account admin.
// Either way the form is the same — current password + new password
// + confirm — and POST /api/admin/accounts/change-password does the
// change (and clears the flag). Env/demo sign-ins have no stored
// password: the server answers 400 naming the Cloudflare settings,
// and that message surfaces verbatim.
//
// Honest scope (docs/ADMINS.md): the forced stop is this client
// routing — the token itself is fully valid in v1, so this page is
// a strongly-signposted step, not a server-side wall.
export default function AdminSetPassword() {
  const navigate = useNavigate();
  const hasToken = Boolean(getAdminToken());
  const mustChange = getAdminMustChange();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!hasToken) return <Navigate to="/shop/admin/login" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
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
      await changeAdminPassword(currentPassword, newPassword);
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
        <h1 className="page-title">{mustChange ? 'Set Your Password' : 'Change Password'}</h1>
      </div>

      {mustChange ? (
        <div className="notice" role="note">
          <strong>Your admin set you a temporary password — choose
          your own to continue.</strong> Enter the temporary password
          as your current password, then pick a new one only you know.
          The temporary one stops working the moment you save.
        </div>
      ) : (
        <div className="notice" role="note">
          Choose a new password for your admin sign-in. Your current
          password stops working the moment you save.
        </div>
      )}

      <form className="form-card" onSubmit={submit}>
        <PasswordField
          id="setCurrentPassword"
          label="Current Password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
        <PasswordField
          id="setNewPassword"
          label="New Password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <PasswordField
          id="setConfirmPassword"
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
          {loading ? 'Please wait…' : 'Save New Password'}
        </button>
        <p className="form-switch">
          <Link to="/shop/admin">Back to the dashboard</Link>
        </p>
      </form>
    </main>
  );
}
