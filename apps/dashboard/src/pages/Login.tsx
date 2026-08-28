import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/http';
import { VyzusMark } from '../components/VyzusMark';
import { AmbientBackground } from '../components/AmbientBackground';
import { inputClass, labelClass } from '../components/formFields';
import { ErrorBanner } from '../components/ErrorBanner';

export function Login(): JSX.Element {
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A brand-new instance has no users at all — send the operator to the
  // first-boot setup screen instead of a login form they cannot possibly
  // satisfy. Cheap, unauthenticated, and only ever true once per install.
  const { data: setupStatus } = useQuery({
    queryKey: ['auth', 'setup-status'],
    queryFn: authApi.setupStatus,
    staleTime: 60_000,
  });

  if (status === 'authenticated') {
    const from = (location.state as { from?: Location })?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  if (setupStatus?.needsSetup) return <Navigate to="/setup" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not reach the server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <AmbientBackground />
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-zinc-900">
        <div className="mb-6 flex items-center gap-2.5 text-lg font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
          <VyzusMark size={26} />
          Vyzus
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>
          <ErrorBanner message={error} />
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
