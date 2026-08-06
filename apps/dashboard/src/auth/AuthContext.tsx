// Auth state: in-memory access token (never persisted) + current user. On
// mount we attempt a silent refresh against the httpOnly cookie so a reload
// doesn't force a re-login while the refresh token is still valid. Any 401
// surfaced by the API client (registerAuthFailureHandler) clears state so
// ProtectedRoute redirects to /login.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User, LoginBody, SetupBody } from '@vyzus/shared';
import { authApi } from '../api/endpoints';
import { getAccessToken, setAccessToken, onAccessTokenChange } from './tokenStore';
import { registerAuthFailureHandler } from '../api/http';

interface AuthContextValue {
  user: User | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  login: (body: LoginBody) => Promise<void>;
  /** First-boot only: creates the initial admin and signs them straight in. */
  setup: (body: SetupBody) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading');

  useEffect(() => {
    registerAuthFailureHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
  }, []);

  useEffect(() => {
    return onAccessTokenChange((token) => {
      if (!token) {
        setUser(null);
        setStatus((s) => (s === 'loading' ? s : 'unauthenticated'));
      }
    });
  }, []);

  // Silent refresh on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { accessToken } = await authApi.refresh();
        if (cancelled) return;
        setAccessToken(accessToken);
        const me = await authApi.me();
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setUser(null);
          setStatus('unauthenticated');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (body: LoginBody) => {
    const res = await authApi.login(body);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  const setup = useCallback(async (body: SetupBody) => {
    const res = await authApi.setup(body);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setAccessToken(null);
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  const value = useMemo(() => ({ user, status, login, setup, logout }), [user, status, login, setup, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Non-hook accessor for code outside React (rare; prefer useAuth). */
export function currentAccessToken(): string | null {
  return getAccessToken();
}
