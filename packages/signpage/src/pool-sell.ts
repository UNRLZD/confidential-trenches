// pool.sell on the Solana pool (card signpage-pool-sell): one tap sells a token a buy's fresh wallet W holds on its venue,
// and the same transaction, signed by W alone, puts what the sale gives back into the pinned pool as a note of the
// user's own; the note is stored only once both RPCs show its deposit.
//
// - W: one of the page's buy wallets (../../wallet/src/pool/buy-wallets.ts BuyWallet: its l, j, address and holdings),
//   the one holding the token, not frozen, with the smallest holding that covers the amount. The pick reads nothing;
//   none: not_funded with no read at all.
// - The gating reads, each on both RPCs: the Rent sysvar; the pool account (the same bytes on both, read again once
//   when they differ: a leaf landed between the two reads) for its trees' sizes; the token's mint (its owner, the token
//   program, the same on both) and W's associated token account under it (the kit's solanaDecodeTokenAccount: W's, of
//   the token; the lower of the two amounts must cover the amount, else not_funded; frozen: not_allowed); W's lamports,
//   the lower of the two.
// - The return note: the first of W's return note (return, c "sol", l, j) and its second arrivals (R, n = 0, 1, ...)
//   that the store does not hold and whose precommitment mark is on neither RPC (at finalized). A mark on both RPCs for
//   a ref the store does not hold is the user's own note (its precommitment comes from the seed, so no one else can
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
// - Sent on both RPCs. W pays the fee, so the tx id is W's own signature: the kind answers with it. The verdict reads,
//   a second apart: both RPCs' finalized height first; this very transaction failed on both (the sale and the deposit
//   are one transaction, so nothing moved): refused; the mark on both at finalized with the deposit's value and its
//   leaf in the state tree: the note stored UNSPENT, filled; no mark of that value on either RPC and both past the
//   blockhash's last valid height: not_landed; past the reads: "sent", nothing stored (the next sell adopts its mark,
//   the restore finds it).
// - Every RPC answer is hostile and parsed strictly. Every read names a public account or the transaction itself, one
//   wallet of the user's at most; no request carries a key or the words. Nothing here logs.
import { base58, base64 } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { readSolanaPoolBuyVenue, readSolanaRent, solanaPoolPage, solanaPoolSellMinOut, solanaPoolSellSteps, solanaRentMin, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference, solanaDecodeTokenAccount } from "../../kit/src/trade/solana/pool.ts";
import { solanaAta, solanaProgramAddress } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_SYSTEM_PROGRAM, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { refKey, type Leaf, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { BuyWallet } from "../../wallet/src/pool/buy-wallets.ts";
import { solanaPoolOf, solanaTreeSync, type SolanaPoolPin, type SolanaTreeSync } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { blockhashOf, pastOnBoth, readBack } from "./pool-buy.ts";
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
  /** The transaction was sent: W's signature. */
  sent?(signature: string): void;
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

/** The note the sale's deposit makes: W's return note, then its R second arrivals in order; the first the store does
 *  not hold and whose mark is on neither RPC. A mark on both for one the store does not hold is the user's own note,
 *  stored UNSPENT with its leaf; on one RPC only: failed. */
async function returnNote(rpcs: Rpcs, program: string, scope: bigint, store: NoteStore, sync: SolanaTreeSync, seed64: Uint8Array, l: bigint, j: number): Promise<{ ref: NoteRef; precommitment: bigint }> {
  const held = new Set((await store.list()).map((n) => refKey(n.ref)));
  for (let n = -1; n <= U32; n++) {
    const ref: NoteRef = n < 0 ? { kind: "return", c: "sol", l, j } : { kind: "second", id: { id: "R", c: "sol", l, j }, n };
    if (held.has(refKey(ref))) continue;
    const precommitment = noteSecrets(seed64, ref).precommitment;
    const m = await markOf(rpcs, program, precommitment);
    if (m === null) return { ref, precommitment };
    if (m === "one") return no();
    await store.add({ ref, scope, precommitment, state: "UNSPENT", leaf: await leafOf(sync, scope, precommitment, m) });
  }
  return no();
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
    // the note the deposit makes; the seed copy for its precommitment is zeroed at once
    const store = await h.notes();
    const sync = solanaTreeSync(rpcs, program);
    const s = await seed();
    const { ref, precommitment } = await returnNote(rpcs, program, scope, store, sync, s, w.l, w.j);
    s.fill(0);
    // last, the reads the quote's age counts from: the reference, its venue, then the device's blockhash and slot
    const reference = await readSolanaReference(rpcs, { side: "sell", token, amount });
    const best = reference?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
    if (!reference || !best) return no("quote_check_failed");
    const venue = await readSolanaPoolBuyVenue(rpcs, best.venue as "pump-curve" | "pumpswap", token, ...(h.pick ? [h.pick] : []));
    if (venue.tokenProgram !== tokens.program) return no();
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
    await Promise.allSettled(rpcs.map((r) => r("sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed" }])));
    h.sent?.(signature);
    const txs: TxRef[] = [{ chain: "solana", hash: signature }];
    // the verdict: the chain's word on the note's mark, never an RPC's tx history alone
    const reads = h.reads ?? POOL_SELL_READS;
    for (let i = 0; i < reads; i++) {
      if (i > 0) await wait(POOL_SELL_WAIT_MS);
      const past = await pastOnBoth(rpcs, bh.lastHeight); // before the mark: a deposit final by then is in its read
      const got = await both(rpcs, (r) => readBack(r, signature, signed)).catch(() => ["none", "none"] as const);
      // this very transaction failed on chain, on both RPCs: the sale and the deposit are one, nothing moved
      if (got[0] === "failed" && got[1] === "failed") return { stage: "refused", txs };
      const m = await markOf(rpcs, program, precommitment).catch(() => "one" as const);
      if (m !== null && m !== "one" && m.value === value) {
        // only now, both RPCs showing the deposit and its leaf: the note is stored
        const leaf = await leafOf(sync, scope, precommitment, m).catch(() => null);
        if (leaf === null) continue;
        await store.add({ ref, scope, precommitment, state: "UNSPENT", leaf });
        return { stage: "filled", txs };
      }
      // no mark of this deposit on either RPC, and none can land after: not landed
      if (past && (m === null || (m !== "one" && m.value !== value))) return { stage: "not_landed", txs };
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

/** The pool.sell kind: one run per tap under the seed's shared lock (a sign out, in any tab, waits for it) and
 *  POOL_SELL_LOCK, answered at the send (W's signature) or at the run's end, then its stage as it comes. */
export function poolSellKind(host: () => PoolSellHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.sell"> => {
    if (ask.kind !== "pool.sell" || ask.chain !== "solana" || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.sell"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, () =>
        locks.request(POOL_SELL_LOCK, { mode: "exclusive" }, async () => {
          const h = host();
          try {
            const a = await runPoolSell({ ...h, sent: (signature) => {
              if (!answer) answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } };
              give();
            } }, ask);
            if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
            else if ("stage" in a) ctx?.progress(a.stage);
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
