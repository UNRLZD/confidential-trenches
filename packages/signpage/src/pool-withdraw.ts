// pool.withdraw on the Solana pool (card signpage-pool-withdraw-form): the user types where the money goes (To) and how
// much arrives there (Amount) on SIGN_HOST's own page (src/withdraw/pool-form.ts), and each part of it leaves the
// pinned pool in two transactions (review #232 HIGH 1): the release of one note's part to its fresh wallet W (tag 2),
// alone, paid by the helper's fee payer (the pool wants the recipient to sign, contracts/pool-solana src/release.rs:188,
// so W is the recipient); then W's own System transfer of all it holds less its own fee to To, W its only signer and
// fee payer, sent through the page's RPC pair, so W ends at 0. Nothing W's holder signs can fail the fee payer's
// transaction. A crash between the two leaves the part on W: the op keeps it pending for the state reads'
// finishPoolOnward, and a restore from the 12 words finds W.
//
// - The plan (planPoolWithdraw): the pool's landed notes largest first, the fewest parts that send exactly the amount,
//   each part at least the min part (rent(0), and the 2 x fee backstop) and each note's change 0 or at least the note
//   floor (fee + W's fee + min part: a smaller change could never leave the pool, review #232 HIGH 2); with the pool's
//   piece rule (card every-lamport-can-move) every part that does not take its whole note has its chunk on the grid,
//   and the note floor is at least the rule's, so no change is ever off the grid or under a buy's floor. Each chunk is
//   part + fee + W's fee, so exactly the part arrives at To. The fee is the device's own, from the Rent sysvar read on
//   two RPCs (the kit's solanaPoolFee); W's fee is getFeeForMessage on both. Max fee is parts x (fee + W's fee), and a
//   run whose plan costs more than the Max fee the screen drew stops before its first part (review #232 MEDIUM 1).
// - Each part proves on demand (6.7 s in run 6d): the queue's own W_{sol, label, j} and change note (queue.ts prove),
//   so a restore from the 12 words finds both. A note the page's proof queue holds for the next buy is dropped first
//   (HELD -> UNSPENT), then held by this run with its context (UNSPENT -> HELD), before its proof starts. The bind's
//   tip cap is 0 (a tag 2 pays no tip).
// - The roots: the epoch root when the note is in it. A note that landed this epoch, of any kind, proves at once on the
//   newest root both RPCs agree on (the queue's own rule, queue.ts; card fresh-money-spendable-at-once: no withdraw
//   waits for a boundary), its epoch, deadline and binding the current epoch's; only a newest cut that does not hold its
//   leaf yet (the landing read ahead of both RPCs' final block) is read again on the pool's time. A root right after a
//   note's own leaf is easier to tie to the W whose money made that leaf (M351), so the plan draws on the notes under
//   the epoch root first and on a note that landed this epoch only when they cannot send the amount. Their leaf indexes
//   are read on both RPCs (pool-buy.ts rootIndex).
// - Built here, checked by the rules (rules/pool.ts checkSolanaWithdraw: the device's own release byte for byte, alone;
//   checkSolanaOnwardSend: W's one transfer of its balance less its fee to To, To never an account of the release nor
//   executable), signed by W only through signSolana. W's key and the seed are zeroed at once. To is read on both
//   RPCs before any note moves: never executable, never owned by the pool program.
// - RESERVED is written before the release leaves (notes/store.ts); its send, busy resends, read-back on both RPCs
//   and settle are pool-buy.ts sendAndSettle's, the one path for a pool send. A note left RESERVED is settled by the
//   page's state reads (solanaSettleReserved), as a buy's is.
// - The op (the kit's kind "withdraw", WithdrawStage): proving while a part proves, submitted while a release is
//   sent, in_transit once it landed and the part is on W, sent once every part's onward send read back on both RPCs,
//   stopped when a part was refused or did not land (the parts sent before it stay sent). txs lists every
//   transaction's signature, release and onward, as both RPCs read it as that very transaction: a release's is the
//   send's read-back or its spend's own, never the helper's word (card signpage-sent-read-back).
// - W goes on only once both RPCs read that the release which spent its note is this attempt's (spendOwner, card
//   signpage-withdraw-own-spend): another device signed in with the same 12 words spends the same note to the same W
//   and keeps its own note store, so a spent note and a full W never say whose part it is.
// - The owed send (PendingOnward: the attempt, its context, To) goes to the host's owe; the testnet page keeps it in the
//   wallet store's meta under owed/<op id>, which the frame never reads, and the op record names only the note's id.
// - Every read names a public account or the transaction itself; no request carries a key, the words or which note is
//   whose (W's fee is read on a fixed message from the pool). Nothing here logs.
import { base58, base64 } from "@scure/base";
import { poolProveWithdraw, type VaultProver } from "../../kit/src/prover/prove.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import {
  readSolanaRent, solanaEncodePoolRelease, solanaPoolAccount, solanaPoolFee, solanaPoolTag2Accounts, solanaRentMin, type SolanaRent,
} from "../../kit/src/trade/solana/pool-buy.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { checkBinding, PoolNoLeafError, type Pool, type PoolTrees, type ReadyProof } from "../../wallet/src/pool/pool.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { changeMoves, isReleaseSize, pieceChunk, releaseSizesUpTo, type PieceRule } from "../../wallet/src/pool/pieces.ts";
import { solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { blockhashOf, pastOnBoth, readBack, releaseOf, rootIndex, sendAndSettle, treeSizes, type PoolBuyHost } from "./pool-buy.ts";
import { checkSolanaOnwardSend, checkSolanaWithdraw, PoolRuleRefused, signSolana, SOLANA_RESERVED_KEYS, solanaWithdrawMinPart, withdrawNoteFloor, type PoolAsk, type WithdrawCosts } from "./rules/pool.ts";
// moved to rules/pool.ts (card sol-buy-rent-back: the sweep's floor is the withdraw's note floor); named here still
export { solanaWithdrawMinPart, withdrawNoteFloor, type WithdrawCosts } from "./rules/pool.ts";
import { spendOwner, type HistoryPlaces } from "./pool-spend.ts";
import { legCause, type PoolRide } from "./pool-sell.ts";
import { within } from "./trade.ts";
// moved to pool-spend.ts (card signpage-buy-own-spend: pool-buy.ts reads them too, with no import cycle); named here still
export { HISTORY_PAGE, HISTORY_PASS, spendOwner, type HistoryPlaces } from "./pool-spend.ts";

/** The release's compute limit: the pool program's own tests send a release at 400,000 (svm-tests/tests/release.rs). */
export const POOL_WITHDRAW_CU = 400_000;


/** A note the plan may draw on: landed, of the pool's scope, UNSPENT or HELD by this page's proof queue. */
export type WithdrawSource = { id: string; value: bigint };
/** One part: the note it spends, what arrives at To from it, and what the release withdraws (part + fee + W's fee). */
export type WithdrawPart = { noteId: string; part: bigint; chunk: bigint };

/** The most `n` can send to To: its value less the relay fee and W's fee. */
const capOf = (n: WithdrawSource, c: WithdrawCosts): bigint => n.value - c.fee - c.wFee;
/** The plan reads at most this many notes, largest first: a withdraw's search stays bounded (3 choices a note). */
export const WITHDRAW_PLAN_NOTES = 16;

/** The grid a plan's split parts keep to and the note floor no change may fall under (card every-lamport-can-move):
 *  with the pool's piece rule (`pieces`, ../../wallet/src/pool/pieces.ts), every chunk that does not take its whole note
 *  is a multiple of its grid, and every change is 0 or at least the larger of its floor and the withdraw's own; with
 *  none (the EVM pools, until their own grid), any chunk, and the withdraw's floor. */
function gridOf(c: WithdrawCosts): { g: bigint; floor: bigint } {
  const own = withdrawNoteFloor(c);
  if (c.pieces === undefined) return { g: 1n, floor: own };
  return { g: c.pieces.grid, floor: c.pieces.floor > own ? c.pieces.floor : own };
}

/** The notes a plan may draw on, largest first, each with its choices: runs [lo, hi] of parts (part = chunk - fee - W's
 *  fee) of step g, a point when lo = hi. With no piece rule: all of it (`cap`), or a part in [minPart, cap - floor] (any
 *  chunk). With the pool's piece rule (card every-lamport-can-move): a chunk of one of the list's sizes
 *  (../../wallet/src/pool/pieces.ts isReleaseSize: a rung, card pool-amounts-are-standard-sizes) that leaves 0 or at
 *  least the floor; the whole note when it is a rung, or once when no rung of it leaves a change that moves (pieceChunk:
 *  a note made before the rule), or under the floor (main's planner left 3,000,000 and 4,000,000 notes; review P3-2 of
 *  00d6bef00). `top`: the note's largest part. */
type Choice = { id: string; runs: [bigint, bigint][]; top: bigint };
function choicesOf(notes: readonly WithdrawSource[], c: WithdrawCosts): Choice[] {
  const { floor } = gridOf(c);
  const k = c.fee + c.wFee;
  const r = c.pieces;
  return [...notes]
    .sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1))
    .map((n) => {
      const cap = capOf(n, c);
      const runs: [bigint, bigint][] = [];
      if (r === undefined) {
        if (cap >= c.minPart) runs.push([cap, cap]);
        if (cap - floor >= c.minPart) runs.push([c.minPart, cap - floor]);
      } else {
        if (cap >= c.minPart && (pieceChunk(r, n.value) === n.value || n.value < r.floor)) runs.push([cap, cap]);
        for (const size of n.value - floor >= r.floor ? releaseSizesUpTo(r, n.value - floor) : []) if (size - k >= c.minPart) runs.push([size - k, size - k]);
      }
      return { id: n.id, runs, top: runs.reduce((t, [, hi]) => (hi > t ? hi : t), 0n) };
    })
    .filter((n) => n.runs.length > 0)
    .slice(0, WITHDRAW_PLAN_NOTES);
}

/** What the notes can send to To: each note's largest part, for every note that gives at least the minimum. */
export function poolWithdrawable(notes: readonly WithdrawSource[], c: WithdrawCosts): bigint {
  return choicesOf(notes, c).reduce((t, n) => t + n.top, 0n);
}

/** Whether `x` is in one of plannableAmounts' runs: in [lo, hi] and lo apart from it by a whole number of `g`. */
const inRun = ([lo, hi]: readonly [bigint, bigint], x: bigint, g: bigint): boolean => lo <= x && x <= hi && (x - lo) % g === 0n;

/** Every amount a plan can send, as runs [lo, hi] of step g (gridOf: 1 with no piece rule, so each run is an interval),
 *  every lo + k x g up to hi: the sums of each note's none or one choice, sorted by lo and merged within each residue. */
export function plannableAmounts(notes: readonly WithdrawSource[], c: WithdrawCosts): [bigint, bigint][] {
  const { g } = gridOf(c);
  const res = (x: bigint): bigint => ((x % g) + g) % g;
  let r: [bigint, bigint][] = [[0n, 0n]];
  for (const n of choicesOf(notes, c)) {
    const next = [...r];
    for (const [clo, chi] of n.runs) for (const [lo, hi] of r) next.push([lo + clo, hi + chi]);
    next.sort((x, y) => (res(x[0]) !== res(y[0]) ? (res(x[0]) < res(y[0]) ? -1 : 1) : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    r = [];
    for (const iv of next) {
      const last = r[r.length - 1];
      if (last && res(last[0]) === res(iv[0]) && iv[0] <= last[1] + g) {
        if (iv[1] > last[1]) last[1] = iv[1];
      } else r.push([iv[0], iv[1]]);
    }
  }
  return r
    .filter(([, hi]) => hi > 0n)
    .map(([lo, hi]) => [lo > 0n ? lo : g, hi] as [bigint, bigint])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}
/** The plannable amounts nearest `amount` from below and above; none on a side with no plannable amount. */
export function nearestPlannable(notes: readonly WithdrawSource[], amount: bigint, c: WithdrawCosts): { below?: bigint; above?: bigint } {
  const { g } = gridOf(c);
  const out: { below?: bigint; above?: bigint } = {};
  for (const run of plannableAmounts(notes, c)) {
    const [lo, hi] = run;
    if (inRun(run, amount, g)) return { below: amount, above: amount };
    const below = amount > hi ? hi : amount >= lo ? lo + ((amount - lo) / g) * g : undefined;
    const above = amount < lo ? lo : amount <= hi ? lo + ((amount - lo) / g + 1n) * g : undefined;
    if (below !== undefined && (out.below === undefined || below > out.below)) out.below = below;
    if (above !== undefined && above <= hi && (out.above === undefined || above < out.above)) out.above = above;
  }
  return out;
}

/** The parts that send `amount` to To with the fewest parts (each part a fee), no part leaving a change between 0 and
 *  the note floor and every split part's chunk on the grid; null when no plan exists. Exactly `amount` when a plan sends
 *  it; with a piece rule, else the least plannable amount above it by under one grid step (a split part's chunk rounds
 *  up to the grid, and W sends all it holds to To, so up to 0.001 SOL more of the user's own money arrives than was
 *  typed and nothing stays behind). */
export function planPoolWithdraw(notes: readonly WithdrawSource[], amount: bigint, c: WithdrawCosts): WithdrawPart[] | null {
  if (amount < c.minPart || c.fee < 0n || c.wFee < 0n) return null;
  const { g } = gridOf(c);
  const runs = plannableAmounts(notes, c);
  if (runs.some((run) => inRun(run, amount, g))) return planExact(notes, amount, c);
  if (g === 1n) return null;
  // the amounts under one grid step above: each run's least at or above `amount`; the plan of the fewest parts (each
  // part a fee), then the least amount
  let best: WithdrawPart[] | null = null;
  for (const [lo, hi] of runs) {
    const x = amount <= lo ? lo : lo + ((amount - lo + g - 1n) / g) * g;
    if (x > hi || x - amount >= g) continue;
    const plan = planExact(notes, x, c);
    if (plan !== null && (best === null || plan.length < best.length)) best = plan;
  }
  return best;
}

function planExact(notes: readonly WithdrawSource[], amount: bigint, c: WithdrawCosts): WithdrawPart[] | null {
  const { g } = gridOf(c);
  const ns = choicesOf(notes, c);
  // most[i][j]: the most j of the notes from i on can give (their j largest tops), the search's bound
  const most = ns.map((_, i) => {
    const tops = ns.slice(i).map((n) => n.top).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const out = [0n];
    for (const t of tops) out.push(out[out.length - 1]! + t);
    return out;
  });
  type Pick = { i: number; run: [bigint, bigint] };
  // depth-first over notes, largest first, with at most k parts, each note none or one of its choices: `need` is what
  // the picks must give, at least their least sum and a whole number of g past it, at most their largest. A state that
  // failed is never searched again: whether it can end depends only on the note, what is left of need past the least
  // sum, the room between the least and the largest sum, and the parts left
  const failed = new Set<string>();
  const search = (i: number, need: bigint, lo: bigint, hi: bigint, k: number, picks: Pick[]): Pick[] | null => {
    if (picks.length > 0 && need >= lo && need <= hi && (need - lo) % g === 0n) return picks;
    const left = k - picks.length;
    if (i >= ns.length || left <= 0 || need < lo) return null;
    const room = most[i]![Math.min(left, ns.length - i)]!;
    if (need > hi + room) return null;
    const key = `${i}|${need - lo}|${hi - lo}|${left}`;
    if (failed.has(key)) return null;
    for (const run of ns[i]!.runs) {
      const got = search(i + 1, need, lo + run[0], hi + run[1], k, [...picks, { i, run }]);
      if (got) return got;
    }
    const got = search(i + 1, need, lo, hi, k, picks);
    if (!got) failed.add(key);
    return got;
  };
  // the fewest parts up to three (each part a fee), then the first plan the largest-first search finds with any number:
  // a bound on the search (16 notes of many sizes each), never a plan the screen and the run differ on (both call here)
  for (const k of [...new Set([1, 2, 3, ns.length])].filter((x) => x <= ns.length)) {
    const picks = search(0, amount, 0n, 0n, k, []);
    if (!picks) continue;
    // each part its run's least, then the rest given in pick order up to each run's top, in whole g
    let left = amount - picks.reduce((t, p) => t + p.run[0], 0n);
    const parts = picks.map((p) => {
      const more = left < p.run[1] - p.run[0] ? left : p.run[1] - p.run[0];
      left -= more;
      const part = p.run[0] + more;
      return { noteId: ns[p.i]!.id, part, chunk: part + c.fee + c.wFee };
    });
    return left === 0n ? parts : null;
  }
  return null;
}

/** What a withdraw run needs from the page. */
export type PoolWithdrawHost = Pick<PoolBuyHost, "send" | "now" | "reads" | "wait"> & {
  pin: SolanaPoolPin;
  /** The page's RPC pair (pageRpc): every read, and W's own send onward, go through it. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The wallet's solanaPool for the pin: now, trees, bind (the helper's fee checked against the device's). */
  pool: Pool<SolanaReleaseRequest>;
  prover: VaultProver;
  notes(): Promise<NoteStore>;
  /** The page's proof queue's drop of a note it holds (HELD -> UNSPENT); none when no queue is open. */
  drop?(noteId: string): Promise<void>;
  seed64(): Promise<Uint8Array>;
  /** One use of the seed (a derive or a signature), zeroed after it; absent: seed64. A finish passes one that takes
   *  the seed's shared lock for that use alone, so a sign out never waits on a blockhash. */
  withSeed?<T>(f: (seed64: Uint8Array) => T | Promise<T>): Promise<T>;
  /** The wallet's solanaSettleSpent for this note, its reads at or past minSlots when given (PoolBuyHost settle). */
  settle(noteId: string, minSlots?: readonly [number, number]): Promise<{ kind: "spent" | "unspent" }>;
  /** The onward send a part owes, written once its note is RESERVED and before its release leaves (awaited): a crash
   *  from there on leaves the op owing it, for the state reads' finishPoolOnward. */
  owe?(pending: PendingOnward): Promise<void>;
  /** A part's release read landed and its withdrawn value written on the note's mark: the page's balance reads it now
   *  (an owed/ write tells no store listener; card pool-buy-record-never-stays-sent). */
  marked?(noteId: string): void;
  /** The release's own signature, added to the owed send `noteId` of `attempt` only while it is still stored: never
   *  bringing back a send another tab has dropped, nor its old fee ceiling, and never touching the op (fold 4, LOW). */
  keepRelease?(noteId: string, attempt: string, release: string): Promise<void>;
  /** The notes an op still owes an onward send for (any tab's): never planned again until that op is settled, since a
   *  note's W is the same for every spend of it (review #232b MEDIUM 1). */
  owedNotes?(): Promise<ReadonlySet<string>>;
  /** The run's planned notes kept out of every proof queue (any tab's) and every other plan for `spanMs` from now on
   *  the device's clock (the longest a part can take to bind), written before any part and again at each; [] clears
   *  them, at every end. */
  keepOut?(noteIds: readonly string[], spanMs: bigint): Promise<void>;
  /** The op's stage, its txs so far, the onward send still owed and what reached To, by onward signature. */
  stage?(stage: WithdrawStage, txs: TxRef[], pending: PendingOnward | null, arrived: Arrivals): void;
  /** A payout to another chain (card pool-withdraws-to-any-chain): the deposit address of a 1Click quote checked on the
   *  device (../../kit/src/checks/oneclick-exit.ts), asked with `refundTo`, the run's first W (already public in this
   *  withdraw: it sends to that address), so a refund names nothing the withdraw does not. Called once, after the plan
   *  and before any note moves; the address it answers is the run's To, checked as any To is. */
  exit?(refundTo: string): Promise<string>;
  /** A Move's claim (src/pool-to-cash.ts, card move-sends-or-says-why): awaited right before a release is taken to leave
   *  the device, before its note is RESERVED; a throw ends the run stopped with nothing sent. */
  claim?(): Promise<void>;
};

/** A part's onward send still owed: its note (W is the note's own W_{sol, label, j}, derived on the device; the op
 *  record names no label, so it links no withdraw to its deposit), the attempt whose release owes it and that
 *  attempt's context (the note keeps its attempts' contexts once SPENT, its attempt id only while RESERVED), To, whether
 *  it is the run's last part, and W's fee ceiling for it (lamports, a decimal): the drawn Max fee's share of the part
 *  less the relay fee, never exceeded; `release`, the release's own signature once sent (spendOwner reads it back first). */
export type PendingOnward = { noteId: string; attempt: string; context: string; to: string; last: boolean; feeCap: string; release?: string };
/** What reached To, by onward signature (lamports as a decimal): what each send moved, read from its own bytes. */
export type Arrivals = Record<string, string>;
/** feeNeeded: W's fee the network reads now when it is over the part's ceiling (lamports, a decimal): the send stays
 *  owed until the Max fee is drawn again. */
/** `cause`: why a run ended on a throw, in public words only (pool-sell.ts legCause: the error's name, its code, where
 *  it was thrown, never its text); for the op's record and the page's console, never a screen. */
export type PoolWithdrawAnswer = { stage: WithdrawStage; txs: TxRef[]; pending: PendingOnward | null; arrived: Arrivals; feeNeeded?: string; cause?: string };
/** A finish's verdict: the op's stage and what its send added; feeNeeded set keeps the send owed. */
export type PoolOnwardFinish = { stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals; feeNeeded?: string };

/** A run's own refusal, its word in `code` (an op's cause names it, legCause). */
class Stop extends Error {
  readonly code: string;
  constructor(why: string) {
    super(why);
    this.code = why;
  }
}
const stop = (why: string): never => {
  throw new Stop(why);
};
const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));
const lamports = (x: unknown): bigint => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : stop("read"));
const agree = <T>(a: T, b: T): T => (a === b ? a : stop("reads"));
const slotOf = (x: unknown): number => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : stop("read"));

/** The higher of both RPCs' finalized slots, read once a spend was read at finalized: a balance read at or past it
 *  (minContextSlot, on both RPCs) holds that spend's credit to W, never a lagging node's older 0 (review #232b LOW 2). */
async function finalSlot(rpcs: readonly [SolanaRpc, SolanaRpc]): Promise<number> {
  const s = await Promise.all(rpcs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])));
  return Math.max(...s.map(slotOf));
}

/** W's balance, the same on both RPCs, read at or past `minSlot` when one is given. */
async function balanceOf(rpcs: readonly [SolanaRpc, SolanaRpc], address: string, minSlot?: number): Promise<{ balance: bigint; each: [bigint, bigint] }> {
  const opts = minSlot === undefined ? { commitment: "confirmed" } : { commitment: "confirmed", minContextSlot: minSlot };
  const bal = await Promise.all(rpcs.map(async (rpc) => lamports(((await rpc("getBalance", [address, opts])) as { value?: unknown } | null)?.value)));
  return { balance: agree(bal[0]!, bal[1]!), each: [bal[0]!, bal[1]!] };
}
const transferIx = (from: string, to: string, v: bigint) => ({
  program: SOLANA_SYSTEM_PROGRAM,
  accounts: [{ key: from, signer: true, writable: true }, { key: to, signer: false, writable: true }],
  data: Uint8Array.of(2, 0, 0, 0, ...u64le(v)),
});

/** W's onward send's message: one System transfer of `v` from `from` to `to`, `from` its only signer and fee payer. */
const onwardMessage = (from: string, to: string, v: bigint, blockhash: string): Uint8Array =>
  solanaCompileV0(from, [transferIx(from, to, v)], blockhash, [], [from]).message;

/** W's fee for its send onward: the network's fee for a message of exactly the onward's shape (onwardMessage: one
 *  signer, one System transfer), on both RPCs (they must agree). Its stand-in keys are the pool and the fee payer, so
 *  no read names W or To. */
export async function solanaOnwardFee(rpcs: readonly [SolanaRpc, SolanaRpc], pin: SolanaPoolPin): Promise<bigint> {
  const bh = await blockhashOf(rpcs);
  return feeOf(rpcs, onwardMessage(solanaPoolAccount(pin.program), pin.feePayer, 1n, bh.blockhash));
}
async function feeOf(rpcs: readonly [SolanaRpc, SolanaRpc], message: Uint8Array): Promise<bigint> {
  const read = async (rpc: SolanaRpc) => lamports(((await rpc("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown } | null)?.value);
  const [a, b] = await Promise.all(rpcs.map(read));
  return agree(a!, b!);
}

/** The landed notes of the pool's scope a withdraw may spend: UNSPENT, or HELD. A HELD note has nothing sent (every
 *  send moves it RESERVED first: queue.ts take, request.ts, onePart below), so it is a proof queue's ready or in-flight
 *  proof (any tab's), or a withdraw part's, which the caller leaves out with the owed and kept-out notes. Its run frees it
 *  first (free(): this page's queue drops it, another tab's lets go at its next pass, queue.ts skip). */
export function withdrawSources(list: readonly NoteRecord[], scope: bigint): WithdrawSource[] {
  return list.filter((n) => n.scope === scope && n.leaf !== undefined && (n.state === "UNSPENT" || n.state === "HELD")).map((n) => ({ id: n.id, value: n.leaf!.value }));
}

/** To's account on both RPCs: never executable, never one the pool program owns (its pages, marks, the pool). */
async function checkTo(h: Pick<PoolWithdrawHost, "rpcs" | "pin">, to: string): Promise<[boolean, boolean]> {
  const read = async (rpc: SolanaRpc) => {
    const r = (await rpc("getAccountInfo", [to, { encoding: "base64", commitment: "confirmed" }])) as { value?: { owner?: unknown; executable?: unknown } | null } | null;
    const v = r?.value;
    if (v === null) return false;
    if (typeof v !== "object" || typeof v.owner !== "string" || typeof v.executable !== "boolean") return stop("read");
    if (v.owner === h.pin.program) stop("to");
    return v.executable;
  };
  const [a, b] = await Promise.all(h.rpcs.map(read));
  if (a || b) stop("to");
  return [a!, b!];
}

/** One use of the seed, zeroed after: the host's own (a lock per use), else seed64. */
const seedUse = (h: Pick<PoolWithdrawHost, "seed64" | "withSeed">) =>
  h.withSeed?.bind(h) ??
  (async <T>(f: (seed64: Uint8Array) => T | Promise<T>): Promise<T> => {
    const s = await h.seed64();
    try {
      return await f(s);
    } finally {
      s.fill(0);
    }
  });

/** A note's W: W_{sol, label, j}, derived and its secret key zeroed at once. */
const wOf = (seed: Uint8Array, n: NoteRecord): string => {
  const w = freshWallet(seed, "sol", n.leaf!.label, jOf(n.ref));
  w.secretKey.fill(0);
  return w.address;
};
/** A note's W and its nullifier hash (public once spent: the release carries it). */
const spendKeysOf = (seed: Uint8Array, n: NoteRecord): { w: string; nullifierHash: bigint } => ({ w: wOf(seed, n), nullifierHash: noteSecrets(seed, n.ref).nullifierHash });

/** To on the pool's own terms: never the pool, its program, the fee payer, a key the runtime keeps read-only (a
 *  sysvar or a native program: nothing can be paid there), nor any W of the plan. */
const toRefused = (to: string, pin: SolanaPoolPin, pool: string, ws: readonly string[]): boolean =>
  [pool, pin.program, pin.feePayer, ...SOLANA_RESERVED_KEYS, ...ws].includes(to);

/** One withdraw of `amount` (base units arriving at `to`), `to` the address typed on this page and checked there, and
 *  `maxFee` the Max fee the screen drew: a plan that would cost more stops before its first part. */
export async function runPoolWithdraw(h: PoolWithdrawHost, ask: PoolAsk, to: string, amount: bigint, maxFee: bigint): Promise<PoolWithdrawAnswer> {
  const txs: TxRef[] = [];
  const arrived: Arrivals = {};
  let pending: PendingOnward | null = null;
  let feeNeeded: bigint | null = null;
  const say = (s: WithdrawStage): void => h.stage?.(s, txs.slice(), pending, { ...arrived });
  const end = (s: WithdrawStage): PoolWithdrawAnswer => (say(s), { stage: s, txs: txs.slice(), pending, arrived: { ...arrived }, ...(feeNeeded !== null ? { feeNeeded: feeNeeded.toString() } : {}) });
  try {
    if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") stop("kind");
    if (typeof maxFee !== "bigint" || maxFee < 0n) stop("max_fee");
    const { scope } = solanaPoolOf(h.pin.program);
    const pool = solanaPoolAccount(h.pin.program);
    const rent = await readSolanaRent(h.rpcs);
    const fee = solanaPoolFee(rent);
    const wFee = await solanaOnwardFee(h.rpcs, h.pin);
    // the pool's own piece rule (the wallet's solanaPool: SOL_PIECES), the one the screen's funds plan with
    const costs: WithdrawCosts = { fee, wFee, minPart: solanaWithdrawMinPart(rent, fee, wFee), ...(h.pool.pieces !== undefined ? { pieces: h.pool.pieces } : {}) };
    const notes = await h.notes();
    // a note an op still owes a send for stays out of the plan: its W is this spend's W too (review #232b MEDIUM 1)
    const owedNotes = (await h.owedNotes?.()) ?? new Set<string>();
    const list = await notes.list();
    const sources = withdrawSources(list, scope).filter((n) => !owedNotes.has(n.id));
    // the notes under the epoch root first, but never in more parts than the plan over every note: the screen drew its
    // Max fee on that one (withdraw/pool-form.ts over withdrawSources), so the rested preference never costs more
    const rested = await restedNotes(h.pool, list);
    const all = planPoolWithdraw(sources, amount, costs);
    const quiet = rested === null ? null : planPoolWithdraw(sources.filter((n) => rested.has(n.id)), amount, costs);
    const plan = quiet !== null && all !== null && quiet.length <= all.length ? quiet : all;
    if (plan === null) stop("plan");
    // review #232 MEDIUM 1: never more than the Max fee the screen showed
    if (BigInt(plan!.length) * (fee + wFee) > maxFee) stop("max_fee");
    // review #232b LOW 4: the Max fee is a ceiling: each part's onward pays at most its share of it less the relay fee
    // (at least the planned wFee), so To never gets less than the amount less the Max fee drawn
    const wCap = maxFee / BigInt(plan!.length) - fee;
    // To checked before any note moves, so no release is made for a send that could never land: never the pool's own
    // keys, a read-only key or one of the plan's own Ws, and on both RPCs never executable nor the pool program's
    const spends = await seedUse(h)(async (seed) => {
      const out: { w: string; nullifierHash: bigint }[] = [];
      for (const p of plan!) {
        const n = await notes.get(p.noteId);
        if (n?.leaf === undefined) stop("note");
        out.push(spendKeysOf(seed, n!));
      }
      return out;
    });
    // another chain: To is the checked quote's deposit address on this chain, its refund the first W
    if (h.exit) to = await h.exit(spends[0]!.w);
    if (toRefused(to, h.pin, pool, spends.map((x) => x.w))) stop("to");
    await checkTo(h, to);
    // from here to the run's end no queue in any tab takes a planned note (each part refreshes the record's deadline)
    if (h.keepOut) await h.keepOut(plan!.map((x) => x.noteId), keepSpan(h.pool));
    for (const [i, p] of plan!.entries()) {
      say("proving");
      // the release's take writes the note RESERVED, then the pending (with the attempt): from then on a crash leaves
      // it owed
      const keep = (): Promise<void> => h.keepOut?.(plan!.map((x) => x.noteId), keepSpan(h.pool)) ?? Promise.resolve();
      const got = await onePart(h, ask, notes, p, fee, wFee, pool, { to, last: i === plan!.length - 1, feeCap: wCap.toString() }, (owed) => void (pending = owed), keep);
      // the release's signature only as both RPCs read it as this release (card signpage-sent-read-back): a helper's
      // word not read back is never in the op's txs
      if (got.signature !== "") txs.push({ chain: "solana", hash: got.signature });
      if (got.stage === "refused" || got.stage === "not_landed") {
        // the release can never land (failed on both RPCs, or its blockhash past on both with no spend): nothing on W
        pending = null;
        return end("stopped");
      }
      // review #232b HIGH 1: any other answer short of filled (the release read back but its spend not yet read at
      // finalized, or the helper's error while it may still land) keeps the part owed, for finishPoolOnward
      if (got.stage !== "filled") return end(pending ? "in_transit" : "stopped");
      // filled: the note's spend read at finalized, and both RPCs read that the release which spent it is this
      // attempt's (sendAndSettle through spendOwner, card signpage-buy-own-spend: another device on the same 12 words
      // spends the same note to the same W, round-3 review LOW 1). Another's was not_landed above (stopped, nothing
      // sent from W, its money left for that device's own send); one not read yet was "sent" (in_transit, owed)
      say("in_transit");
      // the release may have reached finalized after the spend's read: W is read at or past the finalized slot read now
      // (fold 4, LOW)
      const minSlot = await finalSlot(h.rpcs);
      // the part is on W; W read at or past both RPCs' finalized slot after the spend was read there
      const on = await sendOnward(h, ask, got.l, got.j, to, got.releaseAccounts, { minSlot, feeCap: wCap });
      if (on.signature !== "") txs.push({ chain: "solana", hash: on.signature });
      if (on.state === "fee") feeNeeded = on.need;
      if (on.state === "ok") arrived[on.signature] = on.amount.toString();
      // empty: another tab's finish sent it already (its signature in its own write of the op); never the run's end
      else if (on.state !== "empty") return end("in_transit");
      pending = null;
      if (i < plan!.length - 1) say("submitted");
    }
    return end("sent");
  } catch (e) {
    return { ...end(pending ? "in_transit" : "stopped"), cause: legCause(e) };
  } finally {
    // the planned notes back to every queue (a failed write: they come back at the record's own deadline)
    await h.keepOut?.([], 0n).catch(() => {});
  }
}

/** A sale's ride (card every-lamport-can-move T3): the piece one of the pool's notes gives so that a sale's W, whose rest
 *  is under the floor, reaches a note. The least size of the closed list (isReleaseSize) whose change still moves
 *  (changeMoves) and that `fits`; of one size, the least note, then the first listed. null: no note gives one. */
export function ridePiece(r: PieceRule, sources: readonly WithdrawSource[], fits: (chunk: bigint) => boolean): { noteId: string; chunk: bigint } | null {
  let best: { noteId: string; chunk: bigint; value: bigint } | null = null;
  for (const n of sources)
    for (const chunk of releaseSizesUpTo(r, n.value).reverse()) {
      if (!isReleaseSize(r, chunk) || !changeMoves(r, n.value - chunk) || !fits(chunk)) continue;
      if (best === null || chunk < best.chunk || (chunk === best.chunk && n.value < best.value)) best = { noteId: n.id, chunk, value: n.value };
      break;
    }
  return best === null ? null : { noteId: best.noteId, chunk: best.chunk };
}

/** A sale's ride (card every-lamport-can-move T3): one piece of the pool's own notes (ridePiece, the notes the withdraw
 *  reads: withdrawSources less those an op still owes a send for) released to the sale's W `to` through the withdraw's
 *  own part (onePart: the helper's bind, its fee the device's, the rule's check, the relay, the release read back on
 *  both RPCs and its spend read at finalized), its change and refund the note's own (as the queue's tier 2: queue.ts
 *  prove). No onward send: the sale's rent back sweeps W. `fits(got)`: whether what W gets (the chunk less the relay
 *  fee) lifts W's rest to a note. "none": no note gives one, nothing released; "landed": the release read back and its
 *  spend final; "unsure": a release that may still land (W's rent back stays owed and the next load sweeps it). */
export async function runPoolRide(h: PoolWithdrawHost, to: { address: string; l: bigint; j: number }, fits: (got: bigint) => boolean): Promise<PoolRide> {
  const ask: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
  const pieces = h.pool.pieces;
  if (pieces === undefined) return { state: "none" };
  const { scope } = solanaPoolOf(h.pin.program);
  const pool = solanaPoolAccount(h.pin.program);
  const fee = solanaPoolFee(await readSolanaRent(h.rpcs));
  const notes = await h.notes();
  const owedNotes = (await h.owedNotes?.()) ?? new Set<string>();
  const sources = withdrawSources(await notes.list(), scope).filter((n) => !owedNotes.has(n.id));
  const p = ridePiece(pieces, sources, (chunk) => chunk > fee && fits(chunk - fee));
  if (p === null) return { state: "none" };
  // W never the pool's own keys nor a read-only key: the release would pay nothing W can sweep
  if (toRefused(to.address, h.pin, pool, [])) stop("to");
  const keep = (): Promise<void> => h.keepOut?.([p.noteId], keepSpan(h.pool)) ?? Promise.resolve();
  try {
    await keep();
    // no owed onward and no kept release: nothing is sent from W but the sale's sweep
    const { owe: _owe, keepRelease: _keep, ...quiet } = h;
    const got = await onePart(quiet, ask, notes, { noteId: p.noteId, part: p.chunk - fee, chunk: p.chunk }, fee, 0n, pool, { to: to.address, last: true, feeCap: "0" }, () => {}, keep, to);
    if (got.stage === "filled") return { state: "landed", signature: got.signature, got: p.chunk - fee };
    if (got.stage === "refused" || got.stage === "not_landed") return { state: "stopped" };
    return { state: "unsure", signature: got.signature };
  } finally {
    await h.keepOut?.([], 0n).catch(() => {});
  }
}

/** The state reads' pass for an op that owes a part's onward send (any stage: a tab closed while the release was out
 *  leaves "proving" or "in_transit"): settles every case, never waits forever, never sends another spend's money.
 *  - The note not this pending's attempt's (RESERVED by another attempt, back UNSPENT, HELD, SPENT after a later
 *    attempt, gone): that attempt never landed, or its send is settled: stopped, nothing sent (review #232b MEDIUM 1).
 *  - Whose release spent the note, on both RPCs (spendOwner, W's finalized history; round-3 review LOW 1: another
 *    device on the same 12 words spends the same note to the same W, and its note store is its own). Another's:
 *    stopped, nothing sent (its money is that device's to send on). None read yet: the note's own spend read; still
 *    RESERVED by this attempt with no spend: null, read again by the next pass (the reserved pass frees it once both
 *    RPCs' block time is past its deadline: the note store's rule for every RESERVED note,
 *    packages/wallet/src/notes/store.ts, a sent proof can land until its deadline).
 *  - This attempt's: W read at or past both RPCs' finalized slot read after the spend (LOW 2):
 *    - W holds lamports: its send onward, all it holds less its fee, to To; a fee over the part's ceiling keeps it
 *      owed (feeNeeded), and so does a To the checks now refuse (null): the money is on W, so nothing drops it;
 *    - W at 0: its send went (this tab's or another's): sent, or stopped when parts were left after it.
 *  null also when a read or the send fails: the money may be on W, so the pass goes on trying.
 *  `h.places`: this send's places in W's history, kept by the caller from one pass to the next (none: each pass reads
 *  from the newest). */
export async function finishPoolOnward(
  h: Pick<PoolWithdrawHost, "rpcs" | "pin" | "seed64" | "withSeed" | "now" | "wait" | "notes" | "settle"> & { places?: HistoryPlaces },
  pending: PendingOnward,
): Promise<PoolOnwardFinish | null> {
  const done = (stage: WithdrawStage, txs: TxRef[] = [], arrived: Arrivals = {}): PoolOnwardFinish => ({ stage, txs, arrived });
  try {
    const ask: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
    const notes = await h.notes();
    const n = await notes.get(pending.noteId);
    if (n?.leaf === undefined) return done("stopped");
    // an owed send names its attempt and that attempt's context; one that names neither is no attempt's
    if (typeof pending.attempt !== "string" || pending.attempt === "" || typeof pending.context !== "string" || pending.context === "") return done("stopped");
    const mine = (x: NoteRecord): boolean =>
      (x.state === "RESERVED" && x.attempt === pending.attempt) || (x.state === "SPENT" && x.contexts?.at(-1)?.context === pending.context);
    if (!mine(n)) return done("stopped");
    const l = n.leaf.label;
    const j = jOf(n.ref);
    const { w: W, nullifierHash } = await seedUse(h)((seed) => spendKeysOf(seed, n));
    // the spend first: lamports on W say nothing of whose release put them there. Its finalized release in W's history
    // on both RPCs; none there yet, the note's own spend read settles it (spent: read the history again; freed by the
    // reserved pass: no longer this attempt's)
    let minSlot = await finalSlot(h.rpcs);
    const places = h.places ?? new Map();
    let owner = await spendOwner(h.rpcs, h.pin, W, nullifierHash, pending.context, minSlot, pending.release, places);
    if (owner === null) {
      if (n.state === "SPENT") return null;
      const spent = (await h.settle(pending.noteId)).kind === "spent";
      const now = await notes.get(pending.noteId);
      if (now === undefined || !mine(now)) return done("stopped");
      if (!spent) return null;
      minSlot = await finalSlot(h.rpcs);
      owner = await spendOwner(h.rpcs, h.pin, W, nullifierHash, pending.context, minSlot, pending.release, places);
      if (owner === null) return null;
    }
    if (owner === "other") return done("stopped");
    // a RESERVED note's release read back by its own signature may have reached finalized after minSlot was read: W
    // is read at or past the finalized slot read now (fold 4, LOW)
    minSlot = await finalSlot(h.rpcs);
    // a 0 is believed only at or past both RPCs' finalized slot read after the spend was read (LOW 2)
    const { balance } = await balanceOf(h.rpcs, W, minSlot);
    if (balance === 0n) return done(pending.last ? "sent" : "stopped");
    if (toRefused(pending.to, h.pin, solanaPoolAccount(h.pin.program), [W])) return null;
    await checkTo(h, pending.to);
    // the release's own accounts, as both RPCs read the spend: To may be none of them (review LOW 4: a resumed send
    // passed none, so only the checks above held it)
    const on = await sendOnward(h, ask, l, j, pending.to, owner.accounts, { minSlot, feeCap: BigInt(pending.feeCap) });
    if (on.state === "ok") return done(pending.last ? "sent" : "stopped", [{ chain: "solana", hash: on.signature }], { [on.signature]: on.amount.toString() });
    if (on.state === "fee") return { stage: "in_transit", txs: [], arrived: {}, feeNeeded: on.need.toString() };
    return null;
  } catch {
    return null;
  }
}

/** How long W's send onward goes on: resends of the same bytes while its blockhash lives, then a fresh blockhash. */
export const POOL_ONWARD_TRIES = 3;
export const POOL_ONWARD_RESEND_MS = 2_000;

/** W's send onward: all W holds less its own fee to To, W the only signer and fee payer, so W ends at 0. Built,
 *  checked by the rule (checkSolanaOnwardSend), signed by W, sent and read back on both of the page's RPCs. The fee is
 *  the network's for this very message: a fee other than the one planned changes what reaches To (`amount`, kept in
 *  the op's record), never W's end at 0, so no part is ever left on W for it (review #232b LOW 1). */
async function sendOnward(
  h: Pick<PoolWithdrawHost, "rpcs" | "pin" | "seed64" | "withSeed" | "now" | "wait">,
  ask: PoolAsk,
  l: bigint,
  j: number,
  to: string,
  releaseAccounts: readonly string[],
  o: { minSlot?: number; feeCap: bigint },
): Promise<{ state: "ok" | "failed" | "empty" | "unknown"; signature: string; amount: bigint } | { state: "fee"; signature: string; amount: 0n; need: bigint }> {
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const use = seedUse(h);
  let signature = "";
  try {
    const address = await use((seed) => {
      const w = freshWallet(seed, "sol", l, j);
      w.secretKey.fill(0);
      return w.address;
    });
    for (let attempt = 0; attempt < POOL_ONWARD_TRIES; attempt++) {
      // at or past the spend's finalized slot on both RPCs (o.minSlot): a 0 is W's own, never a lagging node's
      const { balance, each: bal } = await balanceOf(h.rpcs, address, o.minSlot);
      if (balance === 0n) return { state: "empty", signature, amount: 0n };
      const bh = await blockhashOf(h.rpcs);
      // the fee is per signature: the same for the draft and the send, whose amount alone differs
      const fee = await feeOf(h.rpcs, onwardMessage(address, to, balance, bh.blockhash));
      // a fee W cannot pay out of what it holds is a plain refusal, never a fee to draw again (fold 2, review LOW 4)
      if (balance <= fee) return { state: "failed", signature, amount: 0n };
      // the Max fee drawn is a ceiling (review #232b LOW 4): over it, nothing is sent and the send stays owed
      if (fee > o.feeCap) return { state: "fee", signature, amount: 0n, need: fee };
      const exec = await checkTo(h, to);
      const message = onwardMessage(address, to, balance - fee, bh.blockhash);
      const wire = new Uint8Array(1 + 64 + message.length);
      wire[0] = 1;
      wire.set(message, 65);
      const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: address, feeCap: fee, solana: h.pin };
      checkSolanaOnwardSend(wire, ask, ctx, to, { blockhash: bh.blockhash, balance: [bal[0]!, bal[1]!], fee: [fee, fee], toExecutable: exec, releaseAccounts });
      // W, from the seed, right before it signs: the one the bytes were built and checked for; its key zeroed at once
      const sig = await use((seed) => {
        const signer = freshWallet(seed, "sol", l, j);
        try {
          if (signer.address !== address) stop("wallet");
          return signSolana(signer.secretKey, wire);
        } finally {
          signer.secretKey.fill(0);
        }
      });
      const signed = wire.slice();
      signed.set(sig, 1);
      signature = base58.encode(sig);
      const b64 = base64.encode(signed);
      // the same bytes to both RPCs until both read it back, while its blockhash lives
      for (;;) {
        await Promise.all(h.rpcs.map((rpc) => Promise.resolve().then(() => rpc("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 0 }])).catch(() => null)));
        const got = await Promise.all(h.rpcs.map((rpc) => readBack(rpc, signature, signed).catch(() => "none" as const)));
        if (got[0] === "ok" && got[1] === "ok") return { state: "ok", signature, amount: balance - fee };
        if (got[0] === "failed" && got[1] === "failed") return { state: "failed", signature, amount: 0n };
        if (await pastOnBoth(h.rpcs, bh.lastHeight)) {
          // past its last block on both: it can never land; one more read decides, then a fresh blockhash
          const last = await Promise.all(h.rpcs.map((rpc) => readBack(rpc, signature, signed).catch(() => "none" as const)));
          if (last[0] === "ok" && last[1] === "ok") return { state: "ok", signature, amount: balance - fee };
          break;
        }
        await wait(POOL_ONWARD_RESEND_MS);
      }
    }
    return { state: "unknown", signature, amount: 0n };
  } catch (e) {
    if (e instanceof PoolRuleRefused) return { state: "failed", signature, amount: 0n };
    throw e;
  }
}

/** A part's one budget for its waits on chain time is one epoch and this: the pool's time is the lower of two RPCs'
 *  finalized block times, which trails the device by about 13 s on mainnet; past it a provider is stalled. A part
 *  waits only while a tree read has not reached its cut, or the newest cut does not hold its note's leaf yet. */
export const WITHDRAW_BOUNDARY_LAG_MS = 30_000n;
/** A withdraw's tree read, bounded in wall-clock time: the read counts its waits (solana.ts SOL_REACH_WAITS), and a
 *  provider that answers each call slowly would stretch them; the read stops at its next wait past this. */
export const WITHDRAW_TREES_MS = 30_000;
/** How long a run's kept-out record stands on the device's clock from each write: the longest a part takes from its
 *  write to its bind (one wait's budget) and that bind's life. */
const keepSpan = (P: PoolWithdrawHost["pool"]): bigint => P.epochMs + WITHDRAW_BOUNDARY_LAG_MS + P.lifeMs;
/** How long a part waits for a note this page's queue is still proving to come back UNSPENT once dropped (a proof takes
 *  6.7 s on a laptop, run 6d; a slow phone several times that): past it the note is another's and the part stops. */
export const WITHDRAW_FREE_MS = 30_000;

/** The landed notes under the pool's epoch root now (leaf index below the epoch tree's size); none when the epoch root
 *  holds no leaf (PoolNoLeafError); null when the read fails, so the plan draws on every note and each part reads its own
 *  roots. */
async function restedNotes(P: PoolWithdrawHost["pool"], list: readonly NoteRecord[]): Promise<ReadonlySet<string> | null> {
  try {
    const nowMs = await P.now();
    const size = BigInt((await P.trees(nowMs - (nowMs % P.epochMs), AbortSignal.timeout(WITHDRAW_TREES_MS))).stateTree.size);
    return new Set(list.filter((n) => n.leaf !== undefined && n.leaf.leafIndex < size).map((n) => n.id));
  } catch (e) {
    return e instanceof PoolNoLeafError ? new Set() : null;
  }
}

/** One part's release to W: hold the note, prove part + fees to W, build, check, sign, RESERVED, then the send and
 *  its settle. The release is alone in its transaction (review #232 HIGH 1). W is the note's own, or `to` (a sale's
 *  ride, runPoolRide: W_{sol, to.l, to.j}, its change and refund still the note's own, as the queue's tier 2). */
async function onePart(h: PoolWithdrawHost, ask: PoolAsk, notes: NoteStore, p: WithdrawPart, fee: bigint, wFee: bigint, pool: string, base: Pick<PendingOnward, "to" | "last" | "feeCap">, owing: (owed: PendingOnward) => void, keep: () => Promise<void> = async () => {}, to?: { l: bigint; j: number }): Promise<{ stage: string; signature: string; l: bigint; j: number; releaseAccounts: string[] }> {
  const P = h.pool;
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let attempt: string | null = null;
  let reserved = false;
  try {
    const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    // the note, dropped first when this page's proof queue holds it; one it is still proving, or another tab's queue
    // holds, comes back UNSPENT when that proof ends or at that queue's next pass (the kept-out record's write wakes it:
    // queue.ts skip), waited for at most WITHDRAW_FREE_MS
    const free = async (): Promise<NoteRecord> => {
      let n = await notes.get(p.noteId);
      if (n?.state === "HELD") {
        // the queue's drop waits in the note's turn (behind a swap and a state read): bounded as the wait below, past
        // it the part stops with nothing held by it (card move-sends-or-says-why)
        if (h.drop) await within(h.drop(p.noteId), WITHDRAW_FREE_MS, "the proof queue's drop").catch(() => stop("drop"));
        for (let waited = 0; (n = await notes.get(p.noteId))?.state === "HELD" && waited < WITHDRAW_FREE_MS; waited += 500) await wait(500);
      }
      if (n === undefined || n.state !== "UNSPENT" || n.leaf === undefined) stop("note");
      return n!;
    };
    let n: NoteRecord = await free();
    const leaf = n.leaf!;
    if (leaf.value < p.chunk) stop("value");
    // the epoch root when the note is in it; else the newest both RPCs agree on, which holds every leaf up to now
    let nowMs = await P.now();
    // the run's notes stay out of every queue's pass (any tab's) past the latest deadline this part can bind: so no
    // queue holds this note at the boundary it may wait for
    await keep();
    // one budget for every wait of this part on chain time: the boundary's and a tree read's lag
    const left = { ms: P.epochMs + WITHDRAW_BOUNDARY_LAG_MS };
    // a provider's read still short of the cut past the sync's own waits (solana.ts, code not_reached) is a lag, as the
    // EVM sync's anchor lag is: read again a second later out of the budget, and stopped only once it is spent
    // a cut that holds no leaf (an empty pool's first leaf landing this epoch: PoolNoLeafError) is a cut that does not
    // hold the note: null, so the newest root is taken at once
    const read = async (cut: bigint, opts?: Parameters<typeof P.trees>[2]): Promise<PoolTrees | null> => {
      for (;;) {
        try {
          return await P.trees(cut, AbortSignal.timeout(WITHDRAW_TREES_MS), opts);
        } catch (e) {
          if (e instanceof PoolNoLeafError) return null;
          if ((e as { code?: unknown } | null)?.code !== "not_reached" || left.ms <= 0n) throw e;
          const ms = left.ms < 1_000n ? left.ms : 1_000n;
          await wait(Number(ms));
          left.ms -= ms;
        }
      }
    };
    const holds = (t: PoolTrees | null): t is PoolTrees => t !== null && leaf.leafIndex < BigInt(t.stateTree.size);
    let epochStartMs = nowMs - (nowMs % P.epochMs);
    let trees = await read(epochStartMs);
    let root: "epoch" | "newest" = "epoch";
    for (let waited = false; !holds(trees); ) {
      // a note that landed this epoch: the newest root, at once
      const newest = await read(nowMs + 1n, { newest: true });
      if (holds(newest)) {
        trees = newest;
        root = "newest";
        // a queue that held it before the record was written, during a wait: dropped as at the start
        if (waited) n = await free();
        break;
      }
      // its leaf past the pool's time (its landing read ahead of both RPCs' final block): the pool's time read again a
      // second later, out of the one budget; a new epoch's root may hold it by then
      if (left.ms <= 0n) stop("leaf");
      const ms = left.ms < 1_000n ? left.ms : 1_000n;
      await wait(Number(ms));
      left.ms -= ms;
      waited = true;
      const at = await P.now();
      if (at > nowMs) nowMs = at;
      if (nowMs - (nowMs % P.epochMs) !== epochStartMs) {
        epochStartMs = nowMs - (nowMs % P.epochMs);
        trees = await read(epochStartMs);
        if (holds(trees)) n = await free();
      }
    }
    const deadlineMs = epochStartMs + P.lifeMs;
    const j = jOf(n.ref);
    const wl = to === undefined ? leaf.label : to.l;
    const wj = to === undefined ? j : to.j;
    seed = await h.seed64();
    const w = freshWallet(seed, "sol", wl, wj);
    w.secretKey.fill(0);
    const refundPrecommitment = noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment;
    const spent = noteSecrets(seed, n.ref);
    const next = noteSecrets(seed, { kind: "change", l: leaf.label, j });
    // shut before the bind asks the helper's fee: a busy helper is waited out (../../wallet/src/busy.ts) with no seed open
    seed.fill(0);
    seed = null;
    // tipCap 0: the tag 2 pays no tip, so W's floor is rent(0) and the backstop alone
    const binding = await P.bind({ chunk: p.chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs, tipCap: 0n });
    checkBinding(P as Pool, binding, p.chunk);
    // the device's fee, never the helper's word: the binding's fee is the one the plan priced, its tip cap 0
    if (binding.request.relayFee !== fee || binding.feeCap !== fee || binding.request.tipCap !== 0n || p.chunk !== p.part + fee + wFee) stop("fee");
    attempt = (await notes.move(p.noteId, "UNSPENT", "HELD", { deadlineMs, context: binding.context.toString() })).attempt!;
    const made = await poolProveWithdraw(h.prover, {
      stateTree: trees.stateTree,
      labelTree: trees.labelTree,
      newestStateRoot: trees.stateRoot,
      newestLabelRoot: trees.labelRoot,
      note: { value: leaf.value, label: leaf.label, nullifier: spent.nullifier, secret: spent.secret },
      newNullifier: next.nullifier,
      newSecret: next.secret,
      withdrawn: p.chunk,
      context: binding.context,
    });
    const r: ReadyProof<SolanaReleaseRequest> = {
      noteId: p.noteId, attempt, poolId: P.id, wallet: { chain: "sol", l: wl, j: wj, path: w.path, address: w.address }, chunk: p.chunk,
      epochStartMs, deadlineMs, root, binding, proof: made.proof, publicSignals: made.publicSignals,
    };
    const sizes = await treeSizes(h, pool, wait);
    const idx = { state: await rootIndex(h, 0, sizes.state, BigInt(r.publicSignals[3])), label: await rootIndex(h, 1, sizes.label, BigInt(r.publicSignals[5])) };
    const release = releaseOf(r, h.pin, w.address, idx);
    const rent = await readSolanaRent(h.rpcs);
    const bh = await blockhashOf(h.rpcs);
    const cfg = { program: h.pin.program, pool };
    const accounts = solanaPoolTag2Accounts(cfg, w.address, h.pin.feePayer, release, sizes.stateSize);
    const ixs = [
      { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u32le(POOL_WITHDRAW_CU)) },
      { program: h.pin.program, accounts, data: solanaEncodePoolRelease(release) },
    ];
    const { message } = solanaCompileV0(h.pin.feePayer, ixs, bh.blockhash, [], [h.pin.feePayer, w.address]);
    const wire = new Uint8Array(1 + 128 + message.length);
    wire[0] = 2;
    wire.set(message, 129);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: solanaPoolFee(rent), solana: h.pin };
    checkSolanaWithdraw(wire, ask, ctx, release, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.label });
    // W, from the seed, right before it signs: it must be the proof's recipient the bytes were built and checked for
    seed = await h.seed64();
    const signer = freshWallet(seed, "sol", wl, wj);
    key = signer.secretKey;
    seed.fill(0);
    seed = null;
    if (signer.address !== w.address) stop("wallet");
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1 + 64);
    let owedNow: PendingOnward | null = null;
    const host = {
      rpcs: h.rpcs,
      send: h.send,
      settle: h.settle,
      ...(h.now ? { now: h.now } : {}),
      ...(h.reads !== undefined ? { reads: h.reads } : {}),
      // the helper's word for the release's signature kept with the owed send, a name a finish after a reload reads
      // back first (spendOwner), never in the op's txs; awaited by the send before its read-back (fold 5, review
      // LOW): a failed write never stops the send
      named: async (s: string): Promise<void> => {
        if (owedNow === null || s === "") return;
        owedNow = { ...owedNow, release: s };
        owing(owedNow);
        await h.keepRelease?.(p.noteId, attempt!, s).catch(() => {});
      },
      // RESERVED, then the onward send owed, both written before anything leaves the device (review #232b HIGH 1):
      // a crash between the two leaves a RESERVED note with nothing sent, which the reserved pass frees
      take: async (_id: string, _attempt: string, _early?: unknown, lastHeight?: bigint) => {
        // a Move past its send-by (or ended) sends nothing: the note goes back UNSPENT in the finally below
        await h.claim?.();
        await notes.move(p.noteId, "HELD", "RESERVED", { attempt: attempt!, ...(lastHeight === undefined ? {} : { lastHeight }) });
        reserved = true;
        const owed: PendingOnward = { noteId: p.noteId, attempt: attempt!, context: binding.context.toString(), ...base };
        owedNow = owed;
        owing(owed);
        await h.owe?.(owed);
        return r;
      },
      // the release read landed on both RPCs: the note's mark holds what it took out, so the balance counts only the
      // change until the settle writes it, as a buy's (card pool-buy-record-never-stays-sent)
      landed: (noteId: string, at: string, withdrawn: bigint) => void notes.landed(noteId, at, withdrawn).then(() => h.marked?.(noteId)).catch(() => {}),
    };
    const a = await sendAndSettle(host, r, release, pool, signed, bh.lastHeight, wait);
    if ("error" in a) return stop("send");
    // the release's signature as the chain read it: the answer's own (this very transaction read back on both RPCs,
    // or the spend's own signature), never the helper's word
    const signature = a.txs[0]?.hash ?? "";
    return { stage: a.stage, signature, l: wl, j: wj, releaseAccounts: accounts.map((x) => x.key) };
  } catch (e) {
    if (e instanceof PoolRuleRefused) stop("rule");
    throw e;
  } finally {
    seed?.fill(0);
    key?.fill(0);
    // held by this run and never sent: freed, so the proof queue proves it again
    if (attempt !== null && !reserved) await notes.move(p.noteId, "HELD", "UNSPENT", { attempt }).catch(() => {});
  }
}
