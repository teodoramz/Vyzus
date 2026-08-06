// Dedicated Incidents tab (replaces the old always-visible banner — see
// RealtimeProvider's toast on incident.opened for the "just happened"
// notification, and Header's bell badge for the ambient count). Cross-app,
// paginated, filterable to open-only.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { incidentsApi } from '../api/endpoints';
import { PagerControls } from '../components/PagerControls';
import { usePagedCursor } from '../hooks/usePagedCursor';
import { markIncidentsSeen } from '../lib/seenIncidents';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 20;

function formatDowntime(seconds: number | null): string {
  if (seconds === null) return 'ongoing';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function Incidents(): JSX.Element {
  const qc = useQueryClient();
  const [openOnly, setOpenOnly] = useState(false);
  const pager = usePagedCursor();

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOnly]);

  const query = useQuery({
    queryKey: ['incidents', 'page', { open: openOnly }, pager.cursor],
    queryFn: () => incidentsApi.list({ open: openOnly || undefined, cursor: pager.cursor, limit: PAGE_SIZE }),
  });

  // Visiting this page means "I read the incidents" — clear the header's
  // bell badge by marking every *currently open* incident as seen (not just
  // whatever happens to be on the current filtered/paginated view), so
  // switching to "Open only" or paging around doesn't under- or over-mark.
  const { data: allOpenForSeen } = useQuery({
    queryKey: ['incidents', 'open-for-seen'],
    queryFn: () => incidentsApi.list({ open: true, limit: 100 }),
  });
  useEffect(() => {
    if (!allOpenForSeen) return;
    const updated = markIncidentsSeen(allOpenForSeen.incidents.map((i) => i.id));
    qc.setQueryData(['seenIncidentIds'], updated);
  }, [allOpenForSeen, qc]);

  const incidents = query.data?.incidents ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Incidents</h1>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open only
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-slate-400 dark:text-zinc-500">Loading incidents…</p>}
      {query.isError && <p className="text-sm text-red-600 dark:text-rose-500">Failed to load incidents.</p>}
      {!query.isLoading && incidents.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-zinc-500">
          {openOnly
            ? 'All clear — nothing open right now.'
            : 'Nothing recorded yet. A quiet history is a good history.'}
        </p>
      )}

      {incidents.length > 0 && (
        <ol className="space-y-3">
          {incidents.map((inc) => {
            const open = inc.resolvedAt === null;
            return (
              <li key={inc.id} className="flex gap-3 rounded-lg border border-gray-200 p-3 dark:border-white/10">
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
                    {inc.appId ? (
                      <Link
                        to={`/apps/${inc.appId}?check=${inc.checkId}&incident=${inc.id}`}
                        className="font-medium hover:underline"
                      >
                        {inc.appName} — {inc.checkName}
                      </Link>
                    ) : (
                      <span>{inc.checkName ?? 'Check'}</span>
                    )}
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
      )}

      <PagerControls
        page={pager.page}
        canGoPrev={pager.canGoPrev}
        canGoNext={query.data?.nextCursor != null}
        onPrev={pager.goPrev}
        onNext={() => pager.goNext(query.data?.nextCursor)}
        disabled={query.isFetching}
      />
    </div>
  );
}
