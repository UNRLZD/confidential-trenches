import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Chain } from "@blindfill/kit";
import { headerModel } from "../signin/model.ts";
import { useSigninSheet } from "../signin/source.tsx";
import {
  amountOk,
  amountWrong,
  busy,
  centsToDecimal,
  fmtUsd,
  outcome,
  parseUsd,
  poolBuyAsk,
  poolView,
  PRESETS,
  proofStatus,
  presetOn,
  progress,
  READY,
  setMatches,
  tap,
} from "./model.ts";
import type { Cents, Phase } from "./model.ts";
import { EndLine, hasRunLabel, RunLabel, stateId } from "./States.tsx";
import { useTradeSource } from "./source.tsx";
import type { SetPreview } from "./source.tsx";
import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";
import "./trade.css";

// S8 the trade box, the buy side (A2.3, app.md:1448 at research; 09-design-brief S8 "Desktop (1440), the trade
// column"), drawn after R5's ticket (design/proto at design-lock-r5: assets/token.js U.ticket, trenches-1440.html's
// ticket; unrlzd.css .tk-*): the side switch, the order tabs with `Bal`, the amount box, the four presets that buy on one
// click, `You receive`, the max line, the main button and the Route & fees and settings line. States: S8.3 Ready,
// S8.9 Sending, S8.10 Landing, S8.11 Slow, S8.12 Filled, and a buy the kit ended (States.tsx): S8.23 Failed, S8.24 Not
// landed, each with Retry, and part filled, with the ready label back. Seams for the next cards: Sell, Limit and TP/SL
// are drawn off; Route & fees opens on its own card. Signed out (S8.1, card app-trade-box-mount): `Bal —`, the exit plan
// block off, the main button `Sign in to trade` (and a preset) opens the sign-in sheet. No dialog, no confirm, ever.

/** A word, marked when it is still the owner's draft. */
function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}

const Bolt = () => (
  <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><path d="M6 0L0 7h4l-1 5 7-7.5H6z" /></svg>
);
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

/** A token amount as drawn: grouped to 4 digits, then K, M, B with up to two decimals ("1.2M", "843.5K"). */
export function fmtOut(dec: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(dec);
  if (!m) return "—";
  const int = m[1]!.replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  const steps: [number, string][] = [[9, "B"], [6, "M"], [3, "K"]];
  for (const [n, u] of steps)
    if (int.length > n + (n === 3 ? 1 : 0)) {
      const whole = int.slice(0, int.length - n);
      const part = int.slice(int.length - n, int.length - n + 2).replace(/0+$/, "");
      return `${whole}${part ? `.${part}` : ""}${u}`;
    }
  return frac ? `${int}.${frac.slice(0, 2)}` : int;
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** The amount box takes digits and one point with up to two decimals: USD cents, nothing finer. */
const TYPING = /^\d{0,15}(?:\.\d{0,2})?$/;

/** `footer` draws inside the panel, under the Route & fees line (the token page's safety grid). */
export function TradeBox({ chain, token, symbol, slippageBps = 1000, initialAmount = "", footer }: { chain: Chain; token: string; symbol: string; slippageBps?: number; initialAmount?: string; footer?: ReactNode }) {
  const src = useTradeSource();
  const { kit, moneyOn, snapshot } = src;
  // signed out as the header reads it (never for a user whose first `state` has not landed): Sign in opens the one sheet
  const account = headerModel(snapshot).kind;
  const signedOut = account === "out";
  const { setOpen: openSignin } = useSigninSheet();
  const [text, setText] = useState(initialAmount);
  const [phase, setPhase] = useState<Phase>(READY);
  const phaseRef = useRef<Phase>(READY);
  phaseRef.current = phase;
  const [preview, setPreview] = useState<{ amount: Cents; p: SetPreview } | null>(null);
  const [, tick] = useState(0);

  const amount = text === "" ? null : parseUsd(text);
  // the pool path (card trade-box-pool): a chain whose pool the signing page reports buys from it, one proof a tap; Bal
  // is the pool's balance and Max the most one tap can spend, in USD at the device's price. Other chains keep the vault.
  const pools = signedOut ? undefined : snapshot.state?.pools;
  const onPool = !!pools?.some((p) => p.chain === chain);
  const price = onPool ? kit.poolPrice(chain) : null;
  const pool = onPool ? poolView(pools, chain, price) : null;
  // the proof's state reads state.pools alone: it draws with no price
  const proof = onPool ? proofStatus(pools, chain) : "none";
  // signed out there is no balance to show: the signing page sends a state with a zero one, which is not "$0" of anyone's
  const balance = onPool ? (pool?.balance ?? null) : snapshot.state && !signedOut ? parseUsd(snapshot.state.vault_balance) : null;
  const maxText = onPool ? null : kit.maxBuy(chain);
  const max = onPool ? (pool?.tapMax ?? null) : maxText === null ? null : parseUsd(maxText);
  const askable = (c: Cents | null) => c !== null && (!onPool || poolBuyAsk(pools, chain, token, c, price, slippageBps).ok);
  const running = busy(phase);

  // the set preview for the amount in the box; a change asks again and the last numbers stay, dimmed, until it answers
  useEffect(() => {
    if (!kit.setPreview || amount === null || amount <= 0n) return;
    let live = true;
    kit.setPreview({ chain, token, amount: centsToDecimal(amount), slippage_bps: slippageBps }).then(
      (a) => live && setPreview(a.ok ? { amount, p: a.preview } : null),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [kit.setPreview, chain, token, amount, slippageBps]);

  // the kit's stages for the running buy
  useEffect(() => {
    if (!kit.onProgress) return;
    // the time is read when the stage arrives, not when React renders it: a late render must not stretch Filled's time
    return kit.onProgress((id, stage) => {
      const at = src.now();
      setPhase((p) => progress(p, id, stage, at));
    });
  }, [kit.onProgress, src.now]);

  // Landing's counter and Slow: a tick every 100 ms while a buy runs, none otherwise
  useEffect(() => {
    if (!busy(phase)) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [phase.k]);

  const ready = moneyOn && kit.request !== null && max !== null && balance !== null;

  function buy(c: Cents) {
    if (!ready || busy(phaseRef.current) || !amountOk(c, max, balance)) return;
    let h;
    if (onPool) {
      // only an ask the box's own checks passed: a proof ready, at most one tap's spend, the device's price
      const ask = poolBuyAsk(pools, chain, token, c, price, slippageBps);
      if (!ask.ok) return;
      h = kit.request!(ask.kind, ask.params);
    } else h = kit.request!("buy", { chain, token, side: "buy", amount: centsToDecimal(c), slippage_bps: slippageBps });
    const next = tap(phaseRef.current, h.id, src.now());
    phaseRef.current = next;
    setPhase(next);
    void h.outcome.then((o) => {
      const at = src.now();
      setPhase((p) => outcome(p, h.id, o, at));
    });
  }

  const shown = preview && amount !== null && preview.amount === amount && setMatches(preview.p.slices, amount) ? preview.p : null;
  const last = preview?.p ?? null;
  const pending = shown === null && last !== null;
  const est = (shown ?? last) ? `≈ ${fmtOut((shown ?? last)!.out)} ${symbol}` : "—";
  const now = src.now();
  const state = signedOut ? "S8.1" : (stateId(phase, now, "buy") ?? "S8.3");
  const canBuy = ready && !running && amountOk(amount, max, balance) && askable(amount);

  let label;
  if (signedOut) label = <W id="signInToTrade" />;
  else if (account === "loading") label = "\u00a0"; // the header's skeleton state: no word until the first `state` says which
  else if (hasRunLabel(phase)) label = <RunLabel phase={phase} now={now} />;
  else
    label = (
      <span className="trb-ctaLbl" title={`${WORDS.buy.text} ${symbol}`}>
        <W id="buy" /> {symbol}
      </span>
    );

  return (
    <div
      className="trb tk-panel"
      data-state={state}
      data-stage={phase.k === "ended" ? phase.stage : undefined}
      data-set={shown ? shown.slices.map((s) => s.usd).join("+") : undefined}
      data-path={onPool ? "pool" : "vault"}
      data-testid="trade-box"
    >
      <div className="trb-sides">
        <button type="button" className="trb-side" data-on="buy" aria-pressed="true"><W id="buy" /></button>
        <button type="button" className="trb-side" aria-pressed="false" disabled><W id="sell" /></button>
      </div>
      <div className="trb-ot">
        <div className="trb-tabs" role="tablist">
          <button type="button" role="tab" className="trb-tab" aria-selected="true"><W id="market" /></button>
          <button type="button" role="tab" className="trb-tab" aria-selected="false" disabled><W id="limit" /></button>
          <button type="button" role="tab" className="trb-tab" aria-selected="false" disabled><W id="tpsl" /></button>
        </div>
        <span className="trb-avail" data-testid="trade-balance">
          {WORDS.bal.text} {balance === null ? "—" : fmtUsd(balance)}
        </span>
      </div>
      <label className="trb-amount" data-bad={!signedOut && amount !== null && amount > 0n && (onPool ? amountWrong(poolBuyAsk(pools, chain, token, amount, price, slippageBps)) : !amountOk(amount, max, balance))}>
        <input
          className="trb-input"
          value={text}
          placeholder="0"
          inputMode="decimal"
          autoComplete="off"
          aria-label={WORDS.amountLabel.text}
          disabled={running}
          onChange={(e) => TYPING.test(e.target.value) && setText(e.target.value)}
        />
        <span className="trb-unit">
          <span>{WORDS.usd.text}</span>
          <span data-pending={pending || undefined}>{est}</span>
        </span>
      </label>
      <div className="trb-presets" data-testid="trade-presets">
        {PRESETS.map((p) => (
          <button
            key={String(p)}
            type="button"
            className="trb-preset"
            data-preset={centsToDecimal(p)}
            data-on={amount === p || undefined}
            disabled={!signedOut && (!ready || !presetOn(p, max, balance, running) || !askable(p))}
            onClick={() => {
              if (signedOut) return openSignin(true);
              setText(String(p / 100n));
              buy(p);
            }}
          >
            <Bolt />
            {fmtUsd(p)}
          </button>
        ))}
      </div>
      <div className="trb-exit" data-testid="trade-exit" data-on="false">
        <div className="trb-exitText">
          <span><W id="exitPlan" /></span>
          <span><W id="exitPlanSub" /></span>
        </div>
        <button type="button" className="trb-toggle" data-on="false" aria-pressed="false" aria-label={WORDS.exitPlan.text} disabled />
      </div>
      <div className="trb-receive">
        <span><W id="receive" /></span>
        <span data-pending={pending || undefined} data-testid="trade-receive">{est}</span>
      </div>
      <div className="trb-warn" data-testid="trade-max">
        {phase.k === "ended" ? (
          <EndLine phase={phase} side="buy" part={kit.part?.(phase.id) ?? null} />
        ) : (
          <>
            {proof !== "none" && (
              <span className="trb-proof" data-proof={proof} data-testid="trade-proof">
                <W id={proof === "ready" ? "proofReady" : "proofMaking"} />
              </span>
            )}
            {max !== null && (
              <span>
                <W id="max" /> {fmtUsd(max)}
              </span>
            )}
          </>
        )}
      </div>
      <button
        type="button"
        className="trb-cta"
        data-tone="buy"
        data-kind={signedOut ? "setup" : running ? "live" : "trade"}
        disabled={!signedOut && !canBuy && !running}
        aria-disabled={running || undefined}
        data-testid="trade-cta"
        onClick={() => (signedOut ? openSignin(true) : amount !== null && buy(amount))}
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
          <span className="trb-pair" title={WORDS.slippage.text}><Sliders /><span data-testid="trade-slippage">≤{pct(slippageBps)}</span></span>
          <span className="trb-pair" title={WORDS.network.text}><Flame /><span data-testid="trade-network">{(shown ?? last) ? fmtUsd(parseUsd((shown ?? last)!.network_usd) ?? 0n) : "—"}</span></span>
          <span className="trb-pair" title={WORDS.fee.text}><Coins /><span data-testid="trade-fee">{(shown ?? last) ? pct((shown ?? last)!.fee_bps) : "—"}</span></span>
        </div>
      </div>
      {footer}
    </div>
  );
}
