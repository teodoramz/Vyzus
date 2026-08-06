// Fixed, full-viewport, behind all content and non-interactive. A dot grid
// plus two slow-drifting brand glows, so the page background is not flat.
// Animation is motion-safe only; reduced-motion users get the static layer.
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
