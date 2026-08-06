// Guard for the first-boot Setup screen, so /setup cannot be reached on an
// instance that already has users. The API enforces this too (409); this only
// avoids rendering a form that could never succeed.
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { Setup } from './Setup';

export function SetupRoute(): JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['auth', 'setup-status'],
    queryFn: authApi.setupStatus,
    staleTime: 60_000,
    retry: 1,
  });

  if (isLoading) return <p className="p-6 text-slate-400 dark:text-zinc-500">Loading...</p>;
  // If the status call itself fails we can't tell whether setup is needed;
  // fall back to the login screen rather than offering to create an admin.
  if (isError || !data?.needsSetup) return <Navigate to="/login" replace />;
  return <Setup />;
}
