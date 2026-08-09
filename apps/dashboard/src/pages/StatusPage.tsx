// Public status page. Rendered outside ProtectedRoute — it is the one view that
// must work with no session at all.
//
// It deliberately shows less than the internal dashboard: names, status and
// uptime only. The API enforces that (see apps/api/src/routes/status.ts); this
// component simply has nothing else to render.
import { useQuery } from '@tanstack/react-query';
import type { AppStatus } from '@vyzus/shared';
import { statusApi } from '../api/endpoints';
import { formatDateTime } from '../lib/format';

const TONE: Record<AppStatus, { dot: string; label: string; text: string }> = {
  UP: { dot: 'bg-emerald-500', label: 'Operational', text: 'text-emerald-700 dark:text-emerald-400' },
  DEGRADED: { dot: 'bg-amber-500', label: 'Degraded', text: 'text-amber-700 dark:text-amber-400' },
  DOWN: { dot: 'bg-red-500', label: 'Down', text: 'text-red-700 dark:text-red-400' },
  PAUSED: { dot: 'bg-slate-400', label: 'Paused', text: 'text-slate-600 dark:text-zinc-400' },
  UNKNOWN: { dot: 'bg-slate-400', label: 'Unknown', text: 'text-slate-600 dark:text-zinc-400' },
};

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);

function humanDowntime(seconds: number | null): string {
  if (seconds === null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function StatusPage(): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['status-page'],
    queryFn: () => statusApi.get(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="p-8 text-center text-slate-400">Loading…</p>;
  if (isError || !data) return <p className="p-8 text-center text-red-600">Status is unavailable right now.</p>;

  const overall = TONE[data.overall];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-zinc-100">{data.title}</h1>

      <div className="mt-4 flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 dark:border-white/10">
        <span className={`h-3 w-3 rounded-full ${overall.dot}`} aria-hidden="true" />
        <span className={`font-medium ${overall.text}`}>
          {data.overall === 'UP' ? 'All systems operational' : overall.label}
        </span>
      </div>

      {data.applications.length === 0 ? (
        <p className="mt-8 text-sm text-slate-400 dark:text-zinc-500">No services are published yet.</p>
      ) : (
        <ul className="mt-8 divide-y divide-gray-200 dark:divide-white/10">
          {data.applications.map((a) => {
            const tone = TONE[a.status];
            return (
              <li key={a.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <span className="truncate text-slate-900 dark:text-zinc-100">{a.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-6 text-sm">
                  <span className="tabular-nums text-slate-500 dark:text-zinc-400" title="Last 24 hours">
                    {pct(a.availability24h)}
                  </span>
                  <span className="tabular-nums text-slate-400 dark:text-zinc-500" title="Last 30 days">
                    {pct(a.availability30d)}
                  </span>
                  <span className={`w-24 text-right ${tone.text}`}>{tone.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400">
        Recent incidents
      </h2>
      {data.recentIncidents.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400 dark:text-zinc-500">No incidents in the last 30 days.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {data.recentIncidents.map((i) => (
            <li key={i.id} className="rounded border border-gray-200 px-3 py-2 text-sm dark:border-white/10">
              <span className="font-medium text-slate-900 dark:text-zinc-100">{i.appName}</span>
              <span className="text-slate-500 dark:text-zinc-400">
                {' '}
                — {formatDateTime(i.openedAt)}
                {i.resolvedAt ? `, resolved after ${humanDowntime(i.downtimeSeconds)}` : ', ongoing'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-10 text-xs text-slate-400 dark:text-zinc-500">
        Updated {formatDateTime(data.generatedAt)}. Percentages are passing checks over the last 24 hours and 30 days.
      </p>
    </main>
  );
}
