// In-memory access-token store. Never persisted (no localStorage/sessionStorage)
// so a token never survives a full page reload — reload re-hydrates via the
// httpOnly refresh cookie (POST /auth/refresh) instead. A tiny pub/sub lets the
// API client and the auth context stay in sync without React context plumbing
// inside the client module itself.
let accessToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const l of listeners) l(token);
}

export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
