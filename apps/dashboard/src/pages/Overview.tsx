// FR-4.1 Overview grid: one card per application, tag/status filters, live via
// WS (RealtimeProvider invalidates ['apps'] on run.finished / incident.* /
// the 30s poll fallback tick).
//
// DOWN apps still sort first — the whole point of the grid is instant
// incident triage, so the thing that needs attention is the first thing you
// see, not buried alphabetically. Card *size* no longer follows status
// though: every card is the same size once there are 3+ apps, so the grid
// reads as a consistent wall rather than a patchwork. With only 1-2 apps
// total there's nothing to be consistent WITH, so those get to stretch and
// actually use the screen instead of sitting in a lonely 320px column.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AppStatus, AppSummary } from '@vyzus/shared';
import { appsApi } from '../api/endpoints';
import { AppCard } from '../components/AppCard';
import { NewAppModal } from '../components/NewAppModal';
import { StatusBadge } from '../components/StatusBadge';
import { useAuth } from '../auth/AuthContext';

const STATUS_OPTIONS: AppStatus[] = ['UP', 'DOWN', 'PAUSED', 'UNKNOWN'];
const TRIAGE_ORDER: Record<AppStatus, number> = { DOWN: 0, UNKNOWN: 1, UP: 2, PAUSED: 3 };

export function Overview(): JSX.Element {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  const [statusFilter, setStatusFilter] = useState<AppStatus | ''>('');
  const [tagFilter, setTagFilter] = useState('');
  const [showNew, setShowNew] = useState(false);

  const {
    data: apps,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['apps', { status: statusFilter || undefined, tag: tagFilter || undefined }],
    queryFn: () => appsApi.list({ status: statusFilter || undefined, tag: tagFilter || undefined }),
    refetchInterval: 30_000,
  });

  const sorted: AppSummary[] = useMemo(
    () => [...(apps ?? [])].sort((a, b) => TRIAGE_ORDER[a.status] - TRIAGE_ORDER[b.status]),
    [apps],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps ?? []) for (const t of a.tags) set.add(t);
    return [...set].sort();
  }, [apps]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-zinc-100">Applications</h1>
        {canEdit && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 px-3 py-2 text-sm font-semibold text-zinc-950 hover:opacity-90"
          >
            + New application
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter((cur) => (cur === s ? '' : s))}
              className={`rounded-full transition-opacity ${statusFilter && statusFilter !== s ? 'opacity-40' : 'opacity-100'}`}
            >
              <StatusBadge status={s} size="sm" />
            </button>
          ))}
        </div>

        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-slate-700 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}

        {(statusFilter || tagFilter) && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter('');
              setTagFilter('');
            }}
            className="text-sm text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading && <p className="text-slate-400 dark:text-zinc-500">Loading applications…</p>}
      {error && <p className="text-red-600 dark:text-rose-500">Failed to load applications.</p>}

      {apps && apps.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 p-10 text-center text-slate-400 dark:border-white/10 dark:text-zinc-500">
          Nothing to watch over yet. Add an application and Vyzus will start keeping an eye on it.
        </div>
      )}

      {apps && apps.length > 0 && !statusFilter && !tagFilter && apps.every((a) => a.status === 'UP') && (
        <p className="flex items-center gap-2 text-sm text-slate-400 dark:text-zinc-500">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-green-600 dark:bg-emerald-400" />
          All quiet — everything's up.
        </p>
      )}

      {/* auto-rows-fr: CSS Grid sizes each row to its own tallest item, so
          without it a row of cards that all have tags ends up taller than a
          row where none do (or where a check has too few runs to draw a
          sparkline). Equal rows make every card the same size across the whole
          grid, not just within a row. */}
      {apps && apps.length > 0 && (
        <div
          className={`grid auto-rows-fr grid-cols-1 gap-4 ${
            sorted.length === 1 ? '' : sorted.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3'
          }`}
        >
          {sorted.map((app) => (
            <AppCard key={app.id} app={app} prominent={app.status === 'DOWN'} />
          ))}
        </div>
      )}

      {showNew && <NewAppModal onClose={() => setShowNew(false)} />}
    </div>
  );
}
