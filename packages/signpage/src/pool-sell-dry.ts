// pool.sell.dry on SIGN_HOST (card app-sell-shows-what-you-receive): what a pool.sell of the same params would give,
// for the sell box's You receive, Network and Fee before the tap. Display only: nothing is built, signed, written or
// sent, and no pool.sell ever takes these numbers (each sale reads and checks its own quote before W signs).
//
// - One code path with the sale: the units are pool.sell's own (pool-sell.ts poolSellUnits, as planPoolSell takes them)
//   and the quote is the sale's own (pool-sell.ts poolSellReference: the reference for exactly this sell on both of the
//   page's paced RPCs and the venue that gives the most), so the preview is the quote the sale signs on, on the same
//   reads. No quote math here.
// - What the page already holds first: the holding is the positions pass's (src/positions.ts: the last whole pass, the
//   amount over every W that holds the token, and the Ws), the token's decimals the pass's or the page's kept ones
//   (PAGE_TOKEN_DECIMALS) and the Rent sysvar the page's (main.ts rentOnce), each read on the providers only when the
//   page has none. A preview's provider reads are then three getMultipleAccounts per provider: the reference's two (one
//   per venue; a venue the two did not agree on is read again once, readSolanaReference) and the Ws' lamports.
// - Never while a trade's own reads hold the providers (the app's devnet run of 11 Nov 02:51Z: a sell refused after 64
//   answers of HTTP 429): it waits while a sell, a rent back or a load's settle holds the sell lock (POOL_SELL_LOCK,
//   read with LockManager.query, never taken, so no trade ever waits for a preview) or the page counts a trade running
//   (busy), then answers busy past POOL_SELL_DRY_WAIT_MS. A provider that fails is not asked again: down. Both are "not
//   now" (api.ts RETRY_CODES): the app's next ask runs again.
// - Solana only here. Base and Robinhood answer not_allowed until the page sells there (card signpage-evm-pool-sell),
//   whose handler answers the same shape: amounts in whole units of the pool's asset, the platform fee in basis points.
// - The answer: `out`, the best venue's expected out for the units (the venue's fees taken, before slippage) less the
//   most the sale's reserve can be (poolSellReserveBound: the fee, the deposit's rents, what the sale makes and what W
//   keeps, less W's lamports), so at the quote's own price it is never above what the sale pays into the user's money;
//   `min_out`, the same at the user's slippage floor (the floor the sale signs, solanaSellFloor); `network`, the sale's
//   one signature fee (SOLANA_POOL_SELL_FEE: no compute budget instruction, so no priority fee), inside the reserve
//   already; `fee_bps` 0: a Solana pool sale is the venue's sell and the deposit back, nothing else (rules/pool.ts
//   checkSolanaSell).
import { readSolanaRent, SOLANA_POOL_SELL_FEE, solanaPoolBuySellNeed, solanaPoolSellNeed, solanaSellFloor, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { ErrorCode, PoolSellDry } from "../../kit/src/signpage/messages.ts";
import type { KindContext, Running } from "./api.ts";
import { keptTokenDecimals, type PoolRpc, type TokenDecimalsKept } from "./pool-kinds.ts";
import { POOL_SELL_LOCK, poolSellReference, poolSellUnits } from "./pool-sell.ts";
import type { Position } from "./positions.ts";
import { checkPoolRequest, POOL_ASSET_DECIMALS_OF, poolTokenAddress, poolUnits, solanaDepositRents, solanaSellAfterFull, type PoolAsk, type PoolChain } from "./rules/pool.ts";

/** A pool buy's final stages (posted once as progress, after its read-backs): until one, the buy's reads are live. */
export const POOL_BUY_ENDS: ReadonlySet<string> = new Set(["filled", "part_filled", "refused", "not_landed"]);
/** The longest a pool buy counts as live with no final stage: the sell's own verdict budget (POOL_SELL_READS x
 *  POOL_SELL_WAIT_MS, 120 s). */
export const POOL_BUY_LIVE_MAX_MS = 120_000;

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
  /** The Rent sysvar the page already read (main.ts rentOnce, state.pools' tap_max); null: read here on both. */
  rent?(): SolanaRent | null;
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

/** Each W's lamports, the lower of the two RPCs' reads, in one getMultipleAccounts per RPC (as sellRun takes W's: the
 *  lower of the two); no account: 0. Strictly parsed: anything else throws. */
async function lamportsOf(rpcs: readonly [SolanaRpc, SolanaRpc], ws: readonly string[]): Promise<bigint[]> {
  const read = async (rpc: SolanaRpc): Promise<bigint[]> => {
    const r = (await rpc("getMultipleAccounts", [ws, { encoding: "base64", commitment: "confirmed" }])) as { value?: unknown };
    if (!Array.isArray(r?.value) || r.value.length !== ws.length) throw new Error("not an answer for these accounts");
    return r.value.map((a: unknown) => {
      if (a === null) return 0n;
      const l = (a as { lamports?: unknown })?.lamports;
      if (!Number.isSafeInteger(l) || (l as number) < 0) throw new Error("lamports not a whole number");
      return BigInt(l as number);
    });
  };
  const [a, b] = await Promise.all([read(rpcs[0]), read(rpcs[1])]);
  return a.map((x, i) => (x < b[i]! ? x : b[i]!));
}

/**
 * The most a sale's reserve can be (pool-sell.ts solanaSellReserve: the fee, what the sale makes at W's cost, the
 * deposit's rents and what W keeps after, less what W holds), so You receive is never above what the sale pays into
 * the user's money. Exact from what the page holds or reads cheaply: the fee (one signature, no compute budget: the
 * sale's own, SOLANA_POOL_SELL_FEE), W's lamports (read), the Rent sysvar. Bounded where the exact figure needs reads a
 * preview does not make: the deposit's rents at both pages' opening (solanaDepositRents with nothing held at size 0:
 * a page that is there takes one entry's growth, never more than its opening), the venue's cashback accounts as if
 * both are to be made, and on a full sale W's keep with both volume accounts owed (solanaSellAfterFull at 2). A
 * partial sale's reserve is never under 0; a full one's may be (W's surplus goes into the note too). With more than one
 * W the plan's legs are not known here: each W's bound, at 0 at least, is summed.
 */
export function poolSellReserveBound(rent: SolanaRent, venue: "pump-curve" | "pumpswap", lamports: readonly bigint[], full: boolean): bigint {
  const made = solanaPoolSellNeed({ kind: venue, cashback: true }, rent) - solanaPoolSellNeed({ kind: venue, cashback: true }, rent, { ammVolume: true, ammVolumeAta: true });
  const none = [null, null] as const;
  const rents = solanaDepositRents(rent, { stateSize: 0, labelSize: 0 }, { mark: none, state: none, label: none }, true);
  const keepPart = [solanaPoolBuySellNeed({ kind: venue, cashback: false }, rent), solanaPoolBuySellNeed({ kind: venue, cashback: true }, rent)].reduce((x, y) => (x > y ? x : y));
  const keepFull = solanaSellAfterFull(rent, 2);
  const one = (l: bigint, after: bigint) => SOLANA_POOL_SELL_FEE + made + rents + after - l;
  if (lamports.length === 1) {
    const r = one(lamports[0]!, full ? keepFull : keepPart);
    return full || r > 0n ? r : 0n;
  }
  const after = keepFull > keepPart ? keepFull : keepPart;
  return lamports.reduce((t, l) => {
    const r = one(l, after);
    return t + (r > 0n ? r : 0n);
  }, 0n);
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
  const venue = quoted.best.venue;
  if (venue !== "pump-curve" && venue !== "pumpswap") return { error: "quote_check_failed" };
  // what the sale keeps out of the user's money: W's lamports (one read per RPC) and the page's Rent sysvar
  let reserve: bigint;
  try {
    const rent = d.rent?.() ?? (await readSolanaRent(rpcs));
    const ws = pos.wallets.length > 0 ? pos.wallets : null;
    if (ws === null) return { error: "not_funded" };
    reserve = poolSellReserveBound(rent, venue, await lamportsOf(rpcs, ws), ws.length === 1 && units === total);
  } catch (e) {
    return { error: e instanceof SolanaRpcTransportError ? "down" : "quote_check_failed" };
  }
  const sol = POOL_ASSET_DECIMALS_OF.solana;
  const e = quoted.best.expectedOut;
  const net = (x: bigint): bigint => (x - reserve > 0n ? x - reserve : 0n);
  return { result: { out: poolUnits(net(e), sol), min_out: poolUnits(net(solanaSellFloor(e, ask.slippageBps)), sol), network: poolUnits(SOLANA_POOL_SELL_FEE, sol), fee_bps: 0 } };
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

/** The pool.buy kind with a count of its live runs (busy above): each from its tap to its run's final stage (posted once
 *  as progress after its read-backs, pool-buy.ts poolBuyKind) or its refusal, at most POOL_BUY_LIVE_MAX_MS (a run that
 *  ends at "sent" posts no end). The kind's answers and progress pass through unchanged. */
export function liveBuys<A>(kind: (params: Record<string, unknown>, ctx: KindContext) => A, maxMs = POOL_BUY_LIVE_MAX_MS): { kind: (params: Record<string, unknown>, ctx: KindContext) => A; live(): number } {
  let n = 0;
  return {
    live: () => n,
    kind: (params, ctx) => {
      let on = true;
      n++;
      const end = (): void => {
        if (!on) return;
        on = false;
        n--;
        clearTimeout(backstop);
      };
      const backstop = setTimeout(end, maxMs);
      const r = kind(params, { ...ctx, progress: (stage) => (ctx.progress(stage), POOL_BUY_ENDS.has(stage) && end()) }) as unknown;
      const run = r as { after?: Promise<unknown>; answer?: () => unknown } | null;
      if (run === null || typeof run !== "object" || !(run.after instanceof Promise) || typeof run.answer !== "function") end();
      else void run.after.then(() => (run.answer!() as { error?: unknown } | null)?.error !== undefined && end(), end);
      return r as A;
    },
  };
}
