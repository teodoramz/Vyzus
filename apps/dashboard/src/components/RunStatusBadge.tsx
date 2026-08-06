import type { RunStatus } from '@vyzus/shared';

const RUN_STATUS_META: Record<RunStatus, { label: string; text: string; bg: string }> = {
  passed: {
    label: 'Passed',
    text: 'text-green-600 dark:text-emerald-400',
    bg: 'bg-green-600/10 dark:bg-emerald-400/10',
  },
  failed: { label: 'Failed', text: 'text-red-600 dark:text-rose-500', bg: 'bg-red-600/10 dark:bg-rose-500/10' },
  error: { label: 'Error', text: 'text-red-600 dark:text-rose-500', bg: 'bg-red-600/10 dark:bg-rose-500/10' },
  timeout: {
    label: 'Timeout',
    text: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-600/10 dark:bg-orange-400/10',
  },
};

export function RunStatusBadge({ status }: { status: RunStatus }): JSX.Element {
  const meta = RUN_STATUS_META[status];
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${meta.bg} ${meta.text}`}>
      {meta.label}
    </span>
  );
}
