import { useAuthedAsset } from '../hooks/useAuthedAsset';
import { runsApi } from '../api/endpoints';

export function ScreenshotThumb({
  runId,
  alt,
  className = '',
}: {
  runId: string | null;
  alt: string;
  className?: string;
}): JSX.Element {
  const url = runId ? runsApi.screenshotUrl(runId) : null;
  const { objectUrl, loading, error } = useAuthedAsset(url);

  if (!runId) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 text-xs text-slate-400 dark:text-zinc-500 dark:bg-zinc-800 ${className}`}
      >
        No screenshot yet
      </div>
    );
  }
  if (error) {
    return (
      <div
        className={`flex items-center justify-center bg-gray-100 text-xs text-slate-400 dark:text-zinc-500 dark:bg-zinc-800 ${className}`}
      >
        Screenshot unavailable
      </div>
    );
  }
  if (loading || !objectUrl) {
    return <div className={`animate-pulse bg-gray-100 dark:bg-white/10 ${className}`} />;
  }
  return <img src={objectUrl} alt={alt} className={`object-cover object-top ${className}`} />;
}
