// Drawing toolbar state, kept in this browser (one set for every token; the drawings themselves are per token,
// persist.ts): the tool being drawn, crosshair mode, magnet, lock all, hide all and the phone toolbar's open state. The
// live UNRLZD terminal's chart/draw/store.ts (a zustand store there), as a small external store read with
// useSyncExternalStore. The tool being drawn is never restored.
import { useSyncExternalStore } from "react";
import type { CrossMode, MagnetMode } from "./tools.ts";

export interface DrawState {
  /** tool id being drawn (tools.ts), null = none */
  active: string | null;
  cross: CrossMode;
  magnet: MagnetMode;
  lockAll: boolean;
  hideAll: boolean;
  /** phones: the user opened the tool column (collapsed by default there) */
  open: boolean;
}

const KEY = "ct:chart-draw-ui:v1";
const CROSS: readonly CrossMode[] = ["cross", "dot", "arrow"];
const MAGNET: readonly MagnetMode[] = ["normal", "weak_magnet", "strong_magnet"];

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function load(): DrawState {
  const d: DrawState = { active: null, cross: "cross", magnet: "normal", lockAll: false, hideAll: false, open: false };
  try {
    const v = JSON.parse(storage()?.getItem(KEY) ?? "null") as Partial<DrawState> | null;
    if (!v || typeof v !== "object") return d;
    return {
      active: null,
      cross: CROSS.includes(v.cross as CrossMode) ? (v.cross as CrossMode) : d.cross,
      magnet: MAGNET.includes(v.magnet as MagnetMode) ? (v.magnet as MagnetMode) : d.magnet,
      lockAll: v.lockAll === true,
      hideAll: v.hideAll === true,
      open: v.open === true,
    };
  } catch {
    return d;
  }
}

let state: DrawState = load();
const subs = new Set<() => void>();

export const drawStore = {
  get: (): DrawState => state,
  set(p: Partial<DrawState>): void {
    state = { ...state, ...p };
    try {
      const { active: _, ...kept } = state;
      storage()?.setItem(KEY, JSON.stringify(kept));
    } catch {
      // the toolbar still works for this page
    }
    for (const f of subs) f();
  },
  subscribe(f: () => void): () => void {
    subs.add(f);
    return () => subs.delete(f);
  },
};

/** One field of the toolbar state, redrawn when it changes. */
export function useDraw<K extends keyof DrawState>(k: K): DrawState[K] {
  return useSyncExternalStore(drawStore.subscribe, () => state[k], () => state[k]);
}
