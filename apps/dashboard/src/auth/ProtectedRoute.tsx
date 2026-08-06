import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: JSX.Element;
  requireAdmin?: boolean;
}): JSX.Element {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <div className="flex h-screen items-center justify-center text-slate-600 dark:text-zinc-400">Loading…</div>;
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (requireAdmin && user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return children;
}
