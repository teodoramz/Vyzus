// FR-4.2 App detail page.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useInfiniteQuery } from '@tanstack/react-query';
import { appsApi, checksApi } from '../api/endpoints';
import { StatusBadge } from '../components/StatusBadge';
import { StatTile } from '../components/StatTile';
import { ResponseTimeChart } from '../components/ResponseTimeChart';
import { AppRunHistoryTable } from '../components/AppRunHistoryTable';
import { ScreenshotGallery } from '../components/ScreenshotGallery';
import { IncidentTimeline } from '../components/IncidentTimeline';
import { AppEditModal } from '../components/AppEditModal';
import { Spinner } from '../components/Spinner';
import { waitForRunCompletion } from '../lib/waitForRun';
import { formatPercent, formatRelativeTime } from '../lib/format';
import { secondaryButtonClass, primaryButtonClass } from '../components/formFields';
import { useAuth } from '../auth/AuthContext';

export function AppDetail(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  // Viewers get full read access + run-now/screenshot-now on their assigned
  // apps, but no editing surface at all (server-enforced regardless; this
  // just keeps buttons that would 403 out of the UI).
  const canEdit = user?.role === 'admin' || user?.role === 'editor';
  const [editing, setEditing] = useState(false);
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'run' | 'screenshot' | 'run-check' | null>(null);
  const [runAllProgress, setRunAllProgress] = useState<{ done: number; total: number } | null>(null);

  const {
    data: app,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['app', id],
    queryFn: () => appsApi.get(id!),
    enabled: !!id,
  });

  // Deep link from the incident banner: /apps/:id?check=:checkId&incident=:incidentId
  // selects the right check tab; the incident itself is scrolled to and
  // highlighted by IncidentTimeline below.
  const checkParam = searchParams.get('check');
  const incidentParam = searchParams.get('incident');
  useEffect(() => {
    if (checkParam && app?.checks.some((c) => c.id === checkParam)) {
      setSelectedCheckId(checkParam);
    }
  }, [checkParam, app]);

  const activeCheckId = selectedCheckId ?? app?.checks[0]?.id ?? null;
  const activeCheck = app?.checks.find((c) => c.id === activeCheckId) ?? null;

  const recentRuns = useInfiniteQuery({
    queryKey: ['runs', activeCheckId, 'chart'],
    queryFn: () => checksApi.runs(activeCheckId!, { limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: () => undefined,
    enabled: !!activeCheckId,
  });

  const screenshotNow = useMutation({
    mutationFn: async () => {
      const { runId } = await appsApi.screenshotNow(id!);
      await waitForRunCompletion(runId);
    },
    onMutate: () => setBusy('screenshot'),
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['app', id] });
    },
  });

  // Runs every check for the app, one at a time in tab order (not in
  // parallel) so results land predictably and the progress counter means
  // something.
  const runAll = useMutation({
    mutationFn: async () => {
      if (!app) return;
      setRunAllProgress({ done: 0, total: app.checks.length });
      for (let i = 0; i < app.checks.length; i++) {
        const { runId } = await checksApi.runNow(app.checks[i]!.id);
        await waitForRunCompletion(runId);
        setRunAllProgress({ done: i + 1, total: app.checks.length });
      }
    },
    onMutate: () => setBusy('run'),
    onSettled: () => {
      setBusy(null);
      setRunAllProgress(null);
      void qc.invalidateQueries({ queryKey: ['app', id] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const runCheck = useMutation({
    mutationFn: async (checkId: string) => {
      const { runId } = await checksApi.runNow(checkId);
      await waitForRunCompletion(runId);
    },
    onMutate: () => setBusy('run-check'),
    onSettled: () => {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['app', id] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const reorderChecks = useMutation({
    mutationFn: (checkIds: string[]) => appsApi.reorderChecks(id!, checkIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['app', id] }),
  });

  function moveCheck(checkId: string, direction: -1 | 1): void {
    if (!app) return;
    const ids = app.checks.map((c) => c.id);
    const from = ids.indexOf(checkId);
    const to = from + direction;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    reorderChecks.mutate(ids);
  }

  if (isLoading) return <p className="text-slate-400 dark:text-zinc-500">Loading application…</p>;
  if (error || !app) return <p className="text-red-600 dark:text-rose-500">Failed to load application.</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{app.name}</h1>
            <StatusBadge status={app.status} />
          </div>
          <a
            href={app.landingUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
          >
            {app.landingUrl}
          </a>
          {app.tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void screenshotNow.mutate()}
            disabled={busy !== null}
            className={`flex items-center gap-1.5 ${secondaryButtonClass}`}
          >
            {busy === 'screenshot' && <Spinner className="h-3.5 w-3.5" />}
            {busy === 'screenshot' ? 'Capturing…' : 'Screenshot now'}
          </button>
          <button
            type="button"
            onClick={() => void runAll.mutate()}
            disabled={busy !== null || app.checks.length === 0}
            className={`flex items-center gap-1.5 ${secondaryButtonClass}`}
          >
            {busy === 'run' && <Spinner className="h-3.5 w-3.5" />}
            {busy === 'run'
              ? runAllProgress
                ? `Running ${runAllProgress.done}/${runAllProgress.total}…`
                : 'Running…'
              : `Run all checks${app.checks.length > 1 ? ` (${app.checks.length})` : ''}`}
          </button>
          {canEdit && (
            <button type="button" onClick={() => setEditing(true)} className={primaryButtonClass}>
              Edit
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3 dark:border-white/10">
        {app.checks.map((c, idx) => (
          <div
            key={c.id}
            className={`flex items-center gap-0.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-medium ${
              activeCheckId === c.id
                ? 'bg-gradient-to-br from-emerald-400 to-cyan-500 text-white'
                : 'border border-gray-200 text-slate-600 hover:bg-gray-100 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/10'
            }`}
          >
            <button type="button" onClick={() => setSelectedCheckId(c.id)}>
              {c.name} <span className="opacity-70">({c.type})</span>
            </button>
            {canEdit && app.checks.length > 1 && (
              <span className="ml-1 flex items-center">
                <button
                  type="button"
                  onClick={() => moveCheck(c.id, -1)}
                  disabled={idx === 0 || reorderChecks.isPending}
                  aria-label={`Move ${c.name} earlier`}
                  title="Move earlier"
                  className="rounded px-1 opacity-70 hover:opacity-100 disabled:opacity-20"
                >
                  ‹
                </button>
                <button
                  type="button"
                  onClick={() => moveCheck(c.id, 1)}
                  disabled={idx === app.checks.length - 1 || reorderChecks.isPending}
                  aria-label={`Move ${c.name} later`}
                  title="Move later"
                  className="rounded px-1 opacity-70 hover:opacity-100 disabled:opacity-20"
                >
                  ›
                </button>
              </span>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => navigate(`/apps/${app.id}/checks/new`)}
            className="rounded-full border border-dashed border-gray-200 px-3 py-1.5 text-sm text-slate-400 dark:text-zinc-500 hover:bg-gray-100 dark:border-white/10 dark:hover:bg-white/10"
          >
            + Add check
          </button>
        )}
      </div>

      {activeCheck && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm text-slate-400 dark:text-zinc-500">
              <span>Last run: {formatRelativeTime(activeCheck.lastRunAt)}</span>
              {activeCheck.consecutiveFailures > 0 && (
                <span className="text-red-600 dark:text-rose-500">
                  {activeCheck.consecutiveFailures} consecutive failures
                </span>
              )}
              {!activeCheck.enabled && <span>Disabled</span>}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => runCheck.mutate(activeCheck.id)}
                disabled={busy !== null}
                className="flex items-center gap-1.5 text-sm text-cyan-600 dark:text-cyan-400 hover:underline disabled:opacity-50"
              >
                {busy === 'run-check' && <Spinner className="h-3 w-3" />}
                {busy === 'run-check' ? 'Running…' : 'Run now'}
              </button>
              {canEdit && (
                <Link
                  to={`/checks/${activeCheck.id}/edit`}
                  className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline"
                >
                  Edit check config
                </Link>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatTile
              label="Availability 24h"
              value={formatPercent(activeCheck.availability24h)}
              tone={toneFor(activeCheck.availability24h)}
            />
            <StatTile
              label="Availability 7d"
              value={formatPercent(activeCheck.availability7d)}
              tone={toneFor(activeCheck.availability7d)}
            />
            <StatTile
              label="Availability 30d"
              value={formatPercent(activeCheck.availability30d)}
              tone={toneFor(activeCheck.availability30d)}
            />
          </div>

          <section className="space-y-2">
            <h2 className="font-semibold">
              Response time <span className="font-normal text-slate-400 dark:text-zinc-500">— {activeCheck.name}</span>
            </h2>
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
              <ResponseTimeChart runs={recentRuns.data?.pages.flatMap((p) => p.runs) ?? []} />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">
              Screenshots <span className="font-normal text-slate-400 dark:text-zinc-500">— {activeCheck.name}</span>
            </h2>
            <ScreenshotGallery checkId={activeCheck.id} />
          </section>
        </>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">
          Run history <span className="font-normal text-slate-400 dark:text-zinc-500">— all checks</span>
        </h2>
        <AppRunHistoryTable appId={app.id} checks={app.checks} />
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">
          Incidents <span className="font-normal text-slate-400 dark:text-zinc-500">— all checks</span>
        </h2>
        <IncidentTimeline appId={app.id} highlightIncidentId={incidentParam} />
      </section>

      {editing && <AppEditModal app={app} onClose={() => setEditing(false)} />}
    </div>
  );
}

// Availability is a 0..1 fraction (see lib/format.ts formatPercent).
function toneFor(fraction: number | null): 'good' | 'warning' | 'critical' | undefined {
  if (fraction === null) return undefined;
  if (fraction >= 0.99) return 'good';
  if (fraction >= 0.95) return 'warning';
  return 'critical';
}
