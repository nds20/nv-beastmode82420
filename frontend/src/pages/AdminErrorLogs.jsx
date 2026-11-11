import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  clearAdminToken,
  clearErrorLogs,
  fetchErrorLogs,
  getAdminToken,
} from '../services/adminApi';

// Admin Error Logs — route "/shop/admin/error-logs". Direct URL /
// admin tabs only, like the rest of the admin (docs/ERROR_LOGS.md).
//
// This page is the reading end of the airlock: every captured
// failure lands here with its FACTS — server 5xx errors (name +
// message), browser-reported failures (the status, content-type and
// first bytes of whatever answered, for the failures only the
// browser can see), and 824 Shield blocks (reasons + scores) — so a
// failure is diagnosed from evidence, not guessed at. A message in
// the product editor citing "(ref: xxxxxxxx)" points at the row
// whose request id starts with those characters.
//
//   GET    /api/admin/error-logs?limit=100  -> { logs }, newest first
//   DELETE /api/admin/error-logs            -> { ok, removed }
//
// A 401 from any call means the token expired or was revoked:
// adminApi clears it, and this page sends the admin back to sign in.

const SOURCE_LABELS = {
  server: 'Server',
  client: 'Client',
  shield: 'Shield',
};

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts || '') : d.toLocaleString();
}

export default function AdminErrorLogs() {
  const navigate = useNavigate();
  const hasToken = Boolean(getAdminToken());

  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearNote, setClearNote] = useState('');

  const bounceToLogin = useCallback(() => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchErrorLogs(100);
      setLogs(Array.isArray(data.logs) ? data.logs : []);
      setError('');
    } catch (err) {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setError((err && err.message) || 'Could not load the error logs.');
    } finally {
      setRefreshing(false);
    }
  }, [bounceToLogin]);

  useEffect(() => {
    if (hasToken) load();
  }, [hasToken, load]);

  if (!hasToken) return <Navigate to="/shop/admin/login" replace />;

  const logout = () => {
    clearAdminToken();
    navigate('/shop/admin/login', { replace: true });
  };

  const clearAll = async () => {
    if (
      !window.confirm(
        'Clear all error logs? The captured failures are deleted and cannot be recovered.'
      )
    ) {
      return;
    }
    setClearing(true);
    setClearNote('');
    try {
      const data = await clearErrorLogs();
      setLogs([]);
      setExpandedId(null);
      setClearNote(
        `Cleared ${typeof data.removed === 'number' ? data.removed : 0} log rows.`
      );
    } catch (err) {
      if (err && err.status === 401) {
        bounceToLogin();
        return;
      }
      setError((err && err.message) || 'Could not clear the error logs.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <main className="shell">
      <div className="page-head admin-head">
        <div>
          <p className="kicker">824 BeastMode L.L.C.</p>
          <h1 className="page-title">Error Logs</h1>
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
        <span className="admin-tab is-active" aria-current="page">
          Error Logs
        </span>
        <Link className="admin-tab" to="/shop/admin/diagnostics">
          Diagnostics
        </Link>
      </nav>

      <p className="section-sub">
        Every captured failure, newest first — server errors, failures the
        browser reported (including the actual answer it got back), and 824
        Shield blocks. When an error message anywhere in the admin cites a{' '}
        <strong>(ref: …)</strong>, the row with that request id is the
        failure it came from.
      </p>

      <div className="admin-order-actions" style={{ marginBottom: 14 }}>
        <button
          className="btn"
          type="button"
          onClick={load}
          disabled={refreshing || clearing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          className="btn-ghost"
          type="button"
          onClick={clearAll}
          disabled={clearing || refreshing || !logs || logs.length === 0}
        >
          {clearing ? 'Clearing…' : 'Clear logs'}
        </button>
      </div>

      {clearNote && (
        <div className="notice" role="note">
          {clearNote}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {logs === null && !error && <p className="section-sub">Loading…</p>}

      {logs !== null && logs.length === 0 && (
        <div className="notice" role="note">
          <strong>No errors logged.</strong> When something breaks — a server
          error, a failed upload, a Shield block — the facts land here
          instead of disappearing.
        </div>
      )}

      {logs !== null && logs.length > 0 && (
        <div className="orders-list">
          {logs.map((log) => {
            const expanded = expandedId === log.id;
            return (
              <div className="order-row admin-order" key={log.id}>
                <div>
                  <span className="ord-id">
                    {log.method || '—'} {log.path || '—'}
                  </span>
                  <span
                    className={`status-pill${log.source === 'server' ? ' is-new' : ''}`}
                  >
                    {SOURCE_LABELS[log.source] || log.source || '—'}
                  </span>
                  {log.status !== null && log.status !== undefined && (
                    <span className="status-pill">HTTP {log.status}</span>
                  )}
                  <div className="ord-meta">
                    {formatTime(log.ts)}
                    {log.errorMessage ? ` — ${log.errorMessage}` : ''}
                  </div>
                </div>
                <div className="admin-order-side">
                  <div className="admin-order-actions">
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : log.id)}
                      aria-expanded={expanded}
                    >
                      {expanded ? 'Hide details' : 'Details'}
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="order-detail">
                    <div className="error-log-detail">
                      <p>
                        <strong>Error:</strong> {log.errorName || '—'}
                        {log.errorMessage ? ` — ${log.errorMessage}` : ''}
                      </p>
                      <p>
                        <strong>Request id:</strong> {log.requestId || '—'}
                      </p>
                      <p>
                        <strong>Actor:</strong> {log.actor || '—'}
                      </p>
                      <p>
                        <strong>User agent:</strong> {log.userAgent || '—'}
                      </p>
                      {log.detail !== null && log.detail !== undefined && (
                        <>
                          <p>
                            <strong>Detail:</strong>
                          </p>
                          <pre>
                            {typeof log.detail === 'string'
                              ? log.detail
                              : JSON.stringify(log.detail, null, 2)}
                          </pre>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
