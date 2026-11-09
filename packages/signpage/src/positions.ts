// The tokens the device's pool buys hold, on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's
// SignpageState.positions, its shape unchanged).
//
// - Display only, from one reader: positions are what the finder's one read of each W says it holds, never a read a
//   sell signs on; a sell reads its W again on two providers before it signs (pool-sell.ts tokenHeld).
// - The finder: the buy wallets the pool's spent notes paid (../../wallet/src/pool/buy-wallets.ts buyWallets, the one
//   finder a restore and a sell use), each W read once by its one reader with every token it holds and the amount: the
//   helper's keyed route on mainnet, a devnet RPC in the testnet build. No read of this pass names a W to a public
//   provider (buy-wallets.ts header); the only chain reads it makes itself are a mint's decimals, on both of the page's
//   RPCs (rules/pool.ts tokenDecimalsOf), which name a token and no wallet, kept once read (they never change).
// - One W at a time: a W whose read fails keeps its last entries (or none) while every other W updates, and the pass
//   counts as failed so it runs again; a finder that cannot list at all keeps every W's last entries.
// - What this device bought: W's buy record (POSITION_COSTS_KEY, written when its buy filled) names the token and the
//   amount W received, read from the buy's transaction on both RPCs. A recorded token the finder read W whole and does
//   not list is shown at that amount, so a reader that lags or omits it hides nothing this device bought, until either
//   the finder lists it (from then on its amount is the finder's) or it is gone. Gone: the finder read W whole and
//   lists no such token, and either the finder listed it in W before (noted on the device) or this device signed a
//   full sell of it from W (pool-sell.ts writes W's rent-back record with that sell before it leaves the device; noted
//   here). A full sell that did not land leaves the token listed, so it stays. W takes one buy only (a W is its
//   note's, and a note spends once: wallet/src/pool/queue.ts jOf and derive/keys.ts walletPath), so a record never
//   names a second holding of W. A token at 0 is not held.
// - Kept on the device: the last pass's positions, each W's amounts and the tokens the finder listed
//   (POSITIONS_KEPT_KEY, in the wallet store, gone at sign out with the store), so the first state read after a load
//   answers at once (the finder reads one W per 3 s on mainnet), and the first pass replaces it.
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
//   after it. A pass with any read failed is tried again POSITIONS_RETRY_MS later, up to POSITIONS_RETRIES times. Sign
//   out drops it all.
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

/** One W as the finder read it: each token it holds, base units; null when that W's read failed. */
export type FoundWallet = { address: string; tokens: ReadonlyMap<string, bigint> | null };

/** What a pass reads, every read the device's own. */
export type PositionsReads = {
  /** Every buy wallet the finder knows, each as it read it; throws when it cannot list at all. */
  wallets(): Promise<readonly FoundWallet[]>;
  /** The mint's decimals, the same on both RPCs; throws otherwise. */
  decimals(mint: string): Promise<number>;
  /** Each W's buy record (POSITION_COSTS_KEY); none: nothing recorded. */
  costs?(): Promise<PositionCosts>;
  /** The full sells this device signed, as "W mint" (POSITIONS_SOLD_KEY). */
  sold?(): Promise<ReadonlySet<string>>;
  /** The kept pass (POSITIONS_KEPT_KEY), as stored; read once, before the first pass. */
  kept?(): Promise<unknown>;
  /** Keeps this pass (POSITIONS_KEPT_KEY). */
  keep?(k: KeptPass): Promise<void>;
};

/** Where the buy records are, in the wallet store's meta by W's address: an owed/ key, the one meta keyspace the store
 *  lets a caller write, beside W's buy mints (pool-sell.ts buyMints, owed/buy-sol). */
export const POSITION_COSTS_KEY = "owed/cost-sol";
/** The full sells this device signed, in meta by W's address: the mints. */
export const POSITIONS_SOLD_KEY = "owed/sold-sol";
/** The last pass, in meta: KeptPass. */
export const POSITIONS_KEPT_KEY = "owed/positions-sol";
/** One W's buy: its mint, the token units it received (a decimal at the mint's own) and, with a price read, the USD it
 *  spent (a decimal). */
export type PositionCost = { mint: string; received: string; cost_usd?: string };
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

/** A pass as kept: its positions, each "W mint" amount (base units, a decimal string) and each "W mint" the finder
 *  listed. */
export type KeptPass = { positions: Position[]; held: Record<string, string>; listed: string[] };
/** What a pass keeps for the next: each "W mint" last amount, what the finder listed, each mint's decimals. */
export type PassMemo = { held: Map<string, bigint>; listed: Set<string>; decimals: Map<string, number>; loaded: boolean; stale?: boolean };
export const passMemo = (): PassMemo => ({ held: new Map(), listed: new Set(), decimals: new Map(), loaded: false });
/** A pass's positions, and whether every read in it held (when not, it runs again). */
export type PassResult = { positions: Position[]; whole: boolean };

const KEY = (w: string, m: string): string => `${w} ${m}`;
const BASE = /^\d{1,78}$/;
/** A kept pass's positions, or null when it is not one (the kit's schema checks them again on the way out). */
export function keptPositions(v: unknown): Position[] | null {
  const k = v as Partial<KeptPass> | null;
  return typeof k === "object" && k !== null && Array.isArray(k.positions) ? (k.positions as Position[]) : null;
}
function loadMemo(memo: PassMemo, v: unknown): void {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null) return;
  if (typeof k.held === "object" && k.held !== null) for (const [key, a] of Object.entries(k.held)) if (typeof a === "string" && BASE.test(a)) memo.held.set(key, BigInt(a));
  if (Array.isArray(k.listed)) for (const key of k.listed) if (typeof key === "string") memo.listed.add(key);
}

/** One pass: the positions of the Solana pool's buy wallets, in the order the finder names them, then the records. */
export async function positionsPass(r: PositionsReads, memo: PassMemo = passMemo()): Promise<PassResult> {
  if (!memo.loaded) {
    memo.loaded = true;
    loadMemo(memo, await r.kept?.().catch(() => null));
  }
  let whole = true;
  let found: readonly FoundWallet[] | null = null;
  try {
    found = await r.wallets();
  } catch {
    whole = false;
  }
  const costs: PositionCosts = r.costs ? await r.costs().catch(() => ((whole = false), {})) : {};
  const sold = r.sold ? await r.sold().catch(() => ((whole = false), new Set<string>())) : new Set<string>();
  // each "W mint": its amount in base units, or the recorded amount (a decimal) until the mint's decimals are known
  const held = new Map<string, { address: string; mint: string; amount: bigint | string }>();
  const listed = new Set(memo.listed);
  const read = new Map<string, ReadonlyMap<string, bigint> | null>();
  for (const w of found ?? []) read.set(w.address, w.tokens);
  const keepLast = (address: string): void => {
    for (const [k, a] of memo.held) if (k.startsWith(`${address} `)) held.set(k, { address, mint: k.slice(address.length + 1), amount: a });
  };
  for (const w of found ?? []) {
    if (w.tokens === null) {
      whole = false;
      keepLast(w.address);
      continue;
    }
    for (const [mint, a] of w.tokens) {
      listed.add(KEY(w.address, mint));
      if (a > 0n) held.set(KEY(w.address, mint), { address: w.address, mint, amount: a });
    }
  }
  // the finder could not list: every W keeps its last entries
  if (found === null) for (const k of memo.held.keys()) keepLast(k.split(" ")[0]!);
  // what this device bought and the finder does not list
  for (const [address, c] of Object.entries(costs)) {
    if (typeof c?.mint !== "string" || typeof c.received !== "string" || !DEC.test(c.received)) continue;
    const k = KEY(address, c.mint);
    const tokens = read.get(address);
    if (tokens && tokens.has(c.mint)) continue; // the finder's amount stands
    if (tokens) {
      // read whole, not listed: gone once it was listed before or this device sold it all, else the record's amount
      if (!listed.has(k) && !sold.has(k)) held.set(k, { address, mint: c.mint, amount: c.received });
      continue;
    }
    // W unread or not known to the finder yet: its last amount, else the record's
    if (tokens === undefined) whole = false;
    if (!held.has(k) && !sold.has(k)) held.set(k, { address, mint: c.mint, amount: memo.held.get(k) ?? c.received });
  }
  for (const m of new Set([...held.values()].map((h) => h.mint))) {
    if (memo.decimals.has(m)) continue;
    try {
      memo.decimals.set(m, await r.decimals(m));
    } catch {
      whole = false;
    }
  }
  const by = new Map<string, { amount: bigint; wallets: string[]; held: { address: string; amount: bigint }[] }>();
  const nextHeld = new Map<string, bigint>();
  for (const [k, h] of held) {
    const d = memo.decimals.get(h.mint);
    if (d === undefined) continue;
    const amount = typeof h.amount === "bigint" ? h.amount : base(h.amount, d);
    if (amount === null || amount <= 0n) continue;
    nextHeld.set(k, amount);
    const q = by.get(h.mint) ?? { amount: 0n, wallets: [], held: [] };
    q.amount += amount;
    q.wallets.push(h.address);
    q.held.push({ address: h.address, amount });
    by.set(h.mint, q);
  }
  const out: Position[] = [];
  for (const [mint, p] of by) {
    const decimals = memo.decimals.get(mint)!;
    out.push({ chain: "solana", token: mint, amount: poolUnits(p.amount, decimals), cost: positionCost(mint, decimals, p.held, costs), wallets: p.wallets, decimals });
  }
  memo.held = nextHeld;
  memo.listed = listed;
  // a pass a sign out overtook keeps nothing (its store is gone)
  if (!memo.stale) await r.keep?.({ positions: out, held: Object.fromEntries([...nextHeld].map(([k, a]) => [k, a.toString()])), listed: [...listed] }).catch(() => {});
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
 *  already there, nor for an id another tab runs), and when it filled with W and its amount told, W's buy record (with
 *  the USD it spent when a price was read). */
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
  if (stage !== "filled" || f.wallet === undefined || f.out === undefined || !DEC.test(f.out)) return;
  const rec: PositionCost = { mint: f.token, received: f.out, ...(usd === null ? {} : { cost_usd: usd }) };
  await store.update("meta", POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [f.wallet!]: rec }));
}

export type PositionsCache = {
  /** The last pass (or the kept one before it), or null before either. */
  get(): readonly Position[] | null;
  /** Once per sign-in, before the first pass: the kept pass, if any, read into get(). */
  ready(): Promise<void>;
  /** Run a pass now, or once more after the one running. */
  refresh(): void;
  /** The sign-in's first pass, once (a signed-in state read). */
  first(): void;
  /** `fn` runs when a pass changes the positions. */
  watch(fn: () => void): void;
  /** Sign out: the positions dropped, a running pass's answer ignored, no retry left. */
  clear(): void;
  /** Settles once no pass runs (tests). */
  idle(): Promise<void>;
};

/** The positions of `pass`, one pass at a time, kept between passes. */
export function positionsCache(pass: (memo: PassMemo) => Promise<PassResult>, o: { kept?: () => Promise<readonly Position[] | null>; retryMs?: number; retries?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): PositionsCache {
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
  let started = false;
  let loading: Promise<void> | null = null;
  const run = (): void => {
    started = true;
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
    ready: () => {
      if (loading === null && o.kept) {
        const g = gen;
        loading = o.kept().then(
          (k) => {
            if (g === gen && last === null && k !== null) last = k;
          },
          () => {},
        );
      }
      return loading ?? Promise.resolve();
    },
    refresh: () => {
      tries = 0;
      run();
    },
    first: () => {
      if (!started) run();
    },
    watch: (fn) => void watchers.add(fn),
    clear: () => {
      gen++;
      last = null;
      memo.stale = true;
      memo = passMemo();
      started = false;
      loading = null;
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
