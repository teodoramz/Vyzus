// Run history merged across every check of the app (not scoped to whichever
// check tab is selected), filterable by both check and status, per
// GET /apps/:id/runs (`?checkId=`, `?status=`). Real prev/next pagination —
// one page in view at a time, not an ever-growing accumulated list.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { RunStatus } from '@vyzus/shared';
import { RUN_STATUSES } from '@vyzus/shared';
import { appsApi } from '../api/endpoints';
import { RunStatusBadge } from './RunStatusBadge';
import { PagerControls } from './PagerControls';
import { CameraIcon, TraceIcon } from './icons';
import { usePagedCursor } from '../hooks/usePagedCursor';
import { formatDateTime, formatMs } from '../lib/format';

const PAGE_SIZE = 15;

export function AppRunHistoryTable({
  appId,
  checks,
}: {
  appId: string;
  checks: { id: string; name: string }[];
}): JSX.Element {
  const [status, setStatus] = useState<RunStatus | ''>('');
  const [checkId, setCheckId] = useState('');
  const pager = usePagedCursor();

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, checkId]);

  const query = useQuery({
    queryKey: ['runs', 'app', appId, { status: status || undefined, checkId: checkId || undefined }, pager.cursor],
    queryFn: () =>
      appsApi.runs(appId, {
        cursor: pager.cursor,
        limit: PAGE_SIZE,
        status: status || undefined,
        checkId: checkId || undefined,
      }),
  });

  const runs = query.data?.runs ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="run-check-filter" className="text-xs text-slate-400 dark:text-zinc-500">
            Check
          </label>
          <select
            id="run-check-filter"
            value={checkId}
            onChange={(e) => setCheckId(e.target.value)}
            className="rounded border border-gray-200 bg-white px-2 py-1 text-sm dark:border-white/10 dark:bg-zinc-900"
          >
            <option value="">All checks</option>
            {checks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="run-status-filter" className="text-xs text-slate-400 dark:text-zinc-500">
            Status
          </label>
          <select
            id="run-status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as RunStatus | '')}
            className="rounded border border-gray-200 bg-white px-2 py-1 text-sm dark:border-white/10 dark:bg-zinc-900"
          >
            <option value="">All</option>
            {RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isLoading && <p className="text-sm text-slate-400 dark:text-zinc-500">Loading runs…</p>}
      {query.isError && <p className="text-sm text-red-600 dark:text-rose-500">Failed to load run history.</p>}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-100 text-xs text-slate-400 dark:text-zinc-500 dark:border-white/10 dark:bg-zinc-800">
              <tr>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Check</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-3 py-2 font-medium tabular">Duration</th>
                <th className="px-3 py-2 font-medium">Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-gray-200 last:border-0 hover:bg-gray-100 dark:border-white/10 dark:hover:bg-white/10"
                >
                  <td className="px-3 py-2">
                    <Link to={`/runs/${run.id}`} className="text-cyan-600 dark:text-cyan-400 hover:underline">
                      {formatDateTime(run.startedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-zinc-400">
                    {run.checkName} <span className="opacity-70">({run.checkType})</span>
                  </td>
                  <td className="px-3 py-2">
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-zinc-400">{run.trigger}</td>
                  <td className="px-3 py-2 tabular">{formatMs(run.durationMs)}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 dark:text-zinc-500">
                    {run.hasScreenshot && <CameraIcon className="mr-2 inline" />}
                    {run.hasTrace && <TraceIcon className="inline" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runs.length === 0 && !query.isLoading && (
        <p className="text-sm text-slate-400 dark:text-zinc-500">No runs yet.</p>
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
