// pool.buy on the Solana pool (card signpage-pool-buy): one tap releases a ready proof's chunk from the pinned pool to
// its fresh wallet W and buys the user's token in the same transaction (tag 3), and the note counts as spent only once
// that transaction reads back on two RPCs.
//
// - The proof: one the wallet's proof queue made ahead (../../wallet/src/pool/queue.ts), the smallest ready one whose
//   chunk pays the spend and W's new accounts (the kit's solanaPoolBuyFunds). Its release is read off the proof itself:
//   the 256 bytes of A, B (imaginary part first) and C, the hashes, the chunk and the depths from its public signals,
//   the fee, caps, deadline and salt from its binding, whose context must be the program's context of those fields
//   (solanaContextOf) and the proof's eighth signal, for this pin and this W.
// - The roots: the program reads each root by its leaf index (contracts/pool-solana src/state.rs root_at). The device
//   finds the index of the proof's state root and label root in the pool's own pages, read on both RPCs, newest page
//   first: both RPCs must give the same index, and a root on neither, or on one only, is a proof for another root,
//   refused before anything is signed.
// - The venue and the quote, on two RPCs: the reference (the kit's readSolanaReference, for exactly the spend) names the
//   venue that gives the most; readSolanaPoolBuyVenue reads it; min out is that venue's expected out less the ask's
//   slippage. The blockhash is read on one RPC (its slot is the device's own slot for the quote's age) and must be valid
//   on the other. The lookup tables are the pin's, a list of generations per venue (card sol-pool-venue-tables), each
//   read on both; a venue with no pinned table is refused venue_not_pinned once the reference names it, before the
//   venue's own read and the pick, and the build (the kit's
//   buildSolanaPoolBuyOnTables) loads the venue's generation that makes the smallest transaction; none that fits 1,232
//   bytes is refused no_table_fits before the claim and the seed. A pinned table that holds no account of the venue's
//   program is no generation of it (the kit passes over it); when none is made for the venue it has no table here,
//   refused venue_not_pinned, before the claim. One order: venue_not_pinned, the build (no_table_fits), the claim.
// - Built by the kit (buildSolanaPoolBuyOnTables), checked by the rule (rules/pool.ts checkSolanaBuy: the request is the ask's,
//   then every byte), signed by W only through signSolana (it signs nothing a check did not pass). W is derived here
//   from the seed (freshWallet, l and j of the note) right before it signs, and must be the proof's recipient; its key
//   and the seed are zeroed when the run ends.
// - The order, so the quote is fresh when W signs (the check refuses a reference over 25 slots behind the device's own
//   slot), in three rounds by each read's inputs (card pool-buy-filled-2s): the rent, the pinned tables, the trees' sizes
//   and the reference; then the root indexes of every ready proof, the venue and the blockhash (its slot), started
//   last; then the blockhash on RPC 1; then the pick, from the ready proofs read again, filtered, built and claimed in
//   one turn (the build is synchronous); then check and sign. A proof remade meanwhile onto a root not yet found runs
//   the reads once more. Counted by the age check: the reference's slot against the device's. Not counted: the time
//   from the slot read to the signature. The venue's read starts a microtask after the slot's, and a root page past the
//   first after the page before it, so when the second round ends over POOL_BUY_SLOT_STALE_MS (a second, the device's
//   clock) after the slot was answered, the blockhash and slot are read again and the check runs on that read: what
//   goes uncounted is at most that second, the third round (RPC 1's blockhash reads) and the build, check and sign.
// - After the send (card pool-buy-filled-2s): the read-back reads at a slot's pace (POOL_BUY_POLL_MS); any read that
//   fails, a throttle or a 5xx alike, waits on the wallet's one rule (throttleWaitMs: twice as long each time, its
//   Retry-After when longer, at most POOL_BUY_RETRY_AFTER_MAX_MS; card signpage-throttled-read-is-not-asked-again-at-once),
//   back to the pace once a round goes through whole; within the blockhash's life no wait runs past it. The settle lists every mark of the pool, so it is asked only once each RPC's
//   finalized slot reaches the slot it read this transaction at (an RPC that names none is held to the other's), held
//   to those slots, or past POOL_BUY_GATE_MAX_MS from the land whatever the slots say; between reads it waits out the
//   gap at a slot's time each. A settle that threw, or past the gate found no spend, waits twice as long each time.
//   The app's Filled is the route's amount out, told at confirmed; the stage filled is the settle's.
// - The fee: the proof's relay fee cap must be at most the epoch fee the device works out from the Rent sysvar it read on
//   both RPCs (the kit's solanaPoolFee), never only the binding's own word.
// - The take: only after the check and the signature does the queue's take move the note HELD -> RESERVED, awaited
//   before the transaction leaves the device (notes/store.ts). It names the attempt the bytes carry: one a remake swapped
//   out is refused inside the queue's turn for the note, before any write, so the note stays HELD and its new proof
//   ready. A refusal before the take leaves the proof ready for the next tap.
// - The send: the helper's POST /v1/pool/solana/send ({pool, tx}); its answer is hostile. The signature it names must
//   read back on both RPCs as this very transaction (the same message, W's signature in slot 1, that signature in slot
//   0) and succeeded. On one RPC only, another transaction under that name is that RPC's word against the other's, so
//   the reads go on. This very transaction failed on chain on both spent nothing (the release and the buy are one
//   transaction) and can never land: refused, or not_landed when the settle finds the note spent (another's spend). A
//   send the helper refused or never answered, a signature that is not one, another transaction under it on both RPCs,
//   or none read back: the signed transaction may still land, so the answer is not_landed only once both RPCs'
//   finalized height is past the blockhash's last valid one (the higher of RPC 0's word and RPC 1's height + 151) and
//   the note's settle, read at or past each RPC's slot of that height read (pastAt), returns no spend; a settle that
//   throws says nothing (card sol-settle-failed-is-not-unspent). Past the reads it is "sent".
// - What the app is told (card signpage-sent-read-back): the helper's signature is a name to read back, never a fact.
//   The kind answers "sent" with it, and an answer's txs name it, only once each RPC read this very transaction's
//   bytes under it. Before that the app has no answer and no transaction id; one read as another transaction, or on
//   one RPC only, is never named (a broken-in helper's word, or another device's).
// - Whose spend (card signpage-buy-own-spend): a spend the settle finds is filled only once both RPCs read, at
//   finalized, that it is this attempt's (pool-spend.ts spendOwner: this transaction by the helper's signature, else
//   W's history, its context this proof's), and filled names that spend's own signature. Another device signed in
//   with the same 12 words spends the same note to the same W from its own note store, so the spent mark alone never
//   says the tokens are this buy's: another's spend is not_landed (this transaction can never land on a spent note),
//   and one not read yet is never filled. The settle writes the change either way.
// - Spent: only then is the note settled through the wallet's one place for it (solanaSettleSpent: the spent mark and
//   the change leaf read on two RPCs, the change written UNSPENT naming the note, which goes SPENT). That SPENT note is
//   W's record: the buy wallets list (../../wallet/src/pool/buy-wallets.ts spentNotesOf) finds W and reads its holdings.
//   Not settled within the reads (or not landed, or refused): the note stays RESERVED, and each state read of the page
//   settles it (../../wallet/src/pool/solana-restore.ts solanaSettleReserved: SPENT once its spent mark and change read
//   on both RPCs, UNSPENT once both RPCs' block time is past its deadline with no spent mark, so the queue proves it
//   again).
// - The route (card signpage-buy-route-events): the run tells the app, through the kind's route events (messages.ts
//   BuyRoute), only what it bound or read itself: W and the venue with its pool once the check passed, W derived to the
//   proof's recipient and signed, and the take holds the note, before the transaction leaves; then the transaction's
//   signature once both RPCs read this very transaction back under it (card pool-buy-send-fast); then the amount W
//   received, read from this very transaction's token balances on both RPCs (the two the same, at least the min out,
//   within the kit's bound), once it reads back as succeeded on both. Not read plainly on both: not told.
// - Every read names a public account or the transaction itself; no request carries a key, the words or which note is
//   whose. Nothing here logs.
import { base58, base64 } from "@scure/base";
import {
  buildSolanaPoolBuyOnTables,
  readSolanaPoolBuyVenue,
  readSolanaRent,
  solanaPoolAccount,
  solanaPoolBuyFunds,
  solanaPoolFee,
  solanaPoolPage,
  solanaPoolPriorityBudget,
  SOLANA_POOL_BUY_CU,
  SolanaPoolBuyError,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRent,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { pageReference } from "./page-rpc.ts";
import { solanaDecodeLookupTable, type SolanaLookupTable } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_CU_PRICE_MAX, SOLANA_JITO_TIP_MIN } from "../../kit/src/checks/solana/checks.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import type { BuyRoute, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_ROUTE_OUT } from "../../kit/src/signpage/schema.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { throttleWaitMs, type ThrottleBounds } from "../../wallet/src/throttle.ts";
import type { ChainNow, ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkSolanaBuy, PoolRuleRefused, signSolana, type PoolAsk } from "./rules/pool.ts";
import { spendOwner, type HistoryPlaces, type SpendOwner } from "./pool-spend.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** The page's own copy of the kit's route bound: a frozen RegExp's matcher can still be swapped
 *  (RegExp.prototype.compile), so the page never tests against the shared one (card kit-oneclick-pins-frozen review). */
const ROUTE_OUT = new RegExp(SIGNPAGE_ROUTE_OUT.source, SIGNPAGE_ROUTE_OUT.flags);

/** What a buy run needs from the page. */
/** W's buy mint by W's address (card sol-w-sweep, delta review 7 of 08290868): each W is one buy's, and the buy writes
 *  the mint it buys (and its token program) before its send, so the rent back after a later sell knows which of W's
 *  tokens is W's own coin. A buy whose send fails leaves the record; it can only make the rent back hold. */
export type BuyMints = { get(address: string): Promise<{ mint: string; program: string } | undefined>; put(address: string, m: { mint: string; program: string }): Promise<void> };

export type PoolBuyHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Where the buy writes W's buy mint before its send (BuyMints); a write that fails sends nothing. */
  bought?: BuyMints;
  /** The pin's lookup tables per venue, generations oldest first (wallet SOL_POOL_TABLES: the addresses a tag 3 on that
   *  venue may load its accounts from); none pinned, or a pin that is not a list of addresses: refused not_allowed; the
   *  buy's venue with none: refused venue_not_pinned before the pick. */
  tables: Readonly<Partial<Record<SolanaPoolBuyVenue["kind"], readonly string[]>>>;
  cluster: "mainnet" | "devnet";
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The queue's ready proofs (never taken by reading them); the queue is opened first when it is not. */
  ready(): Promise<readonly ReadyProof<SolanaReleaseRequest>[]>;
  /** The queue's take of this attempt: HELD -> RESERVED, written before it returns; refused, the note HELD, when the
   *  note's ready proof is another attempt. */
  take(noteId: string, attempt: string, early?: Promise<ChainNow>): Promise<ReadyProof<SolanaReleaseRequest>>;
  /** The pool's time read now, for the take (the wallet's chainNow on the queue's pool; card sol-buy-reads-side-by-side):
   *  a buy starts it with its first round, so the take, which uses it within NOW_REUSE_MS of its start, waits on no read
   *  of its own between the signature and the send. */
  chainNow?(): Promise<ChainNow>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  /** POST /v1/pool/solana/send: the helper's answer as it came (hostile). */
  send(pool: string, tx: Uint8Array): Promise<unknown>;
  /** The wallet's solanaSettleSpent for this note: "spent" once its change is written and the note is SPENT. minSlots:
   *  each RPC's reads at or past it (the not_landed verdict's, pastAt's slots). A throw is no answer, never "unspent". */
  settle(noteId: string, minSlots?: readonly [number, number]): Promise<{ kind: "spent" | "unspent" }>;
  /** The device's clock, ms. */
  now?(): bigint;
  /** Read-back reads and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  /** The helper's word for the transaction's signature, before any read-back: only a name to read back first (a pool
   *  withdraw keeps it with the owed send), never shown and never an answer's. */
  named?(signature: string): void | Promise<void>;
  /** Both RPCs read this very transaction's bytes under that signature: its signature, told once. Never before, so
   *  nothing the app is told names a transaction the chain did not read as this one. */
  sent?(signature: string): void | Promise<void>;
  /** The buy's route as the run binds and reads it (messages.ts BuyRoute): W and the venue with its pool once the check
   *  passed and W derived to the proof's recipient, then the amount W received once the transaction read back on both
   *  RPCs as the same. Each once, in that order; a throw here never stops the buy. */
  route?(r: BuyRoute): void;
  /** W's address and the decimals of the token it received, read with that amount on both RPCs: told just before the
   *  route's amount, for the device's buy record (src/positions.ts); a throw here never stops the buy. */
  outDecimals?(wallet: string, decimals: number): void;
  /** The notes a run on this page has picked and not finished: a second tap picks another ready proof. */
  claimed?: Set<string>;
  /** Tests only: the venue's fee recipient and the Jito tip account, else random. */
  pick?: (n: number) => number;
};

export type PoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "venue_not_pinned" | "no_table_fits" | "failed" | "down" };

/** The helper's busy answer to a send (its 429: rate_limited when a pool provider throttled a read, in_flight when this
 *  caller holds too many sends open, or its per-caller throttle), with the wait its Retry-After names. The send is
 *  made again, the same signed bytes, after that wait, until the blockhash is past on both RPCs (the card
 *  signpage-pool-flow-run, run 6: the page answered not_landed to a helper that said "wait 1 s"). */
export class PoolSendBusy extends Error {
  readonly code: "rate_limited" | "in_flight" | "throttled";
  readonly retryAfterMs: number;
  constructor(code: "rate_limited" | "in_flight" | "throttled", retryAfterMs: number) {
    super(`pool send: busy (${code}), again in ${retryAfterMs} ms`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
/** The wait between two sends of one transaction: the helper's Retry-After, at least 1 s, at most 5 s. */
export const POOL_SEND_BUSY_WAIT_MS = { min: 1_000, max: 5_000 } as const;
/** The most sends of one transaction: past a blockhash's life at the shortest wait, so the height decides first. */
export const POOL_SEND_TRIES_MAX = 120;
/** A blockhash's life on the wall clock, from the signature: 151 blocks (~60 s at 400 ms) with room for slower slots.
 *  Past it, a busy send is not made again, whatever an RPC that is down or stuck reads. */
export const POOL_BLOCKHASH_LIFE_MS = 90_000;
/** The read-back's bound on the wall clock, from the signature: the blockhash's life and a finalization (~32 slots).
 *  Past it, the answer is "sent" (the note RESERVED, settled by the state reads), so one RPC down or stuck never holds
 *  the seed's lock, and sign out, for minutes. */
export const POOL_BUY_SETTLE_MS = 120_000;

/** Read-back reads a buy gets, at most POOL_BUY_POLL_MS apart: POOL_BUY_SETTLE_MS of them, past a blockhash's life
 *  (~60 to 90 s) and a finalization; the wall clock bounds them too. */
export const POOL_BUY_READS = 300;
/** The wait between two reads of the not-landed path (the blockhash past, the settle): a second. */
export const POOL_BUY_WAIT_MS = 1_000;
/** The read-back's pace after the send (card pool-buy-filled-2s): a slot, ~400 ms (the wallet's SOL_LAG_WAIT_MS), so
 *  the transaction is read at most a slot after both RPCs hold it at confirmed. The same pace reads both RPCs'
 *  finalized slot before the settle. */
export const POOL_BUY_POLL_MS = 400;
/** The most a read of the buy waits after a provider's throttle (429, a JSON-RPC throttle) or a settle that threw: the
 *  wait doubles from POOL_BUY_POLL_MS to this, or the provider's Retry-After when that is longer. */
export const POOL_BUY_BACKOFF_MAX_MS = 8_000;
/** The longest Retry-After a read of the buy honours: the helper's own window (apps/helper/src/rpc/rpc.ts, up to 10 s). */
export const POOL_BUY_RETRY_AFTER_MAX_MS = 10_000;
/** The buy's reads on the wallet's one rule for the wait after a failed read (../../wallet/src/throttle.ts
 *  throttleWaitMs; card signpage-throttled-read-is-not-asked-again-at-once): from the slot's pace, doubling to
 *  POOL_BUY_BACKOFF_MAX_MS, a Retry-After when longer up to POOL_BUY_RETRY_AFTER_MAX_MS. */
const POOL_BUY_THROTTLE: ThrottleBounds = /* @__PURE__ */ Object.freeze({ firstMs: POOL_BUY_POLL_MS, maxMs: POOL_BUY_BACKOFF_MAX_MS, afterMaxMs: POOL_BUY_RETRY_AFTER_MAX_MS });
/** The finality gate's bound, from the read that saw the transaction landed: past it the settle is asked whatever slot
 *  an RPC named for the transaction (one RPC's word, 2^53 - 1 say, never holds a landed buy), and its own reads decide. */
export const POOL_BUY_GATE_MAX_MS = 30_000;
/** The device's slot (its blockhash read) ages uncounted while the reads of its round finish: when the round's last
 *  read settles more than this after the slot was answered, on the device's clock, the blockhash and slot are read again
 *  and the quote's age is checked against that read. */
export const POOL_BUY_SLOT_STALE_MS = 1_000;
/** Two providers a slot apart read the pool's state tree at two sizes: read again once, this long after. */
export const POOL_BUY_SIZE_RETRY_MS = 500;

const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024;
const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;

type Code = "not_allowed" | "not_funded" | "quote_check_failed" | "venue_not_pinned" | "no_table_fits" | "failed";
class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
const no = (code: Code = "failed"): never => {
  throw new Refused(code);
};
const int = (x: unknown): number => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : no());
const be32 = (x: bigint): Uint8Array => {
  if (x < 0n || x >= 1n << 256n) no();
  const b = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) b[i] = Number(v & 255n);
  return b;
};
const beInt = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const dec = (s: unknown): bigint => (typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s) ? BigInt(s) : no());
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(h: Pick<PoolBuyHost, "rpcs">, f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(h.rpcs[0]), f(h.rpcs[1])]);

/** One account as an RPC gives it (base64, confirmed); null when there is none. */
async function account(rpc: SolanaRpc, address: string): Promise<{ owner: string; data: Uint8Array } | null> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown };
  const v = r?.value as { owner?: unknown; data?: unknown } | null | undefined;
  if (v === null) return null;
  if (typeof v?.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return no();
  return { owner: v.owner, data: base64.decode(v.data[0]) };
}

/** The pool account on both RPCs: its state tree's size (the kit's build needs it) and both trees' sizes, the lower.
 *  The two state sizes must be one; a pair a slot apart (a leaf landed between them) is read again once. */
export async function treeSizes(h: Pick<PoolBuyHost, "rpcs" | "pin">, pool: string, wait: (ms: number) => Promise<void>): Promise<{ state: number; label: number; stateSize: number }> {
  try {
    return await treeSizesOnce(h, pool);
  } catch (e) {
    if (!(e instanceof SizeSkew)) throw e;
    await wait(POOL_BUY_SIZE_RETRY_MS);
    return treeSizesOnce(h, pool);
  }
}
class SizeSkew extends Refused {}
async function treeSizesOnce(h: Pick<PoolBuyHost, "rpcs" | "pin">, pool: string): Promise<{ state: number; label: number; stateSize: number }> {
  const sizes = (await both(h, (r) => account(r, pool))).map((a) => {
    if (a === null || a.owner !== h.pin.program || a.data.length !== POOL_LEN || !sameBytes(a.data.subarray(0, 8), POOL_DISC)) return no();
    const at = (o: number): number => int(Number(new DataView(a.data.buffer, a.data.byteOffset + o, 8).getBigUint64(0, true)));
    return { state: at(OFF_TREES), label: at(OFF_TREES + TREE_LEN) };
  });
  // the build names the change's page from the state size, which must be the one the release will meet: both the same
  if (sizes[0]!.state !== sizes[1]!.state) throw new SizeSkew("failed");
  return { state: sizes[0]!.state, label: Math.min(sizes[0]!.label, sizes[1]!.label), stateSize: sizes[0]!.state };
}

/** The leaf index whose root is `root` in `tree`, read on both RPCs from the newest page back: both must give it. */
export async function rootIndex(h: Pick<PoolBuyHost, "rpcs" | "pin">, tree: 0 | 1, size: number, root: bigint): Promise<number> {
  const want = be32(root);
  for (let page = Math.floor((size - 1) / PAGE_ENTRIES); page >= 0; page--) {
    const found = (await both(h, (r) => account(r, solanaPoolPage(h.pin.program, tree, page * PAGE_ENTRIES)))).map((a) => {
      if (a === null) return no();
      if (a.owner !== h.pin.program || a.data.length < PAGE_HEADER || (a.data.length - PAGE_HEADER) % PAGE_ENTRY !== 0) return no();
      const n = (a.data.length - PAGE_HEADER) / PAGE_ENTRY;
      for (let i = n - 1; i >= 0; i--) {
        const at = PAGE_HEADER + i * PAGE_ENTRY + 32;
        if (sameBytes(a.data.subarray(at, at + 32), want)) return page * PAGE_ENTRIES + i;
      }
      return -1;
    });
    if (found[0] !== found[1]) return no(); // on one RPC only, or at two indexes: another root
    if (found[0]! >= 0) return found[0]!;
  }
  return no();
}

/** The proof as the program reads it: A, B (each Fq2 imaginary part first), C, 32 bytes big-endian each. */
export function solanaProofBytes(p: VaultSnarkjsProof): Uint8Array {
  if (p.pi_a[2] !== "1" || p.pi_c[2] !== "1" || p.pi_b[2][0] !== "1" || p.pi_b[2][1] !== "0") return no();
  const xs = [p.pi_a[0], p.pi_a[1], p.pi_b[0][1], p.pi_b[0][0], p.pi_b[1][1], p.pi_b[1][0], p.pi_c[0], p.pi_c[1]];
  const out = new Uint8Array(256);
  xs.forEach((x, i) => out.set(be32(dec(x)), i * 32));
  return out;
}

/** The release a ready proof carries, for this pin and W, with its two root indexes; refused unless every field of
 *  the binding is this pin's and W's and its context is the proof's. */
export function releaseOf(r: ReadyProof<SolanaReleaseRequest>, pin: SolanaPoolPin, w: string, idx: { state: number; label: number }): SolanaPoolRelease {
  const q = r.binding.request;
  const { pool, scope } = solanaPoolOf(pin.program);
  const s = r.publicSignals;
  if (q.program !== pin.program || q.pool !== pool || q.feePayer !== pin.feePayer || q.recipient !== w || r.wallet.address !== w) no();
  if (q.deadlineMs !== r.deadlineMs || q.relayFee !== q.relayFeeCap || q.relayFeeCap !== r.binding.feeCap) no();
  if (solanaContextOf(q, scope) !== r.binding.context || dec(s[7]) !== r.binding.context || dec(s[2]) !== r.chunk) no();
  const depth = (x: string): number => {
    const d = dec(x);
    return d <= 32n ? Number(d) : no();
  };
  return {
    proof: solanaProofBytes(r.proof),
    newCommitmentHash: be32(dec(s[0])),
    existingNullifierHash: be32(dec(s[1])),
    withdrawnValue: r.chunk,
    stateRootIndex: idx.state,
    stateTreeDepth: depth(s[4]),
    labelRootIndex: idx.label,
    labelTreeDepth: depth(s[6]),
    relayFee: q.relayFee,
    relayFeeCap: q.relayFeeCap,
    tipCap: q.tipCap,
    deadlineMs: q.deadlineMs,
    salt: Uint8Array.from(q.salt.match(/../g)!.map((x) => parseInt(x, 16))),
  };
}

/** The pinned tables, venue and address, of the venues the kit builds, in each venue's generation order; null when a
 *  venue's pin is not a non-empty list of addresses (refused, never read past). */
const pinnedTables = (h: PoolBuyHost): (readonly [SolanaPoolBuyVenue["kind"], string])[] | null => {
  const out: (readonly [SolanaPoolBuyVenue["kind"], string])[] = [];
  for (const v of ["pump-curve", "pumpswap"] as const) {
    if (!Object.hasOwn(h.tables, v)) continue;
    const list: unknown = h.tables[v];
    if (!Array.isArray(list) || list.length === 0 || !list.every((a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))) return null;
    for (const a of list as string[]) out.push([v, a]);
  }
  return out;
};

/** The lookup table on both RPCs, the same bytes. */
async function tableOf(h: PoolBuyHost, address: string): Promise<{ table: SolanaLookupTable; reads: Record<string, [{ owner: string; data: Uint8Array } | null, { owner: string; data: Uint8Array } | null]> }> {
  const [a, b] = await both(h, (r) => account(r, address));
  if (a === null || b === null || !sameBytes(a.data, b.data) || a.owner !== b.owner) return no();
  return { table: solanaDecodeLookupTable(a.data), reads: { [address]: [a, b] } };
}

/** A blockhash is valid for 150 blocks after the one it names (Solana's MAX_PROCESSING_AGE), so at most height + 151. */
const BLOCKHASH_LIFE = 151;

/** The blockhash on RPC 0 and its slot (the device's own slot for the quote's age), valid on RPC 1; and `lastHeight`,
 *  a block height past which no transaction on it can land, whichever RPC lies: the higher of RPC 0's
 *  lastValidBlockHeight and RPC 1's height (read after it) + 151. A liar can only raise it, which only waits longer.
 *  pool-sell.ts reads its blockhash here too. */
export async function blockhashOf(rpcs: readonly [SolanaRpc, SolanaRpc]): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number; lastHeight: number }> {
  const r = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { context?: { slot?: unknown }; value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } };
  const blockhash = r?.value?.blockhash;
  if (typeof blockhash !== "string") return no();
  const [ok, height] = await Promise.all([
    rpcs[1]("isBlockhashValid", [blockhash, { commitment: "confirmed" }]) as Promise<{ value?: unknown }>,
    rpcs[1]("getBlockHeight", [{ commitment: "confirmed" }]),
  ]);
  if (ok?.value !== true) return no();
  const said = int(r.value!.lastValidBlockHeight);
  const cap = int(height) + BLOCKHASH_LIFE;
  return { blockhash, lastValidBlockHeight: said, slot: int(r.context?.slot), lastHeight: said > cap ? said : cap };
}

/** True once both RPCs' finalized block height is past `last`: no transaction on that blockhash can land after, and
 *  any that did is final, so a spent mark read now at finalized is the whole answer. A failed read is "not yet". */
export async function pastOnBoth(rpcs: readonly [SolanaRpc, SolanaRpc], last: number): Promise<boolean> {
  try {
    const hs = await Promise.all(rpcs.map((rpc) => rpc("getBlockHeight", [{ commitment: "finalized" }])));
    return hs.every((x) => int(x) > last);
  } catch {
    return false;
  }
}

/** Each RPC's finalized slot once both are past `last`: one getEpochInfo at finalized per RPC, so the block height and
 *  the slot are one node's, of one block; null while either is not past, or a read fails. A read held to these slots
 *  (minContextSlot) holds every transaction of that blockhash that ever landed. The same read as pool-sell.ts pastAt,
 *  which a live check (sol-rent-back-dust-burn) reads in place in the bundle beside the sell's own verdict. */
async function pastAt(rpcs: readonly [SolanaRpc, SolanaRpc], last: number, failed?: (e: unknown) => void): Promise<[number, number] | null> {
  try {
    const got = await Promise.all(rpcs.map(async (r) => {
      const e = (await r("getEpochInfo", [{ commitment: "finalized" }])) as { blockHeight?: unknown; absoluteSlot?: unknown } | null;
      return int(e?.blockHeight) > last ? int(e?.absoluteSlot) : null;
    }));
    return got[0] !== null && got[1] !== null ? [got[0], got[1]] : null;
  } catch (e) {
    // a read that failed is not known yet; the caller's wait grows on it (card signpage-throttled-read-is-not-asked-again-at-once)
    failed?.(e);
    return null;
  }
}

/** True once either RPC's finalized block height is past `last`: that RPC's chain can no longer take the blockhash, so
 *  sending it again is no use (the not_landed verdict still waits for both, pastOnBoth). A failed read is "not yet". */
export async function pastOnEither(rpcs: readonly [SolanaRpc, SolanaRpc], last: number): Promise<boolean> {
  const one = (rpc: SolanaRpc): Promise<boolean> =>
    Promise.resolve()
      .then(() => rpc("getBlockHeight", [{ commitment: "finalized" }]))
      .then((x) => int(x) > last, () => false);
  return (await Promise.all(rpcs.map(one))).some(Boolean);
}

/** The transaction under `signature` on one RPC: "none" (not seen yet, or this very transaction with a meta that says
 *  nothing), "ok", "failed" or "other" (not ours). pool-sell.ts reads its transaction here too. */
export async function readBack(rpc: SolanaRpc, signature: string, signed: Uint8Array): Promise<"none" | "ok" | "failed" | "other"> {
  return (await readBackMeta(rpc, signature, signed)).got;
}

/** readBack, with this very transaction's on-chain error when both say it failed (card sol-buy-rent-back, review L2: a
 *  deposit that meets a page another insert filled first fails WrongAccount, and is built again from new reads). */
export async function readBackFailure(rpc: SolanaRpc, signature: string, signed: Uint8Array): Promise<{ got: "none" | "ok" | "failed" | "other"; err?: unknown }> {
  const r = await readBackMeta(rpc, signature, signed);
  return r.got === "failed" ? { got: r.got, err: r.meta?.err } : { got: r.got };
}

/** readBack, with the transaction's meta when it is this very transaction (the token balances the fill is read from),
 *  and `mine`: the RPC answered this very transaction's bytes under the signature (ok, failed, or a meta that says
 *  nothing), the read that lets an answer name it. */
export async function readBackMeta(rpc: SolanaRpc, signature: string, signed: Uint8Array, commitment: "confirmed" | "finalized" = "confirmed"): Promise<{ got: "none" | "ok" | "failed" | "other"; mine?: true; meta?: Record<string, unknown>; slot?: number }> {
  const r = (await rpc("getTransaction", [signature, { encoding: "base64", commitment, maxSupportedTransactionVersion: 0 }])) as { transaction?: unknown; meta?: { err?: unknown }; slot?: unknown } | null;
  if (r === null) return { got: "none" };
  const t = r?.transaction;
  if (!Array.isArray(t) || t[1] !== "base64" || typeof t[0] !== "string") return { got: "other" };
  const got = base64.decode(t[0]);
  const want = signed.slice();
  want.set(base58.decode(signature), 1);
  if (!sameBytes(got, want)) return { got: "other" };
  // this very transaction, its meta unreadable (absent, not an object, no `err`): it proves nothing either way, so the
  // reads go on and the answer keeps the transaction's ref
  const meta = r.meta as unknown;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta) || !Object.hasOwn(meta, "err") || (meta as { err: unknown }).err === undefined) return { got: "none", mine: true };
  // the slot the RPC says it holds it at (card pool-buy-filled-2s: the settle waits for both RPCs' finalized slot to
  // reach it); an RPC's word, which can only make the settle wait longer or start sooner, never decide it
  const slot = Number.isSafeInteger(r.slot) && (r.slot as number) >= 0 ? (r.slot as number) : undefined;
  return { got: (meta as { err: unknown }).err === null ? "ok" : "failed", mine: true, meta: meta as Record<string, unknown>, ...(slot === undefined ? {} : { slot }) };
}

/** What `owner` received of `mint` in one transaction, from its meta's token balances (post less pre, summed over the
 *  owner's accounts of that mint): the raw amount and the mint's decimals, or null when the meta does not say it
 *  plainly (an entry malformed, two decimals, nothing after). Never throws: a fill it cannot read is not shown. */
export function tokenReceived(meta: Record<string, unknown> | undefined, owner: string, mint: string): { raw: bigint; decimals: number } | null {
  if (!meta) return null;
  let decimals: number | null = null;
  const sum = (key: "preTokenBalances" | "postTokenBalances"): bigint | null => {
    const list = meta[key];
    if (!Array.isArray(list)) return null;
    let total = 0n;
    for (const e of list as unknown[]) {
      const b = e as { mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown; decimals?: unknown } } | null;
      if (typeof b !== "object" || b === null) return null;
      if (b.mint !== mint || b.owner !== owner) continue;
      const amount = b.uiTokenAmount?.amount;
      const d = b.uiTokenAmount?.decimals;
      if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(amount) || !Number.isSafeInteger(d) || (d as number) < 0 || (d as number) > 255) return null;
      if (decimals !== null && decimals !== d) return null;
      decimals = d as number;
      total += BigInt(amount);
    }
    return total;
  };
  const pre = sum("preTokenBalances");
  const post = sum("postTokenBalances");
  if (pre === null || post === null || decimals === null || post <= pre) return null;
  return { raw: post - pre, decimals };
}

/** A raw amount in whole units of `decimals`, as a decimal string with no trailing zeros ("1234.5", "7"). */
export function unitsOf(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

type Ready = ReadyProof<SolanaReleaseRequest>;
type Got = "none" | "ok" | "failed" | "other";

/** One pool.buy: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). */
export async function runPoolBuy(h: PoolBuyHost, ask: PoolAsk): Promise<PoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let claim: string | null = null;
  // from here on W signs: a provider that fails past this is never "down" (the transaction may land)
  let signing = false;
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const nowMs = (): number => Number(h.now?.() ?? BigInt(Date.now()));
  const tell = (x: BuyRoute): void => {
    try {
      h.route?.(x);
    } catch {
      /* the app's display never stops a buy */
    }
  };
  try {
    const pinned = pinnedTables(h);
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || ask.token === null || pinned === null || pinned.length === 0) no("not_allowed");
    const token = ask.token!;
    const pool = solanaPoolAccount(h.pin.program);
    const mine = (list: readonly Ready[]): Ready[] => list.filter((p) => p.wallet.chain === "sol" && !h.claimed?.has(p.noteId));
    // the ready proofs first: none (or every one held by another tap of this page) and no read is made
    if (mine(await h.ready()).length === 0) return no("not_funded");
    // the pool's time for the take, read beside the first round (card sol-buy-reads-side-by-side); a failed read is the
    // take's to read again, and one never awaited (a buy refused before its take) is not left unhandled
    const early = h.chainNow?.();
    early?.catch(() => {});
    // the reads go out in rounds by their inputs alone (card pool-buy-filled-2s), each on both RPCs as before: first
    // the rent, each venue's pinned tables, the pool account and the reference, which need only the pin and the ask;
    // then the root pages (the sizes name them), the venue (the reference names it) and the device's blockhash and slot,
    // started last; then the blockhash on RPC 1 (blockhashOf: it needs RPC 0's)
    const rentRead: Promise<SolanaRent> = readSolanaRent(h.rpcs);
    rentRead.catch(() => {}); // awaited in the first round below; a rejection before then is not left unhandled
    let rent!: SolanaRent;
    let feeCap!: bigint;
    // each venue's pinned tables, read here with the other reads that do not age, each venue's on its own: a buy fails
    // on its own venue's tables only, so another venue's unreadable table never stops it
    const tableReads = new Map<SolanaPoolBuyVenue["kind"], Promise<{ address: string; table: SolanaLookupTable; reads: Awaited<ReturnType<typeof tableOf>>["reads"] }[]>>();
    for (const v of new Set(pinned!.map(([v]) => v))) tableReads.set(v, Promise.all(pinned!.filter(([x]) => x === v).map(async ([, address]) => ({ address, ...(await tableOf(h, address)) }))));
    // not awaited here: the buy waits on its own venue's reads only (below, once the reference names the venue), so a
    // slow or hung read of another venue's table never holds it; a rejection no buy awaits is marked handled
    for (const r of tableReads.values()) r.catch(() => {});
    const tip = h.cluster === "mainnet" ? SOLANA_JITO_TIP_MIN : 0n;
    // each root's leaf index, found once: absent when it is on no page or not on both RPCs at one index
    const roots = new Map<string, number | null>();
    const rootKey = (tree: 0 | 1, root: string): string => `${tree}:${root}`;
    const indexOf = (p: Ready): { state: number; label: number } | null => {
      const state = roots.get(rootKey(0, p.publicSignals[3]));
      const label = roots.get(rootKey(1, p.publicSignals[5]));
      return state == null || label == null ? null : { state, label };
    };
    for (let round = 0; ; round++) {
      // round 1: the pool account's two tree sizes and the reference (the quote's age counts from it, so it is read
      // again each round), with the rent on the first
      const [sizes, ref] = await Promise.all([treeSizes(h, pool, wait), pageReference(h.rpcs, { side: "buy", token, amount: ask.amount }), round === 0 ? rentRead.then((x) => void ((rent = x), (feeCap = solanaPoolFee(x)))) : null]);
      const best = ref?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
      if (!ref || !best) return no("quote_check_failed");
      // the venue's own tables: a venue the page pins none for is refused as soon as the reference names it, before its
      // own accounts are read and before the pick, so no note is claimed
      const kind = best.venue as "pump-curve" | "pumpswap";
      const ownRead = tableReads.get(kind);
      if (ownRead === undefined) return no("venue_not_pinned");
      const own = await ownRead;
      if (own.length === 0) return no("venue_not_pinned");
      // round 2: each ready proof's root indexes not found yet (the sizes name the newest page), the venue, then the
      // device's blockhash and slot, started last (the venue's read and a page past the first start after it: below)
      const lookups: Promise<void>[] = [];
      for (const p of mine(await h.ready()))
        for (const [tree, size, root] of [[0, sizes.state, p.publicSignals[3]], [1, sizes.label, p.publicSignals[5]]] as const) {
          const k = rootKey(tree, root);
          if (roots.has(k)) continue;
          roots.set(k, null);
          lookups.push(rootIndex(h, tree, size, dec(root)).then((i) => void roots.set(k, i), (e) => (e instanceof Refused ? undefined : Promise.reject(e))));
        }
      const venueRead: Promise<SolanaPoolBuyVenue> = readSolanaPoolBuyVenue(h.rpcs, kind, token, ...(h.pick ? [h.pick] : []));
      // the slot is read before some of its round's reads end (the venue's a microtask on, a root page past the first
      // after the page before it): when the round ends over POOL_BUY_SLOT_STALE_MS after the slot was answered, the
      // blockhash and slot are read again, so a slow or lying provider costs a round, never the quote's age bound
      let slotAt = 0;
      const timed: readonly [SolanaRpc, SolanaRpc] = [((m: string, q: readonly unknown[]) => h.rpcs[0](m, q).then((x) => ((slotAt = nowMs()), x))) as SolanaRpc, h.rpcs[1]];
      const [, venue, first] = await Promise.all([Promise.all(lookups), venueRead, blockhashOf(timed)]);
      const bh = nowMs() - slotAt > POOL_BUY_SLOT_STALE_MS ? await blockhashOf(h.rpcs) : first;
      const minOut = (best.expectedOut * BigInt(10_000 - ask.slippageBps)) / 10_000n;
      // the pick, from the ready proofs as they are now (a remake or another tab may have changed them during the
      // reads): the smallest chunk that pays the spend and W's accounts; filtered and claimed in one turn, so two runs
      // of this page never claim one note
      const fundable = mine(await h.ready())
        .sort((x, y) => (x.chunk < y.chunk ? -1 : x.chunk > y.chunk ? 1 : 0))
        .filter((p) => solanaPoolBuyFunds({ withdrawnValue: p.chunk, relayFee: p.binding.request.relayFee } as SolanaPoolRelease, venue, { spend: ask.amount, tip }, rent).problem === null);
      if (fundable.length === 0) return no("not_funded");
      const r = fundable.find((p) => indexOf(p) !== null);
      // the proof to buy with is on a root not looked up yet (remade during the reads): read once more
      if (r === undefined || r !== fundable[0]) {
        if (round === 0 && fundable.some((p) => !roots.has(rootKey(0, p.publicSignals[3])) || !roots.has(rootKey(1, p.publicSignals[5])))) continue;
        if (r === undefined) return no(); // a proof for another root: refused before anything is signed
      }
      const release = releaseOf(r, h.pin, r.wallet.address, indexOf(r)!);
      // the most the relay fee's priority budget pays, never over the kit's CU price cap
      const budget = (solanaPoolPriorityBudget(rent, release.relayFee) * 1_000_000n) / BigInt(SOLANA_POOL_BUY_CU[venue.kind]);
      const cuPrice = budget < SOLANA_CU_PRICE_MAX ? budget : SOLANA_CU_PRICE_MAX;
      const req: SolanaPoolBuyRequest = { wallet: r.wallet.address, feePayer: h.pin.feePayer, token, spend: ask.amount, minOut, tip, cuPrice, cluster: h.cluster };
      const cfg = { program: h.pin.program, pool };
      // built on the venue's generation that makes the smallest transaction, before the claim and the seed: a buy that
      // fits none is refused by name (synchronous, so the claim below is still this turn's)
      let built: ReturnType<typeof buildSolanaPoolBuyOnTables>;
      try {
        built = buildSolanaPoolBuyOnTables(cfg, release, venue, req, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, stateSize: sizes.stateSize, rent }, own.map((t) => ({ address: t.address, table: t.table })), h.pick ? { pick: h.pick } : {});
      } catch (e) {
        if (/^no_table_fits\b/.test(String((e as Error)?.message))) return no("no_table_fits");
        // none of the venue's pinned tables is made for it (a table pinned under the wrong venue): no table for it here
        if (e instanceof SolanaPoolBuyError && e.code === "venue_not_in_table") return no("venue_not_pinned");
        throw e;
      }
      const used = own.find((t) => t.address === built.table.address)!;
      claim = r.noteId;
      h.claimed?.add(claim);
      // the device's own fee cap: the epoch fee from the Rent sysvar it read, never the binding's word
      const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: r.wallet.address, feeCap, solana: h.pin };
      checkSolanaBuy(built.wire, ask, ctx, release, venue, req, { blockhash: bh.blockhash, slot: bh.slot, tables: used.reads, stateSize: sizes.stateSize, rent, reference: { amount: ask.amount, ref, slippageBps: ask.slippageBps } });
      // W, from the seed, right before it signs: it must be the proof's recipient the bytes were built and checked for
      signing = true;
      seed = await h.seed64();
      const w = freshWallet(seed, "sol", r.wallet.l, r.wallet.j);
      key = w.secretKey;
      seed.fill(0);
      if (w.address !== r.wallet.address) return no();
      const sig = signSolana(key, built.wire);
      key.fill(0);
      key = null;
      const signed = built.wire.slice();
      signed.set(sig, 1 + 64);
      // the route as bound, told once the take holds the note (sendAndSettle): W, then the venue the check passed and its
      // pool (the curve's account or the AMM pool's)
      const bound: readonly BuyRoute[] = [{ wallet: w.address }, { venue: venue.kind, pool: venue.kind === "pump-curve" ? venue.curve : venue.pool }];
      // W's buy mint, written before the send (delta review 7 of 08290868): the rent back holds while W holds any of it
      await h.bought?.put(w.address, { mint: venue.mint, program: venue.tokenProgram });
      const decimals = (d: number): void => {
        // a record's decimals never stop a buy: a listener that throws, or rejects
        try {
          void Promise.resolve(h.outDecimals?.(w.address, d)).catch(() => {});
        } catch {
          /* thrown */
        }
      };
      return await sendAndSettle(h, r, release, pool, signed, bh.lastHeight, wait, { token, minOut, tell, bound, decimals, early });
    }
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    // a provider read that still fails after the page's own retry, before W signs: "not now" (card pool-read-down)
    if (!signing && e instanceof SolanaRpcTransportError) return { error: "down" };
    return { error: "failed" };
  } finally {
    seed?.fill(0);
    key?.fill(0);
    if (claim !== null) h.claimed?.delete(claim);
  }
}

/** The take, the send, the read-back on both RPCs, the settle and whose spend it is; every answer but filled tries the
 *  settle first, and filled is only this attempt's own spend.
 *  fill: the buy's route, told as the run goes (W and the venue with its pool once the take holds the note, the amount
 *  out once the transaction reads back); none for a pool withdraw, whose release tells no buy route. */
export async function sendAndSettle(
  h: Pick<PoolBuyHost, "rpcs" | "take" | "send" | "settle" | "now" | "reads" | "named" | "sent">, r: Ready, release: SolanaPoolRelease, pool: string, signed: Uint8Array, lastHeight: number, wait: (ms: number) => Promise<void>,
  fill?: { token: string; minOut: bigint; tell: (x: BuyRoute) => void; bound: readonly BuyRoute[]; decimals?: (d: number) => void; early?: Promise<ChainNow> },
): Promise<PoolBuyAnswer> {
  // the take, awaited before anything leaves: the queue hands out this very attempt, or refuses with the note HELD; a
  // buy's early read of the pool's time is its time when still fresh
  const taken = await h.take(r.noteId, r.attempt, fill?.early);
  if (taken.attempt !== r.attempt || !sameBytes(solanaProofBytes(taken.proof), release.proof)) return no();
  // the take holds the note for this very transaction: W and the venue with its pool, told before it leaves
  if (fill) for (const x of fill.bound) fill.tell(x);
  // the buy's transaction as a route fact (card pool-buy-send-fast), told once, by the first read that names it as this
  // very transaction: both RPCs reading it back under the helper's signature, or the spend's own signature read as this
  // attempt's on both (spentBy), so a filled answer the client dropped at its 10 s still links its transaction
  let toldTx = false;
  const tellTx = (tx: string): void => {
    if (!fill || toldTx) return;
    toldTx = true;
    fill.tell({ tx });
  };
  const reads = h.reads ?? POOL_BUY_READS;
  // the wall clock from the signature (the page's clock, h.now, in tests): bounds the resends and the read-back
  const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
  const signedAt = clock();
  const inTime = (): boolean => clock() - signedAt < POOL_BUY_SETTLE_MS;
  // a wait never runs past the read-back's bound
  const waitIn = (ms: number): Promise<void> => wait(Math.max(0, Math.min(ms, POOL_BUY_SETTLE_MS - (clock() - signedAt))));
  // the buy's own reads after the send (card pool-buy-filled-2s): at the slot's pace; any read that fails (a throttle,
  // HTTP 429 or a JSON-RPC one, a 5xx, a timeout, past the client's own retry) or a settle that threw waits on the one
  // rule (throttleWaitMs on POOL_BUY_THROTTLE: twice as long each time, up to POOL_BUY_BACKOFF_MAX_MS, or the provider's
  // Retry-After when longer; card signpage-throttled-read-is-not-asked-again-at-once: a 503 was asked again at the
  // slot's pace, 300 times in 120 s); back to the pace only once a round goes through whole (`faults` unchanged in it),
  // since a provider that refuses one method still answers the others
  const backoff = (cur: number, e: unknown): number => throttleWaitMs(cur, e instanceof SolanaRpcTransportError ? e.afterMs : null, POOL_BUY_THROTTLE);
  let pace = POOL_BUY_POLL_MS;
  let faults = 0;
  const slow = (e: unknown): void => void (faults++, (pace = backoff(pace, e)));
  // the settle (solanaSettleSpent: the note SPENT, its change written), asked until it finds the spend, then never again.
  // A settle that throws (a lister that refuses, a 429 past the retry, a stop) is not known yet (null), never "unspent"
  let settled = false;
  // the settle's own wait (card pool-buy-filled-2s): it lists every mark of the pool, so after one that threw (still no
  // answer) or, past the finality gate, found no spend, the next waits twice as long, from the slot's time to the cap
  let hold = POOL_BUY_POLL_MS;
  const settler = { settle: (id: string, minSlots?: readonly [number, number]) => h.settle(id, minSlots).catch((e: unknown) => ((hold = backoff(hold, e)), Promise.reject(e))) };
  const spent = async (minSlots?: readonly [number, number]): Promise<boolean | null> => {
    if (settled) return true;
    const s = await settler.settle(r.noteId, minSlots).then((x) => x.kind === "spent", () => null);
    settled = s === true;
    return s;
  };
  // whose spend it is, on both RPCs at finalized (spendOwner), read at or past both RPCs' finalized slot read after
  // the settle found it; W's history read on across the reads of this run from where each RPC stopped. The pin is the
  // proof's own, which releaseOf held to the page's. `hint`: the helper's signature, read first (it may be another's:
  // spendOwner names it mine only when it is this attempt's spend). A failed read is not known yet.
  const places: HistoryPlaces = new Map();
  const pin = { program: r.binding.request.program, feePayer: r.binding.request.feePayer };
  const nullifierHash = beInt(release.existingNullifierHash);
  const owner = async (hint: string | undefined): Promise<SpendOwner> => {
    try {
      const slots = await Promise.all(h.rpcs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])));
      return await spendOwner(h.rpcs, pin, r.wallet.address, nullifierHash, r.binding.context.toString(), Math.max(...slots.map(int)), hint, places);
    } catch (e) {
      slow(e);
      return null;
    }
  };
  // a spend the settle found: filled only when it is this attempt's, named by that spend's own signature (never the
  // helper's word); another's can never be this transaction's (not_landed); not known yet: null, the reads go on
  const spentBy = async (hint: string | undefined, txs: TxRef[]): Promise<PoolBuyAnswer | null> => {
    const o = await owner(hint);
    if (o === "other") return { stage: "not_landed", txs };
    if (o === null) return null;
    tellTx(o.mine);
    return { stage: "filled", txs: [{ chain: "solana", hash: o.mine }] };
  };
  // the chain's word on the note (its spent mark and change on both RPCs, then whose spend it is) over the helper's or
  // one RPC's: this attempt's spend is filled, named by the signature both RPCs read it under. not_landed once
  // another's spend is read, or once both RPCs' finalized height is past the blockhash's last one and the settle, read at
  // or past each RPC's slot of that read, returns no spend (a settle that throws decides nothing; the kit's rule: never
  // not_landed while the transaction may still land,
  // packages/kit/src/trade/solana/flow.ts finishSolanaSet); until then the reads go on, and past them the answer is
  // "sent", the note RESERVED (or SPENT with its change, whose spend not read yet) for the state reads' pass. `txs`
  // names the helper's signature only once both RPCs read this very transaction under it.
  const unlanded = async (txs: TxRef[], hint?: string): Promise<PoolBuyAnswer> => {
    for (let i = 0; i < reads && (i === 0 || inTime()); i++) {
      if (i > 0) await waitIn(Math.max(POOL_BUY_WAIT_MS, pace, hold));
      const f0 = faults;
      const past = await pastAt(h.rpcs, lastHeight, slow); // before the settle: a spend final by then is in its read
      const s = await spent(past ?? undefined);
      if (s) {
        const a = await spentBy(hint, txs);
        if (a) return a;
      } else if (s === false && past !== null) return { stage: "not_landed", txs };
      if (faults === f0) pace = POOL_BUY_POLL_MS;
    }
    return { stage: "sent", txs };
  };
  let answer: unknown;
  for (let tries = 1; ; tries++) {
    try {
      answer = await h.send(pool, signed);
      break;
    } catch (e) {
      // the helper's error says nothing of the chain: a broken-in helper may answer 502 and send it anyway
      if (!(e instanceof PoolSendBusy) || tries >= POOL_SEND_TRIES_MAX) return unlanded([]);
      // busy: the same bytes again after its wait, while the blockhash lives: never once either RPC reads it past, nor
      // past its life on the wall clock (an RPC down or stuck reads nothing); then the read-back rules decide
      // (not_landed only once both RPCs read it past and the settle finds no spend)
      if (clock() - signedAt >= POOL_BLOCKHASH_LIFE_MS || (await pastOnEither(h.rpcs, lastHeight))) return unlanded([]);
      await wait(Math.min(Math.max(e.retryAfterMs, POOL_SEND_BUSY_WAIT_MS.min), POOL_SEND_BUSY_WAIT_MS.max));
    }
  }
  const signature = (answer as { signature?: unknown } | null)?.signature;
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || base58.decode(signature).length !== 64) return unlanded([]);
  // the helper's word: a name to read back, kept by a withdraw's owed send, never told or answered before it reads back
  await h.named?.(signature);
  // the answers that name it: only once each RPC read this very transaction's bytes under it (`seen`), then told as
  // sent once; one read as another transaction, or on one RPC only, is never named
  const txs: TxRef[] = [{ chain: "solana", hash: signature }];
  const seen = [false, false];
  let ours = false;
  let landed = false;
  // each RPC's slot of this very transaction at confirmed, as it said it: the settle waits for its finalized slot. An
  // RPC that names none is held to the other's (one transaction lands in one slot), so its gate is never open
  let txSlots: readonly (number | undefined)[] = [undefined, undefined];
  // a wait of the read-back never runs past the blockhash's life: within it, at most the time left, so a read comes at
  // its end however the pause has grown
  const lifeLeft = (ms: number): number => {
    const left = POOL_BLOCKHASH_LIFE_MS - (clock() - signedAt);
    return left > 0 ? Math.min(ms, left) : ms;
  };
  for (let i = 0; i < reads && !landed && (i === 0 || inTime()); i++) {
    if (i > 0) await waitIn(lifeLeft(pace));
    type Read = Awaited<ReturnType<typeof readBackMeta>>;
    let fault = false;
    const metas: readonly Read[] = await both(h, (rpc) => readBackMeta(rpc, signature, signed)).catch((e: unknown): Read[] => {
      fault = true;
      slow(e);
      return [{ got: "none" }, { got: "none" }];
    });
    if (!fault) pace = POOL_BUY_POLL_MS;
    txSlots = metas.map((m, k) => m.slot ?? metas[1 - k]?.slot);
    const got: readonly Got[] = metas.map((m) => m.got);
    metas.forEach((m, p) => void (seen[p] ||= m.mine === true));
    // another transaction under that name on both RPCs: the helper's signature is not this one's
    if (got[0] === "other" && got[1] === "other") return unlanded([], signature);
    // this very transaction failed on chain, on both RPCs: it spent nothing, and it can never land again; a spend the
    // settle finds is another's, so not_landed at once
    if (got[0] === "failed" && got[1] === "failed") return (await spent()) ? { stage: "not_landed", txs } : { stage: "refused", txs };
    landed = got[0] === "ok" && got[1] === "ok";
    // read back on both RPCs as this very transaction: only now is it told as sent, by its signature; a buy tells it
    // as a route fact too (card pool-buy-send-fast), which reaches the app however late it comes: an answer past the
    // kit client's 10 s is dropped (a mainnet bundle the helper holds until it lands)
    if (!ours && seen[0] && seen[1]) {
      ours = true;
      tellTx(signature);
      await h.sent?.(signature);
    }
    if (landed && fill) {
      // the amount W received, from this very transaction on both RPCs: the two the same and at least the min out the
      // device asked, else not shown
      const outs = metas.map((m) => tokenReceived(m.meta, r.wallet.address, fill.token));
      const [a, b] = outs;
      const out = a && b && a.raw === b.raw && a.decimals === b.decimals && a.raw >= fill.minOut ? unitsOf(a.raw, a.decimals) : null;
      // never an amount past the kit's bound (SIGNPAGE_ROUTE_OUT: 78 digits each side), which a client refuses
      if (out !== null && ROUTE_OUT.test(out)) {
        fill.decimals?.(a!.decimals);
        fill.tell({ out });
      }
    }
  }
  if (!landed) return unlanded(ours ? txs : [], signature);
  // only now: the note SPENT, its change written (solanaSettleSpent reads the spent mark at finalized), then filled
  // only once both RPCs read the spend as this attempt's. The settle lists every mark of the pool, so it is asked only
  // once each RPC's finalized slot reaches the slot it read this transaction at (card pool-buy-filled-2s: run 3 asked
  // it every second for 85 s before), and held to those slots. Until then only the two slots are read, each read once
  // and then the gap waited out: the most slots either RPC is short, at a slot's time each (at least the pace, at most
  // POOL_BUY_BACKOFF_MAX_MS), so a buy reads them a few times, never every slot (on mainnet one seat is the helper's
  // keyed route, whose budget every user shares). Past POOL_BUY_GATE_MAX_MS from the land the settle is asked whatever
  // the slots say, its own reads deciding; a settle that finds no spend is asked again at its doubling wait (hold); a
  // read that goes through puts the pace back to the slot's
  const landedAt = clock();
  let next = pace;
  for (let i = 0; i < reads && (i === 0 || inTime()); i++) {
    if (i > 0) await waitIn(next);
    let fin: number[];
    try {
      fin = (await Promise.all(h.rpcs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])))).map(int);
    } catch (e) {
      slow(e);
      next = pace;
      continue;
    }
    const gap = Math.max(...fin.map((x, k) => (txSlots[k] ?? 0) - x));
    const left = POOL_BUY_GATE_MAX_MS - (clock() - landedAt);
    if (gap > 0 && left > 0) {
      // the round went through whole: the pace again
      pace = POOL_BUY_POLL_MS;
      next = Math.max(pace, Math.min(gap * POOL_BUY_POLL_MS, POOL_BUY_BACKOFF_MAX_MS, left));
      continue;
    }
    const s = await spent([fin[0]!, fin[1]!]);
    if (s === false) hold = backoff(hold, null);
    if (!s) {
      pace = POOL_BUY_POLL_MS;
      next = hold;
      continue;
    }
    const f0 = faults;
    const a = await spentBy(signature, txs);
    if (a) return a;
    // whose spend not known yet: read again at the pace, or, when its reads failed, at the grown pause
    if (faults === f0) pace = POOL_BUY_POLL_MS;
    next = pace;
  }
  return { stage: "sent", txs };
}

type Locks = Pick<LockManager, "request">;

/** The pool.buy kind: one run per tap under the seed's shared lock (sign out waits for it), answered "sent" with its
 *  signature once that reads back on both RPCs as this very transaction (sendAndSettle's sent), or at the run's end
 *  with the run's own answer; the run's final stage is always posted as progress as well. */
export function poolBuyKind(host: () => PoolBuyHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    // true once the run answered "sent" early (its transaction went out): only then is "sent" its end when it ends with
    // no stage of its own
    let early = false;
    // the run's final stage, posted once
    let ended = false;
    const end = (stage: TradeStage): void => {
      if (ended) return;
      ended = true;
      ctx?.progress(stage);
    };
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        const h = host();
        try {
          const a = await runPoolBuy({ ...h, sent: (signature) => {
            if (!answer) (answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } }), (early = true);
            give();
          }, route: (x) => ctx?.route?.(x) }, ask);
          if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
          // the run's stage goes out as progress too, answered early or not: an answer that comes only at the run's end
          // (no read-back within the client's 10 s) is one the kit's client has dropped, and the app waits on progress
          // (api.ts holds a progress event until its id's answer is posted). An error after the early answer "sent" is
          // a transaction that went out with its end not known: "sent", so the app's Filled not yet Final ends too
          // (review of 418af7d5)
          if ("stage" in a) end(a.stage);
          else if (early) end("sent");
        } finally {
          h.end?.();
        }
      })
      .catch(() => {
        // a run that threw past its own catch: its error is the answer, or, after the early answer, "sent"; a run that
        // answered its own error (nothing sent) and then threw (the host's end) posts nothing more
        if (!answer) answer = { error: "failed" };
        else if (early) end("sent");
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
