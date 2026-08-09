// FR-1.1 CRUD for applications — creation form ("enroll app").
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { appsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { Modal } from './Modal';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './formFields';

export function NewAppModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [landingUrl, setLandingUrl] = useState('https://');
  const [tags, setTags] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      appsApi.create({
        name,
        landingUrl,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        enabled: true,
        // Both configured after creation, in the edit modal — a new app has
        // nothing to depend on yet, and publishing is a deliberate act.
        parentAppId: null,
        isPublic: false,
        // Starter set: landing uptime, DNS, and TLS for https targets.
        createDefaultChecks: true,
        intervalMinutes,
      }),
    onSuccess: (app) => {
      void qc.invalidateQueries({ queryKey: ['apps'] });
      onClose();
      navigate(`/apps/${app.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create application'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate();
  }

  return (
    <Modal title="New application" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className={labelClass}>
            Name
          </label>
          <input
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="Shop"
          />
        </div>
        <div>
          <label htmlFor="landingUrl" className={labelClass}>
            Landing page URL
          </label>
          <input
            id="landingUrl"
            type="url"
            required
            value={landingUrl}
            onChange={(e) => setLandingUrl(e.target.value)}
            className={inputClass}
            placeholder="https://example.com"
          />
        </div>
        <div>
          <label htmlFor="tags" className={labelClass}>
            Tags (comma separated)
          </label>
          <input
            id="tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className={inputClass}
            placeholder="production, storefront"
          />
        </div>
        <div>
          <label htmlFor="interval" className={labelClass}>
            Uptime check interval (minutes)
          </label>
          <input
            id="interval"
            type="number"
            min={1}
            required
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        {error && (
          <p className="rounded bg-red-600/10 dark:bg-rose-500/10 px-3 py-2 text-sm text-red-600 dark:text-rose-500">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className={primaryButtonClass}>
            {create.isPending ? 'Creating…' : 'Create application'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
