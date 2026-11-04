// GET /v1/withdraw/fee?token=<id> and POST /v1/withdraw's fee_min (card relayer-withdraw-fee; markets paper LD5, M:96;
// H3.3's fee_min, M:1068-1082; H3.4 check 3, M:1122-1126; the route row, M:3361; the kit's HelperWithdrawFeeAnswer,
// packages/kit/src/helper/v1.ts). The relayer quotes an absolute relay_fee = fee_min in the token's base units; the
// device binds it in the proof's context and refuses it above its own fee_max (packages/wallet/src/withdraw/feemax.ts).
//
//   fee_min = ceil((G_w × gp × 1.2 + S_w) × px)
//   S_w     = B_w × 1e19 + register_deposit + G_settle × gp + A_fund + G_arm × gp
//
// - G_w = 92.505 Tgas: the whole withdraw transaction with its payouts at depth 32, a new recipient (the G1 vault gas
//   proof, research proofs/g1-vault-gas/RESULT.md l.57, the top of M:1077's 87.993-92.505). B_w = 858 B (710 + 148, a
//   tree that grows a level, M:1069), G_settle = 104.475 Tgas (a settle writing a refund note, M:1082), G_arm = 100
//   Tgas (A's relayed call, capped until G1 measures it) and A_fund = 182 B × 1e19 + 0.007 N (W:742): every withdrawal
//   pays an A_{l,j} (W:671), and the relayer cannot know at the quote whether a tree grows. They are the device's own
//   cap terms halved (feemax.ts: S_cap = 2 × S_w, G_cap = 2 × G_w), so an honest quote is at most half its fee_max at
//   the same reads (P1, M:3010): 1.2 / 3 on the withdraw gas, 1 / 2 on every other term.
// - register_deposit: at the quote, the token's storage_balance_bounds().min, the one a fresh A pays (H3.4 check 7,
//   M:1380); on POST, the request's own (check 7 refuses any other value later).
// - gp and px are read as the device reads them (LD1; feemax.ts): gp is the gas_price of one final block both of the
//   network's providers hold, their two finals at most HEIGHT_SPREAD_MAX blocks apart, the same height, hash and
//   gas_price on both; px is Ref pool FEE_POOL_ID on mainnet at one such block, byte-equal on both, a SIMPLE_POOL of
//   exactly USDC and wrap.near whose USDC side holds at least FEE_POOL_MIN_TOKEN. Testnet NEAR has no price: the
//   testnet token is mainnet USDC's own code (contracts/vault/deployments/testnet-usdc.json), so it is priced as
//   mainnet USDC. One more rule the device has no clock for: the agreed block is at most MAX_FINAL_AGE_MS behind the
//   helper's clock (withdraw/index.ts), so two frozen providers cannot price a quote, or hold one open, from the past.
//   Anything else (an error, a disagreement, a pool under the floor) throws, and no quote and no fee_min is given.
// - The window, one rule for both paths: a quote is valid until valid_until_block = the agreed height +
//   FEE_QUOTE_WINDOW_BLOCKS. The relayer keeps its open quotes, each with the register_deposit it was priced at; on POST
//   it re-reads and asks relay_fee >= min(the fee_min now, the lowest quote of its own still open at the agreed height
//   now and priced at a register_deposit at or above the body's). So within the window it holds to what it quoted,
//   whatever the price did since, and past it the price now decides (fee_too_low). A device refused fee_too_low stops
//   and gets its note back only after deadline_ms (up to 600 s, wallet request.ts WITHDRAW_DEADLINE_MAX_MS), so the open quotes are kept in the relayers' durable
//   store (store/durable.ts) when the host gives one (HELPER_STORE_DIR): a restart inside the window holds to them too.
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { type HelperWithdrawFeeAnswer } from "@blindfill/kit";
import { nearRpc, RPC_TIMEOUT_MS } from "../bind/send.ts";
import type { Rpc } from "../near/pages.ts";
import { openDurableDir, type DurableDir } from "../store/durable.ts";
import { readUrls, TESTNET_RPCS, TESTNET_TOKEN, USDC } from "../token-status/status.ts";
import { decimal, isAccountId, type CheckedWithdraw, type WithdrawReads } from "./checks.ts";
import { MAX_FINAL_AGE_MS } from "./index.ts";

// ---- Values ----

/** Gas a withdrawal burns: 92.505 Tgas, depth 32, a new recipient (G1, RESULT.md l.57). */
export const FEE_G_W = 92_505_000_000_000n;
/** Bytes a withdraw writes, a tree that grows a level: 710 + 148 (M:1069). */
export const FEE_B_W = 858n;
/** NEAR's storage price, yocto per byte. */
export const STORAGE_YOCTO_PER_BYTE = 10_000_000_000_000_000_000n;
/** A settle that writes a refund note: 101.475 + 3 Tgas (M:1082, E). */
export const FEE_G_SETTLE = 104_475_000_000_000n;
/** A's relayed call: 100 Tgas until G1 measures it (feemax.ts FEE_G_ARM_CAP). */
export const FEE_G_ARM = 100_000_000_000_000n;
/** A's funding: its record and key (182 B × 1e19) and NEAR's 0.007 N account creation charge, in yocto (W:742). */
export const FEE_A_FUND = 182n * STORAGE_YOCTO_PER_BYTE + 7_000_000_000_000_000_000_000n;
/** The price pool: Ref's USDC / wNEAR SIMPLE_POOL on mainnet, its tokens in the pool's order (feemax.ts). */
export const FEE_POOL_CONTRACT = "v2.ref-finance.near";
export const FEE_POOL_ID = 4512;
export const FEE_POOL_TOKENS = [USDC, "wrap.near"] as const;
/** The pool's USDC side must hold at least 250,000 USDC, else no quote (feemax.ts FEE_POOL_MIN_TOKEN). */
export const FEE_POOL_MIN_TOKEN = 250_000_000_000n;
/** Two providers' finals may stand this many blocks apart at most (the device's HEIGHT_SPREAD_MAX, wallet deposit/account.ts). */
export const HEIGHT_SPREAD_MAX = 30n;
/**
 * A quote's life in blocks: about 58 s at NEAR's 576 ms blocks (F57, M:105), seven times the 8.3 s a withdraw proof
 * takes on the owner's iPhone (G1 proof 2, M304 D-9; W:1718), and inside check 9's 120 s send margin
 * (wallet request.ts WITHDRAW_SEND_MARGIN_MS) [design].
 */
export const FEE_QUOTE_WINDOW_BLOCKS = 100;
/** One pair of reads per network per this long, however many callers ask (about one NEAR block; token-status's CACHE_MS). */
export const FEE_CACHE_MS = 1_000;
/**
 * The furthest a held quote can stand ahead of an agreed height: its own agreed height + FEE_QUOTE_WINDOW_BLOCKS, and an
 * agreed height at POST at most HEIGHT_SPREAD_MAX under the one it was quoted at, + 1 of slack. A loaded quote further
 * ahead is no quote of this chain's (a testnet reset) and is dropped.
 */
export const FEE_QUOTE_AHEAD_MAX = BigInt(FEE_QUOTE_WINDOW_BLOCKS) + HEIGHT_SPREAD_MAX + 1n;
/** The testnet token and testnet's two providers: the token watch's (token-status/status.ts WATCHED), one list. */
export { TESTNET_RPCS, TESTNET_TOKEN };

const U128 = 1n << 128n;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export type FeeNetwork = "mainnet" | "testnet";

/** The release's relayer on one network: the account that sends and the one the fee is paid to. */
export type FeeRelayer = { relayer_account: string; fee_recipient: string };

export class FeeReadRefused extends Error {
  constructor(detail: string) {
    super(`fee read refused: ${detail}`);
    this.name = "FeeReadRefused";
  }
}

// ---- The formula ----

export type FeeInputs = { gasPrice: bigint; poolToken: bigint; poolNear: bigint; registerDeposit: bigint };

/** H3.3's fee_min in the token's base units, rounded up. */
export function withdrawFeeMin(i: FeeInputs): bigint {
  for (const [k, v] of Object.entries(i)) if (typeof v !== "bigint" || v < 0n || v >= U128) throw new FeeReadRefused(`${k}: not a u128`);
  const { gasPrice: gp, poolToken, poolNear, registerDeposit } = i;
  if (gp === 0n || poolToken === 0n || poolNear === 0n) throw new FeeReadRefused("gas price and pool amounts must be above 0");
  const sW = FEE_B_W * STORAGE_YOCTO_PER_BYTE + registerDeposit + FEE_G_SETTLE * gp + FEE_A_FUND + FEE_G_ARM * gp;
  // (G_w × gp × 1.2 + S_w) × poolToken / poolNear, with 1.2 = 6 / 5, rounded up
  const num = (FEE_G_W * gp * 6n + 5n * sW) * poolToken;
  const den = 5n * poolNear;
  const fee = (num + den - 1n) / den;
  // the vault's relay_fee is a u128: an answer past it is a read gone wrong, never a quote
  if (fee >= U128) throw new FeeReadRefused("fee_min: over the u128 the contract takes");
  return fee;
}

/** The token's whole units per NEAR, 12 places, rounded down: the answer's px, shown, never used for a bound. */
export function pxOf(poolToken: bigint, poolNear: bigint): string {
  // (poolToken / 1e6) / (poolNear / 1e24) whole tokens per NEAR, × 1e12 for the places
  const scaled = (poolToken * 10n ** 30n) / poolNear;
  const s = scaled.toString().padStart(13, "0");
  const int = s.slice(0, -12).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-12).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

// ---- The reads ----

export type Block = { height: bigint; hash: string; gasPrice: bigint; ms: bigint };

function headerOf(a: unknown, who: string): Block {
  const h = isObj(a) && isObj(a.header) ? a.header : undefined;
  if (!h || typeof h.height !== "number" || !Number.isSafeInteger(h.height) || h.height <= 0 || typeof h.hash !== "string" || !B58.test(h.hash))
    throw new FeeReadRefused(`${who}: not a block header`);
  const gp = decimal(h.gas_price, U128);
  const ns = decimal(h.timestamp_nanosec, 1n << 64n);
  if (gp === null || gp === 0n) throw new FeeReadRefused(`${who}: no gas_price`);
  if (ns === null) throw new FeeReadRefused(`${who}: no timestamp_nanosec`);
  return { height: BigInt(h.height), hash: h.hash, gasPrice: gp, ms: ns / 1_000_000n };
}

async function call(r: Rpc, who: string, method: string, params: unknown): Promise<unknown> {
  try {
    return await r(method, params);
  } catch (e) {
    throw new FeeReadRefused(`${who}: ${method} did not answer (${e instanceof Error ? e.message.slice(0, 200) : "error"})`);
  }
}

/**
 * The newest block both providers hold as final: the lower of their finals, at most HEIGHT_SPREAD_MAX apart, then that
 * height's header on both, one hash and one gas_price, at most MAX_FINAL_AGE_MS behind `now`.
 */
export async function agreedBlock(rpcs: readonly [Rpc, Rpc], now: () => number): Promise<Block> {
  const finals = await Promise.all(rpcs.map(async (r, i) => headerOf(await call(r, `rpc ${i}`, "block", { finality: "final" }), `rpc ${i} final`)));
  const [a, b] = finals as [Block, Block];
  const spread = a.height > b.height ? a.height - b.height : b.height - a.height;
  if (spread > HEIGHT_SPREAD_MAX) throw new FeeReadRefused(`final: the providers' finals stand ${spread} blocks apart, over ${HEIGHT_SPREAD_MAX}`);
  const height = a.height < b.height ? a.height : b.height;
  // finals at one height are already that height's header on both; else the header at the lower one, read on both
  const [x, y] =
    a.height === b.height
      ? [a, b]
      : ((await Promise.all(rpcs.map(async (r, i) => headerOf(await call(r, `rpc ${i}`, "block", { block_id: Number(height) }), `rpc ${i} block ${height}`)))) as [Block, Block]);
  if (x.height !== height || y.height !== height) throw new FeeReadRefused(`block ${height}: another height in the answer`);
  if (x.hash !== y.hash) throw new FeeReadRefused(`block ${height}: the providers name different blocks`);
  if (x.gasPrice !== y.gasPrice) throw new FeeReadRefused(`block ${height}: the providers' gas prices differ`);
  const age = BigInt(Math.floor(now())) - x.ms;
  if (age > MAX_FINAL_AGE_MS) throw new FeeReadRefused(`block ${height}: ${age} ms behind the helper's clock, over ${MAX_FINAL_AGE_MS}`);
  return x;
}

/** One view at block `b` on both providers, its bytes equal on both, parsed as JSON. */
export async function viewAt(rpcs: readonly [Rpc, Rpc], b: Block, account: string, method: string, args: unknown): Promise<unknown> {
  const params = { request_type: "call_function", block_id: Number(b.height), account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") };
  const bytes = await Promise.all(
    rpcs.map(async (r, i) => {
      const a = await call(r, `rpc ${i}`, "query", params);
      if (!isObj(a) || a.block_height !== Number(b.height) || a.block_hash !== b.hash || !Array.isArray(a.result)) throw new FeeReadRefused(`rpc ${i}: ${method} not answered at block ${b.height}`);
      if (!a.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new FeeReadRefused(`rpc ${i}: ${method}'s result is not bytes`);
      return Buffer.from(a.result as number[]);
    }),
  );
  if (!bytes[0]!.equals(bytes[1]!)) throw new FeeReadRefused(`${method} at block ${b.height}: the providers' bytes differ`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes[0]));
  } catch {
    throw new FeeReadRefused(`${method}: not JSON`);
  }
}

/** The price pool at block `b` on mainnet's pair: a SIMPLE_POOL of exactly FEE_POOL_TOKENS, its USDC side at the floor or above. */
export async function readPool(rpcs: readonly [Rpc, Rpc], b: Block): Promise<{ token: bigint; near: bigint }> {
  const pool = await viewAt(rpcs, b, FEE_POOL_CONTRACT, "get_pool", { pool_id: FEE_POOL_ID });
  if (!isObj(pool) || pool.pool_kind !== "SIMPLE_POOL") throw new FeeReadRefused("pool: not a SIMPLE_POOL");
  const ids = pool.token_account_ids;
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] !== FEE_POOL_TOKENS[0] || ids[1] !== FEE_POOL_TOKENS[1]) throw new FeeReadRefused("pool: not the USDC / wNEAR pool");
  const am = pool.amounts;
  const token = Array.isArray(am) && am.length === 2 ? decimal(am[0], U128) : null;
  const near = Array.isArray(am) && am.length === 2 ? decimal(am[1], U128) : null;
  if (token === null || near === null || token === 0n || near === 0n) throw new FeeReadRefused("pool: the amounts are not two u128 decimals above 0");
  if (token < FEE_POOL_MIN_TOKEN) throw new FeeReadRefused(`pool: its USDC side ${token} is under the floor ${FEE_POOL_MIN_TOKEN}`);
  return { token, near };
}

/** The token's storage_balance_bounds().min at block `b` (NEP-145), equal on both providers: what a fresh A registers with. */
export async function readRegisterMin(rpcs: readonly [Rpc, Rpc], b: Block, token: string): Promise<bigint> {
  const bounds = await viewAt(rpcs, b, token, "storage_balance_bounds", {});
  const min = isObj(bounds) ? decimal(bounds.min, U128) : null;
  if (min === null) throw new FeeReadRefused("storage_balance_bounds: no u128 min");
  return min;
}

// ---- The quoter: one per helper, both networks ----

export type FeeNetworkConfig = {
  /** The network's two providers of two operators: its gas price and its token's registration. */
  rpcs: readonly [Rpc, Rpc];
  /** The release's relayer on this network. */
  relayer: FeeRelayer;
};

export type FeeQuoterConfig = {
  /** Mainnet's pair: the price pool, on every network. */
  priceRpcs: readonly [Rpc, Rpc];
  networks: Partial<Record<FeeNetwork, FeeNetworkConfig>>;
  now?: () => number;
  /** The relayers' durable store: the open quotes outlive a restart. Without it they are kept in memory only. */
  store?: DurableDir;
};

export type FeeQuoter = {
  /** The network a token's quotes are on, or null for a token this relayer does not carry. */
  networkOf(token: string): FeeNetwork | null;
  /** GET /v1/withdraw/fee's answer for `token`; throws FeeReadRefused on any read that fails or disagrees. */
  quote(token: string): Promise<HelperWithdrawFeeAnswer>;
  /** POST /v1/withdraw's check 3 fee_min on `network`: the fee_min now, or a lower quote of ours still in its window. */
  reads(network: FeeNetwork): WithdrawReads;
};

const TOKENS: Record<FeeNetwork, string> = { mainnet: USDC, testnet: TESTNET_TOKEN };

export function createFeeQuoter(cfg: FeeQuoterConfig): FeeQuoter {
  const now = cfg.now ?? Date.now;
  for (const [n, c] of Object.entries(cfg.networks)) {
    if (!c || !isAccountId(c.relayer.relayer_account) || !isAccountId(c.relayer.fee_recipient)) throw new Error(`${n}: the relayer's accounts must be NEAR account ids`);
  }
  // The open quotes, per network: valid_until_block -> the lowest fee quoted with it and the register_deposit it was
  // priced at. Pruned on every write and read once past, or once further ahead than FEE_QUOTE_AHEAD_MAX; at most
  // FEE_QUOTE_WINDOW_BLOCKS + 1 entries a network.
  type Open = Map<bigint, { fee: bigint; registerMin: bigint }>;
  const fileOf = (n: FeeNetwork) => `fee-quotes-${n}.json`;
  const load = (n: FeeNetwork): Open => {
    const m: Open = new Map();
    const text = cfg.store?.text(fileOf(n));
    if (!text) return m;
    try {
      const rows = JSON.parse(text) as unknown;
      if (Array.isArray(rows))
        for (const r of rows) {
          const until = decimal(r?.until, U128);
          const fee = decimal(r?.fee, U128);
          const registerMin = decimal(r?.register_min, U128);
          if (until !== null && fee !== null && registerMin !== null) m.set(until, { fee, registerMin });
        }
    } catch {
      // an unreadable file holds no quote: the price now decides
    }
    return m;
  };
  const given: Record<FeeNetwork, Open> = { mainnet: load("mainnet"), testnet: load("testnet") };
  const prune = (n: FeeNetwork, height: bigint) => {
    for (const until of given[n].keys()) if (until < height || until > height + FEE_QUOTE_AHEAD_MAX) given[n].delete(until);
  };
  const save = (n: FeeNetwork) => {
    if (!cfg.store) return;
    const rows = [...given[n]].map(([until, q]) => ({ until: until.toString(), fee: q.fee.toString(), register_min: q.registerMin.toString() }));
    cfg.store.replace(fileOf(n), JSON.stringify(rows));
  };

  type Priced = { block: Block; pool: { token: bigint; near: bigint }; registerMin: bigint };
  // One read per network at a time: a pending read is shared by every caller, and its answer, a refusal included, is
  // served for FEE_CACHE_MS after it settles (still fail closed: a refusal is served as a refusal).
  const cache: Partial<Record<FeeNetwork, { p: Promise<Priced>; settled: number | null }>> = {};
  const priced = (network: FeeNetwork): Promise<Priced> => {
    const c = cache[network];
    if (c && (c.settled === null || now() - c.settled < FEE_CACHE_MS)) return c.p;
    const net = cfg.networks[network]!;
    const p = (async () => {
      const [block, price] = await Promise.all([agreedBlock(net.rpcs, now), network === "mainnet" ? null : agreedBlock(cfg.priceRpcs, now)]);
      const [pool, registerMin] = await Promise.all([readPool(cfg.priceRpcs, price ?? block), readRegisterMin(net.rpcs, block, TOKENS[network])]);
      return { block, pool, registerMin };
    })();
    const entry: { p: Promise<Priced>; settled: number | null } = { p, settled: null };
    cache[network] = entry;
    const done = () => {
      entry.settled = now();
    };
    p.then(done, done);
    return p;
  };

  const networkOf = (token: string): FeeNetwork | null => {
    for (const n of Object.keys(TOKENS) as FeeNetwork[]) if (TOKENS[n] === token && cfg.networks[n]) return n;
    return null;
  };

  return {
    networkOf,
    async quote(token) {
      const network = networkOf(token);
      if (network === null) throw new Error("token: not one this relayer carries");
      const net = cfg.networks[network]!;
      const { block, pool, registerMin } = await priced(network);
      const fee = withdrawFeeMin({ gasPrice: block.gasPrice, poolToken: pool.token, poolNear: pool.near, registerDeposit: registerMin });
      const until = block.height + BigInt(FEE_QUOTE_WINDOW_BLOCKS);
      const had = given[network].get(until);
      if (had === undefined || fee < had.fee) {
        prune(network, block.height);
        given[network].set(until, { fee, registerMin });
        save(network);
      }
      // at most 2 × 64-character accounts, three u128 decimals, a px and a height: about 500 bytes, under the 1 KB limit
      return {
        relayer_account: net.relayer.relayer_account,
        fee_recipient: net.relayer.fee_recipient,
        relay_fee: fee.toString(),
        gp: block.gasPrice.toString(),
        px: pxOf(pool.token, pool.near),
        g_w: FEE_G_W.toString(),
        valid_until_block: Number(until),
      };
    },
    reads(network) {
      if (!cfg.networks[network]) throw new Error(`${network}: not a network this relayer carries`);
      return {
        async feeMin(w: CheckedWithdraw) {
          const { block, pool } = await priced(network);
          const fresh = withdrawFeeMin({ gasPrice: block.gasPrice, poolToken: pool.token, poolNear: pool.near, registerDeposit: w.register_deposit });
          prune(network, block.height);
          let quoted: bigint | undefined;
          // a quote counts only for a body whose register_deposit it covered
          for (const q of given[network].values()) if (q.registerMin >= w.register_deposit && (quoted === undefined || q.fee < quoted)) quoted = q.fee;
          return quoted !== undefined && quoted < fresh ? quoted : fresh;
        },
      };
    },
  };
}

// ---- The host's configuration ----

/** The relayers' durable store folder (store/durable.ts; deploy/compose.yaml mounts a volume there). */
export const STORE_ENV = "HELPER_STORE_DIR";
/** The release's relayer per network: a network is quoted only when both its accounts are set. */
export const RELAYER_ENV = {
  mainnet: ["WITHDRAW_RELAYER_MAINNET", "WITHDRAW_FEE_RECIPIENT_MAINNET"],
  testnet: ["WITHDRAW_RELAYER_TESTNET", "WITHDRAW_FEE_RECIPIENT_TESTNET"],
} as const;

/**
 * The quoter from the host's environment: mainnet's pair as USDC's watch reads it (NEAR_RPC_URL, NEAR_RPC_URL_B), each
 * read bounded by the relayers' RPC_TIMEOUT_MS (bind/send.ts): a full block from rpc.mainnet.near.org took 3.3 s from
 * a Mac (curl, 2026-11-02 09:27Z), so token-status's 2 s would refuse an honest provider. `lockWaitMs`: the store's
 * lock wait (store/durable.ts openDurableDir; 0 for a retry that must not block, server.ts sendersFromEnv).
 */
export function feeQuoterFromEnv(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch, lockWaitMs?: number): FeeQuoter {
  const mainnet = readUrls(env, "mainnet").map((u) => nearRpc(u, fetchFn, RPC_TIMEOUT_MS)) as [Rpc, Rpc];
  const testnetUrls = TESTNET_RPCS.map(({ env: k, fallback }) => {
    const v = env[k];
    if (v === undefined || v === "") return fallback;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${k} must be an http(s) URL`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "") throw new Error(`${k} must be an http(s) URL with no fragment`);
    return v;
  });
  if (testnetUrls[0] === testnetUrls[1]) throw new Error(`${TESTNET_RPCS[0].env} and ${TESTNET_RPCS[1].env} must be two different providers`);
  const pairs: Record<FeeNetwork, readonly [Rpc, Rpc]> = { mainnet, testnet: testnetUrls.map((u) => nearRpc(u, fetchFn, RPC_TIMEOUT_MS)) as [Rpc, Rpc] };
  const networks: Partial<Record<FeeNetwork, FeeNetworkConfig>> = {};
  for (const n of Object.keys(RELAYER_ENV) as FeeNetwork[]) {
    const [a, f] = RELAYER_ENV[n].map((k) => env[k] ?? "");
    if (a === "" && f === "") continue;
    if (!isAccountId(a) || !isAccountId(f)) throw new Error(`${RELAYER_ENV[n].join(" and ")} must both be NEAR account ids`);
    networks[n] = { rpcs: pairs[n], relayer: { relayer_account: a!, fee_recipient: f! } };
  }
  // the relayers' durable store (store/durable.ts), its own folder under HELPER_STORE_DIR; none set: memory only. Opened
  // only for a relayer network: a helper that quotes nothing never stops at start on a store it does not use.
  const dir = env[STORE_ENV] ?? "";
  const store = dir === "" || Object.keys(networks).length === 0 ? undefined : openDurableDir(join(dir, "withdraw-fee"), nodeFs, (d) => d, lockWaitMs);
  return createFeeQuoter({ priceRpcs: mainnet, networks, ...(store ? { store } : {}) });
}
