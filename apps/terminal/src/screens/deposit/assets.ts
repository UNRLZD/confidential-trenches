import type { Asset, QuoteRefusal } from "./model.ts";

// The deposit sheet's asset list, held for the app's session (card app-faults-seen-on-122, walk of release 122 row 7: the
// phone sheet's Asset and Chain were still skeletons with "Min —" at shot time). deposit.assets is a slow read by design:
// SIGN_HOST reads 1Click's token list and a probe quote per chain before it answers, up to its 14 s deadline
// (packages/signpage/src/deposit-wire.ts DEPOSIT_READ_DEADLINE_MS). The sheet unmounts on close and its list lived in its
// own state, so every open read it again behind the skeleton. Now the list is asked once the signing page is READY
// (the shell's mount, before any sheet opens) and held here; a sheet draws the last list at once and asks again, so its
// minimum follows the live fees. A refusal while a list is held keeps the list (the dry and checked quotes refuse any
// amount the live read would); with none held it is the sheet's answer (S4.6-S4.8), as before.

export interface AssetsView {
  list: Asset[] | null;
  refused: QuoteRefusal | null;
}

export type AssetsAsk = () => Promise<{ ok: true; list: Asset[] } | { ok: false; code: QuoteRefusal }>;

export interface AssetsStore {
  view(): AssetsView;
  /** Asks again unless an ask is out; an older ask's answer never lands over a newer one's. */
  ask(read: AssetsAsk): void;
  /** Drops a refusal so the next ask draws the skeleton (Retry after busy); a held list stays. */
  retry(): void;
  subscribe(fn: () => void): () => void;
}

export function createAssetsStore(): AssetsStore {
  let view: AssetsView = { list: null, refused: null };
  let out = 0;
  let asked = 0;
  const subs = new Set<() => void>();
  const set = (v: AssetsView) => {
    view = v;
    for (const fn of subs) fn();
  };
  return {
    view: () => view,
    ask(read) {
      if (out > 0) return;
      out++;
      const n = ++asked;
      void read()
        .then(
          (r) => (r.ok ? { list: r.list, refused: null } : view.list !== null ? view : { list: null, refused: r.code }),
          (): AssetsView => (view.list !== null ? view : { list: null, refused: "down" }),
        )
        .then((v) => {
          out--;
          if (n === asked && v !== view) set(v);
        });
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

/** The app's one held list. */
export const DEPOSIT_ASSETS = createAssetsStore();
