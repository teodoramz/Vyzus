// First-boot screen: creates the initial admin account when the instance has
// no users at all. Reached only via the redirect in Login (which polls
// GET /auth/setup-status); once any user exists the API returns 409 here
// permanently and every further account is created from the admin Users page.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/http';
import { VyzusMark } from '../components/VyzusMark';
import { AmbientBackground } from '../components/AmbientBackground';

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
            <label htmlFor="setup-email" className="mb-1 block text-sm font-medium text-slate-600 dark:text-zinc-400">
              Email
            </label>
            <input
              id="setup-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div>
            <label
              htmlFor="setup-password"
              className="mb-1 block text-sm font-medium text-slate-600 dark:text-zinc-400"
            >
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
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>

          <div>
            <label htmlFor="setup-confirm" className="mb-1 block text-sm font-medium text-slate-600 dark:text-zinc-400">
              Confirm password
            </label>
            <input
              id="setup-confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
            />
            {mismatch && <p className="mt-1 text-xs text-red-600 dark:text-rose-400">Passwords do not match.</p>}
            {tooShort && !mismatch && (
              <p className="mt-1 text-xs text-red-600 dark:text-rose-400">
                Password must be at least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-red-600 dark:text-rose-400">
              {error}
            </p>
          )}

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
