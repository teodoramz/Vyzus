// FR-5.1 Channels admin page.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Channel } from '@vyzus/shared';
import { channelsApi } from '../api/endpoints';
import { ChannelModal } from '../components/ChannelModal';
import { Modal } from '../components/Modal';
import { ConfirmButton } from '../components/ConfirmButton';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';
import { primaryButtonClass, secondaryButtonClass } from '../components/formFields';

function DeliveriesModal({ channel, onClose }: { channel: Channel; onClose: () => void }): JSX.Element {
  const { data: deliveries, isLoading } = useQuery({
    queryKey: ['channels', channel.id, 'deliveries'],
    queryFn: () => channelsApi.deliveries(channel.id),
  });
  return (
    <Modal title={`Deliveries — ${channel.name}`} onClose={onClose} wide>
      {isLoading && <p className="text-slate-400 dark:text-zinc-500">Loading…</p>}
      {deliveries && deliveries.length === 0 && <p className="text-slate-400 dark:text-zinc-500">No deliveries yet.</p>}
      {deliveries && deliveries.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-200 text-xs text-slate-400 dark:text-zinc-500 dark:border-white/10">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Time</th>
              <th className="py-1.5 pr-3 font-medium">Event</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 pr-3 font-medium">Attempts</th>
              <th className="py-1.5 font-medium">Response</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className="border-b border-gray-200 last:border-0 dark:border-white/10">
                <td className="py-1.5 pr-3">{formatDateTime(d.createdAt)}</td>
                <td className="py-1.5 pr-3 capitalize">{d.event}</td>
                <td
                  className={`py-1.5 pr-3 font-medium ${d.status === 'sent' ? 'text-green-600 dark:text-emerald-400' : 'text-red-600 dark:text-rose-500'}`}
                >
                  {d.status}
                </td>
                <td className="py-1.5 pr-3 tabular">{d.attempts}</td>
                <td className="py-1.5 tabular">{d.responseCode ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function CreatorCell({ channel }: { channel: Channel }): JSX.Element {
  const { user: me } = useAuth();
  if (channel.createdBy === me?.id) {
    return <span className="font-medium">You</span>;
  }
  if (channel.createdByEmail) {
    return (
      <span>
        {channel.createdByEmail}
        {channel.ownerId && <span className="ml-1 text-xs text-slate-400 dark:text-zinc-500">(self-service)</span>}
      </span>
    );
  }
  return <span className="text-slate-400 dark:text-zinc-500">—</span>;
}

export function Channels(): JSX.Element {
  const qc = useQueryClient();
  const { data: channels, isLoading, error } = useQuery({ queryKey: ['channels'], queryFn: channelsApi.list });
  const [editing, setEditing] = useState<Channel | null | 'new'>(null);
  const [viewingDeliveries, setViewingDeliveries] = useState<Channel | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const test = useMutation({
    mutationFn: (id: string) => channelsApi.test(id),
    onSuccess: (res, id) =>
      setTestResult((cur) => ({
        ...cur,
        [id]: res.ok ? `OK (${res.responseCode})` : `Failed (${res.responseCode ?? 'no response'})`,
      })),
    onError: (_err, id) => setTestResult((cur) => ({ ...cur, [id]: 'Failed to send' })),
  });

  const remove = useMutation({
    mutationFn: (id: string) => channelsApi.remove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels'] }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Alert channels</h1>
        <button type="button" onClick={() => setEditing('new')} className={primaryButtonClass}>
          + New channel
        </button>
      </div>

      {isLoading && <p className="text-slate-400 dark:text-zinc-500">Loading channels…</p>}
      {error && <p className="text-red-600 dark:text-rose-500">Failed to load channels.</p>}
      {channels && channels.length === 0 && (
        <p className="text-slate-400 dark:text-zinc-500">
          No one's listening yet — add a channel so Vyzus knows who to wake up.
        </p>
      )}

      {channels && channels.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-100 text-xs text-slate-400 dark:text-zinc-500 dark:border-white/10 dark:bg-zinc-800">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Created by</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className="border-b border-gray-200 last:border-0 dark:border-white/10">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 capitalize">{c.type}</td>
                  <td className="px-3 py-2">{c.allApps ? 'All apps' : `${c.appIds.length} app(s)`}</td>
                  <td className="px-3 py-2">
                    <CreatorCell channel={c} />
                  </td>
                  <td className="px-3 py-2">{c.enabled ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => setEditing(c)} className={secondaryButtonClass}>
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => test.mutate(c.id)}
                        disabled={test.isPending}
                        className={secondaryButtonClass}
                      >
                        Test
                      </button>
                      <button type="button" onClick={() => setViewingDeliveries(c)} className={secondaryButtonClass}>
                        Deliveries
                      </button>
                      <ConfirmButton
                        label="Delete"
                        confirmLabel={`Delete channel "${c.name}"?`}
                        pendingLabel="Deleting…"
                        pending={remove.isPending && remove.variables === c.id}
                        onConfirm={() => remove.mutate(c.id)}
                      />
                      {testResult[c.id] && (
                        <span className="text-xs text-slate-400 dark:text-zinc-500">{testResult[c.id]}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ChannelModal channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {viewingDeliveries && <DeliveriesModal channel={viewingDeliveries} onClose={() => setViewingDeliveries(null)} />}
    </div>
  );
}
