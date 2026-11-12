// The live list's arrival cue, as the UNRLZD terminal draws it (apps/terminal/src/lib/arrivals.ts and
// styles/arrive.ts there; its design note "Live list arrivals"): a row that newly enters the top of a list (a new token,
// or one that climbs into the first screen) is lit once by a short blue wash and, unless the pointer is on the list, a
// 2 px damped nudge. CSS does the motion (rail.css .tkr-arrive); this decides which rows arrive and when. Never on the
// first look at a list, a list or sort switch, or a reorder inside the first screen; a row lights at most once in 30 s;
// at most 6 cues at once; none while the user scrolls. Display only.
import { useLayoutEffect, useRef } from "react";

export interface Arrival {
  delay: number;
  nudge: boolean;
}

const O = { window: 12, staggerMs: 35, maxStagger: 4, maxNudge: 3, cooldownMs: 30_000, loadAt: 3, warmMs: 1200 };
export const ARRIVE_MS = 900;
const MAX_CUES = 6;
const QUIET_MS = 400;

export class ArrivalTracker {
  #prev: Set<string> | null = null;
  #seededAt = 0;
  readonly #lit = new Map<string, number>();

  reset(): void {
    this.#prev = null;
  }

  /** the keys that arrived since the last call, in list order */
  observe(ids: readonly string[], now: number, calm = false): Map<string, Arrival> {
    const top = ids.slice(0, O.window);
    const prev = this.#prev;
    this.#prev = new Set(top);
    const out = new Map<string, Arrival>();
    if (prev === null) this.#seededAt = now;
    if (prev === null || now - this.#seededAt < O.warmMs) return out;
    for (const [id, at] of this.#lit) if (now - at >= O.cooldownMs) this.#lit.delete(id);
    const fresh = top.filter((id) => !prev.has(id) && !this.#lit.has(id));
    if (prev.size === 0 && fresh.length > O.loadAt) return out;
    fresh.forEach((id, i) => {
      this.#lit.set(id, now);
      out.set(id, { delay: Math.min(i, O.maxStagger) * O.staggerMs, nudge: !calm && i < O.maxNudge });
    });
    return out;
  }
}

let lastScroll = Number.NEGATIVE_INFINITY;
if (typeof document !== "undefined" && typeof document.addEventListener === "function")
  document.addEventListener("scroll", () => (lastScroll = performance.now()), { capture: true, passive: true });
const scrolling = (): boolean => performance.now() - lastScroll < QUIET_MS;

const active = new Set<HTMLElement>();
const owner = new WeakMap<HTMLElement, object>();
function cueOn(el: HTMLElement, a: Arrival, token: object): void {
  owner.set(el, token);
  active.add(el);
  el.classList.add("tkr-arrive");
  el.dataset.nudge = String(a.nudge);
  el.style.setProperty("--arrive-delay", `${a.delay}ms`);
}
function cueOff(el: HTMLElement, token: object): void {
  if (owner.get(el) !== token) return;
  owner.delete(el);
  active.delete(el);
  el.classList.remove("tkr-arrive");
  delete el.dataset.nudge;
  el.style.removeProperty("--arrive-delay");
}

/** Plays the cue on rows new to the top of `ids`; `find` gives a row's element, `calm` is true while the pointer is on
 *  the list (glow only), a `resetKey` change re-seeds without a cue. The cue is set on the element, not React state. */
export function useArrivals(ids: readonly string[], opts: { find: (id: string) => HTMLElement | null; calm: () => boolean; resetKey: string }): void {
  const tracker = useRef(new ArrivalTracker());
  const live = useRef(opts);
  live.current = opts;
  const top = ids.slice(0, O.window).join("\u0000");
  useLayoutEffect(() => {
    tracker.current.reset();
  }, [opts.resetKey]);
  useLayoutEffect(() => {
    const { find, calm } = live.current;
    const got = tracker.current.observe(top ? top.split("\u0000") : [], Date.now(), calm());
    if (scrolling() || got.size === 0) return;
    const lit: [HTMLElement, Arrival][] = [];
    for (const [id, a] of got) {
      const el = find(id);
      if (el) lit.push([el, a]);
    }
    lit.splice(Math.max(0, MAX_CUES - active.size));
    if (!lit.length) return;
    const token = {};
    for (const [el, a] of lit) cueOn(el, a, token);
    const last = Math.max(...lit.map(([, a]) => a.delay));
    setTimeout(() => {
      for (const [el] of lit) cueOff(el, token);
    }, last + ARRIVE_MS + 50);
  }, [top]);
}
