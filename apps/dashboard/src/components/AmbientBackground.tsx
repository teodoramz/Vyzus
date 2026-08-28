import type { JSX } from 'react';

/**
 * Fixed, full-viewport, behind all content and non-interactive: a dot grid plus
 * two slow-drifting glows so the page background is not flat.
 *
 * The glows carry platform state rather than a fixed brand colour. Emerald is
 * what UP means everywhere else in this app, so painting every page with it
 * spent the status palette on decoration — and kept saying "healthy" while
 * something was down. Neutral is the resting state; the room only takes on
 * colour when there is something to say. Peripheral and slow on purpose: the
 * header counts and the cards are what you read, this is what you notice.
 *
 * Animation is motion-safe only; reduced-motion users get the static layer.
 */
export type AmbientTone = 'neutral' | 'degraded' | 'down';

const TONES: Record<AmbientTone, { a: string; b: string }> = {
  neutral: {
    a: 'bg-slate-400/25 dark:bg-indigo-400/15',
    b: 'bg-sky-400/25 dark:bg-sky-400/15',
  },
  degraded: {
    a: 'bg-amber-400/30 dark:bg-amber-400/20',
    b: 'bg-orange-400/25 dark:bg-amber-500/15',
  },
  down: {
    a: 'bg-rose-400/30 dark:bg-rose-500/20',
    b: 'bg-red-400/25 dark:bg-rose-600/15',
  },
};

export function AmbientBackground({ tone = 'neutral' }: { tone?: AmbientTone }): JSX.Element {
  const { a, b } = TONES[tone];
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-40 dark:opacity-20"
        style={{
          backgroundImage: 'radial-gradient(currentColor 1.5px, transparent 1.5px)',
          backgroundSize: '26px 26px',
          color: '#94a3b8',
        }}
      />
      {/* Long transition so a recovery fades rather than snaps. */}
      <div
        className={`motion-safe:animate-driftA absolute -left-32 -top-32 h-[32rem] w-[32rem] rounded-full blur-2xl transition-colors duration-1000 ${a}`}
      />
      <div
        className={`motion-safe:animate-driftB absolute -bottom-32 -right-32 h-[32rem] w-[32rem] rounded-full blur-2xl transition-colors duration-1000 ${b}`}
      />
    </div>
  );
}
