// Incidents used to show as an always-visible banner here; that's now the
// dedicated /incidents tab plus a transient toast on the WS incident.opened
// event (ToastProvider) and the header's bell badge for the ambient count.
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { AmbientBackground } from './AmbientBackground';

export function Layout(): JSX.Element {
  return (
    <div className="min-h-full">
      <AmbientBackground />
      <Header />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
