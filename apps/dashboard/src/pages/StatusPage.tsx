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
import { VyzusMark } from '../components/VyzusMark';

const TONE: Record<AppStatus, { dot: string; label: string; text: string }> = {
  UP: { dot: 'bg-emerald-500', label: 'Operational', text: 'text-emerald-700 dark:text-emerald-400' },
  DEGRADED: { dot: 'bg-amber-500', label: 'Degraded', text: 'text-amber-700 dark:text-amber-400' },
  DOWN: { dot: 'bg-red-500', label: 'Down', text: 'text-red-700 dark:text-red-400' },
  PAUSED: { dot: 'bg-slate-400', label: 'Paused', text: 'text-slate-600 dark:text-zinc-400' },
  UNKNOWN: { dot: 'bg-slate-400', label: 'Unknown', text: 'text-slate-600 dark:text-zinc-400' },
};

/**
 * The headline states the answer in plain words. A visitor came here for one
 * thing, so "Degraded" — the internal enum label — is not what they should
 * read first; how many services and in what condition is.
 */
function headline(overall: AppStatus, apps: { status: AppStatus }[]): string {
  if (apps.length === 0) return 'No services published';
  const down = apps.filter((a) => a.status === 'DOWN').length;
  const degraded = apps.filter((a) => a.status === 'DEGRADED').length;
  if (down > 0) return `${down} ${down === 1 ? 'service is' : 'services are'} down`;
  if (degraded > 0) return `${degraded} ${degraded === 1 ? 'service is' : 'services are'} degraded`;
  if (overall === 'UP') return 'All systems operational';
  return TONE[overall].label;
}

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

  if (isLoading) return <p className="mx-auto max-w-3xl px-4 py-16 text-sm text-slate-400">Checking…</p>;
  if (isError || !data) {
    return (
      <p role="alert" className="mx-auto max-w-3xl px-4 py-16 text-sm text-red-600 dark:text-rose-400">
        This page could not reach the monitoring service, so the status below may be out of date. Try again shortly.
      </p>
    );
  }

  const overall = TONE[data.overall];
  const title = headline(data.overall, data.applications);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <div className="flex items-center gap-2.5">
        <VyzusMark size={22} />
        <span className="text-sm font-medium text-slate-500 dark:text-zinc-400">{data.title}</span>
      </div>

      {/* The answer, at the size of the question. The status dot is the only
          saturated colour on the page, so it reads before the words do. */}
      <div className="mt-8 flex items-start gap-4">
        <span className={`mt-2.5 h-3.5 w-3.5 shrink-0 rounded-full ${overall.dot}`} aria-hidden="true" />
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl dark:text-zinc-100">
            {title}
          </h1>
          <p className="mt-2 text-sm text-slate-400 dark:text-zinc-500">Checked {formatDateTime(data.generatedAt)}</p>
        </div>
      </div>

      {data.applications.length === 0 ? (
        <p className="mt-12 rounded-lg border border-dashed border-gray-300 px-4 py-6 text-sm text-slate-500 dark:border-white/10 dark:text-zinc-400">
          Nothing is published here yet. Mark an application as public in its settings and it will appear on this page.
        </p>
      ) : (
        <ul className="mt-12 divide-y divide-gray-200 dark:divide-white/10">
          <li className="flex items-center justify-between gap-4 pb-2 text-[11px] uppercase tracking-wide text-slate-400 dark:text-zinc-600">
            <span>Service</span>
            <span className="flex shrink-0 items-center gap-6">
              <span className="w-16 text-right">24 hours</span>
              <span className="w-16 text-right">30 days</span>
              <span className="w-24 text-right">Status</span>
            </span>
          </li>
          {data.applications.map((a) => {
            const tone = TONE[a.status];
            return (
              <li key={a.id} className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
                  <span className="truncate text-slate-900 dark:text-zinc-100">{a.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-6 text-sm">
                  <span className="w-16 text-right tabular-nums text-slate-500 dark:text-zinc-400">
                    {pct(a.availability24h)}
                  </span>
                  <span className="w-16 text-right tabular-nums text-slate-400 dark:text-zinc-500">
                    {pct(a.availability30d)}
                  </span>
                  <span className={`w-24 text-right font-medium ${tone.text}`}>{tone.label}</span>
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

      <p className="mt-12 text-xs text-slate-400 dark:text-zinc-500">
        Percentages are checks that passed in each window.
      </p>
    </main>
  );
}
