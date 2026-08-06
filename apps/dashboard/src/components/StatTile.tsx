export function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'critical' | 'warning' | undefined;
}): JSX.Element {
  const toneClass =
    tone === 'good'
      ? 'text-green-600 dark:text-emerald-400'
      : tone === 'critical'
        ? 'text-red-600 dark:text-rose-500'
        : tone === 'warning'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-slate-900 dark:text-zinc-100';
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
      <div className="text-xs text-slate-400 dark:text-zinc-500">{label}</div>
      <div className={`font-mono text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
