// pool.sell.dry on SIGN_HOST (card app-sell-shows-what-you-receive): what a pool.sell of the same params would give,
// for the sell box's You receive, Network and Fee before the tap. Display only: nothing is built, signed, written or
// sent, and no pool.sell ever takes these numbers (each sale reads and checks its own quote before W signs).
//
// - One code path with the sale: the units are pool.sell's own (pool-sell.ts poolSellUnits, as planPoolSell takes them)
//   and the quote is the sale's own (pool-sell.ts poolSellReference: the reference for exactly this sell on both of the
//   page's paced RPCs and the venue that gives the most), so the preview is the quote the sale signs on, on the same
//   reads. No quote math here.
// - What the page already holds first: the holding is the positions pass's (src/positions.ts: the last whole pass, the
//   amount over every W that holds the token) and the token's decimals the pass's or the page's kept ones
//   (PAGE_TOKEN_DECIMALS), read on the providers only when neither has them. The only provider reads of a preview are
//   then the reference's: one getMultipleAccounts per venue per provider (two each), read again once for a venue the two
//   did not agree on (readSolanaReference).
// - Never while a trade's own reads hold the providers (the app's devnet run of 11 Nov 02:51Z: a sell refused after 64
//   answers of HTTP 429): it waits while a sell, a rent back or a load's settle holds the sell lock (POOL_SELL_LOCK,
//   read with LockManager.query, never taken, so no trade ever waits for a preview) or the page counts a trade running
//   (busy), then answers busy past POOL_SELL_DRY_WAIT_MS. A provider that fails is not asked again: down. Both are "not
//   now" (api.ts RETRY_CODES): the app's next ask runs again.
// - Solana only here. Base and Robinhood answer not_allowed until the page sells there (card signpage-evm-pool-sell),
//   whose handler answers the same shape: amounts in whole units of the pool's asset, the platform fee in basis points.
// - The answer: `out`, the best venue's expected out for the units (the venue's fees taken, before slippage); `network`,
//   the sale's one signature fee (SOLANA_POOL_SELL_FEE: no compute budget instruction, so no priority fee); `fee_bps` 0:
//   a Solana pool sale is the venue's sell and the deposit back, nothing else (rules/pool.ts checkSolanaSell).
import { SOLANA_POOL_SELL_FEE } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { ErrorCode, PoolSellDry } from "../../kit/src/signpage/messages.ts";
import type { Running } from "./api.ts";
import { keptTokenDecimals, type PoolRpc, type TokenDecimalsKept } from "./pool-kinds.ts";
import { POOL_SELL_LOCK, poolSellReference, poolSellUnits } from "./pool-sell.ts";
import type { Position } from "./positions.ts";
import { checkPoolRequest, POOL_ASSET_DECIMALS_OF, poolTokenAddress, poolUnits, type PoolAsk, type PoolChain } from "./rules/pool.ts";

/** The longest a preview waits for a trade's reads to end before it answers busy. */
export const POOL_SELL_DRY_WAIT_MS = 8_000;
/** How often it looks again while it waits. */
export const POOL_SELL_DRY_LOOK_MS = 250;

export type PoolSellDryDeps = {
  /** Whether this page's network pins the chain's pool. */
  pinned(chain: PoolChain): boolean;
  /** The page's paced Solana pair, the trades' own (pool-testnet.ts pageSolanaRpcs); null with none. */
  rpcs(): readonly [SolanaRpc, SolanaRpc] | null;
  /** The positions pass's last whole read (null: none yet, or signed out). */
  positions(): Promise<readonly Position[] | null>;
  /** The page's kept decimals (PAGE_TOKEN_DECIMALS). */
  decimals?: TokenDecimalsKept;
  /** True while the page runs a trade (a buy or a sell between its tap and its end). */
  busy?(): boolean;
  /** The lock manager whose held locks are read (never taken). */
  locks?: Pick<LockManager, "query"> | null;
  wait?(ms: number): Promise<void>;
  waitMs?: number;
};

type DryAnswer = { result: PoolSellDry } | { error: ErrorCode };

/** A plain decimal in whole units to base units at `decimals`; null when it is not one or has more digits. */
function baseUnits(s: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
}

/** Whether a trade's reads hold the page's providers now: the page's own count, or the sell lock held in any tab. */
async function held(d: PoolSellDryDeps): Promise<boolean> {
  if (d.busy?.()) return true;
  const locks = d.locks === undefined ? (globalThis.navigator?.locks ?? null) : d.locks;
  if (!locks) return false;
  const q = await locks.query();
  return [...(q.held ?? []), ...(q.pending ?? [])].some((l) => l.name === POOL_SELL_LOCK);
}

/** pool.sell.dry's answer for `params` (the kit's schema passed them: pool.sell's own). */
export async function poolSellDry(d: PoolSellDryDeps, params: Record<string, unknown>): Promise<DryAnswer> {
  const chain = params.chain;
  if (chain !== "solana" || !d.pinned("solana")) return { error: "not_allowed" };
  const rpcs = d.rpcs();
  const token = params.token;
  if (rpcs === null || !poolTokenAddress("solana", token)) return { error: "not_allowed" };
  // the holding the positions pass read: over every W that holds the token
  const pos = (await d.positions())?.find((p) => p.chain === "solana" && p.token === token);
  if (!pos) return { error: "not_funded" };
  let decimals = pos.decimals ?? d.decimals?.get("solana", token);
  try {
    // neither the pass nor the page has them: one read on both providers, kept (pool-kinds.ts keptTokenDecimals), no wait
    decimals ??= await keptTokenDecimals("solana", token, rpcs as unknown as readonly [PoolRpc, PoolRpc], { ...(d.decimals ? { kept: d.decimals } : {}), waits: 0 });
  } catch (e) {
    return { error: e instanceof SolanaRpcTransportError ? "down" : "not_allowed" };
  }
  let ask: PoolAsk;
  try {
    ask = checkPoolRequest({ ...(params as object), kind: "pool.sell", chain: "solana" }, decimals);
  } catch {
    return { error: "not_allowed" };
  }
  const total = baseUnits(pos.amount, decimals);
  if (total === null) return { error: "not_allowed" };
  const units = poolSellUnits(total, ask);
  if (units <= 0n || units > total) return { error: "not_funded" };
  // a trade's reads first: looked at again until they end, never taken
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bound = d.waitMs ?? POOL_SELL_DRY_WAIT_MS;
  for (let waited = 0; await held(d); waited += POOL_SELL_DRY_LOOK_MS) {
    if (waited >= bound) return { error: "busy" };
    await wait(POOL_SELL_DRY_LOOK_MS);
  }
  let quoted: Awaited<ReturnType<typeof poolSellReference>>;
  try {
    quoted = await poolSellReference(rpcs, token, units);
  } catch (e) {
    return { error: e instanceof SolanaRpcTransportError ? "down" : "quote_check_failed" };
  }
  if (!quoted) return { error: "quote_check_failed" };
  const sol = POOL_ASSET_DECIMALS_OF.solana;
  return { result: { out: poolUnits(quoted.best.expectedOut, sol), network: poolUnits(SOLANA_POOL_SELL_FEE, sol), fee_bps: 0 } };
}

/** The kind for ApiHost.kinds: answered as a read that runs (Running), so `state`, nav and an open kind never wait for
 *  its reads; anything it throws is "down". */
export function poolSellDryKind(d: PoolSellDryDeps): (params: Record<string, unknown>) => Running<"pool.sell.dry"> {
  return (params) => {
    let out: DryAnswer = { error: "down" };
    const after = poolSellDry(d, params).then(
      (a) => void (out = a),
      () => void (out = { error: "down" }),
    );
    return { after, answer: () => out, running: true };
  };
}
