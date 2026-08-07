// Visual regression: defacement, broken CSS and blank-page deploys all return
// HTTP 200 and satisfy every selector assertion, so pixels are the only signal.
// Real PNG buffers throughout — a mocked differ would prove nothing.
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { comparePng } from '../visual-diff.js';

/** Solid-colour PNG, optionally with a differently coloured rectangle. */
function png(
  width: number,
  height: number,
  base: [number, number, number],
  patch?: { x: number; y: number; w: number; h: number; color: [number, number, number] },
): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inPatch =
        patch !== undefined && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
      const [r, g, b] = inPatch ? patch!.color : base;
      const i = (width * y + x) << 2;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

describe('comparePng', () => {
  it('reports 0% for identical images', () => {
    const a = png(100, 100, WHITE);
    const outcome = comparePng(a, png(100, 100, WHITE));
    expect(outcome.comparable).toBe(true);
    expect(outcome.changedPercent).toBe(0);
  });

  it('reports the exact proportion of changed pixels', () => {
    // A 10x10 black square in a 100x100 image = 100 / 10000 = 1%.
    const before = png(100, 100, WHITE);
    const after = png(100, 100, WHITE, { x: 0, y: 0, w: 10, h: 10, color: BLACK });
    const outcome = comparePng(before, after);
    expect(outcome.comparable).toBe(true);
    expect(outcome.changedPercent).toBeCloseTo(1, 5);
  });

  // A blank-page deploy still returns 200 and is the case this exists for.
  it('reports a near-total change when the page goes blank', () => {
    const before = png(100, 100, BLACK);
    const outcome = comparePng(before, png(100, 100, WHITE));
    expect(outcome.changedPercent).toBe(100);
  });

  // A layout that changed shape genuinely looks different; silently passing it
  // would defeat the purpose.
  it('treats a size change as fully changed, with a reason', () => {
    const outcome = comparePng(png(100, 100, WHITE), png(120, 100, WHITE));
    expect(outcome.comparable).toBe(true);
    expect(outcome.changedPercent).toBe(100);
    expect(outcome.reason).toMatch(/size changed from 100x100 to 120x100/);
  });

  // Our own problem must never fail someone's healthy check.
  it('reports undecodable input as not comparable rather than throwing', () => {
    const outcome = comparePng(Buffer.from('not a png'), png(10, 10, WHITE));
    expect(outcome.comparable).toBe(false);
    expect(outcome.changedPercent).toBe(0);
  });

  it('ignores antialiasing-level noise below the per-pixel tolerance', () => {
    const before = png(50, 50, [255, 255, 255]);
    const after = png(50, 50, [253, 253, 253]);
    expect(comparePng(before, after).changedPercent).toBe(0);
  });
});
