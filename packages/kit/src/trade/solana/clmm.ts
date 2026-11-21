// Raydium CLMM as a market the device reads but does not trade (card solana-buy-never-below-a-hidden-market). Device
// side, keyless: a pool and its two vaults read on two providers, never one alone, and its spot price and SOL depth
// taken only where both agree. Nothing here builds, names or signs a route: no CLMM account is ever an account of a
// signed message, and SOLANA_POOL_BUY_VENUES (pool-buy.ts) holds no CLMM venue. A pool address only names where to
// read; the read judges it.
//
// Why: on 21 Nov 16:23Z, for 30 of the 100 coins Discover listed, the deepest pool in any quote sat on a venue the kit
// did not read (a Raydium CLMM pool for 22 of them, most quoted in USDC). A buy's bar M (pool.ts set rule) was then set
// by a thinner pool, so a thin pool priced far from the coin's real market could be bought. This read is that market's
// price and depth; the set rule's use of it comes with its exact out (the card's next round).
//
// Source, read 2026-11-21 16:38Z (date -u): raydium-io/raydium-clmm at 6d7a0f82d2f293c553c69aaf943377367c6c4cc6
// (master, 2026-10-27), programs/amm/src/states/pool.rs: PoolState, Anchor zero_copy, repr(C, packed), 1544 bytes with
// its discriminator sha256("account:PoolState")[..8] (the CPMM pool's name too: the owner tells them apart): bump 8,
// amm_config 9, owner 41, token_mint_0 73, token_mint_1 105, token_vault_0 137, token_vault_1 169, observation_key 201,
// mint_decimals_0 233, mint_decimals_1 234, tick_spacing 235 (u16), liquidity 237 (u128), sqrt_price_x64 253 (u128,
// Q64.64 of token 1 per token 0 in base units), tick_current 269 (i32), ... status 389 (PoolStatusBitIndex: bit 4 set
// = swap disabled), fee_on 390. The vaults are SPL token accounts of the pool's mints whose authority is the pool
// itself (read on mainnet 21 Nov 16:47Z for BxRhW4q1… and 9n3dSLrE…, both vaults of each).
// Checked 21 Nov 16:38Z on api.mainnet-beta.solana.com and solana-rpc.publicnode.com for four pools (SPCX, SQQQ, TSLAx,
// NVDA against USDC): sqrt_price_x64² / 2^128 × 10^(dec0 − dec1) equalled DexScreener's priceNative to 6 digits, the
// same sqrt price on both providers.
//
// Agree: the pool's identity bytes (0..237: discriminator, config, owner, mints, vaults, observation, decimals,
// spacing; 389..391: status, fee_on) byte-equal on both; the spot price (sqrt²) and the SOL vault within
// SOLANA_POOL_READ_TOL_BPS of each other; otherwise read once more on both, then refused. What is no market (verdict
// "none", never a guess): no such account, a pool not of the coin and wSOL, swaps disabled, no liquidity in range, an
// empty SOL vault.
import { base58 } from "@scure/base";
import { SOLANA_SOL_MINT, SOLANA_TOKEN_2022_PROGRAM, SOLANA_TOKEN_PROGRAM } from "../../checks/solana/checks.ts";
import { deepFreeze } from "../../freeze.ts";
import { solanaCallFault, solanaDecodeTokenAccount, solanaParseAccountsAnswer, solanaReservesAgree, type SolanaPoolAccount } from "./pool.ts";
import { solanaSameProvider, solanaTimedRpc, type SolanaRpc } from "./send.ts";

export const SOLANA_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const SOLANA_CLMM_POOL_BYTES = 1544;
const POOL_DISC = [247, 237, 227, 245, 215, 195, 222, 70] as const; // sha256("account:PoolState")[..8]
/** The PoolState bytes that name the pool and must be the same on both providers: 0..237 and status, fee_on. */
export const SOLANA_CLMM_POOL_STATIC: readonly (readonly [number, number])[] = [[0, 237], [389, 391]];
deepFreeze(SOLANA_CLMM_POOL_STATIC);
/** Swaps disabled: PoolStatusBitIndex::Swap. */
const STATUS_SWAP_OFF = 1 << 4;
const READ_TIMEOUT_MS = 5_000;

export type SolanaClmmPool = {
  readonly mint0: string; readonly mint1: string; readonly vault0: string; readonly vault1: string;
  readonly decimals0: number; readonly decimals1: number; readonly tickSpacing: number;
  readonly liquidity: bigint; readonly sqrtPriceX64: bigint; readonly tickCurrent: number; readonly status: number;
};

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true) + (dv(d).getBigUint64(o + 8, true) << 64n);
const key = (d: Uint8Array, o: number): string => base58.encode(d.subarray(o, o + 32));

/** A CLMM PoolState, checked: owner, size, discriminator. Throws on any other account. */
export function solanaDecodeClmmPool(acc: SolanaPoolAccount): SolanaClmmPool {
  if (acc.owner !== SOLANA_CLMM_PROGRAM) throw new Error("the CLMM pool is not owned by the CLMM program");
  const d = acc.data;
  if (d.length !== SOLANA_CLMM_POOL_BYTES) throw new Error("the CLMM pool is not a PoolState");
  if (POOL_DISC.some((b, i) => d[i] !== b)) throw new Error("the CLMM pool is not a PoolState");
  return {
    mint0: key(d, 73), mint1: key(d, 105), vault0: key(d, 137), vault1: key(d, 169),
    decimals0: d[233]!, decimals1: d[234]!, tickSpacing: dv(d).getUint16(235, true),
    liquidity: u128(d, 237), sqrtPriceX64: u128(d, 253), tickCurrent: dv(d).getInt32(269, true), status: d[389]!,
  };
}

/** The pool's identity bytes equal on both reads (SOLANA_CLMM_POOL_STATIC). */
export function solanaClmmSamePool(a: SolanaPoolAccount, b: SolanaPoolAccount): boolean {
  if (a.owner !== b.owner || a.data.length !== b.data.length) return false;
  return SOLANA_CLMM_POOL_STATIC.every(([s, e]) => a.data.subarray(s, e).every((x, i) => x === b.data[s + i]));
}

/** Which side wSOL is on for `mint`: null when the pool is not the coin's wSOL pool. */
export function solanaClmmSide(p: Pick<SolanaClmmPool, "mint0" | "mint1">, mint: string): { solIs0: boolean } | null {
  if (mint === SOLANA_SOL_MINT) return null;
  if (p.mint0 === SOLANA_SOL_MINT && p.mint1 === mint) return { solIs0: true };
  if (p.mint1 === SOLANA_SOL_MINT && p.mint0 === mint) return { solIs0: false };
  return null;
}

/** What `amount` in pays out at the pool's spot price, before any fee and any move of the price (base units, floor):
 *  the price's own bound on the swap's out, never what it pays. P = sqrt² / 2^128 is token 1 per token 0. */
export function solanaClmmSpotOut(sqrtPriceX64: bigint, side: "buy" | "sell", amount: bigint, solIs0: boolean): bigint {
  const p = sqrtPriceX64 * sqrtPriceX64;
  if (p === 0n) return 0n;
  // a buy puts SOL in: out is token 1 when SOL is token 0; a sell puts the coin in
  const zeroIn = side === "buy" ? solIs0 : !solIs0;
  return zeroIn ? (amount * p) >> 128n : (amount << 128n) / p;
}

/** The account list one CLMM read asks for: the pool, then its two vaults. */
export const solanaClmmReadList = (address: string, p: Pick<SolanaClmmPool, "vault0" | "vault1">): string[] => [address, p.vault0, p.vault1];

/** One CLMM pool both providers agree on: its SOL depth and spot out on each provider's read, and the slots. */
export type SolanaClmmSpot = {
  readonly address: string;
  readonly depth: readonly [bigint, bigint];
  readonly spotOut: readonly [bigint, bigint];
  readonly slots: readonly [number, number];
};
export type SolanaClmmVerdict = { kind: "ok"; spot: SolanaClmmSpot } | { kind: "none" } | { kind: "bad"; why: string };

type Read = ReturnType<typeof solanaParseAccountsAnswer>;
type Got = { read: Read; fault: string | null };

/** One provider's read of a pool: its PoolState and SOL depth, checked against the pool's own vaults. A string: why not. */
function one(acc: (SolanaPoolAccount | null)[], address: string, token: string): { pool: SolanaClmmPool; solIs0: boolean; depth: bigint } | "none" | string {
  const pa = acc[0] ?? null;
  if (pa === null) return "none";
  const pool = solanaDecodeClmmPool(pa);
  const side = solanaClmmSide(pool, token);
  if (side === null) return "none";
  const vaults = [acc[1] ?? null, acc[2] ?? null] as const;
  const held: bigint[] = [];
  for (const [i, v] of vaults.entries()) {
    const mint = i === 0 ? pool.mint0 : pool.mint1;
    if (v === null) return "a CLMM vault is missing";
    // wSOL is SPL Token; the coin may be either token program
    const programs = mint === SOLANA_SOL_MINT ? [SOLANA_TOKEN_PROGRAM] : [SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM];
    if (!programs.includes(v.owner)) return "a CLMM vault is not a token account";
    const t = solanaDecodeTokenAccount(v);
    if (t.mint !== mint || t.owner !== address) return "a CLMM vault of another mint or owner";
    held.push(t.amount);
  }
  return { pool, solIs0: side.solIs0, depth: held[side.solIs0 ? 0 : 1]! };
}

function judge(address: string, token: string, side: "buy" | "sell", amount: bigint, ga: Got, gb: Got): SolanaClmmVerdict {
  const a = ga.read;
  const b = gb.read;
  if (!a || !b) {
    const why = [ga, gb].flatMap((g, i) => (g.read ? [] : [`provider ${"AB"[i]} gave no answer${g.fault ? ` (${g.fault})` : " (not an accounts read)"}`]));
    return { kind: "bad", why: why.join(", ") };
  }
  try {
    const pa = a.accounts[0] ?? null;
    const pb = b.accounts[0] ?? null;
    if (pa === null && pb === null) return { kind: "none" };
    // an address both providers hold as some other program's account is no CLMM market
    if (pa !== null && pb !== null && pa.owner !== SOLANA_CLMM_PROGRAM && pb.owner !== SOLANA_CLMM_PROGRAM) return { kind: "none" };
    if (pa === null || pb === null || !solanaClmmSamePool(pa, pb)) return { kind: "bad", why: "the CLMM pool's static bytes differ" };
    const list = solanaClmmReadList(address, solanaDecodeClmmPool(pa));
    const x = one(a.accounts, address, token);
    const y = one(b.accounts, address, token);
    if (x === "none" && y === "none") return { kind: "none" };
    if (typeof x === "string") return { kind: "bad", why: x };
    if (typeof y === "string") return { kind: "bad", why: y };
    if (solanaClmmReadList(address, y.pool).some((k, i) => k !== list[i])) return { kind: "bad", why: "the CLMM read named accounts that are not the pool's own" };
    const live = (p: SolanaClmmPool) => (p.status & STATUS_SWAP_OFF) === 0 && p.liquidity > 0n && p.sqrtPriceX64 > 0n;
    if (!live(x.pool) && !live(y.pool)) return { kind: "none" };
    if (!live(x.pool) || !live(y.pool)) return { kind: "bad", why: "the CLMM pool is open on one provider only" };
    if (x.depth === 0n && y.depth === 0n) return { kind: "none" };
    if (!solanaReservesAgree(x.depth, y.depth)) return { kind: "bad", why: "the CLMM pool's SOL vault is outside the band" };
    if (!solanaReservesAgree(x.pool.sqrtPriceX64 ** 2n, y.pool.sqrtPriceX64 ** 2n)) return { kind: "bad", why: "the CLMM pool's price is outside the band" };
    const out = (p: SolanaClmmPool) => solanaClmmSpotOut(p.sqrtPriceX64, side, amount, x.solIs0);
    return { kind: "ok", spot: { address, depth: [x.depth, y.depth], spotOut: [out(x.pool), out(y.pool)], slots: [a.slot, b.slot] } };
  } catch (e) {
    return { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/**
 * A coin's CLMM wSOL pool `pool`, read on both providers: its SOL depth and spot out for `amount` where the two agree,
 * "none" where it is no market for the coin, and why not where they still disagree after one read more. The vaults to
 * read come from provider A's read of the pool (B's when A has none); the judge holds both reads to the same identity
 * bytes and the list to the vaults those bytes name. Throws only on a request or provider pair that is not one.
 */
export async function readSolanaClmmSpot(providers: readonly [SolanaRpc, SolanaRpc], req: { token: string; pool: string; side: "buy" | "sell"; amount: bigint }): Promise<SolanaClmmVerdict> {
  if (!Array.isArray(providers) || providers.length !== 2 || typeof providers[0] !== "function" || typeof providers[1] !== "function") throw new Error("two providers are needed");
  if (solanaSameProvider(providers[0], providers[1])) throw new Error("the two providers are the same provider: a market must never rest on one provider's word");
  if (req?.side !== "buy" && req?.side !== "sell") throw new Error("side must be buy or sell");
  if (typeof req.amount !== "bigint" || req.amount <= 0n || req.amount >= 1n << 64n) throw new Error("amount must be a positive u64");
  for (const k of [req.token, req.pool]) if (typeof k !== "string" || base58.decode(k).length !== 32) throw new Error("not a 32-byte address");
  const readBoth = (list: string[]): Promise<[Got, Got]> =>
    Promise.all(providers.map((rpc) =>
      Promise.resolve().then(() => solanaTimedRpc(rpc, READ_TIMEOUT_MS)("getMultipleAccounts", [list, { encoding: "base64", commitment: "confirmed" }])).then(
        (ans): Got => ({ read: solanaParseAccountsAnswer(ans, list.length), fault: null }),
        (e: unknown): Got => ({ read: null, fault: solanaCallFault(e) }),
      ),
    )) as Promise<[Got, Got]>;
  let last: SolanaClmmVerdict = { kind: "bad", why: "no read" };
  for (let round = 0; round < 2; round++) {
    const [ha, hb] = await readBoth([req.pool]);
    const head = [ha.read?.accounts[0], hb.read?.accounts[0]].find((x) => x != null) ?? null;
    if (head === null || head.owner !== SOLANA_CLMM_PROGRAM) {
      last = judge(req.pool, req.token, req.side, req.amount, ha, hb);
      if (last.kind !== "bad") return last;
      continue;
    }
    let list: string[];
    try {
      list = solanaClmmReadList(req.pool, solanaDecodeClmmPool(head));
    } catch (e) {
      last = { kind: "bad", why: String(e instanceof Error ? e.message : e).slice(0, 200) };
      continue;
    }
    const [a, b] = await readBoth(list);
    last = judge(req.pool, req.token, req.side, req.amount, a, b);
    if (last.kind !== "bad") return last;
  }
  return last;
}
