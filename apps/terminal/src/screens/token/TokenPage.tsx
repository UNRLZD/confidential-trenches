import { useCallback, useEffect, useRef, useState } from "react";
import type { KLineData } from "klinecharts";
import { useParams } from "react-router";
import { parseTokenRoute } from "../../routes/routes.ts";
import type { MarketChain } from "../discover/fields.ts";
import { DASH, price, usd } from "../discover/format.ts";
import { Avatar } from "../market/Avatar.tsx";
import { useSigninSheet } from "../signin/source.tsx";
import { text as signinWord } from "../signin/Word.tsx";
import { SafetyGrid } from "../trade/SafetyGrid.tsx";
import { TradeBox } from "../trade/TradeBox.tsx";
import { CHART_TFS, DEFAULT_TF, loadCandles } from "./candles.ts";
import type { Bar, CandleData, ChartTf } from "./candles.ts";
import { drawBars, mountChart, unmountChart } from "./chart.ts";
import type { Drawn } from "./chart.ts";
import { tokenView } from "./model.ts";
import type { Curve, TokenView } from "./model.ts";
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

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

const QUICK = [10, 25, 50, 100] as const;

/** A skeleton the height of the value it stands for: one line of that value's own font, so the strip keeps its height
 *  when the read lands (BAR-10 CLS). */
const SkLine = ({ cls, w }: { cls: string; w: number }) => <span className={`${cls} tkp-sk`} style={{ width: w }} aria-hidden="true">{"\u00a0"}</span>;
/** The identity line's skeleton: the filled line holds a mono age and address, so its height is the mono face's line. */
const SkMeta = ({ w }: { w: number }) => <span className="tkp-meta tkp-sk" style={{ width: w }} aria-hidden="true"><span className="tkp-num">{"\u00a0"}</span></span>;

/** The curve's value and, only on a curve, its bar (R5 U.about tk-curve). */
function CurveValue({ c }: { c: Curve }) {
  return (
    <>
      <span className="tkp-val" data-curve={c.on}>{c.text}</span>
      {c.on && (
        <span className="tkp-bar" data-testid="curve-bar" aria-hidden="true">
          <i style={{ width: `${(c.fill * 100).toFixed(2)}%` }} />
        </span>
      )}
    </>
  );
}

function Tile({ label, value, dir, k }: { label: WordId; value: string | null; dir?: string; k: string }) {
  return (
    <div className="tkp-tile" data-k={k}>
      <span className="tkp-lbl"><W id={label} /></span>
      {value === null ? <SkLine cls="tkp-val" w={64} /> : <span className="tkp-val" data-dir={dir}>{value}</span>}
    </div>
  );
}

function CurveTile({ v, phone }: { v: TokenView | null; phone?: boolean }) {
  return (
    <div className={phone ? "tkp-mtile" : "tkp-tile"} data-k="curve">
      <span className="tkp-lbl"><W id="curve" /></span>
      {v === null ? <SkLine cls="tkp-val" w={64} /> : <CurveValue c={v.curve} />}
    </div>
  );
}

/** R5's legend timeframe (token.js TF_LEGEND): 15m reads `15`, 1H `1H`. */
const TF_LEGEND: Record<ChartTf, string> = { "1m": "1", "5m": "5", "15m": "15", "1H": "1H", "4H": "4H", "1D": "1D" };
const MINUS = "\u2212";

/** The chart's candle read, one per page (the desktop and the phone draw the same): `token` null while the token read
 *  is still loading. A new token or timeframe reads again from loading; `retry` reads the same again. */
function useCandles(chain: MarketChain | null, token: string | null, tf: ChartTf): { data: CandleData; retry: () => void } {
  const [data, setData] = useState<CandleData>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (chain === null || token === null) return;
    let live = true;
    setData({ status: "loading" });
    void loadCandles(chain, token, tf).then((d) => live && setData(d));
    return () => {
      live = false;
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
 *  and the crosshair when ready, `No trades` when the helper holds no bars, `Offline` and Retry on a failed read.
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
    drawBars(drawn.current, c.sym ?? "", ready.tf, ready.bars, ready.precision);
    el.dataset.bars = String(drawn.current.chart.getDataList().length);
    setAt(null);
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
        {s === "empty" && <span className="tkp-plotmsg"><W id="noTrades" /></span>}
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

/** The box with the safety grid under it: the desktop column and the phone sheet draw the same. */
function Ticket({ r }: { r: Ready }) {
  const { row, risk } = r.data;
  return <TradeBox chain={row.chain} token={row.token} symbol={row.symbol} footer={<SafetyGrid row={row} risk={risk} nowMs={r.nowMs} />} />;
}

function Desktop({ v, r, c }: { v: TokenView | null; r: Ready | null; c: ChartState }) {
  const s = (x: string | undefined) => (v === null ? null : x!);
  return (
    <div className="tkp-desk">
      <div className="tkp-main">
        <header className="tkp-head">
          <div className="tkp-ident">
            {v ? <Avatar symbol={v.symbol} size={54} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 54, height: 54 }} />}
            <div className="tkp-idtext">
              <div className="tkp-symrow">
                {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <SkLine cls="tkp-sym" w={120} />}
              </div>
              {v ? (
                <div className="tkp-meta">
                  {v.name && <span className="tkp-name" title={v.name}>{v.name}</span>}
                  {v.name && <span className="tkp-sep" aria-hidden="true">|</span>}
                  <span className="tkp-num">{v.age}</span>
                  <span className="tkp-sep" aria-hidden="true">|</span>
                  <span className="tkp-num tkp-ca" title={v.token}>{v.token}</span>
                </div>
              ) : (
                <SkMeta w={220} />
              )}
            </div>
          </div>
          <div className="tkp-strip">
            <div className="tkp-mc">
              <span className="tkp-lbl"><W id="mc" /></span>
              {v ? <span className="tkp-mcval">{v.mc}</span> : <SkLine cls="tkp-mcval" w={120} />}
            </div>
            <Tile k="price" label="price" value={s(v?.priceTile)} />
            <Tile k="change" label="change" value={s(v?.chgTile)} dir={v?.chg.dir} />
            <Tile k="vol" label="vol" value={s(v?.vol)} />
            <Tile k="liq" label="liq" value={s(v?.liq)} />
            <Tile k="holders" label="holders" value={s(v?.holders)} />
            <CurveTile v={v} />
          </div>
        </header>
        <Chart c={c} />
      </div>
      <aside className="tkp-trade" data-slot="trade">
        {r ? <Ticket r={r} /> : <span className="tkp-sk tkp-tradesk" />}
      </aside>
    </div>
  );
}

/** The trade box in a bottom sheet (R5 token-390.html tradeSheet: scrim, grab handle, the symbol and price, then the box). The
 *  scrim, the handle and Escape close it; the page behind does not scroll while it is open. */
function TradeSheet({ v, r, onClose }: { v: TokenView; r: Ready; onClose: () => void }) {
  // the sign-in sheet opens over this one: its Escape closes only that
  const { open: signinOpen } = useSigninSheet();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !signinOpen && onClose();
    window.addEventListener("keydown", esc);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = was;
    };
  }, [onClose, signinOpen]);
  return (
    <div className="tkp-sheet" data-sheet="trade">
      <div className="tkp-scrim" onClick={onClose} />
      <div className="tkp-sheetbox" role="dialog" aria-modal="true" aria-label={`${WORDS.buy.text} ${v.symbol}`}>
        <button type="button" className="tkp-grab" aria-label={signinWord("close")} onClick={onClose}><i /></button>
        <div className="tkp-shead">
          <Avatar symbol={v.symbol} size={40} pad={v.launchpad} chain={v.chain} />
          <div className="tkp-stitle">
            <span className="tkp-ssym" title={v.symbol}>{v.symbol}</span>
            <span className="tkp-sprice">{v.price}</span>
          </div>
        </div>
        <Ticket r={r} />
      </div>
    </div>
  );
}

function Phone({ v, r, c }: { v: TokenView | null; r: Ready | null; c: ChartState }) {
  const [sheet, setSheet] = useState(false);
  const open = () => setSheet(true);
  const close = useCallback(() => setSheet(false), []);
  return (
    <div className="tkp-phone">
      <div className="tkp-hero">
        <div className="tkp-symrow">
          {v ? <Avatar symbol={v.symbol} size={32} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 32, height: 32 }} />}
          {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <SkLine cls="tkp-sym" w={100} />}
        </div>
        <div className="tkp-pricerow">
          {v ? <span className="tkp-price">{v.price}</span> : <SkLine cls="tkp-price" w={160} />}
          {v && <span className="tkp-chg" data-dir={v.chg.dir}>{v.chg.text}</span>}
          {v && <span className="tkp-h24"><W id="h24" /></span>}
        </div>
        {v ? (
          <div className="tkp-meta">
            {v.name && <span className="tkp-name" title={v.name}>{v.name}</span>}
            {v.name && <span className="tkp-dot" aria-hidden="true" />}
            <span className="tkp-num">{v.age}</span>
            <span className="tkp-dot" aria-hidden="true" />
            <span className="tkp-num tkp-ca" title={v.token}>{v.token}</span>
          </div>
        ) : (
          <SkMeta w={240} />
        )}
      </div>
      <Chart c={c} phone />
      <div className="tkp-mtiles">
        {(["mc", "curve", "liq", "vol", "holders"] as const).map((k) =>
          k === "curve" ? (
            <CurveTile key={k} v={v} phone />
          ) : (
            <div key={k} className="tkp-mtile" data-k={k}>
              <span className="tkp-lbl"><W id={k} /></span>
              {v ? <span className="tkp-val">{v[k]}</span> : <SkLine cls="tkp-val" w={70} />}
            </div>
          ),
        )}
      </div>
      {v && (
        <div className="tkp-bottom" data-testid="token-bar">
          <div className="tkp-quick">
            {QUICK.map((q) => (
              <button key={q} type="button" className="tkp-chip" onClick={open}>
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><path d="M6 0L0 7h4l-1 5 7-7.5H6z" /></svg>${q}
              </button>
            ))}
          </div>
          <div className="tkp-trade2">
            <button type="button" className="tkp-sell" onClick={open}><W id="sell" /></button>
            <button type="button" className="tkp-buy" onClick={open}><span className="tkp-buylbl" title={`${WORDS.buy.text} ${v.symbol}`}><W id="buy" /> {v.symbol}</span></button>
          </div>
        </div>
      )}
      {sheet && v && r && <TradeSheet v={v} r={r} onClose={close} />}
    </div>
  );
}

/** S7. `nowMs` is the clock the age is drawn against; `onRetry` asks the caller to read again. */
export function TokenPage({ data, nowMs, onRetry }: { data: TokenData; nowMs: number; onRetry: () => void }) {
  const row = data.status === "ready" ? data.row : null;
  const [tf, setTf] = useState<ChartTf>(DEFAULT_TF);
  const { data: candles, retry } = useCandles(row?.chain ?? null, row?.token ?? null, tf);
  if (data.status === "error" || data.status === "empty")
    return (
      <section className="tkp tkp-msg" data-token-page={data.status}>
        {data.status === "error" ? <W id="offline" /> : <W id="noToken" />}
        {data.status === "error" && <button type="button" className="tkp-retry" onClick={onRetry}>{WORDS.retry.text}</button>}
      </section>
    );
  const v = data.status === "ready" ? tokenView(data.row, nowMs) : null;
  const ready = data.status === "ready" ? { data, nowMs } : null;
  const c: ChartState = { sym: v?.symbol ?? null, tf, onTf: setTf, data: candles, retry };
  return (
    <section className="tkp" data-token-page={data.status} data-token={v?.token} aria-busy={v === null} aria-label={v === null ? WORDS.loading.text : undefined}>
      <Desktop v={v} r={ready} c={c} />
      <Phone v={v} r={ready} c={c} />
    </section>
  );
}

/** The token route. /token/<chain>/<id> draws that token (source.ts); a chain the terminal does not draw is the page's
 *  not-found, with no read. / draws the top Trending token. */
export function TokenRoute() {
  const params = useParams();
  if (params.chain === undefined) return <TopToken />;
  const t = parseTokenRoute(params);
  if (!t) return <TokenPage data={{ status: "empty" }} nowMs={0} onRetry={() => {}} />;
  return <ReadToken key={`${t.chain}/${t.id}`} chain={t.chain} id={t.id} />;
}

function TopToken() {
  const { data, nowMs, retry } = useTopToken();
  return <TokenPage data={data} nowMs={nowMs} onRetry={retry} />;
}

function ReadToken({ chain, id }: { chain: MarketChain; id: string }) {
  const { data, nowMs, retry } = useToken(chain, id);
  return <TokenPage data={data} nowMs={nowMs} onRetry={retry} />;
}
