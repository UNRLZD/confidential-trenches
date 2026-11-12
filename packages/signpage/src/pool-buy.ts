// pool.buy on the Solana pool (card signpage-pool-buy): one tap releases a ready proof's chunk from the pinned pool to
// its fresh wallet W and buys the user's token in the same transaction (tag 3), and the note counts as spent only once
// that transaction reads back on two RPCs.
//
// - The pieces (card buy-spends-several-pieces): the wallet's proof queue binds every ready proof to one W, the own W of
//   its smallest ready note; a tap spends the set of them that holds that note, pays the spend and W's new accounts (the
//   kit's solanaPoolBuyFunds over every piece) and releases the least, then the fewest pieces (pickPieces), at most
//   five: the other pieces' releases (tag 2) to W, each its own transaction, then the own note's tag 3 that buys, sent
//   as one bundle that lands whole or not at all. Every note is taken (RESERVED) before anything leaves, each read back,
//   settled and owned on its own (sendAndSettle). One piece is the plain buy below.
// - The proof: one the wallet's proof queue made ahead (../../wallet/src/pool/queue.ts). Its release is read off the proof itself:
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
//   on both RPCs, UNSPENT once both RPCs' finalized height is past its signed transaction's last height, or their block
//   time past its deadline, with no spent mark, so the queue proves it again).
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
  solanaEncodePoolRelease,
  solanaPoolAccount,
  solanaPoolBuyFunds,
  solanaPoolFee,
  solanaPoolPage,
  solanaPoolPriorityBudget,
  solanaPoolTag2Accounts,
  SOLANA_POOL_BUY_CU,
  SOLANA_POOL_BUY_PIECES_MAX,
  SolanaPoolBuyError,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRent,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { pageReference } from "./page-rpc.ts";
import { solanaDecodeLookupTable, type SolanaLookupTable } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_COMPUTE_BUDGET_PROGRAM, SOLANA_CU_PRICE_MAX, SOLANA_POOL_JITO_TIP } from "../../kit/src/checks/solana/checks.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import type { BuyRoute, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_ROUTE_OUT } from "../../kit/src/signpage/schema.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { throttleWaitMs, type ThrottleBounds } from "../../wallet/src/throttle.ts";
import type { ChainNow, ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkSolanaBuy, PoolRuleRefused, signSolana, type PoolAsk, type SolanaBuyPiece } from "./rules/pool.ts";
import { spendOwner, type HistoryPlaces, type SpendOwner } from "./pool-spend.ts";
import { clockOf, keptReads, readsWaited, readWaits, solanaStableReads, tapDone, tapWaits, waitsOn, type ReadWaits } from "./read-waits.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** The page's own copy of the kit's route bound: a frozen RegExp's matcher can still be swapped
 *  (RegExp.prototype.compile), so the page never tests against the shared one (card kit-oneclick-pins-frozen review). */
const ROUTE_OUT = new RegExp(SIGNPAGE_ROUTE_OUT.source, SIGNPAGE_ROUTE_OUT.flags);

/** What a buy run needs from the page. */
/** W's buy mint by W's address (card sol-w-sweep, delta review 7 of 08290868): each W is one buy's, and the buy writes
 *  the mint it buys (and its token program) before its send, so the rent back after a later sell knows which of W's
 *  tokens is W's own coin. A buy whose send fails leaves the record; it can only make the rent back hold. */
/** W's buy record. `rebuilt` is set only by a restore's rebuild from W's history (sol-buy-records.ts), never by a buy
 *  here: put writes mint and program alone, so this device's next buy from W replaces the mark. */
export type BuyMints = { get(address: string): Promise<{ mint: string; program: string; rebuilt?: true } | undefined>; put(address: string, m: { mint: string; program: string }): Promise<void> };

/**
 * A buy of several pieces owed its end (card buy-spends-several-pieces), written before anything of it leaves: W (its
 * l and j: W again from the seed), the note whose tag 3 buys (`primary`, W's own), the notes whose tag 2s pay W
 * (`pieces`), the last block height its signed transactions can land at, and the coin it buys. When a piece of it is
 * spent and the buy can no longer land, what the pieces paid W goes back into the pool (resumePieces).
 */
export type OwedPieces = { address: string; l: string; j: number; primary: string; pieces: string[]; lastHeight: string; mint: string; program: string };
export type PiecesOwed = { list(): Promise<OwedPieces[]>; put(r: OwedPieces): Promise<void>; drop(address: string): Promise<void> };

export type PoolBuyHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Where the buy writes W's buy mint before its send (BuyMints); a write that fails sends nothing. */
  bought?: BuyMints;
  /** Where a buy of several pieces writes its owed record (OwedPieces) before its take; a write that fails sends
   *  nothing. Absent: a buy spends one piece. */
  piecesOwed?: PiecesOwed;
  /** The pin's lookup tables per venue, generations oldest first (wallet SOL_POOL_TABLES: the addresses a tag 3 on that
   *  venue may load its accounts from); none pinned, or a pin that is not a list of addresses: refused not_allowed; the
   *  buy's venue with none: refused venue_not_pinned before the pick. */
  tables: Readonly<Partial<Record<SolanaPoolBuyVenue["kind"], readonly string[]>>>;
  cluster: "mainnet" | "devnet";
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The queue's ready proofs (never taken by reading them); the queue is opened first when it is not. */
  ready(): Promise<readonly ReadyProof<SolanaReleaseRequest>[]>;
  /** The queue's take of this attempt: HELD -> RESERVED, written before it returns, with the signed transaction's last
   *  block height (blockhashOf's lastHeight); refused, the note HELD, when the note's ready proof is another attempt. */
  take(noteId: string, attempt: string, early?: Promise<ChainNow>, lastHeight?: bigint): Promise<ReadyProof<SolanaReleaseRequest>>;
  /** The queue's take of a buy's several pieces at once (queue.ts takeSet): all RESERVED, or refused with none written.
   *  Absent: a buy spends one piece. */
  takeSet?(items: readonly { noteId: string; attempt: string }[], early?: Promise<ChainNow>, lastHeight?: bigint): Promise<readonly ReadyProof<SolanaReleaseRequest>[]>;
  /** The pool's time read now, for the take (the wallet's chainNow on the queue's pool; card sol-buy-reads-side-by-side):
   *  a buy starts it with its first round, so the take, which uses it within NOW_REUSE_MS of its start, waits on no read
   *  of its own between the signature and the send. */
  chainNow?(): Promise<ChainNow>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  /** POST /v1/pool/solana/send: the helper's answer as it came (hostile). */
  send(pool: string, tx: Uint8Array): Promise<unknown>;
  /** A buy's pieces (card buy-spends-several-pieces): the helper's send of these transactions as one bundle, in order,
   *  all landing or none; its answer as it came (hostile), each one's signature in order. Absent: a buy spends one
   *  piece. */
  sendPieces?(pool: string, txs: readonly Uint8Array[]): Promise<unknown>;
  /** The wallet's solanaSettleSpent for this note: "spent" once its change is written and the note is SPENT. minSlots:
   *  each RPC's reads at or past it (the not_landed verdict's, pastAt's slots). A throw is no answer, never "unspent". */
  settle(noteId: string, minSlots?: readonly [number, number]): Promise<{ kind: "spent" | "unspent" }>;
  /** Several notes settled on one read of the pool's marks (the wallet's solanaSettleSpentSet; card
   *  buy-spends-several-pieces): each note's verdict in order, a note's own refusal `{ error }`; a read that fails
   *  throws. A host without it settles each note with `settle`. */
  settleSet?(noteIds: readonly string[], minSlots?: readonly [number, number]): Promise<({ kind: "spent" | "unspent" } | { error: unknown })[]>;
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
  /** This very transaction landed: both RPCs read it back as succeeded, the amount out told when it reads the same. Once,
   *  after sent; never for one that did not land. The reads from here to Final are the host's to pace (card
   *  sell-right-after-a-buy: a background pass's), every read before it a trade's, the ones that tell Filled among them.
   *  Names the note, its attempt and the value the release withdrew, so the balance counts only the note's change from
   *  here to the settle (../../wallet/src/pool/balances.ts landed). */
  landed?(noteId: string, attempt: string, withdrawn: bigint): void;
  /** The buy's route as the run binds and reads it (messages.ts BuyRoute): W and the venue with its pool once the check
   *  passed and W derived to the proof's recipient, then the amount W received once the transaction read back on both
   *  RPCs as the same. Each once, in that order; a throw here never stops the buy. */
  route?(r: BuyRoute): void;
  /** W's address, the decimals of the token it received, read with that amount on both RPCs, and the token's mint:
   *  told just before the route's amount, for the device's buy record (src/positions.ts) and the page's kept decimals
   *  (pool-kinds.ts PAGE_TOKEN_DECIMALS); a throw here never stops the buy. */
  outDecimals?(wallet: string, decimals: number, mint: string): void;
  /** The notes a run on this page has picked and not finished: a second tap picks another ready proof. */
  claimed?: Set<string>;
  /** Tests only: the venue's fee recipient and the Jito tip account, else random. */
  pick?: (n: number) => number;
  /** The session's sign out: it ends a wait before the buy's next attempt, and the buy never starts again after it. */
  signal?: AbortSignal;
};

export type PoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "venue_not_pinned" | "no_table_fits" | "venue_not_built" | "failed" | "down" };

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
/** The helper's refusal of a send before it sent anything (any 4xx but its 429: a shape, a wallet, a fee, a blockhash or
 *  a simulation it refused, or a route an older helper does not have, 404): the run ends at once, "failed", its notes
 *  RESERVED until the state reads free them (nothing is freed on the helper's word). */
export class PoolSendRefused extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`pool send: refused (${status} ${code})`);
    this.status = status;
    this.code = code;
  }
}
/** A buy of several pieces whose tag 2s read landed and whose tag 3 reads on neither RPC: its signed bytes are sent
 *  again this long after the pieces read landed, and as long again after each, at most POOL_BUY_RESEND_MAX times
 *  [design: past a devnet carry's own tag 3 send after its pieces (about a second), well inside a blockhash's life]. */
export const POOL_BUY_RESEND_MS = 5_000;
export const POOL_BUY_RESEND_MAX = 3;
/** The wait between two sends of one transaction: the helper's Retry-After, at least 1 s, at most 5 s. */
export const POOL_SEND_BUSY_WAIT_MS = { min: 1_000, max: 5_000 } as const;
/** The most sends of one transaction: past a blockhash's life at the shortest wait, so the height decides first. */
export const POOL_SEND_TRIES_MAX = 120;
/** A blockhash's life on the wall clock, from the signature: 151 blocks (~60 s at 400 ms) with room for slower slots.
 *  Past it, a busy send is not made again, whatever an RPC that is down or stuck reads. */
export const POOL_BLOCKHASH_LIFE_MS = 90_000;
/** The read-back's bound on the wall clock, from the signature: the blockhash's life and a finalization (~32 slots).
 *  Past it no round of reads is begun and the answer is "sent" (the note RESERVED, settled by the state reads). It is
 *  checked between rounds, not inside one: from the land on the run's reads are a background pass's (card
 *  sell-right-after-a-buy, pool-testnet.ts buyReads), whose turn waits for its host's room or floor with no deadline of
 *  its own, so a round begun inside it can end past it, and Final with it (the review of 29a9e506: 40 s with trades
 *  holding the hosts and no other pass reader, 155 s with one, 205 s with two, each "filled"). A sign out ends every
 *  such wait at once (throttle.ts stopHostLaneWaits), so it never holds the seed's lock, nor sign out. */
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

/** The leaf index whose root is `root` in `tree`, read on both RPCs from the newest page back: both must give it, at an
 *  index below `size` (the tree's size both RPCs' pool account agreed on, treeSizes): a root a page holds past it is one
 *  only a later read could agree on, so it is never named (card fresh-money-spendable-at-once: a newest root is named
 *  only once both providers hold it). */
export async function rootIndex(h: Pick<PoolBuyHost, "rpcs" | "pin">, tree: 0 | 1, size: number, root: bigint): Promise<number> {
  const want = be32(root);
  for (let page = Math.floor((size - 1) / PAGE_ENTRIES); page >= 0; page--) {
    const found = (await both(h, (r) => account(r, solanaPoolPage(h.pin.program, tree, page * PAGE_ENTRIES)))).map((a) => {
      if (a === null) return no();
      if (a.owner !== h.pin.program || a.data.length < PAGE_HEADER || (a.data.length - PAGE_HEADER) % PAGE_ENTRY !== 0) return no();
      const n = Math.min((a.data.length - PAGE_HEADER) / PAGE_ENTRY, size - page * PAGE_ENTRIES);
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
  return blockhashValid(rpcs, await blockhashRead(rpcs));
}

/** blockhashOf's first read: the blockhash on RPC 0, its lastValidBlockHeight and its slot. A sell builds on it while
 *  blockhashValid runs, and signs only once that check passed (card pool-sell-legs-side-by-side). */
export async function blockhashRead(rpcs: readonly [SolanaRpc, SolanaRpc]): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number }> {
  const r = (await rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { context?: { slot?: unknown }; value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } };
  const blockhash = r?.value?.blockhash;
  if (typeof blockhash !== "string") return no();
  return { blockhash, lastValidBlockHeight: int(r.value!.lastValidBlockHeight), slot: int(r.context?.slot) };
}

/** blockhashOf's check: RPC 0's blockhash valid on RPC 1, and the last height from RPC 1's height at a slot at or past
 *  the one RPC 1 judged the blockhash valid at: RPC 1 has then seen the blockhash's block, so its height is at least
 *  that block's and the last height is never under the true one, whatever RPC 0 said (a last height too low would free
 *  the note while its transaction can still land: card pool-buy-record-never-stays-sent). The height and its slot come
 *  in one read beside the check (getEpochInfo). A bank k slots behind the check's slot (k at most BLOCKHASH_LIFE) is
 *  taken as its height + k: a slot adds at most one block, so that is never under the height at the check's slot, and
 *  only holds a note RESERVED a little longer. A bank further behind, or an answer with no whole height and slot, is
 *  read again at the check's slot (minContextSlot). */
export async function blockhashValid(rpcs: readonly [SolanaRpc, SolanaRpc], r: { blockhash: string; lastValidBlockHeight: number; slot: number }): Promise<{ blockhash: string; lastValidBlockHeight: number; slot: number; lastHeight: number }> {
  const [ok, info] = await Promise.all([
    rpcs[1]("isBlockhashValid", [r.blockhash, { commitment: "confirmed" }]) as Promise<{ context?: { slot?: unknown }; value?: unknown }>,
    rpcs[1]("getEpochInfo", [{ commitment: "confirmed" }]) as Promise<{ blockHeight?: unknown; absoluteSlot?: unknown }>,
  ]);
  if (ok?.value !== true) return no();
  const seen = int(ok.context?.slot);
  if (seen === 0) return no();
  const at = info?.absoluteSlot, bh = info?.blockHeight;
  const whole = Number.isSafeInteger(at) && Number.isSafeInteger(bh) && (at as number) >= 0 && (bh as number) >= 0;
  const behind = whole ? Math.max(0, seen - (at as number)) : Infinity;
  const height = behind <= BLOCKHASH_LIFE ? (bh as number) + behind : await rpcs[1]("getBlockHeight", [{ commitment: "confirmed", minContextSlot: seen }]);
  const said = r.lastValidBlockHeight;
  const cap = int(height) + BLOCKHASH_LIFE;
  return { blockhash: r.blockhash, lastValidBlockHeight: said, slot: r.slot, lastHeight: said > cap ? said : cap };
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

/** The most ready proofs of one W a pick weighs: the largest chunks, the own one always among them. */
const PICK_SIZE = 12;
/** A buy's tag 2 pieces' compute limit: the withdraw's (pool-withdraw.ts POOL_WITHDRAW_CU), one release each. */
export const POOL_RELEASE_CU = 400_000;

/**
 * The pieces a buy spends (card buy-spends-several-pieces): ready proofs bound to one W, one of them that W's own
 * note's (ReadyProof.own: W is found again from that spent note, buy-wallets.ts), at most `max`, that `pays` passes;
 * the set that releases the least in all, then the fewest pieces, then the fewest on the newest root (card
 * fresh-money-spendable-at-once). In send order: the other pieces largest first, the own one last (the tag 3 that
 * buys, so a buy that lands always spends W's own note). null: no set pays.
 */
export type PickPiece = { readonly wallet: { readonly address: string }; readonly own?: true; readonly chunk: bigint; readonly root?: string };
export function pickPieces<P extends PickPiece>(list: readonly P[], pays: (set: readonly P[]) => boolean, max: number = SOLANA_POOL_BUY_PIECES_MAX): P[] | null {
  const byW = new Map<string, P[]>();
  // the smallest chunk first and, of one chunk, a proof on the epoch root before one on the newest root: of two sets
  // alike in every weight the first found wins, and the cut below keeps the epoch root's of one chunk
  const sorted = [...list].sort((x, y) => (x.chunk < y.chunk ? -1 : x.chunk > y.chunk ? 1 : x.root === y.root ? 0 : x.root === "epoch" ? -1 : 1));
  for (const p of sorted) byW.set(p.wallet.address, [...(byW.get(p.wallet.address) ?? []), p]);
  let best: { set: P[]; sum: bigint; newest: number } | null = null;
  const weigh = (set: P[]): void => {
    const sum = set.reduce((a, p) => a + p.chunk, 0n);
    const newest = set.filter((p) => p.root === "newest").length;
    const better = best === null || sum < best.sum || (sum === best.sum && (set.length < best.set.length || (set.length === best.set.length && newest < best.newest)));
    if (better && pays(set)) best = { set, sum, newest };
  };
  // one W has one own note; a list that names several (one proof per note, each its own W's) weighs each as the own one
  for (const group of byW.values())
    for (const own of group.filter((p) => p.own === true)) {
      const rest = group.filter((p) => p !== own).sort((x, y) => (x.chunk > y.chunk ? -1 : x.chunk < y.chunk ? 1 : 0)).slice(0, PICK_SIZE - 1);
      for (let mask = 0; mask < 1 << rest.length; mask++) {
        const others = rest.filter((_, i) => (mask >> i) & 1);
        if (others.length < max) weigh([...others, own]);
      }
    }
  return (best as { set: P[] } | null)?.set ?? null;
}

/** One piece's tag 2 (card buy-spends-several-pieces): the compute limit and the release to W, its change note at
 *  `stateSize`, the fee payer and W signing; two zeroed signature slots, then the message. The same transaction a
 *  withdraw's release is (pool-withdraw.ts), checked by the same rule (rules/pool.ts checkSolanaBuy's pieces). */
export function solanaPieceWire(cfg: { program: string; pool: string }, wallet: string, feePayer: string, release: SolanaPoolRelease, stateSize: number, blockhash: string): Uint8Array {
  const ixs = [
    { program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.of(2, POOL_RELEASE_CU & 255, (POOL_RELEASE_CU >>> 8) & 255, (POOL_RELEASE_CU >>> 16) & 255, (POOL_RELEASE_CU >>> 24) & 255) },
    { program: cfg.program, accounts: solanaPoolTag2Accounts(cfg, wallet, feePayer, release, stateSize), data: solanaEncodePoolRelease(release) },
  ];
  const { message } = solanaCompileV0(feePayer, ixs, blockhash, [], [feePayer, wallet]);
  const wire = new Uint8Array(1 + 128 + message.length);
  wire[0] = 2;
  wire.set(message, 129);
  return wire;
}

/**
 * The buys of several pieces owed their end (card buy-spends-several-pieces), on each Solana state read, with no tap:
 * each record's notes as the state reads left them. Any still RESERVED: its end is not known yet (the settle reads it
 * on). The buy's own note SPENT: it landed, W holds its coin, the record goes. Else the buy can no longer land (its
 * note freed: both RPCs read its blockhash past with no spent mark): a piece SPENT means its release paid W, and what
 * W holds goes back into the pool (`strand`: the rent back's sweep, W's own owed record), then the record goes; no
 * piece spent, nothing reached W, the record goes. A note that cannot be read keeps the record for the next read, and
 * so does a strand that fails. The number stranded.
 */
export async function resumePieces(o: { owed: PiecesOwed; state(noteId: string): Promise<string | undefined>; strand(r: OwedPieces): Promise<void> }): Promise<number> {
  let stranded = 0;
  for (const r of await o.owed.list()) {
    let states: (string | undefined)[];
    try {
      states = await Promise.all([r.primary, ...r.pieces].map((id) => o.state(id)));
    } catch {
      continue;
    }
    const [own, ...pieces] = states;
    if (own === "RESERVED" || pieces.includes("RESERVED")) continue;
    try {
      if (own !== "SPENT" && pieces.includes("SPENT")) {
        await o.strand(r);
        stranded++;
      }
      await o.owed.drop(r.address);
    } catch {
      // kept: the next state read tries again
    }
  }
  return stranded;
}

/** One pool.buy: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). A provider read that still fails
 *  past the page's own retry before W signs makes the buy again from its first read after a wait on the page's one rule
 *  (read-waits.ts readWaits: from 1 s, doubling, at most 10 s, until READ_WAIT_TOTAL_MS), then "down" (card
 *  start-reads-wait-out-a-throttle): each attempt reads its reference, venue, sizes and blockhash again, so nothing it
 *  signs rests on a read from before a wait; the Rent sysvar is kept per provider across the attempts (keptReads). A
 *  sign out ends the wait, and the buy answers failed, nothing taken or signed. */
export async function runPoolBuy(host: PoolBuyHost, ask: PoolAsk, waits: ReadWaits = readWaits(clockOf(host))): Promise<PoolBuyAnswer> {
  const h: PoolBuyHost = Object.assign(Object.create(host) as PoolBuyHost, { rpcs: keptReads(host.rpcs, solanaStableReads(null)) });
  return readsWaited((at) => buyRun(h, ask, at), h.wait, h.signal, waits);
}

async function buyRun(h: PoolBuyHost, ask: PoolAsk, at: { fault?: unknown }): Promise<PoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let claim: string[] | null = null;
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
    // on mainnet the helper sends the tag 3 to Jito bundle-only, so it tips enough to win the auction (the kit's
    // SOLANA_POOL_JITO_TIP); devnet has no block engine, so no tip
    const tip = h.cluster === "mainnet" ? SOLANA_POOL_JITO_TIP : 0n;
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
      // reads): the pieces of one W, its own note's among them, that pay the spend and W's accounts and release the
      // least in all (pickPieces; card buy-spends-several-pieces), so a tap never parks more on its W than it needs;
      // one piece when the host takes one only; filtered and claimed in one turn, so two runs of this page never
      // claim one note
      const pays = (set: readonly Ready[]): boolean =>
        solanaPoolBuyFunds(set.map((p) => ({ withdrawnValue: p.chunk, relayFee: p.binding.request.relayFee })), venue, { spend: ask.amount, tip }, rent).problem === null;
      const max = h.takeSet && h.sendPieces ? SOLANA_POOL_BUY_PIECES_MAX : 1;
      const now = mine(await h.ready());
      const picked = pickPieces(now, pays, max);
      if (picked === null) return no("not_funded");
      let set = picked;
      // a piece on a root not looked up yet (remade during the reads): read once more; past that, the best set whose
      // roots are all found, or refused (a proof for another root is refused before anything is signed)
      if (set.some((p) => indexOf(p) === null)) {
        if (round === 0 && set.some((p) => !roots.has(rootKey(0, p.publicSignals[3])) || !roots.has(rootKey(1, p.publicSignals[5])))) continue;
        const found = pickPieces(now.filter((p) => indexOf(p) !== null), pays, max);
        if (found === null) return no();
        set = found;
      }
      const r = set[set.length - 1]!;
      const k = set.length;
      // every piece to the one W its own note's proof is bound to, each at the state index it lands at: the pool's size
      // read, one more for each release before it; the tag 3 last
      const releases = set.map((p) => releaseOf(p, h.pin, r.wallet.address, indexOf(p)!));
      const release = releases[k - 1]!;
      // the most the relay fee's priority budget pays, never over the kit's CU price cap
      const budget = (solanaPoolPriorityBudget(rent, release.relayFee) * 1_000_000n) / BigInt(SOLANA_POOL_BUY_CU[venue.kind]);
      const cuPrice = budget < SOLANA_CU_PRICE_MAX ? budget : SOLANA_CU_PRICE_MAX;
      const req: SolanaPoolBuyRequest = {
        wallet: r.wallet.address, feePayer: h.pin.feePayer, token, spend: ask.amount, minOut, tip, cuPrice, cluster: h.cluster,
        ...(k > 1 ? { before: releases.slice(0, -1).map((x) => ({ withdrawnValue: x.withdrawnValue, relayFee: x.relayFee })) } : {}),
      };
      const cfg = { program: h.pin.program, pool };
      // built on the venue's generation that makes the smallest transaction, before the claim and the seed: a buy that
      // fits none is refused by name (synchronous, so the claim below is still this turn's)
      let built: ReturnType<typeof buildSolanaPoolBuyOnTables>;
      try {
        built = buildSolanaPoolBuyOnTables(cfg, release, venue, req, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, stateSize: sizes.stateSize + k - 1, rent }, own.map((t) => ({ address: t.address, table: t.table })), h.pick ? { pick: h.pick } : {});
      } catch (e) {
        if (/^no_table_fits\b/.test(String((e as Error)?.message))) return no("no_table_fits");
        // none of the venue's pinned tables is made for it (a table pinned under the wrong venue): no table for it here
        if (e instanceof SolanaPoolBuyError && e.code === "venue_not_in_table") return no("venue_not_pinned");
        throw e;
      }
      const pieces: SolanaBuyPiece[] = releases.slice(0, -1).map((x, i) => ({ wire: solanaPieceWire(cfg, r.wallet.address, h.pin.feePayer, x, sizes.stateSize + i, bh.blockhash), release: x }));
      const used = own.find((t) => t.address === built.table.address)!;
      claim = set.map((p) => p.noteId);
      for (const id of claim) h.claimed?.add(id);
      // the device's own fee cap: the epoch fee from the Rent sysvar it read, never the binding's word
      const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: r.wallet.address, feeCap, solana: h.pin };
      checkSolanaBuy(built.wire, ask, ctx, release, venue, req, { blockhash: bh.blockhash, slot: bh.slot, tables: used.reads, stateSize: sizes.stateSize + k - 1, rent, reference: { amount: ask.amount, ref, slippageBps: ask.slippageBps } }, pieces);
      // W, from the seed, right before it signs: it must be the proof's recipient the bytes were built and checked for
      signing = true;
      seed = await h.seed64();
      const w = freshWallet(seed, "sol", r.wallet.l, r.wallet.j);
      key = w.secretKey;
      seed.fill(0);
      if (w.address !== r.wallet.address) return no();
      // W signs every piece and the buy; each checked above (signSolana signs nothing a check did not pass)
      const signedOf = (wire: Uint8Array): Uint8Array => {
        const out = wire.slice();
        out.set(signSolana(key!, wire), 1 + 64);
        return out;
      };
      const signed = signedOf(built.wire);
      const before = pieces.map((p, i) => ({ r: set[i]!, release: p.release, signed: signedOf(p.wire) }));
      key.fill(0);
      key = null;
      // the route as bound, told once the take holds the note (sendAndSettle): W, then the venue the check passed and its
      // pool (the curve's account or the AMM pool's)
      const bound: readonly BuyRoute[] = [{ wallet: w.address }, { venue: venue.kind, pool: venue.kind === "pump-curve" ? venue.curve : venue.pool }];
      // W's buy mint, written before the send (delta review 7 of 08290868): the rent back holds while W holds any of it
      await h.bought?.put(w.address, { mint: venue.mint, program: venue.tokenProgram });
      // a buy of several pieces: its owed record before the take, so a page that closes from here on leaves W found
      // (resumePieces); none written, nothing taken or sent
      if (before.length > 0) {
        if (!h.piecesOwed) return no();
        await h.piecesOwed.put({ address: w.address, l: r.wallet.l.toString(), j: r.wallet.j, primary: r.noteId, pieces: before.map((b) => b.r.noteId), lastHeight: String(bh.lastHeight), mint: venue.mint, program: venue.tokenProgram });
      }
      const decimals = (d: number): void => {
        // a record's decimals never stop a buy: a listener that throws, or rejects
        try {
          void Promise.resolve(h.outDecimals?.(w.address, d, token)).catch(() => {});
        } catch {
          /* thrown */
        }
      };
      return await sendAndSettle(h, r, release, pool, signed, bh.lastHeight, wait, { token, minOut, tell, bound, decimals, early }, before);
    }
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    // both RPCs read a coin this build does not trade (a curve quoted in another mint): refused by name at the venue's read,
    // before the claim, so the app shows it as one the pool cannot buy, never a Retry that cannot work
    if (e instanceof SolanaPoolBuyError && e.code === "venue_not_built") return { error: "venue_not_built" };
    // a provider read that still fails after the page's own retry, before W signs: "not now" (card pool-read-down),
    // after the rule's waits (runPoolBuy)
    if (!signing && waitsOn(e)) {
      at.fault = e;
      return { error: "down" };
    }
    return { error: "failed" };
  } finally {
    seed?.fill(0);
    key?.fill(0);
    for (const id of claim ?? []) h.claimed?.delete(id);
  }
}

/** The take, the send, the read-back on both RPCs, the settle and whose spend it is; every answer but filled tries the
 *  settle first, and filled is only this attempt's own spend.
 *  fill: the buy's route, told as the run goes (W and the venue with its pool once the take holds the note, the amount
 *  out once the transaction reads back); none for a pool withdraw, whose release tells no buy route. */
export async function sendAndSettle(
  h: Pick<PoolBuyHost, "rpcs" | "take" | "takeSet" | "send" | "sendPieces" | "settle" | "settleSet" | "now" | "reads" | "named" | "sent" | "landed">, r: Ready, release: SolanaPoolRelease, pool: string, signed: Uint8Array, lastHeight: number, wait: (ms: number) => Promise<void>,
  fill?: { token: string; minOut: bigint; tell: (x: BuyRoute) => void; bound: readonly BuyRoute[]; decimals?: (d: number) => void; early?: Promise<ChainNow> },
  before: readonly { r: Ready; release: SolanaPoolRelease; signed: Uint8Array }[] = [],
): Promise<PoolBuyAnswer> {
  // every part of the send, in its order (card buy-spends-several-pieces): the bundle's tag 2 pieces, then this one; one
  // part is a plain send. A bundle lands whole or not at all on Jito, yet the helper holds every signed part, so each
  // part is read back, settled and owned on its own and the answer is filled only when every one is this run's
  const parts = [...before, { r, release, signed }];
  // the take, awaited before anything leaves: the queue hands out these very attempts, or refuses with every note
  // HELD (a set: takeSet, all or none); a buy's early read of the pool's time is its time when still fresh
  // with the signed transactions' last height: once both RPCs' finalized height is past it with no spent mark, the
  // state reads free each note at once (solana-restore.ts solanaSettleReserved), not at the proof's deadline
  const taken = parts.length === 1 ? [await h.take(r.noteId, r.attempt, fill?.early, BigInt(lastHeight))] : h.takeSet && h.sendPieces ? await h.takeSet(parts.map((x) => ({ noteId: x.r.noteId, attempt: x.r.attempt })), fill?.early, BigInt(lastHeight)) : no();
  if (taken.length !== parts.length || taken.some((t, i) => t.attempt !== parts[i]!.r.attempt || !sameBytes(solanaProofBytes(t.proof), parts[i]!.release.proof))) return no();
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
  // the notes this run settles (card buy-spends-several-pieces): one part's, the host's settle; several parts', each
  // part's note in send order (`left`, the ones not found spent yet: each asked until it is, then never again), spent
  // once every one is, a throw when one threw (not known yet), else unspent
  const left = parts.map((p) => p.r.noteId);
  const noteSet = {
    settle: async (id: string, minSlots?: readonly [number, number]): Promise<{ kind: "spent" | "unspent" }> => {
      if (parts.length === 1) return h.settle(id, minSlots);
      // one read of the marks a round for every note left (settleSet), not one a note
      const ids = [...left];
      const got = h.settleSet ? await h.settleSet(ids, minSlots) : await Promise.all(ids.map((n) => h.settle(n, minSlots).catch((error: unknown) => ({ error }))));
      if (got.length !== ids.length) throw new Error("settle: not one verdict a note");
      const thrown = got.find((g): g is { error: unknown } => "error" in g);
      ids.forEach((n, k) => {
        const g = got[k]!;
        if (!("error" in g) && g.kind === "spent") left.splice(left.indexOf(n), 1);
      });
      if (left.length === 0) return { kind: "spent" };
      if (thrown !== undefined) throw thrown.error;
      return { kind: "unspent" };
    },
  };
  let pace = POOL_BUY_POLL_MS;
  let faults = 0;
  const slow = (e: unknown): void => void (faults++, (pace = backoff(pace, e)));
  // the settle (solanaSettleSpent: the note SPENT, its change written), asked until it finds the spend, then never again.
  // A settle that throws (a lister that refuses, a 429 past the retry, a stop) is not known yet (null), never "unspent"
  let settled = false;
  // the settle's own wait (card pool-buy-filled-2s): it lists every mark of the pool, so after one that threw (still no
  // answer) or, past the finality gate, found no spend, the next waits twice as long, from the slot's time to the cap
  let hold = POOL_BUY_POLL_MS;
  const settler = { settle: (id: string, minSlots?: readonly [number, number]) => noteSet.settle(id, minSlots).catch((e: unknown) => ((hold = backoff(hold, e)), Promise.reject(e))) };
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
  // whose spend every part's note is: "other" when any one is another's, null until each is read, else this
  // attempt's, named by the last part's (the buy's) own signature; `hints` the helper's signatures, by part
  const owner = async (hints: readonly (string | undefined)[]): Promise<SpendOwner> => {
    try {
      const slots = await Promise.all(h.rpcs.map((rpc) => rpc("getSlot", [{ commitment: "finalized" }])));
      let mine: SpendOwner = null;
      for (const [i, p] of parts.entries()) {
        const o = await spendOwner(h.rpcs, pin, p.r.wallet.address, beInt(p.release.existingNullifierHash), p.r.binding.context.toString(), Math.max(...slots.map(int)), hints[i], places);
        if (o === "other") return "other";
        if (o === null) return null;
        mine = o;
      }
      return mine;
    } catch (e) {
      slow(e);
      return null;
    }
  };
  // a spend the settle found: filled only when it is this attempt's, named by that spend's own signature (never the
  // helper's word); another's can never be this transaction's (not_landed); not known yet: null, the reads go on
  const spentBy = async (hints: readonly (string | undefined)[], txs: TxRef[]): Promise<PoolBuyAnswer | null> => {
    const o = await owner(hints);
    if (o === "other") return { stage: "not_landed", txs };
    if (o === null) return null;
    tellTx(o.mine);
    // the buy's own spend first, then the pieces' (the helper's names, each read back as this very transaction)
    return { stage: "filled", txs: [{ chain: "solana", hash: o.mine }, ...txs.slice(1)] };
  };
  // the chain's word on the note (its spent mark and change on both RPCs, then whose spend it is) over the helper's or
  // one RPC's: this attempt's spend is filled, named by the signature both RPCs read it under. not_landed once
  // another's spend is read, or once both RPCs' finalized height is past the blockhash's last one and the settle, read at
  // or past each RPC's slot of that read, returns no spend (a settle that throws decides nothing; the kit's rule: never
  // not_landed while the transaction may still land,
  // packages/kit/src/trade/solana/flow.ts finishSolanaSet); until then the reads go on, and past them the answer is
  // "sent", the note RESERVED (or SPENT with its change, whose spend not read yet) for the state reads' pass. `txs`
  // names the helper's signature only once both RPCs read this very transaction under it.
  const unlanded = async (txs: TxRef[], hints: readonly (string | undefined)[] = []): Promise<PoolBuyAnswer> => {
    for (let i = 0; i < reads && (i === 0 || inTime()); i++) {
      if (i > 0) await waitIn(Math.max(POOL_BUY_WAIT_MS, pace, hold));
      const f0 = faults;
      const past = await pastAt(h.rpcs, lastHeight, slow); // before the settle: a spend final by then is in its read
      const s = await spent(past ?? undefined);
      if (s) {
        const a = await spentBy(hints, txs);
        if (a) return a;
      } else if (s === false && past !== null) return { stage: "not_landed", txs };
      if (faults === f0) pace = POOL_BUY_POLL_MS;
    }
    return { stage: "sent", txs };
  };
  let answer: unknown;
  for (let tries = 1; ; tries++) {
    try {
      answer = parts.length === 1 ? await h.send(pool, signed) : await h.sendPieces!(pool, parts.map((p) => p.signed));
      break;
    } catch (e) {
      // the helper refused before it sent (a 4xx but 429): the run ends now, "failed"; its notes stay RESERVED until
      // both RPCs read the blockhash past (the state reads), so a helper that refused and sent anyway frees nothing
      if (e instanceof PoolSendRefused) return { error: "failed" };
      // the helper's error says nothing of the chain: a broken-in helper may answer 502 and send it anyway
      if (!(e instanceof PoolSendBusy) || tries >= POOL_SEND_TRIES_MAX) return unlanded([]);
      // busy: the same bytes again after its wait, while the blockhash lives: never once either RPC reads it past, nor
      // past its life on the wall clock (an RPC down or stuck reads nothing); then the read-back rules decide
      // (not_landed only once both RPCs read it past and the settle finds no spend)
      if (clock() - signedAt >= POOL_BLOCKHASH_LIFE_MS || (await pastOnEither(h.rpcs, lastHeight))) return unlanded([]);
      await wait(Math.min(Math.max(e.retryAfterMs, POOL_SEND_BUSY_WAIT_MS.min), POOL_SEND_BUSY_WAIT_MS.max));
    }
  }
  // the helper's names, one per part in order (a bundle's `signatures`, one send's `signature`): each a signature,
  // else nothing it said is read
  const named = parts.length === 1 ? [(answer as { signature?: unknown } | null)?.signature] : (answer as { signatures?: unknown } | null)?.signatures;
  const isSig = (x: unknown): x is string => typeof x === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(x) && base58.decode(x).length === 64;
  const sigs = Array.isArray(named) && named.length === parts.length && named.every(isSig) && new Set(named).size === named.length ? (named as string[]) : null;
  // the buy's own (the last part's): the one the hook below names, checked as the one-piece answer always was
  const signature = sigs?.[sigs.length - 1];
  if (sigs === null || typeof signature !== "string" || base58.decode(signature).length !== 64) return unlanded([]);
  // the helper's word: a name to read back, kept by a withdraw's owed send, never told or answered before it reads back
  await h.named?.(signature);
  // the answers that name them: only once each RPC read every part's very bytes under its name (`seen`), then told
  // as sent once, by the buy's own; one read as another transaction, or on one RPC only, is never named
  const txs: TxRef[] = [signature, ...sigs.slice(0, -1)].map((hash) => ({ chain: "solana", hash }));
  // each part's slot per RPC (read as that part's very bytes under its name), and `seen`, each RPC's once it has read
  // every part so: the one pair the sent guard reads
  const seenPart = parts.map(() => [false, false]);
  const seen = [false, false];
  // the re-sends of the buy's own transaction, and when every piece first read landed (card buy-spends-several-pieces)
  let resends = 0;
  let piecesAt: number | undefined;
  let ours = false;
  let landed = false;
  // each RPC's slot of the buy's transaction at confirmed, as it said it: the settle waits for its finalized slot. An
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
    // each RPC's read of every part (its `each`, in send order), the buy's own read its own fields; a read that fails,
    // any part's, fails the round: each part read none
    type Read = Awaited<ReturnType<typeof readBackMeta>> & { each?: readonly Awaited<ReturnType<typeof readBackMeta>>[] };
    let fault = false;
    const metas: readonly Read[] = await both(h, (rpc) => Promise.all(parts.map((p, k) => readBackMeta(rpc, sigs[k]!, p.signed))).then((each): Read => ({ ...each[each.length - 1]!, each }))).catch((e: unknown): Read[] => {
      fault = true;
      slow(e);
      return [{ got: "none" }, { got: "none" }];
    });
    if (!fault) pace = POOL_BUY_POLL_MS;
    txSlots = metas.map((m, k) => m.slot ?? metas[1 - k]?.slot);
    const got: readonly (readonly Got[])[] = parts.map((_, k) => metas.map((m) => m.each?.[k]?.got ?? "none"));
    parts.forEach((_, k) => metas.forEach((m, q) => void (seenPart[k]![q] ||= m.each?.[k]?.mine === true)));
    const perRpc = [0, 1].map((q) => ({ mine: seenPart.every((x) => x[q]) }));
    perRpc.forEach((m, p) => void (seen[p] ||= m.mine === true));
    // another transaction under a name on both RPCs: the helper's signature is not that part's
    if (got.some((g) => g[0] === "other" && g[1] === "other")) return unlanded([], sigs);
    // a part failed on chain, on both RPCs: it spent nothing and can never land again, and the bundle with it (a part
    // the helper sent alone may have landed: its note is settled, but no buy is filled); a spend the settle finds then
    // is not this buy's, so not_landed at once
    if (got.some((g) => g[0] === "failed" && g[1] === "failed")) return (await spent()) || left.length < parts.length ? { stage: "not_landed", txs } : { stage: "refused", txs };
    landed = got.every((g) => g[0] === "ok" && g[1] === "ok");
    // every tag 2 on both RPCs and the buy on neither (a buy of several pieces whose tag 3 the helper lost): the very
    // bytes W signed sent again on the one-piece route while the blockhash lives, POOL_BUY_RESEND_MS after the pieces
    // first read landed and as often after, at most POOL_BUY_RESEND_MAX times. Nothing new is signed: its min out is the
    // user's own, and the helper carries a nullifier once, so a buy it still carries answers that carry's word
    const tag3 = got[got.length - 1]!;
    if (!landed && parts.length > 1 && got.slice(0, -1).every((g) => g[0] === "ok" && g[1] === "ok") && tag3[0] === "none" && tag3[1] === "none") {
      piecesAt ??= clock();
      if (resends < POOL_BUY_RESEND_MAX && clock() - piecesAt >= (resends + 1) * POOL_BUY_RESEND_MS && clock() - signedAt < POOL_BLOCKHASH_LIFE_MS) {
        resends++;
        void Promise.resolve()
          .then(() => h.send(pool, signed))
          .catch(() => {});
      }
    }
    // read back on both RPCs as these very transactions: only now is the buy told as sent, by its signature; a buy
    // tells it as a route fact too (card pool-buy-send-fast), which reaches the app however late it comes: an answer
    // past the kit client's 10 s is dropped (a mainnet bundle the helper holds until it lands)
    if (!ours && seen[0] && seen[1]) {
      ours = true;
      tellTx(signature);
      await h.sent?.(signature);
    }
    if (landed && fill) {
      // the amount W received, from the buy's transaction on both RPCs: the two the same and at least the min out the
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
  if (!landed) return unlanded(ours ? txs : [], sigs);
  h.landed?.(r.noteId, r.attempt, release.withdrawnValue);
  for (const p of before) h.landed?.(p.r.noteId, p.r.attempt, p.release.withdrawnValue);
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
    const a = await spentBy(sigs, txs);
    if (a) return a;
    // whose spend not known yet: read again at the pace, or, when its reads failed, at the grown pause
    if (faults === f0) pace = POOL_BUY_POLL_MS;
    next = pace;
  }
  return { stage: "sent", txs };
}

/** A followed buy's end (card pool-buy-record-never-stays-sent), from its note as the page's settle pass left it and,
 *  once SPENT, whose spend it is: still RESERVED by its attempt (or no note read), not known yet (null); out of RESERVED
 *  and not SPENT, not_landed, since only the pass frees a RESERVED note and only once its transaction can never land
 *  (both RPCs past its last height, or its deadline, with no spent mark); SPENT, filled only when `owner` (pool-spend.ts
 *  spendOwner on both RPCs at finalized) reads the spend as this attempt's, not_landed for another's, and null when it
 *  cannot tell or its read throws. */
export async function lateBuyEnd(n: { state: string; attempt?: string } | undefined, attempt: string, owner: () => Promise<SpendOwner>): Promise<"filled" | "not_landed" | null> {
  if (n === undefined || (n.state === "RESERVED" && n.attempt === attempt)) return null;
  if (n.state !== "SPENT") return "not_landed";
  const o = await owner().catch(() => null);
  return o === null ? null : o === "other" ? "not_landed" : "filled";
}

type Locks = Pick<LockManager, "request">;

/** The pool.buy kind: one run per tap under the seed's shared lock (sign out waits for it), answered "sent" with its
 *  signature once that reads back on both RPCs as this very transaction (sendAndSettle's sent), or at the run's end
 *  with the run's own answer; the run's final stage is always posted as progress as well. A run that ends "sent" (its
 *  end not known: the reads ran out, or a throw after its early answer) hands the page `follow`, and the end the page's
 *  own reads of its note find later goes out as progress too, once (card pool-buy-record-never-stays-sent). */
export function poolBuyKind(host: () => PoolBuyHost & { release?(): void; end?(): void; follow?(post: (stage: "filled" | "not_landed") => void): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || !locks) return { error: "not_allowed" };
    // the tap's one bound, from its arrival (before its locks)
    const waits = tapWaits(ctx);
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    // true once the run answered "sent" early (its transaction went out): only then is "sent" its end when it ends with
    // no stage of its own
    let early = false;
    // the run's final stage, posted once
    let ended = false;
    let h: ReturnType<typeof host> | null = null;
    const end = (stage: TradeStage): void => {
      if (ended) return;
      ended = true;
      ctx?.progress(stage);
      // not known: the page follows the note, and its end is posted once
      if (stage !== "sent") return;
      let late = false;
      try {
        h?.follow?.((x) => {
          if (late) return;
          late = true;
          ctx?.progress(x);
        });
      } catch {
        /* the follow never stops the run's end */
      }
    };
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        const h0 = (h = host());
        try {
          const a = await runPoolBuy({ ...h0, sent: (signature) => {
            if (!answer) (answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } }), (early = true);
            give();
            // its transaction read back: its hosts go back now (the read-backs to Final are a trade's reads, first on
            // their host all the same), so the page's background reads and the sell box's preview go on beside them
            h0.release?.();
          }, route: (x) => ctx?.route?.(x) }, ask, waits);
          if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
          // the run's stage goes out as progress too, answered early or not: an answer that comes only at the run's end
          // (no read-back within the client's 10 s) is one the kit's client has dropped, and the app waits on progress
          // (api.ts holds a progress event until its id's answer is posted). An error after the early answer "sent" is
          // a transaction that went out with its end not known: "sent", so the app's Filled not yet Final ends too
          // (review of 418af7d5)
          if ("stage" in a) end(a.stage);
          else if (early) end("sent");
        } finally {
          h0.end?.();
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
    // the request's run ended: its bound dropped (read-waits.ts tapDone)
    void run.then(() => tapDone(ctx, waits), () => tapDone(ctx, waits));
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
