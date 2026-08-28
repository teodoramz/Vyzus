// FR-5.1 alert channels admin — create/edit Slack/Discord/generic webhook/email.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Channel, ChannelType } from '@vyzus/shared';
import { CHANNEL_TYPES } from '@vyzus/shared';
import { appsApi, channelsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { Modal } from './Modal';
import { useAuth } from '../auth/AuthContext';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './formFields';
import { ErrorBanner } from './ErrorBanner';

export function ChannelModal({ channel, onClose }: { channel: Channel | null; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { user } = useAuth();
  // A viewer's self-service channel can only ever target apps they're
  // assigned to — the server rejects allApps outright for them (it would
  // reach apps they can't see), so the toggle isn't offered at all.
  const isViewer = user?.role === 'viewer';
  const isEdit = !!channel;
  const [name, setName] = useState(channel?.name ?? '');
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'webhook');
  const [url, setUrl] = useState(channel?.url ?? '');
  const [secret, setSecret] = useState('');
  // Email (SMTP). Kept in separate state from the webhook URL so switching type
  // back and forth in the form does not lose what was already typed.
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [allApps, setAllApps] = useState(channel?.allApps ?? !isViewer);
  const [appIds, setAppIds] = useState<string[]>(channel?.appIds ?? []);
  const [error, setError] = useState<string | null>(null);

  const { data: apps } = useQuery({ queryKey: ['apps'], queryFn: () => appsApi.list(), enabled: !allApps });

  const save = useMutation({
    mutationFn: () => {
      const config =
        type === 'email'
          ? {
              host,
              port,
              secure: smtpSecure,
              from,
              to: to
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              ...(smtpUser ? { username: smtpUser } : {}),
              ...(smtpPassword ? { password: smtpPassword } : {}),
            }
          : secret
            ? { url, secret }
            : { url };
      const body = { name, type, config, enabled, allApps, appIds };
      return isEdit
        ? channelsApi.update(channel!.id, body as Parameters<typeof channelsApi.update>[1])
        : channelsApi.create(body as Parameters<typeof channelsApi.create>[0]);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save channel'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  function toggleApp(id: string) {
    setAppIds((cur) => (cur.includes(id) ? cur.filter((a) => a !== id) : [...cur, id]));
  }

  return (
    <Modal title={isEdit ? 'Edit channel' : 'New channel'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="channel-name" className={labelClass}>
            Name
          </label>
          <input
            id="channel-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="channel-type" className={labelClass}>
            Type
          </label>
          <select
            id="channel-type"
            value={type}
            onChange={(e) => setType(e.target.value as ChannelType)}
            className={inputClass}
          >
            {CHANNEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {type !== 'email' && (
          <div>
            <label htmlFor="channel-url" className={labelClass}>
              {type === 'webhook'
                ? 'Webhook URL'
                : `${type.charAt(0).toUpperCase()}${type.slice(1)} incoming webhook URL`}
            </label>
            <input
              id="channel-url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        {type === 'email' && (
          <div className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-white/10">
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <label htmlFor="smtp-host" className={labelClass}>
                  SMTP host
                </label>
                <input
                  id="smtp-host"
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  className={inputClass}
                  placeholder="smtp.example.com"
                />
              </div>
              <div>
                <label htmlFor="smtp-port" className={labelClass}>
                  Port
                </label>
                <input
                  id="smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 587)}
                  className={inputClass}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
              Implicit TLS (port 465). Leave off for STARTTLS on 587.
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="smtp-user" className={labelClass}>
                  Username (optional)
                </label>
                <input
                  id="smtp-user"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="smtp-pass" className={labelClass}>
                  Password (optional)
                </label>
                <input
                  id="smtp-pass"
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  className={inputClass}
                  placeholder={isEdit && channel?.hasPassword ? 'Leave blank to keep existing password' : ''}
                />
              </div>
            </div>
            <div>
              <label htmlFor="smtp-from" className={labelClass}>
                From address
              </label>
              <input
                id="smtp-from"
                type="email"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className={inputClass}
                placeholder="vyzus@example.com"
              />
            </div>
            <div>
              <label htmlFor="smtp-to" className={labelClass}>
                Recipients
              </label>
              <input
                id="smtp-to"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className={inputClass}
                placeholder="ops@example.com, oncall@example.com"
              />
              <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">Comma-separated.</p>
            </div>
          </div>
        )}
        {type === 'webhook' && (
          <div>
            <label htmlFor="channel-secret" className={labelClass}>
              Signing secret (optional)
            </label>
            <input
              id="channel-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={inputClass}
              placeholder={isEdit && channel?.hasSecret ? 'Leave blank to keep existing secret' : ''}
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
              Signs deliveries with X-Vyzus-Signature (HMAC-SHA256).
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <div>
          {!isViewer && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={allApps} onChange={(e) => setAllApps(e.target.checked)} />
              Attach to all applications
            </label>
          )}
          {isViewer && <p className={labelClass}>Applications</p>}
          {!allApps && (
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded border border-gray-200 p-2 dark:border-white/10">
              {(apps ?? []).map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={appIds.includes(a.id)} onChange={() => toggleApp(a.id)} />
                  {a.name}
                </label>
              ))}
              {apps && apps.length === 0 && (
                <p className="text-xs text-slate-400 dark:text-zinc-500">No applications yet.</p>
              )}
            </div>
          )}
        </div>

        <ErrorBanner message={error} />

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={save.isPending} className={primaryButtonClass}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create channel'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
