// Bento-grid card for the overview: FR-4.1 (status/availability/response/
// sparkline/screenshot) + FR-4.4 (on-demand screenshot + run-now). Reads
// lastResponseTimeMs/recentDurationsMs/checkStatuses straight off the
// AppSummary embed (apps/api/src/routes/apps.ts) instead of a per-card
// checks+runs fetch — the fields exist precisely to keep the grid a single
// request (NFR-1), so no useAppRunHistory-style N+1 here.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppStatus, AppSummary, RunStatus } from '@vyzus/shared';
import { appsApi, checksApi } from '../api/endpoints';
import { MiniAreaChart } from './MiniAreaChart';
import { ScreenshotThumb } from './ScreenshotThumb';
import { Spinner } from './Spinner';
import { waitForRunCompletion } from '../lib/waitForRun';
import { formatMs, formatPercent, formatRelativeTime } from '../lib/format';

const STATUS_STYLE: Record<AppStatus, { dot: string; text: string }> = {
  UP: { dot: 'bg-green-600 dark:bg-emerald-400', text: 'text-green-600 dark:text-emerald-400' },
  DEGRADED: { dot: 'bg-amber-500 dark:bg-amber-400', text: 'text-amber-600 dark:text-amber-400' },
  DOWN: { dot: 'bg-red-600 dark:bg-rose-500', text: 'text-red-600 dark:text-rose-500' },
  PAUSED: { dot: 'bg-slate-400 dark:bg-zinc-600', text: 'text-slate-500 dark:text-zinc-500' },
  UNKNOWN: { dot: 'bg-slate-300 dark:bg-zinc-700', text: 'text-slate-400 dark:text-zinc-500' },
};

const JOURNEY_STYLE: Record<RunStatus, { text: string; label: string }> = {
  passed: { text: 'text-green-600 dark:text-emerald-400', label: 'PASS' },
  failed: { text: 'text-red-600 dark:text-rose-500', label: 'FAIL' },
  error: { text: 'text-red-600 dark:text-rose-500', label: 'ERROR' },
  timeout: { text: 'text-amber-600 dark:text-amber-400', label: 'TIMEOUT' },
};

function JourneyStatus({ app }: { app: AppSummary }): JSX.Element {
  const journey = app.checkStatuses?.find((c) => c.type === 'journey');
  if (!journey) {
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-400 dark:text-zinc-600">
        <span className="flex h-4 w-4 items-center justify-center rounded border border-gray-200 text-[9px] dark:border-white/10">
          ▶
        </span>
        no journey check
      </div>
    );
  }
  const style = journey.lastStatus
    ? JOURNEY_STYLE[journey.lastStatus]
    : { text: 'text-slate-400 dark:text-zinc-600', label: 'PENDING' };
  return (
    <div className="flex items-center gap-1.5 font-mono text-[11px]">
      <span className="flex h-4 w-4 items-center justify-center rounded border border-gray-200 text-[9px] text-slate-500 dark:border-white/10 dark:text-zinc-500">
        ▶
      </span>
      <span className="text-slate-400 dark:text-zinc-600">journey</span>
      <span className={`font-semibold ${style.text}`}>{style.label}</span>
    </div>
  );
}

export function AppCard({ app, prominent = false }: { app: AppSummary; prominent?: boolean }): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'run' | 'screenshot' | null>(null);
  const style = STATUS_STYLE[app.status];
  const sparkStatus =
    app.status === 'UP' ? 'good' : app.status === 'DOWN' || app.status === 'DEGRADED' ? 'critical' : 'neutral';

  const runNow = useMutation({
    mutationFn: async () => {
      const checks = await checksApi.listForApp(app.id);
      const uptime = checks.find((c) => c.type === 'uptime') ?? checks[0];
      if (!uptime) throw new Error('No checks configured');
      const { runId } = await checksApi.runNow(uptime.id);
      await waitForRunCompletion(runId); // keep the button busy for the real run, not just the enqueue
    },
    onMutate: () => setBusy('run'),
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });

  const screenshotNow = useMutation({
    mutationFn: async () => {
      const { runId } = await appsApi.screenshotNow(app.id);
      await waitForRunCompletion(runId);
    },
    onMutate: () => setBusy('screenshot'),
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });

  return (
    <div
      className={`group flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-colors dark:border-white/10 dark:bg-zinc-900 ${
        prominent ? 'ring-1 ring-rose-500/30' : ''
      }`}
    >
      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Name and status lead; the screenshot is corroboration, not the
            headline. At thumbnail size it answers "is the page still there and
            does it still look like itself" — the detail view is where a
            screenshot is worth reading. */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              to={`/apps/${app.id}`}
              className="flex items-center gap-2 truncate font-semibold text-slate-900 hover:underline dark:text-zinc-100"
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span
                  className={`motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${style.dot}`}
                />
                <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
              </span>
              <span className="truncate">{app.name}</span>
            </Link>
            <p className="truncate font-mono text-xs text-slate-400 dark:text-zinc-500">{app.landingUrl}</p>
            {app.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {app.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-white/10 dark:text-zinc-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className={`font-mono text-xs font-bold tracking-wide ${style.text}`}>{app.status}</span>
            <Link
              to={`/apps/${app.id}`}
              className="block h-14 w-24 overflow-hidden rounded-md border border-gray-200 dark:border-white/10"
              aria-label={`${app.name} latest screenshot`}
            >
              <ScreenshotThumb
                runId={app.latestScreenshotRunId}
                alt={`${app.name} latest screenshot`}
                className="h-full w-full"
              />
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-zinc-600">
              Availability 24h
            </div>
            <div className="font-mono text-sm font-medium text-slate-900 dark:text-zinc-100">
              {formatPercent(app.availability24h)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-zinc-600">Last response</div>
            <div className="font-mono text-sm font-medium text-slate-900 dark:text-zinc-100">
              {formatMs(app.lastResponseTimeMs ?? null)}
            </div>
          </div>
        </div>

        <MiniAreaChart values={app.recentDurationsMs ?? []} status={sparkStatus} />

        <div className="flex items-center justify-between">
          <JourneyStatus app={app} />
          <span className="font-mono text-[11px] text-slate-400 dark:text-zinc-600">
            {formatRelativeTime(app.lastRun)}
          </span>
        </div>

        <div className="mt-auto flex gap-2 pt-2">
          <button
            type="button"
            disabled={busy !== null || !app.enabled}
            onClick={() => runNow.mutate()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10"
          >
            {busy === 'run' && <Spinner className="h-3 w-3" />}
            {busy === 'run' ? 'Running…' : 'Run now'}
          </button>
          <button
            type="button"
            disabled={busy !== null || !app.enabled}
            onClick={() => screenshotNow.mutate()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/10"
          >
            {busy === 'screenshot' && <Spinner className="h-3 w-3" />}
            {busy === 'screenshot' ? 'Capturing…' : 'Screenshot'}
          </button>
        </div>
      </div>
    </div>
  );
}
