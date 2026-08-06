// FR-4.2 "incident timeline" — GET /apps/:id/incidents.
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { appsApi } from '../api/endpoints';
import { formatDateTime } from '../lib/format';

function formatDowntime(seconds: number | null): string {
  if (seconds === null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function IncidentTimeline({
  appId,
  highlightIncidentId,
}: {
  appId: string;
  /** Scrolled to and briefly highlighted once loaded — deep link from the incident banner. */
  highlightIncidentId?: string | null;
}): JSX.Element {
  const {
    data: incidents,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['incidents', 'app', appId],
    queryFn: () => appsApi.incidents(appId),
    retry: false,
  });
  const highlightedRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (highlightIncidentId && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightIncidentId, incidents]);

  if (isLoading) return <p className="text-sm text-slate-400 dark:text-zinc-500">Loading incidents…</p>;
  if (error) return <p className="text-sm text-slate-400 dark:text-zinc-500">Incident history unavailable.</p>;
  if (!incidents || incidents.length === 0)
    return <p className="text-sm text-slate-400 dark:text-zinc-500">No incidents recorded.</p>;

  const sorted = [...incidents].sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());

  return (
    <ol className="space-y-3">
      {sorted.map((inc) => {
        const open = inc.resolvedAt === null;
        const highlighted = inc.id === highlightIncidentId;
        return (
          <li
            key={inc.id}
            id={`incident-${inc.id}`}
            ref={highlighted ? highlightedRef : undefined}
            className={`flex gap-3 rounded-lg border p-3 transition-colors ${
              highlighted
                ? 'border-cyan-500 dark:border-cyan-400 bg-cyan-500/10 dark:bg-cyan-400/10 dark:border-cyan-500 dark:border-cyan-400'
                : 'border-gray-200 dark:border-white/10'
            }`}
          >
            <div
              className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${open ? 'bg-red-600 dark:bg-rose-500' : 'bg-green-600 dark:bg-emerald-400'}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`font-medium ${open ? 'text-red-600 dark:text-rose-500' : 'text-green-600 dark:text-emerald-400'}`}
                >
                  {open ? 'Open' : 'Resolved'}
                </span>
                {inc.checkName && <span className="text-slate-400 dark:text-zinc-500">{inc.checkName}</span>}
                <span className="text-slate-400 dark:text-zinc-500">
                  downtime {formatDowntime(inc.downtimeSeconds)}
                </span>
              </div>
              <div className="text-slate-600 dark:text-zinc-400">
                Opened {formatDateTime(inc.openedAt)}
                {inc.resolvedAt && <> · Resolved {formatDateTime(inc.resolvedAt)}</>}
              </div>
              {inc.openingRunId && (
                <Link
                  to={`/runs/${inc.openingRunId}`}
                  className="text-xs text-cyan-600 dark:text-cyan-400 hover:underline"
                >
                  View triggering run
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
