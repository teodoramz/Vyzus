// Keyset pagination cursor shared by every runs-listing route
// (started_at, id) desc — see docs/04-api-spec.md.
import { badRequest } from './errors.js';

export interface RunsCursor {
  s: string; // startedAt ISO
  id: string;
}

export function encodeCursor(c: RunsCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): RunsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as RunsCursor;
    if (typeof parsed.s !== 'string' || typeof parsed.id !== 'string') throw new Error('bad');
    return parsed;
  } catch {
    throw badRequest('Invalid cursor', 'INVALID_CURSOR');
  }
}
