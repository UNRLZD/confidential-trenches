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
//   0 on Robinhood (Nitro's L1 cost is in its gas). Cost = gasLimit x maxFee + l1Fee, maxFee = 2 x baseFee + tip.
// - Before anything is written: the tx is checked by the rule (rules/pool.ts checkEvmDeposit) and simulated on BOTH RPCs
//   (eth_call from U with the value and data). A failure on either signs nothing. If a Deposited already names the
//   precommitment, the note was taken: it is restored as the user's (evmClaimTaken, at the value that deposit carried)
//   and the run goes on to the next note. If none names it, the run reads and simulates once more before not_funded.
// - The note goes PLANNED -> INCOMING with its send { hash, nonce, value } written BEFORE eth_sendRawTransaction leaves
//   for both RPCs; a send built again is written first too (addEvmSend), at the note's recorded value.
// - The verdict: a Deposited naming the precommitment at the round's finalized block (both RPCs, evmTreeSync's events
//   and evmNextNote) moves the note to UNSPENT with its leaf; one at another value is a take, the note restored at that
//   value. A send is dead ONLY when U's finalized nonce has passed it on BOTH RPCs and no Deposited names the
//   precommitment on either (final or not): then it is built again from fresh reads at the new nonce on the SAME note,
//   never the old bytes, at most POOL_DEPOSIT_EVM_REBUILDS times a run. Anything else is pending: the note stays
//   INCOMING and the answer is "sent" or "not_landed", never failed.
// - An INCOMING note of the scope (a run a reload cut) is settled first, every run; while it is open no index is planned
//   and nothing new is signed.
// - Every read names a public account (the pool, U) and no request carries a key, the words or which note is whose. U's
//   secret key and the seed are zeroed when the run ends. Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_MIN_DEPOSIT, EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads } from "../../kit/src/trade/evm/pool-fee.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { EvmPoolSend, NoteRecord, NoteState, NoteStore } from "../../wallet/src/notes/store.ts";
import { evmAgreedBlock, EvmLagError, evmPoolScopeOf, evmRetryLag, EvmUnansweredError, EVM_CHAIN_IDS, EVM_LADDER, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { SolanaRpcTransportError } from "../../kit/src/trade/solana/send.ts";
import { evmClaimTaken, evmNextNote, EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { evmSameChainDeposit } from "../../wallet/src/pool/same-chain.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkEvmDeposit, EVM_DEPOSIT_GAS_MAX, PoolRuleRefused, signEvmDeposit, type EvmOnwardSend, type PoolAsk } from "./rules/pool.ts";
import { POOL_DEPOSIT_LOCK, type PoolDepositAnswer } from "./pool-deposit.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** The pool's events up to the newest block both RPCs agree on, with the round's finalized block (evmTreeSync's
 *  events(): `events` and `fin.number`). */
export type EvmDepositRound = { events: readonly EvmPoolEvent[]; finalBlock: bigint };

export type PoolDepositEvmHost = {
  /** The pinned pool (the wallet's EVM_POOLS entry of this page's network). */
  pin: EvmPoolPin;
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
  reads?: number;
  wait?(ms: number): Promise<void>;
  end?(): void;
};

/** The priority fee U offers, wei per gas: 0.01 gwei, above what Base's blocks include at (a tip that never lands
 *  holds U's nonce); Robinhood (Nitro) ignores it. */
export const EVM_DEPOSIT_PRIORITY_CAP = 10_000_000n;
/** Verdict reads a send gets in one run, POOL_DEPOSIT_EVM_WAIT_MS apart: past Base's finality (~15 min) is the next
 *  run's (a state read or the next ask settles the open note first). */
export const POOL_DEPOSIT_EVM_READS = 120;
export const POOL_DEPOSIT_EVM_WAIT_MS = 2_000;
/** A run builds one note's send again at most this many times (each only once the last is dead on both RPCs). */
export const POOL_DEPOSIT_EVM_REBUILDS = 3;
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

/** A run's own: the host, the store, the seed, the pool's scope and the keys to zero. */
type Run = { h: PoolDepositEvmHost; store: NoteStore; seed: Uint8Array; scope: bigint; chainId: bigint; keys: Uint8Array[]; ask: PoolAsk };

/** U's reads at one block both RPCs hold: the block, U's nonce (agreed) and its balance (each RPC's). */
async function accountReads(r: Run, u: string): Promise<{ tag: string; baseFee: bigint; nonce: bigint; balance: [bigint, bigint] }> {
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
  return { tag, baseFee: fees[0], nonce: nonce[0], balance };
}

/** The L1 fee bound for `gas` on the pin's network: the kit's chain fee reads on both RPCs (agreed), 0 on Nitro. */
async function l1FeeOf(r: Run, gas: bigint, tag: string): Promise<bigint> {
  const net = r.h.pin.network;
  if (net === "robinhood" || net === "robinhood-testnet") return 0n;
  const calls = evmPoolChainFeeReads(net, gas);
  const answers: bigint[] = [];
  for (const c of calls) {
    const [a, b] = await both(r.h.rpcs, async (rpc, k) => firstWord(await rpc("eth_call", [{ to: c.to, data: c.data }, tag]), `rpc ${k} chain fee`));
    if (a !== b) apart("the chain fee");
    answers.push(a);
  }
  return evmPoolChainFee(net, EVM_POOL_TX_BYTES, answers);
}

/** What one try at a note came to. */
type Try =
  | { kind: "sent"; note: NoteRecord; hash: string }
  | { kind: "taken" } // the note was restored as the user's (a Deposited named it): go on to the next
  | { kind: "claimed" } // notes before it written landed: go on
  | { kind: "wait" } // a take not final yet stands before it
  | { kind: "keep"; short: bigint; u: string }
  | { kind: "sim_failed" };

/**
 * One try at U's next note (or, with `again`, the open note `again` at its recorded value): picked through evmNextNote
 * over the pool's events, priced on both RPCs, checked by the rule, simulated on both, written INCOMING (or its send
 * added) and only then sent to both RPCs.
 */
async function tryNote(r: Run, first: Extract<NoteRef, { kind: "deposit" }>, again: NoteRecord | null, want: bigint): Promise<Try> {
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
  // first at the cap's gas, then at the estimate both RPCs agree on for the call that gives
  const bound = EVM_DEPOSIT_GAS_MAX * maxFee + (await l1FeeOf(r, EVM_DEPOSIT_GAS_MAX, acct.tag));
  let step = priced(bound);
  if (step.kind === "wait") return { kind: "wait" };
  if (step.kind === "claim") return { kind: "claimed" };
  // short: the rung this ask goes in at first (the ladder's split of what is left of it, or the open note's recorded
  // value) and the fee bound, less U's lower reading
  const need = sentValue ?? (want > 0n ? ladderSplit(EVM_LADDER, want).notes[0] : undefined) ?? EVM_LADDER.one;
  if (step.kind !== "deposit" || step.call === undefined) return { kind: "keep", short: need + bound > low ? need + bound - low : 0n, u };
  if (sentValue !== undefined && (step.value !== sentValue || !sameRef(step.ref, again!.ref))) return { kind: "keep", short: sentValue + bound > low ? sentValue + bound - low : 0n, u };
  const estimateOf = async (call: { to: string; value: bigint; data: string }) =>
    both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_estimateGas", [{ from: u, to: call.to, value: qty(call.value), data: call.data }, acct.tag]), `rpc ${k} estimate`));
  let estimate = await estimateOf(step.call);
  if (estimate[0] !== estimate[1]) apart("the deposit's gas estimate");
  let l1 = await l1FeeOf(r, estimate[0], acct.tag);
  if (sentValue === undefined) {
    const better = priced(estimate[0] * maxFee + l1);
    if (better.kind === "deposit" && better.call !== undefined && better.value > step.value && sameRef(better.ref, step.ref)) {
      const e2 = await estimateOf(better.call);
      if (e2[0] === e2[1] && e2[0] === estimate[0]) step = better;
      else if (e2[0] === e2[1] && e2[0] <= EVM_DEPOSIT_GAS_MAX) ((estimate = e2), (step = better), (l1 = await l1FeeOf(r, e2[0], acct.tag)));
    }
  }
  const call = step.call!;
  const tx: EvmOnwardSend = { type: 2, chainId: r.chainId, nonce: acct.nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit: estimate[0], to: call.to, value: call.value, data: call.data, accessList: [] };
  // a send again is of the value an earlier ask signed for: the check holds it to that
  const ask = sentValue !== undefined ? { ...r.ask, amount: sentValue } : { ...r.ask, amount: want };
  checkEvmDeposit(tx, ask, { wallet: u, precommitment: step.precommitment, call, pin: r.h.pin }, { nonce: [acct.nonce, acct.nonce], balance: acct.balance, estimate, baseFee: [acct.baseFee, acct.baseFee], l1Fee: [l1, l1], priorityCap: tip }, r.h.pin.network === "base-sepolia" || r.h.pin.network === "robinhood-testnet");
  // simulated on both before U signs: a failure on either signs nothing
  const sim = await Promise.allSettled(r.h.rpcs.map((rpc) => rpc("eth_call", [{ from: u, to: call.to, value: qty(call.value), data: call.data, gas: qty(estimate[0]) }, acct.tag])));
  if (sim.some((s) => s.status === "rejected")) return { kind: "sim_failed" };
  const raw = signEvmDeposit(id.secretKey, tx);
  const send: EvmPoolSend = { hash: hex(keccak_256(raw)), nonce: acct.nonce, value: call.value };
  // the state and its send, written before the signed tx leaves the device
  let note: NoteRecord;
  if (again !== null) {
    const seen = again.evmSends?.length ?? 0;
    note = await r.store.addEvmSend(again.id, send, seen);
    if ((note.evmSends ?? []).length !== seen + 1 || note.evmSends!.at(-1)!.hash !== send.hash) return { kind: "sim_failed" }; // another run's send came first
  } else {
    const all = await r.store.list();
    const planned = all.find((n) => sameRef(n.ref, step.ref)) ?? (await r.store.add({ ref: step.ref, scope: r.scope, precommitment: step.precommitment, state: "PLANNED" }));
    if (planned.state !== "PLANNED" || planned.precommitment !== step.precommitment) throw new Error("the note to deposit is not PLANNED");
    note = await r.store.move(planned.id, "PLANNED", "INCOMING", { evmSend: send });
  }
  await Promise.allSettled(r.h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hex(raw)])));
  return { kind: "sent", note, hash: send.hash };
}

/** An open note's verdict, read once. */
type Verdict = { kind: "landed"; note: NoteRecord; filled: boolean } | { kind: "pending" } | { kind: "dead" };
async function verdictOf(r: Run, n: NoteRecord): Promise<Verdict> {
  const first = firstOf(n.ref, r.scope)!;
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
  const last = n.evmSends?.at(-1);
  if (last === undefined) return { kind: "dead" }; // INCOMING with no send: nothing left the device for it
  const id = depositIdEvm(r.seed, first.s, first.i);
  r.keys.push(id.secretKey);
  const fin = await both(r.h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [id.address, "finalized"]), `rpc ${k} finalized nonce`));
  // dead only when U's finalized nonce passed the send on BOTH RPCs and no Deposited names it on either
  return fin[0] > last.nonce && fin[1] > last.nonce ? { kind: "dead" } : { kind: "pending" };
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
  try {
    const store = await h.notes();
    const chainId = EVM_CHAIN_IDS[h.pin.network];
    const scope = evmPoolScopeOf(h.pin.pool, chainId);
    const r: Run = { h, store, seed, scope, chainId, keys, ask: ask ?? { kind: "pool.deposit", chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 } };
    let left = ask?.amount ?? 0n;
    let rebuilds = 0;
    let simAgain = false;
    for (let steps = 0; steps < STEPS_MAX; steps++) {
      const all = (await store.list()).filter((n) => n.scope === scope && firstOf(n.ref, scope) !== null);
      const open = all.find((n) => n.state === "INCOMING");
      if (open !== undefined) {
        // an open note is settled first: no new index, nothing new signed, while it may land
        let v: Verdict = { kind: "pending" };
        for (let k = 0; k < (h.reads ?? POOL_DEPOSIT_EVM_READS); k++) {
          v = await verdictOf(r, open);
          if (v.kind !== "pending") break;
          await wait(POOL_DEPOSIT_EVM_WAIT_MS);
        }
        if (v.kind === "landed") {
          const hash = open.evmSends?.at(-1)?.hash;
          if (hash !== undefined) landedTxs.push({ chain, hash });
          if (v.filled) left -= left < v.note.leaf!.value ? left : v.note.leaf!.value;
          h.progress?.("filled");
          continue;
        }
        if (v.kind === "pending") return sentTxs.length > 0 ? { stage: "sent", txs: sentTxs } : { stage: "not_landed", txs: [] };
        // dead on both RPCs: the same note again from fresh reads at U's new nonce
        if (++rebuilds > POOL_DEPOSIT_EVM_REBUILDS) return { stage: "not_landed", txs: sentTxs };
        const t = await tryNote(r, firstOf(open.ref, scope)!, open, 0n);
        if (t.kind === "sent") {
          sentTxs.push({ chain, hash: t.hash });
          h.sent?.(t.hash);
        } else if (t.kind !== "taken") return landedTxs.length ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: sentTxs };
        continue;
      }
      if (ask === null || left < EVM_POOL_MIN_DEPOSIT) break;
      // the source: the newest U that landed a note while it covers a rung, else the planned index
      const used = all.filter((n) => LANDED.includes(n.state)).map((n) => firstOf(n.ref, scope)!.i);
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
        sentTxs.push({ chain, hash: t.hash });
        h.sent?.(t.hash);
        h.progress?.("sent");
        continue;
      }
      if (t.kind === "taken" || t.kind === "claimed") {
        simAgain = false; // a new note: its own simulation, and its own second try
        continue;
      }
      if (t.kind === "wait") return landedTxs.length ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: [] };
      if (t.kind === "sim_failed") {
        // the pool may have moved: read and simulate once more, then not_funded
        if (!simAgain) {
          simAgain = true;
          continue;
        }
        return landedTxs.length ? { stage: "part_filled", txs: landedTxs } : { error: "not_funded" };
      }
      // keep: U cannot carry a rung and its fee
      if (landedTxs.length) return { stage: ask.amount - left > 0n && left >= EVM_POOL_MIN_DEPOSIT ? "part_filled" : "filled", txs: landedTxs };
      h.short?.(t.u, t.short);
      return { error: "not_funded" };
    }
    // the run's step cap (a front-runner taking note after note) with the ask not all in: what landed, never filled
    if (ask !== null && left >= EVM_POOL_MIN_DEPOSIT) return landedTxs.length ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: sentTxs };
    return { stage: "filled", txs: landedTxs };
  } catch (e) {
    // a send may have left: never failed while it may land
    if (sentTxs.length > 0) return { stage: "sent", txs: sentTxs };
    if (landedTxs.length > 0) return { stage: "part_filled", txs: landedTxs };
    // a take not final yet before the note to sign: "not now" (pool-kinds.ts answers it busy), nothing signed
    if (e instanceof EvmNotFinalError) throw e;
    if (e instanceof PoolRuleRefused) return { error: "not_allowed" };
    // a provider read that still fails after the page's own retry (or a lag past its tries), before U signs: "not now"
    // (card pool-read-down); any other fault before a send (two RPCs that read apart, an answer out of shape): failed
    if (e instanceof SolanaRpcTransportError || e instanceof EvmUnansweredError || e instanceof EvmLagError) return { error: "down" };
    return { error: "failed" };
  } finally {
    seed.fill(0);
    for (const k of keys) k.fill(0);
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
          try {
            const a = await runPoolDepositEvm({ ...h, sent, progress }, ask);
            if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
            else if ("stage" in a && a.stage !== "sent") ctx?.progress(a.stage);
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
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
