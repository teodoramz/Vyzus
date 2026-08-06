// Brand mark: a monospace "V" chip on an emerald->cyan gradient, glowing in
// dark mode, with a small pulsing live-signal dot at the corner. Ties the
// identity directly to the command-center palette (emerald is UP/success
// everywhere else in the app) instead of a literal, decorative icon.
export function VyzusMark({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 font-mono font-bold text-zinc-950 shadow-[0_0_16px_-2px_rgba(16,185,129,0.55)] dark:shadow-[0_0_20px_-1px_rgba(16,185,129,0.65)]"
      style={{ width: size, height: size, fontSize: size * 0.52 }}
      aria-hidden="true"
    >
      V
      <span className="motion-safe:animate-pulse absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-gray-50 dark:ring-zinc-950" />
    </span>
  );
}
