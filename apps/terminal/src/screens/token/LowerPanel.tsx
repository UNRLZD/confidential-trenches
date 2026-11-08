// The token page's lower panel and About (card app-token-lower-panel), drawn after R5's U.lowerTabs, U.tradesTab,
// U.holdersTab and U.about (research repo design/proto/assets/token.js and trenches-1440.html, token-390.html at
// design-lock-r5). Desktop: under the chart, the tabs Holders (N) and Trades, Trades open; About in the trade column
// under the box. Phone: under the tiles, the tabs Trades and Holders N; About under the box in the trade sheet, as R5.
// Trades is the tape the chart's marks read, while it is served, else `No data`; Holders is the helper's holders read,
// its rows when the helper holds the holders key, else the count and the top share from Jupiter and `No data` for the
// rows. R5's other tabs (Top traders, My orders, My position) and the trades toolbar are other cards'. The data and its
// formats are lower.ts's.
import { useEffect, useState } from "react";
import type { MarketRow } from "../discover/fields.ts";
import { DASH } from "../discover/format.ts";
import { aboutView, holdersSummary, holderViews, tapeViews, useHolders } from "./lower.ts";
import { W } from "./TokenPage.tsx";
import type { Tape } from "./trades.ts";
import { supplyOf } from "./units.ts";
import "./lower.css";

type Tab = "trades" | "holders";

/** The clock the trades' ages are drawn against, ticking each second while the tab is open. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Skeleton rows the height of the list's own rows, while its first read is out. */
const Skel = ({ n }: { n: number }) => (
  <div className="tkl-skel" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => <span key={i} className="tkp-sk" />)}
  </div>
);

const Empty = () => <div className="tkl-empty" data-testid="lower-empty"><W id="noData" /></div>;

const Creator = () => <span className="tkl-tag"><W id="creatorTag" /></span>;

function Trades({ row, tape, phone, nowMs }: { row: MarketRow; tape: Tape; phone: boolean; nowMs: number }) {
  if (tape.status === "loading") return <Skel n={8} />;
  const rows = tapeViews(tape.trades, { supply: supplyOf(row), creator: row.creator ?? null, nowMs });
  return (
    <div className="tkl-body">
      <div className="tkl-thead tkl-tr" data-testid="trades-heads">
        <span data-col="age"><W id="colAge" /></span>
        <span data-col="type">{phone ? <W id="colBs" /> : <W id="colType" />}</span>
        {!phone && <span data-col="mc"><W id="mc" /></span>}
        {!phone && <span data-col="amount"><W id="colAmount" /></span>}
        <span data-col="total"><W id="colTotal" /></span>
        <span data-col="trader"><W id="colTrader" /></span>
      </div>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="tkl-list" data-testid="lower-rows-trades">
          {rows.map((t) => (
            <div key={t.key} className="tkl-trow tkl-tr" data-testid="lower-row" data-side={t.side}>
              <span className="tkl-c tkl-dim" data-col="age">{t.age}</span>
              <span className="tkl-c tkl-side" data-col="type">{phone ? <W id={t.side === "buy" ? "buyShort" : "sellShort"} /> : <W id={t.side} />}</span>
              {!phone && <span className="tkl-c" data-col="mc">{t.mc}</span>}
              {!phone && <span className="tkl-c" data-col="amount">{t.amount}</span>}
              <span className="tkl-total" data-col="total">
                <span className="tkl-bar" style={{ width: `${t.width}%` }} />
                <span className="tkl-c tkl-side">{t.total}</span>
              </span>
              <span className="tkl-who" data-col="trader">
                <span className="tkl-c tkl-addr" title={t.trader ?? undefined} data-testid="row-wallet">{t.trader ?? DASH}</span>
                {t.creator && <Creator />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Holders({ row, decimals, top, state }: { row: MarketRow; decimals: number | null; top: string; state: ReturnType<typeof useHolders> }) {
  if (state.status === "loading") return <Skel n={8} />;
  const rows = state.status === "ready" ? holderViews(state.read.holders, { decimals, priceUsd: row.price_usd, creator: row.creator ?? null }) : [];
  return (
    <div className="tkl-body">
      <div className="tkl-sum" data-testid="holders-top">
        <span className="tkl-sumlbl"><W id="top10" /></span>
        <span className="tkl-sumval">{top}</span>
      </div>
      <div className="tkl-thead tkl-hr" data-testid="lower-heads">
        <span><W id="colTrader" /></span>
        <span><W id="colPosition" /></span>
        <span><W id="colShare" /></span>
      </div>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="tkl-list" data-testid="lower-rows-holders">
          {rows.map((h) => (
            <div key={h.addr} className="tkl-hrow tkl-hr" data-testid="lower-row" data-burn={h.burn || undefined}>
              <div className="tkl-trader">
                <div className="tkl-namerow">
                  <span className="tkl-name" title={h.addr} data-testid="row-wallet">{h.addr}</span>
                  {h.creator && <Creator />}
                </div>
                {h.burn && <span className="tkl-sub"><W id="burnSub" /></span>}
              </div>
              <div className="tkl-cell">
                <span className="tkl-v">{h.usd}</span>
                <span className="tkl-vs">{h.amount} {row.symbol}</span>
              </div>
              <div className="tkl-share">
                <div className="tkl-track"><div className="tkl-fill" data-creator={h.creator || undefined} style={{ width: `${h.width}%` }} /></div>
                <span className="tkl-pct" data-testid="row-share">{h.share}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The lower panel: `row` null while the token read is out (skeleton rows under the tabs). */
export function LowerPanel({ row, decimals, tape, phone = false }: { row: MarketRow | null; decimals: number | null; tape: Tape; phone?: boolean }) {
  const [tab, setTab] = useState<Tab>("trades");
  const holders = useHolders(row?.chain ?? null, row?.token ?? null, tab === "holders");
  const nowMs = useNow(tab === "trades" && tape.trades.length > 0);
  const sum = row ? holdersSummary(holders.status === "ready" ? holders.read : null, row) : null;
  const tabBtn = (k: Tab) => (
    <button key={k} type="button" role="tab" className="tkl-tab" aria-selected={tab === k} data-testid={`lower-tab-${k}`} onClick={() => setTab(k)}>
      {k === "trades" ? (
        <W id="trades" />
      ) : (
        <>
          <W id="holders" />
          {/* the count's slot is drawn at its widest (lower.css .tkl-tabn) from the first paint, empty until the row
              lands, so the tab after it never moves when the count arrives (BAR-10 CLS 0) */}
          <span className="tkl-tabn" data-testid="lower-tab-count">{sum ? (phone ? sum.count : `(${sum.count})`) : ""}</span>
        </>
      )}
    </button>
  );
  return (
    <section className="tkl" data-testid="lower-panel" data-tab={tab} data-phone={phone || undefined}>
      <div className="tkl-tabs" role="tablist" data-testid="lower-tabs">
        {(phone ? (["trades", "holders"] as const) : (["holders", "trades"] as const)).map(tabBtn)}
      </div>
      {row === null ? <Skel n={8} /> : tab === "trades" ? <Trades row={row} tape={tape} phone={phone} nowMs={nowMs} /> : <Holders row={row} decimals={decimals} top={sum!.top} state={holders} />}
    </section>
  );
}

/** About (R5 U.about): the four change windows, the 5m tiles and the 24h buys and sells as a flow bar. */
export function About({ row }: { row: MarketRow }) {
  const a = aboutView(row);
  const five = [
    ["vol5m", a.five.vol, "none"],
    ["buys5m", a.five.buys, "acc"],
    ["sells5m", a.five.sells, "sell"],
    ["net5m", a.five.net, a.five.netTone],
  ] as const;
  return (
    <section className="tkl-about" data-testid="ticket-about">
      <div className="tkl-ahead">
        <span title={row.symbol}><W id="about" /> {row.symbol}</span>
      </div>
      <div className="tkl-changes" data-testid="about-windows">
        {a.windows.map((w) => (
          <div key={w.id} className="tkl-change" data-tone={w.tone}>
            <span>{w.id}</span>
            <span>{w.text}</span>
          </div>
        ))}
      </div>
      <div className="tkl-changes" data-testid="about-5m">
        {five.map(([k, v, tone]) => (
          <div key={k} className="tkl-change tkl-five" data-tone={v === DASH ? "none" : tone}>
            <span><W id={k} /></span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <div className="tkl-flow" data-testid="about-flow">
        <div>
          <span><span className="tkl-mono">{a.flow.buys}</span> <span className="tkl-flowlbl"><W id="flowBuys" /></span></span>
          <span><span className="tkl-mono">{a.flow.sells}</span> <span className="tkl-flowlbl"><W id="flowSells" /></span></span>
        </div>
        <div className="tkl-flowbar" data-unknown={a.flow.buyPct === null}>
          <div style={{ width: `${a.flow.buyPct ?? 50}%` }} />
          <div />
        </div>
      </div>
    </section>
  );
}
