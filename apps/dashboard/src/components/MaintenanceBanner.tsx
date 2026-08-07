// Shows when alerts are being suppressed for planned work. Without this, a
// silenced platform is indistinguishable from a healthy one — the same
// confusion the dead-man's switch exists to prevent, just with a different
// cause.
import { useQuery } from '@tanstack/react-query';
import { maintenanceApi } from '../api/endpoints';
import { formatDateTime } from '../lib/format';

export function MaintenanceBanner(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['maintenance', 'active'],
    queryFn: () => maintenanceApi.active(),
    refetchInterval: 60_000,
  });

  const windows = data ?? [];
  if (windows.length === 0) return null;

  return (
    <div
      role="status"
      className="border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-center text-sm text-sky-800 dark:text-sky-300"
    >
      {windows.length === 1 ? (
        <>
          Alerts suppressed for {windows[0]!.appName ?? 'all applications'} until {formatDateTime(windows[0]!.endsAt)} —{' '}
          {windows[0]!.reason}. Checks are still running and incidents are still recorded.
        </>
      ) : (
        <>
          {windows.length} maintenance windows are suppressing alerts. Checks are still running and incidents are still
          recorded.
        </>
      )}
    </div>
  );
}
