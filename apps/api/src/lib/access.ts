// Viewer app-scoping (02-architecture §7 extension): admin and editor are
// unrestricted, exactly as before this role existed. A `viewer` may only
// read/act on applications an admin has explicitly granted via
// user_app_access (PUT /users/:id/apps). These helpers are called inline
// from route handlers (after app.authenticate has populated req.authUser)
// rather than as a generic preHandler, since resolving "which app does this
// resource belong to" differs by route (direct id / via check / via run).
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { checks, runs, userAppAccess, type AlertChannelRow } from '../db/schema.js';
import type { AuthUser } from '../plugins/auth.js';
import { forbidden } from './errors.js';

/** All app ids a viewer may access; `null` means "unrestricted" (admin/editor). */
export async function accessibleAppIds(db: Database, user: AuthUser): Promise<string[] | null> {
  if (user.role !== 'viewer') return null;
  const rows = await db
    .select({ appId: userAppAccess.appId })
    .from(userAppAccess)
    .where(eq(userAppAccess.userId, user.id));
  return rows.map((r) => r.appId);
}

export async function assertAppAccess(db: Database, user: AuthUser, appId: string): Promise<void> {
  if (user.role !== 'viewer') return;
  const [row] = await db
    .select({ appId: userAppAccess.appId })
    .from(userAppAccess)
    .where(and(eq(userAppAccess.userId, user.id), eq(userAppAccess.appId, appId)))
    .limit(1);
  if (!row) throw forbidden('Not assigned to this application');
}

/** Resolves the check's app first, then applies the same rule. A missing
 * check is *not* an access error — let the route's own notFound() handle it. */
export async function assertCheckAccess(db: Database, user: AuthUser, checkId: string): Promise<void> {
  if (user.role !== 'viewer') return;
  const [row] = await db.select({ appId: checks.appId }).from(checks).where(eq(checks.id, checkId)).limit(1);
  if (!row) return;
  await assertAppAccess(db, user, row.appId);
}

export async function assertRunAccess(db: Database, user: AuthUser, runId: string): Promise<void> {
  if (user.role !== 'viewer') return;
  const [row] = await db
    .select({ appId: checks.appId })
    .from(runs)
    .innerJoin(checks, eq(runs.checkId, checks.id))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) return;
  await assertAppAccess(db, user, row.appId);
}

/** Restricts an existing app-id condition list to a viewer's accessible set;
 * mutates nothing — callers AND the returned condition into their query. A
 * viewer with zero assignments gets `inArray(col, [])`, which correctly
 * matches nothing rather than accidentally matching everything. */
export function viewerAppScope(
  ids: string[] | null,
  col: Parameters<typeof inArray>[0],
): ReturnType<typeof inArray> | undefined {
  if (ids === null) return undefined; // admin/editor: no restriction
  return inArray(col, ids);
}

/** Channel management was and remains admin-only for global channels — this
 * only ADDS a narrow viewer carve-out for channels a viewer owns themselves.
 * Editor is deliberately excluded, unchanged from before this role existed:
 * editors manage apps/checks, never alert routing. */
export function assertChannelOwnership(user: AuthUser, channel: Pick<AlertChannelRow, 'ownerId'>): void {
  if (user.role === 'admin') return;
  if (user.role === 'viewer' && channel.ownerId === user.id) return;
  throw forbidden('Not permitted to manage this channel');
}
