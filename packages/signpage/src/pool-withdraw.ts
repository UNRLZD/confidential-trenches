// pool.withdraw on the Solana pool (card signpage-pool-withdraw-form): the user types where the money goes (To) and how
// much arrives there (Amount) on SIGN_HOST's own page (src/withdraw/pool-form.ts), and each part of it leaves the
// pinned pool in one transaction: the release of one note's part to its fresh wallet W (tag 2), then one System
// transfer from W to To of all the release paid W. Both pools want the recipient to sign the release (contracts/
// pool-solana src/release.rs:188 recipient.is_signer), so W is the recipient and To gets the money in the same
// transaction; the helper's send takes exactly that shape (apps/helper/src/pool/solana.ts, tag 2 and one transfer).
//
// - The plan (planPoolWithdraw): the pool's landed notes largest first, each giving at most its value less the epoch's
//   relay fee, every part at least SOL_TIP_CAP + rent(0) (the wallet's solanaPool bind refuses a chunk under fee + tip
//   cap + rent(0)); a remainder under that minimum moves to the part before. The fee is the device's own, from the
//   Rent sysvar read on two RPCs (the kit's solanaPoolFee): Max fee is parts x fee.
// - Each part proves on demand (6.7 s in run 6d): the queue's own W_{sol, label, j} and change note (queue.ts prove),
//   so a restore from the 12 words finds both, withdrawing exactly part + fee, so To gets exactly the part. A note the
//   page's proof queue holds for the next buy is dropped first (HELD -> UNSPENT), then held by this run with its
//   context (UNSPENT -> HELD), before its proof starts.
// - The roots: the epoch root when the note is in it, else the newest (a note that landed this epoch); their leaf
//   indexes read on both RPCs (pool-buy.ts rootIndex).
// - Built here, checked by the rule (rules/pool.ts checkSolanaWithdraw: the device's own release byte for byte, then
//   exactly one transfer from W to To of withdrawnValue - relayFee), signed by W only through signSolana. W's key and
//   the seed are zeroed at once.
// - RESERVED is written before the transaction leaves (notes/store.ts); the send, its busy resends, the read-back on
//   both RPCs and the settle are pool-buy.ts sendAndSettle's, the one path for a pool send. A note left RESERVED is
//   settled by the page's state reads (solanaSettleReserved), as a buy's is.
// - The op (the kit's kind "withdraw", WithdrawStage): proving while a part proves, submitted once a part is sent,
//   sent once every part read back on both RPCs and settled, stopped when a part was refused or did not land (the
//   parts sent before it stay sent: each is its own transaction). txs lists every part's signature.
// - Every read names a public account or the transaction itself; no request carries a key, the words or which note is
//   whose. Nothing here logs.
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
import { SOL_TIP_CAP, solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { blockhashOf, releaseOf, rootIndex, sendAndSettle, treeSizes, type PoolBuyHost } from "./pool-buy.ts";
import { checkSolanaWithdraw, PoolRuleRefused, signSolana, type PoolAsk } from "./rules/pool.ts";

/** The release's compute limit: the pool program's own tests send a release at 400,000 (svm-tests/tests/release.rs). */
export const POOL_WITHDRAW_CU = 400_000;

/** A part's smallest arrival: the bind's floor on a chunk (fee + tip cap + rent(0)) less the fee. */
export const solanaWithdrawMinPart = (rent: SolanaRent): bigint => SOL_TIP_CAP + solanaRentMin(rent, 0);

/** A note the plan may draw on: landed, of the pool's scope, UNSPENT or HELD by this page's proof queue. */
export type WithdrawSource = { id: string; value: bigint };
/** One part: the note it spends, what arrives at To from it, and what the release withdraws (part + fee). */
export type WithdrawPart = { noteId: string; part: bigint; chunk: bigint };

/** What the notes can send to To: each note's value less the fee, for every note that gives at least the minimum. */
export function poolWithdrawable(notes: readonly WithdrawSource[], fee: bigint, minPart: bigint): bigint {
  return notes.reduce((t, n) => (n.value - fee >= minPart ? t + n.value - fee : t), 0n);
}

/** The parts that send exactly `amount` to To, largest note first; null when the notes cannot. */
export function planPoolWithdraw(notes: readonly WithdrawSource[], amount: bigint, fee: bigint, minPart: bigint): WithdrawPart[] | null {
  if (amount < minPart || fee < 0n) return null;
  const order = [...notes].sort((x, y) => (x.value !== y.value ? (x.value > y.value ? -1 : 1) : x.id < y.id ? -1 : 1));
  const parts: WithdrawPart[] = [];
  let left = amount;
  for (const n of order) {
    if (left === 0n) break;
    const cap = n.value - fee;
    if (cap < minPart) continue;
    let part = cap < left ? cap : left;
    // never leave a remainder no note could send on its own: leave the minimum for the next note instead
    if (left - part > 0n && left - part < minPart) part = left - minPart;
    if (part < minPart) continue;
    parts.push({ noteId: n.id, part, chunk: part + fee });
    left -= part;
  }
  return left === 0n ? parts : null;
}

/** What a withdraw run needs from the page. */
export type PoolWithdrawHost = Pick<PoolBuyHost, "send" | "now" | "reads" | "wait"> & {
  pin: SolanaPoolPin;
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The wallet's solanaPool for the pin: now, trees, bind (the helper's fee checked against the device's). */
  pool: Pool<SolanaReleaseRequest>;
  prover: VaultProver;
  notes(): Promise<NoteStore>;
  /** The page's proof queue's drop of a note it holds (HELD -> UNSPENT); none when no queue is open. */
  drop?(noteId: string): Promise<void>;
  seed64(): Promise<Uint8Array>;
  /** The wallet's solanaSettleSpent for this note. */
  settle(noteId: string): Promise<{ kind: "spent" | "unspent" }>;
  /** The op's stage and its txs so far, as they change. */
  stage?(stage: WithdrawStage, txs: TxRef[]): void;
};

export type PoolWithdrawAnswer = { stage: WithdrawStage; txs: TxRef[] };

class Stop extends Error {}
const stop = (why: string): never => {
  throw new Stop(why);
};
const u32le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));

/** The landed notes of the pool's scope a withdraw may spend: UNSPENT, or HELD by this page's proof queue (`mine`). */
export function withdrawSources(list: readonly NoteRecord[], scope: bigint, mine: ReadonlySet<string>): WithdrawSource[] {
  return list.filter((n) => n.scope === scope && n.leaf !== undefined && (n.state === "UNSPENT" || (n.state === "HELD" && mine.has(n.id)))).map((n) => ({ id: n.id, value: n.leaf!.value }));
}

/** One withdraw of `amount` (base units arriving at `to`), `to` the address typed on this page and checked there. */
export async function runPoolWithdraw(h: PoolWithdrawHost, ask: PoolAsk, to: string, amount: bigint, mine: ReadonlySet<string> = new Set()): Promise<PoolWithdrawAnswer> {
  const txs: TxRef[] = [];
  const say = (s: WithdrawStage): void => h.stage?.(s, txs.slice());
  try {
    if (ask.kind !== "pool.withdraw" || ask.chain !== "solana") stop("kind");
    const { scope } = solanaPoolOf(h.pin.program);
    const pool = solanaPoolAccount(h.pin.program);
    const rent = await readSolanaRent(h.rpcs);
    const fee = solanaPoolFee(rent);
    const notes = await h.notes();
    const plan = planPoolWithdraw(withdrawSources(await notes.list(), scope, mine), amount, fee, solanaWithdrawMinPart(rent));
    if (plan === null) stop("plan");
    for (const p of plan!) {
      say("proving");
      const got = await onePart(h, ask, notes, p, to, fee, pool);
      if (got.signature !== "") txs.push({ chain: "solana", hash: got.signature });
      if (got.stage !== "filled") {
        say(got.stage === "sent" ? "submitted" : "stopped");
        return { stage: got.stage === "sent" ? "submitted" : "stopped", txs };
      }
      say("submitted");
    }
    say("sent");
    return { stage: "sent", txs };
  } catch {
    say("stopped");
    return { stage: "stopped", txs };
  }
}

/** One part: hold the note, prove part + fee to W, build, check, sign, RESERVED, then the send and its settle. */
async function onePart(h: PoolWithdrawHost, ask: PoolAsk, notes: NoteStore, p: WithdrawPart, to: string, fee: bigint, pool: string): Promise<{ stage: string; signature: string }> {
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
    const binding = await P.bind({ chunk: p.chunk, wallet: { address: w.address, publicKey: w.publicKey }, refundPrecommitment, epochStartMs, deadlineMs });
    checkBinding(P as Pool, binding, p.chunk);
    // the device's fee, never the helper's word: the binding's fee is the one the plan priced
    if (binding.request.relayFee !== fee || binding.feeCap !== fee) stop("fee");
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
    const ixs = [
      { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, ...u32le(POOL_WITHDRAW_CU)) },
      { program: h.pin.program, accounts: solanaPoolReleaseAccounts(cfg, w.address, h.pin.feePayer, release, sizes.stateSize), data: solanaEncodePoolRelease(release) },
      {
        program: SOLANA_SYSTEM_PROGRAM,
        accounts: [{ key: w.address, signer: true, writable: true }, { key: to, signer: false, writable: true }],
        data: Uint8Array.of(2, 0, 0, 0, ...u64le(p.part)),
      },
    ];
    const { message } = solanaCompileV0(h.pin.feePayer, ixs, bh.blockhash, [], [h.pin.feePayer, w.address]);
    const wire = new Uint8Array(1 + 128 + message.length);
    wire[0] = 2;
    wire.set(message, 129);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: solanaPoolFee(rent), solana: h.pin };
    checkSolanaWithdraw(wire, ask, ctx, release, to, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.label });
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
      // RESERVED, written before anything leaves the device
      take: async () => {
        await notes.move(p.noteId, "HELD", "RESERVED", { attempt: attempt! });
        reserved = true;
        return r;
      },
    };
    const a = await sendAndSettle(host, r, release, pool, signed, bh.lastHeight, wait);
    if ("error" in a) stop("send");
    return { stage: (a as { stage: string }).stage, signature };
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
