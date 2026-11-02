import { useEffect, useState } from "react";
import { cents, units, usd } from "../portfolio/model.ts";
import type { Row } from "../portfolio/model.ts";
import { busy, buttonTime } from "../trade/model.ts";
import { BOX_PERCENTS, parsePercent, pctLabel, sellAmount, shareCents } from "./model.ts";
import { useSellKit } from "./source.tsx";
import type { Sell, SellPreview } from "./source.tsx";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import "../trade/trade.css";
import "./positions.css";

// S8 the trade box, the sell side (A2.4, app.md:1449 at research; 09-design-brief S8 "Sell tab", "Sell presets" and
// S8.29, S8.30), drawn after R5's ticket at S8.29 (design/proto at design-lock-r5: assets/token.js U.ticket with
// side "sell", trenches-1440.html's ticket: `1.2M SYM held`, the percent in the amount box with the share's value under
// it, `25%` `50%` `75%` `100%`, `You receive`, `Sell 50%`), in the buy side's own classes (src/screens/trade/trade.css)
// with the sell's coral. A preset sells on one click; the box's percent sells on the main button. The button's states
// are the buy side's (S8.30: Sending, Landing, then Filled), run by `useSell`, one request for a double tap. The side
// switch's Buy goes to the mount (the buy side is TradeBox). No route (S8.33) turns the sell off. No dialog, no confirm.

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** The amount box takes a percent: digits and one point with up to two decimals, at most 100. */
const TYPING = /^\d{0,3}(?:\.\d{0,2})?$/;

const Swap = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5v11M4 13.5l-2.5-2.5M4 13.5l2.5-2.5M12 13.5v-11M12 2.5l-2.5 2.5M12 2.5l2.5 2.5" /></svg>
);
const Chev = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
);
const Check = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);
const Sliders = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12" /><circle cx="10" cy="4.5" r="1.6" fill="var(--bg-raised)" /><circle cx="6" cy="11.5" r="1.6" fill="var(--bg-raised)" /></svg>
);
const Flame = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.5c.5 2.5 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4 0 1.5.8 2.3 1.5 2.5C7 6 7.3 3.5 8 1.5z" /></svg>
);
const Coins = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><ellipse cx="6.5" cy="5" rx="4.5" ry="2.5" /><path d="M2 5v3c0 1.4 2 2.5 4.5 2.5M11 5v1" /><ellipse cx="10" cy="10.5" rx="4" ry="2.2" /></svg>
);

export function SellBox({ row, s, slippageBps = 1000, initialPercent = "50", onBuy }: { row: Row; s: Sell; slippageBps?: number; initialPercent?: string; onBuy?: () => void }) {
  const kit = useSellKit();
  const [text, setText] = useState(initialPercent);
  const [preview, setPreview] = useState<{ amount: string; p: SellPreview } | null>(null);

  const bps = parsePercent(text);
  const noRoute = row.mark === "noRoute";
  const amount = bps === null ? null : sellAmount(row.units, bps);
  const running = busy(s.phase);
  const canSell = s.ready && !running && !noRoute && amount !== null;

  // the sell preview for the share in the box; the last numbers stay, dimmed, until a change answers
  useEffect(() => {
    if (!kit.sellPreview || amount === null) return;
    let live = true;
    kit.sellPreview({ chain: row.chain, token: row.token, amount, slippage_bps: slippageBps }).then(
      (a) => live && setPreview(a.ok ? { amount, p: a.preview } : null),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [kit.sellPreview, row.chain, row.token, amount, slippageBps]);

  // a sell started from Your position's quick sells shows its percent here, so the box never names another share
  useEffect(() => {
    if (s.phase.k === "sending" && s.bps !== null) setText(pctLabel(s.bps).slice(0, -1));
  }, [s.phase.k, s.bps]);

  function sellAt(b: number) {
    if (!canSellAt(b)) return;
    s.sell(sellAmount(row.units, b), b);
  }
  const canSellAt = (b: number) => s.ready && !running && !noRoute && sellAmount(row.units, b) !== null;

  const shown = preview && preview.amount === amount ? preview.p : null;
  const last = preview?.p ?? null;
  const pending = shown === null && last !== null;
  const outC = (shown ?? last) ? cents((shown ?? last)!.out_usd) : null;
  const share = bps === null ? null : shareCents(row.value, bps);
  const state = s.phase.k === "sending" ? "S8.30" : s.phase.k === "landing" ? "S8.30" : s.phase.k === "filled" ? "filled" : s.phase.k === "ended" ? "ended" : noRoute ? "S8.33" : "S8.29";
  const time = buttonTime(s.phase, s.now());

  let label;
  if (s.phase.k === "sending") label = <W id="sending" />;
  else if (s.phase.k === "landing")
    label = (
      <>
        <W id="landing" />&nbsp;<span className="trb-live" data-time={time}>{time}</span>
      </>
    );
  else if (s.phase.k === "filled")
    label = (
      <>
        <Check />&nbsp;<W id="filled" />&nbsp;<span data-time={time}>{time}</span>
      </>
    );
  else if (noRoute) label = <W id="noRoute" />;
  else
    label = (
      <span className="trb-ctaLbl">
        <W id="sellCta" />
        {bps === null ? "" : ` ${pctLabel(bps)}`}
      </span>
    );

  return (
    <div className="trb tk-panel pos-sell" data-state={state} data-stage={s.phase.k === "ended" ? s.phase.stage : undefined} data-amount={amount ?? undefined} data-testid="sell-box">
      <div className="trb-sides">
        <button type="button" className="trb-side" aria-pressed="false" disabled={!onBuy || running} onClick={onBuy}><W id="buy" /></button>
        <button type="button" className="trb-side" data-on="sell" aria-pressed="true"><W id="sell" /></button>
      </div>
      <div className="trb-ot">
        <div className="trb-tabs" role="tablist">
          <button type="button" role="tab" className="trb-tab" aria-selected="true"><W id="market" /></button>
          <button type="button" role="tab" className="trb-tab" aria-selected="false" disabled><W id="limit" /></button>
          <button type="button" role="tab" className="trb-tab" aria-selected="false" disabled><W id="tpsl" /></button>
        </div>
        <span className="trb-avail" data-testid="sell-held">
          {units(row.units)} {row.symbol} <W id="held" />
        </span>
      </div>
      <label className="trb-amount" data-bad={text !== "" && bps === null}>
        <input
          className="trb-input"
          value={text}
          placeholder="0"
          inputMode="decimal"
          autoComplete="off"
          aria-label={WORDS.percent.text}
          disabled={running}
          onChange={(e) => TYPING.test(e.target.value) && setText(e.target.value)}
        />
        <span className="trb-unit">
          <span>%</span>
          <span data-testid="sell-share">{share === null ? "—" : `≈ ${usd(share)}`}</span>
        </span>
      </label>
      <div className="trb-presets" data-testid="sell-presets">
        {BOX_PERCENTS.map((b) => (
          <button
            key={b}
            type="button"
            className="trb-preset"
            data-pct={b}
            data-on={bps === b || undefined}
            disabled={!canSellAt(b)}
            onClick={() => {
              setText(String(b / 100));
              sellAt(b);
            }}
          >
            {pctLabel(b)}
          </button>
        ))}
      </div>
      <div className="trb-receive">
        <span><W id="receive" /></span>
        <span data-pending={pending || undefined} data-testid="sell-receive">{outC === null ? "—" : `≈ ${usd(outC)}`}</span>
      </div>
      <button
        type="button"
        className="trb-cta"
        data-tone="sell"
        data-kind={running ? "live" : "trade"}
        disabled={!canSell && !running}
        aria-disabled={running || undefined}
        data-testid="sell-cta"
        onClick={() => bps !== null && canSell && s.sell(amount, bps)}
      >
        {label}
      </button>
      <div className="trb-line">
        <button type="button" className="trb-row" aria-expanded="false" disabled>
          <Swap />
          <span className="trb-rowLbl"><W id="route" /></span>
          <span className="trb-chev"><Chev /></span>
        </button>
        <div className="trb-row trb-set" data-pending={pending || undefined}>
          <span className="trb-pair" title={WORDS.slippage.text}><Sliders /><span>≤{pct(slippageBps)}</span></span>
          <span className="trb-pair" title={WORDS.network.text}><Flame /><span data-testid="sell-network">{(shown ?? last) ? usd(cents((shown ?? last)!.network_usd) ?? 0n) : "—"}</span></span>
          <span className="trb-pair" title={WORDS.fee.text}><Coins /><span data-testid="sell-fee">{(shown ?? last) ? pct((shown ?? last)!.fee_bps) : "—"}</span></span>
        </div>
      </div>
    </div>
  );
}
