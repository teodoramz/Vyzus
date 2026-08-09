// Application dependencies: "this service sits behind that gateway".
//
// Without them, one dead upstream pages once per service behind it — forty
// alerts describing a single fault, which is how people learn to ignore the
// channel. With them, the upstream alerts and everything downstream stays quiet
// until it is genuinely the thing at fault.
//
// Pure, so the traversal (and its cycle guard) can be tested without a database.

/** Only what the traversal reads. */
export interface AppNode {
  id: string;
  parentAppId: string | null;
  name: string;
  /** Derived status; `DOWN` is what suppresses descendants. */
  status: string;
}

/**
 * The nearest ancestor that is DOWN, or null.
 *
 * Walks the whole chain rather than only the immediate parent: if the host is
 * down, a service two levels below it is just as much collateral as one level.
 *
 * `DEGRADED` deliberately does not suppress. A partly-working upstream can
 * still leave a specific downstream genuinely broken, and silencing that would
 * hide a real fault behind an unrelated one.
 *
 * A cycle (A → B → A) can only arise from bad data, but the traversal must not
 * hang on it, so visited ids terminate the walk.
 */
export function findFailingAncestor(appId: string, byId: ReadonlyMap<string, AppNode>): AppNode | null {
  const seen = new Set<string>([appId]);
  let current = byId.get(appId)?.parentAppId ?? null;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    if (!node) return null;
    if (node.status === 'DOWN') return node;
    current = node.parentAppId;
  }
  return null;
}

/**
 * Whether setting `parentId` as the parent of `appId` would create a cycle.
 * Checked before writing, because the traversal above tolerates a cycle but the
 * data should never contain one.
 */
export function wouldCreateCycle(
  appId: string,
  parentId: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  if (parentId === null) return false;
  if (parentId === appId) return true;

  const seen = new Set<string>([appId]);
  let current: string | null = parentId;
  while (current !== null) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}
