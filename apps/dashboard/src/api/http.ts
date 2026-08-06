// Thin fetch wrapper: relative /api/v1 URLs (nginx/vite proxy in prod/dev),
// Bearer auth from the in-memory token store, uniform `{error:{code,message}}`
// unwrapping, and a single silent-refresh-then-retry on 401 per 04-api-spec.md.
// Every call site passes a Zod schema so the response is both typed and
// runtime-validated against the contract in @vyzus/shared.
import type { ZodType, ZodTypeDef } from 'zod';

// Schemas with `.default(...)` fields (e.g. uptimeConfigSchema.screenshot) have
// an Input type that differs from their Output type (Output has the default
// applied and is required). Every call site only cares about the *parsed*
// Output shape, so the Input param is deliberately left as `any` here —
// pinning it to `T` would force every schema literal to satisfy an Input/Output
// unification TS can't derive, even though runtime parsing is unaffected.
type ResponseSchema<T> = ZodType<T, ZodTypeDef, any>;
import { getAccessToken, setAccessToken } from '../auth/tokenStore';
import { refreshResponseSchema } from '@vyzus/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Set by the auth provider once mounted; called after a refresh attempt fails. */
let onAuthFailure: (() => void) | null = null;
export function registerAuthFailureHandler(fn: () => void): void {
  onAuthFailure = fn;
}

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return null;
      const json = await res.json();
      const parsed = refreshResponseSchema.parse(json);
      setAccessToken(parsed.accessToken);
      return parsed.accessToken;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip the Bearer header (login only). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.pathname + url.search;
}

async function rawRequest(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!opts.anonymous) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  // Built incrementally (rather than a literal with `body: ... ?? undefined`)
  // because `exactOptionalPropertyTypes` rejects explicitly assigning
  // `undefined` to RequestInit's optional `body`/`signal` keys.
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal !== undefined) init.signal = opts.signal;
  return fetch(buildUrl(path, opts.query), init);
}

async function parseErrorEnvelope(res: Response): Promise<{ code: string; message: string }> {
  try {
    const json = await res.json();
    if (json?.error?.code && json?.error?.message) return json.error;
  } catch {
    // fall through
  }
  return { code: 'UNKNOWN', message: res.statusText || `HTTP ${res.status}` };
}

/** No-content requests (204) don't get a schema. */
export async function apiRequest<T>(path: string, schema: ResponseSchema<T>, opts: RequestOptions = {}): Promise<T> {
  let res = await rawRequest(path, opts);

  if (res.status === 401 && !opts.anonymous) {
    const newToken = await doRefresh();
    if (newToken) {
      res = await rawRequest(path, opts);
    } else {
      setAccessToken(null);
      onAuthFailure?.();
      throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired');
    }
  }

  if (res.status === 401 && !opts.anonymous) {
    setAccessToken(null);
    onAuthFailure?.();
  }

  if (!res.ok) {
    const err = await parseErrorEnvelope(res);
    throw new ApiError(res.status, err.code, err.message);
  }

  if (res.status === 204) return undefined as T;
  const json = await res.json();
  return schema.parse(json);
}

export async function apiRequestVoid(path: string, opts: RequestOptions = {}): Promise<void> {
  let res = await rawRequest(path, opts);
  if (res.status === 401 && !opts.anonymous) {
    const newToken = await doRefresh();
    if (newToken) {
      res = await rawRequest(path, opts);
    } else {
      setAccessToken(null);
      onAuthFailure?.();
      throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired');
    }
  }
  if (!res.ok) {
    const err = await parseErrorEnvelope(res);
    throw new ApiError(res.status, err.code, err.message);
  }
}
