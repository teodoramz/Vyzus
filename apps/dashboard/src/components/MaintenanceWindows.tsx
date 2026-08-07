// Maintenance window management. Suppression applies to notification only —
// checks keep running and incidents are still recorded — so the copy here says
// so plainly, otherwise "maintenance window" reads as "monitoring paused".
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { maintenanceApi, appsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthContext';
import { ConfirmButton } from './ConfirmButton';
import { formatDateTime } from '../lib/format';
import { inputClass, labelClass, primaryButtonClass } from './formFields';

/** `datetime-local` needs a local-time string with no zone suffix. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MaintenanceWindows(): JSX.Element {
  const qc = useQueryClient();
  const { user } = useAuth();
  const readOnly = user?.role === 'viewer';

  const windows = useQuery({ queryKey: ['maintenance'], queryFn: () => maintenanceApi.list() });
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => appsApi.list() });

  const now = new Date();
  const [appId, setAppId] = useState<string>('');
  const [reason, setReason] = useState('Deploy');
  const [startsAt, setStartsAt] = useState(toLocalInput(now));
  const [endsAt, setEndsAt] = useState(toLocalInput(new Date(now.getTime() + 60 * 60 * 1000)));
  const [error, setError] = useState<string | null>(null);

  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: ['maintenance'] });
  }

  const create = useMutation({
    mutationFn: () =>
      maintenanceApi.create({
        appId: appId === '' ? null : appId,
        reason,
        // datetime-local is local time; toISOString converts to UTC for the API.
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create window'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => maintenanceApi.remove(id),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to remove window'),
  });

  const rows = windows.data ?? [];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Maintenance windows</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">
          Suppress alerts during planned work. Checks keep running and incidents are still recorded — only the
          notification is withheld, so the history stays complete and the dead-man's switch is unaffected.
        </p>
      </div>

      {!readOnly && (
        <form
          className="grid gap-3 rounded-lg border border-gray-200 p-4 sm:grid-cols-2 dark:border-white/10"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div>
            <label htmlFor="mwApp" className={labelClass}>
              Application
            </label>
            <select id="mwApp" value={appId} onChange={(e) => setAppId(e.target.value)} className={inputClass}>
              <option value="">All applications (admin only)</option>
              {(apps.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mwReason" className={labelClass}>
              Reason
            </label>
            <input
              id="mwReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="mwStart" className={labelClass}>
              Starts
            </label>
            <input
              id="mwStart"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="mwEnd" className={labelClass}>
              Ends
            </label>
            <input
              id="mwEnd"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={create.isPending} className={primaryButtonClass}>
              {create.isPending ? 'Scheduling…' : 'Schedule window'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="rounded bg-red-600/10 px-3 py-2 text-sm text-red-600 dark:bg-rose-500/10 dark:text-rose-500">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-zinc-500">No maintenance windows scheduled.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-400 dark:text-zinc-500">
              <tr>
                <th className="py-2 pr-4">Scope</th>
                <th className="py-2 pr-4">Reason</th>
                <th className="py-2 pr-4">From</th>
                <th className="py-2 pr-4">To</th>
                <th className="py-2 pr-4">Created by</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-t border-gray-200 dark:border-white/10">
                  <td className="py-2 pr-4">
                    {w.appName ?? 'All applications'}
                    {w.active && (
                      <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                        suppressing now
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">{w.reason}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(w.startsAt)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatDateTime(w.endsAt)}</td>
                  <td className="py-2 pr-4 text-slate-400 dark:text-zinc-500">{w.createdByEmail ?? '—'}</td>
                  <td className="py-2 text-right">
                    {!readOnly && (
                      <ConfirmButton
                        label={w.active ? 'End now' : 'Remove'}
                        confirmLabel="Confirm"
                        onConfirm={() => remove.mutate(w.id)}
                        pending={remove.isPending}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
