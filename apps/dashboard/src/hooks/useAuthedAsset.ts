// Screenshot/trace artifact routes require a Bearer token (docs/04-api-spec.md
// "auth required"), so plain <img src>/<a href> can't be used directly — the
// browser sends no custom headers for those. This hook fetches the asset with
// the current access token and exposes an object URL, retried once through the
// same 401 -> refresh flow as apiRequest.
import { useEffect, useState } from 'react';
import { getAccessToken } from '../auth/tokenStore';
import { authApi } from '../api/endpoints';
import { setAccessToken } from '../auth/tokenStore';

export function useAuthedAsset(url: string | null): { objectUrl: string | null; loading: boolean; error: boolean } {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let currentBlobUrl: string | null = null;
    setLoading(true);
    setError(false);

    async function fetchOnce(): Promise<Response> {
      const token = getAccessToken();
      return fetch(url!, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
    }

    (async () => {
      try {
        let res = await fetchOnce();
        if (res.status === 401) {
          try {
            const refreshed = await authApi.refresh();
            setAccessToken(refreshed.accessToken);
            res = await fetchOnce();
          } catch {
            // fall through to error below
          }
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        currentBlobUrl = URL.createObjectURL(blob);
        setObjectUrl(currentBlobUrl);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    };
  }, [url]);

  return { objectUrl, loading, error };
}

/** Fetch + trigger a browser download for a binary artifact (trace.zip). */
export async function downloadAuthedAsset(url: string, filename: string): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
