import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Chain } from "@blindfill/kit";
import type { Row } from "../portfolio/model.ts";
import { useBalance, useHeld } from "../portfolio/source.tsx";
import { SellBox } from "../positions/SellBox.tsx";
import { useSell } from "../positions/source.tsx";
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
  tradeBal,
  presetOn,
  progress,
  READY,
  setMatches,
  tap,
} from "./model.ts";
import type { Cents, Phase } from "./model.ts";
import { EndLine, hasRunLabel, RunLabel, stateId } from "./States.tsx";
import { FillToast, RouteStrip } from "./RouteStrip.tsx";
import { fromOutcome, fromStage, IDLE, routeEvent, routeTap, toastLine, usd2 } from "./route.ts";
import type { Route } from "./route.ts";
import { txLink } from "../withdraw/model.ts";
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
// landed, each with Retry, and part filled, with the ready label back. Seams for the next cards: Limit and TP/SL
// are drawn off; Route & fees opens on its own card. Signed out (S8.1, card app-trade-box-mount): `Bal —`, the exit plan
// block off, the main button `Sign in to trade` (and a preset) opens the sign-in sheet. No dialog, no confirm, ever.
// The Sell side (card app-sell-mount): the switch's Sell is on while the signing page's state holds a position of this
// token on this chain (Portfolio's own Row, heldOf) and draws the sell side (positions/SellBox.tsx) from the same trade
// state, whose sell (positions/source.tsx useSell) asks pool.sell on a chain with a pool: the request names the chain
// and the token amount only, and the signing page picks the note and checks the quote (and keeps a partial sell's
// deposit back over the pool's floor, card sol-sell-deposit-back-floor). Its states are States.tsx's, as the buy side's.

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

/** Which token a trade state trades; null while the page has no token yet (nothing is quoted or bought). */
export interface TradeAt {
  chain: Chain;
  token: string;
  slippageBps?: number;
}

/** One trade state: the amount, the running buy's phase and id, its route and toast, the set preview, and the buy. A page
 *  that draws the box in two places (the token page's desktop column and its phone sheet, card app-phone-trade-sheet)
 *  holds one of these and draws it in both, so a buy started in one is the buy the other draws, whichever is visible. */
export function useTrade(at: TradeAt | null, initialAmount = "") {
  const chain: Chain = at?.chain ?? "solana";
  const token = at?.token ?? "";
  const slippageBps = at?.slippageBps ?? 1000;
  const on = at !== null;
  const src = useTradeSource();
  const { kit, moneyOn, snapshot } = src;
  const { setOpen: openSignin } = useSigninSheet();
  // signed out as the header reads it (never for a user whose first `state` has not landed): Sign in opens the one sheet
  const account = headerModel(snapshot).kind;
  const signedOut = account === "out";
  const [text, setText] = useState(initialAmount);
  const [phase, setPhase] = useState<Phase>(READY);
  const phaseRef = useRef<Phase>(READY);
  phaseRef.current = phase;
  const [route, setRoute] = useState<Route>(IDLE);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ amount: Cents; p: SetPreview } | null>(null);
  const [, tick] = useState(0);
  // the Sell side: the position this token holds on this chain, and the sell of it; a sell that runs or has ended keeps
  // its box though its position has left the state (a 100% sell), so its Filled or its end shows where it was tapped
  const sell = useSell(chain, token, slippageBps);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const heldNow = useHeld(signedOut ? null : snapshot, chain, token);
  const lastHeld = useRef<Row | null>(null);
  if (heldNow) lastHeld.current = heldNow;
  else if (lastHeld.current && (lastHeld.current.chain !== chain || lastHeld.current.token !== token)) lastHeld.current = null;
  const held = heldNow ?? (sell.phase.k !== "ready" ? lastHeld.current : null);
  const onSell = side === "sell" && held !== null;
  // the side moves only while neither side runs: a running buy or sell keeps the box that draws its state
  const pickSide = (x: "buy" | "sell") => {
    if (!busy(phaseRef.current) && !busy(sell.phase)) setSide(x);
  };

  const amount = text === "" ? null : parseUsd(text);
  // the pool path (card trade-box-pool): a chain whose pool the signing page reports buys from it, one proof a tap; Bal
  // is the pool's balance and Max the most one tap can spend, in USD at the device's price. Other chains keep the vault.
  const pools = signedOut ? undefined : snapshot.state?.pools;
  const onPool = !!pools?.some((p) => p.chain === chain);
  const price = onPool ? kit.poolPrice(chain) : null;
  const pool = onPool ? poolView(pools, chain, price) : null;
  // the proof's state reads state.pools alone: it draws with no price
  const proof = onPool ? proofStatus(pools, chain) : "none";
  // Bal: the header's Cash (the one balance) on a chain with no pool, the pool's on a chain with one; one number for the
  // amount gate. Signed out there is none to show: the signing page sends a state with a zero one, which is not "$0" of anyone's
  const cash = useBalance(snapshot);
  const balance = tradeBal(onPool, pool, signedOut ? null : cash).cents;
  const maxText = onPool ? null : kit.maxBuy(chain);
  const max = onPool ? (pool?.tapMax ?? null) : maxText === null ? null : parseUsd(maxText);
  const askable = (c: Cents | null) => c !== null && (!onPool || poolBuyAsk(pools, chain, token, c, price, slippageBps).ok);
  const running = busy(phase);

  // the set preview for the amount in the box; a change asks again and the last numbers stay, dimmed, until it answers
  useEffect(() => {
    if (!on || !kit.setPreview || amount === null || amount <= 0n) return;
    let live = true;
    kit.setPreview({ chain, token, amount: centsToDecimal(amount), slippage_bps: slippageBps }).then(
      (a) => live && setPreview(a.ok ? { amount, p: a.preview } : null),
      () => live && setPreview(null),
    );
    return () => {
      live = false;
    };
  }, [on, kit.setPreview, chain, token, amount, slippageBps]);

  // the kit's stages for the running buy
  useEffect(() => {
    if (!kit.onProgress) return;
    // the time is read when the stage arrives, not when React renders it: a late render must not stretch Filled's time
    return kit.onProgress((id, stage) => {
      const at = src.now();
      setPhase((p) => progress(p, id, stage, at));
      setRoute((r) => fromStage(r, id, stage));
    });
  }, [kit.onProgress, src.now]);

  // what the page tells of the running buy besides its stage: the wallet, the venue and pool, the filled amount
  useEffect(() => {
    if (!kit.route) return;
    return kit.route((d) => setRoute((r) => routeEvent(r, d)));
  }, [kit.route]);

  // the fill toast goes by itself a few seconds after the fill (a notice, never a wait: the next tap does not wait on it)
  useEffect(() => {
    if (phase.k !== "filled") return;
    const id = phase.id;
    const t = setTimeout(() => setDismissed(id), 6000);
    return () => clearTimeout(t);
  }, [phase.k === "filled" ? phase.id : null]);

  // Landing's counter and Slow: a tick every 100 ms while a buy runs, none otherwise
  useEffect(() => {
    if (!busy(phase)) return;
    const t = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [phase.k]);

  const ready = on && moneyOn && kit.request !== null && max !== null && balance !== null;

  function buy(c: Cents) {
    if (!ready || busy(phaseRef.current) || !amountOk(c, max, balance)) return;
    let h;
    if (onPool) {
      // only an ask the box's own checks passed: a proof ready, at most one tap's spend, the device's price as it is at
      // the tap (a price past its bound since the last render prices nothing)
      const ask = poolBuyAsk(pools, chain, token, c, kit.poolPrice(chain), slippageBps);
      if (!ask.ok) return;
      h = kit.request!(ask.kind, ask.params);
    } else h = kit.request!("buy", { chain, token, side: "buy", amount: centsToDecimal(c), slippage_bps: slippageBps });
    const next = tap(phaseRef.current, h.id, src.now());
    phaseRef.current = next;
    setPhase(next);
    setRoute(routeTap(h.id, src.now(), c));
    void h.outcome.then((o) => {
      const at = src.now();
      setPhase((p) => outcome(p, h.id, o, at));
      setRoute((r) => fromOutcome(r, h.id, o));
    });
  }

  // a preset, in the box or the phone bar's chip (card app-quick-buy-one-tap): one tap is one buy of its size, through
  // buy() and its checks; signed out it opens the sign-in sheet
  const presetOff = (p: Cents) => !signedOut && (!ready || !presetOn(p, max, balance, running) || !askable(p));
  function tapPreset(p: Cents) {
    if (signedOut) return openSignin(true);
    setText(String(p / 100n));
    buy(p);
  }

  return { chain, token, slippageBps, src, account, signedOut, text, setText, phase, route, dismissed, setDismissed, amount, pools, onPool, price, proof, balance, max, askable, running, ready, buy, presetOff, tapPreset, preview, sell, side, setSide: pickSide, held, onSell };
}

/** A trade state as useTrade gives it. */
export type Trade = ReturnType<typeof useTrade>;

/** The box with its own trade state. `footer` draws inside the panel, under the Route & fees line (the token page's
 *  safety grid). */
export function TradeBox({ chain, token, symbol, slippageBps = 1000, initialAmount = "", footer }: { chain: Chain; token: string; symbol: string; slippageBps?: number; initialAmount?: string; footer?: ReactNode }) {
  const t = useTrade({ chain, token, slippageBps }, initialAmount);
  return <TradeView t={t} symbol={symbol} footer={footer} />;
}

/** The fill toast (S8.12) of a trade state's filled buy; nothing for any other phase. */
export function TradeFillToast({ t, symbol }: { t: Trade; symbol: string }) {
  const { chain, phase, route, setDismissed } = t;
  if (phase.k !== "filled") return null;
  return (
    <FillToast
      symbol={symbol}
      line={toastLine(phase.ms, route.out === null ? null : fmtOut(route.out), symbol, route.cents === null ? "" : usd2(route.cents))}
      href={route.tx ? txLink([{ chain, hash: route.tx }]) : null}
      chainName={chain === "solana" ? "solscan" : chain === "base" ? "basescan" : chain === "robinhood" ? "rhExplorer" : "nearblocks"}
      onClose={() => setDismissed(phase.id)}
    />
  );
}

/** The box drawn from a trade state; any number of views of one state draw the same trade. */
export function TradeView({ t, symbol, footer, toast = true }: { t: Trade; symbol: string; footer?: ReactNode; toast?: boolean }) {
  const { chain, token, slippageBps, src, account, signedOut, text, setText, phase, route, dismissed, amount, pools, onPool, price, proof, balance, max, askable, running, ready, buy, presetOff, tapPreset, preview } = t;
  const { kit } = src;
  const { setOpen: openSignin } = useSigninSheet();
  // the page's own symbol: Portfolio's Row names a token by its market read, which the live source has none of yet
  if (t.onSell) return <SellBox row={{ ...t.held!, symbol }} s={t.sell} slippageBps={slippageBps} onBuy={() => t.setSide("buy")} footer={footer} />;
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
  else if (hasRunLabel(phase)) label = <RunLabel phase={phase} now={now} final />;
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
        <button type="button" className="trb-side" aria-pressed="false" disabled={t.held === null || running} onClick={() => t.setSide("sell")} data-testid="trade-side-sell"><W id="sell" /></button>
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
            disabled={presetOff(p)}
            onClick={() => tapPreset(p)}
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
      <RouteStrip route={route} symbol={symbol} outText={route.out === null ? null : fmtOut(route.out)} />
      {toast && phase.k === "filled" && dismissed !== phase.id && <TradeFillToast t={t} symbol={symbol} />}
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
