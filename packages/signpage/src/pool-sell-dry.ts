// pool.sell.dry on SIGN_HOST (card app-sell-shows-what-you-receive): what a pool.sell of the same params would give,
// for the sell box's You receive, Network and Fee before the tap. Display only: nothing is built, signed, written or
// sent, and no pool.sell ever takes these numbers (each sale reads and checks its own quote before W signs).
//
// - One code path with the sale: the units are pool.sell's own (pool-sell.ts poolSellUnits, as planPoolSell takes them)
//   and the quote is the sale's own (pool-sell.ts poolSellReference: the reference for exactly this sell on both of the
//   page's paced RPCs and the venue that gives the most), so the preview is the quote the sale signs on, on the same
//   reads. No quote math here.
// - What the page already holds first: the holding is the positions pass's last read (src/positions.ts get(): the amount
//   over every W that holds the token, and the Ws; it starts nothing, reads no seed and writes nothing), and each W
//   bought since the last whole pass as the sale's plan takes it (pool-sell.ts planReads: W's buy mint names the token;
//   boughtSincePass, from the page's store), read by W's own read (pool-sell.ts wHeldNow: the sale's wHeld, one W per
//   call, on both providers, the token account's amount the same on both), so a preview right after a buy's Filled
//   answers for it before the finder lists it, and a W the sale would find empty adds nothing (card
//   app-sell-shows-what-you-receive: devnet run 116 answered not_funded 7.6 s after a Filled while the pass's finder
//   read waited on its lane, and a sale then planned W). The token's
//   decimals the pass's or the page's kept ones (PAGE_TOKEN_DECIMALS) and the Rent sysvar the page's (main.ts
//   rentOnce), each read on the providers only when the page has none. A cold preview's provider reads are then three
//   getMultipleAccounts per provider, side by side: the reference's two (one per venue; a venue the two did not agree on
//   is read again once, readSolanaReference) and the Ws' (walletReads: lamports, volume accounts, the pool's sizes).
// - Decided before any read: a provider's shared queue books a call's turn when it is asked (send.ts rpcSlot), so a
//   preview decides whether it goes before it asks anything, and one that does not go books nothing. It goes only as
//   the page's newest ask (one preview at a time; asks posted in one turn: the last; an ask for what the running one
//   reads gets its answer), while no trade runs on the page (a pool buy from its tap to its early "sent", a sell from
//   its tap to its run's end, main.ts liveRuns) and no trade holds either host (the lanes), and with POOL_SELL_DRY_READ_CALLS left of
//   POOL_SELL_DRY_CALLS per host in any POOL_SELL_DRY_WINDOW_MS (the helper gives one caller 16 in 10 s,
//   apps/helper/src/rpc/rpc.ts); else busy at once, never a wait. Its reads are background ones on its host's lane
//   ("pass", src/page-rpc.ts: they wait while a trade holds the host, and a trade never waits for them), answered
//   within POOL_SELL_DRY_ANSWER_MS, else busy. A sign out: not_funded. A provider that fails is not asked again: down.
//   busy and down are "not now" (api.ts RETRY_CODES): the app's next ask runs again.
// - The reads do not depend on the share: a cold preview's answers are kept POOL_SELL_DRY_KEEP_MS (2 s) for the same
//   holding, and a preview inside it runs on them as two plain answer lists outside the providers' queues: no call, no
//   budget, no wait on a trade (keptReads). Kept for previews only: pool.sell reads its own reference. A sign out drops
//   them.
// - Solana only here. Base and Robinhood answer not_allowed until the page sells there (card signpage-evm-pool-sell),
//   whose handler answers the same shape: amounts in whole units of the pool's asset, the platform fee in basis points.
// - The answer (poolSellPays): `out`, what a sale at the best venue's expected out (its fees taken, before slippage)
//   pays into the user's notes as the sale's own rule prices it (solanaSellReserve), on a full sale with the sweep's
//   note after it; `min_out`, the same at the user's slippage floor (the floor the sale signs, solanaSellFloor);
//   `network`, the sale's one signature fee (SOLANA_POOL_SELL_FEE: no compute budget instruction, so no priority fee),
//   inside both already; `fee_bps` 0: a Solana pool sale is the venue's sell and the deposit back, nothing else
//   (rules/pool.ts checkSolanaSell).
import { SOLANA_LAMPORTS_PER_SIGNATURE, SOLANA_PUMP_AMM_PROGRAM, SOLANA_PUMP_PROGRAM, solanaVolumeAccumulator, solanaVolumeClaimable } from "../../kit/src/checks/solana/checks.ts";
import type { ErrorCode, PoolSellDry } from "../../kit/src/signpage/messages.ts";
import { solanaParseAccountsAnswer } from "../../kit/src/trade/solana/pool.ts";
import { readSolanaRent, SOLANA_POOL_PAGE_ENTRIES, SOLANA_POOL_SELL_FEE, solanaPoolBuySellNeed, solanaPoolSellNeed, solanaRentMin, solanaSellFloor, type SolanaRent } from "../../kit/src/trade/solana/pool-buy.ts";
import { SOLANA_POOL_PAGE_ENTRY, SOLANA_POOL_PAGE_HEADER, solanaPoolNoteFloor } from "../../kit/src/trade/solana/pool-deposit.ts";
import { SolanaRpcTransportError, solanaWrappedRpc, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { TRADE_HOLD_MAX_MS } from "../../wallet/src/throttle.ts";
import type { KindContext, Running } from "./api.ts";
import { keptTokenDecimals, type PoolRpc, type TokenDecimalsKept } from "./pool-kinds.ts";
import { poolSellReference, poolSellUnits, sizesOf as poolTreeSizes, solanaSellReserve, wHeldNow, type WHeld } from "./pool-sell.ts";
import { keptListed, type Position } from "./positions.ts";
import { checkPoolRequest, POOL_ASSET_DECIMALS_OF, poolTokenAddress, poolUnits, SOLANA_POOL_MIN_DEPOSIT, solanaDepositRents, solanaSellAfterFull, SOLANA_SWEEP_OWED_MAX, solanaSweepFloor, solanaSweepKeep, type PoolAsk, type PoolChain } from "./rules/pool.ts";

/** The longest a trade counts as running with no end seen: the lanes' own hold (throttle.ts TRADE_HOLD_MAX_MS). */
export const TRADE_LIVE_MAX_MS = TRADE_HOLD_MAX_MS;

/** The most calls previews make to one host in any POOL_SELL_DRY_WINDOW_MS: two cold previews' three each, a third of
 *  the helper's 16 per caller in 10 s, so a trade tapped after a burst of previews still has 10 of its own. */
export const POOL_SELL_DRY_CALLS = 6;
export const POOL_SELL_DRY_WINDOW_MS = 10_000;
/** A cold preview's calls on each host: the reference's two (one per venue) and the Ws' (walletReads). */
export const POOL_SELL_DRY_READ_CALLS = 3;
/** A preview answers within this of its ask, else busy: a read's bound (SOLANA_RPC_RETRY, 3.5 s) and a margin under the
 *  kit client's 10 s for the kind (SIGNPAGE_TIMEOUT_MS), so no answer comes for an ask the app gave up on. */
export const POOL_SELL_DRY_ANSWER_MS = 6_000;
/** How long a preview's provider answers are kept for the next preview of the same holding: the reads do not depend on
 *  the share, so a user tapping 25%, 50%, 75% and 100% in a row costs one read, not four; 2 s, a few Solana slots, so a
 *  price is never older than a quote the sale itself would take (it reads its own, never these). */
export const POOL_SELL_DRY_KEEP_MS = 2_000;

export type PoolSellDryDeps = {
  /** Whether this page's network pins the chain's pool. */
  pinned(chain: PoolChain): boolean;
  /** The page's paced Solana pair as background reads (pool-testnet.ts pageSolanaRpcs("pass")); null with none. */
  rpcs(): readonly [SolanaRpc, SolanaRpc] | null;
  /** The positions pass's last read, as held (positions.ts get(): null before one, or signed out); never a read. */
  positions(): readonly Position[] | null;
  /** The page's Solana pool (PAGE_SOL_PIN): its pool account gives the trees' sizes the deposit is priced at; none:
   *  priced at a page's opening. */
  pin?(): { readonly program: string } | null;
  /** The Rent sysvar the page already read (main.ts rentOnce, state.pools' tap_max); null: read here on both. */
  rent?(): SolanaRent | null;
  /** The page's kept decimals (PAGE_TOKEN_DECIMALS). */
  decimals?: TokenDecimalsKept;
  /** The Ws bought since the last whole pass that name `token` (boughtSincePass on the page's store); none: []. */
  bought?(token: string): Promise<readonly BoughtW[]>;
  /** True while a trade runs on the page or holds a host of the pair (main.ts: liveRuns and the lanes). */
  trading(): boolean;
  now?(): number;
};

/** A W bought since the last whole pass: its address, its token's program as its buy mint names it, and the token's
 *  decimals as W's buy record holds them. */
export type BoughtW = { address: string; program: string; decimals?: number };
/** The Ws whose buy mint (pool-sell.ts BUY_MINTS_KEY, the sale plan's `bought`) names `token` and that the kept pass
 *  (positions.ts POSITIONS_KEPT_KEY) never listed it in: bought since the last whole pass. A W the finder listed it in
 *  once is the pass's, sold or held (positions.ts: gone once it lists it no more), so it is never read here. */
export function boughtSincePass(token: string, mints: unknown, kept: unknown, costs: unknown): BoughtW[] {
  const listed = keptListed(kept);
  const out: BoughtW[] = [];
  if (typeof mints !== "object" || mints === null) return out;
  for (const [address, m] of Object.entries(mints)) {
    const b = m as { mint?: unknown; program?: unknown } | null;
    if (b?.mint !== token || typeof b.program !== "string" || listed?.get(address)?.has(token)) continue;
    const c = (costs as Record<string, { mint?: unknown; decimals?: unknown } | undefined> | null | undefined)?.[address];
    const d = c?.mint === token ? c.decimals : undefined;
    out.push({ address, program: b.program, ...(Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 255 ? { decimals: d as number } : {}) });
  }
  return out;
}

/** Each provider's answers to one preview's calls, by call (callKey). */
type Answers = readonly [Map<string, unknown>, Map<string, unknown>];
const callKey = (method: string, params: readonly unknown[]): string => JSON.stringify([method, params]);

/** The page's kept preview answers (POOL_SELL_DRY_KEEP_MS), one holding at a time: put once a cold preview answered,
 *  read only by previews (as a pair of plain answer lists, outside the providers' queues), dropped at a sign out. */
type KeptReads = { get(scope: string): Answers | null; put(scope: string, answers: Answers, at: number): void; drop(): void };
function keptReads(now: () => number): KeptReads {
  let held: { scope: string; answers: Answers; at: number } | null = null;
  return {
    get: (scope) => (held !== null && held.scope === scope && now() - held.at < POOL_SELL_DRY_KEEP_MS ? held.answers : null),
    put: (scope, answers, at) => void (held = { scope, answers, at }),
    drop: () => void (held = null),
  };
}

/** One preview's turn: whether it is still the page's newest ask, the page's calls per host, its kept answers. */
type Turn = { newest(): boolean; calls: [number[], number[]]; kept: KeptReads };

type DryAnswer = { result: PoolSellDry } | { error: ErrorCode };

/** A plain decimal in whole units to base units at `decimals`; null when it is not one or has more digits. */
function baseUnits(s: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
}

type Sizes = { stateSize: number; labelSize: number };
/** One W as the preview reads it: its lamports (the lower of the two RPCs'), and whether each pump program's volume
 *  account of W's has cashback to claim on either RPC's read (pump, PumpSwap: pool-sell.ts owesOn's rule). */
export type DryWallet = { lamports: bigint; claim?: readonly [boolean, boolean] };

/** In one getMultipleAccounts per RPC: each W's lamports and its two volume accounts, and the pool account (the trees'
 *  sizes, when both RPCs hold the same bytes; else none). Strictly parsed: anything else throws. */
async function walletReads(rpcs: readonly [SolanaRpc, SolanaRpc], ws: readonly string[], program: string | null): Promise<{ wallets: DryWallet[]; sizes: Sizes | null }> {
  const pool = program === null ? null : solanaPoolOf(program).pool;
  const keys = [...ws, ...ws.flatMap((w) => [solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM)]), ...(pool === null ? [] : [pool])];
  const read = async (rpc: SolanaRpc) => {
    const r = await rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
    const parsed = solanaParseAccountsAnswer(r, keys.length);
    const value = (r as { value?: unknown } | null)?.value;
    if (parsed === null || !Array.isArray(value)) throw new Error("not an answer for these accounts");
    const lamports = value.map((a: unknown) => {
      if (a === null) return 0n;
      const l = (a as { lamports?: unknown })?.lamports;
      if (!Number.isSafeInteger(l) || (l as number) < 0) throw new Error("lamports not a whole number");
      return BigInt(l as number);
    });
    return { lamports, accounts: parsed.accounts };
  };
  const [a, b] = await Promise.all([read(rpcs[0]), read(rpcs[1])]);
  const n = ws.length;
  const claims = (i: number, owner: string): boolean => [a, b].some((x) => x.accounts[i] != null && x.accounts[i]!.owner === owner && solanaVolumeClaimable(owner, x.accounts[i]!.data) > 0n);
  const wallets = ws.map((_, k): DryWallet => ({ lamports: a.lamports[k]! < b.lamports[k]! ? a.lamports[k]! : b.lamports[k]!, claim: [claims(n + 2 * k, SOLANA_PUMP_PROGRAM), claims(n + 2 * k + 1, SOLANA_PUMP_AMM_PROGRAM)] }));
  let sizes: Sizes | null = null;
  const [pa, pb] = [a.accounts[keys.length - 1], b.accounts[keys.length - 1]];
  if (pool !== null && pa && pb && pa.owner === program && pb.owner === program && pa.data.length === pb.data.length && pa.data.every((x, i) => x === pb.data[i])) {
    try {
      sizes = poolTreeSizes(pa.data);
    } catch {
      // not a pool account: priced at a page's opening
    }
  }
  return { wallets, sizes };
}

/**
 * What a sale of `e` at the quote's price (and of `minOut`, the floor's) pays into the user's notes, as the sale's own
 * rule prices it (pool-sell.ts solanaSellReserve), from what the page holds or reads cheaply: the fee (one signature,
 * no compute budget: SOLANA_POOL_SELL_FEE), W's lamports and its volume accounts (read), the trees' sizes (the pool
 * account, read; none: a page's opening) and the Rent sysvar.
 * - The deposit's rents: the mark's, and on each tree one entry's growth (a page there holds its rent at its length at
 *   least) or a new page's opening at a page's end or within the kit's window of it; what the sale makes: the venue's
 *   cashback accounts as if both are to be made (the coin's flag, `cashback`, unknown: the most).
 * - A full sale of one W (`full`): the sale's own reserve and its path (W's keep for the sweep, solanaSellAfterFull at
 *   W's owed claims, or rent(0) when its note would land under the sweep's floor), and on the sweep's path what the
 *   sweep then pays in: W's keep and the token account's rent back, less the teardown's and the sweep's fees, the
 *   sweep's own deposit rents (the trees one entry on) and what W keeps for its owed claims. The coin's slippage share
 *   goes in with the sweep. The costs here are the sale's at most, so where they give the rent(0) path the sale may
 *   still take the sweep's: the lower of the two; W's claims unread: the lowest over each count. A sale the rule
 *   refuses at every count: its refusal.
 * - A partial sale: the expected out less the reserve (never under 0), W's keep for its next sale held back. On a
 *   partial sale the note gets min_out now and the rest when W's last sale sweeps it (card partial-sell-pays-all-into-cash
 *   pays it all into Cash at the sale), so `out` is the expected amount, not today's first note.
 * - More than one W: the plan's legs are not known here, so each W's reserve at the larger of a partial and a full
 *   sale's keep, at 0 at least, is summed.
 */
export function poolSellPays(rent: SolanaRent, venue: "pump-curve" | "pumpswap", wallets: readonly DryWallet[], full: boolean, e: bigint, minOut: bigint, cashback?: boolean, sizes: Sizes | null = null): { out: bigint; minOut: bigint } | { refused: "not_funded" | "quote_check_failed" } {
  const cb = cashback ?? true;
  const made = solanaPoolSellNeed({ kind: venue, cashback: cb }, rent) - solanaPoolSellNeed({ kind: venue, cashback: cb }, rent, { ammVolume: true, ammVolumeAta: true });
  const none = [null, null] as const;
  // a page there holds its rent at its length at least: the insert pays one entry's growth, or a new page's opening
  const held = (size: number): readonly [bigint | null, bigint | null] => {
    const k = size % SOLANA_POOL_PAGE_ENTRIES;
    if (k === 0) return none;
    const h = solanaRentMin(rent, SOLANA_POOL_PAGE_HEADER + k * SOLANA_POOL_PAGE_ENTRY);
    return [h, h];
  };
  const rentsAt = (at: Sizes | null): bigint => (at === null ? solanaDepositRents(rent, { stateSize: 0, labelSize: 0 }, { mark: none, state: none, label: none }, true) : solanaDepositRents(rent, at, { mark: none, state: held(at.stateSize), label: held(at.labelSize) }, true));
  const rents = rentsAt(sizes);
  const venueClaim = venue === "pumpswap" ? 1 : 0;
  // W's volume accounts owed a claim after the sale (pool-sell.ts owesOn): the venue's own on a cashback coin, or one
  // with cashback to claim; unread, both
  const owed = (w: DryWallet): number => (w.claim === undefined ? SOLANA_SWEEP_OWED_MAX : w.claim.filter((c, i) => c || (cb && i === venueClaim)).length);
  const keepPart = (cashback === undefined ? [false, true] : [cashback]).map((c) => solanaPoolBuySellNeed({ kind: venue, cashback: c }, rent)).reduce((x, y) => (x > y ? x : y));
  const net = (x: bigint, r: bigint): bigint => (x - r > 0n ? x - r : 0n);
  if (wallets.length === 1 && full) {
    const w = wallets[0]!;
    const r0 = solanaRentMin(rent, 0);
    const floor = solanaSweepFloor(rent) > SOLANA_POOL_MIN_DEPOSIT ? solanaSweepFloor(rent) : SOLANA_POOL_MIN_DEPOSIT;
    // W's claims unread: each count they can be, the lowest pay-in
    const counts = w.claim === undefined ? [0, 1, SOLANA_SWEEP_OWED_MAX] : [owed(w)];
    const at = (m: bigint, x: bigint): bigint | { refused: "not_funded" | "quote_check_failed" } => {
      let low: bigint | null = null;
      let refusal: { refused: "not_funded" | "quote_check_failed" } | null = null;
      for (const o of counts) {
        const after = solanaSellAfterFull(rent, o);
        const p = { fee: SOLANA_POOL_SELL_FEE, made, rents, after, lamports: w.lamports, minOut: m, keeps: false, noteFloor: solanaPoolNoteFloor(rent) };
        const r = solanaSellReserve({ ...p, swept: after - r0, base: r0, floor });
        if ("refused" in r) {
          refusal ??= r;
          continue;
        }
        // the sweep's path: the sale's note and the sweep's, everything over the reserve (W's keep and the token account's
        // rent back, less the teardown's first frame and the sweep's fee, the sweep's deposit rents with the trees one
        // entry on and what W keeps for its owed claims)
        const sweep = after + solanaRentMin(rent, 165) - 2n * SOLANA_LAMPORTS_PER_SIGNATURE - rentsAt(sizes && { stateSize: sizes.stateSize + 1, labelSize: sizes.labelSize + 1 }) - solanaSweepKeep(rent, o);
        const swept = net(x, SOLANA_POOL_SELL_FEE + made + rents + after - w.lamports) + (sweep > 0n ? sweep : 0n);
        // the rent(0) path (the note alone) here: the sale's own costs are at most these, so it may still take the sweep's
        const own = solanaSellReserve(p);
        const v = !("refused" in own) && own.value >= floor ? swept : r.value < swept ? r.value : swept;
        if (low === null || v < low) low = v;
      }
      return low ?? refusal!;
    };
    const out = at(minOut, e);
    const floorOut = at(minOut, minOut);
    if (typeof out !== "bigint") return out;
    if (typeof floorOut !== "bigint") return floorOut;
    return { out, minOut: floorOut };
  }
  const one = (w: DryWallet, keep: bigint): bigint => {
    const r = SOLANA_POOL_SELL_FEE + made + rents + keep - w.lamports;
    return r > 0n ? r : 0n;
  };
  const reserve = wallets.length === 1 ? one(wallets[0]!, keepPart) : wallets.reduce((t, w) => {
    const k = solanaSellAfterFull(rent, owed(w));
    return t + one(w, k > keepPart ? k : keepPart);
  }, 0n);
  return { out: net(e, reserve), minOut: net(minOut, reserve) };
}

const holding = (d: PoolSellDryDeps, token: unknown): Position | undefined => d.positions()?.find((p) => p.chain === "solana" && p.token === token);

/** pool.sell.dry's answer for `params` (the kit's schema passed them: pool.sell's own). `turn`: the page's (the kind's). */
export async function poolSellDry(d: PoolSellDryDeps, params: Record<string, unknown>, turn: Turn = { newest: () => true, calls: [[], []], kept: keptReads(d.now ?? (() => performance.now())) }): Promise<DryAnswer> {
  const chain = params.chain;
  if (chain !== "solana" || !d.pinned("solana")) return { error: "not_allowed" };
  const bare = d.rpcs();
  const token = params.token;
  if (bare === null || !poolTokenAddress("solana", token)) return { error: "not_allowed" };
  // the holding the positions pass read: over every W that holds the token; and the Ws bought since that pass, which the
  // sale plans before the pass lists them (pool-sell.ts planReads), each read below as the sale reads it
  const pos = holding(d, token);
  // a store that cannot be read (signed out meanwhile): none, so the pass's holding alone, as before
  const since = d.positions() === null ? [] : ((await (async () => d.bought?.(token as string))().catch(() => undefined)) ?? []);
  const extra = since.filter((b) => !pos?.wallets.includes(b.address));
  if (!pos && extra.length === 0) {
    // signed out (or sold out): nothing kept outlives the holding
    if (d.positions() === null) turn.kept.drop();
    return { error: "not_funded" };
  }
  const now = d.now ?? (() => performance.now());
  // asks posted in one turn: only the newest goes on. Everything is decided here, before any read is asked of a
  // provider (whose queue books a call's turn when it is asked): a preview that does not go asks nothing
  await null;
  if (!turn.newest()) return { error: "busy" };
  if (d.positions() === null || (extra.length === 0 && holding(d, token) === undefined)) {
    turn.kept.drop();
    return { error: "not_funded" };
  }
  const scope = JSON.stringify([token, pos?.amount ?? null, pos?.wallets ?? [], extra.map((b) => b.address)]);
  const kept = turn.kept.get(scope);
  if (kept !== null) {
    // the kept answers, as two plain answer lists outside the providers' queues: no call, no budget, no wait on a trade
    let missed = false;
    const replay = kept.map((m) => ((method: string, p: readonly unknown[]) => {
      const k = callKey(method, p);
      if (!m.has(k)) {
        missed = true;
        return Promise.reject(new Error("not kept"));
      }
      return Promise.resolve(m.get(k));
    }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
    const a = await previewOn(d, params, pos, extra, replay);
    if (!missed) return a;
    turn.kept.drop();
  }
  if (d.trading()) return { error: "busy" };
  const t = now();
  for (const c of turn.calls) while (c.length > 0 && c[0]! <= t - POOL_SELL_DRY_WINDOW_MS) c.shift();
  // W's own read for each W bought since the pass: one call more per host each
  if (turn.calls.some((c) => c.length + POOL_SELL_DRY_READ_CALLS + extra.length > POOL_SELL_DRY_CALLS)) return { error: "busy" };
  const answers: Answers = [new Map(), new Map()];
  const rpcs = bare.map((rpc, i) => solanaWrappedRpc(rpc, (m, p) => {
    turn.calls[i as 0 | 1].push(now());
    return rpc(m, p).then((x) => (answers[i as 0 | 1].set(callKey(m, p), x), x));
  })) as unknown as readonly [SolanaRpc, SolanaRpc];
  // answered inside the kit client's 10 s: a read held past POOL_SELL_DRY_ANSWER_MS (a trade's hold on its host) is busy
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DryAnswer>((r) => (timer = setTimeout(() => r({ error: "busy" }), POOL_SELL_DRY_ANSWER_MS)));
  try {
    const a = await Promise.race([previewOn(d, params, pos, extra, rpcs), late]);
    if ("result" in a) turn.kept.put(scope, answers, t);
    return a;
  } finally {
    clearTimeout(timer);
  }
}

/** The preview on `rpcs` (the gated pair, or the kept answers): the pass's holding `pos` and the Ws bought since it. */
async function previewOn(d: PoolSellDryDeps, params: Record<string, unknown>, pos: Position | undefined, extra: readonly BoughtW[], rpcs: readonly [SolanaRpc, SolanaRpc]): Promise<DryAnswer> {
  const token = params.token as string;
  const fault = (e: unknown, other: ErrorCode): DryAnswer => ({ error: e instanceof SolanaRpcTransportError ? "down" : other });
  let decimals = pos?.decimals ?? extra.find((b) => b.decimals !== undefined)?.decimals ?? d.decimals?.get("solana", token);
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
  // each W bought since the pass: what it holds as the sale's plan reads it, side by side (one W per call); two
  // providers apart (its token account on one only, right after its buy): not now; frozen on both: nothing held
  let own: (WHeld | "split" | "frozen")[];
  try {
    own = await Promise.all(extra.map((b) => wHeldNow(rpcs, b.address, token, b.program)));
  } catch (e) {
    return fault(e, "quote_check_failed");
  }
  if (own.includes("split")) return { error: "busy" };
  const mine = own.filter((o): o is WHeld => typeof o === "object" && o.amount > 0n);
  const passed = pos === undefined ? 0n : baseUnits(pos.amount, decimals);
  if (passed === null) return { error: "not_allowed" };
  const total = mine.reduce((t, o) => t + o.amount, passed);
  const units = poolSellUnits(total, ask);
  if (units <= 0n || units > total) return { error: "not_funded" };
  const ws = pos?.wallets ?? [];
  if (ws.length + mine.length === 0) return { error: "not_funded" };
  // the sale's quote, and the Ws (lamports, volume accounts) with the pool's sizes and the Rent sysvar, side by side
  let quoted: Awaited<ReturnType<typeof poolSellReference>>;
  let read: Awaited<ReturnType<typeof walletReads>>;
  let rent: SolanaRent;
  try {
    [quoted, [rent, read]] = await Promise.all([poolSellReference(rpcs, token, units), Promise.all([d.rent?.() ?? readSolanaRent(rpcs), walletReads(rpcs, ws, d.pin?.()?.program ?? null)])]);
  } catch (e) {
    return fault(e, "quote_check_failed");
  }
  if (!quoted) return { error: "quote_check_failed" };
  const venue = quoted.best.venue;
  if (venue !== "pump-curve" && venue !== "pumpswap") return { error: "quote_check_failed" };
  // a sign out while it read: the old holding is not answered
  if (d.positions() === null || (extra.length === 0 && holding(d, token) === undefined)) return { error: "not_funded" };
  const e = quoted.best.expectedOut;
  const wallets = [...read.wallets, ...mine.map((o): DryWallet => ({ lamports: o.lamports, claim: o.owes }))];
  const pays = poolSellPays(rent, venue, wallets, wallets.length === 1 && units === total, e, solanaSellFloor(e, ask.slippageBps), quoted.best.cashback, read.sizes);
  if ("refused" in pays) return { error: pays.refused };
  const sol = POOL_ASSET_DECIMALS_OF.solana;
  return { result: { out: poolUnits(pays.out, sol), min_out: poolUnits(pays.minOut, sol), network: poolUnits(SOLANA_POOL_SELL_FEE, sol), fee_bps: 0 } };
}

/** The kind for ApiHost.kinds: answered as a read that runs (Running), so `state`, nav and an open kind never wait for
 *  its reads; anything it throws is "down". One preview at a time per page (the header): an ask for what the running
 *  one reads shares its answer, any other makes it the newest. */
export function poolSellDryKind(d: PoolSellDryDeps): (params: Record<string, unknown>) => Running<"pool.sell.dry"> {
  const calls: [number[], number[]] = [[], []];
  const kept = keptReads(d.now ?? (() => performance.now()));
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
      after = poolSellDry(d, params, { newest: () => newest === me, calls, kept }).catch((): DryAnswer => ({ error: "down" }));
      const run = (running = { key, after });
      void after.then(() => void (running === run && (running = null)));
    }
    let out: DryAnswer = { error: "down" };
    return { after: after.then((a) => void (out = a)), answer: () => out, running: true };
  };
}

/** A trade kind with a count of its runs (trading above): each from its tap to its `after`, or its refusal, at most
 *  `maxMs`. A pool buy's `after` is its first answer (pool-buy.ts poolBuyKind): its early "sent", the app's Filled, once
 *  its transaction read back on both RPCs, after which its read-backs to Final need no host of its own (it gives its
 *  hold back then); else its run's end. A pool sell's is its run's end (its verdict and its rent backs, pool-sell.ts
 *  poolSellKind). The kind's answers and progress pass through unchanged. */
export function liveRuns<A>(kind: (params: Record<string, unknown>, ctx: KindContext) => A, maxMs = TRADE_LIVE_MAX_MS): { kind: (params: Record<string, unknown>, ctx: KindContext) => A; live(): number } {
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
      const r = kind(params, ctx) as unknown;
      const run = r as { after?: Promise<unknown>; answer?: () => unknown } | null;
      if (run === null || typeof run !== "object" || !(run.after instanceof Promise) || typeof run.answer !== "function") done();
      else void run.after.then(done, done);
      return r as A;
    },
  };
}
