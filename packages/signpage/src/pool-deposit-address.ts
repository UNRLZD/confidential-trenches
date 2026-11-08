// pool.address on the postMessage API (card pool-deposit-address): where money for chain X's pool goes. From public
// records only, as deposit.quote (./deposit-wire.ts): the page never opens the seed here.
// - U_X is named ahead (./deposit-name.ts): meta/"deposit/<s>" of the pool's scope s holds the note store's PLANNED
//   deposit index, U_{s,i}'s 64-hex id and, on Base and Robinhood, U^evm_{s,i}'s EIP-55 address. On Solana U_X is the
//   base58 of the id's 32 bytes (the same ed25519 key); on an EVM chain it is the record's address. A chain the page's
//   network does not pin, a record of another scope, or an EVM record with no address: not_allowed, nothing sent.
// - Signed out, or a no-PRF seed whose backup is not saved (backupFirst, OD:20): not_allowed, nothing sent.
// - With `origin_asset` and `amount`: a 1Click quote to U_X (../../wallet/src/deposit/quote.ts poolDepositQuoteRequest:
//   X's coin to U_X on X, the refund under U_{s,i}'s id inside intents.near, the key the refund move signs with), sent
//   through the helper's proxy and checked by ./pool-deposit-quote.ts before its address goes out, at the device's own
//   price reads of both assets (`priced`; none for an asset: not_allowed). Over the beta cap (HELPER_BIND_DEPOSIT_CAP,
//   in USD at the origin's higher read): above_max before anything is sent. The helper's 429 busy, 503 or no answer
//   down, any other status not_available; an answer that fails a check quote_check_failed.
// - The records are read again once the quote is back: a sign out, another account or an index that moved since drops
//   the address (not_allowed). An address goes out only under a request id and once `checked` took it (the follow that
//   carries the money on into X's pool): with no `checked`, a quote is refused not_allowed, so no address is shown
//   that nothing follows. A read that throws is down (not kept for the id, so the same request runs again).
// - A quote only when the page's pools are pinned on the network 1Click pays out on (POOL_DEPOSIT_NETWORK, mainnet):
//   the testnet build gives the same-chain U_X but refuses a quote not_allowed, nothing sent.
// - A quote whose min out is under the device's own floor for X's pool is refused not_allowed (pool-deposit-quote.ts
//   "floor"; card pool-deposit-follow): the rung plus one deposit's worst-case cost (and on Solana the rent U_X keeps),
//   read at quote time on two RPCs (`floor`: readSolanaPoolFloor on Solana). No floor read, or one that answers null:
//   not_allowed, nothing sent; a read that throws: down.
import { base58, base64, hex } from "@scure/base";
import { backupFirst, type DepositRecord } from "@blindfill/wallet/store";
import { ONECLICK_USDC_ASSETS, type OneClickPricing } from "../../kit/src/checks/oneclick.ts";
import { HELPER_BIND_DEPOSIT_CAP } from "../../kit/src/helper/v1.ts";
import { POOL_ASSET_DECIMALS, type PoolAsset, type PoolChain, type SignpageResults } from "../../kit/src/signpage/messages.ts";
import { POOL_DEPOSIT_NETWORK, askDepositQuote, poolDepositQuoteRequest } from "../../wallet/src/deposit/quote.ts";
import type { Deferred, HostAnswer, HostRefusal } from "./api.ts";
import type { DepositPublic } from "./deposit-wire.ts";
import { checkPoolDepositQuote, solanaPoolDepositFloor } from "./pool-deposit-quote.ts";
import { readSolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaPoolDepositTx } from "../../kit/src/trade/solana/pool-deposit.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { SOL_LADDER } from "../../wallet/src/pool/solana.ts";
import { DepositRuleRefused } from "./rules/deposit.ts";
import { DEPOSIT_ANSWERED, DEPOSIT_QUOTE_PATH } from "./rules/deposit-dry.ts";

/** Each pool chain's asset (state.pools' table): SOL on Solana, ETH on Base and Robinhood. */
export const POOL_ADDRESS_ASSET: Readonly<Record<PoolChain, PoolAsset>> = Object.freeze({ solana: "SOL", base: "ETH", robinhood: "ETH" });
const USDC_DECIMALS = 6;

/** The device's own price reads for a quote into X's pool: the origin's decimals and both assets' two USD reads. */
export interface PoolQuotePricing {
  decimalsIn: number;
  pricing: Exclude<OneClickPricing, "usdc">;
}

export interface PoolAddressDeps {
  /** The pools the page's network pins (src/pools.ts PAGE_POOLS), each under its scope. */
  pools(): readonly { chain: PoolChain; scope: bigint }[];
  /** The network those pools are pinned on (src/pools.ts PAGE_POOLS: the build's). A quote only on POOL_DEPOSIT_NETWORK. */
  network: "mainnet" | "testnet";
  /** Reads the public records of `scope` (src/state.ts depositRead); never the seed. */
  read(scope: bigint): Promise<DepositPublic | null>;
  /** Settles once the top-level page's naming in flight is done (src/deposit-name.ts named). */
  named?(): Promise<unknown>;
  /** The device's own two price reads of `originAsset` and of X's coin; null when it has none. */
  priced?(chain: PoolChain, originAsset: string): PoolQuotePricing | null;
  /** The follow that takes a checked quote under request `id` on into X's pool; none, and no quote is answered. */
  /** The device's floor for a quote into X's pool to U_X, read at quote time on two RPCs (readSolanaPoolFloor); null
   *  when it has none for the chain. None given: no quote. */
  floor?(chain: PoolChain, wallet: string): Promise<bigint | null>;
  checked?(id: string, chain: PoolChain, result: NonNullable<SignpageResults["pool.address"]["quote"]>, u: { scope: bigint; index: number; wallet: string; refundId: string }): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Named = { record: DepositRecord; wallet: string; status: NonNullable<DepositPublic["status"]> };

/** U_X from the scope's record: the id's own key in base58 on Solana, the record's EIP-55 address on an EVM chain. */
function walletOf(chain: PoolChain, rec: DepositRecord): string | null {
  if (chain === "solana") return rec.evm === undefined ? base58.encode(hex.decode(rec.id)) : null;
  return rec.evm ?? null;
}

function usable(p: DepositPublic | null, chain: PoolChain, scope: bigint): Named | null {
  if (!p || !p.status || !p.deposit || backupFirst(p.status)) return null;
  if (p.deposit.scope !== scope.toString()) return null;
  const wallet = walletOf(chain, p.deposit);
  return wallet === null ? null : { record: p.deposit, wallet, status: p.status };
}

const same = (a: Named, b: Named): boolean =>
  a.wallet === b.wallet && a.record.scope === b.record.scope && a.record.index === b.record.index && a.record.id === b.record.id;

const DEC = /^[0-9]+(\.[0-9]+)?$/;
/** A decimal in base units at `decimals`, exactly; null when it has more fraction digits or is not a decimal. */
function units(v: unknown, decimals: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i = "", f = ""] = v.split(".");
  if (f.length > decimals) return null;
  return BigInt(i + f.padEnd(decimals, "0"));
}
/** Base units as a decimal at `decimals`, with no trailing zero in the fraction. */
function decimal(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}
const PRICE = /^[0-9]+(\.[0-9]{1,18})?$/;
/** A price read as an exact positive fraction n / d, or null. */
function fraction(v: unknown): { n: bigint; d: bigint } | null {
  if (typeof v !== "string" || !PRICE.test(v)) return null;
  const [i = "", f = ""] = v.split(".");
  const n = BigInt(i + f);
  return n > 0n ? { n, d: 10n ** BigInt(f.length) } : null;
}
/** True when `amount` of the origin is worth more than the cap (USDC base units) at its higher read; null when a read
 *  is not a price. */
function aboveCap(amount: bigint, decimalsIn: number, reads: readonly [string, string]): boolean | null {
  const [a, b] = reads.map(fraction);
  if (!a || !b) return null;
  const p = a.n * b.d >= b.n * a.d ? a : b;
  return amount * p.n * 10n ** BigInt(USDC_DECIMALS) > HELPER_BIND_DEPOSIT_CAP * p.d * 10n ** BigInt(decimalsIn);
}

/**
 * The Solana floor at quote time (card pool-deposit-follow): the Rent sysvar on both RPCs (the kit's readSolanaRent: two
 * providers, one rate), and the fee each RPC prices a deposit message by U_X at (getFeeForMessage of the kit's own
 * deposit tx at that RPC's latest blockhash; the fee is per signature, so the note's value, precommitment and the trees'
 * sizes do not move it), the higher of the two. A read that does not answer throws (the host answers down).
 */
export async function readSolanaPoolFloor(rpcs: readonly [SolanaRpc, SolanaRpc], program: string, wallet: string): Promise<bigint> {
  const rent = await readSolanaRent(rpcs);
  const fees = await Promise.all(rpcs.map(async (rpc) => {
    const bh = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value?: { blockhash?: unknown } } | null;
    const blockhash = bh?.value?.blockhash;
    if (typeof blockhash !== "string") throw new Error("no blockhash");
    const { message } = solanaPoolDepositTx(program, wallet, { value: SOL_LADDER.min, precommitment: 1n }, { stateSize: 0, labelSize: 0 }, blockhash);
    const v = ((await rpc("getFeeForMessage", [base64.encode(message), { commitment: "confirmed" }])) as { value?: unknown } | null)?.value;
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error("no fee for the deposit message");
    return BigInt(v as number);
  }));
  const fee = fees[0]! > fees[1]! ? fees[0]! : fees[1]!;
  return solanaPoolDepositFloor(fee, rent);
}

/** The pool.address handler for ApiHost.kinds: a Deferred answered once the records, and a quote when asked, are done. */
export function poolAddressHost(deps: PoolAddressDeps): (params: Record<string, unknown>, ctx?: { id: string }) => Deferred<"pool.address"> {
  return (params, ctx) => {
    let out: HostAnswer<"pool.address"> | HostRefusal = { error: "not_allowed" };
    const after = (async () => {
      const chain = params.chain as PoolChain;
      const pool = deps.pools().find((p) => p.chain === chain);
      if (pool === undefined) return;
      const asset = POOL_ADDRESS_ASSET[chain];
      const quoted = params.origin_asset !== undefined || params.amount !== undefined;
      await deps.named?.().catch(() => {});
      const before = usable(await deps.read(pool.scope), chain, pool.scope);
      if (!before) return;
      if (!quoted) return void (out = { result: { chain, address: before.wallet, asset } });

      // a quote: only under a request id, with a follow to carry the money on, and the device's own price reads
      if (ctx === undefined || deps.checked === undefined || deps.floor === undefined) return;
      if (deps.network !== POOL_DEPOSIT_NETWORK) return; // 1Click pays out on mainnet only: never to a devnet pool's U_X
      const origin = params.origin_asset;
      if (typeof origin !== "string") return;
      const priced = deps.priced?.(chain, origin) ?? null;
      if (priced === null || !Number.isInteger(priced.decimalsIn) || priced.decimalsIn < 0 || priced.decimalsIn > 36) return;
      const amount = units(params.amount, priced.decimalsIn);
      if (amount === null || amount === 0n) return;
      const over = ONECLICK_USDC_ASSETS.includes(origin) && priced.decimalsIn === USDC_DECIMALS
        ? amount > HELPER_BIND_DEPOSIT_CAP // USDC base units, as the cap
        : aboveCap(amount, priced.decimalsIn, priced.pricing.in);
      if (over === null) return;
      if (over) return void (out = { error: "above_max" });

      let floor: bigint | null;
      try {
        floor = await deps.floor(chain, before.wallet);
      } catch {
        return void (out = { error: "down" });
      }
      if (floor === null) return;

      const now = deps.now ?? Date.now;
      let request;
      try {
        request = poolDepositQuoteRequest(chain, before.wallet, before.record.id, origin, amount, now());
      } catch {
        return;
      }
      let reply;
      try {
        reply = await askDepositQuote(request, deps.fetch);
      } catch {
        return void (out = { error: "down" });
      }
      if (reply.status === 429) return void (out = { error: "busy" });
      if (reply.status === 503) return void (out = { error: "down" });
      if (!DEPOSIT_ANSWERED.includes(reply.status)) return void (out = { error: "not_available" });
      const decimalsOut = POOL_ASSET_DECIMALS[asset];
      let checked;
      try {
        checked = checkPoolDepositQuote(request, reply.body, {
          seed: before.status,
          chain,
          wallet: before.wallet,
          refundId: before.record.id,
          check: { path: DEPOSIT_QUOTE_PATH, pricing: priced.pricing, decimalsIn: priced.decimalsIn, decimalsOut, now: now() },
          floor,
        });
      } catch (e) {
        return void (out = { error: e instanceof DepositRuleRefused ? "not_allowed" : "quote_check_failed" });
      }
      const timeEstimate = checked.timeEstimate;
      if (checked.depositAddress === undefined || checked.deadline === undefined) return void (out = { error: "quote_check_failed" });
      if (typeof timeEstimate !== "number" || !Number.isSafeInteger(timeEstimate) || timeEstimate < 0) return void (out = { error: "quote_check_failed" });

      // the address stands only while the records are the ones it was asked under
      const now2 = usable(await deps.read(pool.scope), chain, pool.scope);
      if (!now2 || !same(now2, before)) return;
      const quote = {
        deposit_address: checked.depositAddress,
        origin_asset: origin,
        amount_in: decimal(checked.amountIn, priced.decimalsIn),
        min_amount_out: decimal(checked.minAmountOut, decimalsOut),
        deadline: checked.deadline,
        time_estimate_s: timeEstimate,
      };
      await deps.checked(ctx.id, chain, quote, { scope: pool.scope, index: before.record.index, wallet: before.wallet, refundId: before.record.id });
      out = { result: { chain, address: before.wallet, asset, quote } };
    })().catch(() => {
      out = { error: "down" };
    });
    return { after, answer: () => out };
  };
}
