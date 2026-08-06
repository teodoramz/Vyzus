// Fixed, full-viewport, `-z-10` — always behind content, never intercepts
// clicks (pointer-events-none). A visible dot grid (the "engineering tool"
// texture) plus two slow-drifting brand-colored glows keep the plain
// gray-50/zinc-950 background from reading as empty. Tuned to actually be
// seen at a glance (checked against real screenshots, not just computed
// styles — a first pass here was so subtle it was pixel-identical to a
// blank background) while staying well behind foreground content and never
// touching the dark-mode card-contrast fix. motion-safe: only — a user with
// reduced-motion set just gets the static grid + glows, no drift.
export function AmbientBackground(): JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-[0.55] dark:opacity-[0.25]"
        style={{
          backgroundImage: 'radial-gradient(currentColor 1.5px, transparent 1.5px)',
          backgroundSize: '26px 26px',
          color: '#94a3b8',
        }}
      />
      <div className="motion-safe:animate-driftA absolute -left-32 -top-32 h-[32rem] w-[32rem] rounded-full bg-emerald-400/40 blur-2xl dark:bg-emerald-400/25" />
      <div className="motion-safe:animate-driftB absolute -bottom-32 -right-32 h-[32rem] w-[32rem] rounded-full bg-cyan-500/40 blur-2xl dark:bg-cyan-400/25" />
    </div>
  );
}
