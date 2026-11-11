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
//   bought since the last whole pass as the pass itself takes it (boughtSincePass, from the page's store: W's buy mint
//   and its buy record name the token, with what W received, and no full sell of it is noted), read by W's own read (pool-sell.ts wHeldNow: the sale's wHeld, one W per
//   call, on both providers, the token account's amount the same on both), so a preview right after a buy's Filled
//   answers for it before the finder lists it, and a W the sale would find empty adds nothing (card
//   app-sell-shows-what-you-receive: devnet run 116 answered not_funded 7.6 s after a Filled while the pass's finder
//   read waited on its lane, and a sale then planned W). The token's
//   decimals the pass's or the page's kept ones (PAGE_TOKEN_DECIMALS) and the Rent sysvar the page's (main.ts
//   rentOnce), each read on the providers only when the page has none. A cold preview's provider reads are then
//   getMultipleAccounts per provider, side by side: the reference's two (one per venue; a venue the two did not agree on
//   is read again once, readSolanaReference) and one per W (walletReads: W's lamports and volume accounts, the pool's
//   sizes beside the first; each W bought since: wHeldNow), so no request ever names two of the user's wallets (the
//   review of b7212a9e, P1: the Ws' one call named every W the pass listed for the token).
// - Decided before any read: a provider's shared queue books a call's turn when it is asked (send.ts rpcSlot), so a
//   preview decides whether it goes before it asks anything, and one that does not go books nothing. It goes only as
//   the page's newest ask (one preview at a time; asks posted in one turn: the last; an ask for what the running one
//   reads gets its answer), while no trade runs on the page (a pool buy from its tap to its early "sent", a sell from
//   its tap to its run's end, main.ts liveRuns) and no trade holds either host (the lanes), and with its calls left of
//   POOL_SELL_DRY_CALLS per host in any POOL_SELL_DRY_WINDOW_MS (the helper gives one caller 16 in 10 s,
//   apps/helper/src/rpc/rpc.ts); else busy at once, never a wait. Its reads are background ones on its host's lane
//   ("pass", src/page-rpc.ts: they wait while a trade holds the host, and a trade never waits for them), answered
//   within POOL_SELL_DRY_ANSWER_MS, else busy. A sign out: not_funded. A provider that fails is not asked again: down.
//   busy and down are "not now" (api.ts RETRY_CODES): the app's next ask runs again.
// - At most POOL_SELL_DRY_CALLS - 2 Ws read, one per call (drySellCalls within POOL_SELL_DRY_CALLS): the Ws bought
//   since first (what each holds counts only when read; the pass's amount already holds its Ws'), then the ones the sale
//   would sell first (readFirst, as pool-sell.ts planOf takes them: the smallest W that holds the sale's units alone,
//   else the smallest first), by each W's amount as the kept pass holds it (a W bought since: its buy record's). A W not
//   read is priced at lamports 0 with its claims unread, so poolSellPays takes its lowest pay-in for it: the number can
//   be low, never high. A W bought since not read adds none of its tokens: an amount past what was read is busy (not
//   now: the pass lists it within seconds), never not_funded. The review of 6446ec37: with one call per W, five Ws or
//   more were busy on every ask.
// - The reads do not depend on the share: a cold preview's answers are kept POOL_SELL_DRY_KEEP_MS (the budget's window)
//   for the same token and the same Ws read, and a preview inside it runs on them as two plain answer lists outside the
//   providers' queues: no call, no budget, no wait on a trade (keptReads), so a preview never spends the window twice
//   for the same Ws (the review of 6446ec37: a second preview inside 10 s answered busy). At most 10 s old: the sale
//   reads its own before it signs (pool.sell reads its own reference). A sign out drops them.
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

/** The most calls previews make to one host in any POOL_SELL_DRY_WINDOW_MS: two cold previews of one W's holding (three each), a third of
 *  the helper's 16 per caller in 10 s, so a trade tapped after a burst of previews still has 10 of its own. */
export const POOL_SELL_DRY_CALLS = 6;
export const POOL_SELL_DRY_WINDOW_MS = 10_000;
/** A cold preview's calls on each host: the reference's two (one per venue), one per W of the pass's holding (walletReads;
 *  the pool's sizes beside the first, or alone with none) and one per W bought since (wHeldNow). */
export const drySellCalls = (passWs: number, since: number): number => 2 + Math.max(passWs, 1) + since;
/** A preview answers within this of its ask, else busy: a read's bound (SOLANA_RPC_RETRY, 3.5 s) and a margin under the
 *  kit client's 10 s for the kind (SIGNPAGE_TIMEOUT_MS), so no answer comes for an ask the app gave up on. */
export const POOL_SELL_DRY_ANSWER_MS = 6_000;
/** How long a preview's provider answers are kept for the next preview of the same token and Ws: the reads do not depend
 *  on the share, so a user tapping 25%, 50%, 75% and 100% in a row costs one read, not four; the budget's window, so a
 *  preview never spends it twice for the same Ws. A sale never takes these: it reads its own before it signs. */
export const POOL_SELL_DRY_KEEP_MS = POOL_SELL_DRY_WINDOW_MS;

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
  /** From the page's store for `token`: the Ws bought since the last whole pass (boughtSincePass), and each W's amount as
   *  the kept pass holds it (keptHeldOf), the order a sale takes them in. */
  bought?(token: string): Promise<StoreWs | undefined>;
  /** True while a trade runs on the page or holds a host of the pair (main.ts: liveRuns and the lanes). */
  trading(): boolean;
  /** A count that moves at every start and end of a pool trade of this page (deposit, buy, sell, withdraw: liveRuns
   *  edges): a preview's kept reads are taken only while it has not moved since they were read. None: 0. */
  trades?(): number;
  now?(): number;
};

/** A W bought since the last whole pass: its address, its token's program as its buy mint names it, and the token's
 *  decimals as W's buy record holds them. */
export type BoughtW = { address: string; program: string; decimals?: number; received?: string };
/** What the preview takes from the page's store for a token (PoolSellDryDeps.bought). */
export type StoreWs = { since: readonly BoughtW[]; held: ReadonlyMap<string, bigint> };
/** Each W's amount of `token` as the kept pass (positions.ts POSITIONS_KEPT_KEY) holds it, base units. */
export function keptHeldOf(token: string, kept: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [w, ms] of keptListed(kept) ?? []) if (ms.has(token)) out.set(w, ms.get(token)!);
  return out;
}
/** The Ws in the order a sale of `units` takes them (pool-sell.ts planOf, on `held`, each W's amount as known): the
 *  smallest W holding the units alone first, else the smallest first, ties by address; then the rest, smallest first.
 *  `units` null (the decimals not known yet): the smallest first. */
export function readFirst(held: readonly { address: string; held: bigint }[], units: bigint | null): string[] {
  const order = [...held].sort((x, y) => (x.held < y.held ? -1 : x.held > y.held ? 1 : x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
  const one = units === null ? undefined : order.find((x) => x.held >= units && x.held > 0n);
  return order.map((x) => x.address);
}
/** The Ws bought since the last whole pass, by the pass's own rule (positions.ts positionsPass: a recorded token the
 *  finder never listed shows at the record's amount): W's buy mint (pool-sell.ts BUY_MINTS_KEY, the sale plan's
 *  `bought`) names `token` with its program, W's buy record (POSITION_COSTS_KEY) names it with what W received (a buy
 *  that did not land has its record taken back: positions.ts recordPoolBuy), the kept pass (POSITIONS_KEPT_KEY) never
 *  listed it in W (once listed, W is the pass's, held or gone), and no full sell of it from W is noted
 *  (POSITIONS_SOLD_KEY, `{ W: [mint] }`: sold before the finder saw it). Buy mints are never deleted, so the record and
 *  the sold mark keep a W that holds nothing from being read on every preview (the review of b7212a9e, P2). */
export function boughtSincePass(token: string, mints: unknown, kept: unknown, costs: unknown, sold: unknown): BoughtW[] {
  const listed = keptListed(kept);
  const out: BoughtW[] = [];
  if (typeof mints !== "object" || mints === null) return out;
  for (const [address, m] of Object.entries(mints)) {
    const b = m as { mint?: unknown; program?: unknown } | null;
    if (b?.mint !== token || typeof b.program !== "string" || listed?.get(address)?.has(token)) continue;
    const c = (costs as Record<string, { mint?: unknown; received?: unknown; decimals?: unknown } | undefined> | null | undefined)?.[address];
    if (c?.mint !== token || typeof c.received !== "string" || !/^\d+(\.\d+)?$/.test(c.received)) continue;
    const gone = (sold as Record<string, unknown> | null | undefined)?.[address];
    if (Array.isArray(gone) && gone.includes(token)) continue;
    const d = c.decimals;
    out.push({ address, program: b.program, ...(Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 255 ? { decimals: d as number } : {}), received: c.received });
  }
  return out;
}

/** Each provider's answers to one preview's calls, by call (callKey). */
type Answers = readonly [Map<string, unknown>, Map<string, unknown>];
const callKey = (method: string, params: readonly unknown[]): string => JSON.stringify([method, params]);

/** The Ws a preview reads: those of the pass (walletReads) and those bought since (wHeldNow), one call each. */
type Pick = { pass: readonly string[]; since: readonly BoughtW[] };
/** The page's kept preview answers (POOL_SELL_DRY_KEEP_MS), by token, with the Ws they read: put once a cold preview
 *  answered, read only by previews (as a pair of plain answer lists, outside the providers' queues), gone past their
 *  age (so at most the cold previews one window holds: POOL_SELL_DRY_CALLS / 3), a token's dropped when a preview
 *  misses a call in them, all at a sign out. */
type KeptReads = { get(token: string): { answers: Answers; pick: Pick; trades: number } | null; put(token: string, answers: Answers, at: number, pick: Pick, trades: number): void; drop(token?: string): void };
function keptReads(now: () => number): KeptReads {
  const held = new Map<string, { answers: Answers; at: number; pick: Pick; trades: number }>();
  const prune = (): void => {
    for (const [k, v] of held) if (now() - v.at >= POOL_SELL_DRY_KEEP_MS) held.delete(k);
  };
  return {
    get: (token) => (prune(), held.get(token) ?? null),
    put: (token, answers, at, pick, trades) => void (prune(), held.set(token, { answers, at, pick, trades })),
    drop: (token) => void (token === undefined ? held.clear() : held.delete(token)),
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

/** In one getMultipleAccounts per W per RPC, each naming that W alone: its lamports and its two volume accounts; the pool
 *  account (the trees' sizes, when both RPCs hold the same bytes; else none) beside the first W, or alone with none.
 *  Strictly parsed: anything else throws. */
async function walletReads(rpcs: readonly [SolanaRpc, SolanaRpc], ws: readonly string[], program: string | null): Promise<{ wallets: DryWallet[]; sizes: Sizes | null }> {
  const pool = program === null ? null : solanaPoolOf(program).pool;
  const calls: string[][] = ws.map((w) => [w, solanaVolumeAccumulator(w, SOLANA_PUMP_PROGRAM), solanaVolumeAccumulator(w, SOLANA_PUMP_AMM_PROGRAM)]);
  if (pool !== null) (calls[0] ??= []).push(pool);
  const each = await Promise.all(calls.map((keys) => readOne(rpcs, keys)));
  const wallets = ws.map((_, k): DryWallet => {
    const [a, b] = each[k]!;
    const claims = (i: number, owner: string): boolean => [a, b].some((x) => x.accounts[i] != null && x.accounts[i]!.owner === owner && solanaVolumeClaimable(owner, x.accounts[i]!.data) > 0n);
    return { lamports: a.lamports[0]! < b.lamports[0]! ? a.lamports[0]! : b.lamports[0]!, claim: [claims(1, SOLANA_PUMP_PROGRAM), claims(2, SOLANA_PUMP_AMM_PROGRAM)] };
  });
  let sizes: Sizes | null = null;
  const first = each[0];
  const at = calls[0] === undefined ? -1 : calls[0].length - 1;
  const [pa, pb] = first === undefined || pool === null ? [null, null] : [first[0].accounts[at], first[1].accounts[at]];
  if (pool !== null && pa && pb && pa.owner === program && pb.owner === program && pa.data.length === pb.data.length && pa.data.every((x, i) => x === pb.data[i])) {
    try {
      sizes = poolTreeSizes(pa.data);
    } catch {
      // not a pool account: priced at a page's opening
    }
  }
  return { wallets, sizes };
}

/** One getMultipleAccounts of `keys` on each RPC, strictly parsed: each account's lamports and parsed account. */
async function readOne(rpcs: readonly [SolanaRpc, SolanaRpc], keys: readonly string[]) {
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
  return Promise.all([read(rpcs[0]), read(rpcs[1])]);
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
  const stored = d.positions() === null ? undefined : await (async () => d.bought?.(token as string))().catch(() => undefined);
  const since = stored?.since ?? [];
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
  if (d.positions() === null || (pos !== undefined && holding(d, token) === undefined)) {
    turn.kept.drop();
    return { error: "not_funded" };
  }
  // a trade of this page holds its hosts (and changes what its Ws hold): busy, as before, and nothing kept is taken
  if (d.trading()) return { error: "busy" };
  // the Ws read: the ones the last preview of this token read in the window, while no trade of this page started or
  // ended since (a sale, a buy, a withdraw or a deposit changes what a W holds, or the trees' sizes) and each W is still
  // where it was (a W of the pass, or one bought since), so the window is never spent twice for the same Ws, a W now in
  // neither (sold, or counted twice) is never read and nothing read before a trade is used after it; else as many as
  // fit, one call each, in the order the sale would sell them
  const trades = d.trades?.() ?? 0;
  let kept = turn.kept.get(token);
  if (kept !== null && kept.trades !== trades) {
    turn.kept.drop(token);
    kept = null;
  }
  const still = kept !== null && kept.pick.pass.every((w) => pos?.wallets.includes(w)) && kept.pick.since.every((b) => extra.some((x) => x.address === b.address && x.program === b.program));
  const pick: Pick = kept !== null && still ? kept.pick : readsOf(d, params, pos, extra, stored?.held ?? new Map());
  if (kept !== null && still) {
    // the kept answers, as two plain answer lists outside the providers' queues: no call, no budget, no wait on a trade
    let missed = false;
    const replay = kept.answers.map((m) => ((method: string, p: readonly unknown[]) => {
      const k = callKey(method, p);
      if (!m.has(k)) {
        missed = true;
        return Promise.reject(new Error("not kept"));
      }
      return Promise.resolve(m.get(k));
    }) as SolanaRpc) as unknown as readonly [SolanaRpc, SolanaRpc];
    const a = await previewOn(d, params, pos, extra, pick, replay);
    if (!missed) return a;
    turn.kept.drop(token);
  }
  const t = now();
  for (const c of turn.calls) while (c.length > 0 && c[0]! <= t - POOL_SELL_DRY_WINDOW_MS) c.shift();
  // one call per W read: the pass's (walletReads) and each bought since (wHeldNow)
  const need = drySellCalls(pick.pass.length, pick.since.length);
  if (turn.calls.some((c) => c.length + need > POOL_SELL_DRY_CALLS)) return { error: "busy" };
  const answers: Answers = [new Map(), new Map()];
  const rpcs = bare.map((rpc, i) => solanaWrappedRpc(rpc, (m, p) => {
    turn.calls[i as 0 | 1].push(now());
    return rpc(m, p).then((x) => (answers[i as 0 | 1].set(callKey(m, p), x), x));
  })) as unknown as readonly [SolanaRpc, SolanaRpc];
  // answered inside the kit client's 10 s: a read held past POOL_SELL_DRY_ANSWER_MS (a trade's hold on its host) is busy
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DryAnswer>((r) => (timer = setTimeout(() => r({ error: "busy" }), POOL_SELL_DRY_ANSWER_MS)));
  try {
    const a = await Promise.race([previewOn(d, params, pos, extra, pick, rpcs), late]);
    // kept only when no trade of this page started or ended while it read
    if ("result" in a && (d.trades?.() ?? 0) === trades) turn.kept.put(token, answers, t, pick, trades);
    return a;
  } finally {
    clearTimeout(timer);
  }
}

/** The Ws a preview reads: those bought since first, then the pass's, each in the order the sale would sell them
 *  (readFirst, on the kept pass's amounts and the buy records'), as many as fit POOL_SELL_DRY_CALLS one call each
 *  (drySellCalls). */
function readsOf(d: PoolSellDryDeps, params: Record<string, unknown>, pos: Position | undefined, extra: readonly BoughtW[], kept: ReadonlyMap<string, bigint>): Pick {
  const decimals = pos?.decimals ?? extra.find((b) => b.decimals !== undefined)?.decimals ?? d.decimals?.get("solana", params.token as string);
  const recorded = (b: BoughtW): bigint => (decimals === undefined || b.received === undefined ? 0n : (baseUnits(b.received, decimals) ?? 0n));
  const held = [...(pos?.wallets ?? []).map((w) => ({ address: w, held: kept.get(w) ?? 0n })), ...extra.map((b) => ({ address: b.address, held: recorded(b) }))];
  let units: bigint | null = null;
  if (decimals !== undefined) {
    try {
      const total = pos === undefined ? held.reduce((t, h) => t + h.held, 0n) : (baseUnits(pos.amount, decimals) ?? 0n) + extra.reduce((t, b) => t + recorded(b), 0n);
      units = poolSellUnits(total, checkPoolRequest({ ...(params as object), kind: "pool.sell", chain: "solana" }, decimals));
    } catch {
      // a bad request: refused below, before any read
    }
  }
  const pass: string[] = [];
  const since: BoughtW[] = [];
  const order = readFirst(held, units);
  const first = (a: string): boolean => extra.some((x) => x.address === a);
  for (const a of [...order.filter(first), ...order.filter((a) => !first(a))]) {
    const b = extra.find((x) => x.address === a);
    if (drySellCalls(pass.length + (b ? 0 : 1), since.length + (b ? 1 : 0)) > POOL_SELL_DRY_CALLS) continue;
    if (b) since.push(b);
    else pass.push(a);
  }
  return { pass, since };
}

/** The preview on `rpcs` (the gated pair, or the kept answers): the pass's holding `pos` and the Ws bought since it, the
 *  Ws `pick` names read, the others priced at lamports 0 with their claims unread. */
async function previewOn(d: PoolSellDryDeps, params: Record<string, unknown>, pos: Position | undefined, extra: readonly BoughtW[], pick: Pick, rpcs: readonly [SolanaRpc, SolanaRpc]): Promise<DryAnswer> {
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
    own = await Promise.all(pick.since.map((b) => wHeldNow(rpcs, b.address, token, b.program)));
  } catch (e) {
    return fault(e, "quote_check_failed");
  }
  if (own.includes("split")) return { error: "busy" };
  const mine = own.filter((o): o is WHeld => typeof o === "object" && o.amount > 0n);
  const passed = pos === undefined ? 0n : baseUnits(pos.amount, decimals);
  if (passed === null) return { error: "not_allowed" };
  const total = mine.reduce((t, o) => t + o.amount, passed);
  const units = poolSellUnits(total, ask);
  // short of what was read while a W bought since was not: not now, as it may hold the rest
  if (units <= 0n || units > total) return { error: pick.since.length < extra.length ? "busy" : "not_funded" };
  const ws = pos?.wallets ?? [];
  if (ws.length + mine.length === 0) return { error: "not_funded" };
  // the sale's quote, and the Ws (lamports, volume accounts) with the pool's sizes and the Rent sysvar, side by side
  let quoted: Awaited<ReturnType<typeof poolSellReference>>;
  let read: Awaited<ReturnType<typeof walletReads>>;
  let rent: SolanaRent;
  try {
    [quoted, [rent, read]] = await Promise.all([poolSellReference(rpcs, token, units), Promise.all([d.rent?.() ?? readSolanaRent(rpcs), walletReads(rpcs, pick.pass, d.pin?.()?.program ?? null)])]);
  } catch (e) {
    return fault(e, "quote_check_failed");
  }
  if (!quoted) return { error: "quote_check_failed" };
  const venue = quoted.best.venue;
  if (venue !== "pump-curve" && venue !== "pumpswap") return { error: "quote_check_failed" };
  // a sign out while it read: the old holding is not answered
  if (d.positions() === null || (pos !== undefined && holding(d, token) === undefined)) return { error: "not_funded" };
  const e = quoted.best.expectedOut;
  // a W not read (more Ws than fit): lamports 0, its claims unread, so the lowest pay-in for it
  const unread = ws.length - pick.pass.length + (extra.length - pick.since.length);
  const wallets = [...read.wallets, ...mine.map((o): DryWallet => ({ lamports: o.lamports, claim: o.owes })), ...Array.from({ length: unread }, (): DryWallet => ({ lamports: 0n }))];
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
export function liveRuns<A>(kind: (params: Record<string, unknown>, ctx: KindContext) => A, maxMs = TRADE_LIVE_MAX_MS): { kind: (params: Record<string, unknown>, ctx: KindContext) => A; live(): number; edges(): number } {
  let n = 0;
  // every start and every end: the preview's kept reads are taken only while it has not moved (PoolSellDryDeps.trades)
  let edges = 0;
  return {
    live: () => n,
    edges: () => edges,
    kind: (params, ctx) => {
      let on = true;
      n++;
      edges++;
      const done = (): void => {
        if (!on) return;
        on = false;
        n--;
        edges++;
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
