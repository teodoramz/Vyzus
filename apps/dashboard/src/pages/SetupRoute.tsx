// Guard around the first-boot Setup screen. Keeps the "is setup still
// needed?" check in one place so /setup can't be reached (or bookmarked)
// on an instance that already has users — the API enforces this too
// (POST /auth/setup is 409 once any user exists); this just avoids showing
// a form that could only ever fail.
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
