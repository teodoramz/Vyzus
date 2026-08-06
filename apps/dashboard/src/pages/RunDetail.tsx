// FR-4.3 Run detail: metrics, error message, screenshot, downloadable trace.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { runsApi } from '../api/endpoints';
import { RunStatusBadge } from '../components/RunStatusBadge';
import { Lightbox } from '../components/Lightbox';
import { useAuthedAsset, downloadAuthedAsset } from '../hooks/useAuthedAsset';
import { formatDateTime, formatMs } from '../lib/format';
import { secondaryButtonClass } from '../components/formFields';

export function RunDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const {
    data: run,
    isLoading,
    error,
  } = useQuery({ queryKey: ['run', id], queryFn: () => runsApi.get(id!), enabled: !!id });
  const [downloading, setDownloading] = useState<'trace' | 'screenshot' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const screenshotUrl = run?.hasScreenshot ? runsApi.screenshotUrl(run.id) : null;
  const { objectUrl, loading: shotLoading, error: shotError } = useAuthedAsset(screenshotUrl);

  if (isLoading) return <p className="text-slate-400 dark:text-zinc-500">Loading run…</p>;
  if (error || !run) return <p className="text-red-600 dark:text-rose-500">Failed to load run.</p>;

  async function handleTraceDownload() {
    if (!run) return;
    setDownloading('trace');
    setDownloadError(null);
    try {
      await downloadAuthedAsset(runsApi.traceUrl(run.id), `trace-${run.id}.zip`);
    } catch {
      setDownloadError('Trace download failed.');
    } finally {
      setDownloading(null);
    }
  }

  async function handleScreenshotDownload() {
    if (!run) return;
    setDownloading('screenshot');
    setDownloadError(null);
    try {
      await downloadAuthedAsset(runsApi.screenshotUrl(run.id), `screenshot-${run.id}.png`);
    } catch {
      setDownloadError('Screenshot download failed.');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Run detail</h1>
        <RunStatusBadge status={run.status} />
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-zinc-900 sm:grid-cols-4">
        <div>
          <dt className="text-slate-400 dark:text-zinc-500">Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-500">Duration</dt>
          <dd className="tabular">{formatMs(run.durationMs)}</dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-500">Trigger</dt>
          <dd className="capitalize">{run.trigger}</dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-500">Worker</dt>
          <dd>{run.workerId ?? '—'}</dd>
        </div>
      </dl>

      {run.errorMessage && (
        <section className="space-y-1">
          <h2 className="font-semibold text-red-600 dark:text-rose-500">Error</h2>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-rose-500/30 bg-red-600/10 p-3 font-mono text-xs text-red-600 dark:bg-rose-500/10 dark:text-rose-500">
            {run.errorMessage}
          </pre>
        </section>
      )}

      {run.metrics && Object.keys(run.metrics).length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Metrics</h2>
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-white/10 dark:bg-zinc-900 sm:grid-cols-4">
            {Object.entries(run.metrics).map(([key, value]) => (
              <div key={key}>
                <dt className="text-slate-400 dark:text-zinc-500">{key}</dt>
                <dd className="tabular font-medium">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Screenshot</h2>
          {run.hasScreenshot && objectUrl && (
            <button
              type="button"
              onClick={() => void handleScreenshotDownload()}
              disabled={downloading !== null}
              className={secondaryButtonClass}
            >
              {downloading === 'screenshot' ? 'Downloading…' : 'Download screenshot'}
            </button>
          )}
        </div>
        {!run.hasScreenshot && <p className="text-sm text-slate-400 dark:text-zinc-500">No screenshot for this run.</p>}
        {run.hasScreenshot && shotError && (
          <p className="text-sm text-red-600 dark:text-rose-500">Failed to load screenshot.</p>
        )}
        {run.hasScreenshot && (shotLoading || !objectUrl) && !shotError && (
          <div className="h-64 animate-pulse rounded-lg bg-gray-100 dark:bg-white/10" />
        )}
        {run.hasScreenshot && objectUrl && (
          <>
            {/* w-full, or the button shrinks to the image's intrinsic width and
                sits narrower than the cards above it. */}
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              className="block w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-white/10 dark:bg-zinc-800"
            >
              <img
                src={objectUrl}
                alt="Run screenshot"
                className="max-h-[420px] w-full cursor-zoom-in object-contain object-top"
              />
            </button>
            <p className="text-xs text-slate-400 dark:text-zinc-500">Viewport capture — click to view at full size.</p>
          </>
        )}
        {lightboxOpen && objectUrl && (
          <Lightbox src={objectUrl} alt="Run screenshot" onClose={() => setLightboxOpen(false)} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Trace</h2>
        {!run.hasTrace && <p className="text-sm text-slate-400 dark:text-zinc-500">No trace captured for this run.</p>}
        {run.hasTrace && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleTraceDownload()}
              disabled={downloading !== null}
              className={secondaryButtonClass}
            >
              {downloading === 'trace' ? 'Downloading…' : 'Download trace.zip'}
            </button>
            <p className="text-xs text-slate-400 dark:text-zinc-500">
              A step-by-step replay: DOM snapshot + screenshot at every action, plus network requests and console logs.
              Open with{' '}
              <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-zinc-800">
                npx playwright show-trace trace.zip
              </code>{' '}
              or drag it into{' '}
              <a
                href="https://trace.playwright.dev"
                target="_blank"
                rel="noreferrer"
                className="text-cyan-600 dark:text-cyan-400 hover:underline"
              >
                trace.playwright.dev
              </a>
              .
            </p>
            {downloadError && <span className="text-sm text-red-600 dark:text-rose-500">{downloadError}</span>}
          </div>
        )}
      </section>

      <Link
        to={`/checks/${run.checkId}/edit`}
        className="inline-block text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
      >
        View check configuration
      </Link>
    </div>
  );
}
