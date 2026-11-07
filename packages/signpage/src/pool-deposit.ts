// pool.deposit on the Solana pool (card signpage-pool-notes): a one-time wallet U of the device puts SOL into the pinned
// pool, and each note is stored only once its own deposit reads back on two RPCs.
//
// - The source: U_{scope,i} (derive/keys.ts depositId). The newest U this scope has used stays the source while its
//   balance covers a rung and its costs; else the U of the index the note store plans (planDeposit: one unfunded index
//   per scope, so the same U is named until money reaches it). The amount is split on the pool's ladder
//   (../../wallet/src/pool/ladder.ts ladderSplit): on a new U the first rung is its deposit note, every other rung that
//   U's next second arrival (n = 0, 1, ...), each its own deposit, the next planned only once the one before is done.
// - The deposit is the kit's (packages/kit/src/trade/solana/pool-deposit.ts, card pool-deposits): built by
//   solanaPoolDepositTx, priced by solanaPoolDepositCost as the program charges (the fee, the mark's rent and each page's
//   rent at its new length, less what each already holds), the pool read by solanaPoolTreeSizes and a mark by
//   solanaPoolPreMarkOf (a stranger's system account at a mark's address is no mark: the deposit takes it over).
// - One deposit's numbers are of one slot on each RPC: the pool, the two pages it writes, the mark's address, U and the
//   Rent sysvar in one getMultipleAccounts at confirmed per RPC (the pool the same bytes on both, the pages the ones its
//   sizes name, else read again at the higher slot either answered, minContextSlot); every other read of a build at
//   confirmed too. The deposit must go on each RPC's reading: U after it holds 0 or at least the rent of an empty
//   account (the runtime refuses less) on both, so neither RPC's word prices it. Short of that: not_funded, nothing
//   written, `short` naming the least top-up that makes both go.
// - Before anything is written: the blockhash is read on one RPC and must be valid on the other; the tx is checked by
//   the rule (rules/pool.ts checkSolanaDeposit: one tag 1 into the pinned pool, by U, of the rung, with the note's own
//   precommitment) and its unsigned bytes simulated on both RPCs (sigVerify off, so neither can send it), which must
//   both pass before U signs. A simulation
//   that fails while the note's mark exists (both RPCs, finalized) means another deposit took the precommitment: that
//   deposit is restored as the user's note (below) and the rung goes on U's next note, nothing signed for this one.
// - A state and its send are written before the act: PLANNED -> INCOMING carries the send (signature, value, the
//   blockhash's last valid height), written before the signed tx leaves the device; a send again is written first too
//   (addSend, at the note's recorded value).
// - A note's verdict is the precommitment's mark at finalized on both RPCs, never an RPC's tx history: the mark at the
//   note's recorded value, its label the label tree's leaf nonce - 1 and the commitment Poseidon(value, label,
//   precommitment) a leaf of the state tree (../../wallet/src/pool/solana.ts solanaTreeSync): INCOMING -> UNSPENT,
//   whoever sent it (a same-value deposit by another only funds the user's note). A mark of any other value: another
//   deposit took the precommitment first (anyone who saw U's pending tx can send MIN_DEPOSIT with it; the pool keeps
//   the first, contracts/pool-solana/src/deposit.rs:93). That deposit is still the user's note, since only the seed
//   gives the precommitment's secrets: INCOMING -> UNSPENT with the leaf the mark names, at the value it carried, read
//   as above (card precommit-taken-recover). The ask's rung then goes on U's next note in the same run, U's money
//   untouched by the failed tx but its fee; each try costs the front-runner at least MIN_DEPOSIT, which becomes the
//   user's note, and the mark's rent, locked in a mark that never closes. A run signs again after at most as many taken
//   notes as its ask has rungs; the one taken after those is restored too and ends the run (so at most rungs + 1 taken
//   notes and sends: a one-rung ask still gets its second try), part_filled with what landed, else failed, and the next
//   run goes on, so a front-runner
//   who takes every send never holds the deposit and seed locks (a sign out waits on them) past that. Taken also needs
//   both RPCs not to say one of the note's sends succeeded (that would contradict the mark: refused). A page closed between a taken PLANNED note's two moves (PLANNED -> INCOMING with no send,
//   then UNSPENT) leaves it INCOMING with no send: its mark, which never closes, is read again and it is restored.
//   No mark, read after both RPCs' finalized heights and signature statuses, and every send dead by those reads (past
//   its last valid height on both, or finalized with an error on both: a failed tx never lands): built again at its own
//   value, the same note and U, from fresh reads (above), never the old bytes (heights and statuses first, so a send
//   that finalizes between the reads is read landed, never sent again). Anything else is pending: read again, then
//   not_landed with the note left INCOMING, never
//   stored as money. A mark one RPC holds and the other not yet is a deposit that may have landed: read again, never
//   built again. A send built again whose simulation fails is read again too, never stuck. A run builds one note again
//   on a failure on both RPCs at most POOL_DEPOSIT_REBUILDS times; past that only expiry makes its last send dead.
// - After U's send, a read back that does not check out (the RPCs disagree on the mark, a mark of nonce 0, a label
//   leaf not its nonce's, the commitment not once in the state tree) answers "sent" with the send, never failed: the
//   note stays INCOMING and settles at the next load (card pool-answer-unknown). Signature statuses only name the tx
//   that landed, in the answer; a rung that landed with no tx named still counts (part_filled, never failed or down).
//   A send's last valid height is the higher of each RPC's own bound (RPC 0's word capped by its height + 151, RPC 1's
//   height + 151), so no one RPC reads a live send expired, nor keeps one alive past + 151 alone.
// - An INCOMING note of the pool's scope (a run a reload cut short) is read once at the start of every run, as its own
//   move, never waited on: settled, taken, sent again, or left INCOMING with its U not a source this run (a resend U
//   cannot pay leaves it so, and `short` names the top-up). settlePoolDeposits does that pass with no ask, on page load
//   and on the page's state reads while such a note is open. An ask whose U is short behind such a pending note waits
//   (not_landed) only when that note's U still holds the rung once its open notes land (a send an RPC already saw
//   succeed is in U's balance, never subtracted again; the lower of the two RPCs' readings decides); else not_funded,
//   `short` naming the ask's own U.
// - Each note that lands starts the proof queue's pass (`landed`), so the next buy's proof is made ahead; `sent` and
//   `progress` tell the app of the ask's own sends and landed rungs, never an earlier note's.
// - A provider fault is "down" only while nothing of the ask landed and no send of it may still land (none signed, or
//   each one taken); else part_filled or sent. A note sent again by the pass, never the ask's, leaves the ask's own
//   fault "down".
// - Every read names a public account or tx (the pool, its pages, U, the mark the deposit itself named, U's own
//   signatures), one wallet of the user's per request; no request carries a key, the words, or which note is whose. U's
//   secret key and the seed are zeroed when the run ends. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { SOLANA_RENT_SYSVAR, solanaPoolPage, solanaRentMin, solanaRentOf, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaPoolDepositError, solanaPoolDepositCost, solanaPoolDepositTx, solanaPoolPreMark, solanaPoolPreMarkOf, solanaPoolTreeSizes } from "../../kit/src/trade/solana/pool-deposit.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { depositId } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import type { Leaf, NoteRecord, NoteStore, PoolSend } from "../../wallet/src/notes/store.ts";
import { ladderSplit } from "../../wallet/src/pool/ladder.ts";
import { SOL_LADDER, solanaPoolOf, solanaTreeSync, type SolanaPoolPin } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkSolanaDeposit, PoolRuleRefused, signSolana, type PoolAsk } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

export type PoolDepositHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The note store, opened top-level. */
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  /** A note landed: the proof queue's pass, which makes the next buy's proof ahead. */
  landed?(note: NoteRecord): void;
  /** A deposit tx was sent (its signature), and each rung's stage as it comes: "sent", "filled" (landed). */
  sent?(signature: string): void;
  progress?(stage: TradeStage): void;
  /** U cannot pay a note's send: the lamports it is short (a top-up to its address lets the note go). */
  short?(address: string, lamports: bigint): void;
  /** Verdict reads before not_landed, and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  now?(): bigint;
  /** Called by poolDepositKind once the run ends: the note store opened for it is closed. */
  end?(): void;
};

/** What a run answers: the trade stage with the deposits that landed (or, not landed, were sent), or a code. */
export type PoolDepositAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "failed" | "down" };

/** Verdict reads a note gets in one run, a second apart: about two finalizations and a blockhash's life (~60 to 90 s). */
export const POOL_DEPOSIT_READS = 120;
export const POOL_DEPOSIT_WAIT_MS = 1_000;

/** A blockhash is valid for 150 blocks after the one it names (Solana's MAX_PROCESSING_AGE), so at most height + 151. */
const BLOCKHASH_LIFE = 151n;
/** Reads of one deposit's state before it is refused: the pool moved under them, or the RPCs disagree on it. */
const STATE_READS = 3;
/** A node behind the slot a read again names (minContextSlot) is read again this long after (as pool-sell's sizes). */
export const POOL_DEPOSIT_BEHIND_MS = 500;
/** Sends of one note built again in a run because the last one failed on both RPCs: past these, the note waits for its
 *  last send's blockhash to expire (each failed send costs U its fee, so a run never pays for an unbounded chain). */
export const POOL_DEPOSIT_REBUILDS = 2;

// "taken": the run's last taken note (a front-runner took as many as the ask has rungs, and one more), a verdict of its
// own, never read as a send that may land
type Code = "not_allowed" | "not_funded" | "failed" | "not_landed" | "taken";
class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
const int = (x: unknown): number => {
  if (!Number.isSafeInteger(x) || (x as number) < 0) throw new Refused("failed");
  return x as number;
};
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(h: PoolDepositHost, f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(h.rpcs[0]), f(h.rpcs[1])]);

/** An account as an RPC gives it; `lamports` as the RPC wrote it, read only where it is priced (lamportsOf): the pool's
 *  or the Rent sysvar's balance is never a number this page needs, so no size of it ever refuses a run. */
type Account = { owner: string; data: Uint8Array; lamports: unknown };
/** An account as an RPC gives it (base64); null when there is none. */
const accountOf = (v: unknown): Account | null => {
  if (v === null) return null;
  const x = v as { owner?: unknown; data?: unknown; lamports?: unknown } | undefined;
  if (typeof x?.owner !== "string" || !Array.isArray(x.data) || x.data[1] !== "base64" || typeof x.data[0] !== "string") throw new Refused("failed");
  return { owner: x.owner, data: base64.decode(x.data[0]), lamports: x.lamports };
};
/** A priced account's lamports (none: 0). */
const lamportsOf = (a: Account | null): bigint => (a === null ? 0n : BigInt(int(a.lamports)));
/** Solana's JSON-RPC answer to a read with minContextSlot past the node's own slot (a node a slot or more behind). */
const BEHIND = /RPC error -32016\b/;

/** One account, with the slot the RPC answered at. */
async function account(rpc: SolanaRpc, address: string, commitment: "confirmed" | "finalized"): Promise<{ slot: number; account: Account | null }> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment }])) as { context?: { slot?: unknown }; value?: unknown };
  return { slot: int(r?.context?.slot), account: accountOf(r?.value) };
}

/** The pool account on both RPCs, the same bytes: its two tree sizes (the kit's parse). */
async function treeSizes(h: PoolDepositHost, pool: string): Promise<{ stateSize: number; labelSize: number }> {
  const [a, b] = await both(h, (r) => account(r, pool, "confirmed"));
  if (a.account === null || b.account === null) throw new Refused("not_allowed");
  if (!sameBytes(a.account.data, b.account.data)) throw new Refused("failed");
  solanaPoolTreeSizes(b.account, h.pin.program);
  return solanaPoolTreeSizes(a.account, h.pin.program);
}

/** The precommitment mark on both RPCs at finalized (the kit's parse): the deposit's value and nonce, and the higher
 *  slot; null when neither holds it, "one" when only one does (a deposit that may have landed, the other RPC behind:
 *  never built again or stuck on it). A stranger's system account at the address is no mark (I-3: it never fails a
 *  run). */
async function markOf(h: PoolDepositHost, precommitment: bigint): Promise<{ value: bigint; nonce: bigint; slot: number } | null | "one"> {
  const address = solanaPoolPreMark(h.pin.program, precommitment);
  const [a, b] = await both(h, (r) => account(r, address, "finalized"));
  const [ma, mb] = [solanaPoolPreMarkOf(a.account, h.pin.program), solanaPoolPreMarkOf(b.account, h.pin.program)];
  if (ma === null && mb === null) return null;
  if (ma === null || mb === null) return "one";
  if (ma.value !== mb.value || ma.nonce !== mb.nonce) throw new Refused("failed");
  return { value: ma.value, nonce: ma.nonce, slot: Math.max(a.slot, b.slot) };
}

/** One RPC's balances a deposit is priced from: the two pages', the mark's address's and U's, of one slot. */
type View = { have: { statePage: bigint; labelPage: bigint; mark: bigint }; balance: bigint };

/** What one deposit is priced from, each number of one slot on each RPC: the pool, the two pages its sizes name, the
 *  mark's address, U and the Rent sysvar, in one getMultipleAccounts at confirmed per RPC. The pool the same bytes on
 *  both and the pages the ones its sizes name, else read again (an insert moved it, or one RPC is a slot behind), at
 *  most STATE_READS times, each read again at the higher slot the last one answered at (minContextSlot) on both RPCs; a
 *  node not there yet is read again POOL_DEPOSIT_BEHIND_MS on. Each RPC's balances are kept apart (`views`): the
 *  deposit must go on each RPC's reading, so neither one's word prices it. */
async function depositState(h: PoolDepositHost, pool: string, guess: { stateSize: number; labelSize: number }, mark: string, u: string, wait: (ms: number) => Promise<void>) {
  const program = h.pin.program;
  let at: number | undefined;
  for (let t = 0, sizes = guess; t < STATE_READS; t++) {
    const keys = [pool, solanaPoolPage(program, 0, sizes.stateSize), solanaPoolPage(program, 1, sizes.labelSize), mark, u, SOLANA_RENT_SYSVAR];
    let read: [{ slot: number; v: (Account | null)[] }, { slot: number; v: (Account | null)[] }];
    try {
      read = await both(h, async (r) => {
        const x = (await r("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed", ...(at === undefined ? {} : { minContextSlot: at }) }])) as { context?: { slot?: unknown }; value?: unknown };
        const v = x?.value;
        if (!Array.isArray(v) || v.length !== keys.length) throw new Refused("failed");
        return { slot: int(x?.context?.slot), v: v.map(accountOf) };
      });
    } catch (e) {
      if (at === undefined || !(e instanceof Error) || !BEHIND.test(e.message)) throw e;
      await wait(POOL_DEPOSIT_BEHIND_MS);
      continue;
    }
    at = Math.max(read[0].slot, read[1].slot, at ?? 0);
    const [a, b] = [read[0].v, read[1].v];
    if (a[0] === null || b[0] === null) throw new Refused("not_allowed");
    const told = solanaPoolTreeSizes(a[0], program);
    solanaPoolTreeSizes(b[0], program);
    const same = sameBytes(a[0].data, b[0].data);
    const pages = solanaPoolPage(program, 0, told.stateSize) === keys[1] && solanaPoolPage(program, 1, told.labelSize) === keys[2];
    sizes = told;
    if (!same || !pages) continue;
    // a mark the program made is priced at what it holds (its simulation then fails: the precommitment is used); any
    // other owner refused
    solanaPoolPreMarkOf(a[3]!, program);
    solanaPoolPreMarkOf(b[3]!, program);
    let rent: SolanaRent;
    try {
      const [ra, rb] = [solanaRentOf(a[5]!), solanaRentOf(b[5]!)];
      if (ra.lamportsPerByte !== rb.lamportsPerByte || ra.factor !== rb.factor) throw new Error("the RPCs disagree on rent");
      rent = ra;
    } catch {
      throw new Refused("failed");
    }
    const view = (x: (Account | null)[]): View => ({ have: { statePage: lamportsOf(x[1]!), labelPage: lamportsOf(x[2]!), mark: lamportsOf(x[3]!) }, balance: lamportsOf(x[4]!) });
    return { sizes, rent, views: [view(a), view(b)] as const };
  }
  throw new Refused("failed");
}

/** Both RPCs' finalized block height. */
async function heights(h: PoolDepositHost): Promise<[bigint, bigint]> {
  return both(h, async (r) => BigInt(int(await r("getBlockHeight", [{ commitment: "finalized" }]))));
}

/** The send that landed, for the answer only: one finalized with no error on either RPC, else none (a history an RPC no
 *  longer holds never changes a verdict). */
async function landedSend(h: PoolDepositHost, sends: readonly PoolSend[]): Promise<string | null> {
  const sigs = sends.map((s) => s.signature);
  const reads = await Promise.allSettled(h.rpcs.map((r) => r("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])));
  for (const x of reads) {
    const v = x.status === "fulfilled" ? (x.value as { value?: unknown })?.value : null;
    if (!Array.isArray(v) || v.length !== sigs.length) continue;
    const k = v.findIndex((st) => (st as { confirmationStatus?: unknown; err?: unknown } | null)?.confirmationStatus === "finalized" && (st as { err?: unknown }).err === null);
    if (k >= 0) return sigs[k]!;
  }
  return null;
}

/** U's id (deposit or second arrival of U): its scope and index. */
function uOf(ref: NoteRef): { s: bigint; i: number } | null {
  if (ref.kind === "deposit") return { s: ref.s, i: ref.i };
  if (ref.kind === "second" && ref.id.id === "U") return { s: ref.id.s, i: ref.id.i };
  return null;
}

/** The run of one pool.deposit (`ask` already passed checkPoolRequest), or, with no ask, the INCOMING notes finished. */
export async function runPoolDeposit(h: PoolDepositHost, ask: PoolAsk | null): Promise<PoolDepositAnswer> {
  if (ask !== null && (ask.kind !== "pool.deposit" || ask.chain !== "solana")) return { error: "not_allowed" };
  const { pool, scope } = solanaPoolOf(h.pin.program);
  const store = await h.notes();
  const seed64 = await h.seed64();
  const sync = solanaTreeSync(h.rpcs, h.pin.program);
  const landedTxs: TxRef[] = [];
  // the ask's own notes that landed this run, each counted whether or not an RPC still names its tx (landedTxs): a
  // landed note is always part of the answer, never read as nothing done
  let landed = 0;
  const sentTxs: TxRef[] = [];
  // the sends of notes this run settled (landed or taken): none of them is a send that may still land
  const closed = new Set<string>();
  const open = (): TxRef[] => sentTxs.filter((t) => !closed.has(t.hash));
  // sends built again this run per note because the last one failed on both RPCs (POOL_DEPOSIT_REBUILDS)
  const rebuilt = new Map<NoteRecord["id"], number>();
  const keys: Uint8Array[] = [];
  const wait = h.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // the tree sizes last read: which pages a deposit's one read names first
  let sizes = { stateSize: 0, labelSize: 0 };
  try {
    const uKey = (u: { s: bigint; i: number }): { address: string; secretKey: Uint8Array } => {
      if (u.s !== scope) throw new Refused("not_allowed");
      const id = depositId(seed64, u.s, u.i);
      keys.push(id.secretKey);
      return { address: base58.encode(id.publicKey), secretKey: id.secretKey };
    };

    // a note's deposit of `value` by U: built, checked by the rule, simulated unsigned on both RPCs, then signed; its cost
    type Built = { tx: string; send: PoolSend };
    type Unbuilt = { short: bigint } | { simulation: "failed" };
    // `own`: the ask's own note (or, with no ask, a note it settles): only its sends are told to the app and answered
    const build = async (u: { address: string; secretKey: Uint8Array }, precommitment: bigint, value: bigint, own: boolean): Promise<Built | Unbuilt> => {
      const st = await depositState(h, pool, sizes, solanaPoolPreMark(h.pin.program, precommitment), u.address, wait);
      sizes = st.sizes;
      const bh = (await h.rpcs[0]("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } };
      const blockhash = bh?.value?.blockhash;
      if (typeof blockhash !== "string") throw new Refused("failed");
      // the other RPC must know the blockhash too, and caps its life: one RPC never picks the tx's life alone
      const valid = (await h.rpcs[1]("isBlockhashValid", [blockhash, { commitment: "confirmed" }])) as { value?: unknown };
      if (valid?.value !== true) throw new Refused("failed");
      // the send's last valid height: the higher of each RPC's own bound (RPC 0's word, capped by its height + 2 x 151, and
      // RPC 1's height + 151), so one RPC's low word never reads a live send expired, nor its high word past + 2 x 151.
      // The cap's slack: RPC 0's height read may come from a node behind the one that gave the blockhash (a load-balanced
      // URL), and its word is still the blockhash's own life
      const said = BigInt(int(bh.value!.lastValidBlockHeight));
      const [h0, h1] = await both(h, async (r) => BigInt(int(await r("getBlockHeight", [{ commitment: "confirmed" }]))));
      const own0 = said < h0 + 2n * BLOCKHASH_LIFE ? said : h0 + 2n * BLOCKHASH_LIFE;
      const lastValid = own0 > h1 + BLOCKHASH_LIFE ? own0 : h1 + BLOCKHASH_LIFE;
      const { message, wire } = solanaPoolDepositTx(h.pin.program, u.address, { value, precommitment }, st.sizes, blockhash);
      checkSolanaDeposit(
        wire,
        { ...(ask ?? { kind: "pool.deposit", chain: "solana", token: null, slippageBps: 0, decimals: 9 }), amount: value } as PoolAsk,
        { nowMs: (h.now ?? (() => BigInt(Date.now())))(), wallet: u.address, feeCap: 0n, solana: h.pin, precommitment },
        { blockhash, tables: {}, stateSize: st.sizes.stateSize, labelSize: st.sizes.labelSize },
      );
      // the cost: the fee both RPCs price this message at, and the rent the program charges (the kit's)
      const [fa, fb] = await both(h, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
      if (fa !== fb) throw new Refused("failed");
      // what U keeps on each RPC's reading: 0 or at least an empty account's rent on both (the runtime refuses less), so
      // the true one, whichever it is, goes; short of that, the least top-up that makes both go
      const costs = st.views.map((v) => solanaPoolDepositCost(fa, st.rent, st.sizes, v.have));
      const lefts = st.views.map((v, k) => v.balance - value - costs[k]!);
      const floor = solanaRentMin(st.rent, 0);
      const goes = (top: bigint): boolean => lefts.every((l) => l + top === 0n || l + top >= floor);
      const tops = [0n, ...lefts.map((l) => -l), ...lefts.map((l) => floor - l)].filter((x) => x >= 0n).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const top = tops.find(goes)!;
      if (top > 0n) return { short: top };
      // unsigned: an RPC cannot send what it simulates
      const sims = await both(h, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } })?.value);
      if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return { simulation: "failed" };
      const signature = signSolana(u.secretKey, wire);
      const signed = wire.slice();
      signed.set(signature, 1);
      return { tx: base64.encode(signed), send: { signature: base58.encode(signature), value, last_valid_block_height: lastValid } };
    };

    // `own`: a send of this run's ask (or, with no ask, of the notes it settles), the only sends it tells the app of
    const send = async (b: Built, own: boolean): Promise<void> => {
      const out = await Promise.allSettled(h.rpcs.map((r) => r("sendTransaction", [b.tx, { encoding: "base64", preflightCommitment: "confirmed" }])));
      if (!own) return;
      // written before it left: whether an RPC took it or not, its verdict reads it
      sentTxs.push({ chain: "solana", hash: b.send.signature });
      if (out.some((s) => s.status === "fulfilled" && s.value === b.send.signature)) {
        h.sent?.(b.send.signature);
        h.progress?.("sent");
      }
    };

    // a send of `sends` both RPCs say finalized with no error: one RPC's word alone never refuses a taken note
    const bothLanded = async (sends: readonly PoolSend[]): Promise<boolean> => {
      const sigs = sends.map((s) => s.signature);
      const reads = await Promise.allSettled(h.rpcs.map((r) => r("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])));
      const ok = reads.map((x) => {
        const v = x.status === "fulfilled" ? (x.value as { value?: unknown })?.value : null;
        return Array.isArray(v) && v.length === sigs.length ? v.map((st) => (st as { confirmationStatus?: unknown } | null)?.confirmationStatus === "finalized" && (st as { err?: unknown }).err === null) : sigs.map(() => false);
      });
      return sigs.some((_, k) => ok.every((o) => o[k]));
    };

    // each send's death read before the mark (with the heights): `expired`, or finalized with an error on both RPCs,
    // so it can never land. One RPC's word alone keeps it alive
    const failedOnBoth = async (sends: readonly PoolSend[], expired: readonly boolean[]): Promise<boolean[]> => {
      const sigs = sends.map((s) => s.signature);
      const reads = await Promise.allSettled(h.rpcs.map((r) => r("getSignatureStatuses", [sigs, { searchTransactionHistory: true }])));
      const failed = reads.map((x) => {
        const v = x.status === "fulfilled" ? (x.value as { value?: unknown })?.value : null;
        return Array.isArray(v) && v.length === sigs.length ? v.map((st) => { const o = st as { confirmationStatus?: unknown; err?: unknown } | null; return o?.confirmationStatus === "finalized" && o.err !== null && o.err !== undefined; }) : sigs.map(() => false);
      });
      return sigs.map((_, k) => expired[k]! || failed.every((f) => f[k]));
    };

    // one INCOMING note, read up to `reads` times: landed (UNSPENT), taken (restored UNSPENT at the mark's value),
    // pending (INCOMING, maybe sent again), or stuck (INCOMING: U cannot pay its send again)
    // a mark's leaf: its label the label tree's leaf nonce - 1, and Poseidon(value, label, precommitment) a leaf of the
    // state tree, once, in the trees read at the mark's slot
    const leafOf = async (precommitment: bigint, m: { value: bigint; nonce: bigint; slot: number }): Promise<Leaf> => {
      if (m.nonce === 0n) throw new Refused("failed");
      const leaves = await sync.leaves(m.slot);
      const label = vaultLabelOf(keccak_256, scope, m.nonce);
      if (leaves.label[Number(m.nonce - 1n)] !== label) throw new Refused("failed");
      const commitment = noteCommitment(m.value, label, precommitment);
      const at = leaves.state.indexOf(commitment);
      if (at < 0 || leaves.state.indexOf(commitment, at + 1) >= 0) throw new Refused("failed");
      return { value: m.value, label, commitment, leafIndex: BigInt(at) };
    };
    // another deposit took the note's precommitment first: its deposit is the user's note all the same (only the seed
    // names the precommitment's secrets, so only this device can spend it), stored UNSPENT at the value that deposit
    // carried, whatever it is (MIN_DEPOSIT, or more); its pass starts like any landed note's
    const restore = async (n: NoteRecord, m: { value: bigint; nonce: bigint; slot: number }): Promise<void> => {
      const leaf = await leafOf(n.precommitment, m);
      const incoming = n.state === "PLANNED" ? await store.move(n.id, "PLANNED", "INCOMING") : n;
      // the move outside the optional call: `h.landed?.(x)` never evaluates x on a host with no landed hook
      const done = await store.move(incoming.id, "INCOMING", "UNSPENT", { leaf });
      h.landed?.(done);
    };

    const finish = async (note: NoteRecord, own: boolean, reads: number): Promise<"landed" | "taken" | "pending" | "stuck"> => {
      let n = note;
      // the reads are a time budget too (POOL_DEPOSIT_READS a second apart): one RPC down, each read's retry its own
      // 3.5 s, never holds the seed's lock past it; the note, INCOMING, settles at the next load
      const clock = (): number => Number(h.now?.() ?? BigInt(Date.now()));
      const from = clock();
      for (let k = 0; ; k++) {
        const sends = n.sends ?? [];
        // INCOMING with no send: a page closed between a taken note's two moves (restore), made only once its mark was
        // read on both RPCs at finalized; the mark never closes, so it is read again and the note restored
        if (sends.length === 0) {
          const m = await markOf(h, n.precommitment);
          if (m === null) throw new Refused("failed");
          if (m === "one") return "pending";
          await restore(n, m);
          return "taken";
        }
        const value = sends[0]!.value; // every send of a note is at its recorded value (store addSend)
        // the heights before the mark: a finalized height past every send's last valid height, read before a mark read
        // that finds none, means no send can land after it
        const hs = await heights(h);
        const expired = sends.map((x) => hs.every((y) => y > x.last_valid_block_height));
        // past POOL_DEPOSIT_REBUILDS sends built again on a failure this run, only expiry makes a send dead
        const capped = (rebuilt.get(n.id) ?? 0) >= POOL_DEPOSIT_REBUILDS;
        const dead = expired.every(Boolean) || capped ? expired : await failedOnBoth(sends, expired);
        const m = await markOf(h, n.precommitment);
        if (m !== null && m !== "one") {
          // a mark of another value is another deposit's: this precommitment is taken, and that deposit is restored.
          // Then none of the note's sends can have succeeded: an RPC that says one did contradicts the mark, refused
          if (m.value !== value) {
            if (await bothLanded(sends)) throw new Refused("failed");
            await restore(n, m);
            for (const x of sends) closed.add(x.signature);
            return "taken";
          }
          const leaf = await leafOf(n.precommitment, m);
          const done = await store.move(n.id, "INCOMING", "UNSPENT", { leaf });
          for (const x of sends) closed.add(x.signature);
          const sig = own ? await landedSend(h, sends) : null;
          if (sig !== null) landedTxs.push({ chain: "solana", hash: sig });
          if (own) landed++;
          h.landed?.(done);
          if (own) h.progress?.("filled");
          return "landed";
        }
        // no mark on either RPC: built again at its own value only once no send of it can land, on both RPCs (past its
        // last valid height, or failed): from fresh reads, never the old bytes. A mark on one RPC only is a deposit that
        // may have landed: read again, never built again
        if (m === null && dead.every(Boolean)) {
          const u = uOf(n.ref);
          if (!u) throw new Refused("not_allowed");
          const key = uKey(u);
          const b = await build(key, n.precommitment, value, own);
          if ("short" in b) {
            h.short?.(key.address, b.short);
            return "stuck";
          }
          // a simulation that fails here may be the note's own deposit, landed while one RPC's finalized view lacks its
          // mark (the mark's precommitment is then used), or the pool moving under the read: never stuck, read again
          if ("tx" in b) {
            if (!expired.every(Boolean)) rebuilt.set(n.id, (rebuilt.get(n.id) ?? 0) + 1);
            const after = await store.addSend(n.id, b.send, sends.length);
            if ((after.sends ?? []).length === sends.length + 1 && after.sends!.at(-1)!.signature === b.send.signature) await send(b, own);
            n = after;
          }
        }
        if (k + 1 >= reads || clock() - from >= POOL_DEPOSIT_READS * POOL_DEPOSIT_WAIT_MS) return "pending";
        await wait(POOL_DEPOSIT_WAIT_MS);
      }
    };

    // the pinned pool, on both RPCs, before any note is planned for its scope
    sizes = await treeSizes(h, pool);

    // a run a reload cut short: each INCOMING note of the pool's scope read once, as its own move, never waited on; a U
    // with a note still open is no source this run
    const busy = new Set<number>();
    const pending = new Set<number>(); // the U of a note still landing (not one stuck on its top-up)
    let stuck = false;
    for (const n of await store.list()) {
      const u = n.state === "INCOMING" && n.scope === scope ? uOf(n.ref) : null;
      if (!u) continue;
      // a read back that does not check out (a stale tree read, a mark the RPCs disagree on) leaves the note INCOMING, read
      // again at the next load: pending, never a failed run
      const end = await finish(n, ask === null, 1).catch((e: unknown) => {
        if ((e instanceof Refused && e.code === "failed") || e instanceof SolanaPoolDepositError) return "pending" as const;
        throw e;
      });
      if (end === "pending" || end === "stuck") busy.add(u.i);
      if (end === "pending") pending.add(u.i);
      stuck ||= end === "stuck";
    }
    // a U still landing a note holds `value` once its open notes land. Per RPC: U's balance, less the value of each open
    // note none of whose sends that RPC has seen succeed (processed or later: already out of the balance); one batched
    // status read per U. The lower of the two RPCs' readings decides, so neither alone makes the ask wait.
    const coversOnceLanded = async (value: bigint): Promise<boolean> => {
      const open = (await store.list()).filter((n) => n.state === "INCOMING" && n.scope === scope);
      for (const i of pending) {
        const address = uKey({ s: scope, i }).address;
        const mine = open.filter((n) => uOf(n.ref)?.i === i);
        const sigs = mine.flatMap((n) => (n.sends ?? []).map((x) => x.signature));
        const left = await both(h, async (r) => {
          const held = lamportsOf((await account(r, address, "confirmed")).account);
          const v = ((await r("getSignatureStatuses", [sigs, { searchTransactionHistory: false }])) as { value?: unknown })?.value;
          if (!Array.isArray(v) || v.length !== sigs.length) throw new Refused("failed");
          const seen = new Set(sigs.filter((_, k) => (v[k] as { err?: unknown } | null)?.err === null));
          const out = mine.filter((n) => !(n.sends ?? []).some((x) => seen.has(x.signature))).reduce((t, n) => t + (n.sends?.[0]?.value ?? 0n), 0n);
          return held - out;
        });
        if ((left[0] < left[1] ? left[0] : left[1]) >= value) return true;
      }
      return false;
    };
    if (ask === null) return busy.size === 0 ? { stage: "filled", txs: landedTxs } : stuck && sentTxs.length === 0 && landed === 0 ? { error: "not_funded" } : { stage: "not_landed", txs: sentTxs };

    const rungs = ladderSplit(SOL_LADDER, ask.amount).notes;
    // taken notes this run, each restored before it is counted: the run signs again after at most rungs.length of
    // them, and the one after (rungs.length + 1) ends it; the next run goes on
    let takes = 0;
    const tookOne = (): void => {
      if (++takes >= rungs.length + 1) throw new Refused("taken");
    };
    if (rungs.length === 0) return { error: "not_allowed" };

    // the source: the newest U this scope used while it covers a rung and its costs, else the planned index's U. Its
    // notes: a new U's deposit note first, then that U's second arrivals in order (a PLANNED one is taken up again)
    const all = (await store.list()).filter((n) => n.scope === scope);
    const used = all.filter((n) => n.ref.kind === "deposit" && n.state !== "PLANNED").map((n) => (n.ref as { i: number }).i);
    const onU = (i: number): NoteRef => {
      const ns = all.filter((n) => n.ref.kind === "second" && n.ref.id.id === "U" && n.ref.id.i === i);
      const open = ns.find((n) => n.state === "PLANNED");
      if (open) return open.ref;
      const top = ns.map((n) => (n.ref as { n: number }).n);
      return { kind: "second", id: { id: "U", s: scope, i }, n: top.length ? Math.max(...top) + 1 : 0 };
    };
    const after = (r: NoteRef): NoteRef => (r.kind === "deposit" ? { kind: "second", id: { id: "U", s: r.s, i: r.i }, n: 0 } : { ...(r as Extract<NoteRef, { kind: "second" }>), n: (r as { n: number }).n + 1 });
    const free = used.filter((i) => !busy.has(i));
    const newest = free.length ? Math.max(...free) : null;
    let source: { s: bigint; i: number } | null = newest === null ? null : { s: scope, i: newest };
    let ref: NoteRef | null = source === null ? null : onU(source.i);

    for (let k = 0; k < rungs.length; ) {
      if (source === null || ref === null) {
        const first = await store.planDeposit(scope, (r) => noteSecrets(seed64, r).precommitment);
        source = uOf(first.ref)!;
        ref = first.ref;
      }
      const value = rungs[k]!;
      const precommitment = noteSecrets(seed64, ref).precommitment;
      const key = JSON.stringify(ref, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      const held = (await store.list()).find((n) => n.scope === scope && JSON.stringify(n.ref, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === key);
      const planned = held ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" }));
      if (planned.state !== "PLANNED" || planned.precommitment !== precommitment) throw new Refused("failed");
      const from = uKey(source);
      const b = await build(from, precommitment, value, true);
      if (!("tx" in b)) {
        // another deposit took this precommitment while it was planned: that deposit is restored as the user's note,
        // and the same rung goes on U's next note, in this run (nothing was signed or paid for this one)
        const taken = await markOf(h, precommitment);
        // a mark one RPC holds and the other not yet: taken, read again by the next run (restored once both hold it)
        if (taken === "one") return landed ? { stage: "part_filled", txs: landedTxs } : { stage: "not_landed", txs: [] };
        if (taken !== null) {
          await restore(planned, taken);
          ref = after(ref);
          tookOne();
          continue;
        }
        // the used U no longer covers a rung: the move starts on the planned index's U (its PLANNED note waits for it)
        if (k === 0 && source.i === newest && planned.ref.kind === "second") {
          source = null;
          ref = null;
          continue;
        }
        if (landed) return { stage: "part_filled", txs: landedTxs };
        // an earlier note still landing on a U that covers this rung once it lands: try again then; else the ask's
        // own U is short, and the top-up names it
        if (await coversOnceLanded(value)) return { stage: "not_landed", txs: [] };
        if ("short" in b) h.short?.(from.address, b.short);
        return { error: "not_funded" };
      }
      // written before the signed tx leaves the device: INCOMING with its send
      const incoming = await store.move(planned.id, "PLANNED", "INCOMING", { send: b.send });
      await send(b, true);
      const end = await finish(incoming, true, h.reads ?? POOL_DEPOSIT_READS);
      if (end === "pending") throw new Refused("not_landed");
      if (end === "stuck") throw new Refused("not_funded");
      // a front-run on the run's own send: the front-runner's deposit is restored as the user's note, and the same rung
      // goes on U's next note. Each try costs U one failed tx's fee and the front-runner at least MIN_DEPOSIT, which
      // becomes the user's
      if (end === "taken") {
        ref = after(ref);
        tookOne();
        continue;
      }
      k++;
      ref = after(ref);
    }
    return { stage: "filled", txs: landedTxs };
  } catch (e) {
    // the read-back's own verdicts (not landed, taken, stuck), each from reads that answered. A read that does not check
    // out (failed) while a send of the ask may still land answers "sent" with it: the note stays INCOMING and settles at
    // the next load, never failed (an app told failed may ask the user to deposit again)
    if (e instanceof Refused) {
      if (e.code === "not_landed") return { stage: "not_landed", txs: sentTxs };
      if (landed) return { stage: "part_filled", txs: landedTxs };
      if (e.code === "failed" && open().length) return { stage: "sent", txs: open() };
      return { error: e.code === "taken" ? "failed" : e.code };
    }
    // the kit refused a read (a pool or a mark the program never writes): failed, as a refused read here is
    if (e instanceof SolanaPoolDepositError) return landed ? { stage: "part_filled", txs: landedTxs } : open().length ? { stage: "sent", txs: open() } : { error: "failed" };
    if (e instanceof PoolRuleRefused) return { error: "not_allowed" };
    // any other fault past U's send (a provider down after its retry): the transaction may land, so the answer is
    // never failed. What landed is part filled; else "sent" with its signature, and the note, INCOMING, settles at the
    // next load or run (as pool-sell answers; card pool-read-down)
    if (landed) return { stage: "part_filled", txs: landedTxs };
    if (open().length) return { stage: "sent", txs: open() };
    // a provider read that still fails after the page's own retry, with nothing of the ask landed and no send of it that
    // may still land (none signed, or each one taken): "not now", and the user can ask again (card pool-read-down)
    if (e instanceof SolanaRpcTransportError) return { error: "down" };
    throw e;
  } finally {
    for (const k of keys) k.fill(0);
    seed64.fill(0);
  }
}

/** The INCOMING notes of the pool's scope finished with no new ask: on page load and before each run. */
export const settlePoolDeposits = (h: PoolDepositHost): Promise<PoolDepositAnswer> => runPoolDeposit(h, null);

/** One deposit at a time on this device, every tab: two runs never plan or send for one note. */
export const POOL_DEPOSIT_LOCK = "ct-pool/deposit";

type Locks = Pick<LockManager, "request">;

/** The pool flow's pool.deposit on Solana, run holding the seed lock shared (a sign out, in any tab, waits for it) and
 *  POOL_DEPOSIT_LOCK. Answered at its first send (stage "sent" with that tx), or at its end when nothing was sent; each
 *  rung's landing then goes to the app as a `progress` event ("filled"), and a run that ends short as its stage. */
export function poolDepositKind(host: () => PoolDepositHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk | null, ctx: KindContext | null): HostRefusal | Running<"pool.deposit"> => {
    if ((ask !== null && (ask.kind !== "pool.deposit" || ask.chain !== "solana")) || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.deposit"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(POOL_DEPOSIT_LOCK, { mode: "exclusive" }, async () => {
          const h = host();
          let first = true;
          const run = {
            ...h,
            sent: (signature: string) => {
              if (!answer) answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } };
              give();
            },
            progress: (stage: TradeStage) => {
              if (stage === "sent" && first) return void (first = false);
              ctx?.progress(stage);
            },
          };
          try {
            const a = await runPoolDeposit(run, ask);
            if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
            else if ("stage" in a && a.stage !== "filled") ctx?.progress(a.stage);
          } finally {
            h.end?.();
          }
        }),
      )
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
