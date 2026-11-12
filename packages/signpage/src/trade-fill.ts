// What each filled Solana trade moved, from its own transaction (card portfolio-shows-pool-trades), on SIGN_HOST's
// top-level page: the token W got or sold (the op's units) and the SOL W paid into the venue or got out of it (the op's
// pool_amount, kit 1.10 OpDetail), so the app's Portfolio draws each round trip's result from the device's records.
//
// - Why from the transaction: a pool sale's deposit back is min out less W's reserve plus whatever W held (the change
//   the pool lent W beyond the buy comes back with it), so no record of the run holds what the venue paid; the chain's
//   record of the sale does. A buy's spend is the request's own (pool-testnet.ts writes it with the buy's op); a buy
//   recorded before (release 118 and earlier) gets it here too.
// - The read: getTransaction of each of the op's signatures at finalized, "json" encoding, on both of the page's RPCs;
//   each figure is taken only when both answers give the same one. A read that fails, or two that differ, writes
//   nothing: the next load reads it again.
// - The rules, from the transaction's meta and its system instructions (top level and inner), W being the one owner
//   whose balance of the op's token rose (a buy) or fell (a sale):
//   - units: that change, at the token's decimals;
//   - a sale's SOL out of the venue: W's lamports after less before, plus the fee when W paid it, plus every lamport W
//     paid out by a system transfer or account creation (the pool's deposit, the mark's rent, a fee), less every lamport
//     a system transfer paid W. What a program paid W without one (pump's curve, a closed wrapped-SOL account) is the
//     venue's. On 32CSJ1...Kwn (12 Nov) that is 574,635 lamports: the curve's 581,910 less pump's fees.
//   - a buy's SOL into the venue: every lamport W paid by a system transfer, its account creations (rent) apart. On
//     5Qn5Lt...vB8Q that is 1,205,887 lamports, the BuyExactSolIn spend. A buy that wraps SOL (W's wrapped-SOL balance
//     in its meta) gets none: its transfer to its own account is not what the venue took.
//   Any other system instruction W signs (a transfer with seed, an allocate) makes the figure unknown: nothing is
//   written for it, never a guess.
// - amount_usd on a sale: its SOL out at the page's own pool price (src/pool-price.ts), only when the price was read
//   within PRICE_FRESH_MS and the sale is younger than SALE_USD_MS; an older sale's USD is not on any record, so it is
//   left out (the app draws a dash).
// - Written once per op, in one store update that keeps every other field; an op that has pool_amount is not read again.
//   Display only: nothing here feeds a signature. Reads name only the op's own signatures, which the same two RPCs
//   already saw at the trade's send and verdict.
import { base58 } from "@scure/base";
import type { PoolStatePrice } from "../../kit/src/signpage/messages.ts";
import { usdOf } from "./positions.ts";
import { poolUnits } from "./rules/pool.ts";

const SYSTEM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
/** The page's price counts for a sale's USD only this fresh (its own read, ms). */
export const PRICE_FRESH_MS = 120_000;
/** A sale's USD is written only this soon after it: past it, the price now is not the sale's. */
export const SALE_USD_MS = 600_000;

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
      if (from === w && to !== w) out += l;
      else if (to === w && from !== w) into += l;
    } else if (tag === 0 && data.length === 52 && from === w) rents += u64(data, 4);
    else return null;
  }
  if (side === "buy") {
    // a wrapped-SOL buy pays its own account first: not what the venue took
    if (tokenChanges(meta.preTokenBalances, meta.postTokenBalances, WSOL)?.has(w)) return null;
    return { wallet: w, units, decimals, lamports: out };
  }
  const fee = wAt === 0 && Number.isSafeInteger(meta.fee) ? BigInt(meta.fee as number) : 0n;
  const delta = BigInt(meta.postBalances[wAt]!) - BigInt(meta.preBalances[wAt]!);
  const got = delta + fee + out + rents - into;
  return got > 0n ? { wallet: w, units, decimals, lamports: got } : null;
}

/** The store the fill writes the ops records in (the wallet store). */
export type FillStore = {
  keys(store: "ops"): Promise<readonly string[]>;
  get(store: "ops", key: string): Promise<unknown>;
  update(store: "ops", key: string, f: (v: unknown) => unknown): Promise<unknown>;
};
export type FillDeps = {
  store: FillStore;
  /** One signature's "json" getTransaction answer at finalized on each of the two RPCs. */
  read(signature: string): Promise<readonly [unknown, unknown]>;
  /** The page's own SOL price now, if any. */
  price(): PoolStatePrice | null;
  now(): number;
};

type OpRecord = { kind?: unknown; stage?: unknown; chain?: unknown; token?: unknown; txs?: unknown; created_ms?: unknown; pool_amount?: unknown };

/** A Solana buy or sale that filled, with its signatures, and no pool_amount yet. */
function wants(r: OpRecord | undefined): r is OpRecord & { kind: "buy" | "sell"; token: string; txs: { hash: string }[] } {
  return (r?.kind === "buy" || r?.kind === "sell") && r.stage === "filled" && r.chain === "solana" && typeof r.token === "string" && r.pool_amount === undefined && Array.isArray(r.txs) && r.txs.length > 0 && r.txs.every((t) => typeof (t as { hash?: unknown })?.hash === "string");
}

/** The two answers' leg, when both give the same one. */
const agreed = (a: TradeLeg | null, b: TradeLeg | null): TradeLeg | null => (a && b && a.wallet === b.wallet && a.units === b.units && a.decimals === b.decimals && a.lamports === b.lamports ? a : null);

/**
 * Fills each filled Solana trade op that has no pool_amount (see the top): its units and pool_amount, and a young sale's
 * amount_usd. A buy reads its first signature; a sale every leg's, summed (each leg one W). Never throws for one op:
 * an op whose reads fail or differ is left as it is. Whether any op was written.
 */
export async function fillTradeOps(d: FillDeps): Promise<boolean> {
  let wrote = false;
  for (const k of await d.store.keys("ops")) {
    const rec = (await d.store.get("ops", k).catch(() => undefined)) as OpRecord | undefined;
    if (!wants(rec)) continue;
    const sigs = rec.kind === "buy" ? [rec.txs[0]!.hash] : rec.txs.map((t) => t.hash);
    let units = 0n;
    let lamports = 0n;
    let decimals: number | null = null;
    let whole = true;
    for (const sig of sigs) {
      const [a, b] = await d.read(sig).catch(() => [null, null] as const);
      const leg = agreed(solanaTradeLeg(a, rec.kind, rec.token), solanaTradeLeg(b, rec.kind, rec.token));
      if (leg === null || (decimals !== null && leg.decimals !== decimals)) {
        whole = false;
        break;
      }
      decimals = leg.decimals;
      units += leg.units;
      lamports += leg.lamports;
    }
    if (!whole || decimals === null) continue;
    const fill: Record<string, string> = { units: poolUnits(units, decimals), pool_amount: poolUnits(lamports, 9) };
    const p = d.price();
    const now = d.now();
    if (rec.kind === "sell" && p !== null && now - p.read_ms <= PRICE_FRESH_MS && typeof rec.created_ms === "number" && now - rec.created_ms <= SALE_USD_MS) {
      const usd = usdOf(lamports, 9, p);
      if (usd !== null) fill.amount_usd = usd;
    }
    await d.store
      .update("ops", k, (v) => (wants(v as OpRecord) ? { ...(v as object), ...fill } : v))
      .then(() => (wrote = true))
      .catch(() => {});
  }
  return wrote;
}
