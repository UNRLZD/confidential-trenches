import type { Asset, QuoteRefusal } from "./model.ts";

// The deposit sheet's asset list, held for the app's session (card app-faults-seen-on-122, walk of release 122 row 7: the
// phone sheet's Asset and Chain were still skeletons with "Min —" at shot time). deposit.assets is a slow read by design:
// SIGN_HOST reads 1Click's token list and a probe quote per chain before it answers, up to its 14 s deadline
// (packages/signpage/src/deposit-wire.ts DEPOSIT_READ_DEADLINE_MS). The sheet unmounts on close and its list lived in its
// own state, so every open read it again behind the skeleton. Now the list is asked once the signing page is READY
// (the shell's mount, before any sheet opens) and held here; a sheet draws the last list at once and asks again, so its
// minimum follows the live fees. A refusal while a list is held keeps the list (the dry and checked quotes refuse any
// amount the live read would); with none held it is the sheet's answer (S4.6-S4.8), as before.
//
// Card app-faults-seen-on-124: that ask is four of the five 1Click calls a device may send in one fixed 10 s window (the
// token list and a probe quote per asset, packages/signpage/src/rules/deposit-dry.ts depositAssetsKind; the helper's
// share, apps/helper/src/proxy/proxy.ts DEPOSIT_SHEET_CALLS, counted per apps/helper/src/limits/limits.ts
// LIMIT_WINDOW_MS; only 1Click's total over every device is counted over 60 s, VENDOR_WINDOW_MS), and the list lived in
// module memory, so every page load asked it again at READY and a sheet opening asked it once more: a second ask inside
// one 10 s window met 429 on the token list (live run of release 124: the third of ten loads in a minute). Now
// the list is held in the tab's session store with the time it was read, and the time of the last ask: the shell's warm
// read asks only when no list is held and nothing was asked in the last minute; a sheet opening asks only when no list
// younger than a minute is held. So a device asks it at most once a minute, and a sheet still opens on a list. The page
// is right without the store (blocked, full or unreadable): the list is then held in memory only, as before.

/** How long a held list is fresh, and the least time between two asks: longer than the 10 s window the helper counts a
 *  device's 1Click share in (apps/helper/src/limits/limits.ts LIMIT_WINDOW_MS), so two asks never share one, and as
 *  long as the window 1Click's own total is counted over (apps/helper/src/proxy/proxy.ts VENDOR_WINDOW_MS). */
export const ASSETS_FRESH_MS = 60_000;
const KEY = "ct.deposit.assets";

export interface AssetsView {
  list: Asset[] | null;
  refused: QuoteRefusal | null;
}

export type AssetsAsk = () => Promise<{ ok: true; list: Asset[] } | { ok: false; code: QuoteRefusal }>;

export interface AssetsStore {
  view(): AssetsView;
  /** A sheet's ask: asks unless an ask is out or a list younger than ASSETS_FRESH_MS is held; an older ask's answer
   *  never lands over a newer one's. */
  ask(read: AssetsAsk): void;
  /** The shell's warm read: asks only when no list is held, no ask is out and none was made in the last ASSETS_FRESH_MS. */
  warm(read: AssetsAsk): void;
  /** Drops a refusal so the next ask draws the skeleton (Retry after busy); a held list stays. */
  retry(): void;
  subscribe(fn: () => void): () => void;
}

/** Where the list is kept across page loads: the tab's session store, or none. */
export type AssetsStorage = Pick<Storage, "getItem" | "setItem">;

const isAsset = (v: unknown): v is Asset => {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === "string" && typeof a.chain === "string" && typeof a.symbol === "string" && typeof a.min === "string" && (a.max_usd === null || typeof a.max_usd === "string");
};

/** The held list and the last ask's time from the store; anything unreadable is nothing held. */
function load(storage: AssetsStorage | null): { list: Asset[] | null; at: number | null; asked: number | null } {
  const none = { list: null, at: null, asked: null };
  try {
    const v: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (typeof v !== "object" || v === null) return none;
    const o = v as Record<string, unknown>;
    const at = typeof o.at === "number" ? o.at : null;
    const asked = typeof o.asked === "number" ? o.asked : null;
    const list = Array.isArray(o.list) && o.list.length > 0 && o.list.every(isAsset) ? o.list : null;
    return { list, at: list ? at : null, asked };
  } catch {
    return none;
  }
}

export function createAssetsStore(deps: { now?: () => number; storage?: AssetsStorage | null } = {}): AssetsStore {
  const now = deps.now ?? Date.now;
  const storage = deps.storage ?? null;
  const held = load(storage);
  let view: AssetsView = { list: held.list, refused: null };
  // when the held list was read, and when the last ask went out
  let at = held.at;
  let lastAsk = held.asked;
  let out = 0;
  let asked = 0;
  const subs = new Set<() => void>();
  const save = () => {
    try {
      storage?.setItem(KEY, JSON.stringify({ at, asked: lastAsk, list: view.list }));
    } catch {
      // the store is blocked or full: the list stays held in memory
    }
  };
  const set = (v: AssetsView) => {
    view = v;
    for (const fn of subs) fn();
  };
  const within = (t: number | null) => {
    if (t === null) return false;
    const d = now() - t;
    return d >= 0 && d < ASSETS_FRESH_MS;
  };
  const send = (read: AssetsAsk) => {
    out++;
    const n = ++asked;
    lastAsk = now();
    save();
    void read()
      .then(
        (r) => (r.ok ? { list: r.list, refused: null } : view.list !== null ? view : { list: null, refused: r.code }),
        (): AssetsView => (view.list !== null ? view : { list: null, refused: "down" }),
      )
      .then((v) => {
        out--;
        if (n !== asked) return;
        if (v.refused === null && v !== view) {
          at = now();
          set(v);
          save();
        } else if (v !== view) set(v);
      });
  };
  return {
    view: () => view,
    ask(read) {
      if (out > 0 || (view.list !== null && within(at))) return;
      send(read);
    },
    warm(read) {
      if (out > 0 || view.list !== null || within(lastAsk)) return;
      send(read);
    },
    retry() {
      if (view.refused !== null) set({ list: view.list, refused: null });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

/** The tab's session store, or none where reading it throws (a blocked store). */
function sessionStore(): AssetsStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The app's one held list. */
export const DEPOSIT_ASSETS = createAssetsStore({ storage: sessionStore() });
