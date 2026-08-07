// Visual regression (backlog task 8). A screenshot is kept per run, so
// consecutive captures can be compared: defacement, broken CSS and blank-page
// deploys all return HTTP 200 and satisfy every selector assertion, yet look
// obviously wrong to a person.
//
// pixelmatch + pngjs rather than a headless-browser comparison: both are tiny
// and dependency-free, and the work is pure CPU on two buffers we already have.
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface DiffOutcome {
  /** Percentage of pixels that differ, 0-100. */
  changedPercent: number;
  /** False when the two images could not be compared at all. */
  comparable: boolean;
  reason?: string;
}

/**
 * Compare two PNG buffers.
 *
 * A size change is reported as 100% rather than an error: the page genuinely
 * looks different, and silently passing a layout that changed shape would
 * defeat the point. Anything that cannot be decoded is reported as
 * not-comparable so the caller can pass rather than fail on our own problem.
 */
export function comparePng(previous: Buffer, current: Buffer): DiffOutcome {
  let a: PNG;
  let b: PNG;
  try {
    a = PNG.sync.read(previous);
    b = PNG.sync.read(current);
  } catch (err) {
    return { changedPercent: 0, comparable: false, reason: err instanceof Error ? err.message : 'undecodable PNG' };
  }

  if (a.width !== b.width || a.height !== b.height) {
    return {
      changedPercent: 100,
      comparable: true,
      reason: `size changed from ${a.width}x${a.height} to ${b.width}x${b.height}`,
    };
  }

  const total = a.width * a.height;
  if (total === 0) return { changedPercent: 0, comparable: false, reason: 'empty image' };

  // threshold is per-pixel colour tolerance (not the pass/fail threshold):
  // 0.1 is pixelmatch's default and ignores antialiasing-level noise.
  // No diff-image output buffer: we only need the count, not a visual.
  const changed = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  return { changedPercent: (changed / total) * 100, comparable: true };
}
