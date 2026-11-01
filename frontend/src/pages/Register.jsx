import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

// Create account — route "/shop/register". Real registration against
// POST /api/customers/register (name, valid email, password ≥ 8 chars;
// duplicate emails get a 409 the API explains).
export default function Register() {
  const { signup, loading } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await signup(name.trim(), email.trim(), password);
      navigate('/shop');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="shell">
      <div className="page-head">
        <h1 className="page-title">Create Account</h1>
      </div>
      <form className="form-card" onSubmit={submit}>
        <div className="field">
          <label htmlFor="regName">Full Name</label>
          <input
            id="regName"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="regEmail">Email</label>
          <input
            id="regEmail"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="regPassword">Password (8+ characters)</label>
          <input
            id="regPassword"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn-green" type="submit" disabled={loading}>
          {loading ? 'Creating Account…' : 'Create Account'}
        </button>
        <p className="form-switch">
          Already have an account? <Link to="/shop/login">Log in</Link>
        </p>
      </form>
    </main>
  );
}
