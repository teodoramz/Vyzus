// Global header: totals (apps up/down), bell badge linking to the Incidents
// tab (the persistent ambient signal; transient "just happened"
// notifications are ToastProvider's job, on the WS incident.opened event).
// The badge counts *unseen* open incidents, not just open ones — visiting
// the Incidents tab marks everything currently open as seen (seenIncidents.ts),
// so the number clears once you've actually looked, and only climbs back up
// for incidents that opened after that.
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { statsApi, incidentsApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { useDarkMode } from '../hooks/useDarkMode';
import { useConnectionState } from '../ws/RealtimeProvider';
import { getSeenIncidentIds } from '../lib/seenIncidents';
import { VyzusMark } from './VyzusMark';
import { SunIcon, MoonIcon } from './icons';

function BellIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive
      ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
      : 'text-slate-600 hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-white/10'
  }`;

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const [dark, toggleDark] = useDarkMode();
  const connection = useConnectionState();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: statsApi.get, refetchInterval: 30_000 });
  const { data: openIncidents } = useQuery({
    queryKey: ['incidents', 'open-for-badge'],
    queryFn: () => incidentsApi.list({ open: true, limit: 100 }),
    refetchInterval: 30_000,
  });
  const { data: seenIds } = useQuery({
    queryKey: ['seenIncidentIds'],
    queryFn: () => getSeenIncidentIds(),
    staleTime: Infinity, // only ever changes via qc.setQueryData from the Incidents page
  });
  const unseenCount = (openIncidents?.incidents ?? []).filter((i) => !seenIds?.has(i.id)).length;

  return (
    <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
        <NavLink
          to="/"
          className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-slate-900 dark:text-zinc-100"
        >
          <VyzusMark size={24} />
          Vyzus
        </NavLink>

        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={navLinkClass}>
            Overview
          </NavLink>
          <NavLink to="/incidents" className={navLinkClass}>
            Incidents
          </NavLink>
          <NavLink to="/channels" className={navLinkClass}>
            Channels
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/users" className={navLinkClass}>
              Users
            </NavLink>
          )}
          <NavLink to="/settings" className={navLinkClass}>
            Settings
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-4 text-sm">
          {stats && (
            <div className="hidden items-center gap-3 font-mono tabular-nums sm:flex" aria-label="application totals">
              <span className="flex items-center gap-1 text-green-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-green-600 dark:bg-emerald-400" /> {stats.apps.up} up
              </span>
              {stats.apps.degraded > 0 && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" /> {stats.apps.degraded}{' '}
                  degraded
                </span>
              )}
              <span className="flex items-center gap-1 text-red-600 dark:text-rose-500">
                <span className="h-1.5 w-1.5 rounded-full bg-red-600 dark:bg-rose-500" /> {stats.apps.down} down
              </span>
            </div>
          )}

          <NavLink
            to="/incidents"
            className="relative rounded-lg p-1.5 text-slate-600 hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-white/10"
            aria-label={unseenCount > 0 ? `${unseenCount} unread incidents` : 'Incidents'}
            title={
              unseenCount > 0
                ? `${unseenCount} unread incident${unseenCount === 1 ? '' : 's'}${stats ? ` (${stats.openIncidents} open total)` : ''}`
                : 'Incidents'
            }
          >
            <BellIcon />
            {unseenCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 font-mono text-[10px] font-semibold leading-none text-white">
                {unseenCount > 99 ? '99+' : unseenCount}
              </span>
            )}
          </NavLink>

          <span
            className={`hidden items-center gap-1 rounded-full px-2 py-0.5 text-xs md:inline-flex ${
              connection === 'open'
                ? 'bg-emerald-500/10 text-green-600 dark:text-emerald-400'
                : connection === 'connecting'
                  ? 'bg-gray-400/10 text-slate-500 dark:text-zinc-500'
                  : 'bg-amber-400/10 text-amber-600 dark:text-amber-400'
            }`}
            title={
              connection === 'open'
                ? 'Live updates connected'
                : connection === 'connecting'
                  ? 'Connecting…'
                  : 'Polling every 30s (WS unavailable)'
            }
          >
            {connection === 'open' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Polling'}
          </span>

          <button
            type="button"
            onClick={toggleDark}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-gray-100 dark:text-zinc-400 dark:hover:bg-white/10"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </button>

          {user && (
            <div className="flex items-center gap-2">
              <span className="hidden font-mono text-slate-500 dark:text-zinc-500 lg:inline">{user.email}</span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-lg border border-gray-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-gray-100 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10"
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
