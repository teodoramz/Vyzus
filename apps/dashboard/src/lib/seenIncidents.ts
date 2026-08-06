// Bell-badge "read" state: purely a local UI concept (never changes an
// incident's actual open/resolved state server-side) — visiting the
// Incidents tab marks every currently-open incident as seen, so the badge
// count drops to just what's genuinely new since you last looked. Stored in
// localStorage (per browser, not synced across devices — acceptable for the
// small-team scope this dashboard targets) and mirrored into the TanStack
// Query cache under ['seenIncidentIds'] so the header re-renders immediately
// without a page reload when the Incidents page marks something seen.
const STORAGE_KEY = 'vyzus.seenIncidentIds';
const MAX_TRACKED = 500; // bound growth over months of use

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeSeen(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_TRACKED)));
  } catch {
    // localStorage disabled/full — badge just won't remember across reloads.
  }
}

export function getSeenIncidentIds(): Set<string> {
  return readSeen();
}

export function markIncidentsSeen(ids: string[]): Set<string> {
  const seen = readSeen();
  for (const id of ids) seen.add(id);
  writeSeen(seen);
  return seen;
}
