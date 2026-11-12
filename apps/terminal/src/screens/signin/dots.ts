// The restore notice's mark (card restore-notice-redraw, direction A, owner pick 12 Nov 18:55Z): a disc of dots in the
// logo's own grammar (shell/brand/ct-stack-1x.svg: circles on a grid, thinning toward the edge), and the tick drawn in
// those dots. Pure geometry on a 60-unit box, so the test reads it without a browser.

export const BOX = 60;
const C = BOX / 2;
const DISC = 28.5;
const STEP = 4;
/** The tick's two strokes, in the box's units. */
export const TICK: readonly (readonly [number, number])[] = [
  [15.5, 31],
  [26, 41.5],
  [45, 20],
];
/** One loop of the sweep, in seconds (signin.css `rn-comet`). */
export const SWEEP_S = 1.2;

export interface Dot {
  x: number;
  y: number;
  /** The disc's dot radius, thinner toward the rim. */
  r: number;
  /** The dot's radius in the tick, or 0 when it is not part of it. */
  tick: number;
  /** The dot's place in the sweep, 0 at the lit head to 1 at the tail. */
  phase: number;
}

function segDist(px: number, py: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** A dot's distance to the tick. */
export const tickDist = (x: number, y: number): number => Math.min(segDist(x, y, TICK[0]!, TICK[1]!), segDist(x, y, TICK[1]!, TICK[2]!));

/** The dot a phase draws while the sweep rests (reduced motion, or Offline): bright at the head, fading to the tail. */
export const glow = (p: number): number => (p < 0.55 ? 1 - (p / 0.55) * 0.88 : 0.12 * (1 - (p - 0.55) / 0.45));

function build(): Dot[] {
  const dots: Dot[] = [];
  for (let y = STEP / 2; y < BOX; y += STEP)
    for (let x = STEP / 2; x < BOX; x += STEP) {
      const d = Math.hypot(x - C, y - C);
      if (d > DISC) continue;
      const r = 0.95 * (1 - Math.pow(d / DISC, 6) * 0.55);
      const t = tickDist(x, y);
      const tick = t < 2.1 ? 1.9 : t < 4.2 ? 1.45 : t < 5.8 ? 1.05 : 0;
      // the head starts at 40 degrees past three o'clock, the arc's resting place
      const phase = ((((Math.atan2(y - C, x - C) * 180) / Math.PI + 360 - 40) % 360) + 360) % 360 / 360;
      dots.push({ x, y, r, tick, phase });
    }
  return dots;
}

export const DOTS: readonly Dot[] = build();
