import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { tokenHref } from "../../routes/routes.ts";
import { usePick } from "../../shell/chain-pick.ts";
import { pickSnapshot } from "../discover/data.ts";
import { Ring } from "../discover/Discover.tsx";
import type { MarketChain, MarketRow, MarketSnapshot } from "../discover/fields.ts";
import { DASH } from "../discover/format.ts";
import { columnRows, rowView } from "../discover/model.ts";
import { onCurve } from "../market/curve.ts";
import { useArrivals } from "./arrivals.ts";
import { readWatch, WATCH_EVENT } from "./model.ts";
import { RAIL } from "./rail.ts";
import type { RailStore } from "./rail.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./rail.css";

// The token page's left rail (card app-token-rail), brought to the live UNRLZD trenches rail's parity (owner 12 Nov:
// "its UI/UX, the little details, on par with the main product"; UNRLZD apps/terminal/src/screens/trenches/rail):
// - the head: the Tokens tab and «, which folds the rail to its rings (kept on this device);
// - the chips: Trending, Watchlist (the tokens starred on this device), New, Hot and Graduating, beside Pause (the
//   list holds its order until it is pressed again; a hover never pauses) and Sort (MC, Liquidity, 24h vol, Age,
//   24h change, Curve, Holders; again on the same key flips it);
// - the rows stay fixed slots keyed by place (card app-token-rail, 50891a01: BAR-10 CLS 0), so a refresh redraws each
//   slot in place and no drawn row moves; what UNRLZD tracks per token is tracked per token here too: a token new to
//   the list's first screen is lit once (arrivals.ts, UNRLZD's "Live list arrivals"), and a token's MC flashes green or
//   coral for 800 ms when it moves (a slot that takes another token never flashes);
// - the 24h change as UNRLZD draws it (▲ 11.27%), and "Open launch board" to Discover at the foot.
// Everything reads Discover's lists (rail.ts), narrowed to the shell's chain filter. Display only.

export type List = "trending" | "watch" | "new" | "hot" | "graduating";
export const LISTS: readonly { key: List; word: WordId }[] = [
  { key: "trending", word: "railTrending" },
  { key: "watch", word: "railWatch" },
  { key: "new", word: "railNew" },
  { key: "hot", word: "railHot" },
  { key: "graduating", word: "railGrad" },
];
export type SortKey = "mc" | "liq" | "vol24" | "age" | "chg" | "prog" | "holders";
export type Sort = { key: SortKey; dir: "asc" | "desc" } | null;
export const SORTS: readonly { key: SortKey; word: WordId }[] = [
  { key: "mc", word: "mc" },
  { key: "liq", word: "sortLiq" },
  { key: "vol24", word: "sortVol" },
  { key: "age", word: "sortAge" },
  { key: "chg", word: "sortChg" },
  { key: "prog", word: "sortCurve" },
  { key: "holders", word: "sortHolders" },
];
const SKELETON_ROWS = 14;
const FLASH_MS = 800;
/** The rail is drawn from this width (rail.css; token.css .tkp-desk): under it, it reads nothing. */
export const RAIL_MEDIA = "(min-width: 1180px)";
const SLIM_MEDIA = "(max-width: 1499.98px)";
const PREFS = "ct.rail.v1";

const dec = (v: string | null | undefined): number | null => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const keyOf = (r: MarketRow): string => `${r.chain}:${r.token}`;

/** A row's value for a sort key; null sorts last whatever the direction. */
function sortValue(r: MarketRow, k: SortKey): number | null {
  if (k === "mc") return dec(r.mc_usd);
  if (k === "liq") return dec(r.liq_usd);
  if (k === "vol24") return dec(r.vol_24h_usd);
  if (k === "age") return num(r.created_s);
  if (k === "chg") return num(r.chg_24h_bps);
  if (k === "prog") return onCurve(r) ? r.curve_bps! : null;
  return num(r.holders);
}

/** Sorted when a sort is set (stable: ties keep the served order). "Age" high-to-low is the newest first. */
export function sortRows(rows: readonly MarketRow[], sort: Sort): MarketRow[] {
  if (!sort) return [...rows];
  const sign = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, sort.key) }))
    .sort((a, b) => (a.v === null ? (b.v === null ? a.i - b.i : 1) : b.v === null ? -1 : (a.v - b.v) * sign || a.i - b.i))
    .map((x) => x.r);
}

/** The watchlist's rows: the starred tokens (`chain/token`, model.ts readWatch) found in any served list, in star order. */
export function watchRows(s: MarketSnapshot, watch: readonly string[]): MarketRow[] {
  const seen = new Map<string, MarketRow>();
  for (const rows of Object.values(s.lists)) for (const r of rows ?? []) if (!seen.has(`${r.chain}/${r.token}`)) seen.set(`${r.chain}/${r.token}`, r);
  return watch.flatMap((k) => seen.get(k) ?? []);
}

/** ▲ 11.27% / ▼ 4.10% from basis points (UNRLZD fmtArrowPct). */
export function arrowPct(bps: number | null | undefined): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return DASH;
  return `${bps >= 0 ? "▲" : "▼"} ${(Math.abs(bps) / 100).toFixed(2)}%`;
}

export function useMedia(q: string): boolean {
  const sub = useCallback(
    (f: () => void) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", f);
      return () => m.removeEventListener("change", f);
    },
    [q],
  );
  return useSyncExternalStore(sub, () => window.matchMedia(q).matches, () => false);
}

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
export type Prefs = { list: List; sort: Sort; collapsed: boolean };
export function readPrefs(): Prefs {
  const d: Prefs = { list: "trending", sort: null, collapsed: false };
  try {
    const v = JSON.parse(storage()?.getItem(PREFS) ?? "null") as Partial<Prefs> | null;
    if (!v || typeof v !== "object") return d;
    const list = LISTS.some((l) => l.key === v.list) ? (v.list as List) : d.list;
    const s = v.sort as Sort;
    const sort = s && SORTS.some((x) => x.key === s.key) && (s.dir === "asc" || s.dir === "desc") ? s : null;
    return { list, sort, collapsed: v.collapsed === true };
  } catch {
    return d;
  }
}
export function writePrefs(p: Prefs): void {
  try {
    storage()?.setItem(PREFS, JSON.stringify(p));
  } catch {
    // the rail still works for this page
  }
}

export function useWatch(): string[] {
  const [w, setW] = useState(() => readWatch(storage()));
  useEffect(() => {
    const f = () => setW(readWatch(storage()));
    window.addEventListener(WATCH_EVENT, f);
    window.addEventListener("storage", f);
    return () => {
      window.removeEventListener(WATCH_EVENT, f);
      window.removeEventListener("storage", f);
    };
  }, []);
  return w;
}

/** Line icons on the 12 box (UNRLZD's set): pause, the sort arrows, the chevrons, the grid. */
function Ic({ n, size = 12 }: { n: "pause" | "sort" | "chevL" | "chevR" | "grid" | "check" | "up" | "down"; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (n === "pause") return <svg {...p}><path d="M4.25 2.5v7M7.75 2.5v7" /></svg>;
  if (n === "sort") return <svg {...p}><path d="M3.5 9.5v-7M1.75 4.25L3.5 2.5l1.75 1.75M8.5 2.5v7M6.75 7.75L8.5 9.5l1.75-1.75" /></svg>;
  if (n === "chevL") return <svg {...p}><path d="M6.5 2.5L3 6l3.5 3.5M9.5 2.5L6 6l3.5 3.5" /></svg>;
  if (n === "chevR") return <svg {...p}><path d="M5.5 2.5L9 6l-3.5 3.5M2.5 2.5L6 6 2.5 9.5" /></svg>;
  if (n === "check") return <svg {...p}><path d="M2.5 6.25l2.25 2.25L9.5 3.5" /></svg>;
  if (n === "up") return <svg {...p}><path d="M6 9.5v-7M3.5 5L6 2.5 8.5 5" /></svg>;
  if (n === "down") return <svg {...p}><path d="M6 2.5v7M3.5 7L6 9.5 8.5 7" /></svg>;
  return <svg {...p}><rect x="1.75" y="1.75" width="3.5" height="3.5" rx="0.75" /><rect x="6.75" y="1.75" width="3.5" height="3.5" rx="0.75" /><rect x="1.75" y="6.75" width="3.5" height="3.5" rx="0.75" /><rect x="6.75" y="6.75" width="3.5" height="3.5" rx="0.75" /></svg>;
}

const Row = memo(function Row({ r, nowMs, sel, seen }: { r: MarketRow; nowMs: number; sel: boolean; seen: Map<string, number> }) {
  const v = rowView(r, "1h", nowMs);
  const c = r.chg_24h_bps;
  const mc = dec(r.mc_usd);
  const k = keyOf(r);
  // each token's last drawn MC is the rail's (`seen`), not the slot's: a token that moved slots still flashes when its
  // MC moved, and a slot that takes another token compares that token's own last MC
  const [lit, setLit] = useState<{ k: string; d: -1 | 1 } | null>(null);
  useEffect(() => {
    if (mc === null) return;
    const p = seen.get(k);
    seen.set(k, mc);
    if (p === undefined || p === mc) return;
    setLit({ k, d: mc > p ? 1 : -1 });
    const t = setTimeout(() => setLit(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [k, mc, seen]);
  const flash = lit !== null && lit.k === k ? lit.d : 0;
  return (
    <div role="listitem" data-token={r.token} data-key={keyOf(r)} className="tkr-li">
      <Link className="tkr-row" to={tokenHref(r.chain, r.token)} title={v.symbol} aria-current={sel ? "page" : undefined}>
        <Ring v={v} size={46} stroke={3} av={34} />
        <span className="tkr-a">
          <span className="tkr-s">{v.symbol}</span>
          <span className="tkr-p">{v.price}</span>
        </span>
        <span className="tkr-b">
          <span className="tkr-mc" data-flash={flash}>
            {v.mc}
            <u>{WORDS.mc.text}</u>
          </span>
          <span className="tkr-c" data-dir={typeof c !== "number" ? "none" : c >= 0 ? "up" : "down"}>{arrowPct(c)}</span>
        </span>
      </Link>
    </div>
  );
});

function Skeleton() {
  return (
    <div className="tkr-row" aria-hidden="true">
      <span className="tkp-sk tkp-skc tkr-skc" />
      <span className="tkr-a">
        <span className="tkp-sk" style={{ width: 70, height: 14 }} />
        <span className="tkp-sk" style={{ width: 56, height: 11 }} />
      </span>
      <span className="tkr-b">
        <span className="tkp-sk" style={{ width: 74, height: 14 }} />
        <span className="tkp-sk" style={{ width: 48, height: 11 }} />
      </span>
    </div>
  );
}

/** The sort menu as UNRLZD's (trenches/rail/filters/FilterBar.tsx SortMenu): first the list's own order (Trending on
 *  Trending, else Default), ticked while no sort is set, then each key; the key on again flips its direction. */
function SortMenu({ list, sort, onPick, onClose }: { list: List; sort: Sort; onPick: (s: Sort) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as Element).closest?.('[data-testid="rail-sort"]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={box} className="tkr-menu" role="menu" data-testid="rail-sort-menu">
      <button type="button" role="menuitemradio" aria-checked={sort === null} className="tkr-mi" data-on={sort === null} onClick={() => onPick(null)} data-testid="rail-sort-none">
        <span>{WORDS[list === "trending" ? "railTrending" : "sortDefault"].text}</span>
        {sort === null && <Ic n="check" />}
      </button>
      {SORTS.map((s) => {
        const on = sort?.key === s.key;
        return (
          <button key={s.key} type="button" role="menuitemradio" aria-checked={on} className="tkr-mi" data-on={on} onClick={() => onPick({ key: s.key, dir: on && sort!.dir === "desc" ? "asc" : "desc" })}>
            <span>{WORDS[s.word].text}</span>
            {on && <Ic n={sort!.dir === "desc" ? "down" : "up"} />}
          </button>
        );
      })}
    </div>
  );
}

/** The rail. `chain` and `token` are the page's own token (null while it loads); `store` is the page's lists store. */
export function Rail({ chain, token, store = RAIL }: { chain: MarketChain | null; token: string | null; store?: RailStore }) {
  const drawn = useMedia(RAIL_MEDIA);
  const narrow = useMedia(SLIM_MEDIA);
  const sub = useCallback((f: () => void) => (drawn ? store.subscribe(f) : () => {}), [drawn, store]);
  const { data, nowMs } = useSyncExternalStore(sub, store.get, store.get);
  const [prefs, setPrefs] = useState(readPrefs);
  const set = (p: Partial<Prefs>) =>
    setPrefs((o) => {
      const n = { ...o, ...p };
      writePrefs(n);
      return n;
    });
  const { list, sort, collapsed } = prefs;
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const [menu, setMenu] = useState(false);
  const watch = useWatch();
  const pick = usePick();
  const snapshot = data.status === "ready" ? data.snapshot : null;
  const picked = useMemo(() => (snapshot ? pickSnapshot(snapshot, pick) : null), [snapshot, pick]);
  const hasGrad = !!picked && columnRows(picked, "graduating").length > 0;
  const lists = LISTS.filter((l) => l.key !== "graduating" || hasGrad || list === "graduating");
  const rows = useMemo(() => {
    if (!picked) return null;
    const base = list === "watch" ? watchRows(picked, watch) : columnRows(picked, list);
    return sortRows(base, sort);
  }, [picked, list, watch, sort]);
  // Pause holds the order as it was when pressed; the rows' values still move (UNRLZD TokenList `frozen`)
  const last = useRef(new Map<string, MarketRow>());
  const seen = useRef(new Map<string, number>()).current;
  for (const r of rows ?? []) last.current.set(keyOf(r), r);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the order is captured when pause starts, and again on a list or sort change
  useEffect(() => setFrozen(held && rows ? rows.map(keyOf) : null), [held, sort]);
  const shown = held && frozen ? frozen.flatMap((k) => last.current.get(k) ?? []) : rows;
  const slim = (narrow && !open) || (!narrow && collapsed);
  const box = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  useArrivals(shown ? shown.map(keyOf) : [], {
    find: (k) => box.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"] > .tkr-row`) ?? null,
    calm: () => hovered.current,
    resetKey: `${list}|${sort?.key ?? ""}${sort?.dir ?? ""}|${pick}|${slim}`,
  });
  // a chip switch ends a pause (UNRLZD: "a chip or tab switch ends it")
  useLayoutEffect(() => setHeld(false), [list]);
  const closeMenu = useCallback(() => setMenu(false), []);
  return (
    <aside className="tkr" data-testid="token-rail" data-open={open} data-slim={slim} data-collapsed={!narrow && collapsed} data-list={list} data-state={data.status}>
      {slim ? (
        <button
          type="button"
          className="tkr-exp"
          aria-label={WORDS.expand.text}
          aria-expanded={false}
          data-testid="rail-expand"
          onClick={() => (narrow ? setOpen(true) : set({ collapsed: false }))}
        >
          <Ic n="chevR" size={14} />
        </button>
      ) : (
        <>
          <div className="tkr-head" data-testid="rail-head">
            <span className="tkr-tab" data-on="true">{WORDS.railTokens.text}</span>
            <button
              type="button"
              className="tkr-chev"
              aria-label={WORDS.collapse.text}
              title={WORDS.collapse.text}
              data-testid="rail-collapse"
              onClick={() => (narrow ? setOpen(false) : set({ collapsed: true }))}
            >
              <Ic n="chevL" size={15} />
            </button>
          </div>
          <div className="tkr-bar">
            <div className="tkr-chips" data-testid="rail-chips">
              {lists.map((l) => (
                <button key={l.key} type="button" className="tkr-chip" aria-pressed={list === l.key} data-list={l.key} onClick={() => set({ list: l.key })}>
                  {WORDS[l.word].text}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="tkr-hold"
              aria-pressed={held}
              aria-label={held ? WORDS.resume.text : WORDS.pause.text}
              title={held ? WORDS.resume.text : WORDS.pause.text}
              data-testid="rail-pause"
              onClick={() => setHeld((h) => !h)}
            >
              <Ic n="pause" />
              {held && WORDS.paused.text}
            </button>
            <button
              type="button"
              className="tkr-iconbtn"
              aria-label={WORDS.sort.text}
              title={WORDS.sort.text}
              aria-expanded={menu}
              data-on={sort !== null}
              data-testid="rail-sort"
              onClick={() => setMenu((m) => !m)}
            >
              <Ic n="sort" size={13} />
            </button>
            {menu && (
              <SortMenu
                list={list}
                sort={sort}
                onClose={closeMenu}
                onPick={(s) => {
                  set({ sort: s });
                  setMenu(false);
                }}
              />
            )}
          </div>
        </>
      )}
      {data.status === "loading" ? (
        <div className="tkr-rows" role="list" aria-busy="true" aria-label={WORDS.loading.text}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => <Skeleton key={i} />)}
        </div>
      ) : data.status === "error" ? (
        <div className="tkr-rows tkr-msg">
          {WORDS.offline.text}
          <button type="button" className="tkp-retry" onClick={store.retry}>{WORDS.retry.text}</button>
        </div>
      ) : shown && shown.length ? (
        <div
          ref={box}
          className="tkr-rows"
          role="list"
          data-frozen={held}
          onMouseEnter={() => (hovered.current = true)}
          onMouseLeave={() => (hovered.current = false)}
        >
          {shown.map((r, i) => <Row key={i} r={r} nowMs={nowMs} sel={r.chain === chain && r.token === token} seen={seen} />)}
        </div>
      ) : list === "watch" && !slim ? (
        <div className="tkr-rows tkr-msg tkr-empty" data-testid="rail-watch-empty">
          <svg width="28" height="28" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 1.2l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.8l-3 1.5.6-3.3-2.4-2.3 3.3-.5z" />
          </svg>
          {WORDS.watchEmpty.text}
        </div>
      ) : (
        <div className="tkr-rows tkr-msg">{WORDS.noTokens.text}</div>
      )}
      {!slim && (
        <Link to="/discover" className="tkr-board" data-testid="rail-board">
          <Ic n="grid" size={14} />
          {WORDS.board.text}
        </Link>
      )}
    </aside>
  );
}
