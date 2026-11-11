import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cents, units, usd } from "../portfolio/model.ts";
import type { Row } from "../portfolio/model.ts";
import { busy } from "../trade/model.ts";
import { EndLine, hasRunLabel, RunLabel, stateId } from "../trade/States.tsx";
import { BOX_PERCENTS, parsePercent, pctLabel, sellAmount, shareCents } from "./model.ts";
import { useSellKit } from "./source.tsx";
import type { Sell, SellPreview } from "./source.tsx";
import { OrderTabs, OrdersSoon } from "../trade/OrderTabs.tsx";
import type { OrderTab } from "../trade/OrderTabs.tsx";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import "../trade/trade.css";
import "./positions.css";

// S8 the trade box, the sell side (A2.4, app.md:1449 at research; 09-design-brief S8 "Sell tab", "Sell presets" and
// S8.29, S8.30), drawn after R5's ticket at S8.29 (design/proto at design-lock-r5: assets/token.js U.ticket with
// side "sell", trenches-1440.html's ticket: `1.2M SYM held`, the percent in the amount box with the share's value under
// it, `25%` `50%` `75%` `100%`, `You receive`, `Sell 50%`), in the buy side's own classes (src/screens/trade/trade.css)
// with the sell's coral. A preset sells on one click; the box's percent sells on the main button. The button's states
// are the buy side's (src/screens/trade/States.tsx: S8.30 Sending and Landing, S8.11 Slow, Filled, and for a sell
// the kit ended S8.32 Failed or S8.36 Not landed with Retry, S8.35 part sold with the ready label), run by `useSell`,
// one request for a double tap. The side switch's Buy goes to the mount (the buy side is TradeBox). No route (S8.33)
// turns the sell off. No dialog, no confirm.

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** How long the share in the box holds still before its preview is asked: a typed "50" asks once, not for "5" too. */
export const PREVIEW_SETTLE_MS = 250;
/** A "not now" preview answer (the signing page's RETRY_CODES) is asked again once, this long after. */
export const PREVIEW_AGAIN_MS = 3_000;
const NOT_NOW: ReadonlySet<string> = new Set(["busy", "down"]);

/** The amount box takes a percent: digits and one point with up to two decimals, at most 100. */
const TYPING = /^\d{0,3}(?:\.\d{0,2})?$/;

const Swap = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5v11M4 13.5l-2.5-2.5M4 13.5l2.5-2.5M12 13.5v-11M12 2.5l-2.5 2.5M12 2.5l2.5 2.5" /></svg>
);
const Chev = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
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

/** `footer` draws inside the panel under the Route & fees line, as the buy side's does (the token page's safety grid). */
/** A percent is a share of the row's own units at the row's decimals, the signing page's (positions/model.ts sellAmount),
 *  never the helper's token read: a sell's amount is never sized on a server's word (card app-sell-mount re-check 2). */
export function SellBox({ row, s, slippageBps = 1000, initialPercent = "50", onBuy, footer }: { row: Row; s: Sell; slippageBps?: number; initialPercent?: string; onBuy?: () => void; footer?: ReactNode }) {
  const decimals = row.decimals;
  const kit = useSellKit();
  const [text, setText] = useState(initialPercent);
  // the last answer and the amount it was for: a preview, or none (the page refused, or its reads could not be had)
  const [preview, setPreview] = useState<{ amount: string; p: SellPreview | null } | null>(null);
  const [tab, setTab] = useState<OrderTab>("market");

  const bps = parsePercent(text);
  const noRoute = row.mark === "noRoute";
  const amount = bps === null ? null : sellAmount(row.units, bps, decimals);
  const running = busy(s.phase);
  const canSell = s.ready && !running && !noRoute && amount !== null;

  // the sell preview for the share in the box: asked at once when the box opens, then once a changed share has settled
  // (PREVIEW_SETTLE_MS: one ask per typed percent, never per key); the last numbers stay, dimmed, until a change
  // answers. A "not now"
  // answer (busy: a trade runs or the page's preview budget is spent; down) is asked again once, PREVIEW_AGAIN_MS later
  const sellPreview = kit.sellPreview;
  const asked = useRef(false);
  useEffect(() => {
    if (!sellPreview || amount === null || bps === null) return;
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const ask = (again: boolean): void =>
      void sellPreview({ chain: row.chain, token: row.token, amount, share_bps: bps, slippage_bps: slippageBps }).then(
        (a) => {
          if (!live) return;
          if (!a.ok && again && NOT_NOW.has(a.code)) t = setTimeout(() => ask(false), PREVIEW_AGAIN_MS);
          else setPreview({ amount, p: a.ok ? a.preview : null });
        },
        () => live && setPreview({ amount, p: null }),
      );
    t = setTimeout(() => ((asked.current = true), ask(true)), asked.current ? PREVIEW_SETTLE_MS : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sellPreview, row.chain, row.token, amount, bps, slippageBps]);

  // a sell started from Your position's quick sells shows its percent here, so the box never names another share
  useEffect(() => {
    if (s.phase.k === "sending" && s.bps !== null) setText(pctLabel(s.bps).slice(0, -1));
  }, [s.phase.k, s.bps]);

  function sellAt(b: number) {
    if (!canSellAt(b)) return;
    s.sell(sellAmount(row.units, b, decimals), b, decimals);
  }
  const canSellAt = (b: number) => s.ready && !running && !noRoute && sellAmount(row.units, b, decimals) !== null;

  // a dash only before the first answer; Unavailable once the newest answer is none (the trade box's word), a "not now"
  // answer (busy, down) asked again once first
  const shown = preview && preview.amount === amount ? preview.p : null;
  const last = preview?.p ?? null;
  const pending = preview !== null && preview.amount !== amount;
  const none = preview !== null && preview.p === null;
  const p = shown ?? last;
  const outC = p ? cents(p.out_usd) : null;
  const dash = (v: ReactNode): ReactNode => (none ? <W id="unavailable" /> : v);
  const share = bps === null ? null : shareCents(row.value, bps);
  const now = s.now();
  const state = stateId(s.phase, now, "sell") ?? (noRoute ? "S8.33" : "S8.29");

  let label;
  if (hasRunLabel(s.phase)) label = <RunLabel phase={s.phase} now={now} />;
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
        <OrderTabs tab={tab} setTab={setTab} running={running} W={W} />
        <span className="trb-avail" data-testid="sell-held">
          {units(row.units)} {row.symbol} <W id="held" />
        </span>
      </div>
      {tab !== "market" && <OrdersSoon place={tab === "limit" ? "sell-limit" : "sell-tpsl"} W={W} />}
      {tab === "market" && (<>
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
        <span data-pending={pending || undefined} data-none={none || undefined} data-testid="sell-receive">{dash(outC === null ? "—" : `≈ ${usd(outC)}`)}</span>
      </div>
      <div className="trb-warn" data-testid="sell-line">
        {s.phase.k === "ended" ? (
          <EndLine phase={s.phase} side="sell" part={s.part} />
        ) : (
          s.pool && (
            <span className="trb-toPool" data-testid="sell-to-pool">
              <W id="toPool" />
            </span>
          )
        )}
      </div>
      <button
        type="button"
        className="trb-cta"
        data-tone="sell"
        data-kind={running ? "live" : "trade"}
        disabled={!canSell && !running}
        aria-disabled={running || undefined}
        data-testid="sell-cta"
        onClick={() => bps !== null && canSell && s.sell(amount, bps, decimals)}
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
          {/* no preview to be had: You receive says so once; Network and Fee have no number to draw */}
          {none ? null : (
            <>
              <span className="trb-pair" title={WORDS.network.text}><Flame /><span data-testid="sell-network">{p ? usd(cents(p.network_usd) ?? 0n) : "—"}</span></span>
              <span className="trb-pair" title={WORDS.fee.text}><Coins /><span data-testid="sell-fee">{p ? pct(p.fee_bps) : "—"}</span></span>
            </>
          )}
        </div>
      </div>
      </>)}
      {footer}
    </div>
  );
}
