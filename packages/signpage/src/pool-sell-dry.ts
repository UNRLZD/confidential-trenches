// pool.sell.dry on SIGN_HOST (card app-sell-shows-what-you-receive): what a pool.sell of the same params would give,
// for the sell box's You receive, Network and Fee before the tap. Display only: nothing is built, signed, written or
// sent, and no pool.sell ever takes these numbers (each sale reads and checks its own quote before W signs).
//
// - One code path with the sale: the units are pool.sell's own (pool-sell.ts poolSellUnits, as planPoolSell takes them)
//   and the quote is the sale's own (pool-sell.ts poolSellReference: the reference for exactly this sell on both of the
//   page's paced RPCs and the venue that gives the most), so the preview is the quote the sale signs on, on the same
//   reads. No quote math here.
// - What the page already holds first: the holding is the positions pass's last read (src/positions.ts get(): the amount
//   over every W that holds the token, and the Ws; it starts nothing, reads no seed and writes nothing), the token's
//   decimals the pass's or the page's kept ones (PAGE_TOKEN_DECIMALS) and the Rent sysvar the page's (main.ts
//   rentOnce), each read on the providers only when the page has none. A preview's provider reads are then three
//   getMultipleAccounts per provider, side by side: the reference's two (one per venue; a venue the two did not agree on
//   is read again once, readSolanaReference) and the Ws' lamports.
// - The trades' providers first. Every read is a background one on its host's lane ("pass", src/page-rpc.ts: it waits
//   while a trade holds the host, and a trade never waits for it), and before each read the preview looks itself: it
//   goes only while no trade runs on the page (a pool buy or sell from its tap to its run's end, main.ts liveRuns) and
//   no trade holds either host (the lanes), within POOL_SELL_DRY_CALLS calls per host in any POOL_SELL_DRY_WINDOW_MS
//   (the helper gives one caller 16 in 10 s, apps/helper/src/rpc/rpc.ts), and only while the ask is the page's newest:
//   one preview runs at a time, a newer ask stops an older one before its next read (busy), and an ask for what the
//   running one reads (the same token, holding, share and slippage) gets its answer. No read starts past
//   POOL_SELL_DRY_START_MS after the ask, so the answer comes inside the kit client's 10 s; past it, busy. A sign out
//   ends the wait: no holding, not_funded. A provider that fails is not asked again: down. busy and down are "not now"
//   (api.ts RETRY_CODES): the app's next ask runs again.
// - The reads do not depend on the share: a preview's provider answers are kept POOL_SELL_DRY_KEEP_MS (2 s) for the
//   same holding, so the next preview of another share inside it reads nothing and costs no budget (keptAnswers). Kept
//   for previews only: pool.sell reads its own reference.
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
import { SolanaRpcTransportError, solanaWrappedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { TRADE_HOLD_MAX_MS } from "../../wallet/src/throttle.ts";
import type { ErrorCode, PoolSellDry } from "../../kit/src/signpage/messages.ts";
import type { KindContext, Running } from "./api.ts";
import { keptTokenDecimals, type PoolRpc, type TokenDecimalsKept } from "./pool-kinds.ts";
import { poolSellReference, poolSellUnits } from "./pool-sell.ts";
import type { Position } from "./positions.ts";
import { checkPoolRequest, POOL_ASSET_DECIMALS_OF, poolTokenAddress, poolUnits, solanaDepositRents, solanaSellAfterFull, type PoolAsk, type PoolChain } from "./rules/pool.ts";

/** A pool buy's final stages (posted once as progress, after its read-backs): until one, the buy's reads are live. */
export const POOL_BUY_ENDS: ReadonlySet<string> = new Set(["filled", "part_filled", "refused", "not_landed"]);
/** The longest a trade counts as running with no end seen: the lanes' own hold (throttle.ts TRADE_HOLD_MAX_MS). */
export const TRADE_LIVE_MAX_MS = TRADE_HOLD_MAX_MS;

/** The most calls previews make to one host in any POOL_SELL_DRY_WINDOW_MS: two cold previews' three each, a third of
 *  the helper's 16 per caller in 10 s, so a trade tapped after a burst of previews still has 10 of its own. */
export const POOL_SELL_DRY_CALLS = 6;
export const POOL_SELL_DRY_WINDOW_MS = 10_000;
/** No read of a preview starts later than this after its ask: a read's bound (SOLANA_RPC_RETRY, 3.5 s) and a margin
 *  under the kit client's 10 s for the kind (SIGNPAGE_TIMEOUT_MS), so it never reads for an ask the app gave up on. */
export const POOL_SELL_DRY_START_MS = 6_000;
/** How often a waiting preview looks again. */
export const POOL_SELL_DRY_LOOK_MS = 250;
/** How long a preview's provider answers are kept for the next preview of the same holding (each answer as both
 *  providers gave it, for the same call): the reads do not depend on the share, so a user tapping 25%, 50%, 75% and
 *  100% in a row costs one read, not four; 2 s, a few Solana slots, so a price is never older than a quote the sale
 *  itself would take (it reads its own, never these). */
export const POOL_SELL_DRY_KEEP_MS = 2_000;

export type PoolSellDryDeps = {
  /** Whether this page's network pins the chain's pool. */
  pinned(chain: PoolChain): boolean;
  /** The page's paced Solana pair as background reads (pool-testnet.ts pageSolanaRpcs("pass")); null with none. */
  rpcs(): readonly [SolanaRpc, SolanaRpc] | null;
  /** The positions pass's last read, as held (positions.ts get(): null before one, or signed out); never a read. */
  positions(): readonly Position[] | null;
  /** The Rent sysvar the page already read (main.ts rentOnce, state.pools' tap_max); null: read here on both. */
  rent?(): SolanaRent | null;
  /** The page's kept decimals (PAGE_TOKEN_DECIMALS). */
  decimals?: TokenDecimalsKept;
  /** True while a trade runs on the page or holds a host of the pair (main.ts: liveRuns and the lanes). */
  trading(): boolean;
  now?(): number;
  wait?(ms: number): Promise<void>;
};

/** One preview's turn: whether it is still the page's newest ask, the page's calls per host, and the page's kept answers
 *  (keep: `read` unless the same call on the same provider for the same holding answered within POOL_SELL_DRY_KEEP_MS;
 *  drop: forget them, a sign out). */
type Turn = { newest(): boolean; calls: [number[], number[]]; keep(scope: string, key: string, read: () => Promise<unknown>): Promise<unknown>; drop(): void };

/** The page's kept preview answers, one holding at a time (a new scope forgets the last). Only a preview's own wrapped
 *  pair reads them: pool.sell never does. */
function keptAnswers(now: () => number): Pick<Turn, "keep" | "drop"> {
  let scope = "";
  const kept = new Map<string, { at: number; p: Promise<unknown> }>();
  const keep = (sc: string, key: string, read: () => Promise<unknown>): Promise<unknown> => {
    if (sc !== scope) {
      kept.clear();
      scope = sc;
    }
    const e = kept.get(key);
    if (e && now() - e.at < POOL_SELL_DRY_KEEP_MS) return e.p.catch((err: unknown) => (err instanceof Stop ? keep(sc, key, read) : Promise.reject(err)));
    const p = read();
    const entry = { at: now(), p };
    kept.set(key, entry);
    p.catch(() => void (kept.get(key) === entry && kept.delete(key)));
    return p;
  };
  return { keep, drop: () => (kept.clear(), void (scope = "")) };
}

type DryAnswer = { result: PoolSellDry } | { error: ErrorCode };

/** A plain decimal in whole units to base units at `decimals`; null when it is not one or has more digits. */
function baseUnits(s: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
}

/** A preview's stop before a read: busy (a trade, the budget, a newer ask or the clock) or not_funded (a sign out). */
class Stop extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
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
 * both are to be made, and on a full sale W's keep with both volume accounts owed (solanaSellAfterFull at 2). The
 * coin's cashback flag (`cashback`, the reference's, the venue's own byte) prices what the sale makes and what W keeps
 * as the sale's rule does; unknown, the most of both. A
 * partial sale's reserve is never under 0; a full one's may be (W's surplus goes into the note too). With more than one
 * W the plan's legs are not known here: each W's bound, at 0 at least, is summed.
 */
export function poolSellReserveBound(rent: SolanaRent, venue: "pump-curve" | "pumpswap", lamports: readonly bigint[], full: boolean, cashback?: boolean): bigint {
  const cb = cashback ?? true;
  const made = solanaPoolSellNeed({ kind: venue, cashback: cb }, rent) - solanaPoolSellNeed({ kind: venue, cashback: cb }, rent, { ammVolume: true, ammVolumeAta: true });
  const none = [null, null] as const;
  const rents = solanaDepositRents(rent, { stateSize: 0, labelSize: 0 }, { mark: none, state: none, label: none }, true);
  const keepPart = (cashback === undefined ? [false, true] : [cashback]).map((c) => solanaPoolBuySellNeed({ kind: venue, cashback: c }, rent)).reduce((x, y) => (x > y ? x : y));
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

const holding = (d: PoolSellDryDeps, token: unknown): Position | undefined => d.positions()?.find((p) => p.chain === "solana" && p.token === token);

/** pool.sell.dry's answer for `params` (the kit's schema passed them: pool.sell's own). `turn`: the page's (the kind's). */
export async function poolSellDry(d: PoolSellDryDeps, params: Record<string, unknown>, turn: Turn = { newest: () => true, calls: [[], []], ...keptAnswers(d.now ?? (() => performance.now())) }): Promise<DryAnswer> {
  const chain = params.chain;
  if (chain !== "solana" || !d.pinned("solana")) return { error: "not_allowed" };
  const bare = d.rpcs();
  const token = params.token;
  if (bare === null || !poolTokenAddress("solana", token)) return { error: "not_allowed" };
  // the holding the positions pass read: over every W that holds the token
  const pos = holding(d, token);
  if (!pos) {
    // signed out (or sold out): nothing kept outlives the holding
    if (d.positions() === null) turn.drop();
    return { error: "not_funded" };
  }
  const now = d.now ?? (() => performance.now());
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const last = now() + POOL_SELL_DRY_START_MS;
  let stop: Stop | null = null;
  // each read goes once this preview may read on its host (the header), else it stops the preview
  const gate = async (i: 0 | 1): Promise<void> => {
    // asks posted in one turn: only the newest reads
    await null;
    for (;;) {
      if (stop) throw stop;
      if (!turn.newest() || now() >= last) throw (stop = new Stop("busy"));
      if (holding(d, token) === undefined) {
        turn.drop();
        throw (stop = new Stop("not_funded"));
      }
      const t = now();
      const calls = turn.calls[i];
      while (calls.length > 0 && calls[0]! <= t - POOL_SELL_DRY_WINDOW_MS) calls.shift();
      // the host's budget frees only past the last start: no wait for it
      if (calls.length >= POOL_SELL_DRY_CALLS && calls[0]! + POOL_SELL_DRY_WINDOW_MS >= last) throw (stop = new Stop("busy"));
      if (!d.trading() && calls.length < POOL_SELL_DRY_CALLS) {
        calls.push(t);
        return;
      }
      await wait(POOL_SELL_DRY_LOOK_MS);
    }
  };
  // each call answered from the kept answers of this holding when they are young enough (no read, no budget), else read
  // once its gate lets it
  const scope = JSON.stringify([token, pos.amount, pos.wallets]);
  const rpcs = bare.map((rpc, i) => solanaWrappedRpc(rpc, (m, p) => turn.keep(scope, JSON.stringify([i, m, p]), () => gate(i as 0 | 1).then(() => rpc(m, p))))) as unknown as readonly [SolanaRpc, SolanaRpc];
  const fault = (e: unknown, other: ErrorCode): DryAnswer => ({ error: stop ? stop.code : e instanceof SolanaRpcTransportError ? "down" : other });
  let decimals = pos.decimals ?? d.decimals?.get("solana", token);
  try {
    // neither the pass nor the page has them: one read on both providers, kept (pool-kinds.ts keptTokenDecimals), no wait
    decimals ??= await keptTokenDecimals("solana", token, rpcs as unknown as readonly [PoolRpc, PoolRpc], { ...(d.decimals ? { kept: d.decimals } : {}), waits: 0 });
  } catch (e) {
    return fault(e, "not_allowed");
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
  const ws = pos.wallets;
  if (ws.length === 0) return { error: "not_funded" };
  // the sale's quote, and W's lamports with the Rent sysvar, side by side
  let quoted: Awaited<ReturnType<typeof poolSellReference>>;
  let lamports: bigint[];
  let rent: SolanaRent;
  try {
    [quoted, [rent, lamports]] = await Promise.all([poolSellReference(rpcs, token, units), Promise.all([d.rent?.() ?? readSolanaRent(rpcs), lamportsOf(rpcs, ws)])]);
  } catch (e) {
    return fault(e, "quote_check_failed");
  }
  if (stop) return { error: (stop as Stop).code };
  if (!quoted) return { error: "quote_check_failed" };
  const venue = quoted.best.venue;
  if (venue !== "pump-curve" && venue !== "pumpswap") return { error: "quote_check_failed" };
  // a sign out while it read: the old holding is not answered
  if (holding(d, token) === undefined) {
    turn.drop();
    return { error: "not_funded" };
  }
  // what the sale keeps out of the user's money (poolSellReserveBound), the coin's cashback flag where the reference read it
  const reserve = poolSellReserveBound(rent, venue, lamports, ws.length === 1 && units === total, quoted.best.cashback);
  const sol = POOL_ASSET_DECIMALS_OF.solana;
  const e = quoted.best.expectedOut;
  const net = (x: bigint): bigint => (x - reserve > 0n ? x - reserve : 0n);
  return { result: { out: poolUnits(net(e), sol), min_out: poolUnits(net(solanaSellFloor(e, ask.slippageBps)), sol), network: poolUnits(SOLANA_POOL_SELL_FEE, sol), fee_bps: 0 } };
}

/** The kind for ApiHost.kinds: answered as a read that runs (Running), so `state`, nav and an open kind never wait for
 *  its reads; anything it throws is "down". One preview at a time per page (the header): an ask for what the running
 *  one reads shares its answer, any other makes it the newest. */
export function poolSellDryKind(d: PoolSellDryDeps): (params: Record<string, unknown>) => Running<"pool.sell.dry"> {
  const calls: [number[], number[]] = [[], []];
  const kept = keptAnswers(d.now ?? (() => performance.now()));
  let newest = 0;
  let running: { key: string; after: Promise<DryAnswer> } | null = null;
  return (params) => {
    let held: string | null = null;
    try {
      held = holding(d, params.token)?.amount ?? null;
    } catch {
      // the run below answers it: down
    }
    const key = JSON.stringify([params.chain, params.token, held, params.share_bps ?? null, params.amount ?? null, params.slippage_bps ?? null]);
    let after: Promise<DryAnswer>;
    if (running?.key === key) after = running.after;
    else {
      const me = ++newest;
      after = poolSellDry(d, params, { newest: () => newest === me, calls, ...kept }).catch((): DryAnswer => ({ error: "down" }));
      const run = (running = { key, after });
      void after.then(() => void (running === run && (running = null)));
    }
    let out: DryAnswer = { error: "down" };
    return { after: after.then((a) => void (out = a)), answer: () => out, running: true };
  };
}

/** A trade kind with a count of its runs (trading above): each from its tap to its run's end, or its refusal, at most
 *  `maxMs`. A pool buy's end is its final stage (posted once as progress after its read-backs, pool-buy.ts
 *  poolBuyKind; its first answer can be "sent" while they go on); a pool sell's is its run's `after` (its verdict and
 *  its rent backs, pool-sell.ts poolSellKind). The kind's answers and progress pass through unchanged. */
export function liveRuns<A>(kind: (params: Record<string, unknown>, ctx: KindContext) => A, end: "final" | "after", maxMs = TRADE_LIVE_MAX_MS): { kind: (params: Record<string, unknown>, ctx: KindContext) => A; live(): number } {
  let n = 0;
  return {
    live: () => n,
    kind: (params, ctx) => {
      let on = true;
      n++;
      const done = (): void => {
        if (!on) return;
        on = false;
        n--;
        clearTimeout(backstop);
      };
      const backstop = setTimeout(done, maxMs);
      const r = kind(params, end === "final" ? { ...ctx, progress: (stage) => (ctx.progress(stage), POOL_BUY_ENDS.has(stage) && done()) } : ctx) as unknown;
      const run = r as { after?: Promise<unknown>; answer?: () => unknown } | null;
      if (run === null || typeof run !== "object" || !(run.after instanceof Promise) || typeof run.answer !== "function") done();
      else void run.after.then(() => (end === "after" || (run.answer!() as { error?: unknown } | null)?.error !== undefined) && done(), done);
      return r as A;
    },
  };
}
