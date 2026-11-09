import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref, RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { tokenHref } from "../routes/routes.ts";
import { Ring } from "../screens/discover/Discover.tsx";
import type { MarketChain, MarketRow, MarketSnapshot } from "../screens/discover/fields.ts";
import { change } from "../screens/discover/format.ts";
import { rowView } from "../screens/discover/model.ts";
import { chainOf } from "../screens/market/pads.ts";
import { loadToken } from "../screens/token/source.ts";
import type { TokenData } from "../screens/token/source.ts";
import { setPick, usePick } from "./chain-pick.ts";
import { allRows, chainsWithData, idleRows, plan, SEARCH_LISTS } from "./search.ts";
import type { ChainPick } from "./search.ts";
import { WORDS } from "./search-words.ts";
import type { WordId } from "./search-words.ts";
import "./search.css";

// The top bar's search (card app-header-search-chain), drawn after R5's top bar (research repo design/proto/assets/
// app.js P.topbar, P.chainChip and P.phHeader, proto.css .searchwrap, .search, .chainchip, .tb-searchBtn and .phh .sfi
// at design-lock-r5): the field (`Name, symbol or address`) with its results under it, the chain chip (All, then the
// chains with data), and under 1024 px and on the phone a search button that opens the same search as a sheet. The
// results are search.ts's, found on this device in the lists already read: typing reads nothing (useDeferredValue keeps
// each key's paint first); a pasted address the lists do not hold is read once, a moment after the last key. Each row
// is its token's link, the rail's row (token/Rail.tsx). The menus and the sheet sit over the page, so opening one moves
// nothing (BAR-10 CLS 0).

const W = ({ id }: { id: WordId }) => {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
};
const draftAttr = (id: WordId) => (WORDS[id].draft ? { "data-draft-copy": WORDS[id].text } : {});

/** R5 app.js P.ic, 12 x 12 at a stroke of 1.25. */
function Ic({ d, size = 17, stroke = 1.25 }: { d: ReactNode; size?: number; stroke?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{d}</g>
    </svg>
  );
}
const SEARCH = (
  <>
    <circle cx={5.2} cy={5.2} r={3.7} />
    <path d="M8 8l2.8 2.8" />
  </>
);
const ALL = [1.5, 7].flatMap((x) => [1.5, 7].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width={3.5} height={3.5} rx={0.8} />));
const CHEV_DOWN = <path d="M3 4.5l3 3 3-3" />;
const BACK = <path d="M7.5 2.5L4 6l3.5 3.5" />;

// ------------------------------------------------------------------------------------------------ the shared state
type Lists = { status: "loading" | "ready" | "error"; snapshot: MarketSnapshot | null; retry: () => void };

/** The lists while `active` (the search open): the ones held at once, then fresh ones (search.ts SEARCH_LISTS). */
function useLists(active: boolean): Lists {
  const [st, setSt] = useState<{ status: Lists["status"]; snapshot: MarketSnapshot | null }>(() => {
    const s = SEARCH_LISTS.now();
    return { status: s ? "ready" : "loading", snapshot: s };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    SEARCH_LISTS.get().then(
      (snapshot) => live && setSt({ status: "ready", snapshot }),
      () => live && setSt((p) => (p.snapshot ? p : { status: "error", snapshot: null })),
    );
    return () => {
      live = false;
    };
  }, [active, attempt]);
  const retry = useCallback(() => {
    setSt({ status: "loading", snapshot: null });
    setAttempt((n) => n + 1);
  }, []);
  return { ...st, retry };
}

/** A pasted address's token reads, kept for the page's life once answered (a row, or no such token). */
const READS = new Map<string, TokenData>();
/** How long after the last key an address is read: a paste is read once, typing an address out reads it once. */
export const READ_AFTER_MS = 250;

type Found = { status: "idle" | "loading" | "error"; rows: MarketRow[] } | { status: "done"; rows: MarketRow[] };

function useReads(reads: readonly { chain: MarketChain; id: string }[]): Found & { retry: () => void } {
  const key = reads.map((r) => `${r.chain}/${r.id}`).join(" ");
  const [st, setSt] = useState<{ key: string; out: TokenData[] }>({ key: "", out: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    const keys = key.split(" ");
    if (keys.every((k) => READS.has(k))) return setSt({ key, out: keys.map((k) => READS.get(k)!) });
    let live = true;
    const t = setTimeout(() => {
      void Promise.all(
        keys.map((k) => {
          const held = READS.get(k);
          if (held) return held;
          const at = k.indexOf("/");
          return loadToken(k.slice(0, at) as MarketChain, k.slice(at + 1)).then((d) => {
            if (d.status !== "error") READS.set(k, d);
            return d;
          });
        }),
      ).then((out) => live && setSt({ key, out }));
    }, READ_AFTER_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!key) return { status: "idle", rows: [], retry };
  const out = st.key === key ? st.out : keys0(key).map((k) => READS.get(k)).filter((d): d is TokenData => !!d);
  if (out.length < reads.length) return { status: "loading", rows: [], retry };
  const rows = out.flatMap((d) => (d.status === "ready" ? [d.row] : []));
  if (!rows.length && out.some((d) => d.status === "error")) return { status: "error", rows: [], retry };
  return { status: "done", rows, retry };
}
const keys0 = (key: string) => key.split(" ");

// ------------------------------------------------------------------------------------------------ the results
function Row({ r, id, on, nowMs, onPick, onHover }: { r: MarketRow; id: string; on: boolean; nowMs: number; onPick: () => void; onHover: () => void }) {
  const v = rowView(r, "1h", nowMs);
  const c = r.chg_24h_bps;
  return (
    <Link role="option" id={id} aria-selected={on} tabIndex={-1} className="srr" to={tokenHref(r.chain, r.token)} data-token={r.token} data-chain={r.chain} title={v.symbol} onClick={onPick} onMouseDown={(e) => e.preventDefault()} onMouseMove={onHover}>
      <Ring v={v} size={40} stroke={3} av={30} />
      <span className="srr-a">
        <span className="srr-s">
          {v.symbol}
          {v.name && <span className="srr-n">{v.name}</span>}
        </span>
        <span className="srr-p">{v.price}</span>
      </span>
      <span className="srr-b">
        <span className="srr-mc">
          {v.mc}
          <u>{WORDS.mc.text}</u>
        </span>
        <span className="srr-c" data-dir={typeof c !== "number" ? "none" : c >= 0 ? "up" : "down"}>{change(c, "24h")}</span>
      </span>
    </Link>
  );
}

function Skeleton() {
  return (
    <div className="srr" aria-hidden="true">
      <span className="srr-sk srr-skc" />
      <span className="srr-a">
        <span className="srr-sk" style={{ width: 90, height: 14 }} />
        <span className="srr-sk" style={{ width: 56, height: 11 }} />
      </span>
      <span className="srr-b">
        <span className="srr-sk" style={{ width: 70, height: 14 }} />
        <span className="srr-sk" style={{ width: 44, height: 11 }} />
      </span>
    </div>
  );
}

interface View {
  state: "loading" | "error" | "rows" | "none";
  head: boolean;
  rows: MarketRow[];
  retry: () => void;
}

/** What the search draws for a query on the filter's chain. */
function useView(query: string, pick: ChainPick, lists: Lists): View {
  const q = useDeferredValue(query);
  const rows = useMemo(() => (lists.snapshot ? allRows(lists.snapshot) : []), [lists.snapshot]);
  const chains = useMemo(() => chainsWithData(rows), [rows]);
  const p = useMemo(() => plan(rows, q, pick, chains), [rows, q, pick, chains]);
  const found = useReads(p.reads);
  if (!lists.snapshot) return { state: lists.status === "error" ? "error" : "loading", head: false, rows: [], retry: lists.retry };
  if (!q.trim()) {
    const idle = idleRows(lists.snapshot, pick);
    return { state: idle.length ? "rows" : "none", head: idle.length > 0, rows: idle, retry: lists.retry };
  }
  if (p.reads.length) {
    if (found.status === "loading" || found.status === "idle") return { state: "loading", head: false, rows: [], retry: found.retry };
    if (found.status === "error") return { state: "error", head: false, rows: [], retry: found.retry };
    return { state: found.rows.length ? "rows" : "none", head: false, rows: found.rows, retry: found.retry };
  }
  return { state: p.rows.length ? "rows" : "none", head: false, rows: p.rows, retry: lists.retry };
}

function Results({ id, view, active, onPick, onHover }: { id: string; view: View; active: number; onPick: () => void; onHover: (i: number) => void }) {
  const nowMs = Date.now();
  return (
    <div className="srch-res" role="listbox" id={id} aria-label={WORDS.search.text} aria-busy={view.state === "loading"} data-state={view.state}>
      {view.head && (
        <div className="srch-head" role="presentation">
          <W id="trending" />
        </div>
      )}
      {view.state === "loading" ? (
        <div aria-label={WORDS.loading.text}>{[0, 1, 2].map((i) => <Skeleton key={i} />)}</div>
      ) : view.state === "error" ? (
        <div className="srch-msg">
          <W id="offline" />
          <button type="button" className="srch-retry" onMouseDown={(e) => e.preventDefault()} onClick={view.retry}>
            <W id="retry" />
          </button>
        </div>
      ) : view.state === "none" ? (
        <div className="srch-msg">
          <W id="noResults" />
        </div>
      ) : (
        view.rows.map((r, i) => <Row key={`${r.chain}/${r.token}`} r={r} id={`${id}-${i}`} on={i === active} nowMs={nowMs} onPick={onPick} onHover={() => onHover(i)} />)
      )}
    </div>
  );
}

/** The field's keys: up and down move the marked row, Enter opens it, Escape closes the search. */
function useKeys(view: View, onPick: () => void, onClose: () => void) {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const sig = view.rows.map((r) => r.token).join(" ");
  useEffect(() => setActive(0), [sig]);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = view.state === "rows" ? view.rows.length : 0;
    if (e.key === "ArrowDown" && n) (e.preventDefault(), setActive((a) => (a + 1) % n));
    else if (e.key === "ArrowUp" && n) (e.preventDefault(), setActive((a) => (a - 1 + n) % n));
    else if (e.key === "Enter" && n) {
      e.preventDefault();
      const r = view.rows[Math.min(active, n - 1)]!;
      onPick();
      navigate(tokenHref(r.chain, r.token));
    } else if (e.key === "Escape") (e.preventDefault(), onClose());
  };
  return { active, setActive, onKeyDown };
}

function Field({ query, setQuery, listId, active, open, onFocus, onKeyDown, inputRef, autoFocus }: { query: string; setQuery: (q: string) => void; listId: string; active: number; open: boolean; onFocus?: () => void; onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void; inputRef?: Ref<HTMLInputElement>; autoFocus?: boolean }) {
  return (
    <input
      ref={inputRef}
      className="srch-in"
      type="text"
      role="combobox"
      aria-label={WORDS.search.text}
      aria-expanded={open}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={open ? `${listId}-${active}` : undefined}
      placeholder={WORDS.placeholder.text}
      {...draftAttr("placeholder")}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      enterKeyHint="search"
      autoFocus={autoFocus}
      data-testid="search-input"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    />
  );
}

/** Closes on a press outside `box` while `on`. */
function useAway(on: boolean, box: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && close();
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [on, box, close]);
}

// ------------------------------------------------------------------------------------------------ the top bar's parts
/** The desktop field and its results under it (R5 .searchwrap .search). */
export function SearchField() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const pick = usePick();
  const lists = useLists(open);
  const view = useView(query, pick, lists);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    input.current?.blur();
  }, []);
  const picked = useCallback(() => {
    setQuery("");
    close();
  }, [close]);
  const keys = useKeys(view, picked, close);
  useAway(open, box, close);
  return (
    <div className="searchwrap" ref={box} data-testid="search" data-open={open}>
      <div className="search">
        <Ic d={SEARCH} />
        <Field query={query} setQuery={(q) => (setQuery(q), setOpen(true))} listId={listId} active={keys.active} open={open} onFocus={() => setOpen(true)} onKeyDown={keys.onKeyDown} inputRef={input} />
      </div>
      {open && (
        <div className="srch-pop" data-testid="search-results">
          <Results id={listId} view={view} active={keys.active} onPick={picked} onHover={keys.setActive} />
        </div>
      )}
    </div>
  );
}

const chainName = (c: MarketChain) => chainOf(c)?.name ?? c;

function Mark({ c, size }: { c: ChainPick; size: number }) {
  const m = c === "all" ? null : chainOf(c);
  if (!m) return <Ic d={ALL} size={size} />;
  return (
    <span className="srch-cm" style={{ width: size, height: size, padding: Math.round(size * m.inset) }}>
      <img src={m.logo} alt="" />
    </span>
  );
}

/** The chain chip (R5 P.chainChip): All, then each chain with data. */
export function ChainChip() {
  const pick = usePick();
  const [open, setOpen] = useState(false);
  const lists = useLists(open);
  const chains = useMemo(() => (lists.snapshot ? chainsWithData(allRows(lists.snapshot)) : []), [lists.snapshot]);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useAway(open, box, close);
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const choices: ChainPick[] = ["all", ...chains];
  return (
    <div className="srch-chip" ref={box}>
      <button type="button" className="chainchip" aria-haspopup="menu" aria-expanded={open} data-testid="chain-chip" data-pick={pick} onClick={() => setOpen((o) => !o)}>
        <Mark c={pick} size={13} />
        <span>{pick === "all" ? <W id="all" /> : chainName(pick)}</span>
        <Ic d={CHEV_DOWN} size={12} />
      </button>
      {open && (
        <div className="srch-menu" role="menu" data-testid="chain-menu">
          {choices.map((c) => (
            <button key={c} type="button" role="menuitemradio" aria-checked={c === pick} className="srch-mrow" data-chain={c} onClick={() => (setPick(c), setOpen(false))}>
              <Mark c={c} size={16} />
              <span>{c === "all" ? <W id="all" /> : chainName(c)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The search as a sheet over the page: the phone's search button and the narrow top bar's (R5 .phh .sfi, .tb-searchBtn). */
function Sheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const pick = usePick();
  const lists = useLists(true);
  const chains = useMemo(() => (lists.snapshot ? chainsWithData(allRows(lists.snapshot)) : []), [lists.snapshot]);
  const view = useView(query, pick, lists);
  const listId = useId();
  const keys = useKeys(view, onClose, onClose);
  return createPortal(
    <div className="srch-sheet" data-testid="search-sheet" role="dialog" aria-modal="true" aria-label={WORDS.search.text}>
      <div className="srch-top">
        <button type="button" className="srch-back" aria-label={WORDS.back.text} onClick={onClose}>
          <Ic d={BACK} size={18} stroke={1.3} />
        </button>
        <div className="srch-sf">
          <Ic d={SEARCH} size={16} />
          <Field query={query} setQuery={setQuery} listId={listId} active={keys.active} open onKeyDown={keys.onKeyDown} autoFocus />
        </div>
      </div>
      <div className="srch-chips" data-testid="chain-chips">
        {(["all", ...chains] as ChainPick[]).map((c) => (
          <button key={c} type="button" className="srch-cchip" aria-pressed={c === pick} data-chain={c} onClick={() => setPick(c)}>
            {c !== "all" && <Mark c={c} size={14} />}
            {c === "all" ? <W id="all" /> : chainName(c)}
          </button>
        ))}
      </div>
      <div className="srch-body">
        <Results id={listId} view={view} active={keys.active} onPick={onClose} onHover={keys.setActive} />
      </div>
    </div>,
    document.body,
  );
}

/** A search button that opens the sheet: `phone` the phone header's 44 px one (R5 .phh .sfi), else the top bar's 40 px
 *  one under 1024 px (R5 .tb-searchBtn). */
export function SearchButton({ phone = false }: { phone?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className={phone ? "hit44 sfi" : "bell tb-searchBtn"} aria-label={WORDS.search.text} aria-expanded={open} data-testid={phone ? "search-button-phone" : "search-button"} onClick={() => setOpen(true)}>
        <Ic d={SEARCH} size={phone ? 18 : 17} stroke={phone ? 1.2 : 1.25} />
      </button>
      {open && <Sheet onClose={close} />}
    </>
  );
}
