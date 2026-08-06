// FR-4.2 "screenshot gallery" — GET /checks/:id/runs?hasScreenshot=true, one
// real page at a time (not accumulated) so a check with a long history
// doesn't load more thumbnails than are actually on screen.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { checksApi } from '../api/endpoints';
import { ScreenshotThumb } from './ScreenshotThumb';
import { PagerControls } from './PagerControls';
import { usePagedCursor } from '../hooks/usePagedCursor';
import { formatDateTime } from '../lib/format';

const PAGE_SIZE = 12;

export function ScreenshotGallery({ checkId }: { checkId: string }): JSX.Element {
  const pager = usePagedCursor();

  useEffect(() => {
    pager.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId]);

  const query = useQuery({
    queryKey: ['runs', checkId, 'gallery', pager.cursor],
    queryFn: () => checksApi.runs(checkId, { cursor: pager.cursor, limit: PAGE_SIZE, hasScreenshot: true }),
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
            <div className="border-t border-gray-200 px-2 py-1 text-xs text-slate-400 group-hover:text-slate-900 dark:border-white/10 dark:text-zinc-500 dark:group-hover:text-zinc-100">
              {formatDateTime(run.startedAt)}
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
