// Incidents used to show as an always-visible banner here; that's now the
// dedicated /incidents tab plus a transient toast on the WS incident.opened
// event (ToastProvider) and the header's bell badge for the ambient count.
import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Header } from './Header';
import { AmbientBackground, type AmbientTone } from './AmbientBackground';
import { statsApi } from '../api/endpoints';

export function Layout(): JSX.Element {
  // Shares the cache with the header's identical query, so this costs no
  // extra request; it just decides what colour the room is.
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: statsApi.get, refetchInterval: 30_000 });
  const tone: AmbientTone = stats?.apps.down ? 'down' : stats?.apps.degraded ? 'degraded' : 'neutral';

  return (
    <div className="min-h-full">
      <AmbientBackground tone={tone} />
      <Header />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
