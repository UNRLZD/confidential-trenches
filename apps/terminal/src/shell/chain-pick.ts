// The chain filter, one for the whole shell (09-design-brief S1 Chain filter: "one filter for the token lists, Discover
// and Search"): the top bar's chain chip and the phone's search sheet set it (Search.tsx); the search and Discover
// (screens/discover/Discover.tsx DiscoverRoute) read it. It lives for the page's life, on this device only.
import { useSyncExternalStore } from "react";
import type { ChainPick } from "./search.ts";

let pickNow: ChainPick = "all";
const pickSubs = new Set<() => void>();

export const setPick = (p: ChainPick): void => {
  pickNow = p;
  for (const f of pickSubs) f();
};
const subPick = (f: () => void) => (pickSubs.add(f), () => void pickSubs.delete(f));
export const usePick = (): ChainPick => useSyncExternalStore(subPick, () => pickNow, () => pickNow);
