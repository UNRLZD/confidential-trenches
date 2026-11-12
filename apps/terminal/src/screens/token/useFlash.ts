import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// A short colour flash when the header's live figure moves, UNRLZD's (components/viz/useFlash.ts; owner 12 Nov parity):
// gain green when it went up, loss coral when it went down, easing back to the element's own colour over 600 ms. Web
// Animations on the element: no React state, no re-render, off the layout path (a colour change moves nothing, CLS 0);
// a new move replaces the running flash, and a burst of moves the same way is one flash. Only the headline figures
// (the MC and the Price), never dense rows. Reduced motion keeps it: a colour change, no movement.

const GAIN = "#50e397";
const LOSS = "#ff5d4d";

/** `key`: what the number belongs to (the token); a new key never flashes. */
export function useFlash<T extends HTMLElement>(value: number | null, key: string): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const prev = useRef({ value, key });
  const anim = useRef<Animation | null>(null);
  const dir = useRef(true);
  useEffect(() => {
    const was = prev.current.key === key ? prev.current.value : null;
    prev.current = { value, key };
    const el = ref.current;
    if (!el || was === null || value === null || was === value || !el.animate) return;
    const up = value > was;
    if (anim.current?.playState === "running" && dir.current === up) return;
    anim.current?.cancel();
    dir.current = up;
    // one keyframe at offset 0: the animation eases back to the element's own colour
    anim.current = el.animate([{ color: up ? GAIN : LOSS, offset: 0 }], { duration: 600, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }, [value, key]);
  useEffect(() => () => anim.current?.cancel(), []);
  return ref;
}

/** A row's decimal string as a number for the flash; null when it has none. */
export const flashNum = (x: string | null | undefined): number | null => {
  const n = x == null ? Number.NaN : Number(x);
  return Number.isFinite(n) ? n : null;
};
