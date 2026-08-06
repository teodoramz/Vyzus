// FR-2.6 dry-run result panel — renders `dryRunResultSchema` from
// @vyzus/shared inline (status, duration, metrics, error). A dry run is
// never persisted (docs/04-api-spec.md), so there is no run id and no
// artifact routes to link; everything shown comes from the inline response.
import type { DryRunResult as DryRunResultType } from '@vyzus/shared';
import { RunStatusBadge } from './RunStatusBadge';
import { formatMs } from '../lib/format';

export function DryRunResult({ result }: { result: DryRunResultType }): JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-100 p-4 dark:border-white/10 dark:bg-zinc-800">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">Dry-run result</h3>
        <RunStatusBadge status={result.status} />
        <span className="tabular text-sm text-slate-400 dark:text-zinc-500">{formatMs(result.durationMs)}</span>
      </div>

      {result.errorMessage && (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-red-600/10 dark:bg-rose-500/10 p-2 text-xs text-red-600 dark:text-rose-500">
          {result.errorMessage}
        </pre>
      )}

      {result.metrics && Object.keys(result.metrics).length > 0 && (
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          {Object.entries(result.metrics).map(([key, value]) => (
            <div key={key}>
              <dt className="text-slate-400 dark:text-zinc-500">{key}</dt>
              <dd className="tabular font-medium">
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
