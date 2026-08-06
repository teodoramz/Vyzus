// FR-1.1/FR-1.2/FR-1.3 — edit application (name/url/tags/enabled + optional
// basic-auth/header credentials, stored encrypted server-side).
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppDetail } from '@vyzus/shared';
import { appsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { Modal } from './Modal';
import { ConfirmButton } from './ConfirmButton';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './formFields';

export function AppEditModal({ app, onClose }: { app: AppDetail; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const [name, setName] = useState(app.name);
  const [landingUrl, setLandingUrl] = useState(app.landingUrl);
  const [tags, setTags] = useState(app.tags.join(', '));
  const [enabled, setEnabled] = useState(app.enabled);
  const [useAuth, setUseAuth] = useState(app.hasAuthConfig);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: () =>
      appsApi.update(app.id, {
        name,
        landingUrl,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        enabled,
        authConfig: useAuth ? (username || password ? { basicAuth: { username, password } } : undefined) : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['app', app.id] });
      void qc.invalidateQueries({ queryKey: ['apps'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save'),
  });

  const remove = useMutation({
    mutationFn: () => appsApi.remove(app.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['apps'] });
      window.location.assign('/');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to delete'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    update.mutate();
  }

  return (
    <Modal title="Edit application" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="edit-name" className={labelClass}>
            Name
          </label>
          <input
            id="edit-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="edit-url" className={labelClass}>
            Landing page URL
          </label>
          <input
            id="edit-url"
            type="url"
            required
            value={landingUrl}
            onChange={(e) => setLandingUrl(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="edit-tags" className={labelClass}>
            Tags (comma separated)
          </label>
          <input id="edit-tags" value={tags} onChange={(e) => setTags(e.target.value)} className={inputClass} />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (unchecking pauses all checks; history is kept)
        </label>

        <div className="rounded border border-gray-200 p-3 dark:border-white/10">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={useAuth} onChange={(e) => setUseAuth(e.target.checked)} />
            Protected staging environment (HTTP basic auth)
          </label>
          {useAuth && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputClass}
              />
              <input
                placeholder="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
              <p className="col-span-2 text-xs text-slate-400 dark:text-zinc-500">
                Stored encrypted. Leave blank to keep the existing credentials.
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="rounded bg-red-600/10 dark:bg-rose-500/10 px-3 py-2 text-sm text-red-600 dark:text-rose-500">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between pt-2">
          <ConfirmButton
            label="Delete application"
            confirmLabel={`Delete "${app.name}"? This removes all checks, runs, and incidents.`}
            pendingLabel="Deleting…"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={secondaryButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={update.isPending} className={primaryButtonClass}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
