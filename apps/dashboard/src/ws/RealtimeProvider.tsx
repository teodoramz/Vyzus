// Bridges WS events (docs/04-api-spec.md `/ws`) into TanStack Query cache
// invalidation, and re-invalidates the same keys on the 30s polling fallback
// tick when the socket is down. Mounted once near the app root, below
// AuthProvider so it only connects once a token exists.
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEvent } from '@vyzus/shared';
import { useVyzusSocket, type ConnectionState } from './useVyzusSocket';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/ToastProvider';

const ConnectionStateContext = createContext<ConnectionState>('connecting');

export function useConnectionState(): ConnectionState {
  return useContext(ConnectionStateContext);
}

export function RealtimeProvider({ children }: { children: ReactNode }): JSX.Element {
  const qc = useQueryClient();
  const { status } = useAuth();
  const showToast = useToast();

  const handleEvent = (event: WsEvent) => {
    switch (event.type) {
      case 'run.finished':
        void qc.invalidateQueries({ queryKey: ['apps'] });
        void qc.invalidateQueries({ queryKey: ['app', event.appId] });
        void qc.invalidateQueries({ queryKey: ['checks', event.checkId] });
        void qc.invalidateQueries({ queryKey: ['runs', event.checkId] });
        void qc.invalidateQueries({ queryKey: ['run', event.runId] });
        void qc.invalidateQueries({ queryKey: ['sparkline', event.appId] });
        break;
      case 'incident.opened': {
        void qc.invalidateQueries({ queryKey: ['incidents'] });
        void qc.invalidateQueries({ queryKey: ['app', event.appId] });
        void qc.invalidateQueries({ queryKey: ['apps'] });
        void qc.invalidateQueries({ queryKey: ['stats'] });
        const app = qc.getQueryData<{ name: string }>(['app', event.appId]);
        showToast({
          message: app ? `${app.name} — a check just went down` : 'A check just went down',
          linkTo: `/apps/${event.appId}?check=${event.checkId}&incident=${event.incidentId}`,
          tone: 'critical',
        });
        break;
      }
      case 'incident.resolved': {
        void qc.invalidateQueries({ queryKey: ['incidents'] });
        void qc.invalidateQueries({ queryKey: ['app', event.appId] });
        void qc.invalidateQueries({ queryKey: ['apps'] });
        void qc.invalidateQueries({ queryKey: ['stats'] });
        const app = qc.getQueryData<{ name: string }>(['app', event.appId]);
        showToast({
          message: app ? `${app.name} — recovered` : 'A check recovered',
          linkTo: `/apps/${event.appId}?check=${event.checkId}&incident=${event.incidentId}`,
          tone: 'good',
        });
        break;
      }
      case 'stats.updated':
        qc.setQueryData(['stats'], (prev: unknown) =>
          prev && typeof prev === 'object'
            ? {
                ...prev,
                apps: { ...(prev as any).apps, up: event.up, down: event.down },
                openIncidents: event.openIncidents,
              }
            : prev,
        );
        break;
    }
  };

  const { state, pollTick } = useVyzusSocket(handleEvent);

  useEffect(() => {
    if (pollTick === 0) return;
    void qc.invalidateQueries({ queryKey: ['apps'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
    void qc.invalidateQueries({ queryKey: ['incidents'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollTick]);

  if (status !== 'authenticated') {
    return <ConnectionStateContext.Provider value="polling">{children}</ConnectionStateContext.Provider>;
  }

  return <ConnectionStateContext.Provider value={state}>{children}</ConnectionStateContext.Provider>;
}
