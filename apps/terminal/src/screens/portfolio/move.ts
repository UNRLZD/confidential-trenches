import { SIGNPAGE_KINDS } from "@blindfill/kit";
import type { PoolChain, SignpageState, TxRef } from "@blindfill/kit";
import { decimalToUnits, statePoolPrice, unitsToCents } from "../trade/model.ts";
import type { PoolRow } from "./model.ts";

// Moving money between chains from Portfolio's Private balance (card portfolio-moves-money-between-chains), as pure
// functions: each row's dollar figure and the block's total, the route a move takes (lite paper v2 §3: money from Cash
// to a pool is one NEAR Intents leg; pool to pool stops in the NEAR vault, pool, NEAR Intents, NEAR vault, NEAR
// Intents, pool), which step a running move is at, the amount typed against what the row can move, and whether the
// signing page has the move at all.
//
// The move itself is the signing page's (wallet card one-balance-buys-on-every-chain): pool.move {from, to, amount}
// starts it, pool.move.dry {from, to, amount} prices it, and its op in state.ops says where it is. The app never builds
// a path of its own. Until the kit names those kinds, moveShips() is false and the screen draws no Move: the gate is
// the kit's own kind table, which the build pins with the signing page it ships against, never a flag.

/** A chain a row stands for: NEAR's is the vault's USDC (Cash), the others their pool. */
export type MoveChain = "near" | PoolChain;

/** The signing page's kinds (wallet card one-balance-buys-on-every-chain). */
export const MOVE_KIND = "pool.move";
export const MOVE_DRY_KIND = "pool.move.dry";

/** True once the kit names both kinds: before that the page refuses them and a Move would do nothing. */
export function moveShips(isKind: (k: string) => boolean = (k) => (SIGNPAGE_KINDS as readonly string[]).includes(k)): boolean {
  return isKind(MOVE_KIND) && isKind(MOVE_DRY_KIND);
}

/** pool.move's and pool.move.dry's params: `amount` a decimal string in whole units of `from`'s asset. */
export interface MoveParams {
  from: MoveChain;
  to: MoveChain;
  amount: string;
}

/** A step of a move as pool.move.dry names it (kit 1.15, wallet card one-balance-buys-on-every-chain): out of the vault
 *  or a pool, a NEAR Intents leg (its chain the side it delivers to), into the vault or a pool. */
export const MOVE_STEPS = ["vault_out", "pool_out", "intents", "vault_in", "pool_in"] as const;
export type MoveStep = { step: (typeof MOVE_STEPS)[number]; chain: MoveChain };

/** pool.move.dry's answer (kit 1.15): `out` the least that arrives, whole units of `to`'s asset; `fee` whole units of
 *  `from`'s asset; `steps` the route it takes; `max` (kit 1.16, card move-sends-what-it-shows) the most the move can send
 *  now, whole units of `from`'s asset. Display only: pool.move reads and checks its own quotes. */
export interface MoveDry {
  out: string;
  fee: string;
  steps: readonly MoveStep[];
  max?: string;
  /** The legs' quoted time in seconds, when the page sends one (Arrives); none is made up. */
  time_estimate_s?: number;
}

/** pool.move.dry's answer for an amount the move cannot send (kit 1.16, card move-sends-what-it-shows): no `out`, so
 *  nothing would move; `max` the most it can send now, and the nearest amounts it sends exactly (`below`, `above`) or
 *  the least that clears every floor on its route (`min`), each in whole units of `from`'s asset. */
export interface MoveLimits {
  max: string;
  steps: readonly MoveStep[];
  min?: string;
  below?: string;
  above?: string;
}

const dec = (v: unknown): v is string => typeof v === "string" && /^\d+(\.\d+)?$/.test(v);
const stepsOf = (v: unknown): MoveStep[] | null =>
  Array.isArray(v) && v.length >= 3 && v.every((x) => (MOVE_STEPS as readonly unknown[]).includes(x?.step) && isChain(x?.chain)) ? v.map((x) => ({ step: x.step, chain: x.chain })) : null;

/** pool.move.dry's answer, field by field (kit 1.15, with kit 1.16's max): null for any other shape. */
export function readDry(x: unknown): MoveDry | null {
  const d = x as Partial<MoveDry> | null;
  const steps = d ? stepsOf(d.steps) : null;
  if (!d || !dec(d.out) || !dec(d.fee) || steps === null) return null;
  if (d.max !== undefined && !dec(d.max)) return null;
  const t = d.time_estimate_s;
  const time = typeof t === "number" && Number.isFinite(t) && t >= 0 ? { time_estimate_s: t } : {};
  return { out: d.out, fee: d.fee, steps, ...(d.max === undefined ? {} : { max: d.max }), ...time };
}

/** pool.move.dry's answer for an amount the move cannot send (kit 1.16), field by field: null for any other shape. */
export function readLimits(x: unknown): MoveLimits | null {
  const d = x as Partial<MoveLimits> & { out?: unknown } | null;
  const steps = d ? stepsOf(d.steps) : null;
  if (!d || d.out !== undefined || !dec(d.max) || steps === null) return null;
  const opt = { min: d.min, below: d.below, above: d.above };
  if (Object.values(opt).some((v) => v !== undefined && !dec(v))) return null;
  return { max: d.max, steps, ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)) };
}

/** A move op's stages (kit 1.15): leaving its side, in transit on a NEAR Intents leg, in the NEAR vault (pool to pool:
 *  the stop between the legs; a pool to Cash: arrived), into the pool, then done; or failed, or refunded. */
export const MOVE_STAGES = ["leaving", "in_transit", "in_vault", "into_pool", "done", "failed", "refunded"] as const;
export type MoveStage = (typeof MOVE_STAGES)[number];

/** The move's op in state.ops (kit 1.15), its id pool.move's request id. */
export interface MoveOp {
  id: string;
  kind: "move";
  from: MoveChain;
  to: MoveChain;
  stage: MoveStage;
  txs: readonly TxRef[];
  amount?: string;
  /** What landed in `to`, whole units of its asset. */
  out?: string;
}

/** The move op with `id` in the state's ops, read field by field: null until the page sends one this app can read. */
export function moveOp(state: SignpageState | null | undefined, id: string | null): MoveOp | null {
  if (!state || !id) return null;
  for (const o of state.ops as readonly unknown[]) {
    const m = o as Partial<MoveOp> & { kind?: unknown };
    if (m.id !== id || m.kind !== "move") continue;
    if (!isChain(m.from) || !isChain(m.to) || !(MOVE_STAGES as readonly unknown[]).includes(m.stage) || !Array.isArray(m.txs)) return null;
    return m as MoveOp;
  }
  return null;
}

export const MOVE_CHAINS: readonly MoveChain[] = ["near", "solana", "base", "robinhood"];
const isChain = (c: unknown): c is MoveChain => (MOVE_CHAINS as readonly unknown[]).includes(c);

// ------------------------------------------------------------------------------------------------ the route

/** The steps a move takes before pool.move.dry answers, as kit 1.15 names them (lite paper v2 §3): Cash to a pool one
 *  NEAR Intents leg; a pool to Cash one leg into the vault; pool to pool through the NEAR vault, so the two chains'
 *  money is never tied together. Null for a chain to itself. Once the dry answers, its own steps are drawn. */
export function routeSteps(from: MoveChain, to: MoveChain): MoveStep[] | null {
  if (from === to) return null;
  if (from === "near") return [{ step: "vault_out", chain: "near" }, { step: "intents", chain: to }, { step: "pool_in", chain: to }];
  const out: MoveStep[] = [{ step: "pool_out", chain: from }, { step: "intents", chain: "near" }, { step: "vault_in", chain: "near" }];
  return to === "near" ? out : [...out, { step: "vault_out", chain: "near" }, { step: "intents", chain: to }, { step: "pool_in", chain: to }];
}

export type NodeKind = "pool" | "intents" | "vault";
/** A place the flow draws: a pool or the vault (a vault_in then vault_out is one stop), or a NEAR Intents leg. */
export interface FlowNode {
  kind: NodeKind;
  chain: MoveChain;
}

export function nodesOf(steps: readonly MoveStep[]): FlowNode[] {
  const out: FlowNode[] = [];
  for (const s of steps) {
    const kind: NodeKind = s.step === "intents" ? "intents" : s.step.startsWith("vault") ? "vault" : "pool";
    const prev = out.at(-1);
    if (kind === "vault" && prev?.kind === "vault") continue;
    out.push({ kind, chain: s.chain });
  }
  return out;
}

export type StepState = "idle" | "active" | "done" | "error";

/** The node a running move is at, never behind `reached` (the furthest the sheet has seen: kit 1.15 names both legs
 *  in_transit, so a leg after the vault is told by having passed it). -1: not started. */
export function reach(nodes: readonly FlowNode[], stage: MoveStage | null, reached: number): number {
  if (stage === null) return reached;
  const last = nodes.length - 1;
  let i = reached;
  if (stage === "done" || stage === "into_pool") i = last;
  else if (stage === "in_vault") i = nodes.findLastIndex((n) => n.kind === "vault");
  else if (stage === "in_transit") i = nodes.findIndex((n, k) => n.kind === "intents" && k >= reached);
  else if (stage === "leaving") i = Math.max(0, reached);
  return Math.max(i, reached);
}

/** Each node's state at `stage`, the move at node `at` (reach): done before it, it active; on done every node done;
 *  failed or refunded, the node it stopped at in error. */
export function stepStates(nodes: readonly FlowNode[], stage: MoveStage | null, at: number): StepState[] {
  if (stage === null || at < 0) return nodes.map(() => "idle");
  if (stage === "done") return nodes.map(() => "done");
  const end = stage === "failed" || stage === "refunded";
  return nodes.map((_, k) => (k < at ? "done" : k === at ? (end ? "error" : "active") : "idle"));
}

/** A move still on its way: started and not ended. */
export const moveRunning = (op: MoveOp | null): boolean => op !== null && op.stage !== "done" && op.stage !== "failed" && op.stage !== "refunded";

// ------------------------------------------------------------------------------------------------ the rows' dollars

/** A row's dollar figure in cents, rounded down: NEAR's vault USDC as is, a pool's balance at the signing page's own
 *  price while fresh on this clock (the trade box's one rule, statePoolPrice); null for a pool with something and no
 *  fresh price (never made up). Nothing is $0 at any price. */
export function rowCents(s: SignpageState, r: PoolRow, now: number): bigint | null {
  if (r.balance === 0n) return 0n;
  if (r.asset === "USDC") return r.balance / 10n ** BigInt(r.decimals - 2);
  const p = statePoolPrice(s.pools, r.chain, now);
  return p ? unitsToCents(r.balance, p) : null;
}

/** The block's total: every row's cents that has one, and whether a row had none (its dollars left out). */
export function poolTotal(s: SignpageState, rows: readonly PoolRow[], now: number): { cents: bigint; partial: boolean } {
  let cents = 0n;
  let partial = false;
  for (const r of rows) {
    const c = rowCents(s, r, now);
    if (c === null) partial = true;
    else cents += c;
  }
  return { cents, partial };
}

// ------------------------------------------------------------------------------------------------ the amount

/** What a row can move: what its pool's notes hold (or the vault's USDC); money still at a deposit wallet is not yet
 *  the pool's. */
export const movable = (r: PoolRow): bigint => r.pooled;

/** Base units at `d` decimals as an exact decimal string, no trailing zeros ("0.021049", "12"): Max's text. */
export function exact(units: bigint, d: number): string {
  const one = 10n ** BigInt(d);
  const f = (units % one).toString().padStart(d, "0").replace(/0+$/, "");
  return `${units / one}${f ? `.${f}` : ""}`;
}

export type AmountCheck = { kind: "none" } | { kind: "ok"; units: bigint } | { kind: "bad" } | { kind: "over"; units: bigint };

/** The typed amount against the row: none (empty), bad (not a decimal, more digits than the asset has, or zero), over
 *  (more than the row can move) or ok. */
export function checkAmount(text: string, r: PoolRow): AmountCheck {
  const t = text.trim();
  if (!t) return { kind: "none" };
  // "0." while it is being typed reads as its whole part
  const units = decimalToUnits(t.endsWith(".") ? t.slice(0, -1) : t, r.decimals);
  if (units === null || units === 0n) return { kind: "bad" };
  return units > movable(r) ? { kind: "over", units } : { kind: "ok", units };
}

/** The approved word a Move's refusal is named by (card move-one-confidential-swap), the same on the dry and at the tap:
 *  a read not in yet or a throttle Busy, a quote that failed the device's check Quote refused, anything else Not
 *  available. No new sentence: each is a word of words.ts. */
export function refusedWord(code: string): "busy" | "quoteRefused" | "notAvailable" {
  if (code === "busy" || code === "down") return "busy";
  return code === "quote_check_failed" ? "quoteRefused" : "notAvailable";
}
