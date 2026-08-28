// First-boot screen: creates the initial admin when the instance has no users.
// Reached via the redirect in Login; every later account comes from the admin
// Users page.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/http';
import { VyzusMark } from '../components/VyzusMark';
import { AmbientBackground } from '../components/AmbientBackground';
import { inputClass, labelClass } from '../components/formFields';
import { ErrorBanner } from '../components/ErrorBanner';

const MIN_PASSWORD_LENGTH = 8;

export function Setup(): JSX.Element {
  const { setup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit = email.length > 0 && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await setup({ email, password });
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
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-zinc-900">
        <div className="mb-1 flex items-center gap-2.5 text-lg font-semibold tracking-tight text-slate-900 dark:text-zinc-100">
          <VyzusMark size={26} />
          Vyzus
        </div>
        <h1 className="mb-1 text-sm font-medium text-slate-900 dark:text-zinc-100">Create the first administrator</h1>
        <p className="mb-6 text-sm text-slate-500 dark:text-zinc-400">
          This instance has no users yet. The account you create here is a full administrator and can invite everyone
          else from the Users page.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="setup-email" className={labelClass}>
              Email
            </label>
            <input
              id="setup-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="setup-password" className={labelClass}>
              Password
            </label>
            <input
              id="setup-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>

          <div>
            <label htmlFor="setup-confirm" className={labelClass}>
              Confirm password
            </label>
            <input
              id="setup-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />
            {mismatch && <p className="mt-1 text-xs text-red-600 dark:text-rose-400">Passwords do not match.</p>}
            {tooShort && !mismatch && (
              <p className="mt-1 text-xs text-red-600 dark:text-rose-400">
                Password must be at least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          <ErrorBanner message={error} />

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 px-3 py-2 text-sm font-semibold text-zinc-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Creating account...' : 'Create administrator'}
          </button>
        </form>
      </div>
    </div>
  );
}
