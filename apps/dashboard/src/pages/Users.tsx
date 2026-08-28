// FR-6.2 Users admin (admin role only — route also guarded by ProtectedRoute).
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { User, UserRole } from '@vyzus/shared';
import { USER_ROLES } from '@vyzus/shared';
import { usersApi, appsApi } from '../api/endpoints';
import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { formatDateTime } from '../lib/format';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components/formFields';

const ROLE_BADGE: Record<UserRole, string> = {
  admin: 'bg-red-600/10 dark:bg-rose-500/10 text-red-600 dark:text-rose-500',
  editor: 'bg-cyan-500/10 dark:bg-cyan-400/10 text-cyan-600 dark:text-cyan-400',
  viewer: 'bg-green-600/10 dark:bg-emerald-400/10 text-green-600 dark:text-emerald-400',
};

const ROLE_DESCRIPTION: Record<UserRole, string> = {
  admin: 'Manages users, channels, and everything else',
  editor: 'Manages apps and checks, sees everything',
  viewer: 'Read/run access limited to assigned apps',
};

function RoleBadge({ role }: { role: UserRole }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${ROLE_BADGE[role]}`}
    >
      {role}
    </span>
  );
}

function initials(email: string): string {
  const name = email.split('@')[0] ?? email;
  const parts = name.split(/[._-]/).filter(Boolean);
  const chars = parts.length >= 2 ? [parts[0]![0], parts[1]![0]] : [name[0], name[1] ?? ''];
  return chars.join('').toUpperCase();
}

function Avatar({ email }: { email: string }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 dark:bg-cyan-400/15 text-xs font-semibold text-cyan-600 dark:text-cyan-400"
    >
      {initials(email)}
    </span>
  );
}

// Which apps a viewer can see/act on — admin-managed. Meaningless for
// admin/editor (already unrestricted), so the "Manage apps" control only
// appears for viewer rows.
function AssignAppsModal({ user, onClose }: { user: User; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { data: allApps, isLoading: appsLoading } = useQuery({
    queryKey: ['apps', 'all-for-assignment'],
    queryFn: () => appsApi.list(),
  });
  const { data: access, isLoading: accessLoading } = useQuery({
    queryKey: ['users', user.id, 'apps'],
    queryFn: () => usersApi.getApps(user.id),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effective = selected ?? new Set(access?.appIds ?? []);

  const save = useMutation({
    mutationFn: () => usersApi.setApps(user.id, Array.from(effective)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users', user.id, 'apps'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to save app assignments'),
  });

  function toggle(appId: string): void {
    const next = new Set(effective);
    if (next.has(appId)) next.delete(appId);
    else next.add(appId);
    setSelected(next);
  }

  return (
    <Modal title={`Apps assigned to ${user.email}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-400 dark:text-zinc-500">
          This viewer can see and run checks only for the applications checked below.
        </p>
        {(appsLoading || accessLoading) && <p className="text-sm text-slate-400 dark:text-zinc-500">Loading…</p>}
        {allApps && allApps.length === 0 && (
          <p className="text-sm text-slate-400 dark:text-zinc-500">No applications exist yet.</p>
        )}
        {allApps && allApps.length > 0 && (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-gray-200 p-2 dark:border-white/10">
            {allApps.map((a) => (
              <label
                key={a.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-white/10"
              >
                <input type="checkbox" checked={effective.has(a.id)} onChange={() => toggle(a.id)} />
                {a.name}
                <span className="truncate text-xs text-slate-400 dark:text-zinc-500">{a.landingUrl}</span>
              </label>
            ))}
          </div>
        )}
        <ErrorBanner message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className={primaryButtonClass}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NewUserModal({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('editor');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => usersApi.create({ email, password, role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create user'),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate();
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="new-user-email" className={labelClass}>
            Email
          </label>
          <input
            id="new-user-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="new-user-password" className={labelClass}>
            Password
          </label>
          <input
            id="new-user-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="new-user-role" className={labelClass}>
            Role
          </label>
          <select
            id="new-user-role"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className={inputClass}
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">{ROLE_DESCRIPTION[role]}</p>
        </div>
        <ErrorBanner message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={create.isPending} className={primaryButtonClass}>
            {create.isPending ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Consolidates role change / password reset / app assignment / delete into
// one place — previously these were crammed into a single cluttered table
// row (an inline text input for the new password, sitting next to a bare
// role <select>, next to a Delete button).
function EditUserModal({ user, onClose }: { user: User; onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const isSelf = user.id === me?.id;
  const [role, setRole] = useState<UserRole>(user.role);
  const [newPassword, setNewPassword] = useState('');
  const [assigningApps, setAssigningApps] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onError(err: unknown, fallback: string): void {
    setError(err instanceof ApiError ? err.message : fallback);
  }

  const updateRole = useMutation({
    mutationFn: (r: UserRole) => usersApi.update(user.id, { role: r }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => onError(err, 'Failed to change role'),
  });
  const resetPassword = useMutation({
    mutationFn: () => usersApi.update(user.id, { password: newPassword }),
    onSuccess: () => {
      setNewPassword('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => onError(err, 'Failed to reset password'),
  });
  const remove = useMutation({
    mutationFn: () => usersApi.remove(user.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => onError(err, 'Failed to delete user'),
  });

  function handleRoleChange(next: UserRole): void {
    setRole(next);
    updateRole.mutate(next);
  }

  return (
    <Modal title={user.email} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar email={user.email} />
          <div className="min-w-0">
            <p className="truncate font-medium">
              {user.email}{' '}
              {isSelf && <span className="text-xs font-normal text-slate-400 dark:text-zinc-500">(you)</span>}
            </p>
            <p className="text-xs text-slate-400 dark:text-zinc-500">Member since {formatDateTime(user.createdAt)}</p>
          </div>
        </div>

        <div>
          <label htmlFor="edit-user-role" className={labelClass}>
            Role
          </label>
          <select
            id="edit-user-role"
            value={role}
            disabled={isSelf || updateRole.isPending}
            onChange={(e) => handleRoleChange(e.target.value as UserRole)}
            className={inputClass}
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400 dark:text-zinc-500">
            {isSelf ? "You can't change your own role." : ROLE_DESCRIPTION[role]}
          </p>
        </div>

        {role === 'viewer' && (
          <div>
            <span className={labelClass}>App access</span>
            <button type="button" onClick={() => setAssigningApps(true)} className={secondaryButtonClass}>
              Manage assigned apps
            </button>
          </div>
        )}

        <div>
          <label htmlFor="edit-user-password" className={labelClass}>
            Reset password
          </label>
          <div className="flex gap-2">
            <input
              id="edit-user-password"
              type="password"
              placeholder="New password (min 8 characters)"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputClass}
            />
            <button
              type="button"
              disabled={newPassword.length < 8 || resetPassword.isPending}
              onClick={() => resetPassword.mutate()}
              className={secondaryButtonClass}
            >
              {resetPassword.isPending ? 'Saving…' : 'Reset'}
            </button>
          </div>
          {resetPassword.isSuccess && (
            <p className="mt-1 text-xs text-green-600 dark:text-emerald-400">Password updated.</p>
          )}
        </div>

        <ErrorBanner message={error} />

        <div className="flex items-center justify-between border-t border-gray-200 pt-4 dark:border-white/10">
          {confirmingDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-red-600 dark:text-rose-500">Delete this user permanently?</span>
              <button type="button" onClick={() => setConfirmingDelete(false)} className={secondaryButtonClass}>
                Cancel
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className={dangerButtonClass}
              >
                {remove.isPending ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={isSelf}
              title={isSelf ? "You can't delete your own account" : undefined}
              onClick={() => setConfirmingDelete(true)}
              className={dangerButtonClass}
            >
              Delete user
            </button>
          )}
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Done
          </button>
        </div>

        {assigningApps && <AssignAppsModal user={user} onClose={() => setAssigningApps(false)} />}
      </div>
    </Modal>
  );
}

function AppAccessCell({ user }: { user: User }): JSX.Element {
  const { data: access, isLoading } = useQuery({
    queryKey: ['users', user.id, 'apps'],
    queryFn: () => usersApi.getApps(user.id),
  });
  if (user.role !== 'viewer') return <span className="text-slate-400 dark:text-zinc-500">All apps</span>;
  if (isLoading) return <span className="text-slate-400 dark:text-zinc-500">…</span>;
  const count = access?.appIds.length ?? 0;
  if (count === 0) return <span className="text-amber-600 dark:text-amber-400">No apps assigned</span>;
  return (
    <span>
      {count} app{count === 1 ? '' : 's'}
    </span>
  );
}

export function Users(): JSX.Element {
  const { data: users, isLoading, error } = useQuery({ queryKey: ['users'], queryFn: usersApi.list });
  const [showNew, setShowNew] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [search, setSearch] = useState('');

  const counts = useMemo(() => {
    const c: Record<UserRole, number> = { admin: 0, editor: 0, viewer: 0 };
    for (const u of users ?? []) c[u.role]++;
    return c;
  }, [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users ?? [];
    return (users ?? []).filter((u) => u.email.toLowerCase().includes(q) || u.role.includes(q));
  }, [users, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          {users && (
            <p className="mt-0.5 text-sm text-slate-400 dark:text-zinc-500">
              {users.length} user{users.length === 1 ? '' : 's'} · {counts.admin} admin{counts.admin === 1 ? '' : 's'} ·{' '}
              {counts.editor} editor
              {counts.editor === 1 ? '' : 's'} · {counts.viewer} viewer{counts.viewer === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <button type="button" onClick={() => setShowNew(true)} className={primaryButtonClass}>
          + New user
        </button>
      </div>

      {isLoading && <p className="text-slate-400 dark:text-zinc-500">Loading users…</p>}
      {error && <p className="text-red-600 dark:text-rose-500">Failed to load users.</p>}

      {users && users.length > 0 && (
        <input
          type="search"
          placeholder="Search by email or role…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`max-w-xs ${inputClass}`}
          aria-label="Search users"
        />
      )}

      {users && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-100 text-xs text-slate-400 dark:text-zinc-500 dark:border-white/10 dark:bg-zinc-800">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">App access</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <UserRow key={u.id} user={u} onEdit={() => setEditingUser(u)} />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400 dark:text-zinc-500">
                    No users match "{search}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <NewUserModal onClose={() => setShowNew(false)} />}
      {editingUser && <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} />}
    </div>
  );
}

function UserRow({ user, onEdit }: { user: User; onEdit: () => void }): JSX.Element {
  const { user: me } = useAuth();
  const isSelf = user.id === me?.id;

  return (
    <tr className="border-b border-gray-200 last:border-0 dark:border-white/10">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2.5">
          <Avatar email={user.email} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{user.email}</span>
              {isSelf && (
                <span className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-white/10 dark:text-zinc-400">
                  YOU
                </span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2">
        <RoleBadge role={user.role} />
      </td>
      <td className="px-3 py-2">
        <AppAccessCell user={user} />
      </td>
      <td className="px-3 py-2 text-slate-400 dark:text-zinc-500">{formatDateTime(user.createdAt)}</td>
      <td className="px-3 py-2">
        <button type="button" onClick={onEdit} className={secondaryButtonClass}>
          Edit
        </button>
      </td>
    </tr>
  );
}
