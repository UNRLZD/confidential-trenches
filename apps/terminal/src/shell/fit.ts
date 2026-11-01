// Desktop design fit, as the live UNRLZD terminal draws it: from 1024 css px up, #root is zoomed by viewport / 1920,
// clamped to [0.72, 1], so the 1920 design is drawn whole; below 1024 nothing is scaled. The zoom is set before the
// first render, so the first paint is already at its size.
export const DESIGN_W = 1920;
export const FIT_FROM = 1024;
export const FIT_MIN = 0.72;

export function fitScale(vw: number): number {
  if (vw < FIT_FROM) return 1;
  return Math.min(1, Math.max(FIT_MIN, vw / DESIGN_W));
}

export function applyFit(): void {
  const set = () => document.documentElement.style.setProperty("--fit-zoom", String(fitScale(window.innerWidth)));
  set();
  window.addEventListener("resize", set);
}
