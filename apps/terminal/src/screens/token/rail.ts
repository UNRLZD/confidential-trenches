// The token page's left rail's data (card app-token-rail; every chain since card app-chains-evm-rail): Discover's own
// read of every chain's lists, merged (../discover/data.ts sharedAllLists: GET /v1/market/lists?chain=<chain> for each
// chain the helper serves), re-read on Discover's cadence (REFRESH_MS) with Discover's failure rule (afterFail). The
// store holds every chain's lists; the rail narrows them to the shell's chain filter as it draws (Rail.tsx, pickSnapshot),
// so a new pick redraws at once with no read. Display only: nothing here feeds a signature.
//
// One store for the whole page, outside React: a token page is keyed by its token (TokenPage.tsx TokenRoute), so a hop
// from one rail row to the next mounts a new page; the store keeps the lists drawn across that hop, with no skeleton and
// no second read. It reads only while a rail is drawn (`subscribe`). A read in flight is shared with the top-token read
// of / (source.ts loadTopToken) and Discover's, so opening / reads the lists once, not once per part.
import { afterFail, REFRESH_MS, sharedAllLists } from "../discover/data.ts";
import type { DiscoverData } from "../discover/Discover.tsx";
import type { MarketSnapshot } from "../discover/fields.ts";

export interface RailState {
  data: DiscoverData;
  nowMs: number;
}

export interface RailDeps {
  read?: () => Promise<MarketSnapshot>;
  now?: () => number;
  every?: (fn: () => void, ms: number) => () => void;
}

/** A lists store: loading until the first read, then the lists, read again every REFRESH_MS while anyone listens; a
 *  failed read keeps the last good lists until STALE_MS pass with no 200 (afterFail). */
export function railStore(deps: RailDeps = {}) {
  const read = deps.read ?? (() => sharedAllLists());
  const now = deps.now ?? Date.now;
  const every =
    deps.every ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });
  let state: RailState = { data: { status: "loading" }, nowMs: now() };
  let lastGood: number | null = null;
  let readAt: number | null = null;
  let stop: (() => void) | null = null;
  const subs = new Set<() => void>();
  const set = (s: RailState) => {
    state = s;
    for (const f of subs) f();
  };
  const once = () => {
    readAt = now();
    void read().then(
      (snapshot) => {
        lastGood = now();
        set({ data: { status: "ready", snapshot }, nowMs: lastGood });
      },
      () => {
        const t = now();
        set({ data: afterFail(state.data, lastGood, t), nowMs: t });
      },
    );
  };
  return {
    get: (): RailState => state,
    subscribe(f: () => void): () => void {
      subs.add(f);
      if (!stop) {
        // a page hop unsubscribes and subscribes again at once: read only when the last read is a full period old
        if (readAt === null || now() - readAt >= REFRESH_MS) once();
        stop = every(once, REFRESH_MS);
      }
      return () => {
        subs.delete(f);
        if (subs.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
    /** Read again from the loading state (the error state's Retry). */
    retry(): void {
      set({ data: { status: "loading" }, nowMs: now() });
      once();
    },
  };
}

export type RailStore = ReturnType<typeof railStore>;

/** The page's one store. */
export const RAIL = railStore();
