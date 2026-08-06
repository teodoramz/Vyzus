// WS client for docs/04-api-spec.md `/ws`: auth via `?token=`, server->client
// events only (run.finished / incident.opened / incident.resolved /
// stats.updated). Falls back to a 30s polling tick (consumers re-run their
// TanStack Query fetches on it) whenever the socket isn't OPEN, per FR-4.1 /
// the vyzus-frontend brief.
import { useEffect, useRef, useState } from 'react';
import { wsEventSchema, type WsEvent } from '@vyzus/shared';
import { getAccessToken, onAccessTokenChange } from '../auth/tokenStore';

export type ConnectionState = 'connecting' | 'open' | 'polling';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const POLL_FALLBACK_MS = 30_000;

export function useVyzusSocket(onEvent: (event: WsEvent) => void): { state: ConnectionState; pollTick: number } {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [pollTick, setPollTick] = useState(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let closedByUs = false;

    function startPolling() {
      setState('polling');
      if (pollTimer) return;
      pollTimer = setInterval(() => setPollTick((t) => t + 1), POLL_FALLBACK_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function connect() {
      const token = getAccessToken();
      if (!token) {
        startPolling();
        return;
      }
      setState('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
        stopPolling();
        setState('open');
      };

      ws.onmessage = (ev) => {
        try {
          const parsed = wsEventSchema.parse(JSON.parse(ev.data));
          onEventRef.current(parsed);
        } catch {
          // ignore malformed/unknown events
        }
      };

      ws.onclose = () => {
        if (closedByUs) return;
        startPolling();
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    const unsubscribe = onAccessTokenChange((token) => {
      if (!token) {
        socket?.close();
        stopPolling();
        setState('polling');
        return;
      }
      // Token appeared (login, or silent refresh after the socket died): if
      // there's no live socket, (re)connect now instead of waiting for a poll
      // tick — this is what flips the UI from "Polling" to "Live" right after
      // sign-in, since this hook mounts before any token exists.
      const alive =
        socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
      if (!alive) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        attempt = 0;
        connect();
      }
    });

    return () => {
      closedByUs = true;
      unsubscribe();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      socket?.close();
    };
  }, []);

  return { state, pollTick };
}
