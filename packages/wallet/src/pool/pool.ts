// The pool interface the proof queue calls (card wallet-pool-ladder; architecture v2, the lite paper §3 "Buy: proved
// before the tap"). A pool is any keyless contract that holds notes under one scope and releases a chunk against a
// Withdraw(32) proof: the NEAR vault today, the Solana and EVM pools when they land. Every pool runs the same circuit
// with the same 8 public signals (VAULT_WITHDRAW_SIGNALS); what differs between pools is only what is named here, so a
// new pool plugs in by implementing Pool and nothing in the queue changes.
//
// - scope: the pool's own, a field element below p, computed as the pool computes it. A note is keyed by it
//   (NoteRecord.scope), every label the pool writes hashes it, and so does every context, so a proof made for one pool
//   is refused by any other.
// - chain: which fresh wallet a chunk goes to. W = W_{chain, l, j} (derive/keys.ts walletPath), with (l, j) the spent
//   note's label and change index (keys.ts changeIndex), so each note has its own W and no W serves two notes.
// - ladder: the rungs in the pool's asset (./ladder.ts). A proof withdraws exactly one rung (withdrawnValue, public),
//   so every release from every user is one of a few standard sizes. The fee is paid from the chunk, never added to
//   it: a fee read at another time would otherwise make another size.
// - Epochs: the pool's time is cut into epochs of epochMs. Every proof made in epoch e proves against e's epoch root
//   (the newest root whose leaf landed before e's start: trees(e's start)), binds the deadline e's start + lifeMs and
//   the relayer's fee for e, so every proof of that epoch, from every user, shares its root, label root, deadline and
//   fee. The queue makes its ready proofs again at each new epoch. One exception: a deposit's own note (a deposit note,
//   or a second arrival of a deposit from U) is proved at once on the newest root, so the first buy never waits for a
//   boundary. That proof is made again at the next epoch and is handed out only until its replacement is made, and
//   never past the next boundary + NEWEST_GRACE_MS. Every other note (change, refund, return, move, and second
//   arrivals of a return or a move) waits for the next boundary: a root right after its own leaf would link the W it
//   pays to the earlier W whose money made that leaf.
// - now and trees: the pool's time and its two trees cut at a time, each read on two RPCs by the pool's own reader.
//   Never the device clock, and never one RPC's word. The tree source must know each leaf's chain time.
// - Two duties on every adapter, which the queue cannot check (the NEAR leaf-time sync and each pool adapter hold
//   them):
//   1. relayFee(epoch), the fee bind uses, is the relayer's one published fee for that epoch, shared by every user,
//      in coarse steps; a fee picked per user or per request would mark that user's proofs.
//   2. trees(start) is refused unless the pool's sync has read the chain past `start` (every leaf before `start` is
//      in), so an epoch root is the same for every user and never a partial tree.
// - bind: the context function. It binds one chunk's release to W, the fee cap and the queue's deadline, and never the
//   token: the token, route and minimum out are W's signature at the tap. It returns the context and the request
//   fields the pool recomputes that context from at the tap, so a context the pool would not recompute exactly is
//   refused there.
// Nothing here holds a secret: W's secret key never reaches a pool, only its address and public key.
import { VAULT_FIELD_P, type VaultSnarkjsProof, type VaultTree, type VaultWithdrawSignals } from "@blindfill/kit";
import { CHAINS, type Chain } from "../derive/index.ts";
import type { Ladder } from "./ladder.ts";

/** A pool's two trees, holding every leaf it has, and its newest roots, read on two RPCs. */
export type PoolTrees = { stateTree: VaultTree; labelTree: VaultTree; stateRoot: bigint; labelRoot: bigint };

/** What the queue hands the context function for one chunk. */
export type PoolBindArgs = {
  /** withdrawnValue: one rung of the pool's ladder, in the asset's base units. */
  chunk: bigint;
  /** W_{chain, l, j}: its address in the chain's own form (sol: base58; evm: EIP-55; near: 64-hex id) and public key. */
  wallet: { address: string; publicKey: Uint8Array };
  /** The precommitment of refund note (l, j), for a pool that writes a refund note when its payout fails. */
  refundPrecommitment: bigint;
  /** The epoch's start in the pool's time, ms: the fee is the relayer's for this epoch. */
  epochStartMs: bigint;
  /** The deadline to bind: epochStartMs + lifeMs, the same for every proof of the epoch. */
  deadlineMs: bigint;
  /** A pool that binds a tip cap (Solana): 0 for a withdraw, which pays no tip; the pool's own cap when absent (a buy). */
  tipCap?: bigint;
};

/** One chunk's binding: what the proof's last public signal must be, and what the tap sends for the pool to check it. */
export type PoolBinding<R = unknown> = {
  /** The context, a field element below p: Withdraw(32)'s 8th public signal. */
  context: bigint;
  /** The most the relayer may take from the chunk, in base units (exact on the NEAR vault). */
  feeCap: bigint;
  /** The pool's own request fields the context is computed from, sent with the proof at the tap. Never a secret. */
  request: R;
};

/** A keyless pool on any chain, as the proof queue sees it. */
export interface Pool<R = unknown> {
  /** A name for this pool on the device (chain, contract and token); never sent. */
  readonly id: string;
  /** The chain of W, the fresh wallet each chunk goes to. */
  readonly chain: Chain;
  /** The pool's scope, as the pool computes it. */
  readonly scope: bigint;
  /** The chunk sizes, in the pool's asset. */
  readonly ladder: Ladder;
  /** E: the length of an epoch of the pool's time, ms. */
  readonly epochMs: bigint;
  /** L: every proof of an epoch has the deadline epoch start + L. At least 2E + sendMarginMs; 2E + sendMarginMs +
   * 2 TAKE_SLACK_MS keeps every take of the next epoch inside take()'s slack (the NEAR vault's 270 s). */
  readonly lifeMs: bigint;
  /** What the relayer keeps before a deadline (its check 9): a proof is handed out only with more than this left. */
  readonly sendMarginMs: bigint;
  /** The pool's time in ms (its chain's newest final block, the lower of two RPCs). */
  now(signal?: AbortSignal): Promise<bigint>;
  /** The tree source: both trees holding only the leaves that landed before `beforeMs`, and their roots. `newest`: the
   * read for a deposit's own note (beforeMs = now + 1), which a pool may make at a lower commitment than its epoch
   * roots (Solana: confirmed, M355 (5)); its failure fails only the notes that wait on it. */
  trees(beforeMs: bigint, signal?: AbortSignal, opts?: { newest?: boolean }): Promise<PoolTrees>;
  /** The context function. */
  bind(a: PoolBindArgs, signal?: AbortSignal): Promise<PoolBinding<R>>;
}

/** A proof made ahead for one note, held until the tap sends it or the queue drops it. */
export type ReadyProof<R = unknown> = {
  /** The note it spends, HELD in the store by this attempt. */
  noteId: string;
  attempt: string;
  poolId: string;
  /** W_{chain, l, j}: the wallet that receives the chunk and signs the tap's one transaction. */
  wallet: { chain: Chain; l: bigint; j: number; path: string; address: string };
  chunk: bigint;
  /** The epoch it was made in (its start, ms), and whether its root is the epoch root or the newest (a fresh note's). */
  epochStartMs: bigint;
  deadlineMs: bigint;
  root: "epoch" | "newest";
  binding: PoolBinding<R>;
  proof: VaultSnarkjsProof;
  publicSignals: VaultWithdrawSignals;
};

/** take() hands a proof out only with more than sendMarginMs + this left before its deadline (clock skew between the
 * pool's time and the relayer's). */
export const TAKE_SLACK_MS = 15_000n;
/** A newest-root proof (a deposit's own note) is handed out past its epoch only until its replacement is made, and
 * never past the next boundary + this: it bounds how long the root right after the deposit stays in use. */
export const NEWEST_GRACE_MS = 15_000n;

const field = (x: unknown): boolean => typeof x === "bigint" && x >= 0n && x < VAULT_FIELD_P;

/** Refuses a pool whose fixed fields are not what the queue relies on. */
export function checkPool(p: Pool): void {
  if (p === null || typeof p !== "object") throw new Error("pool: not an object");
  if (typeof p.id !== "string" || p.id.length === 0) throw new Error("pool: no id");
  if (typeof p.chain !== "string" || !Object.hasOwn(CHAINS, p.chain)) throw new Error(`pool ${p.id}: unknown chain ${String(p.chain)}`);
  if (!field(p.scope)) throw new Error(`pool ${p.id}: scope is not a field element below p`);
  for (const f of ["epochMs", "lifeMs", "sendMarginMs"] as const) if (typeof p[f] !== "bigint" || p[f] <= 0n) throw new Error(`pool ${p.id}: ${f} is a bigint above 0`);
  // a proof of epoch e is handed out until e + 1 ends: by then deadline - now is lifeMs - 2 epochMs, above the margin
  if (p.lifeMs < 2n * p.epochMs + p.sendMarginMs) throw new Error(`pool ${p.id}: lifeMs is below 2 epochs plus the send margin`);
  // at that floor a proof made at its epoch's start keeps take()'s slack for 2 epochMs - TAKE_SLACK_MS: an epoch at or
  // below the slack would leave no time in which take() hands a proof out
  if (p.epochMs <= TAKE_SLACK_MS) throw new Error(`pool ${p.id}: epochMs is at most the take slack (${TAKE_SLACK_MS} ms)`);
  for (const f of ["now", "trees", "bind"] as const) if (typeof p[f] !== "function") throw new Error(`pool ${p.id}: ${f} is not a function`);
}

/** Refuses a binding the queue cannot hold a note under: a context not below p, a fee cap at or above the chunk. */
export function checkBinding(p: Pool, b: PoolBinding, chunk: bigint): void {
  if (b === null || typeof b !== "object") throw new Error(`pool ${p.id}: bind gave no binding`);
  if (!field(b.context)) throw new Error(`pool ${p.id}: the context is not a field element below p`);
  if (typeof b.feeCap !== "bigint" || b.feeCap < 0n || b.feeCap >= chunk) throw new Error(`pool ${p.id}: the fee cap is below 0 or not below the chunk`);
}
