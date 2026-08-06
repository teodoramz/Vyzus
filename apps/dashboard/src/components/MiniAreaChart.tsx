// Per-card trend for the bento overview grid: Recharts AreaChart, no
// cartesian grid/axes (a small-multiple, not a standalone chart — the card
// already gives the numbers), gradient wash under the line, tooltip styled
// as a small Tailwind popover.
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatMs } from '../lib/format';

const COLOR = {
  good: '#10b981', // emerald-500
  critical: '#f43f5e', // rose-500
  neutral: '#71717a', // zinc-500
} as const;

function CardTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-2 py-1 font-mono text-xs shadow-lg dark:border-white/10 dark:bg-zinc-900">
      {formatMs(payload[0]!.value)}
    </div>
  );
}

export function MiniAreaChart({
  values,
  status,
  height = 44,
}: {
  values: number[];
  status: 'good' | 'critical' | 'neutral';
  height?: number;
}): JSX.Element | null {
  // Hold the space rather than returning null, so a new card does not reflow
  // once its second run lands.
  if (values.length < 2) {
    return (
      <div style={{ height }} className="flex w-full items-center text-[11px] text-slate-300 dark:text-zinc-700">
        Not enough runs yet
      </div>
    );
  }
  const color = COLOR[status];
  const data = values.map((v, i) => ({ i, v }));
  const gradientId = `sparkFill-${status}`;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip content={<CardTooltip />} cursor={{ stroke: color, strokeOpacity: 0.3 }} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.75}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, fill: color }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
