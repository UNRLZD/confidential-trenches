// pool.sell on the Solana pool (card signpage-pool-sell): one tap sells a token a buy's fresh wallet W holds on its venue,
// and the same transaction, signed by W alone, puts what the sale gives back into the pinned pool as a note of the
// user's own; the note is written INCOMING before the send and lands UNSPENT once both RPCs show its deposit.
//
// - W: one of the page's buy wallets (../../wallet/src/pool/buy-wallets.ts BuyWallet: its l, j, address and holdings),
//   the one holding the token, not frozen, with the smallest holding that covers the amount. The pick reads nothing;
//   none: not_funded with no read at all.
// - The gating reads, each on both RPCs: the Rent sysvar; the pool account (the same bytes on both, read again once
//   when they differ: a leaf landed between the two reads) for its trees' sizes; the token's mint (its owner, the token
//   program, the same on both) and W's associated token account under it (the kit's solanaDecodeTokenAccount: W's, of
//   the token; the lower of the two amounts must cover the amount, else not_funded; frozen: not_allowed); W's lamports,
//   the lower of the two. W pays the fee before anything runs, so W must hold what its sell needs up front (the kit's
//   solanaPoolSellNeed: the fee and rent(0) on pump's curve, the fee and the wrapped-SOL account's rent on PumpSwap,
//   which that sell makes before any proceeds arrive): short of it, not_funded before anything is built, never a
//   failed simulation (the review of 4b6223a). The kit's buy rule leaves every bought W exactly that much.
// - The return note: the first of W's return note (return, c "sol", l, j) and its second arrivals (R, n = 0, 1, ...)
//   that has not landed and whose precommitment mark is on neither RPC (at finalized): one the store does not hold, or
//   holds PLANNED (a sell that never landed: the next one deposits on the same note, so the walk below has no gap); one
//   it holds INCOMING (a sell a closed page sent) is settled first, and while it may still land the sell is failed. A
//   mark on both RPCs for a ref the store does not hold as landed is the user's own note (its precommitment comes from the seed, so no one else can
//   name it before it lands): it is stored UNSPENT with its leaf, as pool-deposit.ts's verdict reads one, and the walk
//   goes on. A mark on one RPC only is that RPC's word against the other's: failed. The same order is what the restore
//   walks (../../wallet/src/pool/solana-restore.ts: every spent note's return and R second arrivals), so a note this
//   page never stored is found there.
// - The quote, last, so it is fresh when W signs (the rule refuses a reference over 25 slots behind the device's own
//   slot): the reference for exactly this sell (the kit's readSolanaReference, side "sell") names the venue that gives
//   the most, readSolanaPoolBuyVenue reads it (its token program must be the one read above), then the blockhash
//   (pool-buy.ts blockhashOf: its slot is the device's own). Min out is the kit's solanaPoolSellMinOut.
// - The reserve, the lamports W keeps out of the deposit: the costs (the tx fee both RPCs price the message at, the
//   mark's rent and each tree page's growth, as pool-deposit.ts counts them) and an empty account's rent W must keep,
//   less what W holds. No compute budget instruction: no priority fee. A reserve over SOLANA_POOL_SELL_RESERVE_MAX or
//   at least min out is refused.
// - Built here (the kit's solanaPoolSellSteps, then the tag 1 deposit of min out less the reserve with the return note's
//   precommitment, last), checked by the rule (rules/pool.ts checkSolanaSell, against the page's pin read at the check),
//   simulated unsigned on both RPCs (sigVerify off, so neither can send it), which must both pass; only then is W
//   derived from the seed (freshWallet, l and j) and must be the W the bytes were built for, and it signs through
//   signSolana (it signs nothing a check did not pass). The key and every seed copy are zeroed on every path.
// - Before it is sent, the note is written INCOMING with W's send (signature, value, the blockhash's last valid
//   height), as pool-deposit.ts writes a deposit's (the review of 4b6223a: a page closed between the send and
//   finality lost the note). Sent on both RPCs. W pays the fee, so the tx id is W's own signature: the kind answers
//   with it. The verdict reads, a second apart (settleSellNote, the one rule for the run, the next sell and the load):
//   both RPCs' finalized height first, then the mark at finalized. The mark on both with its leaf in the state tree:
//   the note UNSPENT, filled when its value is the deposit's (a mark of another value is the user's own note too: a
//   deposit that took the precommitment first; the sell is refused or not_landed). No mark on either and both past the
//   blockhash's last valid height, or this very transaction failed on both (the sale and the deposit are one
//   transaction, so nothing moved): the note PLANNED again, its send dropped, not_landed or refused. Past the reads:
//   "sent", the note INCOMING; each state read of the page settles it (settlePoolSells, src/pool-testnet.ts).
// - Every RPC answer is hostile and parsed strictly. Every read names a public account or the transaction itself, one
//   wallet of the user's at most; no request carries a key or the words. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, SOLANA_POOL_SELL_FEE, solanaPoolPage, solanaPoolSellMinOut, solanaPoolSellNeed, solanaPoolSellSteps, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference, solanaDecodeTokenAccount } from "../../kit/src/trade/solana/pool.ts";
import { solanaAta, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { ErrorCode, TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type Leaf, type NoteRecord, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf, solanaTreeSync, type SolanaPoolPin, type SolanaTreeSync } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { blockhashOf, pastOnBoth, readBack } from "./pool-buy.ts";
import { fromRecord, timedStore, TRADE_STORE_MS, tradeLock, type TradeStore } from "./trade.ts";
import { checkSolanaSell, PoolRuleRefused, signSolana, SOLANA_POOL_SELL_RESERVE_MAX, type PoolAsk } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** What a sell run needs from the page. */
export type PoolSellHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The note store, opened top-level. */
  notes(): Promise<NoteStore>;
  /** The 64-byte seed; each copy is zeroed here. */
  seed64(): Promise<Uint8Array>;
  /** The page's buy wallets with their holdings (shown, never signed on: the run reads again on both RPCs). */
  wallets(): Promise<readonly BuyWallet[]>;
  /** The transaction is signed and about to leave the device (its note already INCOMING with it): W's signature. */
  signed?(signature: string): void;
  /** The transaction was sent: W's signature. */
  sent?(signature: string): void;
  /** A sell's note settled by its mark (this run's, or one a closed page left): its send's signature and the stage. */
  settled?(signature: string, stage: TradeStage): void;
  /** The device's clock, ms. */
  now?(): bigint;
  /** Verdict reads and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  /** Tests only: the venue's buyback recipient, else random. */
  pick?: (n: number) => number;
};

export type PoolSellAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" };

/** Verdict reads a sell gets, a second apart: past a blockhash's life (~60 to 90 s) and a finalization. */
export const POOL_SELL_READS = 120;
export const POOL_SELL_WAIT_MS = 1_000;
/** Two providers a slot apart read the pool account at two states: read again once, this long after. */
export const POOL_SELL_SIZE_RETRY_MS = 500;
/** One sell at a time on this device, every tab: two runs never pick one return note. */
export const POOL_SELL_LOCK = "ct-pool/sell";

const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;
const PRE_MARK_LEN = 17;
const MARK_TAG = 1;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024;
const U32 = 0xffff_ffff;
const enc = /* @__PURE__ */ new TextEncoder();

type Code = "not_allowed" | "not_funded" | "quote_check_failed" | "failed";
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
const u64le = (x: bigint): Uint8Array => {
  if (x <= 0n || x >= 1n << 64n) no();
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const lower = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(rpcs: readonly [SolanaRpc, SolanaRpc], f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(rpcs[0]), f(rpcs[1])]);
type Rpcs = readonly [SolanaRpc, SolanaRpc];

/** One account as an RPC gives it (base64), with the slot it answered at; none when there is no account. */
async function account(rpc: SolanaRpc, address: string, commitment: "confirmed" | "finalized"): Promise<{ slot: number; owner: string; data: Uint8Array; lamports: bigint } | { slot: number; none: true }> {
  const r = (await rpc("getAccountInfo", [address, { encoding: "base64", commitment }])) as { context?: { slot?: unknown }; value?: unknown };
  const slot = int(r?.context?.slot);
  const v = r?.value as { owner?: unknown; data?: unknown; lamports?: unknown } | null | undefined;
  if (v === null) return { slot, none: true };
  if (typeof v?.owner !== "string" || !Array.isArray(v.data) || v.data[1] !== "base64" || typeof v.data[0] !== "string") return no();
  return { slot, owner: v.owner, data: base64.decode(v.data[0]), lamports: BigInt(int(v.lamports)) };
}

/** The pool account on both RPCs, the same bytes (read again once when they differ): its two tree sizes. */
async function treeSizes(rpcs: Rpcs, program: string, pool: string, wait: (ms: number) => Promise<void>): Promise<{ stateSize: number; labelSize: number }> {
  for (let round = 0; ; round++) {
    const [a, b] = await both(rpcs, (r) => account(r, pool, "confirmed"));
    if ("none" in a || "none" in b) return no("not_allowed");
    if (a.owner !== program || b.owner !== program) return no();
    if (!sameBytes(a.data, b.data)) {
      if (round > 0) return no();
      await wait(POOL_SELL_SIZE_RETRY_MS);
      continue;
    }
    const d = a.data;
    if (d.length !== POOL_LEN || !sameBytes(d.subarray(0, 8), POOL_DISC)) return no();
    const size = (at: number): number => int(Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true)));
    return { stateSize: size(OFF_TREES), labelSize: size(OFF_TREES + TREE_LEN) };
  }
}

/** The token's program (the mint's owner, the same on both RPCs) and W's associated token account under it: the lower
 *  of the two amounts. None on either RPC holds nothing; frozen on either: not_allowed. */
async function tokenHeld(rpcs: Rpcs, w: string, mint: string): Promise<{ program: string; amount: bigint }> {
  const mints = await both(rpcs, (r) => account(r, mint, "confirmed"));
  const programs = mints.map((m) => ("none" in m ? no() : m.owner));
  const program = programs[0]!;
  if (programs[1] !== program || (program !== SOLANA_TOKEN_PROGRAM && program !== SOLANA_TOKEN_2022_PROGRAM)) return no();
  const ata = solanaAta(w, mint, program);
  const amounts = (await both(rpcs, (r) => account(r, ata, "confirmed"))).map((a) => {
    if ("none" in a) return 0n;
    if (a.owner !== program) return no();
    let t: ReturnType<typeof solanaDecodeTokenAccount>;
    try {
      t = solanaDecodeTokenAccount({ owner: a.owner, data: a.data });
    } catch {
      return no();
    }
    if (t.mint !== mint || t.owner !== w) return no();
    if (t.state === 2) return no("not_allowed");
    return t.amount;
  });
  return { program, amount: lower(amounts[0]!, amounts[1]!) };
}

type Mark = { value: bigint; nonce: bigint; slot: number };
/** The precommitment's mark at finalized: null when on neither RPC, "one" when on one only, else both's record (the
 *  same bytes) and the higher slot. */
async function markOf(rpcs: Rpcs, program: string, precommitment: bigint): Promise<Mark | "one" | null> {
  const address = solanaProgramAddress([enc.encode("pre"), be32(precommitment)], program);
  const [a, b] = await both(rpcs, (r) => account(r, address, "finalized"));
  if ("none" in a && "none" in b) return null;
  if ("none" in a || "none" in b) return "one";
  if (a.owner !== program || b.owner !== program || !sameBytes(a.data, b.data)) return no();
  const d = a.data;
  if (d.length !== PRE_MARK_LEN || d[16] !== MARK_TAG) return no();
  const v = new DataView(d.buffer, d.byteOffset, 16);
  return { value: v.getBigUint64(0, true), nonce: v.getBigUint64(8, true), slot: Math.max(a.slot, b.slot) };
}

/** A mark's leaf, as pool-deposit.ts's verdict reads it: its label the label tree's leaf nonce - 1, and the commitment
 *  Poseidon(value, label, precommitment) a leaf of the state tree, once. */
async function leafOf(sync: SolanaTreeSync, scope: bigint, precommitment: bigint, m: Mark): Promise<Leaf> {
  if (m.nonce === 0n) return no();
  const leaves = await sync.leaves(m.slot);
  const label = vaultLabelOf(keccak_256, scope, m.nonce);
  if (leaves.label[Number(m.nonce - 1n)] !== label) return no();
  const commitment = noteCommitment(m.value, label, precommitment);
  const at = leaves.state.indexOf(commitment);
  if (at < 0 || leaves.state.indexOf(commitment, at + 1) >= 0) return no();
  return { value: m.value, label, commitment, leafIndex: BigInt(at) };
}

/** A sell's note (card signpage-pool-sell): W's return note or one of its R second arrivals. */
const sellRef = (ref: NoteRef): boolean => ref.kind === "return" || (ref.kind === "second" && ref.id.id === "R");

type SellEnd = "filled" | "taken" | "dropped" | "pending";
/**
 * A sell's INCOMING note, read once, as the run's verdict reads it (the chain's word on its mark, never an RPC's tx
 * history alone): both RPCs' finalized height first, then the mark at finalized. The mark on both: the note goes
 * UNSPENT with its leaf, "filled" when its value is the send's, else "taken" (a deposit of another value used the
 * precommitment first: the user's own note all the same, since only the seed names it, and the sell can never land).
 * No mark on either and both past the send's last valid height, or `dead` (the transaction failed on both, so nothing
 * moved): the send is dropped, the note PLANNED again for the next sell of this W ("dropped"). Else "pending".
 */
async function settleSellNote(rpcs: Rpcs, program: string, scope: bigint, sync: SolanaTreeSync, store: NoteStore, n: NoteRecord, dead = false): Promise<{ end: SellEnd; signature: string | null }> {
  const send = n.sends?.at(-1);
  const signature = send?.signature ?? null;
  // no send: a page closed between an adoption's two moves; nothing was sent with it, so it is past at once
  const past = dead || send === undefined || (await pastOnBoth(rpcs, Number(send.last_valid_block_height)));
  const m = await markOf(rpcs, program, n.precommitment).catch(() => "one" as const);
  if (m !== null && m !== "one") {
    const leaf = await leafOf(sync, scope, n.precommitment, m).catch(() => null);
    if (leaf === null) return { end: "pending", signature };
    await store.move(n.id, "INCOMING", "UNSPENT", { leaf });
    return { end: send !== undefined && m.value === send.value ? "filled" : "taken", signature };
  }
  if (m === null && past) {
    await store.move(n.id, "INCOMING", "PLANNED");
    return { end: "dropped", signature };
  }
  return { end: "pending", signature };
}

/** The stage a settled sell answers: its transaction failed on both (`dead`), or the chain's word on its note. */
const stageOf = (end: Exclude<SellEnd, "pending">, dead: boolean): TradeStage => (end === "filled" ? "filled" : dead ? "refused" : "not_landed");

/**
 * The note the sale's deposit makes: W's return note, then its R second arrivals in order; the first that has not
 * landed and whose mark is on neither RPC, with its PLANNED record when the store holds one (a sell that never
 * landed). A mark on both for one the store does not hold as landed is the user's own note, stored UNSPENT with its
 * leaf; on one RPC only: failed. An INCOMING one (a sell a closed page sent) is settled first: still landing, failed.
 */
async function returnNote(rpcs: Rpcs, program: string, scope: bigint, store: NoteStore, sync: SolanaTreeSync, seed64: Uint8Array, l: bigint, j: number, settled?: (signature: string, stage: TradeStage) => void): Promise<{ ref: NoteRef; precommitment: bigint; planned: string | null }> {
  const held = new Map((await store.list()).map((n) => [refKey(n.ref), n]));
  for (let n = -1; n <= U32; n++) {
    const ref: NoteRef = n < 0 ? { kind: "return", c: "sol", l, j } : { kind: "second", id: { id: "R", c: "sol", l, j }, n };
    const precommitment = noteSecrets(seed64, ref).precommitment;
    const h = held.get(refKey(ref));
    if (h !== undefined && (h.precommitment !== precommitment || h.scope !== scope)) return no();
    if (h?.state === "INCOMING") {
      const got = await settleSellNote(rpcs, program, scope, sync, store, h);
      if (got.end === "pending") return no();
      if (got.signature !== null) settled?.(got.signature, stageOf(got.end, false));
      if (got.end === "dropped") return { ref, precommitment, planned: h.id };
      continue;
    }
    if (h !== undefined && h.state !== "PLANNED") continue;
    const m = await markOf(rpcs, program, precommitment);
    if (m === null) return { ref, precommitment, planned: h?.id ?? null };
    if (m === "one") return no();
    const leaf = await leafOf(sync, scope, precommitment, m);
    if (h === undefined) await store.add({ ref, scope, precommitment, state: "UNSPENT", leaf });
    else await store.move((await store.move(h.id, "PLANNED", "INCOMING")).id, "INCOMING", "UNSPENT", { leaf });
  }
  return no();
}

/**
 * Settles the sells a closed or reloaded page left INCOMING (on load and at each state read, src/pool-testnet.ts):
 * each of the pool's INCOMING return and R notes read once by the run's own verdict rules. Under the sell lock, so it
 * never reads a note a running sell holds; one that is running is skipped (that run settles its own note).
 */
export async function settlePoolSells(h: Pick<PoolSellHost, "pin" | "rpcs" | "notes" | "settled">, locks: Locks | null = globalThis.navigator?.locks ?? null): Promise<void> {
  if (!locks) return;
  await locks.request(POOL_SELL_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const program = h.pin.program;
    const { scope } = solanaPoolOf(program);
    const store = await h.notes();
    const sync = solanaTreeSync(h.rpcs, program);
    for (const n of await store.list()) {
      if (n.state !== "INCOMING" || n.scope !== scope || !sellRef(n.ref)) continue;
      const got = await settleSellNote(h.rpcs, program, scope, sync, store, n).catch(() => ({ end: "pending" as const, signature: null }));
      if (got.end !== "pending" && got.signature !== null) h.settled?.(got.signature, stageOf(got.end, false));
    }
  });
}

/** One pool.sell: the ask is the user's own (rules/pool.ts checkPoolRequest passed it, with the token's decimals). */
export async function runPoolSell(h: PoolSellHost, ask: PoolAsk): Promise<PoolSellAnswer> {
  const seeds: Uint8Array[] = [];
  let key: Uint8Array | null = null;
  const seed = async (): Promise<Uint8Array> => {
    const s = await h.seed64();
    seeds.push(s);
    return s;
  };
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  try {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || ask.token === null) return no("not_allowed");
    const token = ask.token;
    const amount = ask.amount;
    // W: the smallest holding of the token that covers the amount, not frozen; the pick reads nothing
    const held = (x: BuyWallet) => x.holdings.tokens.get(token);
    const w = (await h.wallets())
      .filter((x) => x.chain === "sol" && held(x) !== undefined && !held(x)!.frozen && held(x)!.amount >= amount)
      .sort((x, y) => (held(x)!.amount < held(y)!.amount ? -1 : held(x)!.amount > held(y)!.amount ? 1 : 0))[0];
    if (w === undefined) return no("not_funded");
    // the pin, read once for every read and the build; the rule reads the page's pin again at the check
    const program = h.pin.program;
    const { pool, scope } = solanaPoolOf(program);
    const rpcs = h.rpcs;
    // the gating reads, each on both RPCs
    const rent: SolanaRent = await readSolanaRent(rpcs);
    const sizes = await treeSizes(rpcs, program, pool, wait);
    const tokens = await tokenHeld(rpcs, w.address, token);
    if (tokens.amount < amount) return no("not_funded");
    const lamports = lower(...(await both(rpcs, async (r) => {
      const a = await account(r, w.address, "confirmed");
      return "none" in a ? 0n : a.lamports;
    })));
    // W pays the sell's fee before anything runs, and must hold what the sell makes before any proceeds arrive (the
    // kit's solanaPoolSellNeed): short of the cheaper venue's need, no venue can take it, refused before any other read
    if (lamports < solanaPoolSellNeed("pump-curve", rent)) return no("not_funded");
    // the note the deposit makes; the seed copy for its precommitment is zeroed at once
    const store = await h.notes();
    const sync = solanaTreeSync(rpcs, program);
    const s = await seed();
    const { ref, precommitment, planned } = await returnNote(rpcs, program, scope, store, sync, s, w.l, w.j, h.settled);
    s.fill(0);
    // last, the reads the quote's age counts from: the reference, its venue, then the device's blockhash and slot
    const reference = await readSolanaReference(rpcs, { side: "sell", token, amount });
    const best = reference?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
    if (!reference || !best) return no("quote_check_failed");
    const venue = await readSolanaPoolBuyVenue(rpcs, best.venue as "pump-curve" | "pumpswap", token, ...(h.pick ? [h.pick] : []));
    if (venue.tokenProgram !== tokens.program) return no();
    // the venue's own need up front (PumpSwap: the wrapped-SOL account its sell makes first), before anything is built
    if (lamports < solanaPoolSellNeed(venue.kind, rent)) return no("not_funded");
    const bh = await blockhashOf(rpcs);
    const quote = { amount, ref: reference, slippageBps: ask.slippageBps };
    let minOut: bigint;
    try {
      minOut = solanaPoolSellMinOut(venue, amount, quote, bh.slot);
    } catch {
      return no("quote_check_failed");
    }
    // the transaction: the venue's sell, then last the deposit of `value` with the note's precommitment, W the payer
    const steps = solanaPoolSellSteps(venue, w.address, amount, minOut);
    const pre = be32(precommitment);
    const build = (value: bigint): { message: Uint8Array; wire: Uint8Array } => {
      const deposit = {
        program,
        accounts: [
          { key: pool, signer: false, writable: true },
          { key: w.address, signer: true, writable: true },
          { key: solanaPoolPage(program, 0, sizes.stateSize), signer: false, writable: true },
          { key: solanaPoolPage(program, 1, sizes.labelSize), signer: false, writable: true },
          { key: solanaProgramAddress([enc.encode("pre"), pre], program), signer: false, writable: true },
          { key: SOLANA_SYSTEM_PROGRAM, signer: false, writable: false },
        ],
        data: Uint8Array.of(1, ...u64le(value), ...pre),
      };
      const { message } = solanaCompileV0(w.address, [...steps, deposit], bh.blockhash, []);
      const wire = new Uint8Array(1 + 64 + message.length);
      wire[0] = 1;
      wire.set(message, 65);
      return { message, wire };
    };
    // the fee both RPCs price the message at: per signature, with no compute budget, so the deposit's value (the one
    // thing the reserve changes) changes nothing it prices
    const [fa, fb] = await both(rpcs, async (r) => BigInt(int(((await r("getFeeForMessage", [base64.encode(build(minOut).message), { commitment: "confirmed" }])) as { value?: unknown })?.value)));
    if (fa !== fb) return no();
    // the need again at the fee both RPCs price this very message at
    if (lamports < solanaPoolSellNeed(venue.kind, rent) - SOLANA_POOL_SELL_FEE + fa) return no("not_funded");
    const grow = (size: number): bigint => (size % PAGE_ENTRIES === 0 ? solanaRentMin(rent, PAGE_HEADER + PAGE_ENTRY) : BigInt(PAGE_ENTRY) * rent.lamportsPerByte * rent.factor);
    const short = fa + solanaRentMin(rent, PRE_MARK_LEN) + grow(sizes.stateSize) + grow(sizes.labelSize) + solanaRentMin(rent, 0) - lamports;
    const reserve = short > 0n ? short : 0n;
    if (reserve > SOLANA_POOL_SELL_RESERVE_MAX || reserve >= minOut) return no("quote_check_failed");
    const value = minOut - reserve;
    const { wire } = build(value);
    const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: w.address, feeCap: 0n, solana: h.pin, precommitment };
    checkSolanaSell(wire, ask, ctx, venue, quote, bh.slot, { blockhash: bh.blockhash, tables: {}, stateSize: sizes.stateSize, labelSize: sizes.labelSize }, reserve);
    // unsigned: an RPC cannot send what it simulates
    const sims = await both(rpcs, async (r) => ((await r("simulateTransaction", [base64.encode(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }])) as { value?: { err?: unknown } } | null)?.value);
    if (!sims.every((v) => v !== undefined && v !== null && v.err === null)) return no();
    // W, from the seed, right before it signs: it must be the W the bytes were built and checked for
    const fw = freshWallet(await seed(), "sol", w.l, w.j);
    key = fw.secretKey;
    for (const x of seeds) x.fill(0);
    if (fw.address !== w.address) return no();
    const sig = signSolana(key, wire);
    key.fill(0);
    key = null;
    const signed = wire.slice();
    signed.set(sig, 1);
    const signature = base58.encode(sig);
    // written before the signed transaction leaves the device: the note INCOMING with W's send, so a page closed or
    // reloaded from here on leaves a record its next load settles (settlePoolSells) by the same verdict rules
    const id = planned ?? (await store.add({ ref, scope, precommitment, state: "PLANNED" })).id;
    const note = await store.move(id, "PLANNED", "INCOMING", { send: { signature, value, last_valid_block_height: BigInt(bh.lastHeight) } });
    h.signed?.(signature);
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.sent?.(signature);
    const txs: TxRef[] = [{ chain: "solana", hash: signature }];
    // the verdict: the chain's word on the note's mark, never an RPC's tx history alone
    const reads = h.reads ?? POOL_SELL_READS;
    for (let i = 0; i < reads; i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      const got = await both(rpcs, (r) => readBack(r, signature, signed)).catch(() => ["none", "none"] as const);
      // this very transaction failed on chain, on both RPCs: the sale and the deposit are one, nothing moved
      const dead = got[0] === "failed" && got[1] === "failed";
      const { end } = await settleSellNote(rpcs, program, scope, sync, store, note, dead);
      if (end !== "pending") return { stage: stageOf(end, dead), txs };
      // failed on both, its note's mark on one RPC only: refused; the note settles at the next load or sell
      if (dead) return { stage: "refused", txs };
    }
    return { stage: "sent", txs };
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    return { error: "failed" };
  } finally {
    for (const x of seeds) x.fill(0);
    key?.fill(0);
  }
}

type Locks = Pick<LockManager, "request">;

/** A pool sell's ops record (src/state.ts's op contract: nothing secret), keyed by its request's id: kind "sell", as
 *  the app reads a trade's; `pool` marks it as this kind's, so the settle on load finds it by its transaction. */
type SellOp = { kind: "sell"; pool: "sol"; sha: string; stage: "pending" | TradeStage; txs: TxRef[]; code?: ErrorCode; created_ms: number };

/** What the kind needs beyond a run's host: the wallet store its ops records go in, and the end of the run. */
export type PoolSellKindHost = PoolSellHost & { ops(): Promise<TradeStore>; end?(): void; storeMs?: number };

/** Writes a settled sell's stage to the pool sell record that names its transaction (one a closed page left "signed"
 *  or "sent"); a record already at an end stays. */
export async function settleSellOps(ops: TradeStore, signature: string, stage: TradeStage): Promise<void> {
  for (const k of await ops.keys("ops")) {
    const rec = (await ops.get("ops", k)) as Partial<SellOp> | undefined;
    if (rec?.kind !== "sell" || rec.pool !== "sol" || rec.txs?.[0]?.hash !== signature || (rec.stage !== "signed" && rec.stage !== "sent")) continue;
    await ops.update("ops", k, (v) => ({ ...(v as SellOp), stage }));
  }
}

/**
 * The pool.sell kind: one run per tap under the seed's shared lock (a sign out, in any tab, waits for it), the
 * request's own lock (the same id in another tab at once: id_reused) and POOL_SELL_LOCK, answered at the send (W's
 * signature) or at the run's end, then its stage as it comes. Its ops record is written first, under the sell lock, as
 * trade.ts writes a trade's: an id seen before (a reload, a retry after client_timeout) is answered from its record and
 * never runs twice, and the app reads the running sell's stage in state.ops: "signed" with W's signature before the
 * send, "sent", then its end (a closed page's end is written by the settle on load, settleSellOps).
 */
export function poolSellKind(host: () => PoolSellKindHost, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.sell"> => {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || !locks || !ctx) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(tradeLock(ctx.id), { mode: "exclusive", ifAvailable: true }, async (own) => {
          if (!own) return void (answer ??= { error: "id_reused" });
          await locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, async () => {
            const h = host();
            try {
              const ms = h.storeMs ?? TRADE_STORE_MS;
              const ops = timedStore(await h.ops(), ms);
              // the record first: an id seen before is answered from it, never run again
              const prior = await ops.get("ops", ctx.id);
              if (prior !== undefined) return void (answer ??= fromRecord(prior, ctx.sha) as HostAnswer<"pool.sell"> | HostRefusal);
              const op: SellOp = { kind: "sell", pool: "sol", sha: ctx.sha, stage: "pending", txs: [], created_ms: Number(h.now?.() ?? BigInt(Date.now())) };
              await ops.put("ops", ctx.id, { ...op });
              let writes: Promise<void> = Promise.resolve();
              const write = (patch: Partial<SellOp>): void => {
                Object.assign(op, patch);
                const snap = { ...op, txs: op.txs.map((t) => ({ ...t })) };
                writes = writes.then(() => ops.put("ops", ctx.id, snap)).catch(() => {});
              };
              const txs = (signature: string): TxRef[] => [{ chain: "solana", hash: signature }];
              const a = await runPoolSell({
                ...h,
                signed: (signature) => write({ stage: "signed", txs: txs(signature) }),
                sent: (signature) => {
                  write({ stage: "sent", txs: txs(signature) });
                  if (!answer) answer = { result: { stage: "sent", txs: txs(signature) } };
                  give();
                },
                settled: (signature, stage) => void (writes = writes.then(() => settleSellOps(ops, signature, stage)).catch(() => {})),
              }, ask);
              if ("error" in a) write({ stage: "refused", code: a.error });
              else write({ stage: a.stage, txs: a.txs });
              await writes;
              if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
              else if ("stage" in a) ctx.progress(a.stage);
            } finally {
              h.end?.();
            }
          });
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
