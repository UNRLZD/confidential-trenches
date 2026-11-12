// What each filled Solana trade moved, from its own transaction (card portfolio-shows-pool-trades), on SIGN_HOST's
// top-level page: the token W got or sold (the op's units) and the SOL W paid into the venue or got out of it (the op's
// pool_amount, kit 1.10 OpDetail), so the app's Portfolio draws each round trip's result from the device's records.
//
// - Why from the transaction: a pool sale's deposit back is min out less W's reserve plus whatever W held (the change
//   the pool lent W beyond the buy comes back with it), so no record of the run holds what the venue paid; the chain's
//   record of the sale does. A buy's spend is the request's own (pool-testnet.ts writes it with the buy's op); a buy
//   recorded before (release 118 and earlier) gets it here too.
// - The read: getTransaction of each of the op's signatures at finalized, "json" encoding, on the helper's route alone
//   (pool-testnet.ts: the positions finder's reader). The figures are shown, never signed on, so one reader is enough,
//   and no read names a W or a signature of the user's to a public provider (wallet/src/pool/buy-wallets.ts). An answer
//   is refused unless its transaction's first signature is the one asked for, and a sale's W must be one of the op's
//   legs' wallets when the op names them. A read that fails or is refused writes nothing: the next run reads it again.
// - The rules, from the transaction's meta and its system instructions (top level and inner), W being the one owner
//   whose balance of the op's token rose (a buy) or fell (a sale):
//   - units: that change, at the token's decimals;
//   - a sale's SOL out of the venue: W's lamports after less before, plus the fee when W paid it, plus every lamport W
//     paid out by a system transfer, plus the rent of each account W created that is still open after the transaction
//     (the mark), less every lamport a system transfer paid W. What a program paid W without one (pump's curve, the close
//     of W's wrapped-SOL account) is the venue's. A PumpSwap sale creates W's wrapped-SOL account, takes the proceeds
//     into it and closes it in the same transaction: the close hands back its rent with the proceeds, so that account's
//     creation (closed: 0 lamports after) is not counted, or the sale would read 2,039,280 lamports high (review R1).
//     On 32CSJ1...Kwn (12 Nov) that is 574,635 lamports: the curve's 581,910 less pump's fees.
//   - a buy's SOL into the venue: every lamport W paid by a system transfer, its account creations (rent) apart. On
//     5Qn5Lt...vB8Q that is 1,205,887 lamports, the BuyExactSolIn spend. A PumpSwap buy (a graduated coin) pays wrapped
//     SOL (review of 776d40528, P2-2): W wraps by a system transfer into W's own wrapped-SOL account (one W's token
//     program initializes for the wrapped-SOL mint with W its owner, or one the meta lists as W's), the swap spends from
//     it by token transfers, and the close hands what is left back to W with the rent. So a transfer into W's own
//     wrapped-SOL account is no spend; the spend is the wrapped SOL moved out of it to others, less any moved into it.
//     On 4HSwog...Nd3 (12 Nov) that is 121,165 lamports: 121,043 to the pool and 122 in fees, all W wrapped. Any other
//     token instruction on W's wrapped-SOL account (an approve, a burn) makes the figure unknown.
//   Any other system instruction W signs (a transfer with seed, an allocate) makes the figure unknown: nothing is
//   written for it, never a guess.
// - amount_usd on a sale: its SOL out at the page's own pool price (src/pool-price.ts), only when the price was read
//   within PRICE_FRESH_MS and the sale is younger than SALE_USD_MS (usd_from "live"). An older sale (release 118's
//   records, or a fill that ran late) gets it at the SOL price of its own block instead (usd_from "block"): the page's
//   own SOL/USD feed (the kit's POOL_USD_FEEDS.solana, Pyth's sponsored account) is written on chain about each minute,
//   and each write carries Pyth's signed price message, which the push oracle checks before it writes. The newest write
//   before the sale (the account's getSignaturesForAddress before the sale's signature, then getTransaction of each
//   until a write, on the fill's one reader, the helper's route: src/pool-testnet.ts fillTrades) gives the price, taken
//   only when its publish time is within BLOCK_PRICE_S at or before the sale's block time and its confidence within the
//   feed's maxConfBps; else no USD, never a guess. On 32CSJ1...Kwn: $82.98770947 published 7 s before its block. usd_from stays on the device's record (the
//   state sends only src/state.ts's detail keys), so the two sources are never confused.
// - amount_usd on a buy whose record has none (a buy a restore rebuilt from W's history, src/sol-buy-records.ts): its
//   SOL in at its own block's price, by the same feed rule as an older sale's (usd_from "block").
// - Pool ops only: a buy with no `sha` (positions.ts recordPoolBuy; a trade-box buy carries its quote's sha, trade.ts)
//   and a sale with pool "sol". At most FILL_OPS_MAX ops a run, newest first, so a backlog cannot fan out at every trade
//   end. A sale younger than SALE_USD_MS with neither a fresh price nor its block's is left for the next run.
// - Written once per op, in one store update that keeps every other field and re-checks the op still wants it; an op
//   that has pool_amount is not read again. An op whose transactions were read, each its signature's own, and whose
//   figures are still unknown by these rules (no trade of its token, another wallet, a move these rules do not read)
//   gets `fill_none` instead when a restore rebuilt it (its key `restored/<signature>`), since a landed transaction
//   never changes, and is not read again either (review of 776d40528, P2-2: it took one of FILL_OPS_MAX each run for
//   good); this device's own op is never marked, so one answer it cannot read (a malformed or hostile one) never blanks
//   a real trade's figure for good (review of f73ee1c82, P3-a). A read that failed or was refused writes nothing.
//   Display only: nothing here feeds a signature.
import { base58 } from "@scure/base";
import type { PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";
import { usdOf } from "./positions.ts";
import { poolUnits } from "./rules/pool.ts";

const SYSTEM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** The token program's instructions on W's wrapped-SOL account that move no SOL out of W's reach: InitializeAccount (1,
 *  16, 18), CloseAccount (9, its lamports back to W: checked below), SyncNative (17), GetAccountDataSize (21),
 *  InitializeImmutableOwner (22). Transfer (3) and TransferChecked (12) are read; any other makes the figure unknown. */
const WSOL_QUIET = new Set([1, 9, 16, 17, 18, 21, 22]);
/** The page's price counts for a sale's USD only this fresh (its own read, ms). */
export const PRICE_FRESH_MS = 120_000;
/** A sale's USD is written only this soon after it: past it, the price now is not the sale's. */
export const SALE_USD_MS = 600_000;
/** A feed write prices a sale only when published at most this long before the sale's block (and not after it). */
export const BLOCK_PRICE_S = 60;
/** The most feed transactions read to find the write before one sale (the account's readers sit between its writes). */
export const FEED_READS_MAX = 40;
/** The most ops one run fills, newest first. */
export const FILL_OPS_MAX = 20;
const FEED = POOL_USD_FEEDS.solana;
const FEED_ID = Uint8Array.from(FEED.feedId.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
/** Pyth's price feed message: type 0, feed id, price, conf, exponent, publish time, previous publish time, EMA price and
 *  EMA conf, big-endian; length-prefixed (u32, little-endian) in the push oracle's update. */
const MESSAGE_LEN = 85;

type Ix = { programIdIndex?: unknown; accounts?: unknown; data?: unknown };
type TokenBalance = { accountIndex?: unknown; mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown; decimals?: unknown } };
type JsonTx = {
  meta?: { err?: unknown; fee?: unknown; preBalances?: unknown; postBalances?: unknown; preTokenBalances?: unknown; postTokenBalances?: unknown; innerInstructions?: unknown; loadedAddresses?: { writable?: unknown; readonly?: unknown } };
  transaction?: { message?: { accountKeys?: unknown; instructions?: unknown } };
} | null;

/** What one trade transaction moved for W: the token's base units and decimals, and W's lamports to or from the venue. */
export type TradeLeg = { wallet: string; units: bigint; decimals: number; lamports: bigint };

const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isSafeInteger(x) && (x as number) >= 0);
const u64 = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);

/** The token's change per owner, in base units, with its decimals; null when a balance entry is malformed. */
function tokenChanges(pre: unknown, post: unknown, token: string): Map<string, { delta: bigint; decimals: number }> | null {
  if (!Array.isArray(pre) || !Array.isArray(post)) return null;
  const out = new Map<string, { delta: bigint; decimals: number }>();
  for (const [list, side] of [[pre, -1n], [post, 1n]] as const) {
    for (const b of list as TokenBalance[]) {
      if (b?.mint !== token) continue;
      const amount = b.uiTokenAmount?.amount;
      const decimals = b.uiTokenAmount?.decimals;
      if (typeof b.owner !== "string" || typeof amount !== "string" || !/^\d{1,40}$/.test(amount) || !Number.isSafeInteger(decimals)) return null;
      const had = out.get(b.owner);
      out.set(b.owner, { delta: (had?.delta ?? 0n) + side * BigInt(amount), decimals: decimals as number });
    }
  }
  return out;
}

/** What a landed buy or sale of `token` moved for W, from its "json" getTransaction answer; null when it did not land,
 *  is not such a trade, or any figure is unknown (see the top). */
export function solanaTradeLeg(t: unknown, side: "buy" | "sell", token: string): TradeLeg | null {
  const tx = t as JsonTx;
  const meta = tx?.meta;
  const msg = tx?.transaction?.message;
  if (!meta || meta.err !== null || !msg || !strs(msg.accountKeys)) return null;
  const loaded = meta.loadedAddresses;
  const keys = [...msg.accountKeys, ...(loaded && strs(loaded.writable) ? loaded.writable : []), ...(loaded && strs(loaded.readonly) ? loaded.readonly : [])];
  if (!ints(meta.preBalances) || !ints(meta.postBalances) || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length) return null;
  const changes = tokenChanges(meta.preTokenBalances, meta.postTokenBalances, token);
  if (!changes) return null;
  // W: the one owner whose balance moved the trade's way, the most
  let w: string | null = null;
  let units = 0n;
  let decimals = 0;
  for (const [owner, c] of changes) {
    const d = side === "buy" ? c.delta : -c.delta;
    if (d > units) [w, units, decimals] = [owner, d, c.decimals];
  }
  if (w === null) return null;
  const wAt = keys.indexOf(w);
  if (wAt < 0) return null;
  // every system instruction, top level and inner
  const ixs: Ix[] = Array.isArray(msg.instructions) ? [...(msg.instructions as Ix[])] : [];
  if (Array.isArray(meta.innerInstructions)) for (const g of meta.innerInstructions as { instructions?: unknown }[]) if (Array.isArray(g?.instructions)) ixs.push(...(g.instructions as Ix[]));
  // W's wrapped-SOL accounts (see the top): listed as W's in the meta, or initialized here for the wrapped-SOL mint
  // with W its owner
  const wsol = new Set<string>();
  for (const b of [...(meta.preTokenBalances as TokenBalance[]), ...(meta.postTokenBalances as TokenBalance[])]) if (b?.mint === WSOL && b.owner === w && Number.isSafeInteger(b.accountIndex) && keys[b.accountIndex as number] !== undefined) wsol.add(keys[b.accountIndex as number]!);
  const tokenData = (ix: Ix): Uint8Array | null => {
    if (!Number.isSafeInteger(ix.programIdIndex) || keys[ix.programIdIndex as number] !== TOKEN || !ints(ix.accounts) || typeof ix.data !== "string") return null;
    try {
      return base58.decode(ix.data);
    } catch {
      return null;
    }
  };
  for (const ix of ixs) {
    const d = tokenData(ix);
    if (d === null || !ints(ix.accounts)) continue;
    const a = ix.accounts.map((i) => keys[i]);
    // InitializeAccount: account, mint, owner (an account); InitializeAccount2 and 3: account, mint, the owner in data
    const owner = d[0] === 1 ? a[2] : (d[0] === 16 || d[0] === 18) && d.length >= 33 ? base58.encode(d.subarray(1, 33)) : undefined;
    if (owner === w && a[1] === WSOL && a[0] !== undefined) wsol.add(a[0]);
  }
  // the wrapped SOL W's accounts paid to others, less what others paid into them
  let wsolOut = 0n;
  for (const ix of ixs) {
    const d = tokenData(ix);
    if (d === null || !ints(ix.accounts)) continue;
    const a = ix.accounts.map((i) => keys[i]);
    if (!a.some((k) => k !== undefined && wsol.has(k))) continue;
    if ((d[0] === 3 && d.length === 9) || (d[0] === 12 && d.length === 10)) {
      const [src, dst] = d[0] === 3 ? [a[0], a[1]] : [a[0], a[2]];
      const n = u64(d, 1);
      if (wsol.has(src!) && !wsol.has(dst!)) wsolOut += n;
      else if (wsol.has(dst!) && !wsol.has(src!)) wsolOut -= n;
    } else if (d[0] === 9) {
      // a close of W's wrapped-SOL account hands its lamports to W, or the figure is unknown
      if (wsol.has(a[0]!) && a[1] !== w) return null;
    } else if (!WSOL_QUIET.has(d[0]!)) return null;
  }
  let wrapped = 0n;
  let out = 0n;
  let rents = 0n;
  let into = 0n;
  for (const ix of ixs) {
    if (!Number.isSafeInteger(ix.programIdIndex) || keys[ix.programIdIndex as number] !== SYSTEM) continue;
    if (!ints(ix.accounts) || typeof ix.data !== "string") return null;
    let data: Uint8Array;
    try {
      data = base58.decode(ix.data);
    } catch {
      return null;
    }
    const from = keys[ix.accounts[0]!];
    const to = keys[ix.accounts[1]!];
    if (from !== w && to !== w) continue;
    const tag = data.length >= 4 ? new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) : -1;
    if (tag === 2 && data.length === 12) {
      const l = u64(data, 4);
      if (from === w && to !== w) {
        // a wrap into W's own wrapped-SOL account is no spend of a buy's (see the top)
        if (wsol.has(to!)) wrapped += l;
        else out += l;
      } else if (to === w && from !== w) into += l;
    } else if (tag === 0 && data.length === 52 && from === w) {
      // an account W made that the transaction also closed gave its rent back with the close: not paid out
      const at = keys.indexOf(to!);
      if (to === undefined || at < 0) return null;
      if (meta.postBalances[at]! > 0) rents += u64(data, 4);
    } else return null;
  }
  if (side === "buy") {
    const spent = out + wsolOut;
    return spent > 0n ? { wallet: w, units, decimals, lamports: spent } : null;
  }
  const fee = wAt === 0 && Number.isSafeInteger(meta.fee) ? BigInt(meta.fee as number) : 0n;
  const delta = BigInt(meta.postBalances[wAt]!) - BigInt(meta.preBalances[wAt]!);
  const got = delta + fee + out + wrapped + rents - into;
  return got > 0n ? { wallet: w, units, decimals, lamports: got } : null;
}

/** A feed write's signed SOL/USD (see the top), with the write's block time. */
export type FeedPrice = { price: bigint; conf: bigint; expo: number; publishedS: number; blockS: number };

/** The SOL/USD a landed transaction wrote to the page's feed through the push oracle, from its own price message; null
 *  for any other transaction, one that failed, or a message that is not the feed's. */
export function feedWritePrice(t: unknown): FeedPrice | null {
  const tx = t as (JsonTx & { blockTime?: unknown }) | null;
  const meta = tx?.meta;
  const msg = tx?.transaction?.message;
  if (!meta || meta.err !== null || !msg || !strs(msg.accountKeys) || !Number.isSafeInteger(tx?.blockTime)) return null;
  const loaded = meta.loadedAddresses;
  const keys = [...msg.accountKeys, ...(loaded && strs(loaded.writable) ? loaded.writable : []), ...(loaded && strs(loaded.readonly) ? loaded.readonly : [])];
  const ixs: Ix[] = Array.isArray(msg.instructions) ? [...(msg.instructions as Ix[])] : [];
  if (Array.isArray(meta.innerInstructions)) for (const g of meta.innerInstructions as { instructions?: unknown }[]) if (Array.isArray(g?.instructions)) ixs.push(...(g.instructions as Ix[]));
  let found: FeedPrice | null = null;
  for (const ix of ixs) {
    if (!Number.isSafeInteger(ix.programIdIndex) || keys[ix.programIdIndex as number] !== FEED.pushOracle || typeof ix.data !== "string") continue;
    // the write names the feed's account
    if (!ints(ix.accounts) || !ix.accounts.some((a) => keys[a] === FEED.account)) continue;
    let d: Uint8Array;
    try {
      d = base58.decode(ix.data);
    } catch {
      continue;
    }
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    for (let i = 4; i + MESSAGE_LEN <= d.length; i++) {
      if (d[i] !== 0 || v.getUint32(i - 4, true) !== MESSAGE_LEN || !FEED_ID.every((b, j) => d[i + 1 + j] === b)) continue;
      const o = i + 33;
      const p: FeedPrice = { price: v.getBigInt64(o, false), conf: v.getBigUint64(o + 8, false), expo: v.getInt32(o + 16, false), publishedS: Number(v.getBigInt64(o + 20, false)), blockS: tx!.blockTime as number };
      if (found !== null && (found.price !== p.price || found.publishedS !== p.publishedS)) return null;
      found = p;
    }
  }
  if (found === null || found.price <= 0n || found.expo > 0 || found.expo < -18 || !Number.isSafeInteger(found.publishedS)) return null;
  // the feed's own bound on its confidence (the kit's maxConfBps)
  if (found.conf * 10_000n > found.price * BigInt(FEED.maxConfBps)) return null;
  return found;
}

/** The answer to a getTransaction of `sig`, or null when it is no transaction or its first signature is another. */
function own(t: unknown, sig: string): unknown {
  const sigs = (t as { transaction?: { signatures?: unknown } } | null)?.transaction?.signatures;
  return Array.isArray(sigs) && sigs[0] === sig ? t : null;
}

/** The SOL/USD at `blockS`: the newest feed write before `sig` (see the top), or null. */
async function blockPrice(d: FillDeps, sig: string, blockS: number): Promise<FeedPrice | null> {
  if (!d.feedBefore) return null;
  const sigs = await d.feedBefore(sig).catch(() => [] as readonly string[]);
  for (const s of sigs.slice(0, FEED_READS_MAX)) {
    const x = feedWritePrice(own(await d.read(s).catch(() => null), s));
    if (x === null) continue; // a reader of the feed, not a write (or an answer refused)
    // the newest write before the sale: its price is the one in force at the sale's block, if it is that minute's
    return x.blockS <= blockS && x.publishedS <= blockS && blockS - x.publishedS <= BLOCK_PRICE_S ? x : null;
  }
  return null;
}

/** The store the fill writes the ops records in (the wallet store). */
export type FillStore = {
  keys(store: "ops"): Promise<readonly string[]>;
  get(store: "ops", key: string): Promise<unknown>;
  update(store: "ops", key: string, f: (v: unknown) => unknown): Promise<unknown>;
};
export type FillDeps = {
  store: FillStore;
  /** One signature's "json" getTransaction answer at finalized, on the helper's route (see the top). */
  read(signature: string): Promise<unknown>;
  /** The signatures of the page's SOL/USD feed account before `signature`, newest first, the failed ones left out
   *  (getSignaturesForAddress at finalized, on the same route); each is read with `read` before it counts. */
  feedBefore?(signature: string): Promise<readonly string[]>;
  /** The page's own SOL price now, if any. */
  price(): PoolStatePrice | null;
  now(): number;
  /** The sign out's stop: once aborted, no op is read or written more. */
  signal?: AbortSignal;
};

type OpRecord = { kind?: unknown; stage?: unknown; chain?: unknown; token?: unknown; txs?: unknown; created_ms?: unknown; pool_amount?: unknown; sha?: unknown; pool?: unknown; legs?: unknown; amount_usd?: unknown; fill_none?: unknown };

/** A pool buy or sale on Solana that filled, with its signatures, and no pool_amount yet (see the top). */
function wants(r: OpRecord | undefined): r is OpRecord & { kind: "buy" | "sell"; token: string; txs: { hash: string }[] } {
  const pool = r?.kind === "buy" ? r.sha === undefined : r?.kind === "sell" && r.pool === "sol";
  return pool && r!.stage === "filled" && r!.chain === "solana" && typeof r!.token === "string" && r!.pool_amount === undefined && r!.fill_none === undefined && Array.isArray(r!.txs) && r!.txs.length > 0 && r!.txs.every((t) => typeof (t as { hash?: unknown })?.hash === "string");
}

/** A sale's legs' wallets, when its op names them. */
function legWallets(r: OpRecord): Set<string> | null {
  if (!Array.isArray(r.legs)) return null;
  return new Set(r.legs.flatMap((l) => (typeof (l as { wallet?: unknown })?.wallet === "string" ? [(l as { wallet: string }).wallet] : [])));
}

/**
 * Fills each pool trade op on Solana that has no pool_amount (see the top): its units and pool_amount, and a sale's
 * amount_usd with where it came from. A buy reads its first signature; a sale every leg's, summed (each leg one W).
 * Never throws for one op: an op whose reads fail or are refused is left as it is. Whether any op was written.
 */
export async function fillTradeOps(d: FillDeps): Promise<boolean> {
  let wrote = false;
  const found: { k: string; rec: OpRecord & { kind: "buy" | "sell"; token: string; txs: { hash: string }[] } }[] = [];
  for (const k of await d.store.keys("ops")) {
    const rec = (await d.store.get("ops", k).catch(() => undefined)) as OpRecord | undefined;
    if (wants(rec)) found.push({ k, rec });
  }
  const at = (r: OpRecord): number => (typeof r.created_ms === "number" ? r.created_ms : 0);
  found.sort((a, b) => at(b.rec) - at(a.rec));
  for (const { k, rec } of found.slice(0, FILL_OPS_MAX)) {
    if (d.signal?.aborted) break;
    const sigs = rec.kind === "buy" ? [rec.txs[0]!.hash] : rec.txs.map((t) => t.hash);
    const walletsOk = rec.kind === "sell" ? legWallets(rec) : null;
    let units = 0n;
    let lamports = 0n;
    let decimals: number | null = null;
    let whole = true;
    // every answer read and its own, yet no figure: for good (see the top)
    let never = false;
    const legs: { sig: string; lamports: bigint; blockS: number | null }[] = [];
    for (const sig of sigs) {
      const a = own(await d.read(sig).catch(() => null), sig);
      const leg = solanaTradeLeg(a, rec.kind, rec.token);
      if (leg === null || (decimals !== null && leg.decimals !== decimals) || (walletsOk !== null && !walletsOk.has(leg.wallet))) {
        whole = false;
        never = a !== null;
        break;
      }
      decimals = leg.decimals;
      units += leg.units;
      lamports += leg.lamports;
      const bt = (a as { blockTime?: unknown }).blockTime;
      legs.push({ sig, lamports: leg.lamports, blockS: Number.isSafeInteger(bt) ? (bt as number) : null });
    }
    // only an op a restore rebuilt (src/sol-buy-records.ts, `restored/<signature>`) is marked: this device's own op
    // holds a real trade, so an answer it cannot read is the answer's fault and the op is read again (review of
    // f73ee1c82, P3-a)
    if (never && k.startsWith("restored/")) {
      await d.store
        .update("ops", k, (v) => (wants(v as OpRecord) ? { ...(v as object), fill_none: true } : v))
        .then(() => (wrote = true))
        .catch(() => {});
      continue;
    }
    if (!whole || decimals === null) continue;
    const fill: Record<string, string> = { units: poolUnits(units, decimals), pool_amount: poolUnits(lamports, 9) };
    // a buy with no USD (a device restored from the words rebuilt it from W's history, src/sol-buy-records.ts; or its
    // request had no price): its SOL in at its own block's price, as an old sale's; none, no USD
    if (rec.kind === "buy" && rec.amount_usd === undefined) {
      const l = legs[0]!;
      const bp = l.blockS === null ? null : await blockPrice(d, l.sig, l.blockS);
      if (bp !== null && l.lamports > 0n) [fill.amount_usd, fill.usd_from] = [poolUnits(l.lamports * bp.price * 10n ** BigInt(18 + bp.expo), 9 + 18), "block"];
    }
    if (rec.kind === "sell") {
      const p = d.price();
      const now = d.now();
      const young = typeof rec.created_ms === "number" && now - rec.created_ms <= SALE_USD_MS;
      if (young && p !== null && now - p.read_ms <= PRICE_FRESH_MS) {
        const usd = usdOf(lamports, 9, p);
        if (usd !== null) [fill.amount_usd, fill.usd_from] = [usd, "live"];
      }
      if (fill.amount_usd === undefined) {
        // each leg at its own block's price, summed at one scale; any leg with none: no USD
        let sum = 0n;
        for (const l of legs) {
          const bp = l.blockS === null ? null : await blockPrice(d, l.sig, l.blockS);
          if (bp === null) {
            sum = -1n;
            break;
          }
          sum += l.lamports * bp.price * 10n ** BigInt(18 + bp.expo);
        }
        if (sum > 0n) [fill.amount_usd, fill.usd_from] = [poolUnits(sum, 9 + 18), "block"];
        // a young sale with no price yet: left for the next run, which may have one (review R2)
        else if (young) continue;
      }
    }
    if (d.signal?.aborted) break;
    await d.store
      .update("ops", k, (v) => (wants(v as OpRecord) ? { ...(v as object), ...fill } : v))
      .then(() => (wrote = true))
      .catch(() => {});
  }
  return wrote;
}
