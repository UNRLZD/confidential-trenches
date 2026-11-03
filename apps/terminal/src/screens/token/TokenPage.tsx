import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Avatar } from "../market/Avatar.tsx";
import { FIXTURE_NOW_MS } from "./fixtures.ts";
import { tokenView } from "./model.ts";
import type { Curve, TokenView } from "./model.ts";
import { tokenData } from "./source.ts";
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

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

/** Timeframes R5 draws (token.js TF_LABEL; token-390.html mt-tfs); 15m is the default (BRF v2.0.5, M157). */
const TFS = ["1m", "5m", "15m", "1H", "4H", "1D"] as const;
const QUICK = [10, 25, 50, 100] as const;

const Sk = ({ w, h }: { w: number | string; h: number }) => <span className="tkp-sk" style={{ width: w, height: h }} />;

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
      {value === null ? <Sk w={64} h={15} /> : <span className="tkp-val" data-dir={dir}>{value}</span>}
    </div>
  );
}

function CurveTile({ v, phone }: { v: TokenView | null; phone?: boolean }) {
  return (
    <div className={phone ? "tkp-mtile" : "tkp-tile"} data-k="curve">
      <span className="tkp-lbl"><W id="curve" /></span>
      {v === null ? <Sk w={64} h={15} /> : <CurveValue c={v.curve} />}
    </div>
  );
}

function Chart({ loading, phone }: { loading: boolean; phone?: boolean }) {
  const [tf, setTf] = useState<(typeof TFS)[number]>("15m");
  const tfs = (
    <div className={phone ? "tkp-tfs tkp-tfs-ph" : "tkp-tfs"}>
      {TFS.map((t) => (
        <button key={t} type="button" className="tkp-tf" aria-pressed={t === tf} onClick={() => setTf(t)}>{t}</button>
      ))}
    </div>
  );
  return (
    <section className="tkp-chart" data-slot="chart" aria-label={WORDS.chart.text}>
      {!phone && tfs}
      <div className="tkp-plot">{loading && <span className="tkp-sk tkp-plotsk" />}</div>
      {phone && tfs}
    </section>
  );
}

function Desktop({ v }: { v: TokenView | null }) {
  const s = (x: string | undefined) => (v === null ? null : x!);
  return (
    <div className="tkp-desk">
      <div className="tkp-main">
        <header className="tkp-head">
          <div className="tkp-ident">
            {v ? <Avatar symbol={v.symbol} size={54} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 54, height: 54 }} />}
            <div className="tkp-idtext">
              <div className="tkp-symrow">
                {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <Sk w={120} h={22} />}
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
                <Sk w={220} h={13} />
              )}
            </div>
          </div>
          <div className="tkp-strip">
            <div className="tkp-mc">
              <span className="tkp-lbl"><W id="mc" /></span>
              {v ? <span className="tkp-mcval">{v.mc}</span> : <Sk w={120} h={26} />}
            </div>
            <Tile k="price" label="price" value={s(v?.price)} />
            <Tile k="change" label="change" value={s(v?.chg.text)} dir={v?.chg.dir} />
            <Tile k="vol" label="vol" value={s(v?.vol)} />
            <Tile k="liq" label="liq" value={s(v?.liq)} />
            <Tile k="holders" label="holders" value={s(v?.holders)} />
            <CurveTile v={v} />
          </div>
        </header>
        <Chart loading={v === null} />
      </div>
      <aside className="tkp-trade" data-slot="trade" />
    </div>
  );
}

function Phone({ v }: { v: TokenView | null }) {
  return (
    <div className="tkp-phone">
      <div className="tkp-hero">
        <div className="tkp-symrow">
          {v ? <Avatar symbol={v.symbol} size={32} pad={v.launchpad} chain={v.chain} /> : <span className="tkp-sk tkp-skc" style={{ width: 32, height: 32 }} />}
          {v ? <h1 className="tkp-sym" title={v.symbol}>{v.symbol}</h1> : <Sk w={100} h={20} />}
        </div>
        <div className="tkp-pricerow">
          {v ? <span className="tkp-price">{v.price}</span> : <Sk w={160} h={30} />}
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
          <Sk w={240} h={13} />
        )}
      </div>
      <Chart loading={v === null} phone />
      <div className="tkp-mtiles">
        {(["mc", "curve", "liq", "vol", "holders"] as const).map((k) =>
          k === "curve" ? (
            <CurveTile key={k} v={v} phone />
          ) : (
            <div key={k} className="tkp-mtile" data-k={k}>
              <span className="tkp-lbl"><W id={k} /></span>
              {v ? <span className="tkp-val">{v[k]}</span> : <Sk w={70} h={16} />}
            </div>
          ),
        )}
      </div>
      {v && (
        <div className="tkp-bottom" data-testid="token-bar">
          <div className="tkp-quick">
            {QUICK.map((q) => (
              <button key={q} type="button" className="tkp-chip">
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><path d="M6 0L0 7h4l-1 5 7-7.5H6z" /></svg>${q}
              </button>
            ))}
          </div>
          <div className="tkp-trade2">
            <button type="button" className="tkp-sell"><W id="sell" /></button>
            <button type="button" className="tkp-buy"><span className="tkp-buylbl" title={`${WORDS.buy.text} ${v.symbol}`}><W id="buy" /> {v.symbol}</span></button>
          </div>
        </div>
      )}
    </div>
  );
}

/** S7. `nowMs` is the clock the age is drawn against; `onRetry` asks the caller to read again. */
export function TokenPage({ data, nowMs, onRetry }: { data: TokenData; nowMs: number; onRetry: () => void }) {
  if (data.status === "error" || data.status === "empty")
    return (
      <section className="tkp tkp-msg" data-token-page={data.status}>
        {data.status === "error" ? <W id="offline" /> : <W id="noToken" />}
        {data.status === "error" && <button type="button" className="tkp-retry" onClick={onRetry}>{WORDS.retry.text}</button>}
      </section>
    );
  const v = data.status === "ready" ? tokenView(data.row, nowMs) : null;
  return (
    <section className="tkp" data-token-page={data.status} data-token={v?.token} aria-busy={v === null} aria-label={v === null ? WORDS.loading.text : undefined}>
      <Desktop v={v} />
      <Phone v={v} />
    </section>
  );
}

/** The token route: the page on the fixture source (source.ts) until the market data read lands. */
export function TokenRoute() {
  const { search } = useLocation();
  const [reads, setReads] = useState(0);
  const data = useMemo(() => tokenData(search), [search, reads]);
  return <TokenPage data={data} nowMs={FIXTURE_NOW_MS} onRetry={() => setReads((n) => n + 1)} />;
}
