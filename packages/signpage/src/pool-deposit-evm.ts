// pool.deposit on an EVM pool (card pool-deposits, slice 3): a one-time wallet U of the device puts ETH into the pinned
// pool on its own chain (Base, Robinhood), and each note is stored landed only once a Deposited naming its
// precommitment is final on both RPCs. The rules are the Solana runner's (src/pool-deposit.ts), on the EVM's reads:
//
// - The source: U = U^evm_{s,i} (derive/keys.ts depositIdEvm), s the pinned pool's scope. The newest U this scope has
//   landed a note from stays the source while it covers a rung and its fee; else the U of the index the note store plans
//   (planDeposit: one unfunded index per scope, the same index handed back across asks until money reaches it). The note
//   and its rung are the wallet's (../../wallet/src/pool/same-chain.ts evmSameChainDeposit: the note picked through
//   evmNextNote over the pool's events, the largest rung U carries with its cost, the rest kept in U, floor 0).
// - The price, from both RPCs at one block both hold (evmAgreedBlock "latest"): U's nonce and the base fee agree, U's
//   balance is each RPC's own reading and the deposit must go on both; eth_estimateGas of the call from U agrees on both
//   (capped, rules/pool.ts EVM_DEPOSIT_GAS_MAX); the L1 fee is the kit's chain fee read (evmPoolChainFeeReads) on Base,
//   0 on Robinhood (Nitro's L1 cost is in its gas). The gas limit is the estimate plus the tree's headroom
//   (rules/pool.ts evmDepositHeadroom, from the pool's two tree depths both RPCs agree on): the deposit lands at any
//   later index than the estimate's, and gas it does not use is never charged. Cost = gasLimit x maxFee + l1Fee,
//   maxFee = 2 x baseFee + tip, checked against U's balance at that padded limit.
// - Before anything is written: the tx is checked by the rule (rules/pool.ts checkEvmDeposit) and simulated on BOTH RPCs
//   (eth_call from U with the value and data). A failure on either signs nothing. If a Deposited already names the
//   precommitment, the note was taken: it is restored as the user's (evmClaimTaken, at the value that deposit carried)
//   and the run goes on to the next note. If none names it, the run reads and simulates once more before not_funded.
// - The note goes PLANNED -> INCOMING with its send { hash, nonce, value } written BEFORE eth_sendRawTransaction leaves
//   for both RPCs; a send built again is written first too (addEvmSend), at the note's recorded value.
// - The verdict: a Deposited naming the precommitment at the round's finalized block (both RPCs, evmTreeSync's events
//   and evmNextNote) moves the note to UNSPENT with its leaf; one at another value is a take, the note restored at that
//   value. A send is dead ONLY when U's finalized nonce has passed it on BOTH RPCs, read before the round, and no
//   Deposited names the precommitment on either (final or not): then it is built again from fresh reads at the new nonce on the SAME note,
//   never the old bytes, at most POOL_DEPOSIT_EVM_REBUILDS times a run. A send that reached neither RPC is built again
//   at its own nonce once EVM_DEPOSIT_RESEND_MS has passed on the device's clock since it left (a send again restarts
//   it). Anything else is pending: the note stays INCOMING and the answer is "sent" or "not_landed", never failed.
// - The Solana runner's rule for open notes (src/pool-deposit.ts): each INCOMING note of the scope's U chains is read
//   once at the start of every run, as its own move, never waited on: settled, taken, sent again, or left INCOMING with
//   its U no source this run (a send again U cannot pay leaves it so, and `short` names the top-up). settle (no ask)
//   does that pass on page load and on the page's state reads while such a note is open (src/pool-testnet.ts). An ask
//   never takes an earlier note's landing or send as its own: it goes on the newest U with no open note, else the
//   planned index; short there, it waits (not_landed) only when a U still landing a note holds the rung once that note
//   lands, else not_funded with `short` naming the ask's own U. `sent` and `progress` are the ask's own sends only.
// - The end after "sent" (card pool-deposit-sent-end, the Solana kind's rule): the run reads its send's verdict once (a
//   Deposited is final only ~1,000 s on), so a run that ends with no verdict past a send of its ask hands the kind the
//   ask's notes still INCOMING (`left`), and the kind reads them, with no lock held and nothing written, every
//   POOL_DEPOSIT_EVM_FOLLOW_MS until each is decided. Landed: a Deposited naming its precommitment at or below the
//   round's finalized block, at its value. Dead, never one RPC's word: U's finalized nonce past every send of it on BOTH
//   RPCs, read before the round that finds no Deposited naming it (final or not); or taken (a final Deposited at another
//   value). Then filled when every open note landed and the ask was all sent, part_filled when any of it landed, else
//   not_landed; the money of a dead send stays in U, and the next load or ask builds the note again.
// - Every read names a public account (the pool, U) and no request carries a key, the words or which note is whose. U's
//   secret key and the seed are zeroed when the run ends. Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_MIN_DEPOSIT, EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads } from "../../kit/src/trade/evm/pool-fee.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { EvmPoolSend, NoteRecord, NoteState, NoteStore } from "../../wallet/src/notes/store.ts";
import { evmAgreedBlock, EvmLagError, evmPoolScopeOf, evmRetryLag, EvmUnansweredError, EVM_CHAIN_IDS, EVM_LADDER, EVM_READ_TRY_MS, type EvmNetwork, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { evmClaimTaken, evmNextNote, EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { evmSameChainDeposit } from "../../wallet/src/pool/same-chain.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkEvmDeposit, EVM_DEPOSIT_GAS_MAX, evmDepositHeadroom, PoolRuleRefused, signEvmDeposit, type EvmOnwardSend, type PoolAsk } from "./rules/pool.ts";
import { POOL_DEPOSIT_FOLLOW_FOR_MS, POOL_DEPOSIT_FOLLOW_MAX_MS, POOL_DEPOSIT_LOCK, type PoolDepositAnswer } from "./pool-deposit.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** The pool's events up to the newest block both RPCs agree on, with the round's finalized block (evmTreeSync's
 *  events(): `events` and `fin.number`). */
export type EvmDepositRound = { events: readonly EvmPoolEvent[]; finalBlock: bigint };

export type PoolDepositEvmHost = {
  /** The pinned pool (the wallet's EVM_POOLS entry of this page's network). */
  pin: EvmPoolPin;
  /** The page's own network (POOL_TESTNET), never read off the pin: the rule holds the pin to it. */
  testnet: boolean;
  /** Two RPCs of different operators on the pool's network. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** The pool's events on both RPCs (evmTreeSync over the same pair). */
  round(): Promise<EvmDepositRound>;
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  landed?(note: NoteRecord): void;
  sent?(hash: string): void;
  progress?(stage: TradeStage): void;
  /** U cannot pay the next rung and its fee: the wei it is short. */
  short?(address: string, wei: bigint): void;
  /** The device's cap on the priority fee, wei per gas (EVM_DEPOSIT_PRIORITY_CAP otherwise). */
  priorityCap?: bigint;
  /** The device's clock, ms since the epoch (Date.now otherwise): when a send left, for EVM_DEPOSIT_RESEND_MS. */
  now?(): number;
  reads?: number;
  wait?(ms: number): Promise<void>;
  end?(): void;
  /** The run's end, past a send of its ask: the ask's notes still INCOMING (poolDepositEvmKind reads them on). */
  left?(left: PoolDepositEvmLeft): void;
  /** The load and state-read pass (settle, no ask), started by the end's reads when U's finalized nonce is past every
   *  send of an open note with no Deposited naming it, so the note is built again without waiting on a state read. */
  settle?(): void;
  /** Aborted when the page leaves the deposit (sign out): the end's reads stop, telling nothing. */
  signal?: AbortSignal;
};

/** An ask's notes still INCOMING at its run's end (each: its precommitment, its recorded value, the highest nonce of its
 *  sends and its U), whether any note of the ask landed, and whether the ask was all sent (`whole`). */
export type PoolDepositEvmLeft = { notes: { precommitment: bigint; value: bigint; nonce: bigint; u: string }[]; landed: boolean; whole: boolean };

/** The wait between the kind's reads of an ask's open notes once its run ended with no verdict (a Deposited is final
 *  ~1,000 s after it lands, and each read is a round of the pool's events). */
export const POOL_DEPOSIT_EVM_FOLLOW_MS = 10_000;

/** The priority fee U offers, wei per gas: 0.01 gwei, above what Base's blocks include at (a tip that never lands
 *  holds U's nonce); Robinhood (Nitro) ignores it. */
export const EVM_DEPOSIT_PRIORITY_CAP = 10_000_000n;
/** Verdict reads the ask's own send gets in its run, POOL_DEPOSIT_EVM_WAIT_MS apart. One: a Deposited is final on
 *  both RPCs only after Base 1,061 s, Base Sepolia 1,341 s, Robinhood 1,088 s, Robinhood testnet 1,439 s (measured on
 *  two public RPCs per chain, 2026-11-07 06:12Z), so no wait inside a run sees it, and a run holding the deposit lock
 *  that long would hold every other deposit. The note settles in the load and state-read pass (settle). */
export const POOL_DEPOSIT_EVM_READS = 1;
export const POOL_DEPOSIT_EVM_WAIT_MS = 2_000;
/** A run builds one note's send again at most this many times (each only once the last is dead on both RPCs, or
 *  reached neither). */
export const POOL_DEPOSIT_EVM_REBUILDS = 3;
/** Each network's block interval, ms, the slower of two public RPCs' mean over 100 and 1,000 blocks (2026-11-07): Base
 *  and Base Sepolia 200; Robinhood Chain 110; Robinhood testnet 180 to 204, so 204. */
export const EVM_BLOCK_MS: Readonly<Record<EvmNetwork, bigint>> = Object.freeze({ base: 200n, "base-sepolia": 200n, robinhood: 110n, "robinhood-testnet": 204n });
/**
 * How long after a send left the device (its sentMs, or the run's own send again of the same bytes, whichever is later)
 * a send that reached neither RPC is built again at its nonce: the page client's deadline for one call with its retry
 * (EVM_READ_TRY_MS, 3.5 s) plus one block interval. A send still on its way is never taken for lost; at the same nonce
 * at most one of the sends can land in any case.
 */
export const EVM_DEPOSIT_RESEND_MS: Readonly<Record<EvmNetwork, bigint>> = Object.freeze(
  Object.fromEntries(Object.entries(EVM_BLOCK_MS).map(([n, ms]) => [n, EVM_READ_TRY_MS + ms])) as Record<EvmNetwork, bigint>,
);
/** Notes one run may settle or try (landed, taken, or deposited): a front-runner who takes every send ends the run. */
const STEPS_MAX = 16;
const LANDED: readonly NoteState[] = ["UNSPENT", "HELD", "RESERVED", "SPENT", "TAKEN"];

const hex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const qty = (v: bigint): string => "0x" + v.toString(16);
/** A JSON-RPC quantity from a provider: hostile until read. */
function quantity(x: unknown, what: string): bigint {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error(`${what}: not a quantity`);
  return BigInt(x);
}
/** An eth_call answer's first word. */
function firstWord(x: unknown, what: string): bigint {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64,}$/.test(x)) throw new Error(`${what}: not a word`);
  return BigInt("0x" + x.slice(2, 66));
}
/** Two RPCs whose answers to one read differ: no read at all, and the run answers failed (as the Solana runner does). */
export class EvmDepositDisagree extends Error {
  constructor(m: string) {
    super(m);
    this.name = "EvmDepositDisagree";
  }
}
const apart = (what: string): never => {
  throw new EvmDepositDisagree(`the two RPCs read ${what} apart`);
};
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc, k: number) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0], 0), f(rpcs[1], 1)]);

/** U's chain of notes: the first note (its deposit note) of a deposit or a U second arrival of `scope`; null otherwise. */
function firstOf(ref: NoteRef, scope: bigint): Extract<NoteRef, { kind: "deposit" }> | null {
  if (ref.kind === "deposit") return ref.s === scope ? ref : null;
  if (ref.kind === "second" && ref.id.id === "U" && ref.id.s === scope) return { kind: "deposit", s: ref.id.s, i: ref.id.i };
  return null;
}
const sameRef = (a: NoteRef, b: NoteRef): boolean => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}` : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}` : v));

/** A run's own: the host, the store, the seed, the pool's scope, the keys to zero, and when this run last sent each
 *  hash (a send again of the very bytes restarts EVM_DEPOSIT_RESEND_MS). */
type Run = { h: PoolDepositEvmHost; store: NoteStore; seed: Uint8Array; scope: bigint; chainId: bigint; keys: Uint8Array[]; ask: PoolAsk; sentAt: Map<string, bigint> };
const nowOf = (r: Run): bigint => BigInt(Math.floor((r.h.now ?? Date.now)()));

/** U's reads at one block both RPCs hold: the block, U's nonce and the base fee (agreed; each RPC's reading kept for
 *  the rule's own check) and its balance (each RPC's). */
async function accountReads(r: Run, u: string): Promise<{ block: bigint; tag: string; baseFee: bigint; baseFees: [bigint, bigint]; nonce: bigint; nonces: [bigint, bigint]; balance: [bigint, bigint] }> {
  const sleep = (ms: number) => (r.h.wait ?? ((x: number) => new Promise<void>((ok) => setTimeout(ok, x))))(ms);
  // the newest block both hold (a lag read again), then its base fee as each RPC answers it: the two the same
  const blk = await evmRetryLag(() => evmAgreedBlock(r.h.rpcs, "latest", undefined, sleep), sleep);
  const tag = qty(blk.number);
  const fees = await both(r.h.rpcs, async (rpc, k) => {
    const b = (await rpc("eth_getBlockByNumber", [tag, false])) as { baseFeePerGas?: unknown } | null;
    return quantity(b?.baseFeePerGas, `rpc ${k} base fee`);
  });
  if (fees[0] !== fees[1] || blk.baseFeePerGas !== fees[0]) apart("the base fee");
  const nonce = await both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [u, tag]), `rpc ${k} nonce`));
  if (nonce[0] !== nonce[1]) apart("U's nonce");
  const balance = await both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_getBalance", [u, tag]), `rpc ${k} balance`));
  return { block: blk.number, tag, baseFee: fees[0], baseFees: fees, nonce: nonce[0], nonces: nonce, balance };
}

const DEPTH_CALLS = Object.freeze([selectorOf("currentTreeDepth()"), selectorOf("currentLabelTreeDepth()")]);
function selectorOf(sig: string): string {
  return hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
}
/** The pool's state and label tree depths at `tag`, each as both RPCs read it (they must agree). */
async function depthsOf(r: Run, tag: string): Promise<{ state: [bigint, bigint]; label: [bigint, bigint] }> {
  const out: [bigint, bigint][] = [];
  for (const data of DEPTH_CALLS) {
    const d = await both(r.h.rpcs, async (rpc, k) => firstWord(await rpc("eth_call", [{ to: r.h.pin.pool, data }, tag]), `rpc ${k} tree depth`));
    if (d[0] !== d[1]) apart("the pool's tree depth");
    out.push(d);
  }
  return { state: out[0]!, label: out[1]! };
}

/** The L1 fee bound for `gas` on the pin's network, as each RPC's chain fee reads give it (the kit's reads; they must
 *  agree), 0 on Nitro. */
async function l1FeesOf(r: Run, gas: bigint, tag: string): Promise<[bigint, bigint]> {
  const net = r.h.pin.network;
  if (net === "robinhood" || net === "robinhood-testnet") return [0n, 0n];
  const calls = evmPoolChainFeeReads(net, gas);
  const answers: [bigint[], bigint[]] = [[], []];
  for (const c of calls) {
    const [a, b] = await both(r.h.rpcs, async (rpc, k) => firstWord(await rpc("eth_call", [{ to: c.to, data: c.data }, tag]), `rpc ${k} chain fee`));
    if (a !== b) apart("the chain fee");
    answers[0].push(a);
    answers[1].push(b);
  }
  return [evmPoolChainFee(net, EVM_POOL_TX_BYTES, answers[0]), evmPoolChainFee(net, EVM_POOL_TX_BYTES, answers[1])];
}

/** What one try at a note came to. */
type Try =
  | { kind: "sent"; note: NoteRecord; hash: string; u: string }
  | { kind: "taken" } // the note was restored as the user's (a Deposited named it): go on to the next
  | { kind: "claimed" } // notes before it written landed: go on
  | { kind: "wait" } // a take not final yet stands before it
  | { kind: "keep"; short: bigint; u: string }
  | { kind: "sim_failed" }
  | { kind: "moved" }; // a send again at its nonce, but U's nonce moved since: not built

/**
 * One try at U's next note (or, with `again`, the open note `again` at its recorded value): picked through evmNextNote
 * over the pool's events, priced on both RPCs, checked by the rule, simulated on both, written INCOMING (or its send
 * added) and only then sent to both RPCs.
 */
async function tryNote(r: Run, first: Extract<NoteRef, { kind: "deposit" }>, again: NoteRecord | null, want: bigint, atNonce?: bigint): Promise<Try> {
  const round = await r.h.round();
  // the pick: the device never signs a precommitment the pool already holds (signer guard)
  const pick = evmNextNote(r.seed, r.scope, round.events, first, round.finalBlock);
  if (pick.taken.length > 0) {
    const all = await r.store.list();
    const fresh = pick.taken.filter((t) => !all.some((n) => sameRef(n.ref, t.ref) && LANDED.includes(n.state)));
    if (fresh.length > 0) {
      for (const n of await evmClaimTaken(r.store, fresh)) r.h.landed?.(n);
      if (again !== null && fresh.some((t) => sameRef(t.ref, again.ref))) return { kind: "taken" };
      if (again === null) return { kind: "claimed" };
    }
  }
  const id = depositIdEvm(r.seed, first.s, first.i);
  r.keys.push(id.secretKey);
  const u = id.address;
  const acct = await accountReads(r, u);
  // a send that reached neither RPC is built again at its own nonce only, so at most one of the two can land
  if (atNonce !== undefined && acct.nonce !== atNonce) return { kind: "moved" };
  const tip = r.h.priorityCap ?? EVM_DEPOSIT_PRIORITY_CAP;
  const maxFee = 2n * acct.baseFee + tip;
  const low = acct.balance[0] < acct.balance[1] ? acct.balance[0] : acct.balance[1];
  // the store's notes as the pick sees them: the open note built again is the chain's next note, not settled first
  const held = (await r.store.list()).map((n) => (again !== null && n.id === again.id ? { ref: n.ref, state: "PLANNED" as NoteState } : { ref: n.ref, state: n.state }));
  const sentValue = again?.evmSends?.[0]?.value;
  // the rung: within the ask (a send again: its recorded value exactly), U's lower reading, its cost
  const priced = (cost: bigint) => {
    const cap = (sentValue ?? want) + cost;
    return evmSameChainDeposit({ pin: r.h.pin, seed64: r.seed, scope: r.scope, ladder: EVM_LADDER, first, held, events: round.events, finalBlock: round.finalBlock, balance: low < cap ? low : cap, cost });
  };
  // the tree's headroom over any estimate (the pool's two depths, both RPCs); first at the cap's gas with it, then at
  // the estimate both RPCs agree on for the call that gives, with it
  const depths = await depthsOf(r, acct.tag);
  const room = evmDepositHeadroom(depths.state[0], depths.label[0]);
  const capGas = EVM_DEPOSIT_GAS_MAX + room;
  const bound = capGas * maxFee + (await l1FeesOf(r, capGas, acct.tag))[0];
  let step = priced(bound);
  if (step.kind === "wait") return { kind: "wait" };
  if (step.kind === "claim") return { kind: "claimed" };
  // short: the rung this ask goes in at first (the ladder's split of what is left of it, or the open note's recorded
  // value) and the fee bound, less U's lower reading
  const need = sentValue ?? (want > 0n ? ladderSplit(EVM_LADDER, want).notes[0] : undefined) ?? EVM_LADDER.min;
  if (step.kind !== "deposit" || step.call === undefined) return { kind: "keep", short: need + bound > low ? need + bound - low : 0n, u };
  if (sentValue !== undefined && (step.value !== sentValue || !sameRef(step.ref, again!.ref))) return { kind: "keep", short: sentValue + bound > low ? sentValue + bound - low : 0n, u };
  const estimateOf = async (call: { to: string; value: bigint; data: string }) =>
    both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_estimateGas", [{ from: u, to: call.to, value: qty(call.value), data: call.data }, acct.tag]), `rpc ${k} estimate`));
  let estimate = await estimateOf(step.call);
  if (estimate[0] !== estimate[1]) apart("the deposit's gas estimate");
  if (estimate[0] > EVM_DEPOSIT_GAS_MAX) throw new PoolRuleRefused("gas_over_cap");
  let l1 = await l1FeesOf(r, estimate[0] + room, acct.tag);
  if (sentValue === undefined) {
    const better = priced((estimate[0] + room) * maxFee + l1[0]);
    if (better.kind === "deposit" && better.call !== undefined && better.value > step.value && sameRef(better.ref, step.ref)) {
      const e2 = await estimateOf(better.call);
      if (e2[0] === e2[1] && e2[0] === estimate[0]) step = better;
      else if (e2[0] === e2[1] && e2[0] <= EVM_DEPOSIT_GAS_MAX) ((estimate = e2), (step = better), (l1 = await l1FeesOf(r, e2[0] + room, acct.tag)));
    }
  }
  const call = step.call!;
  const gasLimit = estimate[0] + room;
  const tx: EvmOnwardSend = { type: 2, chainId: r.chainId, nonce: acct.nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to: call.to, value: call.value, data: call.data, accessList: [] };
  // a send again is of the value an earlier ask signed for: the check holds it to that
  const ask = sentValue !== undefined ? { ...r.ask, amount: sentValue } : { ...r.ask, amount: want };
  // U's balance at the padded limit: a send again U can no longer pay is `keep`, its top-up named
  if (call.value + gasLimit * maxFee + l1[0] > low) return { kind: "keep", short: call.value + gasLimit * maxFee + l1[0] - low, u };
  checkEvmDeposit(tx, ask, { wallet: u, precommitment: step.precommitment, call, pin: r.h.pin }, { nonce: acct.nonces, balance: acct.balance, estimate, baseFee: acct.baseFees, l1Fee: l1, stateDepth: depths.state, labelDepth: depths.label, priorityCap: tip }, r.h.testnet);
  // simulated on both before U signs: a failure on either signs nothing
  const sim = await Promise.allSettled(r.h.rpcs.map((rpc) => rpc("eth_call", [{ from: u, to: call.to, value: qty(call.value), data: call.data, gas: qty(gasLimit) }, acct.tag])));
  if (sim.some((s) => s.status === "rejected")) return { kind: "sim_failed" };
  const raw = signEvmDeposit(id.secretKey, tx);
  const send: EvmPoolSend = { hash: hex(keccak_256(raw)), nonce: acct.nonce, value: call.value, sentMs: nowOf(r) };
  // the state and its send, written before the signed tx leaves the device
  let note: NoteRecord;
  if (again !== null && (again.evmSends ?? []).some((x) => x.hash === send.hash)) {
    // built again at its own nonce with fees unchanged: the very tx already written, never received; sent as it is
    note = again;
  } else if (again !== null) {
    const seen = again.evmSends?.length ?? 0;
    note = await r.store.addEvmSend(again.id, send, seen);
    if ((note.evmSends ?? []).length !== seen + 1 || note.evmSends!.at(-1)!.hash !== send.hash) return { kind: "sim_failed" }; // another run's send came first
  } else {
    const all = await r.store.list();
    const planned = all.find((n) => sameRef(n.ref, step.ref)) ?? (await r.store.add({ ref: step.ref, scope: r.scope, precommitment: step.precommitment, state: "PLANNED" }));
    if (planned.state !== "PLANNED" || planned.precommitment !== step.precommitment) throw new Error("the note to deposit is not PLANNED");
    note = await r.store.move(planned.id, "PLANNED", "INCOMING", { evmSend: send });
  }
  // the send's clock starts as it leaves (a send again of the very bytes restarts it)
  r.sentAt.set(send.hash, nowOf(r));
  await Promise.allSettled(r.h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hex(raw)])));
  return { kind: "sent", note, hash: send.hash, u };
}

/** An open note's verdict, read once. */
type Verdict = { kind: "landed"; note: NoteRecord; filled: boolean } | { kind: "pending" } | { kind: "dead" } | { kind: "unsent"; nonce: bigint };
async function verdictOf(r: Run, n: NoteRecord): Promise<Verdict> {
  const first = firstOf(n.ref, r.scope)!;
  // U's finalized nonce before the round (card pool-deposit-sent-end): a send final by its nonce is then in the round's
  // events, so one that lands between the two reads is read landed, never dead and built again
  const last = n.evmSends?.at(-1);
  const id = depositIdEvm(r.seed, first.s, first.i);
  r.keys.push(id.secretKey);
  const fin = last === undefined ? null : await both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [id.address, "finalized"]), `rpc ${k} finalized nonce`));
  const round = await r.h.round();
  let pick: ReturnType<typeof evmNextNote>;
  try {
    pick = evmNextNote(r.seed, r.scope, round.events, first, round.finalBlock);
  } catch (e) {
    if (e instanceof EvmNotFinalError) return { kind: "pending" }; // a Deposited not final yet: never dead
    throw e;
  }
  if (pick.taken.some((t) => sameRef(t.ref, n.ref))) {
    for (const c of await evmClaimTaken(r.store, pick.taken)) r.h.landed?.(c);
    const now = (await r.store.get(n.id))!;
    return { kind: "landed", note: now, filled: now.leaf?.value === n.evmSends?.[0]?.value };
  }
  // a Deposited naming it in a block not final yet: pending, never dead
  if (pick.pending.some((p) => sameRef(p, n.ref))) return { kind: "pending" };
  if (last === undefined || fin === null) return { kind: "dead" }; // INCOMING with no send: nothing left the device for it
  // dead only when U's finalized nonce passed the send on BOTH RPCs and no Deposited names it on either
  if (fin[0] > last.nonce && fin[1] > last.nonce) return { kind: "dead" };
  // reached neither RPC: old enough, no RPC knows any of the note's hashes, and U's latest and pending nonces both still
  // the send's on both. Anything else is pending
  // old enough: EVM_DEPOSIT_RESEND_MS since the last send left the device (its record, or this run's send again)
  if (last.sentMs === undefined) return { kind: "pending" };
  const ran = r.sentAt.get(last.hash);
  const left = ran !== undefined && ran > last.sentMs ? ran : last.sentMs;
  if (nowOf(r) < left + EVM_DEPOSIT_RESEND_MS[r.h.pin.network]) return { kind: "pending" };
  const hashes = n.evmSends!.map((x) => x.hash);
  const known = await both(r.h.rpcs, async (rpc) => (await Promise.all(hashes.map((x) => rpc("eth_getTransactionByHash", [x])))).some((t) => t !== null));
  if (known[0] || known[1]) return { kind: "pending" };
  for (const tag of ["latest", "pending"]) {
    const nonce = await both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [id.address, tag]), `rpc ${k} ${tag} nonce`));
    if (nonce[0] !== last.nonce || nonce[1] !== last.nonce) return { kind: "pending" };
  }
  return { kind: "unsent", nonce: last.nonce };
}

/** How an open note's reads in one run ended: landed (or taken: restored at the value its Deposited carried), still
 *  pending (maybe sent again), or stuck (its send again U cannot pay: the top-up `short` names). */
type End = { kind: "landed"; note: NoteRecord; filled: boolean; hash: string | undefined } | { kind: "pending" } | { kind: "stuck"; short: bigint; u: string };

/** An INCOMING note read up to `reads` times, POOL_DEPOSIT_EVM_WAIT_MS apart; a dead send built again (a send that
 *  reached neither RPC at its own nonce), at most POOL_DEPOSIT_EVM_REBUILDS times. `sent` hears each send again. */
async function follow(r: Run, n: NoteRecord, reads: number, wait: (ms: number) => Promise<void>, sent: (hash: string, note: NoteRecord) => void): Promise<End> {
  let note = n;
  let rebuilds = 0;
  for (let k = 0; k < reads; k++) {
    if (k > 0) await wait(POOL_DEPOSIT_EVM_WAIT_MS);
    const v = await verdictOf(r, note);
    if (v.kind === "landed") return { kind: "landed", note: v.note, filled: v.filled, hash: note.evmSends?.at(-1)?.hash };
    if (v.kind === "pending") continue;
    // dead on both RPCs: the same note again from fresh reads at U's new nonce; reached neither: at its own nonce
    if (++rebuilds > POOL_DEPOSIT_EVM_REBUILDS) return { kind: "pending" };
    const t = await tryNote(r, firstOf(note.ref, r.scope)!, note, 0n, v.kind === "unsent" ? v.nonce : undefined);
    if (t.kind === "sent") {
      note = t.note;
      sent(t.hash, t.note);
      continue;
    }
    if (t.kind === "taken") {
      const now = (await r.store.get(note.id))!;
      return { kind: "landed", note: now, filled: false, hash: undefined };
    }
    if (t.kind === "keep") return { kind: "stuck", short: t.short, u: t.u };
    return { kind: "pending" };
  }
  return { kind: "pending" };
}

/** An open note of an ask, read once with nothing written: "landed", "dead", "expired" or null. Followed by its own
 *  record (card pool-deposit-sent-end review 1): past INCOMING, "landed" at its recorded value, else "dead" (taken);
 *  INCOMING, its sends' highest nonce read on chain. U's finalized nonce is read before the round, so a send final by its
 *  nonce is in the round's events. A final Deposited at its value: landed; at another value: dead (taken: the pool
 *  refuses a used precommitment, so it is never built again). U's finalized nonce past every send on both RPCs with no
 *  Deposited naming it: "expired", no end, since the pass builds the note again at U's new nonce from U's money. */
async function noteEndEvm(h: PoolDepositEvmHost, n: PoolDepositEvmLeft["notes"][number]): Promise<"landed" | "dead" | "expired" | null> {
  const scope = evmPoolScopeOf(h.pin.pool, EVM_CHAIN_IDS[h.pin.network]);
  const store = await h.notes();
  let rec: NoteRecord | undefined;
  try {
    rec = (await store.list()).find((x) => x.scope === scope && x.precommitment === n.precommitment);
  } finally {
    h.end?.();
  }
  if (rec !== undefined && rec.state !== "INCOMING") return rec.state === "PLANNED" ? null : rec.leaf?.value === n.value ? "landed" : "dead";
  const nonce = (rec?.evmSends ?? []).reduce((m, x) => (x.nonce > m ? x.nonce : m), n.nonce);
  const fin = await both(h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [n.u, "finalized"]), `rpc ${k} finalized nonce`));
  const round = await h.round();
  const d = round.events.find((e) => e.kind === "deposit" && e.precommitment === n.precommitment);
  if (d !== undefined) return d.block > round.finalBlock ? null : d.value === n.value ? "landed" : "dead";
  return fin[0] > nonce && fin[1] > nonce ? "expired" : null;
}

/** The end of an ask whose run ended with no verdict: its open notes read until each is landed or dead (a read that
 *  fails is read again), with no lock held and nothing written: every POOL_DEPOSIT_EVM_FOLLOW_MS while a send may land,
 *  doubling to POOL_DEPOSIT_FOLLOW_MAX_MS while nothing can move without the pass (every send dead: the pass is
 *  started, `settle`) or a read fails. Null, telling nothing, once the page leaves the deposit (`signal`) or past
 *  POOL_DEPOSIT_FOLLOW_FOR_MS of waits: the note stays INCOMING for the pass. */
export async function followPoolDepositEvm(h: PoolDepositEvmHost, left: PoolDepositEvmLeft): Promise<"filled" | "part_filled" | "not_landed" | null> {
  const wait = h.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const ends: ("landed" | "dead" | null)[] = left.notes.map(() => null);
  let gap = POOL_DEPOSIT_EVM_FOLLOW_MS;
  let spent = 0;
  for (;;) {
    if (h.signal?.aborted) return null;
    let quiet = true;
    let kick = false;
    for (const [k, n] of left.notes.entries()) {
      if (ends[k] !== null) continue;
      const e = await noteEndEvm(h, n).catch(() => "fault" as const);
      if (e === "landed" || e === "dead") ends[k] = e;
      else if (e === "expired") kick = true;
      else if (e === null) quiet = false;
    }
    if (ends.every((e) => e !== null)) break;
    if (kick) h.settle?.();
    if (!quiet) gap = POOL_DEPOSIT_EVM_FOLLOW_MS;
    if (spent + gap > POOL_DEPOSIT_FOLLOW_FOR_MS) return null;
    await wait(gap);
    spent += gap;
    if (quiet) gap = Math.min(gap * 2, POOL_DEPOSIT_FOLLOW_MAX_MS);
  }
  if (h.signal?.aborted) return null;
  if (left.whole && ends.length > 0 && ends.every((e) => e === "landed")) return "filled";
  return left.landed || ends.includes("landed") ? "part_filled" : "not_landed";
}

/** The run: an ask (pool.deposit on an EVM chain), or null to settle the scope's open notes only. */
export async function runPoolDepositEvm(h: PoolDepositEvmHost, ask: PoolAsk | null): Promise<PoolDepositAnswer> {
  if (ask !== null && (ask.kind !== "pool.deposit" || ask.chain === "solana")) return { error: "not_allowed" };
  const seed = await h.seed64();
  const keys: Uint8Array[] = [];
  const landedTxs: TxRef[] = [];
  const sentTxs: TxRef[] = [];
  const chain = ask?.chain ?? (h.pin.network === "robinhood" || h.pin.network === "robinhood-testnet" ? "robinhood" : "base");
  const wait = h.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  // the ask's own notes that landed this run (each counted whether or not a tx is named for it)
  let landed = 0;
  // a send of the pass (an earlier note's, sent again) may land too: the run is never "failed" past it
  let passSent = false;
  // the ask's own notes sent this run (each: its precommitment, recorded value, highest nonce sent and U), kept as each
  // send leaves, and whether the ask was all sent: what the kind reads on (`left`). Held in memory, so the run's end
  // zeroes the seed and U's keys before any store read (review 6)
  const askNotes = new Map<NoteRecord["id"], PoolDepositEvmLeft["notes"][number]>();
  const keep = (n: NoteRecord, u: string): void => {
    const sends = n.evmSends ?? [];
    if (sends.length > 0) askNotes.set(n.id, { precommitment: n.precommitment, value: sends[0]!.value, nonce: sends.reduce((m, x) => (x.nonce > m ? x.nonce : m), 0n), u });
  };
  let whole = false;
  let opened: NoteStore | null = null;
  try {
    const store = await h.notes();
    opened = store;
    const chainId = EVM_CHAIN_IDS[h.pin.network];
    const scope = evmPoolScopeOf(h.pin.pool, chainId);
    const r: Run = { h, store, seed, scope, chainId, keys, ask: ask ?? { kind: "pool.deposit", chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, sentAt: new Map() };
    const mine = async () => (await store.list()).filter((n) => n.scope === scope && firstOf(n.ref, scope) !== null);

    // the pass: each INCOMING note of the scope read once, as its own move, never waited on; its U no source this run
    // while it stays open. Its landing and its sends are never the ask's.
    const busy = new Set<number>();
    const pending = new Set<number>(); // the U of a note still landing (not one stuck on its top-up)
    let stuck = false;
    for (const n of (await mine()).filter((x) => x.state === "INCOMING")) {
      const i = firstOf(n.ref, scope)!.i;
      const end = await follow(r, n, 1, wait, () => void (passSent = true));
      if (end.kind === "landed") continue;
      busy.add(i);
      if (end.kind === "pending") pending.add(i);
      else {
        stuck = true;
        h.short?.(end.u, end.short);
      }
    }
    if (ask === null) return busy.size === 0 ? { stage: "filled", txs: [] } : stuck && !passSent ? { error: "not_funded" } : { stage: "not_landed", txs: [] };

    // a U still landing a note holds `value` once that note lands. Per RPC: U's balance at the newest block both hold,
    // less the note's value while U's nonce there has not passed its last send (a mined send is out of the balance
    // already); the lower of the two RPCs' readings decides, so neither alone makes the ask wait
    const coversOnceLanded = async (value: bigint): Promise<boolean> => {
      const open = (await mine()).filter((n) => n.state === "INCOMING");
      for (const i of pending) {
        const id = depositIdEvm(seed, scope, i);
        keys.push(id.secretKey);
        const acct = await accountReads(r, id.address);
        const out = open.filter((n) => firstOf(n.ref, scope)!.i === i && (n.evmSends?.at(-1)?.nonce ?? acct.nonce) >= acct.nonce).reduce((t, n) => t + (n.evmSends?.[0]?.value ?? 0n), 0n);
        const low = acct.balance[0] < acct.balance[1] ? acct.balance[0] : acct.balance[1];
        if (low - out >= value) return true;
      }
      return false;
    };

    // an ask below the ladder's smallest rung has no note to deposit (the Solana runner's rule): refused, nothing planned
    if (ladderSplit(EVM_LADDER, ask.amount).notes.length === 0) return { error: "not_allowed" };
    let left = ask.amount;
    let simAgain = false;
    for (let steps = 0; steps < STEPS_MAX; steps++) {
      if (left < EVM_POOL_MIN_DEPOSIT) break;
      // the source: the newest U with no open note that landed a note, while it covers a rung; else the planned index
      const all = await mine();
      const used = all.filter((n) => LANDED.includes(n.state)).map((n) => firstOf(n.ref, scope)!.i).filter((i) => !busy.has(i));
      let t: Try | null = null;
      if (used.length > 0) {
        t = await tryNote(r, { kind: "deposit", s: scope, i: Math.max(...used) }, null, left);
        if (t.kind === "keep") t = null;
      }
      if (t === null) {
        const planned = await store.planDeposit(scope, (ref) => noteSecrets(seed, ref).precommitment);
        t = await tryNote(r, planned.ref as Extract<NoteRef, { kind: "deposit" }>, null, left);
      }
      if (t.kind === "sent") {
        keep(t.note, t.u);
        const u = t.u;
        whole = left - (t.note.evmSends?.[0]?.value ?? 0n) < EVM_POOL_MIN_DEPOSIT;
        sentTxs.push({ chain, hash: t.hash });
        h.sent?.(t.hash);
        h.progress?.("sent");
        const i = firstOf(t.note.ref, scope)!.i;
        const end = await follow(r, t.note, h.reads ?? POOL_DEPOSIT_EVM_READS, wait, (hash, note) => {
          keep(note, u);
          sentTxs.push({ chain, hash });
          h.sent?.(hash);
        });
        if (end.kind === "landed") {
          landed++;
          if (end.hash !== undefined) landedTxs.push({ chain, hash: end.hash });
          if (end.filled) left -= left < end.note.leaf!.value ? left : end.note.leaf!.value;
          h.progress?.("filled");
          continue;
        }
        // still landing (the next load settles it), or its send again U cannot pay: the ask ends here with its sends
        busy.add(i);
        if (end.kind === "stuck") h.short?.(end.u, end.short);
        return landed ? { stage: "part_filled", txs: landedTxs } : { stage: "sent", txs: sentTxs };
      }
      if (t.kind === "taken" || t.kind === "claimed") {
        simAgain = false; // a new note: its own simulation, and its own second try
        continue;
      }
      if (t.kind === "wait" || t.kind === "moved") return landed ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: [] };
      if (t.kind === "sim_failed") {
        // the pool may have moved: read and simulate once more, then not_funded
        if (!simAgain) {
          simAgain = true;
          continue;
        }
        return landed ? { stage: "part_filled", txs: landedTxs } : { error: "not_funded" };
      }
      // keep: U cannot carry a rung and its fee
      if (landed) return { stage: left >= EVM_POOL_MIN_DEPOSIT ? "part_filled" : "filled", txs: landedTxs };
      // an earlier note still landing on a U that covers this rung once it lands: try again then; else the ask's own U
      // is short, and the top-up names it
      if (await coversOnceLanded(ladderSplit(EVM_LADDER, left).notes[0] ?? EVM_LADDER.min)) return { stage: "not_landed", txs: [] };
      h.short?.(t.u, t.short);
      return { error: "not_funded" };
    }
    // the run's step cap (a front-runner taking note after note) with the ask not all in: what landed, never filled
    if (left >= EVM_POOL_MIN_DEPOSIT) return landed ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: sentTxs };
    return { stage: "filled", txs: landedTxs };
  } catch (e) {
    // a send may have left: never failed while it may land
    if (sentTxs.length > 0) return { stage: "sent", txs: sentTxs };
    if (landed > 0) return { stage: "part_filled", txs: landedTxs };
    // a take not final yet before the note to sign: "not now" (pool-kinds.ts answers it busy), nothing signed
    if (e instanceof EvmNotFinalError) throw e;
    if (e instanceof PoolRuleRefused) return { error: "not_allowed" };
    // a provider read that still fails after the page's own retry (or a lag past its tries), before U signs: "not now"
    // (card pool-read-down); any other fault before a send (two RPCs that read apart, an answer out of shape): failed,
    // except past a send of the pass, which may land: not_landed
    if (e instanceof SolanaRpcTransportError || e instanceof EvmUnansweredError || e instanceof EvmLagError) return { error: "down" };
    if (passSent) return { stage: "not_landed", txs: [] };
    return { error: "failed" };
  } finally {
    // the seed and U's keys zeroed before any await (review 6: a store read that never settles never keeps them)
    seed.fill(0);
    for (const k of keys) k.fill(0);
    // past a send of the ask: its notes still INCOMING, for the kind's end (a store that cannot be read hands none, so
    // nothing is told on a read that did not happen)
    const store = opened;
    if (ask !== null && sentTxs.length > 0 && store !== null) {
      try {
        const notes: PoolDepositEvmLeft["notes"] = [];
        for (const [id, x] of askNotes) if ((await store.get(id))?.state === "INCOMING") notes.push(x);
        h.left?.({ notes, landed: landed > 0, whole });
      } catch {
        // no end handed: the note settles at the next load, as before
      }
    }
  }
}

type Locks = Pick<LockManager, "request">;
/** pool.deposit on an EVM pool, under the seed's shared lock and POOL_DEPOSIT_LOCK (one deposit run at a time, Solana's
 *  and the EVM's alike): answered at its first send, or at its end when nothing was sent. */
export function poolDepositEvmKind(host: () => PoolDepositEvmHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk | null, ctx: KindContext | null): HostRefusal | Running<"pool.deposit"> => {
    if ((ask !== null && (ask.kind !== "pool.deposit" || ask.chain === "solana")) || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.deposit"> | HostRefusal | null = null;
    let give!: () => void;
    let fail!: (e: unknown) => void;
    const answered = new Promise<void>((ok, no) => ((give = ok), (fail = no)));
    const chain = ask?.chain ?? "base";
    // a run that ends with no verdict past its ask's send: its open notes, read on once the locks are let go
    let follow: { h: PoolDepositEvmHost; left: PoolDepositEvmLeft } | null = null;
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(POOL_DEPOSIT_LOCK, { mode: "exclusive" }, async () => {
          const h = host();
          let first = true;
          const sent = (hash: string): void => {
            if (!answer) answer = { result: { stage: "sent", txs: [{ chain, hash }] } };
            give();
          };
          // the first "sent" is the answer itself
          const progress = (stage: TradeStage): void => (stage === "sent" && first ? void (first = false) : ctx?.progress(stage));
          let left: PoolDepositEvmLeft | null = null;
          try {
            const a = await runPoolDepositEvm({ ...h, sent, progress, left: (l) => void (left = l) }, ask);
            const l = left as PoolDepositEvmLeft | null;
            // filled or part_filled is the ask's end; anything else past a send of the ask (sent, not_landed, a fault)
            // is no end: its open notes are read on, and the end goes as progress once each is landed or dead
            // filled is the ask's end, and part_filled with no note of the ask still INCOMING (review 3: a send that may
            // still land is followed to a real end, never told part filled)
            const ended = "stage" in a && (a.stage === "filled" || (a.stage === "part_filled" && (l === null || l.notes.length === 0)));
            if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
            else if (ended) ctx?.progress((a as { stage: TradeStage }).stage);
            else if (l !== null) follow = { h, left: l };
          } finally {
            h.end?.();
          }
        }),
      )
      .then(give, (e: unknown) => {
        // evmNextNote's wait for finality reaches pool-kinds as the run's wait rejecting with it (busy)
        if (e instanceof EvmNotFinalError && !answer) return fail(e);
        if (!answer) answer = { error: "failed" };
        give();
      });
    // the end, read with no lock held (a sign out never waits on it) and nothing written; a wait that rejects stops it
    void run.then(() => {
      const f = follow;
      if (f !== null && ctx !== null) return followPoolDepositEvm(f.h, f.left).then((stage) => void (stage !== null && ctx.progress(stage)), () => {});
    });
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
