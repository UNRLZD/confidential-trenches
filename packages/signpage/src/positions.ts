// The tokens the device's pool buys hold, on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's
// SignpageState.positions, its shape unchanged).
//
// - Where to look: each W and token the device's own records name (W's buy mint, pool-sell.ts buyMints owed/buy-sol,
//   and W's buy record, POSITION_COSTS_KEY), and each the finder names: the buy wallets the pool's spent notes paid
//   (../../wallet/src/pool/buy-wallets.ts buyWallets, the one finder a restore and a sell use) with the tokens its one
//   reader lists (the helper's keyed route on mainnet, a devnet RPC in the testnet build). The device knows what it
//   bought, so a reader that lags, omits a token or fails hides no position this device bought; the finder adds what a
//   restore needs. A record's W and token that a pass saw held and later reads as 0 on both RPCs, with the finder
//   naming no such token in W, is marked gone (POSITIONS_GONE_KEY) and not read again from the records: W takes one
//   buy only (a W is its note's, and a note spends once), so its records never name a new holding.
// - What is held: each, read again as W's associated token account on both of the page's RPCs (pool-sell.ts tokenHeld,
//   the read a sell gates on: the mint's program the same on both, then the account's amount the same on both, read
//   again once), POSITIONS_READS_AT_ONCE at once on the page's own paced queues. A token's decimals are its mint's on
//   both RPCs (rules/pool.ts tokenDecimalsOf), kept once read (a mint's decimals never change). An amount one RPC
//   alone reports, or that the two read apart, is never shown: that one W and token keeps its last agreed amount, or
//   none, while every other updates, and the pass counts as failed so it runs again. A token whose agreed amount is 0
//   is not held, so after a full sell its position is gone.
// - One position per token: its amount the sum over the Ws that hold it, as an exact decimal at its decimals, and
//   those Ws' addresses.
// - Its cost, in USD: each W's buy record (POSITION_COSTS_KEY, written by recordPoolBuy when the buy filled) names what
//   the buy spent at the page's own two-RPC pool price at the request (src/pool-price.ts; never a helper's price) and
//   what W received, read from the transaction on both RPCs. A W's cost now is that spend times what it holds over what
//   it received, so a sell takes cost off pro rata by the units it sold. A position any of whose Ws has no record (a
//   restored device, a buy from before this card, a buy with no price read) has cost "0", which the app reads as
//   unknown: never a cost made of part of its Ws.
// - The pool buy's ops record (recordPoolBuy, review P3-1 of card kit-portfolio-reads): written once its run ends, as
//   state.ts's op contract reads it: kind "buy", its end stage, its txs, the error code of a refusal, its time, chain and
//   token, and amount_usd its asked spend at that price. Nothing secret. A run a closed tab ended writes none, nor one
//   that answered "sent" (no end yet).
// - When: a pass at the first signed-in state read, and again each time a pool buy or sell run ends; never inside a
//   state read, which only takes the last whole pass. One pass at a time: a refresh asked while one runs runs once more
//   after it. A pass with any read failed is tried again POSITIONS_RETRY_MS later, up to POSITIONS_RETRIES times, so a
//   buy's tokens that one RPC has not shown yet still appear without a reload. Sign out drops it all.
// - What crosses to APP_HOST: per token its chain, mint, amount, decimals and the Ws' addresses: amounts, addresses and
//   tokens only, never a note, a key or a path.
import type { BuyRoute, PoolStatePrice, SignpageState, TxRef } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { ANSWER_ROOM, pickOps } from "./state.ts";
import { poolUnits } from "./rules/pool.ts";

export type Position = SignpageState["positions"][number];

/** A failed pass is tried again this long after it ends. */
export const POSITIONS_RETRY_MS = 5_000;
/** At most this many tries in a row after a failed pass (a minute of a chain catching up), then the next buy, sell or
 *  sign-in load runs it again. */
export const POSITIONS_RETRIES = 12;

/** Reads in flight at once in a pass: each W and token is two or three getAccountInfo rounds on both RPCs, one after
 *  another, so 4 at once fills the page's paced queues (SOLANA_KEYLESS_RPC_LIMIT: 40 calls of one method per 10 s a
 *  provider) at about a dozen calls in flight, under that budget with room for a sell's own reads on the same queues. */
export const POSITIONS_READS_AT_ONCE = 4;

/** What a pass reads, every read the device's own. */
export type PositionsReads = {
  /** Each buy wallet with the tokens the finder's read names in it (more than nothing); throws when it cannot list. */
  wallets(): Promise<readonly { address: string; tokens: readonly string[] }[]>;
  /** Each W and token the device's own records name (its buy mints and buy records), gone ones left out. */
  bought?(): Promise<readonly { address: string; mint: string }[]>;
  /** Marks a record's W and token gone (see the header). */
  gone?(address: string, mint: string): Promise<void>;
  /** W's amount of `mint` in base units, the same on both RPCs; throws when they differ or a read fails. */
  held(address: string, mint: string): Promise<bigint>;
  /** The mint's decimals, the same on both RPCs; throws otherwise. */
  decimals(mint: string): Promise<number>;
  /** Each W's buy record (POSITION_COSTS_KEY); none: every cost "0". */
  costs?(): Promise<PositionCosts>;
};

/** Where the buy records are, in the wallet store's meta by W's address: an owed/ key, the one meta keyspace the store
 *  lets a caller write, beside W's buy mints (pool-sell.ts buyMints, owed/buy-sol). */
export const POSITION_COSTS_KEY = "owed/cost-sol";
/** The records' Ws and tokens read as gone, in meta by W's address: its mint. */
export const POSITIONS_GONE_KEY = "owed/gone-sol";
/** One W's buy: its mint, the USD it spent (a decimal) and the token units it received (a decimal at the mint's own). */
export type PositionCost = { mint: string; cost_usd: string; received: string };
export type PositionCosts = Readonly<Record<string, PositionCost>>;

const DEC = /^\d{1,78}(\.\d{1,78})?$/;
/** A decimal string in base units at `d` decimals, the extra digits cut; null when it is not one. */
function base(v: unknown, d: number): bigint | null {
  if (typeof v !== "string" || !DEC.test(v)) return null;
  const [i, f = ""] = v.split(".");
  return BigInt(i!) * 10n ** BigInt(d) + BigInt((f.slice(0, d) || "0").padEnd(d, "0"));
}
/** Cost in USD carried at this scale through the pro rata. */
const COST_SCALE = 12;

/** A position's cost: the sum over its Ws of each W's spend times its held over its received, or "0" when any W has no
 *  record of this mint, or one that does not read. */
export function positionCost(mint: string, decimals: number, held: readonly { address: string; amount: bigint }[], costs: PositionCosts): string {
  let sum = 0n;
  for (const w of held) {
    const c = Object.hasOwn(costs, w.address) ? costs[w.address] : undefined;
    if (!c || c.mint !== mint) return "0";
    const spent = base(c.cost_usd, COST_SCALE);
    const received = base(c.received, decimals);
    if (spent === null || received === null || received <= 0n) return "0";
    sum += w.amount >= received ? spent : (spent * w.amount) / received;
  }
  return poolUnits(sum, COST_SCALE);
}

/** What a pass keeps for the next: each W and token's last agreed amount (by "W mint") and each mint's decimals. */
export type PassMemo = { held: Map<string, bigint>; decimals: Map<string, number> };
export const passMemo = (): PassMemo => ({ held: new Map(), decimals: new Map() });
/** A pass's positions, and whether every read in it held (when not, it runs again). */
export type PassResult = { positions: Position[]; whole: boolean };

async function atOnce<T>(items: readonly T[], f: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(POSITIONS_READS_AT_ONCE, items.length) }, async () => {
    while (i < items.length) await f(items[i++]!);
  }));
}

/** One pass: the positions of the Solana pool's buy wallets, in the order the finder then the records name them. */
export async function positionsPass(r: PositionsReads, memo: PassMemo = passMemo()): Promise<PassResult> {
  let whole = true;
  const pairs = new Map<string, { address: string; mint: string; found: boolean }>();
  const add = (address: string, mint: string, found: boolean): void => {
    const k = `${address} ${mint}`;
    const p = pairs.get(k);
    if (p) p.found ||= found;
    else pairs.set(k, { address, mint, found });
  };
  const listed = new Set<string>();
  let finder = true;
  try {
    for (const w of await r.wallets()) {
      listed.add(w.address);
      for (const m of w.tokens) add(w.address, m, true);
    }
  } catch {
    whole = finder = false;
  }
  try {
    for (const b of (await r.bought?.()) ?? []) add(b.address, b.mint, false);
  } catch {
    whole = false;
  }
  // with the finder or the records unread, every W and token the last pass held is read again
  if (!whole) for (const k of memo.held.keys()) add(k.split(" ")[0]!, k.split(" ")[1]!, false);
  const held = new Map<string, bigint>();
  const gone: { address: string; mint: string }[] = [];
  await atOnce([...pairs], async ([k, p]) => {
    try {
      const amount = await r.held(p.address, p.mint);
      held.set(k, amount);
      // seen held by a pass, now 0 on both RPCs, and the finder read W with no such token
      if (amount === 0n && (memo.held.get(k) ?? 0n) > 0n && finder && listed.has(p.address) && !p.found) gone.push(p);
    } catch {
      whole = false;
      const was = memo.held.get(k);
      if (was !== undefined) held.set(k, was);
    }
  });
  const by = new Map<string, { amount: bigint; wallets: string[]; held: { address: string; amount: bigint }[] }>();
  for (const [k, p] of pairs) {
    const amount = held.get(k);
    if (amount === undefined || amount <= 0n) continue;
    const q = by.get(p.mint) ?? { amount: 0n, wallets: [], held: [] };
    q.amount += amount;
    q.wallets.push(p.address);
    q.held.push({ address: p.address, amount });
    by.set(p.mint, q);
  }
  await atOnce([...by.keys()].filter((m) => !memo.decimals.has(m)), async (m) => {
    try {
      memo.decimals.set(m, await r.decimals(m));
    } catch {
      whole = false;
    }
  });
  const costs = by.size > 0 && r.costs ? await r.costs().catch(() => ({})) : {};
  const out: Position[] = [];
  for (const [mint, p] of by) {
    const decimals = memo.decimals.get(mint);
    if (decimals === undefined) continue;
    out.push({ chain: "solana", token: mint, amount: poolUnits(p.amount, decimals), cost: positionCost(mint, decimals, p.held, costs), wallets: p.wallets, decimals });
  }
  memo.held.clear();
  for (const [k, a] of held) if (a > 0n) memo.held.set(k, a);
  for (const g of gone) await r.gone?.(g.address, g.mint).catch(() => {});
  return { positions: out, whole };
}

/** A pool asset's amount in base units at `decimals`, in USD at `price` (price x 10^expo USD a whole unit), exact. */
export function usdOf(amount: bigint, decimals: number, price: PoolStatePrice): string | null {
  if (!/^[1-9]\d{0,77}$/.test(price.price) || !Number.isSafeInteger(price.expo) || price.expo > 0) return null;
  return poolUnits(amount * BigInt(price.price), decimals - price.expo);
}

/** The store a pool buy's records go in (the wallet store's ops and meta). */
export type BuyRecordStore = {
  get(store: "ops", key: string): Promise<unknown>;
  put(store: "ops", key: string, value: unknown): Promise<unknown>;
  update(store: "meta", key: string, f: (v: unknown) => unknown): Promise<unknown>;
};
/** What a pool buy run told and asked, for its records. */
export type PoolBuyFacts = { token: string; spend: bigint; spendDecimals: number; price: PoolStatePrice | null; createdMs: number; wallet?: string; out?: string };
type BuyAnswer = { result: { stage: string; txs: readonly TxRef[] } } | { error: string };

const FINAL = new Set(["filled", "part_filled", "refused", "not_landed"]);

/** The ctx route a buy run tells through, its W and the amount W received kept in `facts` on the way. */
export const routeInto = (facts: PoolBuyFacts, route?: (r: BuyRoute) => void) => (r: BuyRoute): void => {
  if ("wallet" in r) facts.wallet = r.wallet;
  if ("out" in r) facts.out = r.out;
  route?.(r);
};

/** A pool buy's records once its run ended (see the header): its ops record under the request's id (never over one
 *  already there, nor for an id another tab runs), and when it filled with W and its amount told and a price read, W's
 *  buy record for its cost. */
export async function recordPoolBuy(store: BuyRecordStore, id: string, f: PoolBuyFacts, answer: BuyAnswer | null): Promise<void> {
  if (answer === null || ("error" in answer && answer.error === "id_reused")) return;
  if ((await store.get("ops", id)) !== undefined) return;
  const usd = f.price === null ? null : usdOf(f.spend, f.spendDecimals, f.price);
  const stage = "error" in answer ? "refused" : answer.result.stage;
  // an end only: a run that answered "sent" (read back, its spend not yet read as this attempt's) is the note settle's to
  // finish, which writes no op, so a "sent" record would stay open; and trade.ts settleTradeOps refuses an open buy
  // record with no tx as a trade-box one
  if (!FINAL.has(stage)) return;
  const txs = "error" in answer ? [] : answer.result.txs.map((t) => ({ chain: t.chain, hash: t.hash }));
  await store.put("ops", id, { kind: "buy", stage, txs, ...("error" in answer ? { code: answer.error } : {}), created_ms: f.createdMs, chain: "solana", token: f.token, ...(usd === null ? {} : { amount_usd: usd }) });
  if (stage !== "filled" || usd === null || f.wallet === undefined || f.out === undefined || !DEC.test(f.out)) return;
  const rec: PositionCost = { mint: f.token, cost_usd: usd, received: f.out };
  await store.update("meta", POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [f.wallet!]: rec }));
}

export type PositionsCache = {
  /** The last whole pass, or null before the first. */
  get(): readonly Position[] | null;
  /** Run a pass now, or once more after the one running. */
  refresh(): void;
  /** A pass when none has run or is running (a signed-in state read). */
  first(): void;
  /** `fn` runs when a pass changes the positions. */
  watch(fn: () => void): void;
  /** Sign out: the positions dropped, a running pass's answer ignored, no retry left. */
  clear(): void;
  /** Settles once no pass runs (tests). */
  idle(): Promise<void>;
};

/** The positions of `pass`, one pass at a time, kept between passes. */
export function positionsCache(pass: (memo: PassMemo) => Promise<PassResult>, o: { retryMs?: number; retries?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): PositionsCache {
  const retryMs = o.retryMs ?? POSITIONS_RETRY_MS;
  const retries = o.retries ?? POSITIONS_RETRIES;
  // a retry never holds a process open (Node's unref; a browser's timer has none)
  const setTimer = o.setTimer ?? ((f, ms) => {
    const t = setTimeout(f, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const watchers = new Set<() => void>();
  let last: readonly Position[] | null = null;
  let memo = passMemo();
  let running: Promise<void> | null = null;
  let again = false;
  let gen = 0;
  let tries = 0;
  let timer: unknown = null;
  const run = (): void => {
    if (timer !== null) clearTimer(timer), (timer = null);
    if (running) return void (again = true);
    const g = gen;
    const retry = (): void => {
      if (g !== gen || tries >= retries) return;
      tries++;
      timer = setTimer(() => ((timer = null), run()), retryMs);
    };
    running = pass(memo).then(
      (got) => {
        if (g !== gen) return;
        const changed = JSON.stringify(got.positions) !== JSON.stringify(last);
        last = got.positions;
        if (changed) for (const f of watchers) f();
        if (got.whole) tries = 0;
        else retry();
      },
      retry,
    ).finally(() => {
      running = null;
      if (again && g === gen) {
        again = false;
        run();
      }
    });
  };
  return {
    get: () => last,
    refresh: () => {
      tries = 0;
      run();
    },
    first: () => {
      if (last === null && running === null && timer === null) run();
    },
    watch: (fn) => void watchers.add(fn),
    clear: () => {
      gen++;
      last = null;
      memo = passMemo();
      again = false;
      tries = 0;
      if (timer !== null) clearTimer(timer), (timer = null);
    },
    idle: async () => {
      while (running) await running;
    },
  };
}

const utf8 = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** `state` with `positions` when signed in and a pass has run; the oldest ops give way for them as for the vault's
 *  balance (src/vault-balance.ts), and a state they cannot fit, or that the kit's schema refuses with them, goes as it
 *  was. */
export function withPositions(state: SignpageState, positions: readonly Position[] | null): SignpageState {
  if (!state.signed_in || positions === null) return state;
  let out: SignpageState = { ...state, positions };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) out = { ...out, ops: pickOps({ ...out, ops: [] }, state.ops.map((op, t) => ({ op, t }))) };
  if (utf8(out) > SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM) return state;
  return SIGNPAGE_RESULT_SCHEMAS.state(out) ? out : state;
}
