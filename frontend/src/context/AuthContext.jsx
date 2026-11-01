import React, { createContext, useState, useCallback, useEffect } from 'react';
import {
  registerCustomer,
  loginCustomer,
  fetchCustomerMe,
  getCustomerToken,
  clearCustomerToken,
} from '../services/customersApi';

// Auth + age-verification state — ported from the live shop's
// AuthContext. The user object is built from a REAL customer profile
// returned by the API instead of being invented client-side.
export const AuthContext = createContext();

function toUserProfile(customer) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    identifier: customer.email,
    createdAt: customer.createdAt,
  };
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [ageVerified, setAgeVerified] = useState(() => {
    try {
      return localStorage.getItem('ageVerified') === 'true';
    } catch {
      return false;
    }
  });
  const [zip, setZip] = useState(() => {
    try {
      return localStorage.getItem('zip') || '';
    } catch {
      return '';
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      if (user) localStorage.setItem('user', JSON.stringify(user));
      else localStorage.removeItem('user');
    } catch {
      // Storage unavailable — session just won't persist.
    }
  }, [user]);

  useEffect(() => {
    try {
      localStorage.setItem('ageVerified', String(ageVerified));
    } catch {
      // ignore
    }
  }, [ageVerified]);

  useEffect(() => {
    try {
      if (zip) localStorage.setItem('zip', zip);
    } catch {
      // ignore
    }
  }, [zip]);

  const verifyAge = useCallback(async (zipCode) => {
    setAgeVerified(true);
    setZip(zipCode);
    return true;
  }, []);

  // Real sign-in against POST /api/customers/login. Throws on failure so
  // callers can show the message and stay on the form.
  const login = useCallback(async (identifier, password) => {
    setLoading(true);
    setError('');
    try {
      const data = await loginCustomer(String(identifier || '').trim(), password);
      const profile = toUserProfile(data.customer);
      setUser(profile);
      return profile;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearCustomerToken();
    setUser(null);
    setError('');
  }, []);

  // Real registration against POST /api/customers/register. Resolves to
  // the new customer's profile — including its real id (the first
  // account ever registered is customer 1). Throws on failure, e.g. a
  // duplicate email (409) or an unreachable API.
  const signup = useCallback(async (name, email, password) => {
    setLoading(true);
    setError('');
    try {
      const data = await registerCustomer(name, email, password);
      const profile = toUserProfile(data.customer);
      setUser(profile);
      return profile;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Validate a restored session once on load: if a customer token is
  // stored, ask the API who it belongs to and refresh the profile. A 401
  // means the token is dead — drop the session. A network failure means
  // the API can't be reached right now; keep the local profile.
  useEffect(() => {
    if (!getCustomerToken()) return undefined;
    let cancelled = false;
    fetchCustomerMe()
      .then((data) => {
        if (!cancelled && data && data.customer) setUser(toUserProfile(data.customer));
      })
      .catch((err) => {
        if (!cancelled && err && err.status === 401) {
          clearCustomerToken();
          setUser(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = {
    user,
    ageVerified,
    zip,
    loading,
    error,
    verifyAge,
    login,
    logout,
    signup,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
