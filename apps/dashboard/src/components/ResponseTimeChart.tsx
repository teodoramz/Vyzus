// App-detail "response-time chart" (FR-4.2). Single series -> no legend box
// (the title names it); hairline horizontal gridlines only; 2px line with an
// accent area wash at 10% opacity; crosshair tooltip on hover per the dataviz
// skill's interaction guidance. Failed/error/timeout runs are marked with a
// small critical dot (with a surface ring) so a failure is visible directly on
// the trend, not only in the table below. Colors match the command-center
// palette: cyan accent line, rose failure dots, surface = the card's own
// bg-zinc-900 so the dot ring cuts cleanly out of the line in dark mode.
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Run } from '@vyzus/shared';
import { formatMs } from '../lib/format';
import { useDarkModeValue } from '../hooks/useDarkModeValue';

interface Point {
  startedAt: string;
  durationMs: number;
  status: Run['status'];
}

const CHROME = {
  light: {
    series: '#0891b2',
    grid: '#e5e7eb',
    baseline: '#d1d5db',
    tick: '#94a3b8',
    surface: '#ffffff',
    critical: '#dc2626',
  },
  dark: {
    series: '#22d3ee',
    grid: '#27272a',
    baseline: '#3f3f46',
    tick: '#71717a',
    surface: '#18181b',
    critical: '#f43f5e',
  },
} as const;

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as Point;
  const failed = p.status !== 'passed';
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-white/10 dark:bg-zinc-900">
      <div className="font-mono text-slate-400 dark:text-zinc-500">{new Date(p.startedAt).toLocaleString()}</div>
      <div className="font-mono font-medium text-slate-900 dark:text-zinc-100">{formatMs(p.durationMs)}</div>
      {failed && <div className="font-medium text-red-600 dark:text-rose-500">{p.status}</div>}
    </div>
  );
}

export function ResponseTimeChart({ runs }: { runs: Run[] }): JSX.Element {
  const dark = useDarkModeValue();
  const c = dark ? CHROME.dark : CHROME.light;
  const data: Point[] = [...runs]
    .reverse()
    .map((r) => ({ startedAt: r.startedAt, durationMs: r.durationMs, status: r.status }));

  if (data.length < 2) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-slate-400 dark:text-zinc-500">
        Not enough runs yet for a trend.
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="responseTimeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.series} stopOpacity={0.1} />
              <stop offset="100%" stopColor={c.series} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={c.grid} strokeDasharray="0" />
          <XAxis
            dataKey="startedAt"
            tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            tick={{ fontSize: 11, fill: c.tick }}
            axisLine={{ stroke: c.baseline }}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tickFormatter={(v) => formatMs(v)}
            tick={{ fontSize: 11, fill: c.tick }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="durationMs"
            stroke={c.series}
            strokeWidth={2}
            fill="url(#responseTimeFill)"
            dot={(props: any) => {
              const failed = props.payload.status !== 'passed';
              if (!failed) return <g key={props.key} />;
              return (
                <circle
                  key={props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={c.critical}
                  stroke={c.surface}
                  strokeWidth={2}
                />
              );
            }}
            activeDot={{ r: 4, strokeWidth: 2, stroke: c.surface }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
