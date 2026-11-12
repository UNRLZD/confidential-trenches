// The carry on a Base or Robinhood pool: when a buy's swap fails inside the pool's own call, the pool pays the fresh
// wallet W the chunk less the fee in ETH (contracts/pool-evm/src/PrivacyPoolSimple.sol buy, its Withdrawn branch). This
// puts that ETH back into the pinned pool as a note of the user's, with no tap, by a deposit W signs and pays the gas of.
//
// - Which Ws, from chain data alone: every RESERVED or SPENT note of the pool's scope in the note store (a restore from
//   the 12 words writes them from the chain), its release found in the pool's round (evmTreeSync events(), both RPCs
//   byte for byte) by its nullifier hash: a Withdrawn paying the note's own W (W_{evm, l, j}, l its label, j = jOf(its
//   ref), the only W a proof of the note pays). A Bought is a buy that filled: never a carry. A Withdrawn is a refused
//   buy only when the transaction that emitted it, read on both RPCs (its log at its block hash and index, then that
//   block's transaction at its index), is a direct call to the pool whose input is a Buy (evm-send.ts
//   evmBuyCalldataRead): a pool.withdraw's W, whose ETH goes on to its destination, is never carried, and a release the
//   two RPCs name apart, or that came through another contract, is left alone (`unread`, `other`). No local record is
//   the source: a tab that closed before its buy's end and a fresh device are the same path.
// - The note: W's return chain (return, evm, l, j), then its R second arrivals, picked through the wallet's evmNextNote
//   over the round, the chain a sell signs on: a W whose buy was refused holds no token, so no sell of it ever signs
//   there, and a restore's walk of every spent note's return chain finds the carried note (../../wallet/src/pool/
//   evm-restore.ts). Before the raw transaction leaves for both RPCs, the open carry's record (EVM_CARRY_OPEN_KEY: the
//   note, W's (l, j), each send { hash, nonce, value, sentMs } W signed for it, as a sale keeps its own) and then the
//   note PLANNED -> INCOMING are written: a write that fails sends nothing. UNSPENT only from a Deposited at a final
//   block (evmClaimTaken), never on a send's word.
// - The value: W's whole lower balance reading at one block both RPCs hold, less the send's bound (gas limit = the
//   two-RPC estimate plus the tree's headroom, at 2 x base fee + the tip cap, and Base's L1 fee bound), checked by the
//   rule (rules/pool.ts checkEvmCarry: the pinned pool, deposit(value, precommitment) only, W's agreed nonce, value +
//   bound = W's lower balance exactly) and simulated on both RPCs before W signs; signed by signEvmDeposit with W's key,
//   derived from the seed for the signature and zeroed after it. W keeps only the gas its send did not use.
// - An open carry's end, on every pass: landed (a final Deposited naming its precommitment: UNSPENT, at the value it
//   carried); pending (a Deposited above the final block, or the send may still land); dead (W's nonce past the send at a
//   block final on both RPCs, that block kept in the record so a reload waits on the same one, and no Deposited: built
//   again on the same note at W's new nonce); unsent (old enough, no RPC knows any of its hashes, W's latest and pending
//   nonces still the send's: built again at that same nonce, so at most one of the two can land). A send built again is
//   added to the record before it leaves, at its own value (W's balance and the fee may have moved).
// - Ends per W (EVM_CARRY_DONE_KEY), never read again: `withdraw` and `other`; `carried` once its carry landed (W keeps
//   only the gas its send did not use: at most the send's bound less its cost); `empty` when W reads at or under the
//   pool's least deposit with nothing carried (no deposit can take it at any fee). A W whose balance covers the least
//   deposit but not the fee at the base fee read (`high_fee`) is read again on the next pass.
// - When: the buy's own read-back starts a pass at a refusal (pool-buy-evm.ts), and every signed-in state read starts
//   one (src/pool-testnet.ts), under the seed's shared lock and one pass per chain at a time. A sign out (`signal`) ends
//   it between steps: nothing is signed or written after it.
// - Who learns what: the pool RPCs, W (its nonce, balance, estimate and its deposit), the pool's logs at one block and
//   that block's transactions. No server is asked anything. Nothing here logs.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_MIN_DEPOSIT } from "../../kit/src/trade/evm/pool-fee.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { evmAgreedBlock, evmRetryLag, EVM_CHAIN_IDS, EVM_POOL_EVENTS, type EvmPoolEvent, type EvmPoolPin, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import { evmClaimTaken, evmNextNote, EvmNotFinalError } from "../../wallet/src/pool/evm-restore.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { checkEvmCarry, EVM_DEPOSIT_GAS_MAX, evmDepositHeadroom, signEvmDeposit, type EvmOnwardSend } from "./rules/pool.ts";
import { depthsOf, EVM_DEPOSIT_PRIORITY_CAP, EVM_DEPOSIT_RESEND_MS, l1FeesOf, spentFinal } from "./pool-deposit-evm.ts";
import { evmBuyCalldataRead } from "./evm-send.ts";

type Chain = "base" | "robinhood";

/** Each W's end, by W's address (lowercase): an owed/ key, the one meta keyspace the wallet store lets a caller write. */
export const EVM_CARRY_DONE_KEY = "owed/carry-evm";
export type EvmCarryDone = { chain: Chain; end: "withdraw" | "other" | "empty" | "carried" };
/** Each open carry by W's address (lowercase): written before its first send leaves, its sends added before each
 *  leaves, dropped once its note lands. */
export const EVM_CARRY_OPEN_KEY = "owed/carry-evm-open";
export type EvmCarryOpen = { chain: Chain; note: string; l: string; j: number; sends: { hash: string; nonce: string; value: string; sentMs: string }[]; spent?: { nonce: string; number: string; hash: string } };
/** The refused buys' hint of an earlier release (W's address -> its owed ETH): no longer written; an entry is dropped once
 *  its W ends here. */
export const EVM_OWED_BACK_KEY = "owed/back-evm";

/** What a carry pass needs from the page. */
export type EvmCarryHost = {
  chain: Chain;
  testnet: boolean;
  pin: EvmPoolPin;
  /** The pool's scope (evmPoolScopeOf of the pin). */
  scope: bigint;
  /** The pool's two RPCs, of two operators. */
  rpcs: readonly [EvmRpc, EvmRpc];
  /** One round of the pool's sync (evmTreeSync events()): its events up to the newest agreed block, its final block. */
  round(): Promise<{ events: readonly EvmPoolEvent[]; fin: { number: bigint } }>;
  notes(): Promise<NoteStore>;
  seed64(): Promise<Uint8Array>;
  /** The wallet store while one is open (its meta: the ends, the old hint). */
  held(): Promise<Pick<WalletStore, "get" | "update">>;
  /** A note the carry landed (UNSPENT): the page's proof queue proves it. */
  landed?(n: NoteRecord): void;
  priorityCap?: bigint;
  now?(): number;
  wait?(ms: number): Promise<void>;
  signal?: AbortSignal;
};

/** One W's outcome in a pass. */
export type EvmCarryOutcome = { w: string; end: "sent" | "landed" | "pending" | "withdraw" | "other" | "empty" | "unread" | "high_fee" | "sim_failed" };

const lower = (s: string): string => s.toLowerCase();
const hex = (b: Uint8Array): string => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const qty = (v: bigint): string => "0x" + v.toString(16);
const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const TOPIC_WITHDRAWN = hex(keccak_256(new TextEncoder().encode(EVM_POOL_EVENTS.Withdrawn)));
function quantity(x: unknown, what: string): bigint {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new Error(`${what}: not a quantity`);
  return BigInt(x);
}
const both = <T>(rpcs: readonly [EvmRpc, EvmRpc], f: (rpc: EvmRpc, k: number) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0], 0), f(rpcs[1], 1)]);
const key = (r: NoteRef): string => JSON.stringify(r, (_, v) => (typeof v === "bigint" ? `${v}` : v));
const sameRef = (a: NoteRef, b: NoteRef): boolean => key(a) === key(b);
/** A note of W's return chain (return, evm, l, j) or its R second arrivals. */
const onChain = (r: NoteRef, l: bigint, j: number): boolean =>
  (r.kind === "return" && r.c === "evm" && r.l === l && r.j === j) || (r.kind === "second" && r.id.id === "R" && r.id.c === "evm" && r.id.l === l && r.id.j === j);
const recordsOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {});

/** A W of the user's that a release paid with no swap: its (l, j), address (lowercase) and the release. */
type Owed = { l: bigint; j: number; w: string; release: EvmPoolEvent };

/**
 * What a Withdrawn paying W came from, on both RPCs: its log at its block hash and index, then that block's transaction
 * at the log's index. "buy": a direct call to the pool with a Buy's input (a refused buy); "withdraw": a direct call to
 * the pool that is no Buy; "other": a call to another contract. Two RPCs that name another transaction, or input,
 * throw: the W is left for a later pass.
 */
export async function evmReleaseKind(rpcs: readonly [EvmRpc, EvmRpc], pool: string, w: string, e: Pick<EvmPoolEvent, "block" | "blockHash" | "logIndex">): Promise<"buy" | "withdraw" | "other"> {
  const one = async (rpc: EvmRpc) => {
    const logs = (await rpc("eth_getLogs", [{ address: lower(pool), topics: [TOPIC_WITHDRAWN], fromBlock: qty(e.block), toBlock: qty(e.block) }])) as unknown;
    if (!Array.isArray(logs)) throw new Error("carry: not a log list");
    const log = (logs as Record<string, unknown>[]).find((x) => typeof x === "object" && x !== null && x.removed !== true && typeof x.logIndex === "string" && BigInt(x.logIndex) === e.logIndex && typeof x.blockHash === "string" && lower(x.blockHash) === lower(e.blockHash));
    const topics = Array.isArray(log?.topics) ? (log!.topics as unknown[]) : [];
    if (log === undefined || typeof topics[1] !== "string" || BigInt(topics[1]) !== BigInt(w) || typeof log.transactionIndex !== "string" || typeof log.transactionHash !== "string") throw new Error("carry: no Withdrawn for W at its place");
    const tx = lower(log.transactionHash);
    const block = (await rpc("eth_getBlockByNumber", [qty(e.block), true])) as { hash?: unknown; transactions?: unknown } | null;
    if (typeof block?.hash !== "string" || lower(block.hash) !== lower(e.blockHash) || !Array.isArray(block.transactions)) throw new Error("carry: not the Withdrawn's block");
    const t = block.transactions[Number(BigInt(log.transactionIndex))] as { hash?: unknown; to?: unknown; input?: unknown } | undefined;
    if (typeof t?.hash !== "string" || lower(t.hash) !== tx || typeof t.input !== "string" || (t.to !== null && typeof t.to !== "string")) throw new Error("carry: the Withdrawn's transaction is not read");
    return { tx, to: typeof t.to === "string" ? lower(t.to) : "", input: lower(t.input) };
  };
  const [a, b] = await both(rpcs, one);
  if (a.tx !== b.tx || a.to !== b.to || a.input !== b.input) throw new Error("carry: the two RPCs name another release");
  if (a.to !== lower(pool)) return "other";
  return evmBuyCalldataRead(a.input) !== null ? "buy" : "withdraw";
}

/** W's reads at one block both RPCs hold: the block, the base fee and W's nonce (each the same on both, each RPC's kept
 *  for the rule) and W's balance (each RPC's). */
async function wReads(rpcs: readonly [EvmRpc, EvmRpc], w: string, sleep: (ms: number) => Promise<void>, signal?: AbortSignal) {
  const blk = await evmRetryLag(() => evmAgreedBlock(rpcs, "latest", signal, sleep), sleep, signal);
  const tag = qty(blk.number);
  const fees = await both(rpcs, async (rpc, k) => quantity(((await rpc("eth_getBlockByNumber", [tag, false])) as { baseFeePerGas?: unknown } | null)?.baseFeePerGas, `rpc ${k} base fee`));
  if (fees[0] !== fees[1] || blk.baseFeePerGas !== fees[0]) throw new Error("carry: the two RPCs read the base fee apart");
  const nonce = await both(rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [w, tag]), `rpc ${k} nonce`));
  if (nonce[0] !== nonce[1]) throw new Error("carry: the two RPCs read W's nonce apart");
  const balance = await both(rpcs, async (rpc, k) => quantity(await rpc("eth_getBalance", [w, tag]), `rpc ${k} balance`));
  return { block: blk.number, tag, baseFee: fees[0], baseFees: fees, nonce: nonce[0], nonces: nonce, balance };
}

type Pass = { h: EvmCarryHost; store: NoteStore; seed: Uint8Array; sleep: (ms: number) => Promise<void>; now: () => bigint };

/**
 * One carry of W's balance into the pool: the note picked through evmNextNote over a fresh round (a taken note of the
 * chain claimed as the user's first), W's reads, the fee bound, the rule, the simulation on both RPCs, W's signature,
 * the note written INCOMING with its send, then the raw transaction to both RPCs.
 */
async function carryOnce(p: Pass, o: Owed, again?: NoteRecord): Promise<EvmCarryOutcome["end"]> {
  const { h, store, seed } = p;
  const round = await h.round();
  const first: NoteRef = { kind: "return", c: "evm", l: o.l, j: o.j };
  // the pick: the device never signs a precommitment the pool already holds (signer guard); a take not final yet before
  // the note throws EvmNotFinalError, which the pass reads as pending
  const pick = evmNextNote(seed, h.scope, round.events, first, round.fin.number);
  // PrivacyPool.sol:82 deposit(uint256,uint256), encoded only past the pick
  const selector = hex(keccak_256(new TextEncoder().encode("deposit(uint256,uint256)")).subarray(0, 4));
  if (pick.taken.length > 0) for (const n of await evmClaimTaken(store, pick.taken)) h.landed?.(n);
  const next = pick.next;
  // a send built again is of the open note itself, never another of the chain beside it
  if (again !== undefined && !sameRef(next.ref, again.ref)) return "pending";
  const acct = await wReads(h.rpcs, o.w, p.sleep, h.signal);
  // W's balance read at or past the release that paid it
  if (acct.block < o.release.block) return "pending";
  const low = acct.balance[0] < acct.balance[1] ? acct.balance[0] : acct.balance[1];
  if (low <= EVM_POOL_MIN_DEPOSIT) return "empty";
  const tip = h.priorityCap ?? EVM_DEPOSIT_PRIORITY_CAP;
  const maxFee = 2n * acct.baseFee + tip;
  const r = { h: { rpcs: h.rpcs, pin: h.pin } };
  const depths = await depthsOf(r, acct.tag);
  const room = evmDepositHeadroom(depths.state[0], depths.label[0]);
  const callOf = (value: bigint) => Object.freeze({ to: h.pin.pool, value, data: selector + word(value) + word(next.precommitment) });
  // a first value at the cap's gas, for the estimate; then the value at the estimate both RPCs agree on
  const cap = EVM_DEPOSIT_GAS_MAX + room;
  const first0 = low - cap * maxFee - (await l1FeesOf(r, cap, acct.tag))[0];
  if (first0 < EVM_POOL_MIN_DEPOSIT) return "high_fee";
  const est = await both(h.rpcs, async (rpc, k) => quantity(await rpc("eth_estimateGas", [{ from: o.w, to: h.pin.pool, value: qty(first0), data: callOf(first0).data }, acct.tag]), `rpc ${k} estimate`));
  if (est[0] !== est[1]) throw new Error("carry: the two RPCs estimate W's deposit apart");
  if (est[0] > EVM_DEPOSIT_GAS_MAX) return "high_fee";
  const gasLimit = est[0] + room;
  const l1 = await l1FeesOf(r, gasLimit, acct.tag);
  const value = low - gasLimit * maxFee - l1[0];
  if (value < EVM_POOL_MIN_DEPOSIT) return "high_fee";
  const call = callOf(value);
  const tx: EvmOnwardSend = { type: 2, chainId: EVM_CHAIN_IDS[h.pin.network], nonce: acct.nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to: call.to, value: call.value, data: call.data, accessList: [] };
  checkEvmCarry(tx, { wallet: o.w, precommitment: next.precommitment, call, pin: h.pin, chain: h.chain }, { nonce: acct.nonces, balance: acct.balance, estimate: est, baseFee: acct.baseFees, l1Fee: l1, stateDepth: depths.state, labelDepth: depths.label, priorityCap: tip }, h.testnet);
  // simulated on both before W signs: a failure on either signs nothing
  const sim = await Promise.allSettled(h.rpcs.map((rpc) => rpc("eth_call", [{ from: o.w, to: call.to, value: qty(call.value), data: call.data, gas: qty(gasLimit) }, acct.tag])));
  if (sim.some((s) => s.status === "rejected")) return "sim_failed";
  // a sign out since the reads: nothing signed or written after it
  if (h.signal?.aborted) return "pending";
  const wk = freshWallet(seed, "evm", o.l, o.j);
  let raw: Uint8Array;
  try {
    if (lower(wk.address) !== o.w) throw new Error("carry: W is not the release's");
    raw = signEvmDeposit(wk.secretKey, tx);
  } finally {
    wk.secretKey.fill(0);
  }
  const send = { hash: hex(keccak_256(raw)), nonce: acct.nonce.toString(), value: value.toString(), sentMs: p.now().toString() };
  // the record and the note, written before the signed bytes leave the device: a write that fails sends nothing
  const all = await store.list();
  const note = all.find((n) => sameRef(n.ref, next.ref)) ?? (await store.add({ ref: next.ref, scope: h.scope, precommitment: next.precommitment, state: "PLANNED" }));
  if ((note.state !== "PLANNED" && note.state !== "INCOMING") || note.precommitment !== next.precommitment) throw new Error("carry: the note to deposit is not open");
  const meta = await h.held();
  await meta.update("meta", EVM_CARRY_OPEN_KEY, (v) => {
    const open = recordsOf(v);
    const was = open[o.w] as EvmCarryOpen | undefined;
    const sends = was?.note === note.id ? [...was.sends, send] : [send];
    const rec: EvmCarryOpen = { chain: h.chain, note: note.id, l: o.l.toString(), j: o.j, sends };
    return { ...open, [o.w]: rec };
  });
  if (note.state === "PLANNED") await store.move(note.id, "PLANNED", "INCOMING");
  await Promise.allSettled(h.rpcs.map((rpc) => rpc("eth_sendRawTransaction", [hex(raw)])));
  return "sent";
}

const sendOf = (x: EvmCarryOpen["sends"][number]): { hash: string; nonce: bigint; value: bigint; sentMs: bigint } => ({ hash: x.hash, nonce: BigInt(x.nonce), value: BigInt(x.value), sentMs: BigInt(x.sentMs) });

/** An open carry's end this pass (see the header): landed, pending, or built again. `rec` is its record, `n` its note. */
async function follow(p: Pass, o: Owed, n: NoteRecord, rec: EvmCarryOpen | undefined): Promise<EvmCarryOutcome["end"]> {
  const { h, store, seed } = p;
  const mine = rec !== undefined && rec.note === n.id ? rec : undefined;
  const last = mine?.sends.length ? sendOf(mine.sends.at(-1)!) : undefined;
  // W's nonce past the last send at a block final on both RPCs, read before the round (so a deposit landing between the
  // two reads is read landed, never dead); its block kept in the record so a reload waits on the same one
  let spent: bigint | null = null;
  if (last !== undefined) {
    const was = mine!.spent !== undefined && BigInt(mine!.spent.nonce) === last.nonce ? { number: BigInt(mine!.spent.number), hash: mine!.spent.hash } : undefined;
    const s = await spentFinal(h.rpcs, o.w, last.nonce, was, p.sleep, h.signal);
    spent = s.final;
    if (s.kept?.number !== was?.number || s.kept?.hash !== was?.hash) {
      await (await h.held()).update("meta", EVM_CARRY_OPEN_KEY, (v) => {
        const open = recordsOf(v);
        const cur = open[o.w] as EvmCarryOpen | undefined;
        if (cur?.note !== n.id) return open;
        const next: EvmCarryOpen = { ...cur };
        if (s.kept === undefined) delete next.spent;
        else next.spent = { nonce: last.nonce.toString(), number: s.kept.number.toString(), hash: s.kept.hash };
        return { ...open, [o.w]: next };
      });
    }
  }
  const round = await h.round();
  const first: NoteRef = { kind: "return", c: "evm", l: o.l, j: o.j };
  let pick: ReturnType<typeof evmNextNote>;
  try {
    pick = evmNextNote(seed, h.scope, round.events, first, round.fin.number);
  } catch (e) {
    if (e instanceof EvmNotFinalError) return "pending";
    throw e;
  }
  if (pick.taken.some((t) => sameRef(t.ref, n.ref))) {
    for (const c of await evmClaimTaken(store, pick.taken)) h.landed?.(c);
    return "landed";
  }
  if (pick.pending.some((r) => sameRef(r, n.ref))) return "pending";
  // INCOMING with no send of its record: nothing left the device for it (the page closed between the two writes)
  let again = last === undefined;
  if (!again && spent !== null && round.fin.number >= spent) again = true;
  if (!again && p.now() >= last!.sentMs + EVM_DEPOSIT_RESEND_MS[h.pin.network]) {
    // reached neither RPC: no RPC knows any of its hashes, and W's latest and pending nonces are both still the send's
    const hashes = mine!.sends.map((x) => x.hash);
    const known = await both(h.rpcs, async (rpc) => (await Promise.all(hashes.map((x) => rpc("eth_getTransactionByHash", [x])))).some((t) => t !== null));
    if (!known[0] && !known[1]) {
      let still = true;
      for (const tag of ["latest", "pending"]) {
        const nonce = await both(h.rpcs, async (rpc, k) => quantity(await rpc("eth_getTransactionCount", [o.w, tag]), `rpc ${k} ${tag} nonce`));
        if (nonce[0] !== last!.nonce || nonce[1] !== last!.nonce) still = false;
      }
      again = still;
    }
  }
  if (!again || h.signal?.aborted) return "pending";
  return carryOnce(p, o, n);
}

/**
 * One carry pass over the pool's scope (see the header). Returns each owed W's outcome; a W whose reads fail is
 * `unread` and read again on the next pass.
 */
export async function carryEvmOwed(h: EvmCarryHost): Promise<EvmCarryOutcome[]> {
  const sleep = h.wait ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const now = (): bigint => BigInt(Math.floor((h.now ?? Date.now)()));
  const store = await h.notes();
  const notes = (await store.list()).filter((n) => n.scope === h.scope);
  const spent = notes.filter((n) => (n.state === "SPENT" || n.state === "RESERVED") && n.leaf !== undefined);
  if (spent.length === 0) return [];
  const meta = await h.held();
  const done = recordsOf(await meta.get("meta", EVM_CARRY_DONE_KEY));
  const round = await h.round();
  const releases = new Map<bigint, EvmPoolEvent>();
  for (const e of round.events) if (e.kind === "withdraw" && e.nullifier !== null) releases.set(e.nullifier, e);
  const out: EvmCarryOutcome[] = [];
  const seed = await h.seed64();
  try {
    const owed: Owed[] = [];
    for (const n of spent) {
      const e = releases.get(noteSecrets(seed, n.ref).nullifierHash);
      if (e === undefined || e.recipient === null) continue;
      const l = n.leaf!.label;
      const j = jOf(n.ref);
      const wk = freshWallet(seed, "evm", l, j);
      wk.secretKey.fill(0);
      const w = lower(wk.address);
      // a release of the note to another W is not the user's W's money
      if (lower(e.recipient) !== w || done[w] !== undefined) continue;
      owed.push({ l, j, w, release: e });
    }
    const p: Pass = { h, store, seed, sleep, now };
    for (const o of owed) {
      if (h.signal?.aborted) break;
      let end: EvmCarryOutcome["end"];
      try {
        const open = (await store.list()).find((n) => n.scope === h.scope && n.state === "INCOMING" && onChain(n.ref, o.l, o.j));
        if (open !== undefined) end = await follow(p, o, open, recordsOf(await meta.get("meta", EVM_CARRY_OPEN_KEY))[o.w] as EvmCarryOpen | undefined);
        else {
          const kind = await evmReleaseKind(h.rpcs, h.pin.pool, o.w, o.release);
          end = kind === "buy" ? await carryOnce(p, o) : kind;
        }
      } catch (e) {
        end = e instanceof EvmNotFinalError ? "pending" : "unread";
      }
      if (end === "withdraw" || end === "other" || end === "empty" || end === "landed") {
        if (h.signal?.aborted) break;
        const rec: EvmCarryDone = { chain: h.chain, end: end === "landed" ? "carried" : end };
        await meta.update("meta", EVM_CARRY_DONE_KEY, (v) => ({ ...recordsOf(v), [o.w]: rec }));
        await meta.update("meta", EVM_CARRY_OPEN_KEY, (v) => {
          const all = recordsOf(v);
          delete all[o.w];
          return all;
        });
        await meta.update("meta", EVM_OWED_BACK_KEY, (v) => {
          const all = recordsOf(v);
          for (const k of Object.keys(all)) if (lower(k) === o.w) delete all[k];
          return all;
        });
      }
      out.push({ w: o.w, end });
    }
  } finally {
    seed.fill(0);
  }
  return out;
}
