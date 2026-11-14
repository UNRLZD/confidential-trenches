import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SignpageState } from "@blindfill/kit";
import { chainOf } from "../market/pads.ts";
import { Ic } from "./icons.tsx";
import { amount, baseUnits, usd } from "./model.ts";
import type { PoolRow } from "./model.ts";
import { checkAmount, exact, moveOp, moveRunning, nodesOf, reach, routeSteps, rowCents, stepStates } from "./move.ts";
import type { FlowNode, MoveChain, StepState } from "./move.ts";
import type { DryAnswer, MoveSource } from "./move-source.tsx";
import { statePoolPrice, unitsToCents } from "../trade/model.ts";
import { W } from "./W.tsx";
import { WORDS } from "./words.ts";
import "../deposit/deposit.css";
import "../trade/trade.css";

// The move sheet (card portfolio-moves-money-between-chains): Private balance's Move, in the deposit sheet's family
// (deposit/DepositSheet.tsx: the drawer on desktop, the sheet from the bottom on the phone, its classes and words).
// From (the row's chain) and To, each a chain tile with its balance; Amount with Max; You get, about, the fee and
// Arrives from pool.move.dry; the route's flow as the buy's route strip draws it (trade/RouteStrip.tsx classes: a node
// glows while it runs, checks when passed, the dotted link fills); one Move, then the op's stages from state.ops until
// it lands. The sheet asks the signing page (move-source.tsx) and never builds a path of its own. Max is what the page
// says the move can send (card move-sends-what-it-shows: a dry of the whole balance answers it). Max is an intent, not a
// number (card withdraw-max-means-all): tapped, the box follows the page's live max until an amount is typed. An amount
// the move cannot send exactly sends the nearest it sends at or below it (Max above everything), drawn on its own line
// while the box keeps what was typed, and put in the box on blur or at the press; only one under the least it sends
// names that least: Min.

export interface MoveUi {
  from: MoveChain;
  to: MoveChain;
  amount: string;
  /** pool.move's request id once Move is tapped: the op in state.ops. */
  id: string | null;
  /** Its refusal, when the page would not start it. */
  refused: string | null;
}

const NAME: Record<MoveChain, string> = { near: "NEAR", solana: "Solana", base: "Base", robinhood: "Robinhood" };
const BLUE = "#5b8cff";

export function MoveSheet({ ui, set, rows, state, src, on, now, withdraw, close }: { ui: MoveUi; set(p: Partial<MoveUi>): void; rows: readonly PoolRow[]; state: SignpageState | null; src: MoveSource; on: boolean; now: number; withdraw(c: MoveChain): void; close(): void }) {
  const from = rows.find((r) => r.chain === ui.from) ?? null;
  const to = rows.find((r) => r.chain === ui.to) ?? null;
  const op = moveOp(state, ui.id);
  const running = ui.id !== null && ui.refused === null && (op === null || moveRunning(op));
  const ended = op !== null && !moveRunning(op);
  const check = from ? checkAmount(ui.amount, from) : ({ kind: "none" } as const);
  const [dry, setDry] = useState<DryAnswer | "loading" | null>(null);
  const [tries, setTries] = useState(0);
  // the most this move can send, as the page answers it for this pair (its own dry of the whole balance, or any dry
  // since): null until it has answered, so Max never offers an amount the move would refuse
  const [top, setTop] = useState<{ pair: string; max: string } | null>(null);
  const pair = `${ui.from}>${ui.to}`;
  const started = useRef<number | null>(null);
  const [reached, setReached] = useState(-1);
  const [tick, setTick] = useState(0);

  // Max: a dry of the whole balance, asked once per pair and balance; its max (a page before kit 1.16 sends none and
  // prices the whole balance when it can send it)
  const whole = from && from.pooled > 0n ? exact(from.pooled, from.decimals) : null;
  useEffect(() => {
    if (ui.id !== null || whole === null || ui.from === ui.to) return;
    let live = true;
    void src.dry({ from: ui.from, to: ui.to, amount: whole }).then((a) => {
      const max = a.kind === "limits" ? a.value.max : a.kind === "ok" ? a.value.max ?? whole : null;
      if (live && max !== null) setTop({ pair: `${ui.from}>${ui.to}`, max });
    });
    return () => {
      live = false;
    };
  }, [src, ui.from, ui.to, whole, ui.id, tries]);
  // every dry since names it too
  useEffect(() => {
    if (dry && dry !== "loading" && dry.kind !== "refused" && dry.value.max !== undefined) setTop({ pair, max: dry.value.max });
  }, [dry, pair]);
  const maxText = top?.pair === pair && from && (baseUnits(top.max, from.decimals) ?? 0n) > 0n ? top.max : null;
  // Max tapped and no amount typed since: the box follows the live max (a fee or balance re-read moves it)
  const [maxIntent, setMaxIntent] = useState(false);
  useEffect(() => {
    if (maxIntent && maxText !== null && ui.id === null && ui.amount !== maxText) set({ amount: maxText });
  }, [maxIntent, maxText, ui.id, ui.amount]);
  // the amount the move sends for the typed one: the typed amount when the page prices it; else the nearest it sends at
  // or below it, once the page names it; Max over the balance. The box keeps what was typed: this amount is drawn on its
  // own line and goes into the box only on blur or at the press (card withdraw-max-means-all)
  const typed = ui.amount.trim();
  const key = `${pair}|${typed}`;
  const [near, setNear] = useState<{ key: string; amount: string } | null>(null);
  const sends = ui.id !== null ? typed : check.kind === "over" ? maxText : near?.key === key ? near.amount : check.kind === "ok" ? typed : null;
  const sendCheck = sends !== null && from ? checkAmount(sends, from) : ({ kind: "none" } as const);
  // the price for this pair and the amount it sends, asked again 300 ms after the last change; frozen once the move runs
  const ask = sendCheck.kind === "ok" ? sends : null;
  useEffect(() => {
    if (ui.id !== null || ask === null || ui.from === ui.to) return void setDry(null);
    let live = true;
    setDry("loading");
    const t = setTimeout(() => void src.dry({ from: ui.from, to: ui.to, amount: ask }).then((a) => live && setDry(a)), 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [src, ui.from, ui.to, ask, ui.id, tries]);
  // an amount the move cannot send exactly: the page names the nearest it sends at or below it (or its max over it),
  // kept for this typed amount; Min (nothing at or below moves) stays a refusal
  const lim = dry && dry !== "loading" && dry.kind === "limits" && ui.id === null ? dry.value : null;
  const least = lim ? lim.min ?? (lim.below === undefined ? lim.above : undefined) : undefined;
  useEffect(() => {
    // an answer is always the current ask's: a newer ask drops the older answer and draws loading first
    if (!lim || least !== undefined || !from) return;
    const n = lim.below ?? lim.max;
    if (n !== ask && (baseUnits(n, from.decimals) ?? 0n) > 0n) setNear({ key, amount: n });
  }, [dry]);
  // on blur the box takes the amount sent
  const settle = () => {
    if (ui.id === null && sends !== null && sendCheck.kind === "ok" && sends !== typed) set({ amount: sends });
  };

  const steps = (dry && dry !== "loading" && dry.kind === "ok" ? dry.value.steps : null) ?? routeSteps(ui.from, ui.to) ?? [];
  const nodes = nodesOf(steps);
  // the furthest node seen, so the leg after the vault reads as the second (kit 1.15 names both in_transit)
  const at = reach(nodes, op?.stage ?? (running ? "leaving" : null), reached);
  useEffect(() => setReached(at), [at]);
  useEffect(() => {
    if (!running) return;
    started.current ??= now;
    const t = setInterval(() => setTick((k) => k + 1), 1000);
    return () => clearInterval(t);
  }, [running, now]);
  const states = stepStates(nodes, op?.stage ?? (running ? "leaving" : null), at);

  const pick = (side: "from" | "to", c: MoveChain) => {
    if (ui.id !== null) return;
    const other = side === "from" ? ui.to : ui.from;
    // picking the other side's chain swaps the two
    const next = c === other ? { from: side === "from" ? c : ui.to, to: side === "to" ? c : ui.from } : side === "from" ? { from: c, to: ui.to } : { from: ui.from, to: c };
    const fresh = side === "from" && next.from !== ui.from;
    if (fresh) setMaxIntent(false);
    set({ ...next, amount: fresh ? "" : ui.amount });
  };
  const go = () => {
    if (sendCheck.kind !== "ok" || !ask) return;
    // the press sends the amount the line shows, and the box takes it
    const h = src.start({ from: ui.from, to: ui.to, amount: ask });
    set({ amount: ask, id: h.id, refused: null });
    void h.outcome.then((code) => code && set({ refused: code }));
  };

  const q = dry && dry !== "loading" && dry.kind === "ok" ? dry.value : null;
  const toUsd = (r: PoolRow | null, s: string | undefined): string | null => {
    if (!r || !state || s === undefined) return null;
    const u = baseUnits(s, r.decimals);
    if (u === null) return null;
    if (r.asset === "USDC") return usd(u / 10n ** BigInt(r.decimals - 2));
    const p = statePoolPrice(state.pools, r.chain, now);
    return p ? usd(unitsToCents(u, p)) : null;
  };
  const coin = (r: PoolRow | null, s: string | undefined) => (r && s !== undefined ? `${amount(baseUnits(s, r.decimals) ?? 0n, r.decimals)} ${r.asset}` : null);
  const cell = (v: ReactNode | null) => (dry === "loading" ? <span className="sk" /> : <span className={v ? "num" : "num t3"}>{v ?? "—"}</span>);
  const elapsed = started.current === null ? 0 : Math.max(0, Math.floor((now + tick * 1000 - started.current) / 1000));

  let quote: ReactNode;
  if (lim && least !== undefined) {
    // nothing at or below the amount moves: Min, the least it sends, a tap that types it (drawn with no tap when even
    // Max is under it)
    const fits = from !== null && (baseUnits(least, from.decimals) ?? 0n) <= (baseUnits(lim.max, from.decimals) ?? 0n);
    quote = (
      <div className="dstat warn row" data-move-dry="min" data-move-min={least}>
        <span><W id="min" /></span>
        {fits ? (
          <button type="button" className="retry num" data-control="move-try" data-amount={least} onClick={() => set({ amount: least })}>
            {coin(from, least)}
          </button>
        ) : (
          <span className="num">{coin(from, least)}</span>
        )}
      </div>
    );
  } else if (dry && dry !== "loading" && dry.kind === "refused" && ui.id === null) {
    quote =
      dry.code === "busy" || dry.code === "down" ? (
        <div className="dstat warn row" data-move-dry={dry.code}><span><W id="busy" /></span><button type="button" className="retry" onClick={() => setTries((t) => t + 1)}><W id="retry" /></button></div>
      ) : (
        <div className="dstat warn" data-move-dry={dry.code}><span>{dry.code === "quote_check_failed" ? <W id="quoteRefused" /> : <W id="notAvailable" />}</span></div>
      );
  } else {
    const got = coin(to, q?.out);
    quote = (
      <>
        <div className="dget" data-move-out={q?.out}>
          <div className="lb"><W id="youGet" /></div>
          <div className="v">{cell(got)}{q && toUsd(to, q.out) && <span className="mvusd num">{toUsd(to, q.out)}</span>}</div>
        </div>
        {sends !== null && sends !== typed && ui.id === null && (
          <div className="dstat row" data-move-sends={sends}>
            <span><W id="amount" /></span>
            <span className="num">{coin(from, sends)}</span>
          </div>
        )}
        <div className="dstrip two">
          <div><div className="k"><W id="fees" /></div><div className="v">{cell(q ? coin(from, q.fee) : null)}</div></div>
          <div><div className="k"><W id="arrives" /></div><div className="v">{cell(q?.time_estimate_s !== undefined ? `~${q.time_estimate_s}s` : null)}</div></div>
        </div>
      </>
    );
  }

  const total = rows.reduce((a, r) => a + (state ? rowCents(state, r, now) ?? 0n : 0n), 0n);
  let stat: ReactNode = null;
  if (ui.refused !== null) stat = <div className="dstat warn" data-move-end="refused"><span>{ui.refused === "busy" ? <W id="busy" /> : <W id="notAvailable" />}</span></div>;
  else if (running) stat = <div className="dstat blue" data-move-end="running"><span><W id="processing" /></span><span className="num cnt">{`${elapsed}s`.padEnd(6, " ")}</span></div>;
  else if (op?.stage === "done") stat = <div className="dstat mvok" data-move-end="done"><span><W id="done" /></span>{op.out && to && <span className="num">{coin(to, op.out)}</span>}</div>;
  else if (op?.stage === "refunded") stat = <div className="dstat warn" data-move-end="refunded"><span><W id="refunded" /></span></div>;
  else if (op?.stage === "failed") stat = <div className="dstat warn" data-move-end="failed"><span><W id="txFailed" /></span></div>;

  const can = on && sendCheck.kind === "ok" && q !== null && ui.id === null;
  return (
    <div className="dep mv" data-sheet="move" data-from={ui.from} data-to={ui.to} data-move-state={ui.refused ? "refused" : op?.stage ?? (running ? "starting" : "idle")}>
      <div className="dep-scrim" onClick={close} />
      <aside className="dep-box" aria-labelledby="mv-seg-on">
        <div className="grab"><i /></div>
        <div className="dhd">
          <span className="bal num">{usd(total)}</span>
          <button type="button" className="dep-x" aria-label={WORDS.close.text} onClick={close}><Ic name="x" size={14} /></button>
        </div>
        <div className="dbody">
          <div className="dseg">
            <button type="button" className="on" id="mv-seg-on"><W id="move" /></button>
            <button type="button" disabled={!on || running || (from?.pooled ?? 0n) === 0n} data-control="move-withdraw" onClick={() => withdraw(ui.from)}><W id="withdraw" /></button>
          </div>
          <Side label="from" rows={rows} value={ui.from} locked={ui.id !== null} pick={(c) => pick("from", c)} />
          <Side label="to" rows={rows} value={ui.to} locked={ui.id !== null} pick={(c) => pick("to", c)} />
          <label className={check.kind === "bad" || least !== undefined ? "damt bad" : "damt"}>
            <span className="lb"><W id="amount" /></span>
            <span className="row">
              <input className="v num" inputMode="decimal" autoComplete="off" placeholder="0" value={ui.amount} disabled={ui.id !== null} onChange={(e) => (setMaxIntent(false), set({ amount: e.target.value.replace(",", ".") }))} onBlur={settle} data-field="move-amount" />
              <span className="u">{from?.asset}</span>
            </span>
          </label>
          <div className="lim">
            <span className={check.kind === "over" ? "loss" : ""}><W id="balance" /> <span className="num">{from ? amount(from.pooled, from.decimals) : "—"}</span> {from?.asset}</span>
            <button type="button" className="mvmax" data-control="move-max" data-max={maxText ?? undefined} disabled={maxText === null || ui.id !== null} onClick={() => maxText !== null && (setMaxIntent(true), set({ amount: maxText }))}><W id="max" /></button>
          </div>
          {ui.id === null || ui.refused !== null ? quote : null}
          <Flow nodes={nodes} states={states} sent={ui.id !== null ? coin(from, ui.amount.trim()) : null} got={op?.stage === "done" ? coin(to, op.out) : null} />
          {stat}
        </div>
        <div className="dfoot">
          {ended ? (
            <button type="button" className="dbtn paper" data-control="move-done" onClick={close}><W id="done" /></button>
          ) : (
            <button type="button" className={`dbtn ${can ? "buy" : "off"}`} disabled={!can} aria-busy={running || undefined} data-control="move-go" onClick={go}>
              <Ic name="move" size={14} stroke={1.6} />
              <W id="move" />
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/** From or To: the four chains as tiles (the deposit sheet's To row), each its mark, name and balance; the picked one on. */
function Side({ label, rows, value, locked, pick }: { label: "from" | "to"; rows: readonly PoolRow[]; value: MoveChain; locked: boolean; pick(c: MoveChain): void }) {
  return (
    <div className="ddest mvside">
      <div className="lb" id={`mv-${label}`}><W id={label} /></div>
      <div className="dtiles" role="group" aria-labelledby={`mv-${label}`} data-side={label}>
        {rows.map((r) => {
          const m = chainOf(r.chain)!;
          return (
            <button key={r.chain} type="button" className={r.chain === value ? "on" : undefined} aria-pressed={r.chain === value} disabled={locked} data-chain={r.chain} onClick={() => pick(r.chain)}>
              <span className="mk" style={{ padding: Math.round(20 * m.inset) }}><img src={m.logo} alt="" /></span>
              <span className="nm">{m.name}</span>
              <span className="mvb num">{amount(r.pooled, r.decimals)} {r.asset}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The route as the buy's strip draws it: each pool or the vault by its chain's mark, each NEAR Intents leg a blue ring
 *  of dots; a node glows while the move is at it and checks once passed, and the link after it fills. */
function Flow({ nodes, states, sent, got }: { nodes: readonly FlowNode[]; states: readonly StepState[]; sent: string | null; got: string | null }) {
  const out: ReactNode[] = [];
  nodes.forEach((n, i) => {
    if (i > 0) out.push(<FlowLink key={`l${i}`} full={states[i - 1] === "done"} />);
    const st = states[i] ?? "idle";
    const m = n.kind === "intents" ? null : chainOf(n.chain);
    const value = i === 0 ? sent : i === nodes.length - 1 ? got : null;
    out.push(
      <span className="rs-n" key={`n${i}`} data-step={n.kind} data-chain={n.chain} data-state={st} data-testid={`move-step-${i}`}>
        <span className="rs-g">
          {m ? <img className="mvmk" src={m.logo} alt="" style={{ padding: Math.round(22 * m.inset) }} /> : <Ring />}
          {(st === "done" || st === "error") && <span className="rs-ck" data-kind={st}>{st === "done" ? <Check /> : <Cross />}</span>}
        </span>
        <span className="rs-k">{n.kind === "intents" ? <W id="intents" /> : NAME[n.chain]}</span>
        <span className="rs-v" data-on={value !== null || undefined}>{value ?? " "}</span>
      </span>,
    );
  });
  return (
    <div className="rs mvflow" data-testid="move-flow" data-steps={nodes.map((n) => `${n.kind}:${n.chain}`).join(" ")}>
      <div className="rs-flow">{out}</div>
    </div>
  );
}

function FlowLink({ full }: { full: boolean }) {
  return (
    <span className="rs-l" data-full={full || undefined}>
      <span className="rs-ld"><i /></span>
      <svg width="7" height="8" viewBox="0 0 7 8" aria-hidden="true"><circle cx="1.5" cy="1.4" r="1.2" /><circle cx="4.5" cy="4" r="1.3" /><circle cx="1.5" cy="6.6" r="1.2" /></svg>
    </span>
  );
}

/** NEAR Intents' leg: a ring of blue dots, the strip's one-time wallet's tone (blue moves money between chains). */
function Ring() {
  const dots: ReactNode[] = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    dots.push(<circle key={k} cx={12 + 8.5 * Math.cos(a)} cy={12 + 8.5 * Math.sin(a)} r={1.35} fill={BLUE} fillOpacity={0.45 + 0.55 * ((Math.cos(a - 2.4) + 1) / 2)} />);
  }
  dots.push(<circle key="c" cx={12} cy={12} r={2.2} fill={BLUE} />);
  return <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">{dots}</svg>;
}

const Check = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);
const Cross = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
