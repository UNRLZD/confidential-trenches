// The desktop header keeps its symbol whole (card rail-open-keeps-the-symbol-whole): token.css's container steps drop
// the strip's last tiles for a narrow main column on a short symbol's budget; a longer symbol (Anthropic, live 13 Nov
// with the rail opened at 1440 and 1280) still ran into "…". Here the same tiles give way from the end, Holders, then
// Liquidity, 24h vol and Tax (each also in the trade column's stats), one at a time until the symbol is drawn whole,
// and come back when it has room. The MC, Price and Change stay; past them the symbol's own "…" (its title the full
// text) is the last resort.
import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** The tiles that give way, the first to go first. */
export const STRIP_DROPS = ["holders", "liq", "vol", "tax"] as const;

/** Every tile back, then each of STRIP_DROPS hidden in turn while the header's symbol is cut. */
export function fitStrip(head: HTMLElement): void {
  const tiles = STRIP_DROPS.map((k) => head.querySelector<HTMLElement>(`.tkp-strip > [data-k="${k}"]`)).filter((e) => e !== null);
  for (const t of tiles) t.removeAttribute("data-fit");
  const sym = head.querySelector<HTMLElement>(".tkp-sym");
  if (sym === null) return;
  for (const t of tiles) {
    if (sym.scrollWidth <= sym.clientWidth) return;
    t.setAttribute("data-fit", "drop");
  }
}

/** Fits the strip before each paint that could cut the symbol: a new symbol, the header's width (the rail opened or
 *  folded, the window resized), the icons landing, a font loaded. Nothing the fit changes resizes what it watches. */
export function useStripFit(head: RefObject<HTMLElement | null>, symbol: string): void {
  useLayoutEffect(() => {
    const el = head.current;
    if (el === null) return;
    const run = () => fitStrip(el);
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    const icons = el.querySelector(".tkp-icons");
    if (icons !== null) ro.observe(icons);
    document.fonts?.addEventListener("loadingdone", run);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener("loadingdone", run);
    };
  }, [head, symbol]);
}
