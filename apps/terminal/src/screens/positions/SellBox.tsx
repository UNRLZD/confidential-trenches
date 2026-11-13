import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cents, shareOf, units, usd } from "../portfolio/model.ts";
import type { Row } from "../portfolio/model.ts";
import { busy, unavailable } from "../trade/model.ts";
import { EndLine, hasRunLabel, RunLabel, stateId } from "../trade/States.tsx";
import { BOX_PERCENTS, parsePercent, pctLabel, sellAmount } from "./model.ts";
import { useSellKit } from "./source.tsx";
import type { Sell, SellPreview } from "./source.tsx";
import { OrderTabs, OrdersSoon } from "../trade/OrderTabs.tsx";
import { RouteStrip } from "../trade/RouteStrip.tsx";
import type { Logo } from "../market/Avatar.tsx";
import type { OrderTab } from "../trade/OrderTabs.tsx";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import "../trade/trade.css";
import "./positions.css";

// S8 the trade box, the sell side (A2.4, app.md:1449 at research; 09-design-brief S8 "Sell tab", "Sell presets" and
// S8.29, S8.30), drawn after R5's ticket at S8.29 (design/proto at design-lock-r5: assets/token.js U.ticket with
// side "sell", trenches-1440.html's ticket: `1.2M SYM held`, the percent in the amount box with the share's value under
// it, `25%` `50%` `75%` `100%`, `You receive`, `Sell 50%`), in the buy side's own classes (src/screens/trade/trade.css)
// with the sell's coral. A preset only picks the share (card sell-box-works-like-the-buy-box, owner 13 Nov 18:11Z: "these
// button are to choose"); the main button sells it, once. A running sell draws the buy's flow reversed (RouteStrip.tsx):
// the coin, its one-time wallet, the pool, Private balance. The button's states
// are the buy side's (src/screens/trade/States.tsx: S8.30 Sending and Landing, S8.11 Slow, Filled, and for a sell
// the kit ended S8.32 Failed or S8.36 Not landed with Retry, S8.35 part sold with the ready label), run by `useSell`,
// one request for a double tap. The side switch's Buy goes to the mount (the buy side is TradeBox). No route (S8.33)
// turns the sell off. No dialog, no confirm.

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** How long the share in the box holds still before its preview is asked: a typed "50" asks once, not for "5" too. */
export const PREVIEW_SETTLE_MS = 250;
/** A "down" preview answer (a provider failed: the page's next ask reads again) is asked again once, this long after. */
export const PREVIEW_AGAIN_MS = 3_000;
/** A busy answer (a trade runs on the page, or its preview budget is spent), or not_funded while the box shows a holding
 *  (the page's own read of a just-filled buy not in yet), is asked again this often, as long as the box shows that
 *  holding and no sale runs: the page answers either before it asks any provider (src/pool-sell-dry.ts), so a re-ask
 *  costs no read, and the number comes within about a second of the page having it (devnet runs 11 and 12, 11 Nov). */
export const PREVIEW_BUSY_MS = 1_000;
const NOT_NOW: ReadonlySet<string> = new Set(["busy", "down"]);
const NOT_YET: ReadonlySet<string> = new Set(["busy", "not_funded"]);
/** A share's last number is shown again for a "not now" answer this long after it came, so a shown number never flips
 *  to a dash and back while the page is busy. */
export const PREVIEW_KEEP_MS = 10_000;

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
/** `logo` whose logo the flow's coin step draws (the token page's own read); none draws the symbol's letters. */
export function SellBox({ row, s, slippageBps = 1000, initialPercent = "50", onBuy, footer, logo }: { row: Row; s: Sell; slippageBps?: number; initialPercent?: string; onBuy?: () => void; footer?: ReactNode; logo?: Logo }) {
  const decimals = row.decimals;
  const kit = useSellKit();
  // NEAR sells the whole holding only (s.takes): its box opens at 100%, and its amount box holds it there
  const whole = !s.takes(5_000);
  const [text, setText] = useState(whole ? "100" : initialPercent);
  // the last answer and the amount it was for: a preview, or none (a dash: the page refused, or its reads could not be had)
  const [preview, setPreview] = useState<{ amount: string; p: SellPreview | null } | null>(null);
  // each share's last number, by token and amount, with when it came (PREVIEW_KEEP_MS)
  const recent = useRef(new Map<string, { p: SellPreview; at: number }>());
  const [tab, setTab] = useState<OrderTab>("market");

  const bps = parsePercent(text);
  const noRoute = row.mark === "noRoute";
  const amount = bps === null ? null : sellAmount(row.units, bps, decimals);
  const running = busy(s.phase);
  // the pool cannot sell this token (model.ts unavailable: the same sale would be refused again): Sell and its presets
  // stay off, as the buy side's
  const off = unavailable(s.phase);
  const canSell = s.ready && !running && !off && !noRoute && amount !== null && bps !== null && s.takes(bps);

  // the sell preview for the share in the box: asked at once when the box opens, then once a changed share has settled
  // (PREVIEW_SETTLE_MS: one ask per typed percent, never per key); the last numbers stay, dimmed, until a change
  // answers. Nothing is asked while a sale runs (its tap fixed what it sells; the last number stays, dimmed). A busy or
  // not_funded answer is asked again every PREVIEW_BUSY_MS while the box shows the holding; a down answer once,
  // PREVIEW_AGAIN_MS later. A first "not now" leaves what shows; after it, the share's own number from the last
  // PREVIEW_KEEP_MS shows, else the dash
  const sellPreview = kit.sellPreview;
  const asked = useRef(false);
  useEffect(() => {
    if (!sellPreview || amount === null || bps === null || running) return;
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    let downs = 0;
    const ask = (first: boolean): void =>
      void sellPreview({ chain: row.chain, token: row.token, amount, share_bps: bps, slippage_bps: slippageBps }).then(
        (a) => {
          if (!live) return;
          const key = `${row.token}|${amount}`;
          if (a.ok) {
            recent.current.set(key, { p: a.preview, at: s.now() });
            setPreview({ amount, p: a.preview });
            return;
          }
          const again = NOT_YET.has(a.code) ? PREVIEW_BUSY_MS : a.code === "down" && downs++ === 0 ? PREVIEW_AGAIN_MS : null;
          if (again !== null) t = setTimeout(() => ask(false), again);
          if (first && (NOT_NOW.has(a.code) || a.code === "not_funded")) return;
          const kept = NOT_NOW.has(a.code) ? recent.current.get(key) : undefined;
          setPreview({ amount, p: kept && s.now() - kept.at <= PREVIEW_KEEP_MS ? kept.p : null });
        },
        () => live && setPreview({ amount, p: null }),
      );
    t = setTimeout(() => ((asked.current = true), ask(true)), asked.current ? PREVIEW_SETTLE_MS : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sellPreview, row.chain, row.token, amount, bps, slippageBps, running]);

  // a sell started from Your position's quick sells shows its percent here, so the box never names another share
  useEffect(() => {
    if (s.phase.k === "sending" && s.bps !== null) setText(pctLabel(s.bps).slice(0, -1));
  }, [s.phase.k, s.bps]);

  const canSellAt = (b: number) => s.ready && !running && !off && !noRoute && s.takes(b) && sellAmount(row.units, b, decimals) !== null;

  const shown = preview && preview.amount === amount ? preview.p : null;
  const last = preview?.p ?? null;
  const pending = last !== null && (shown === null || running);
  const outC = (shown ?? last) ? cents((shown ?? last)!.out_usd) : null;
  const share = bps === null ? null : shareOf(row, bps);
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
          readOnly={whole}
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
            onClick={() => setText(String(b / 100))}
          >
            {pctLabel(b)}
          </button>
        ))}
      </div>
      <div className="trb-receive">
        <span><W id="receive" /></span>
        <span data-pending={pending || undefined} data-testid="sell-receive">{outC === null ? "—" : `≈ ${usd(outC)}`}</span>
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
        onClick={() => bps !== null && canSell && s.sell(amount, bps, decimals, shown ? cents(shown.out_usd) : null)}
      >
        {label}
      </button>
      <RouteStrip route={s.route} symbol={row.symbol} outText={s.route.sold === null ? null : units(s.route.sold)} {...(logo ? { logo } : {})} />
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
      </>)}
      {footer}
    </div>
  );
}
