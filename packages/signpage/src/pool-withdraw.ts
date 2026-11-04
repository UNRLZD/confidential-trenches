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
//   floor (fee + W's fee + min part: a smaller change could never leave the pool, review #232 HIGH 2). Each chunk is
//   part + fee + W's fee, so exactly the part arrives at To. The fee is the device's own, from the Rent sysvar read on
//   two RPCs (the kit's solanaPoolFee); W's fee is getFeeForMessage on both. Max fee is parts x (fee + W's fee), and a
//   run whose plan costs more than the Max fee the screen drew stops before its first part (review #232 MEDIUM 1).
// - Each part proves on demand (6.7 s in run 6d): the queue's own W_{sol, label, j} and change note (queue.ts prove),
//   so a restore from the 12 words finds both. A note the page's proof queue holds for the next buy is dropped first
//   (HELD -> UNSPENT), then held by this run with its context (UNSPENT -> HELD), before its proof starts. The bind's
//   tip cap is 0 (a tag 2 pays no tip).
// - The roots: the epoch root when the note is in it, else the newest (a note that landed this epoch); their leaf
//   indexes read on both RPCs (pool-buy.ts rootIndex).
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
//   transaction's signature, release and onward.
// - Every read names a public account or the transaction itself; no request carries a key, the words or which note is
//   whose (W's fee is read on a fixed message from the pool). Nothing here logs.
import { base58, base64 } from "@scure/base";
import { poolProveWithdraw, type VaultProver } from "../../kit/src/prover/prove.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_SYSTEM_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import { readSolanaRent, solanaEncodePoolRelease, solanaPoolAccount, solanaPoolFee, solanaPoolReleaseAccounts, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { TxRef, WithdrawStage } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteSecrets } from "../../wallet/src/notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../../wallet/src/notes/store.ts";
import { checkBinding, type Pool, type ReadyProof } from "../../wallet/src/pool/pool.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { blockhashOf, pastOnBoth, readBack, releaseOf, rootIndex, sendAndSettle, treeSizes, type PoolBuyHost } from "./pool-buy.ts";
import { checkSolanaOnwardSend, checkSolanaWithdraw, PoolRuleRefused, signSolana, SOLANA_RESERVED_KEYS, type PoolAsk } from "./rules/pool.ts";

/** The release's compute limit: the pool program's own tests send a release at 400,000 (svm-tests/tests/release.rs). */
export const POOL_WITHDRAW_CU = 400_000;

/** A part's smallest arrival: rent(0), so To (when new) and W after its release (part + W's fee on it) are both
 *  rent-exempt; and at least the relay fee less W's fee, so the chunk (part + fee + W's fee) meets the program's
 *  backstop of 2 x fee. A withdraw binds tipCap 0 (its tag 2 pays no tip), so no tip cap counts here. */
export const solanaWithdrawMinPart = (rent: SolanaRent, fee: bigint, wFee: bigint): bigint => {
  const r = solanaRentMin(rent, 0);
  return fee - wFee > r ? fee - wFee : r;
};

/** A note the plan may draw on: landed, of the pool's scope, UNSPENT or HELD by this page's proof queue. */
export type WithdrawSource = { id: string; value: bigint };
/** One part: the note it spends, what arrives at To from it, and what the release withdraws (part + fee + W's fee). */
export type WithdrawPart = { noteId: string; part: bigint; chunk: bigint };
/** What every part costs: the epoch's relay fee, W's own fee for its send onward, and the smallest part. */
export type WithdrawCosts = { fee: bigint; wFee: bigint; minPart: bigint };

/** The most `n` can send to To: its value less the relay fee and W's fee. */
const capOf = (n: WithdrawSource, c: WithdrawCosts): bigint => n.value - c.fee - c.wFee;
/** The smallest note one part can withdraw: a change under it (and above 0) could never leave the pool, so no part
 *  leaves one (review #232 HIGH 2). */
export const withdrawNoteFloor = (c: WithdrawCosts): bigint => c.fee + c.wFee + c.minPart;
/** The plan reads at most this many notes, largest first: a withdraw's search stays bounded (3 choices a note). */
export const WITHDRAW_PLAN_NOTES = 16;

/** The notes a plan may draw on, largest first, each with its two kinds of part: all of it (`cap`), or a part in
 *  [minPart, flexHi] that leaves a change of at least the note floor (`flexHi` under minPart: none). */
function choicesOf(notes: readonly WithdrawSource[], c: WithdrawCosts): { id: string; cap: bigint; flexHi: bigint }[] {
  const floor = withdrawNoteFloor(c);
  return [...notes]
    .sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1))
    .map((n) => ({ id: n.id, cap: capOf(n, c), flexHi: capOf(n, c) - floor }))
    .filter((n) => n.cap >= c.minPart)
    .slice(0, WITHDRAW_PLAN_NOTES);
}

/** What the notes can send to To: each note's largest part, for every note that gives at least the minimum. */
export function poolWithdrawable(notes: readonly WithdrawSource[], c: WithdrawCosts): bigint {
  return choicesOf(notes, c).reduce((t, n) => t + n.cap, 0n);
}

/** Every amount a plan can send, as closed intervals, sorted and merged: the sums of each note's none, all or flex. */
export function plannableAmounts(notes: readonly WithdrawSource[], c: WithdrawCosts): [bigint, bigint][] {
  let r: [bigint, bigint][] = [[0n, 0n]];
  for (const n of choicesOf(notes, c)) {
    const next = [...r, ...r.map(([lo, hi]) => [lo + n.cap, hi + n.cap] as [bigint, bigint])];
    if (n.flexHi >= c.minPart) for (const [lo, hi] of r) next.push([lo + c.minPart, hi + n.flexHi]);
    next.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    r = [];
    for (const iv of next) {
      const last = r[r.length - 1];
      if (last && iv[0] <= last[1] + 1n) {
        if (iv[1] > last[1]) last[1] = iv[1];
      } else r.push([iv[0], iv[1]]);
    }
  }
  return r.filter(([, hi]) => hi > 0n).map(([lo, hi]) => [lo > 0n ? lo : 1n, hi]);
}

/** The plannable amounts nearest `amount` from below and above; none on a side with no plannable amount. */
export function nearestPlannable(notes: readonly WithdrawSource[], amount: bigint, c: WithdrawCosts): { below?: bigint; above?: bigint } {
  const out: { below?: bigint; above?: bigint } = {};
  for (const [lo, hi] of plannableAmounts(notes, c)) {
    if (lo <= amount && amount <= hi) return { below: amount, above: amount };
    if (hi < amount) out.below = hi;
    if (lo > amount && out.above === undefined) out.above = lo;
  }
  return out;
}

/** The parts that send exactly `amount` to To with the fewest parts (each part a fee), no part leaving a change
 *  between 0 and the note floor; null when no plan exists. */
export function planPoolWithdraw(notes: readonly WithdrawSource[], amount: bigint, c: WithdrawCosts): WithdrawPart[] | null {
  if (amount < c.minPart || c.fee < 0n || c.wFee < 0n) return null;
  if (!plannableAmounts(notes, c).some(([lo, hi]) => lo <= amount && amount <= hi)) return null;
  const ns = choicesOf(notes, c);
  const rest = ns.map((_, i) => ns.slice(i).reduce((t, n) => t + n.cap, 0n));
  type Pick = { i: number; flex: boolean };
  // depth-first over notes, largest first, with at most k parts: `need` is what the flex parts must still give
  const search = (i: number, need: bigint, flexLo: bigint, flexHi: bigint, k: number, picks: Pick[]): Pick[] | null => {
    if (need >= flexLo && need <= flexHi && picks.length > 0) return picks;
    if (i >= ns.length || picks.length >= k || need < flexLo || need > flexHi + rest[i]!) return null;
    const n = ns[i]!;
    if (n.cap <= need) {
      const got = search(i + 1, need - n.cap, flexLo, flexHi, k, [...picks, { i, flex: false }]);
      if (got) return got;
    }
    if (n.flexHi >= c.minPart) {
      const got = search(i + 1, need, flexLo + c.minPart, flexHi + n.flexHi, k, [...picks, { i, flex: true }]);
      if (got) return got;
    }
    return search(i + 1, need, flexLo, flexHi, k, picks);
  };
  for (let k = 1; k <= ns.length; k++) {
    const picks = search(0, amount, 0n, 0n, k, []);
    if (!picks) continue;
    // the flex parts: each its minimum, then the rest given largest note first up to each one's flex top
    let left = amount - picks.filter((p) => !p.flex).reduce((t, p) => t + ns[p.i]!.cap, 0n) - BigInt(picks.filter((p) => p.flex).length) * c.minPart;
    const parts = picks.map((p) => {
      const n = ns[p.i]!;
      let part = n.cap;
      if (p.flex) {
        const more = left < n.flexHi - c.minPart ? left : n.flexHi - c.minPart;
        part = c.minPart + more;
        left -= more;
      }
      return { noteId: n.id, part, chunk: part + c.fee + c.wFee };
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
  /** The wallet's solanaSettleSpent for this note. */
  settle(noteId: string): Promise<{ kind: "spent" | "unspent" }>;
  /** The onward send a part owes, written once its note is RESERVED and before its release leaves (awaited): a crash
   *  from there on leaves the op owing it, for the state reads' finishPoolOnward. */
  owe?(pending: PendingOnward): Promise<void>;
  /** The op's stage, its txs so far, the onward send still owed and what reached To, by onward signature. */
  stage?(stage: WithdrawStage, txs: TxRef[], pending: PendingOnward | null, arrived: Arrivals): void;
};

/** A part's onward send still owed: its note (W is the note's own W_{sol, label, j}, derived on the device; the op
 *  record names no label, so it links no withdraw to its deposit), To, and whether it is the run's last part. */
export type PendingOnward = { noteId: string; to: string; last: boolean };
/** What reached To, by onward signature (lamports as a decimal): what each send moved, read from its own bytes. */
export type Arrivals = Record<string, string>;
export type PoolWithdrawAnswer = { stage: WithdrawStage; txs: TxRef[]; pending: PendingOnward | null; arrived: Arrivals };

class Stop extends Error {}
const stop = (why: string): never => {
  throw new Stop(why);
};
const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));
const lamports = (x: unknown): bigint => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : stop("read"));
const agree = <T>(a: T, b: T): T => (a === b ? a : stop("reads"));
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

/** The landed notes of the pool's scope a withdraw may spend: UNSPENT, or HELD by this page's proof queue (`mine`). */
export function withdrawSources(list: readonly NoteRecord[], scope: bigint, mine: ReadonlySet<string>): WithdrawSource[] {
  return list.filter((n) => n.scope === scope && n.leaf !== undefined && (n.state === "UNSPENT" || (n.state === "HELD" && mine.has(n.id)))).map((n) => ({ id: n.id, value: n.leaf!.value }));
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

/** To on the pool's own terms: never the pool, its program, the fee payer, a key the runtime keeps read-only (a
 *  sysvar or a native program: nothing can be paid there), nor any W of the plan. */
const toRefused = (to: string, pin: SolanaPoolPin, pool: string, ws: readonly string[]): boolean =>
  [pool, pin.program, pin.feePayer, ...SOLANA_RESERVED_KEYS, ...ws].includes(to);

/** One withdraw of `amount` (base units arriving at `to`), `to` the address typed on this page and checked there, and
 *  `maxFee` the Max fee the screen drew: a plan that would cost more stops before its first part. */
export async function runPoolWithdraw(h: PoolWithdrawHost, ask: PoolAsk, to: string, amount: bigint, maxFee: bigint, mine: ReadonlySet<string> = new Set()): Promise<PoolWithdrawAnswer> {
  const txs: TxRef[] = [];
  const arrived: Arrivals = {};
  let pending: PendingOnward | null = null;
  const say = (s: WithdrawStage): void => h.stage?.(s, txs.slice(), pending, { ...arrived });
  const end = (s: WithdrawStage): PoolWithdrawAnswer => (say(s), { stage: s, txs: txs.slice(), pending, arrived: { ...arrived } });
  try {
    if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") stop("kind");
    if (typeof maxFee !== "bigint" || maxFee < 0n) stop("max_fee");
    const { scope } = solanaPoolOf(h.pin.program);
    const pool = solanaPoolAccount(h.pin.program);
    const rent = await readSolanaRent(h.rpcs);
    const fee = solanaPoolFee(rent);
    const wFee = await solanaOnwardFee(h.rpcs, h.pin);
    const costs: WithdrawCosts = { fee, wFee, minPart: solanaWithdrawMinPart(rent, fee, wFee) };
    const notes = await h.notes();
    const plan = planPoolWithdraw(withdrawSources(await notes.list(), scope, mine), amount, costs);
    if (plan === null) stop("plan");
    // review #232 MEDIUM 1: never more than the Max fee the screen showed
    if (BigInt(plan!.length) * (fee + wFee) > maxFee) stop("max_fee");
    // To checked before any note moves, so no release is made for a send that could never land: never the pool's own
    // keys, a read-only key or one of the plan's own Ws, and on both RPCs never executable nor the pool program's
    const ws = await seedUse(h)(async (seed) => {
      const out: string[] = [];
      for (const p of plan!) {
        const n = await notes.get(p.noteId);
        if (n?.leaf === undefined) stop("note");
        out.push(wOf(seed, n!));
      }
      return out;
    });
    if (toRefused(to, h.pin, pool, ws)) stop("to");
    await checkTo(h, to);
    for (const [i, p] of plan!.entries()) {
      say("proving");
      const owed: PendingOnward = { noteId: p.noteId, to, last: i === plan!.length - 1 };
      // the release's take writes the note RESERVED, then this pending: from then on a crash leaves it owed
      const got = await onePart(h, ask, notes, p, fee, wFee, pool, owed, () => void (pending = owed));
      if (got.signature !== "") txs.push({ chain: "solana", hash: got.signature });
      if (got.stage === "refused" || got.stage === "not_landed") {
        // the release can never land (failed on both RPCs, or its blockhash past on both with no spend): nothing on W
        pending = null;
        return end("stopped");
      }
      // review #232b HIGH 1: any other answer short of filled (the release read back but its spend not yet read at
      // finalized, or the helper's error while it may still land) keeps the part owed, for finishPoolOnward
      if (got.stage !== "filled") return end(pending ? "in_transit" : "stopped");
      // the release landed: the part is on W
      say("in_transit");
      const on = await sendOnward(h, ask, got.l, got.j, to, got.releaseAccounts);
      if (on.signature !== "") txs.push({ chain: "solana", hash: on.signature });
      if (on.state === "ok") arrived[on.signature] = on.amount.toString();
      // empty: another tab's finish sent it already (its signature in its own write of the op); never the run's end
      else if (on.state !== "empty") return end("in_transit");
      pending = null;
      if (i < plan!.length - 1) say("submitted");
    }
    return end("sent");
  } catch {
    return end(pending ? "in_transit" : "stopped");
  }
}

/** The state reads' pass for an op left in_transit (the part owed on W): settles every case, never waits forever.
 *  - W holds lamports: its send onward, all it holds less its fee, to To.
 *  - W at 0 and the note spent: the release landed and its send went (this tab's or another's): sent, or stopped
 *    when parts were left after it.
 *  - W at 0 and the note back UNSPENT (the state reads' solanaSettleReserved frees a RESERVED note once both RPCs'
 *    block time is past its deadline with no spend: the release never landed), HELD again or gone: stopped.
 *  - W at 0 and the note still RESERVED with no spend read: null, read again by the next pass.
 *  null also when a read or the send fails: the money is on W, so the pass goes on trying. */
export async function finishPoolOnward(
  h: Pick<PoolWithdrawHost, "rpcs" | "pin" | "seed64" | "withSeed" | "now" | "wait" | "notes" | "settle">,
  pending: PendingOnward,
): Promise<{ stage: WithdrawStage; txs: TxRef[]; arrived: Arrivals } | null> {
  const done = (stage: WithdrawStage, txs: TxRef[] = [], arrived: Arrivals = {}) => ({ stage, txs, arrived });
  try {
    const ask: PoolAsk = { kind: "pool.withdraw", chain: "solana", token: null, amount: 0n, slippageBps: 0, decimals: 9 };
    const notes = await h.notes();
    const n = await notes.get(pending.noteId);
    if (n?.leaf === undefined) return done("stopped");
    const l = n.leaf.label;
    const j = jOf(n.ref);
    const W = await seedUse(h)((seed) => wOf(seed, n));
    if (toRefused(pending.to, h.pin, solanaPoolAccount(h.pin.program), [W])) return done("stopped");
    await checkTo(h, pending.to);
    const on = await sendOnward(h, ask, l, j, pending.to, []);
    if (on.state === "ok") return done(pending.last ? "sent" : "stopped", [{ chain: "solana", hash: on.signature }], { [on.signature]: on.amount.toString() });
    if (on.state !== "empty") return null;
    const now = await notes.get(pending.noteId);
    if (now?.state === "SPENT" || (now?.state === "RESERVED" && (await h.settle(pending.noteId)).kind === "spent")) return done(pending.last ? "sent" : "stopped");
    if (now === undefined || now.state === "UNSPENT" || now.state === "HELD") return done("stopped");
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
async function sendOnward(h: Pick<PoolWithdrawHost, "rpcs" | "pin" | "seed64" | "withSeed" | "now" | "wait">, ask: PoolAsk, l: bigint, j: number, to: string, releaseAccounts: readonly string[]): Promise<{ state: "ok" | "failed" | "empty" | "unknown"; signature: string; amount: bigint }> {
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
      const bal = await Promise.all(h.rpcs.map(async (rpc) => lamports(((await rpc("getBalance", [address, { commitment: "confirmed" }])) as { value?: unknown } | null)?.value)));
      const balance = agree(bal[0]!, bal[1]!);
      if (balance === 0n) return { state: "empty", signature, amount: 0n };
      const bh = await blockhashOf(h.rpcs);
      // the fee is per signature: the same for the draft and the send, whose amount alone differs
      const fee = await feeOf(h.rpcs, onwardMessage(address, to, balance, bh.blockhash));
      if (balance <= fee) return { state: "failed", signature, amount: 0n };
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

/** One part's release to W: hold the note, prove part + fees to W, build, check, sign, RESERVED, then the send and
 *  its settle. The release is alone in its transaction (review #232 HIGH 1). */
async function onePart(h: PoolWithdrawHost, ask: PoolAsk, notes: NoteStore, p: WithdrawPart, fee: bigint, wFee: bigint, pool: string, owed: PendingOnward, owing: () => void): Promise<{ stage: string; signature: string; l: bigint; j: number; releaseAccounts: string[] }> {
  const P = h.pool;
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let attempt: string | null = null;
  let reserved = false;
  try {
    let n = await notes.get(p.noteId);
    if (n?.state === "HELD" && h.drop) {
      await h.drop(p.noteId);
      n = await notes.get(p.noteId);
    }
    if (n === undefined || n.state !== "UNSPENT" || n.leaf === undefined) stop("note");
    const leaf = n!.leaf!;
    if (leaf.value < p.chunk) stop("value");
    const nowMs = await P.now();
    const epochStartMs = nowMs - (nowMs % P.epochMs);
    const deadlineMs = epochStartMs + P.lifeMs;
    const j = jOf(n!.ref);
    seed = await h.seed64();
    const w = freshWallet(seed, "sol", leaf.label, j);
    w.secretKey.fill(0);
    const refundPrecommitment = noteSecrets(seed, { kind: "refund", l: leaf.label, j }).precommitment;
    // tipCap 0: the tag 2 pays no tip, so W's floor is rent(0) and the backstop alone
    const binding = await P.bind({ chunk: p.chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs, tipCap: 0n });
    checkBinding(P as Pool, binding, p.chunk);
    // the device's fee, never the helper's word: the binding's fee is the one the plan priced, its tip cap 0
    if (binding.request.relayFee !== fee || binding.feeCap !== fee || binding.request.tipCap !== 0n || p.chunk !== p.part + fee + wFee) stop("fee");
    attempt = (await notes.move(p.noteId, "UNSPENT", "HELD", { deadlineMs, context: binding.context.toString() })).attempt!;
    // the epoch root when the note is in it, else the newest (it landed this epoch)
    let trees = await P.trees(epochStartMs);
    if (leaf.leafIndex >= BigInt(trees.stateTree.size)) trees = await P.trees(nowMs + 1n, undefined, { newest: true });
    const spent = noteSecrets(seed, n!.ref);
    const next = noteSecrets(seed, { kind: "change", l: leaf.label, j });
    seed.fill(0);
    seed = null;
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
      noteId: p.noteId, attempt, poolId: P.id, wallet: { chain: "sol", l: leaf.label, j, path: w.path, address: w.address }, chunk: p.chunk,
      epochStartMs, deadlineMs, root: "epoch", binding, proof: made.proof, publicSignals: made.publicSignals,
    };
    const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const sizes = await treeSizes(h, pool, wait);
    const idx = { state: await rootIndex(h, 0, sizes.state, BigInt(r.publicSignals[3])), label: await rootIndex(h, 1, sizes.label, BigInt(r.publicSignals[5])) };
    const release = releaseOf(r, h.pin, w.address, idx);
    const rent = await readSolanaRent(h.rpcs);
    const bh = await blockhashOf(h.rpcs);
    const cfg = { program: h.pin.program, pool };
    const accounts = solanaPoolReleaseAccounts(cfg, w.address, h.pin.feePayer, release, sizes.stateSize);
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
    const signer = freshWallet(seed, "sol", leaf.label, j);
    key = signer.secretKey;
    seed.fill(0);
    seed = null;
    if (signer.address !== w.address) stop("wallet");
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1 + 64);
    let signature = "";
    const host = {
      rpcs: h.rpcs,
      send: h.send,
      settle: h.settle,
      ...(h.now ? { now: h.now } : {}),
      ...(h.reads !== undefined ? { reads: h.reads } : {}),
      sent: (s: string) => void (signature = s),
      // RESERVED, then the onward send owed, both written before anything leaves the device (review #232b HIGH 1):
      // a crash between the two leaves a RESERVED note with nothing sent, which the reserved pass frees
      take: async () => {
        await notes.move(p.noteId, "HELD", "RESERVED", { attempt: attempt! });
        reserved = true;
        owing();
        await h.owe?.(owed);
        return r;
      },
    };
    const a = await sendAndSettle(host, r, release, pool, signed, bh.lastHeight, wait);
    if ("error" in a) stop("send");
    return { stage: (a as { stage: string }).stage, signature, l: leaf.label, j, releaseAccounts: accounts.map((x) => x.key) };
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
