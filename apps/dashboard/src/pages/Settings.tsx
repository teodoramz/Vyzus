// FR-7.1 Settings — retention values (runs/screenshots/traces, days).
// Note: `GET/PATCH /settings` is implemented in apps/api but isn't documented
// in docs/04-api-spec.md (only appears in the data model / Phase 7 retention
// job context) — used here since the route exists and Phase 6 needs it.
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthContext';
import { MaintenanceWindows } from '../components/MaintenanceWindows';
import { inputClass, labelClass, primaryButtonClass } from '../components/formFields';

export function Settings(): JSX.Element {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: settingsApi.get });
  const [runsDays, setRunsDays] = useState(90);
  const [screenshotsDays, setScreenshotsDays] = useState(30);
  const [tracesDays, setTracesDays] = useState(14);
  const [heartbeatStallMinutes, setHeartbeatStallMinutes] = useState(15);
  const [renotifyMinutes, setRenotifyMinutes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setRunsDays(data.runsDays);
      setScreenshotsDays(data.screenshotsDays);
      setTracesDays(data.tracesDays);
      setHeartbeatStallMinutes(data.heartbeatStallMinutes);
      setRenotifyMinutes(data.renotifyMinutes);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      settingsApi.update({ runsDays, screenshotsDays, tracesDays, heartbeatStallMinutes, renotifyMinutes }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save settings'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  const readOnly = user?.role !== 'admin';

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="space-y-1">
        <h2 className="font-medium">Data retention</h2>
        <p className="text-sm text-slate-400 dark:text-zinc-500">
          A daily cleanup job deletes runs, screenshots, and traces older than these windows. Incidents are always kept
          indefinitely.
        </p>
      </div>

      {isLoading ? (
        <p className="text-slate-400 dark:text-zinc-500">Loading…</p>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 dark:border-white/10 dark:bg-zinc-900"
        >
          <div>
            <label htmlFor="runsDays" className={labelClass}>
              Runs (days)
            </label>
            <input
              id="runsDays"
              type="number"
              min={1}
              max={3650}
              disabled={readOnly}
              value={runsDays}
              onChange={(e) => setRunsDays(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="screenshotsDays" className={labelClass}>
              Screenshots (days)
            </label>
            <input
              id="screenshotsDays"
              type="number"
              min={1}
              max={3650}
              disabled={readOnly}
              value={screenshotsDays}
              onChange={(e) => setScreenshotsDays(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="tracesDays" className={labelClass}>
              Traces (days)
            </label>
            <input
              id="tracesDays"
              type="number"
              min={1}
              max={3650}
              disabled={readOnly}
              value={tracesDays}
              onChange={(e) => setTracesDays(Number(e.target.value))}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="heartbeatStallMinutes" className={labelClass}>
              Alert if nothing runs for (minutes)
            </label>
            <input
              id="heartbeatStallMinutes"
              type="number"
              min={0}
              max={1440}
              disabled={readOnly}
              value={heartbeatStallMinutes}
              onChange={(e) => setHeartbeatStallMinutes(Number(e.target.value))}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
              {heartbeatStallMinutes > 0
                ? 'If no check completes anywhere in this window, Vyzus alerts that its own monitoring has stopped — the failure a dead worker cannot report itself. Raised automatically to twice your shortest check interval when that is longer. 0 disables it.'
                : 'Off — if the worker dies, checks stop silently and the dashboard keeps showing the last known status indefinitely.'}
            </p>
          </div>

          <div>
            <label htmlFor="renotifyMinutes" className={labelClass}>
              Repeat alerts while still down (minutes)
            </label>
            <input
              id="renotifyMinutes"
              type="number"
              min={0}
              max={1440}
              disabled={readOnly}
              value={renotifyMinutes}
              onChange={(e) => setRenotifyMinutes(Number(e.target.value))}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
              {renotifyMinutes > 0
                ? `An incident that is still open is re-announced every ${renotifyMinutes} minute(s) until it resolves. Reminders go through the same path as the original alert, so an active maintenance window suppresses them too.`
                : 'Off — each incident is announced once when it opens. A single message in a busy channel is easy to miss.'}
            </p>
          </div>

          {error && (
            <p className="rounded bg-red-600/10 dark:bg-rose-500/10 px-3 py-2 text-sm text-red-600 dark:text-rose-500">
              {error}
            </p>
          )}
          {readOnly && (
            <p className="text-xs text-slate-400 dark:text-zinc-500">Only admins can change retention settings.</p>
          )}

          {!readOnly && (
            <div className="flex items-center gap-3">
              <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="text-sm text-green-600 dark:text-emerald-400">Saved.</span>}
            </div>
          )}
        </form>
      )}

      <div className="mt-8 border-t border-gray-200 pt-8 dark:border-white/10">
        <MaintenanceWindows />
      </div>
    </div>
  );
}
