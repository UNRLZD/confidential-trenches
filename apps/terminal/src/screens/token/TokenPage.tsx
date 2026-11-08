import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { KLineData } from "klinecharts";
import { useParams } from "react-router";
import { parseTokenRoute } from "../../routes/routes.ts";
import type { MarketChain } from "../discover/fields.ts";
import { DASH, price, usd } from "../discover/format.ts";
import { Avatar } from "../market/Avatar.tsx";
import { text as signinWord } from "../signin/Word.tsx";
import { SafetyGrid } from "../trade/SafetyGrid.tsx";
import { safetyCells } from "../trade/safety.ts";
import { SIGN_HOST_URL } from "../../shell/signpage-frame.tsx";
import { TradeView, useTrade } from "../trade/TradeBox.tsx";
import type { Trade } from "../trade/TradeBox.tsx";
import { TradeSheet, useTradeSheet } from "../trade/TradeSheet.tsx";
import { TradeToast } from "../trade/TradeToast.tsx";
import { centsToDecimal, fmtUsd, PRESETS } from "../trade/model.ts";
import { CHART_TFS, DEFAULT_TF, followCandles, loadCandles } from "./candles.ts";
import type { Bar, CandleData, ChartTf } from "./candles.ts";
import { liveBars, mountChart, unmountChart } from "./chart.ts";
import type { Drawn } from "./chart.ts";
import { copyText, readWatch, shareHref, toggleWatch, tokenLinks, tokenView } from "./model.ts";
import type { TokenView } from "./model.ts";
import { useToken, useTopToken } from "./source.ts";
import type { TokenData } from "./source.ts";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./token.css";

// S7 the token page shell (A2.2, app.md:1435 at research 3c95759), drawn after R5's trenches-1440.html and
// token-390.html (research repo design/proto at design-lock-r5): desktop, the header (identity and the metric strip)
// over the chart's area beside the trade box's place; phone, the hero, the chart's area, the metric tiles and the bottom
// bar (quick buys, Sell, Buy SYM) above the shell's tab bar. States: S7.1 skeleton, S7.2 filled, S7.3 the same with
// dashes, the empty and error labels. Each part's own card fills it: the chart and the info strip's data (markets),
// the trade box (S8) and what the bar's buttons open.
//
// Card app-trade-box-mount puts the trade box and the safety grid under it (the token read's row and risk) in the
// desktop's right column, signed out as designed (S8.1: `Bal —`, the exit plan off, `Sign in to trade`), and opens the
// same box in a bottom sheet from the phone bar's Buy, Sell and quick buys. The signed-in money path is trade-box-pool's.
// Card app-phone-trade-sheet moves the sheet to trade/TradeSheet.tsx: its box stays mounted when it closes, so a running
// buy is drawn where it is on the next open; a pushed page (/token/<chain>/<id>) has no tab bar, its bar at the bottom.

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

/** A skeleton the height of the value it stands for: one line of that value's own font, so the strip keeps its height
 *  when the read lands (BAR-10 CLS). */
const SkLine = ({ cls, w }: { cls: string; w: number }) => <span className={`${cls} tkp-sk`} style={{ width: w }} aria-hidden="true">{"\u00a0"}</span>;
/** The identity line's skeleton: the filled line holds a mono age and address, so its height is the mono face's line. */
const SkMeta = ({ w }: { w: number }) => <span className="tkp-meta tkp-sk" style={{ width: w }} aria-hidden="true"><span className="tkp-num">{"\u00a0"}</span></span>;

function Tile({ label, value, dir, tone, k }: { label: WordId; value: string | null; dir?: string; tone?: string; k: string }) {
  return (
    <div className="tkp-tile" data-k={k}>
      <span className="tkp-lbl"><W id={label} /></span>
      {value === null ? <SkLine cls="tkp-val" w={64} /> : <span className="tkp-val" data-dir={dir} data-tone={tone}>{value}</span>}
    </div>
  );
}

// R5's line icons (assets/app.js I, drawn by P.ic in a 12 box): the identity's links, star, copy, share and back
const ICONS: Record<string, readonly (string | readonly [string, Record<string, number>])[]> = {
  link: ["M5 7l2-2", "M4.2 5.2L3 6.4a2 2 0 002.8 2.8L7 8", "M7.8 6.8L9 5.6a2 2 0 00-2.8-2.8L5 4"],
  search: [["circle", { cx: 5.2, cy: 5.2, r: 3.7 }], "M8 8l2.8 2.8"],
  star: ["M6 1.2l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.8l-3 1.5.6-3.3-2.4-2.3 3.3-.5z"],
  copy: [["rect", { x: 4, y: 4, width: 6.5, height: 6.5, rx: 1.2 }], "M8 4V2.7c0-.7-.5-1.2-1.2-1.2H2.7c-.7 0-1.2.5-1.2 1.2v4.1c0 .7.5 1.2 1.2 1.2H4"],
  share: ["M6 7.5V1.5M3.5 4L6 1.5 8.5 4", "M2 7v2.5c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V7"],
  back: ["M7.5 2.5L4 6l3.5 3.5"],
};
function Ic({ n, size = 13, stroke = 1.25, filled = false }: { n: keyof typeof ICONS; size?: number; stroke?: number; filled?: boolean }) {
  return (
    <svg className="tkp-ic" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <g fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[n]!.map((p, i) => (typeof p === "string" ? <path key={i} d={p} /> : p[0] === "circle" ? <circle key={i} {...p[1]} /> : <rect key={i} {...p[1]} />))}
      </g>
    </svg>
  );
}

/** The page's own copy command: a framed page whose parent keeps the async clipboard from it still copies on a tap. */
function pageCopy(t: string): boolean {
  const el = document.createElement("textarea");
  el.value = t;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:-100px;opacity:0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    el.remove();
  }
}
const copy = (t: string) => copyText(t, navigator.clipboard, pageCopy);

/** Copy contract (R5 hd-copy): the address to the clipboard; `data-copied` lights it once it took. */
function CopyBtn({ token, cls, children }: { token: string; cls: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" className={cls} data-copied={copied} aria-label={WORDS.copy.text} title={token} onClick={() => void copy(token).then(setCopied)}>
      {children}
      <Ic n="copy" size={cls === "tkp-copy" ? 14 : 13} />
    </button>
  );
}

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
/** The watchlist star (R5 token-watch): kept on this device (model.ts readWatch). */
function Star({ v, cls, size }: { v: TokenView; cls: string; size: number }) {
  const key = `${v.chain}/${v.token}`;
  const [on, setOn] = useState(() => readWatch(storage()).includes(key));
  const label = (on ? WORDS.watchRemove.text : WORDS.watchAdd.text).replace("{sym}", v.symbol);
  return (
    <button type="button" className={cls} data-on={on} aria-pressed={on} aria-label={label} title={label} onClick={() => setOn(toggleWatch(storage(), key))}>
      <Ic n="star" size={size} filled={on} />
    </button>
  );
}

/** The link icons (R5 socials and explorers): only those with data behind them (model.ts tokenLinks). */
function Links({ v }: { v: TokenView }) {
  return (
    <>
      {tokenLinks(v.chain, v.token).map((l) => {
        const name = l.id === "xSearch" ? WORDS.searchX.text : WORDS[l.name].text;
        return (
          <a key={l.id} className="tkp-ib" href={l.href} target="_blank" rel="noopener noreferrer" aria-label={name} title={name} data-link={l.id}>
            <Ic n={l.id === "xSearch" ? "search" : "link"} size={l.id === "xSearch" ? 12 : 13} />
          </a>
        );
      })}
    </>
  );
}

/** R5's legend timeframe (token.js TF_LEGEND): 15m reads `15`, 1H `1H`. */
const TF_LEGEND: Record<ChartTf, string> = { "1m": "1", "5m": "5", "15m": "15", "1H": "1H", "4H": "4H", "1D": "1D" };
const MINUS = "\u2212";

/** The chart's candle read, one per page (the desktop and the phone draw the same): `token` null while the token read
 *  is still loading. A new token or timeframe reads again from loading; `retry` reads the same again. Bars of the
 *  helper's own reads are then followed live (candles.ts followCandles, card app-chart-live) until the page, the token
 *  or the timeframe changes. */
function useCandles(chain: MarketChain | null, token: string | null, tf: ChartTf): { data: CandleData; retry: () => void } {
  const [data, setData] = useState<CandleData>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (chain === null || token === null) return;
    const [ch, id] = [chain, token];
    let live = true;
    let stop = () => {};
    setData({ status: "loading" });
    void loadCandles(ch, id, tf).then((d) => {
      if (!live) return;
      setData(d);
      if (d.status === "ready" && d.own) stop = followCandles(ch, id, d, (r) => live && setData(r));
    });
    return () => {
      live = false;
      stop();
    };
  }, [chain, token, tf, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, retry };
}

/** The shared chart state the desktop and the phone draw. */
interface ChartState {
  sym: string | null;
  tf: ChartTf;
  onTf: (t: ChartTf) => void;
  data: CandleData;
  retry: () => void;
}

/** R5's legend (token.js U.legend): the bar under the crosshair, else the newest; its colour is its close against the
 *  bar before it. On the phone only the close and the change (R5 unrlzd.css .cp-lgKv[data-ohl]). */
function Legend({ sym, tf, bars, at, precision, phone }: { sym: string; tf: ChartTf; bars: readonly Bar[]; at: KLineData | null; precision: number; phone?: boolean }) {
  let i = bars.length - 1;
  if (at) {
    const j = bars.findIndex((b) => b.timestamp === at.timestamp);
    if (j >= 0) i = j;
  }
  const k = bars[i]!;
  const prev = bars[i - 1] ?? k;
  const dir = k.close >= prev.close ? "up" : "down";
  const p = (x: number) => price(x.toFixed(precision));
  const d = k.close - prev.close;
  const pc = prev.close ? (d / prev.close) * 100 : 0;
  const ch = `${d >= 0 ? "+" : MINUS}${p(Math.abs(d))} (${pc >= 0 ? "+" : MINUS}${Math.abs(pc).toFixed(2)}%)`;
  const kv = (id: "lgO" | "lgH" | "lgL" | "lgC", x: number) => (
    <span className="tkp-lgkv" data-k={id}>
      <W id={id} /> <span data-dir={dir}>{p(x)}</span>
    </span>
  );
  return (
    <div className="tkp-legend" data-testid="chart-legend">
      <span className="tkp-lgrow">
        <span className="tkp-lghead">
          {sym} · {TF_LEGEND[tf]} · <W id="lgVenue" />
        </span>
        {!phone && kv("lgO", k.open)}
        {!phone && kv("lgH", k.high)}
        {!phone && kv("lgL", k.low)}
        {kv("lgC", k.close)}
        <span className="tkp-lgkv" data-dir={dir}>{ch}</span>
      </span>
      <span className="tkp-lgrow">
        <span className="tkp-lgkv">
          <W id="vol" /> <span data-dir={dir}>{k.volume > 0 ? usd(k.volume.toFixed(2)) : DASH}</span>
        </span>
      </span>
    </div>
  );
}

/** The price chart (S7.2's chart panel): the timeframes, then the plot. The plot keeps its size in every state, so a
 *  read landing moves nothing (BAR-10 CLS): the skeleton while loading, the candles with the price axis, the volume pane
 *  and the crosshair when ready, `No data` when the helper holds no bars, `Offline` and Retry on a failed read.
 *  CoinGecko's label shows while any drawn bar is GeckoTerminal's (none over no bars). The library draws only once the
 *  plot is on screen (the page holds both layouts; one is display: none). */
function Chart({ c, phone }: { c: ChartState; phone?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<Drawn | null>(null);
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState<KLineData | null>(null);
  const ready = c.data.status === "ready" ? c.data : null;
  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setShown(el.clientWidth > 0 && el.clientHeight > 0));
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (drawn.current) unmountChart(el);
      drawn.current = null;
    };
  }, []);
  useEffect(() => {
    const el = host.current!;
    if (!shown || ready === null) return;
    drawn.current ??= mountChart(el, phone === true, setAt);
    if (drawn.current === null) return;
    // a live read moves the last bar in place (the crosshair kept); a new read or timeframe draws them all again
    if (liveBars(drawn.current, c.sym ?? "", ready.tf, ready.bars, ready.precision)) setAt(null);
    const list = drawn.current.chart.getDataList();
    el.dataset.bars = String(list.length);
    const last = list.at(-1);
    el.dataset.last = last ? `${last.timestamp}:${last.close}` : "";
  }, [shown, ready]);
  const tfs = (
    <div className={phone ? "tkp-tfs tkp-tfs-ph" : "tkp-tfs"}>
      {CHART_TFS.map((t) => (
        <button key={t} type="button" className="tkp-tf" aria-pressed={t === c.tf} onClick={() => c.onTf(t)}>{t}</button>
      ))}
    </div>
  );
  const s = c.data.status;
  return (
    <section className="tkp-chart" data-slot="chart" data-chart={s} aria-label={WORDS.chart.text}>
      {!phone && tfs}
      <div className="tkp-plot" data-drawn={ready !== null} onMouseLeave={() => setAt(null)}>
        <div className="tkp-kc" ref={host} data-testid="chart-canvas" />
        {ready && c.sym && <Legend sym={c.sym} tf={ready.tf} bars={ready.bars} at={at} precision={ready.precision} phone={phone} />}
        {s === "loading" && <span className="tkp-sk tkp-plotsk" />}
        {s === "empty" && <span className="tkp-plotmsg"><W id="noData" /></span>}
        {s === "error" && (
          <span className="tkp-plotmsg">
            <W id="offline" />
            <button type="button" className="tkp-retry" onClick={c.retry}>{WORDS.retry.text}</button>
          </span>
        )}
        {ready?.gecko && <span className="tkp-vendor" data-testid="chart-vendor"><W id="gecko" /></span>}
      </div>
      {phone && tfs}
    </section>
  );
}

/** What the trade box and the grid need from a ready read. */
interface Ready {
  data: Extract<TokenData, { status: "ready" }>;
  nowMs: number;
}

/** The box with the safety grid under it: the desktop column and the phone sheet draw the same, from the page's one
 *  trade state (TokenPage's useTrade), so a buy started at one width is the buy the other width draws. */
function Ticket({ r, t, toast }: { r: Ready; t: Trade; toast?: boolean }) {
  const { row, risk } = r.data;
  return <TradeView t={t} symbol={row.symbol} toast={toast} footer={<SafetyGrid row={row} risk={risk} nowMs={r.nowMs} filling={r.data.filling === true} />} />;
}

/** The strip's and the tiles' Tax: the token read's transfer fee as the safety grid draws it (trade/safety.ts). */
const taxOf = (r: Ready) => safetyCells(r.data.row, r.data.risk, r.nowMs).find((c) => c.id === "tax")!;

function Desktop({ v, r, c, t }: { v: TokenView | null; r: Ready | null; c: ChartState; t: Trade }) {
  // null draws the tile's skeleton: the page is loading, or its row is still filling (card token-page-fills-after)
  const s = (x: string | null | undefined) => (v === null ? null : (x ?? null));
  const tax = r ? taxOf(r) : null;
  return (
    <div className="tkp-desk">
      <div className="tkp-main">
        <header className="tkp-head">
          <div className="tkp-ident">
            {v ? <Avatar symbol={v.symbol} size={54} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 54, height: 54 }} />}
            <div className="tkp-idtext">
              <div className="tkp-symrow">
                {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <SkLine cls="tkp-sym" w={120} />}
                <div className="tkp-icons" data-testid="token-links">
                  {v && <Links v={v} />}
                  {v && <Star v={v} cls="tkp-ib" size={13} />}
                </div>
              </div>
              {v ? (
                <div className="tkp-meta">
                  {v.name && <span className="tkp-name" title={v.name}>{v.name}</span>}
                  {v.name && <span className="tkp-sep" aria-hidden="true">|</span>}
                  {v.age === null ? <SkLine cls="tkp-num" w={28} /> : <span className="tkp-num">{v.age}</span>}
                  <span className="tkp-sep" aria-hidden="true">|</span>
                  <span className="tkp-num tkp-ca" title={v.token}>{v.token}</span>
                  <CopyBtn token={v.token} cls="tkp-copy" />
                </div>
              ) : (
                <SkMeta w={220} />
              )}
            </div>
          </div>
          <div className="tkp-strip">
            <div className="tkp-mc">
              <span className="tkp-lbl"><W id="mc" /></span>
              {v?.mc != null ? <span className="tkp-mcval">{v.mc}</span> : <SkLine cls="tkp-mcval" w={120} />}
            </div>
            <Tile k="price" label="price" value={s(v?.priceTile)} />
            <Tile k="change" label="change" value={s(v?.chgTile)} dir={v?.chg?.dir} />
            <Tile k="tax" label="tax" value={tax?.text ?? null} tone={tax?.tone} />
            <Tile k="vol" label="vol" value={s(v?.vol)} />
            <Tile k="liq" label={v?.curve.on ? "inCurve" : "liq"} value={s(v?.liq)} />
            <Tile k="holders" label="holders" value={s(v?.holders)} />
          </div>
        </header>
        <Chart c={c} />
      </div>
      <aside className="tkp-trade" data-slot="trade">
        {r ? <Ticket r={r} t={t} /> : <span className="tkp-sk tkp-tradesk" />}
      </aside>
    </div>
  );
}

/** The sheet's head row (R5 token-390.html tradeSheet ms-head): the token's avatar, the symbol over the price. */
function SheetHead({ v }: { v: TokenView }) {
  return (
    <div className="tkp-shead">
      <Avatar symbol={v.symbol} size={40} pad={v.launchpad} chain={v.chain} />
      <div className="tkp-stitle">
        <span className="tkp-ssym" title={v.symbol}>{v.symbol}</span>
        {v.price === null ? <SkLine cls="tkp-sprice" w={80} /> : <span className="tkp-sprice">{v.price}</span>}
      </div>
    </div>
  );
}

/** Share (R5 m-token-share): the token's public address, by the system sheet where the page may use it, else copied. */
function share(v: TokenView) {
  const url = shareHref(SIGN_HOST_URL, v.chain, v.token);
  if (typeof navigator.share === "function") return void navigator.share({ title: v.symbol, url }).catch(() => void copy(url));
  void copy(url);
}

/** Back (R5 pp-back): where the visitor came from in the terminal, else Discover's first page. */
function back() {
  if (window.history.length > 1) window.history.back();
  else window.location.assign("/");
}

function Phone({ v, r, c, t }: { v: TokenView | null; r: Ready | null; c: ChartState; t: Trade }) {
  const sheet = useTradeSheet();
  const tax = r ? taxOf(r) : null;
  const cells = r ? safetyCells(r.data.row, r.data.risk, r.nowMs) : null;
  // while the row fills, a holder share it has no value for yet is still loading (card token-page-fills-after)
  const waits = (f: "top10_bps" | "dev_bps") => v?.filling === true && r !== null && r.data.row[f] == null;
  const cell = (id: "top10" | "dev") => (waits(id === "top10" ? "top10_bps" : "dev_bps") ? null : (cells?.find((x) => x.id === id) ?? null));
  return (
    <div className="tkp-phone">
      <div className="tkp-nav" data-testid="token-nav">
        <button type="button" className="tkp-navbtn" aria-label={WORDS.back.text} onClick={back}><Ic n="back" size={20} stroke={1.4} /></button>
        {v ? <Avatar symbol={v.symbol} size={30} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 30, height: 30 }} />}
        {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <SkLine cls="tkp-sym" w={100} />}
        {v && <Star v={v} cls="tkp-navbtn tkp-star" size={20} />}
        {v && <button type="button" className="tkp-navbtn" aria-label={WORDS.share.text} onClick={() => share(v)}><Ic n="share" size={19} /></button>}
      </div>
      <div className="tkp-hero">
        <div className="tkp-pricerow">
          {v?.price != null ? <span className="tkp-price">{v.price}</span> : <SkLine cls="tkp-price" w={160} />}
          {v?.chg && <span className="tkp-chg" data-dir={v.chg.dir}>{v.chg.text}</span>}
          {v?.chg && <span className="tkp-h24"><W id="h24" /></span>}
        </div>
        {v ? (
          <div className="tkp-meta">
            {v.name && <span className="tkp-name" title={v.name}>{v.name}</span>}
            {v.name && <span className="tkp-dot" aria-hidden="true" />}
            {v.age === null ? <SkLine cls="tkp-num" w={28} /> : <span className="tkp-num">{v.age}</span>}
            <span className="tkp-dot" aria-hidden="true" />
            <CopyBtn token={v.token} cls="tkp-mca">
              <span className="tkp-num tkp-ca">{v.token}</span>
            </CopyBtn>
          </div>
        ) : (
          <SkMeta w={240} />
        )}
        <div className="tkp-links" data-testid="token-links">
          {v && <Links v={v} />}
        </div>
      </div>
      <Chart c={c} phone />
      <div className="tkp-mtiles">
        {(
          [
            ["mc", "mc", v?.mc, undefined],
            ["liq", v?.curve.on ? "inCurve" : "liq", v?.liq, undefined],
            ["vol", "vol", v?.vol, undefined],
            ["holders", "holders", v?.holders, undefined],
            ["top10", "top10", cell("top10")?.text, cell("top10")?.tone],
            ["dev", "dev", cell("dev")?.text, cell("dev")?.tone],
            ["tax", "tax", tax?.text, tax?.tone],
          ] as const
        ).map(([k, label, value, tone]) => (
          <div key={k} className="tkp-mtile" data-k={k}>
            <span className="tkp-lbl"><W id={label} /></span>
            {value != null && v ? <span className="tkp-val" data-tone={tone}>{value}</span> : <SkLine cls="tkp-val" w={70} />}
            <span className="tkp-viz" aria-hidden="true" />
          </div>
        ))}
      </div>
      {v && (
        <div className="tkp-bottom" data-testid="token-bar">
          <div className="tkp-quick">
            {PRESETS.map((p) => (
              <button key={String(p)} type="button" className="tkp-chip" data-preset={centsToDecimal(p)} disabled={t.presetOff(p)} onClick={() => t.tapPreset(p)}>
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><path d="M6 0L0 7h4l-1 5 7-7.5H6z" /></svg>{fmtUsd(p)}
              </button>
            ))}
          </div>
          <div className="tkp-trade2">
            <button type="button" className="tkp-sell" onClick={sheet.open}><W id="sell" /></button>
            <button type="button" className="tkp-buy" onClick={sheet.open}><span className="tkp-buylbl" title={`${WORDS.buy.text} ${v.symbol}`}><W id="buy" /> {v.symbol}</span></button>
          </div>
        </div>
      )}
      {v && r && (
        <TradeSheet state={sheet.state} onClose={sheet.close} label={`${WORDS.buy.text} ${v.symbol}`} closeLabel={signinWord("close")} head={<SheetHead v={v} />}>
          <Ticket r={r} t={t} toast={false} />
        </TradeSheet>
      )}
      {v && <TradeToast t={t} symbol={v.symbol} sheetOpen={sheet.state.open} />}
    </div>
  );
}

/** S7. `nowMs` is the clock the age is drawn against; `onRetry` asks the caller to read again; `pushed` is a token's own
 *  route (/token/<chain>/<id>), pushed over the tabs with no tab bar (09-design-brief S7 phone), not the home route. */
export function TokenPage({ data, nowMs, onRetry, pushed = false }: { data: TokenData; nowMs: number; onRetry: () => void; pushed?: boolean }) {
  const row = data.status === "ready" ? data.row : null;
  const [tf, setTf] = useState<ChartTf>(DEFAULT_TF);
  const { data: candles, retry } = useCandles(row?.chain ?? null, row?.token ?? null, tf);
  // the page's one trade state, drawn by the desktop column's box and the phone sheet's (card app-phone-trade-sheet)
  const trade = useTrade(row ? { chain: row.chain, token: row.token } : null);
  if (data.status === "error" || data.status === "empty")
    return (
      <section className="tkp tkp-msg" data-token-page={data.status} data-pushed={pushed || undefined}>
        {data.status === "error" ? <W id="offline" /> : <W id="noToken" />}
        {data.status === "error" && <button type="button" className="tkp-retry" onClick={onRetry}>{WORDS.retry.text}</button>}
      </section>
    );
  const v = data.status === "ready" ? tokenView(data.row, nowMs, data.filling === true) : null;
  const ready = data.status === "ready" ? { data, nowMs } : null;
  const c: ChartState = { sym: v?.symbol ?? null, tf, onTf: setTf, data: candles, retry };
  return (
    <section className="tkp" data-token-page={data.status} data-pushed={pushed || undefined} data-token={v?.token} data-filling={v?.filling} aria-busy={v === null || v.filling} aria-label={v === null ? WORDS.loading.text : undefined}>
      <Desktop v={v} r={ready} c={c} t={trade} />
      <Phone v={v} r={ready} c={c} t={trade} />
    </section>
  );
}

/** The token route. /token/<chain>/<id> draws that token (source.ts); a chain the terminal does not draw is the page's
 *  not-found, with no read. / draws the top Trending token. */
export function TokenRoute() {
  const params = useParams();
  if (params.chain === undefined) return <TopToken />;
  const t = parseTokenRoute(params);
  if (!t) return <TokenPage data={{ status: "empty" }} nowMs={0} onRetry={() => {}} pushed />;
  return <ReadToken key={`${t.chain}/${t.id}`} chain={t.chain} id={t.id} />;
}

function TopToken() {
  const { data, nowMs, retry } = useTopToken();
  return <TokenPage data={data} nowMs={nowMs} onRetry={retry} />;
}

function ReadToken({ chain, id }: { chain: MarketChain; id: string }) {
  const { data, nowMs, retry } = useToken(chain, id);
  return <TokenPage data={data} nowMs={nowMs} onRetry={retry} pushed />;
}
