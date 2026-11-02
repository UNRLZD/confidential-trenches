// The device's own cap on a relayed withdrawal's fee (card wallet-withdraw-feemax; LD5, docs/plan1/markets.md l.1074-1080
// and H3.7's A_cap, l.1584-1586 and l.1686-1688; the §2.8 arming row, wallet.md l.915; §8 item 13, l.1333-1338; at
// research 3b60115). The relayer quotes relay_fee; the device refuses one above fee_max, which it computes here from
// constants fixed in the release and its own reads, never from a figure a caller or the helper names.
//
//   fee_max = ceil((G_cap × gp × 1.5 + S_cap) × px)
//   S_cap   = 2 × (B_cap × 1e19 + register_deposit + G_settle_cap × gp + A_cap),  A_cap = A_fund + G_arm_cap × gp
//
// - G_cap = 2 × 92.505 Tgas (the depth-32 withdraw with its payouts, the G1 gas proof), B_cap = 858 B (710 + 148, a tree
//   that grows a level), G_settle_cap = 104.475 Tgas (101.475 + 3), G_arm_cap = 100 Tgas, A_fund = A_store + NEAR's
//   0.007 N account creation charge, A_store = 182 B × 1e19 (W:742). A_cap counts on every withdrawal: the kit's
//   recipient is always this note's A_{l,j} (request.ts), so every withdrawal pays an A (W:671; WM-06).
// - gp is the gas_price in the header of one final block, the same block (height and hash) on both of the network's
//   release RPCs, and the same price on both (LD1: two providers, never through the helper; nearPairNetwork). Two
//   prices at one block cannot honestly differ, so a difference is refused, never averaged.
// - px, the NEAR price in the token, is the spot price of Ref's pool FEE_POOL_ID (USDC / wNEAR, a constant-product
//   SIMPLE_POOL; the deepest USDC / wNEAR pool of v2.ref-finance.near's 8,993, read 2026-11-02: about 1.02 M USDC
//   against 248.7 k NEAR): the USDC amount over the wNEAR amount, both in base units, read on mainnet's release pair at
//   one block, byte-equal on both. It is mainnet's on every network: testnet NEAR has no price, and the testnet token is
//   mainnet USDC's own code with its 6 decimals (contracts/vault/deployments/testnet-usdc.json; ft_metadata in
//   test/vectors/withdraw-feemax.json), so a fee in it is priced as the USDC it copies.
// - Everything is a bigint and the one division rounds up, so the cap is never below the formula's figure.
import { heightSpreadOver, NEAR_NETWORKS, type NearNetwork, nearPairNetwork, nearPairRule } from "../deposit/account.ts";

/** Gas a withdrawal may burn, capped: 2 × 92.505 Tgas. */
export const FEE_G_CAP = 185_010_000_000_000n;
/** Bytes a withdraw writes at most (a tree that grows a level): 710 + 148. */
export const FEE_B_CAP = 858n;
/** NEAR's storage price, yocto per byte. */
export const STORAGE_YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
/** A settle that writes a refund note, capped: 101.475 + 3 Tgas. */
export const FEE_G_SETTLE_CAP = 104_475_000_000_000n;
/** The relayed call from A_{l,j}, capped until G1 measures it: 100 Tgas. */
export const FEE_G_ARM_CAP = 100_000_000_000_000n;
/** A's funding: its record and key (182 B × 1e19) and NEAR's 0.007 N account creation charge, in yocto. */
export const FEE_A_FUND = 182n * STORAGE_YOCTO_PER_BYTE + 7_000_000_000_000_000_000_000n;
/** The price pool: Ref's USDC / wNEAR SIMPLE_POOL on mainnet, its token order as the pool lists it. */
export const FEE_POOL_CONTRACT = "v2.ref-finance.near";
export const FEE_POOL_ID = 4512;
export const FEE_POOL_TOKENS = [NEAR_NETWORKS.mainnet.usdc, "wrap.near"] as const;
/**
 * The pool's USDC side must hold at least 250,000 USDC (a quarter of the 1,017,547 read 2026-11-02), else no cap and
 * no relayed withdrawal (fail closed). On a constant-product pool, raising the read price k-fold in one block takes
 * swapping in USDC (sqrt(k) - 1) x its USDC side [derived]: doubling it at the floor takes about 103,600 USDC in, at
 * 0.3 % pool fee (total_fee 30) about 311 USDC lost each way, and arbitrage reversing the move takes about 30,300 USDC
 * more, x (k^1/4 - k^-1/4)^2 with x the USDC side, while the cap it doubles is about 0.43 USDC per withdrawal.
 * The floor stops a drained pool only. A hostile upgrade of Ref's contract could still report 250,000 USDC or more
 * against a few yocto of NEAR and raise the price: a residual risk that needs Ref's owner and the relayer both bad,
 * and the vault's MAX_RELAY_FEE_BPS backstop (50 % of the withdrawn amount) still holds.
 */
export const FEE_POOL_MIN_TOKEN = 250_000_000_000n;

const U128 = 1n << 128n;
const DEC = /^(0|[1-9][0-9]{0,38})$/;

export type FeeMaxRefusalCode = "input" | "rpc" | "disagree" | "pool";
export class FeeMaxRefused extends Error {
  readonly code: FeeMaxRefusalCode;
  constructor(code: FeeMaxRefusalCode, detail: string) {
    super(`fee cap stopped (${code}): ${detail}`);
    this.name = "FeeMaxRefused";
    this.code = code;
  }
}

/** The inputs of the formula: gp in yocto per gas, the pool's two amounts in base units, register_deposit in yocto. */
export type FeeMaxInputs = { gasPrice: bigint; poolToken: bigint; poolNear: bigint; registerDeposit: bigint };

/** LD5's fee_max in the token's base units. */
export function withdrawFeeMax(i: FeeMaxInputs): bigint {
  const { gasPrice: gp, poolToken, poolNear, registerDeposit } = i;
  for (const [k, v] of Object.entries({ gasPrice: gp, poolToken, poolNear, registerDeposit })) {
    if (typeof v !== "bigint" || v < 0n || v >= U128) throw new FeeMaxRefused("input", `${k}: not a u128`);
  }
  if (gp === 0n || poolToken === 0n || poolNear === 0n) throw new FeeMaxRefused("input", "gas price and pool amounts must be above 0");
  const aCap = FEE_A_FUND + FEE_G_ARM_CAP * gp;
  const sCap = 2n * (FEE_B_CAP * STORAGE_YOCTO_PER_BYTE + registerDeposit + FEE_G_SETTLE_CAP * gp + aCap);
  // (G_cap × gp × 1.5 + S_cap) × poolToken / poolNear, with 1.5 = 3 / 2, rounded up
  const num = (FEE_G_CAP * gp * 3n + 2n * sCap) * poolToken;
  const den = 2n * poolNear;
  return (num + den - 1n) / den;
}

/** A NEAR provider for `query` and for one block's header (`block`), named by its exact URL (relay.ts relayRpc). */
export interface FeeRpc {
  name: string;
  query(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  block(params: { block_id: number } | { finality: "final" }, signal?: AbortSignal): Promise<unknown>;
}

export type FeeMaxReadArgs = {
  /** The withdrawal's network: its release pair reads the gas price. */
  network: NearNetwork;
  rpcs: readonly [FeeRpc, FeeRpc];
  /** Mainnet's release pair: reads the price pool (the same pair as rpcs on mainnet). */
  priceRpcs: readonly [FeeRpc, FeeRpc];
  /** NEAR, in yocto, for A_{l,j}'s token registration, as the withdrawal binds it. */
  registerDeposit: bigint;
  signal?: AbortSignal;
};

/** The device's fee_max for one withdrawal, from its own reads on two providers. */
export async function readWithdrawFeeMax(a: FeeMaxReadArgs): Promise<bigint> {
  const { network, rpcs, priceRpcs, signal } = a;
  if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new FeeMaxRefused("input", `unknown network ${String(network)}`);
  if (nearPairNetwork(rpcs) !== network || !hasBlock(rpcs)) throw new FeeMaxRefused("input", nearPairRule(network));
  if (nearPairNetwork(priceRpcs) !== "mainnet" || !hasBlock(priceRpcs)) throw new FeeMaxRefused("input", `price: ${nearPairRule("mainnet")}`);
  const [gas, pool] = await Promise.all([agreedBlock(rpcs, signal), readPool(priceRpcs, signal)]);
  return withdrawFeeMax({ gasPrice: gas.gasPrice, poolToken: pool.token, poolNear: pool.near, registerDeposit: a.registerDeposit });
}

const hasBlock = (rpcs: readonly unknown[]): boolean => rpcs.every((r) => isObj(r) && typeof r.block === "function");
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

type Header = { height: number; hash: string; gasPrice: bigint };

// The newest block both providers hold as final: the lower of their final heights, which may differ by
// HEIGHT_SPREAD_MAX blocks at most (heightSpreadOver), then that height's header on both, the same hash and gas_price.
async function agreedBlock(rpcs: readonly [FeeRpc, FeeRpc], signal?: AbortSignal): Promise<Header> {
  const finals = await Promise.all(rpcs.map((r) => headerOf(r, { finality: "final" }, signal)));
  // a provider that names an old block as final would have both read the past (an older gas price or pool)
  const spread = heightSpreadOver([finals[0].height, finals[1].height]);
  if (spread !== null) throw new FeeMaxRefused("disagree", `final: ${spread}`);
  const height = Math.min(finals[0].height, finals[1].height);
  const [x, y] = await Promise.all(rpcs.map((r) => headerOf(r, { block_id: height }, signal)));
  if (x.height !== height || y.height !== height) throw new FeeMaxRefused("rpc", `block ${height}: another height in the answer`);
  if (x.hash !== y.hash) throw new FeeMaxRefused("disagree", `block ${height}: the RPCs name different blocks`);
  if (x.gasPrice !== y.gasPrice) throw new FeeMaxRefused("disagree", `block ${height}: the RPCs' gas prices differ`);
  return x;
}

async function headerOf(r: FeeRpc, params: { block_id: number } | { finality: "final" }, signal?: AbortSignal): Promise<Header> {
  let a: unknown;
  try {
    a = await r.block(params, signal);
  } catch (e) {
    throw new FeeMaxRefused("rpc", `${r.name}: no block answer (${e instanceof Error ? e.message : String(e)})`);
  }
  const h = isObj(a) && a.error === undefined && isObj(a.result) ? a.result.header : undefined;
  if (!isObj(h) || !Number.isSafeInteger(h.height) || (h.height as number) <= 0 || typeof h.hash !== "string" || typeof h.gas_price !== "string" || !DEC.test(h.gas_price))
    throw new FeeMaxRefused("rpc", `${r.name}: not a block header with a gas price`);
  return { height: h.height as number, hash: h.hash, gasPrice: BigInt(h.gas_price) };
}

// The pool at one block both providers hold, its answer byte-equal on both: a SIMPLE_POOL of exactly FEE_POOL_TOKENS.
async function readPool(rpcs: readonly [FeeRpc, FeeRpc], signal?: AbortSignal): Promise<{ token: bigint; near: bigint }> {
  const b = await agreedBlock(rpcs, signal);
  const params = {
    request_type: "call_function",
    account_id: FEE_POOL_CONTRACT,
    method_name: "get_pool",
    args_base64: btoa(JSON.stringify({ pool_id: FEE_POOL_ID })),
    block_id: b.height,
  };
  const bytes = await Promise.all(
    rpcs.map(async (r) => {
      let a: unknown;
      try {
        a = await r.query(params, signal);
      } catch (e) {
        throw new FeeMaxRefused("rpc", `${r.name}: no pool answer (${e instanceof Error ? e.message : String(e)})`);
      }
      const res = isObj(a) && a.error === undefined && isObj(a.result) ? a.result : undefined;
      if (!res || res.error !== undefined || res.block_height !== b.height || res.block_hash !== b.hash || !Array.isArray(res.result))
        throw new FeeMaxRefused("rpc", `${r.name}: not the pool at block ${b.height}`);
      if (!res.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new FeeMaxRefused("rpc", `${r.name}: the pool's bytes are not bytes`);
      return Uint8Array.from(res.result as number[]);
    }),
  );
  const [p, q] = bytes;
  if (p!.length !== q!.length || p!.some((x, k) => x !== q![k])) throw new FeeMaxRefused("disagree", `the pool at block ${b.height} differs between the RPCs`);
  let pool: unknown;
  try {
    pool = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(p));
  } catch {
    throw new FeeMaxRefused("pool", "the pool is not JSON");
  }
  if (!isObj(pool) || pool.pool_kind !== "SIMPLE_POOL") throw new FeeMaxRefused("pool", "not a SIMPLE_POOL");
  const ids = pool.token_account_ids;
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] !== FEE_POOL_TOKENS[0] || ids[1] !== FEE_POOL_TOKENS[1]) throw new FeeMaxRefused("pool", "not the USDC / wNEAR pool");
  const amounts = pool.amounts;
  if (!Array.isArray(amounts) || amounts.length !== 2 || !amounts.every((x) => typeof x === "string" && DEC.test(x) && BigInt(x) > 0n))
    throw new FeeMaxRefused("pool", "the pool's amounts are not two u128 decimals above 0");
  const token = BigInt(amounts[0] as string);
  if (token < FEE_POOL_MIN_TOKEN) throw new FeeMaxRefused("pool", `the pool holds ${token} USDC base units, under its floor ${FEE_POOL_MIN_TOKEN}`);
  return { token, near: BigInt(amounts[1] as string) };
}
