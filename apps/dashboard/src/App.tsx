import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { RealtimeProvider } from './ws/RealtimeProvider';
import { ToastProvider } from './components/ToastProvider';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { SetupRoute } from './pages/SetupRoute';
import { Overview } from './pages/Overview';
import { Channels } from './pages/Channels';
import { Incidents } from './pages/Incidents';
import { Settings } from './pages/Settings';

// Code-split the heaviest pages (Monaco editor, Recharts) so the initial
// bundle stays light per NFR-1 ("UI initial load < 2s") — they're only
// fetched when a user actually navigates to them.
const AppDetail = lazy(() => import('./pages/AppDetail').then((m) => ({ default: m.AppDetail })));
const RunDetail = lazy(() => import('./pages/RunDetail').then((m) => ({ default: m.RunDetail })));
const CheckEditor = lazy(() => import('./pages/CheckEditor').then((m) => ({ default: m.CheckEditor })));
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })));

function PageFallback(): JSX.Element {
  return <p className="text-slate-400 dark:text-zinc-500">Loading…</p>;
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ToastProvider>
            <RealtimeProvider>
              <Suspense fallback={<PageFallback />}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/setup" element={<SetupRoute />} />
                  <Route
                    element={
                      <ProtectedRoute>
                        <Layout />
                      </ProtectedRoute>
                    }
                  >
                    <Route path="/" element={<Overview />} />
                    <Route path="/apps/:id" element={<AppDetail />} />
                    <Route path="/apps/:appId/checks/new" element={<CheckEditor />} />
                    <Route path="/checks/:checkId/edit" element={<CheckEditor />} />
                    <Route path="/runs/:id" element={<RunDetail />} />
                    <Route path="/channels" element={<Channels />} />
                    <Route path="/incidents" element={<Incidents />} />
                    <Route
                      path="/users"
                      element={
                        <ProtectedRoute requireAdmin>
                          <Users />
                        </ProtectedRoute>
                      }
                    />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="*" element={<Overview />} />
                  </Route>
                </Routes>
              </Suspense>
            </RealtimeProvider>
          </ToastProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
