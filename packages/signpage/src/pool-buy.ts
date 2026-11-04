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
//   on the other. The lookup table is the pin's, read on both.
// - Built by the kit (buildSolanaPoolBuy), checked by the rule (rules/pool.ts checkSolanaBuy: the request is the ask's,
//   then every byte), signed by W only through signSolana (it signs nothing a check did not pass). W is derived here
//   from the seed (freshWallet, l and j of the note) right before it signs, and must be the proof's recipient; its key
//   and the seed are zeroed when the run ends.
// - The order, so the quote is fresh when W signs (the check refuses a reference over 25 slots behind the device's own
//   slot): the rent, the table, the trees' sizes and the root indexes of every ready proof first; then the reference,
//   the venue and the blockhash (its slot); then the pick, from the ready proofs read again, filtered and claimed in one
//   turn; then build, check and sign. A proof remade meanwhile onto a root not yet found runs the reads once more.
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
//   transaction) and can never land: refused. A send the helper refused or never answered, a signature that is not
//   one, another transaction under it on both RPCs, or none read back: the signed transaction may still land, so the
//   answer is not_landed only once both RPCs' finalized height is past the blockhash's last valid one (the higher of
//   RPC 0's word and RPC 1's height + 151) and the note's settle still finds no spend; a spend found first is filled,
//   and past the reads it is "sent".
// - Spent: only then is the note settled through the wallet's one place for it (solanaSettleSpent: the spent mark and
//   the change leaf read on two RPCs, the change written UNSPENT naming the note, which goes SPENT). That SPENT note is
//   W's record: the buy wallets list (../../wallet/src/pool/buy-wallets.ts spentNotesOf) finds W and reads its holdings.
//   Not settled within the reads (or not landed, or refused): the note stays RESERVED, and each state read of the page
//   settles it (../../wallet/src/pool/solana-restore.ts solanaSettleReserved: SPENT once its spent mark and change read
//   on both RPCs, UNSPENT once both RPCs' block time is past its deadline with no spent mark, so the queue proves it
//   again).
// - Every read names a public account or the transaction itself; no request carries a key, the words or which note is
//   whose. Nothing here logs.
import { base58, base64 } from "@scure/base";
import {
  buildSolanaPoolBuy,
  readSolanaPoolBuyVenue,
  readSolanaRent,
  solanaPoolAccount,
  solanaPoolBuyFunds,
  solanaPoolFee,
  solanaPoolPage,
  solanaPoolPriorityBudget,
  SOLANA_POOL_BUY_CU,
  type SolanaPoolBuyRequest,
  type SolanaPoolBuyVenue,
  type SolanaPoolRelease,
  type SolanaRent,
} from "../../kit/src/trade/solana/pool-buy.ts";
import { readSolanaReference } from "../../kit/src/trade/solana/pool.ts";
import { solanaDecodeLookupTable, type SolanaLookupTable } from "../../kit/src/checks/solana/message.ts";
import { SOLANA_CU_PRICE_MAX, SOLANA_JITO_TIP_MIN } from "../../kit/src/checks/solana/checks.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { VaultSnarkjsProof } from "../../kit/src/vault/shapes.ts";
import type { TradeStage, TxRef } from "../../kit/src/signpage/messages.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import type { ReadyProof } from "../../wallet/src/pool/pool.ts";
import { solanaContextOf, solanaPoolOf, type SolanaPoolPin, type SolanaReleaseRequest } from "../../wallet/src/pool/solana.ts";
import { WALLET_SEED_LOCK } from "@blindfill/wallet/store";
import { checkSolanaBuy, PoolRuleRefused, signSolana, type PoolAsk } from "./rules/pool.ts";
import type { HostAnswer, HostRefusal, KindContext, Running } from "./api.ts";

/** What a buy run needs from the page. */
export type PoolBuyHost = {
  /** The pinned pool (the wallet's SOL_POOLS of this page's network). */
  pin: SolanaPoolPin;
  /** The pin's lookup table (the address every tag 3 loads its accounts from); none pinned: refused not_allowed. */
  table: string | null;
  cluster: "mainnet" | "devnet";
  /** Two RPCs of different operators. */
  rpcs: readonly [SolanaRpc, SolanaRpc];
  /** The queue's ready proofs (never taken by reading them); the queue is opened first when it is not. */
  ready(): Promise<readonly ReadyProof<SolanaReleaseRequest>[]>;
  /** The queue's take of this attempt: HELD -> RESERVED, written before it returns; refused, the note HELD, when the
   *  note's ready proof is another attempt. */
  take(noteId: string, attempt: string): Promise<ReadyProof<SolanaReleaseRequest>>;
  /** The 64-byte seed; zeroed here when the run ends. */
  seed64(): Promise<Uint8Array>;
  /** POST /v1/pool/solana/send: the helper's answer as it came (hostile). */
  send(pool: string, tx: Uint8Array): Promise<unknown>;
  /** The wallet's solanaSettleSpent for this note: "spent" once its change is written and the note is SPENT. */
  settle(noteId: string): Promise<{ kind: "spent" | "unspent" }>;
  /** The device's clock, ms. */
  now?(): bigint;
  /** Read-back reads and the wait between them. */
  reads?: number;
  wait?(ms: number): Promise<void>;
  /** The transaction was sent: its signature (the helper's word until it reads back). */
  sent?(signature: string): void;
  /** The notes a run on this page has picked and not finished: a second tap picks another ready proof. */
  claimed?: Set<string>;
  /** Tests only: the venue's fee recipient and the Jito tip account, else random. */
  pick?: (n: number) => number;
};

export type PoolBuyAnswer = { stage: TradeStage; txs: TxRef[] } | { error: "not_allowed" | "not_funded" | "quote_check_failed" | "failed" };

/** Read-back reads a buy gets, a second apart: past a blockhash's life (~60 to 90 s) and a finalization. */
export const POOL_BUY_READS = 120;
export const POOL_BUY_WAIT_MS = 1_000;
/** Two providers a slot apart read the pool's state tree at two sizes: read again once, this long after. */
export const POOL_BUY_SIZE_RETRY_MS = 500;

const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024;
const POOL_LEN = 2179;
const POOL_DISC = /* @__PURE__ */ new TextEncoder().encode("bfpool01");
const TREE_LEN = 8 + 1 + 33 * 32;
const OFF_TREES = 49;

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
const beInt = (b: Uint8Array): bigint => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);
const dec = (s: unknown): bigint => (typeof s === "string" && /^(0|[1-9][0-9]{0,77})$/.test(s) ? BigInt(s) : no());
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const both = <T>(h: PoolBuyHost, f: (rpc: SolanaRpc) => Promise<T>): Promise<[T, T]> => Promise.all([f(h.rpcs[0]), f(h.rpcs[1])]);

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
async function treeSizes(h: PoolBuyHost, pool: string, wait: (ms: number) => Promise<void>): Promise<{ state: number; label: number; stateSize: number }> {
  try {
    return await treeSizesOnce(h, pool);
  } catch (e) {
    if (!(e instanceof SizeSkew)) throw e;
    await wait(POOL_BUY_SIZE_RETRY_MS);
    return treeSizesOnce(h, pool);
  }
}
class SizeSkew extends Refused {}
async function treeSizesOnce(h: PoolBuyHost, pool: string): Promise<{ state: number; label: number; stateSize: number }> {
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
async function rootIndex(h: PoolBuyHost, tree: 0 | 1, size: number, root: bigint): Promise<number> {
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
function releaseOf(r: ReadyProof<SolanaReleaseRequest>, pin: SolanaPoolPin, w: string, idx: { state: number; label: number }): SolanaPoolRelease {
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

/** The transaction under `signature` on one RPC: "none" (not seen yet), "ok", "failed" or "other" (not ours). */
export async function readBack(rpc: SolanaRpc, signature: string, signed: Uint8Array): Promise<"none" | "ok" | "failed" | "other"> {
  const r = (await rpc("getTransaction", [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as { transaction?: unknown; meta?: { err?: unknown } } | null;
  if (r === null) return "none";
  const t = r?.transaction;
  if (!Array.isArray(t) || t[1] !== "base64" || typeof t[0] !== "string") return "other";
  const got = base64.decode(t[0]);
  const want = signed.slice();
  want.set(base58.decode(signature), 1);
  if (!sameBytes(got, want)) return "other";
  if (r.meta === undefined || r.meta === null) return "other";
  return r.meta.err === null ? "ok" : "failed";
}

type Ready = ReadyProof<SolanaReleaseRequest>;
type Got = "none" | "ok" | "failed" | "other";

/** One pool.buy: the ask is the user's own (rules/pool.ts checkPoolRequest passed it). */
export async function runPoolBuy(h: PoolBuyHost, ask: PoolAsk): Promise<PoolBuyAnswer> {
  let seed: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let claim: string | null = null;
  const wait = h.wait ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  try {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || ask.token === null || h.table === null) no("not_allowed");
    const token = ask.token!;
    const pool = solanaPoolAccount(h.pin.program);
    const mine = (list: readonly Ready[]): Ready[] => list.filter((p) => p.wallet.chain === "sol" && !h.claimed?.has(p.noteId));
    // the ready proofs first: none (or every one held by another tap of this page) and no read is made
    if (mine(await h.ready()).length === 0) return no("not_funded");
    // the reads that do not age, each on both RPCs
    const rent: SolanaRent = await readSolanaRent(h.rpcs);
    const feeCap = solanaPoolFee(rent);
    const { table, reads: tables } = await tableOf(h, h.table!);
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
      const sizes = await treeSizes(h, pool, wait);
      for (const p of mine(await h.ready()))
        for (const [tree, size, root] of [[0, sizes.state, p.publicSignals[3]], [1, sizes.label, p.publicSignals[5]]] as const) {
          if (roots.has(rootKey(tree, root))) continue;
          roots.set(rootKey(tree, root), await rootIndex(h, tree, size, dec(root)).catch((e) => (e instanceof Refused ? null : Promise.reject(e))));
        }
      // last, the reads the quote's age counts from: the reference, its venue, then the device's blockhash and slot
      const ref = await readSolanaReference(h.rpcs, { side: "buy", token, amount: ask.amount });
      const best = ref?.pools.filter((p) => p.venue === "pump-curve" || p.venue === "pumpswap").sort((x, y) => (x.expectedOut > y.expectedOut ? -1 : 1))[0];
      if (!ref || !best) return no("quote_check_failed");
      const venue: SolanaPoolBuyVenue = await readSolanaPoolBuyVenue(h.rpcs, best.venue as "pump-curve" | "pumpswap", token, ...(h.pick ? [h.pick] : []));
      const bh = await blockhashOf(h.rpcs);
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
      claim = r.noteId;
      h.claimed?.add(claim);
      const release = releaseOf(r, h.pin, r.wallet.address, indexOf(r)!);
      // the most the relay fee's priority budget pays, never over the kit's CU price cap
      const budget = (solanaPoolPriorityBudget(rent, release.relayFee) * 1_000_000n) / BigInt(SOLANA_POOL_BUY_CU[venue.kind]);
      const cuPrice = budget < SOLANA_CU_PRICE_MAX ? budget : SOLANA_CU_PRICE_MAX;
      const req: SolanaPoolBuyRequest = { wallet: r.wallet.address, feePayer: h.pin.feePayer, token, spend: ask.amount, minOut, tip, cuPrice, cluster: h.cluster };
      const cfg = { program: h.pin.program, pool };
      const built = buildSolanaPoolBuy(cfg, release, venue, req, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, table: { address: h.table!, table }, stateSize: sizes.stateSize, rent }, h.pick ? { pick: h.pick } : {});
      // the device's own fee cap: the epoch fee from the Rent sysvar it read, never the binding's word
      const ctx = { nowMs: h.now?.() ?? BigInt(Date.now()), wallet: r.wallet.address, feeCap, solana: h.pin };
      checkSolanaBuy(built.wire, ask, ctx, release, venue, req, { blockhash: bh.blockhash, slot: bh.slot, tables, stateSize: sizes.stateSize, rent, reference: { amount: ask.amount, ref, slippageBps: ask.slippageBps } });
      // W, from the seed, right before it signs: it must be the proof's recipient the bytes were built and checked for
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
      return await sendAndSettle(h, r, release, pool, signed, bh.lastHeight, wait);
    }
  } catch (e) {
    if (e instanceof Refused) return { error: e.code };
    if (e instanceof PoolRuleRefused) return { error: "quote_check_failed" };
    return { error: "failed" };
  } finally {
    seed?.fill(0);
    key?.fill(0);
    if (claim !== null) h.claimed?.delete(claim);
  }
}

/** The take, the send, the read-back on both RPCs and the settle; every answer but filled tries the settle first. */
async function sendAndSettle(h: PoolBuyHost, r: Ready, release: SolanaPoolRelease, pool: string, signed: Uint8Array, lastHeight: number, wait: (ms: number) => Promise<void>): Promise<PoolBuyAnswer> {
  // the take, awaited before anything leaves: the queue hands out this very attempt, or refuses with the note HELD
  const taken = await h.take(r.noteId, r.attempt);
  if (taken.attempt !== r.attempt || !sameBytes(solanaProofBytes(taken.proof), release.proof)) return no();
  const reads = h.reads ?? POOL_BUY_READS;
  const spent = async (): Promise<boolean> => (await h.settle(r.noteId).catch(() => ({ kind: "unspent" as const }))).kind === "spent";
  // the chain's word on the note (its spent mark and change on both RPCs) over the helper's or one RPC's: spent is
  // filled, shown with the helper's signature only when it read back as this transaction. not_landed only once both
  // RPCs' finalized height is past the blockhash's last one and the settle still finds no spend (the kit's rule: never
  // not_landed while the transaction may still land, packages/kit/src/trade/solana/flow.ts finishSolanaSet); until then
  // the reads go on, and past them the answer is "sent", the note RESERVED for the state reads' pass to settle or free
  const unlanded = async (txs: TxRef[]): Promise<PoolBuyAnswer> => {
    for (let i = 0; i < reads; i++) {
      if (i > 0) await wait(POOL_BUY_WAIT_MS);
      const past = await pastOnBoth(h.rpcs, lastHeight); // before the settle: a spend final by then is in its read
      if (await spent()) return { stage: "filled", txs };
      if (past) return { stage: "not_landed", txs };
    }
    return { stage: "sent", txs };
  };
  let answer: unknown;
  try {
    answer = await h.send(pool, signed);
  } catch {
    // the helper's error says nothing of the chain: a broken-in helper may answer 502 and send it anyway
    return unlanded([]);
  }
  const signature = (answer as { signature?: unknown } | null)?.signature;
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || base58.decode(signature).length !== 64) return unlanded([]);
  h.sent?.(signature);
  const txs: TxRef[] = [{ chain: "solana", hash: signature }];
  let landed = false;
  for (let i = 0; i < reads && !landed; i++) {
    if (i > 0) await wait(POOL_BUY_WAIT_MS);
    const got: readonly Got[] = await both(h, (rpc) => readBack(rpc, signature, signed)).catch((): Got[] => ["none", "none"]);
    // another transaction under that name on both RPCs: the helper's signature is not this one's
    if (got[0] === "other" && got[1] === "other") return unlanded([]);
    // this very transaction failed on chain, on both RPCs: it spent nothing, and it can never land again
    if (got[0] === "failed" && got[1] === "failed") return (await spent()) ? { stage: "filled", txs } : { stage: "refused", txs };
    landed = got[0] === "ok" && got[1] === "ok";
  }
  if (!landed) return unlanded(txs);
  // only now: the note SPENT, its change written (solanaSettleSpent reads the spent mark at finalized)
  for (let i = 0; i < reads; i++) {
    if (i > 0) await wait(POOL_BUY_WAIT_MS);
    const s = await h.settle(r.noteId).catch(() => ({ kind: "unspent" as const }));
    if (s.kind === "spent") return { stage: "filled", txs };
  }
  return { stage: "sent", txs };
}

type Locks = Pick<LockManager, "request">;

/** The pool.buy kind: one run per tap under the seed's shared lock (sign out waits for it), answered at the send (its
 *  signature) or at the run's end, then its stage as it comes. */
export function poolBuyKind(host: () => PoolBuyHost & { end?(): void }, locks: Locks | null = globalThis.navigator?.locks ?? null) {
  return (ask: PoolAsk, ctx: KindContext | null): HostRefusal | Running<"pool.buy"> => {
    if (ask.kind !== "pool.buy" || ask.chain !== "solana" || !locks) return { error: "not_allowed" };
    let answer: HostAnswer<"pool.buy"> | HostRefusal | null = null;
    let give!: () => void;
    const answered = new Promise<void>((r) => (give = r));
    const run = locks
      .request(WALLET_SEED_LOCK, { mode: "shared" }, async () => {
        const h = host();
        try {
          const a = await runPoolBuy({ ...h, sent: (signature) => {
            if (!answer) answer = { result: { stage: "sent", txs: [{ chain: "solana", hash: signature }] } };
            give();
          } }, ask);
          if (!answer) answer = "error" in a ? { error: a.error } : { result: a };
          else if ("stage" in a) ctx?.progress(a.stage);
        } finally {
          h.end?.();
        }
      })
      .catch(() => {
        if (!answer) answer = { error: "failed" };
      })
      .finally(give);
    void run;
    return { running: true, after: answered, answer: () => answer ?? { error: "failed" } };
  };
}
