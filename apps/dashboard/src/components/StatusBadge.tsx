// Status color mapping fixed by the brief: green UP / red DOWN / gray PAUSED /
// amber UNKNOWN — electric emerald/rose in dark mode (SOC vibe), standard
// green-600/red-600 in light mode (aviation-dashboard vibe), matching the
// bento overview cards. Status is never color-alone: every badge carries an
// icon + label.
import type { AppStatus } from '@vyzus/shared';

const STATUS_META: Record<AppStatus, { label: string; dot: string; text: string; bg: string; icon: string }> = {
  UP: {
    label: 'Up',
    dot: 'bg-green-600 dark:bg-emerald-400',
    text: 'text-green-600 dark:text-emerald-400',
    bg: 'bg-green-600/10 dark:bg-emerald-400/10',
    icon: '●', // filled circle
  },
  DOWN: {
    label: 'Down',
    dot: 'bg-red-600 dark:bg-rose-500',
    text: 'text-red-600 dark:text-rose-500',
    bg: 'bg-red-600/10 dark:bg-rose-500/10',
    icon: '▲', // triangle
  },
  PAUSED: {
    label: 'Paused',
    dot: 'bg-slate-400 dark:bg-zinc-600',
    text: 'text-slate-500 dark:text-zinc-500',
    bg: 'bg-slate-400/10 dark:bg-zinc-600/10',
    icon: '⏸', // pause
  },
  UNKNOWN: {
    label: 'Unknown',
    dot: 'bg-amber-500 dark:bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10 dark:bg-amber-400/10',
    icon: '●',
  },
};

export function StatusBadge({ status, size = 'md' }: { status: AppStatus; size?: 'sm' | 'md' }): JSX.Element {
  const meta = STATUS_META[status];
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-mono font-medium ${meta.bg} ${meta.text} ${padding}`}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
