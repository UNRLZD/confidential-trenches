import { useCallback, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { tokenHref } from "../../routes/routes.ts";
import { Ring } from "../discover/Discover.tsx";
import type { MarketChain, MarketRow } from "../discover/fields.ts";
import { change } from "../discover/format.ts";
import { columnRows, rowView } from "../discover/model.ts";
import { RAIL } from "./rail.ts";
import type { RailStore } from "./rail.ts";
import { WORDS } from "./words.ts";
import "./rail.css";

// The token page's left rail (card app-token-rail), drawn after R5's trenches-1440.html rail (research repo
// design/proto at design-lock-r5, proto.css .rail and .rr, token.css's width modes): Trending and New from Discover's
// lists (rail.ts), each row a link to its token's page, the page's own token marked. The desktop's width modes
// (token.css .tkp-desk, rail.css): the full rail (340) from 1500 px, the slim rail (78: the rings, and the expand
// button that draws the full rail over the chart) from 1180, none under it. Its column is sized from the first paint,
// and its rows hold one height loading or drawn, so nothing moves when the lists land (BAR-10 CLS 0).

type List = "trending" | "new";
const LISTS: readonly { key: List; word: "railTrending" | "railNew" }[] = [
  { key: "trending", word: "railTrending" },
  { key: "new", word: "railNew" },
];
const SKELETON_ROWS = 14;
/** The rail is drawn from this width (rail.css; token.css .tkp-desk): under it, it reads nothing. */
export const RAIL_MEDIA = "(min-width: 1180px)";

function useMedia(q: string): boolean {
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

function Row({ r, nowMs, sel }: { r: MarketRow; nowMs: number; sel: boolean }) {
  const v = rowView(r, "1h", nowMs);
  const c = r.chg_24h_bps;
  return (
    <div role="listitem" data-token={r.token}>
      <Link className="tkr-row" to={tokenHref(r.chain, r.token)} title={v.symbol} aria-current={sel ? "page" : undefined}>
        <Ring v={v} size={46} stroke={3} av={34} />
        <span className="tkr-a">
          <span className="tkr-s">{v.symbol}</span>
          <span className="tkr-p">{v.price}</span>
        </span>
        <span className="tkr-b">
          <span className="tkr-mc">
            {v.mc}
            <u>{WORDS.mc.text}</u>
          </span>
          <span className="tkr-c" data-dir={typeof c !== "number" ? "none" : c >= 0 ? "up" : "down"}>{change(c, "24h")}</span>
        </span>
      </Link>
    </div>
  );
}

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

/** The rail. `chain` and `token` are the page's own token (null while it loads); `store` is the page's lists store. */
export function Rail({ chain, token, store = RAIL }: { chain: MarketChain | null; token: string | null; store?: RailStore }) {
  const drawn = useMedia(RAIL_MEDIA);
  const sub = useCallback((f: () => void) => (drawn ? store.subscribe(f) : () => {}), [drawn, store]);
  const { data, nowMs } = useSyncExternalStore(sub, store.get, store.get);
  const [list, setList] = useState<List>("trending");
  const [open, setOpen] = useState(false);
  const rows = data.status === "ready" ? columnRows(data.snapshot, list) : null;
  return (
    <aside className="tkr" data-testid="token-rail" data-open={open} data-list={list} data-state={data.status}>
      <button type="button" className="tkr-exp" aria-label={WORDS.expand.text} aria-expanded={open} data-testid="rail-expand" onClick={() => setOpen((o) => !o)}>
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
          <path d={open ? "M7.5 2.5L4 6l3.5 3.5" : "M4.5 2.5L8 6l-3.5 3.5"} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="tkr-chips">
        {LISTS.map((l) => (
          <button key={l.key} type="button" className="tkr-chip" aria-pressed={list === l.key} data-list={l.key} onClick={() => setList(l.key)}>
            {WORDS[l.word].text}
          </button>
        ))}
      </div>
      {data.status === "loading" ? (
        <div className="tkr-rows" role="list" aria-busy="true" aria-label={WORDS.loading.text}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => <Skeleton key={i} />)}
        </div>
      ) : data.status === "error" ? (
        <div className="tkr-rows tkr-msg">
          {WORDS.offline.text}
          <button type="button" className="tkp-retry" onClick={store.retry}>{WORDS.retry.text}</button>
        </div>
      ) : rows && rows.length ? (
        <div className="tkr-rows" role="list">
          {rows.map((r) => <Row key={r.token} r={r} nowMs={nowMs} sel={r.chain === chain && r.token === token} />)}
        </div>
      ) : (
        <div className="tkr-rows tkr-msg">{WORDS.noTokens.text}</div>
      )}
    </aside>
  );
}
