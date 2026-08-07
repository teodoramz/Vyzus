// FR-4.2 "screenshot gallery" — GET /apps/:id/runs?hasScreenshot=true, one
// real page at a time (not accumulated) so an application with a long history
// doesn't load more thumbnails than are actually on screen.
//
// Scoped to the application, not the selected check, and ordered purely by
// time. A screenshot is a picture of the site; which check happened to be
// selected when it was captured is metadata about it, not a reason to hide it
// — so every capture stays in one timeline and each tile is tagged with the
// check that produced it (same shape as the merged run-history table).
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { appsApi } from '../api/endpoints';
import { ScreenshotThumb } from './ScreenshotThumb';
import { PagerControls } from './PagerControls';
import { usePagedCursor } from '../hooks/usePagedCursor';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 12;

export function ScreenshotGallery({ appId }: { appId: string }): JSX.Element {
  const pager = usePagedCursor();

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const query = useQuery({
    queryKey: ['app-runs', appId, 'gallery', pager.cursor],
    queryFn: () => appsApi.runs(appId, { cursor: pager.cursor, limit: PAGE_SIZE, hasScreenshot: true }),
  });

  if (query.isLoading) return <p className="text-sm text-slate-400 dark:text-zinc-500">Loading screenshots…</p>;
  if (query.isError) return <p className="text-sm text-red-600 dark:text-rose-500">Failed to load screenshots.</p>;

  const runs = query.data?.runs ?? [];
  if (runs.length === 0 && pager.page === 1)
    return <p className="text-sm text-slate-400 dark:text-zinc-500">No screenshots yet.</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {runs.map((run) => (
          <Link
            key={run.id}
            to={`/runs/${run.id}`}
            className="group block overflow-hidden rounded border border-gray-200 dark:border-white/10"
          >
            <ScreenshotThumb
              runId={run.id}
              alt={`Screenshot from run at ${formatDateTime(run.startedAt)}`}
              className="h-28 w-full"
            />
            <div className="space-y-1 border-t border-gray-200 px-2 py-1.5 dark:border-white/10">
              <div className="text-xs text-slate-400 group-hover:text-slate-900 dark:text-zinc-500 dark:group-hover:text-zinc-100">
                {formatDateTime(run.startedAt)}
              </div>
              {/* Which check produced this capture — the gallery is no longer
                  filtered by check, so the tile has to say. */}
              <div
                className="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-white/10 dark:text-zinc-400"
                title={`${run.checkName} (${run.checkType})`}
              >
                {run.checkName}
              </div>
            </div>
          </Link>
        ))}
      </div>
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
