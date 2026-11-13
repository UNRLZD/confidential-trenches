import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigationType } from "react-router";
import { tokenHref } from "../../routes/routes.ts";
import { usePick } from "../../shell/chain-pick.ts";
import { pickSnapshot } from "../discover/data.ts";
import { Ring } from "../discover/Discover.tsx";
import type { MarketRow } from "../discover/fields.ts";
import { DASH } from "../discover/format.ts";
import { columnRows, rowView } from "../discover/model.ts";
import { RAIL } from "./rail.ts";
import type { RailStore } from "./rail.ts";
import { keyOf, LISTS, readPrefs, sortRows, watchRows, useWatch, writePrefs } from "./Rail.tsx";
import type { List, Prefs, Sort, SortKey } from "./Rail.tsx";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./phone-trenches.css";

// The phone's home (owner 12 Nov: "Phone home: Trenches list"), the live UNRLZD phone Trenches › Tokens list
// (apps/terminal/src/mobile/trenches/TokensView.tsx and Trenches.tsx there): the title with LIVE, the chips (the rail's
// Trending, Watchlist, New, Hot, Graduating) in a sticky blurred bar, the Token / sort header, and 68 px rows (the ring,
// the symbol over the price, the MC over the 24h change in a tinted pill); a row pushes the token's page, and Back lands
// on the same list at the same place. The lists are the rail's own store (rail.ts RAIL, Discover's read), the chip and
// the sort the rail's own kept ones (Rail.tsx prefs), narrowed to the shell's chain filter. Display only.
// The header's sort is UNRLZD's (mobile/trenches/phoneSort.ts): Trending with no sort is the served order, every other
// list with no sort is Market cap high to low, and a tap goes Market cap → 24h change → Market cap, high to low.

const SKELETON_ROWS = 8;
const MINUS = "−";
/** The header's word for a sort key: its own two, the sort menu's for the rest (phoneSort.ts LABEL). */
const LABEL: Record<SortKey, WordId> = { mc: "mcLong", chg: "sortChg", liq: "sortLiq", vol24: "sortVol", age: "sortAge", prog: "sortCurve", holders: "sortHolders" };

/** The sort the list is drawn in: the kept one, else Market cap high to low (Trending: its served order). */
export function phoneSort(list: List, sort: Sort): Sort {
  return sort ?? (list === "trending" ? null : { key: "mc", dir: "desc" });
}
/** A header tap: Market cap (also no sort) → 24h change high to low; any other sort → Market cap high to low. */
export function nextPhoneSort(sort: Sort): NonNullable<Sort> {
  return { key: sort === null || sort.key === "mc" ? "chg" : "mc", dir: "desc" };
}
/** The change pill (UNRLZD mobile/trenches/model.ts changeText): "+1932%" (no decimals from 100), "−17.3%", "—". */
export function changeText(bps: number | null | undefined): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return DASH;
  const c = bps / 100;
  return `${c >= 0 ? "+" : MINUS}${Math.abs(c).toFixed(Math.abs(c) >= 100 ? 0 : 1)}%`;
}

/** Where the list was when a row was opened: Back restores it (UNRLZD: the page's scroll is the frame's). */
let keptY = 0;

/** UNRLZD's LIVE mark (mobile/dotart LiveIcon): a dot in two rings of dots that pulse. */
function LiveIcon() {
  const ring = (n: number, r: number, dot: number, op: number, cls: string) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return <circle key={`${cls}${i}`} className={cls} cx={(7.5 + Math.cos(a) * r).toFixed(2)} cy={(7.5 + Math.sin(a) * r).toFixed(2)} r={dot} fill="#5b8cff" fillOpacity={op} />;
    });
  return (
    <svg width={15} height={15} viewBox="0 0 15 15" className="ptr-liveic" aria-hidden="true">
      <circle cx="7.50" cy="7.50" r={1.8} fill="#5b8cff" />
      {ring(8, 4, 0.95, 0.8, "ptr-r1")}
      {ring(12, 6.8, 0.75, 0.45, "ptr-r2")}
    </svg>
  );
}

function Row({ r, nowMs }: { r: MarketRow; nowMs: number }) {
  const v = rowView(r, "1h", nowMs);
  const c = r.chg_24h_bps;
  return (
    <Link className="ptr-row" to={tokenHref(r.chain, r.token)} data-testid="phone-trenches-row" data-key={keyOf(r)} onClick={() => (keptY = window.scrollY)}>
      <Ring v={v} size={48} stroke={3} av={36} />
      <span className="ptr-main">
        <span className="ptr-sym" title={v.symbol}>{v.symbol}</span>
        <span className="ptr-price">{v.price}</span>
      </span>
      <span className="ptr-side">
        <span className="ptr-mc">{v.mc}</span>
        <span className="ptr-chg" data-tone={typeof c !== "number" ? "none" : c >= 0 ? "up" : "down"}>{changeText(c)}</span>
      </span>
    </Link>
  );
}

function Skeleton() {
  return (
    <div className="ptr-row" aria-hidden="true">
      <span className="tkp-sk tkp-skc" style={{ width: 48, height: 48 }} />
      <span className="ptr-main">
        <span className="tkp-sk" style={{ width: 72, height: 15 }} />
        <span className="tkp-sk" style={{ width: 56, height: 12 }} />
      </span>
      <span className="ptr-side">
        <span className="tkp-sk" style={{ width: 64, height: 14 }} />
        <span className="tkp-sk" style={{ width: 52, height: 20 }} />
      </span>
    </div>
  );
}

export function PhoneTrenches({ store = RAIL }: { store?: RailStore }) {
  const { data, nowMs } = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [prefs, setPrefs] = useState(readPrefs);
  const set = (p: Partial<Prefs>) =>
    setPrefs((o) => {
      const n = { ...o, ...p };
      writePrefs(n);
      return n;
    });
  const { list } = prefs;
  const sort = phoneSort(list, prefs.sort);
  const watch = useWatch();
  const pick = usePick();
  const snapshot = data.status === "ready" ? data.snapshot : null;
  const picked = useMemo(() => (snapshot ? pickSnapshot(snapshot, pick) : null), [snapshot, pick]);
  const hasGrad = !!picked && columnRows(picked, "graduating").length > 0;
  const lists = LISTS.filter((l) => l.key !== "graduating" || hasGrad || list === "graduating");
  const rows = useMemo(() => {
    if (!picked) return null;
    return sortRows(list === "watch" ? watchRows(picked, watch) : columnRows(picked, list), sort);
  }, [picked, list, watch, sort]);
  // Back lands where the list was (a tab tap starts at the top)
  const pop = useNavigationType() === "POP";
  useLayoutEffect(() => {
    if (pop && keptY > 0) window.scrollTo(0, keptY);
    // biome-ignore lint/correctness/useExhaustiveDependencies: once, on the mount Back made
  }, []);
  // a chip or sort change while the page is scrolled past the list's top lands on the new list's first row
  const bar = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const toListTop = () => {
    const b = bar.current;
    const l = box.current;
    if (!b || !l) return;
    const stuck = Number.parseFloat(getComputedStyle(b).top);
    const barBottom = (Number.isFinite(stuck) ? stuck : b.getBoundingClientRect().top) + b.offsetHeight;
    const by = l.getBoundingClientRect().top - barBottom;
    if (by < 0) window.scrollBy({ top: by, behavior: "instant" });
  };
  const label = sort === null ? WORDS.railTrending.text : WORDS[LABEL[sort.key]].text;
  return (
    <div className="ptr" data-testid="phone-trenches" data-list={list} data-state={data.status}>
      <div className="ptr-title">
        <h1>{WORDS.phoneTrenches.text}</h1>
        {data.status === "ready" && (
          <span className="ptr-live" data-testid="phone-trenches-live">
            <LiveIcon />
            {WORDS.phoneLive.text}
          </span>
        )}
      </div>
      <div className="ptr-sticky" ref={bar}>
        <div className="ptr-chips" data-testid="phone-trenches-chips">
          {lists.map((l) => (
            <button
              key={l.key}
              type="button"
              className="ptr-chip"
              aria-pressed={list === l.key}
              data-list={l.key}
              onClick={() => {
                toListTop();
                set({ list: l.key });
              }}
            >
              {WORDS[l.word].text}
            </button>
          ))}
        </div>
        <div className="ptr-sortrow">
          <span>{WORDS.phoneToken.text}</span>
          <button
            type="button"
            className="ptr-sort"
            data-testid="phone-trenches-sort"
            data-sort={sort?.key ?? "trending"}
            onClick={() => {
              toListTop();
              set({ sort: nextPhoneSort(sort) });
            }}
          >
            {label}
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1 3l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      </div>
      <div className="ptr-list" ref={box} role="list" data-testid="phone-trenches-list" aria-busy={data.status === "loading" || undefined}>
        {data.status === "loading" ? (
          Array.from({ length: SKELETON_ROWS }, (_, i) => <Skeleton key={i} />)
        ) : data.status === "error" ? (
          <div className="ptr-state">
            {WORDS.offline.text}
            <button type="button" className="tkp-retry" onClick={store.retry}>{WORDS.retry.text}</button>
          </div>
        ) : rows && rows.length ? (
          // rows are slots keyed by place, as the rail's (BAR-10 CLS 0): a refresh redraws each slot, no drawn row moves
          rows.map((r, i) => <Row key={i} r={r} nowMs={nowMs} />)
        ) : list === "watch" ? (
          <div className="ptr-state ptr-empty" data-testid="phone-trenches-empty">
            <svg width="28" height="28" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 1.2l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.8l-3 1.5.6-3.3-2.4-2.3 3.3-.5z" />
            </svg>
            {WORDS.watchEmpty.text}
          </div>
        ) : (
          <div className="ptr-state" data-testid="phone-trenches-empty">{WORDS.noTokens.text}</div>
        )}
      </div>
    </div>
  );
}
