// The tokens the device's pool buys hold, on SIGN_HOST's top-level page (card signpage-state-holdings; the kit's
// SignpageState.positions, its shape unchanged).
//
// - Only what this device bought: a position is a token W's buy record names (POSITION_COSTS_KEY, written by
//   recordPoolBuy when the buy filled: the mint, the units W received and their decimals, read from the buy's
//   transaction on both RPCs). A token the finder lists in W with no buy record on this device (one sent to W by
//   anyone) is no position: not listed, no Sell, and nothing is read for it. A W takes one buy only (a W is its note's,
//   and a note spends once: wallet/src/pool/queue.ts jOf and derive/keys.ts walletPath), so a record names W's one
//   holding. A device restored from the words has no buy records (src/pool-restore.ts writes notes only), so it shows
//   no position until it buys.
// - Display only, from one reader: a position's amount is what the finder's one read of its W says, never a read a
//   sell signs on; a sell reads its W again on two providers before it signs (pool-sell.ts tokenHeld).
// - The finder: the Ws the pool's spent notes paid (../../wallet/src/pool/buy-wallets.ts derivedBuyWallets, the one
//   finder a restore and a sell use), derived under the seed's lock with the seed zeroed at once, then only the Ws
//   with a buy record read, each once by its one reader with every token it holds: the helper's keyed route on mainnet,
//   a devnet RPC in the testnet build. No read of this pass names a W to a public provider (buy-wallets.ts header), and
//   none names a mint no buy record names: a mint's decimals come from its buy record, else from the kept pass, else
//   (a record from before decimals were kept) from both of the page's RPCs (rules/pool.ts tokenDecimalsOf) once.
// - One W at a time: a W whose read fails keeps its last amount (or, never listed and not sold, its record's) while
//   every other W updates, and the pass counts as failed so it runs again; a finder that cannot list at all keeps every
//   W's last. Once the finder listed a token in W and lists it no more (or at 0), it is gone, and an unread W or a
//   finder that is down never brings it back. A recorded token the finder read W whole and never listed shows at the
//   record's amount (a reader that lags hides nothing this device bought) until the finder lists it or this device
//   signed a full sell of it from W (pool-sell.ts writes W's rent-back record with that sell before it leaves the
//   device; noted here). A full sell that did not land leaves the token listed, so it stays.
// - Kept on the device: the last whole pass's positions (each with its decimals), each W's amounts and the tokens the
//   finder listed (POSITIONS_KEPT_KEY, in the wallet store, gone at sign out with the store), so the first state read
//   after a load answers at once (the finder reads one W per 3 s on mainnet), and the first pass replaces it. A pass
//   with any read failed never replaces it.
// - One position per token: its amount the sum over the Ws that hold it, as an exact decimal at its decimals, and
//   those Ws' addresses.
// - Its cost, in USD: each W's buy record names what the buy spent at the page's own two-RPC pool price at the request
//   (src/pool-price.ts; never a helper's price) and what W received. A W's cost now is that spend times what it holds
//   over what it received, so a sell takes cost off pro rata by the units it sold. A position any of whose Ws has no
//   cost in its record (a buy with no price read) has cost "0", which the app reads as unknown: never a cost made of
//   part of its Ws.
// - The pool buy's ops record (recordPoolBuy, review P3-1 of card kit-portfolio-reads): written once its run ends, as
//   state.ts's op contract reads it: kind "buy", its end stage, its txs, the error code of a refusal, its time, chain and
//   token, and amount_usd its asked spend at that price. Nothing secret. A run a closed tab ended writes none, nor one
//   that answered "sent" (no end yet).
// - When: a pass at the sign-in's first state read, and again each time a pool buy or sell run ends; never inside a
//   state read, which only takes the last pass. One pass at a time: a refresh asked while one runs runs once more after
//   it, a sign out's included. A sell's own read of the Ws stops a running pass and is the next pass's read, so a sell
//   never waits behind the display. A pass with any read failed is tried again POSITIONS_RETRY_MS later, up to
//   POSITIONS_RETRIES times. Sign out stops the running pass and drops it all.
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
  /** The Ws of these addresses (each with a buy record), each as the finder read it; throws when it cannot list. */
  wallets(only: ReadonlySet<string>): Promise<readonly FoundWallet[]>;
  /** The mint's decimals, the same on both RPCs; throws otherwise. Asked only for a recorded mint whose record and
   *  kept pass name none. */
  decimals(mint: string): Promise<number>;
  /** Each W's buy record (POSITION_COSTS_KEY); none: nothing recorded. */
  costs?(): Promise<PositionCosts>;
  /** The full sells this device signed, as "W mint" (POSITIONS_SOLD_KEY). */
  sold?(): Promise<ReadonlySet<string>>;
  /** The kept pass (POSITIONS_KEPT_KEY), as stored; read once, before the first pass. */
  kept?(): Promise<unknown>;
  /** Keeps this pass (POSITIONS_KEPT_KEY); only a whole one. */
  keep?(k: KeptPass): Promise<void>;
  /** Aborted: the pass stops, and keeps and answers nothing (a sign out, or a sell's own read in its place). */
  signal?: AbortSignal;
};

/** Where the buy records are, in the wallet store's meta by W's address: an owed/ key, the one meta keyspace the store
 *  lets a caller write, beside W's buy mints (pool-sell.ts buyMints, owed/buy-sol). */
export const POSITION_COSTS_KEY = "owed/cost-sol";
/** The full sells this device signed, in meta by W's address: the mints. */
export const POSITIONS_SOLD_KEY = "owed/sold-sol";
/** The last whole pass, in meta: KeptPass. */
export const POSITIONS_KEPT_KEY = "owed/positions-sol";
/** One W's buy: its mint, the token units it received (a decimal at the mint's own), the mint's decimals (read with
 *  that amount; none in a record from before they were kept) and, with a price read, the USD it spent (a decimal). */
export type PositionCost = { mint: string; received: string; decimals?: number; cost_usd?: string };
export type PositionCosts = Readonly<Record<string, PositionCost>>;

const DEC = /^\d{1,78}(\.\d{1,78})?$/;
/** A token's decimals: a u8, as an SPL mint's are (and the kit's schema bounds them). */
const isDecimals = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
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
/** A kept pass's positions, or null when it is not one (the kit's schema checks them again on the way out); with the
 *  buy records, only the tokens they name (a pass kept before the rule took any token the finder listed). */
export function keptPositions(v: unknown, costs?: unknown): Position[] | null {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null || !Array.isArray(k.positions)) return null;
  if (costs === undefined) return k.positions as Position[];
  const bought = new Set(typeof costs === "object" && costs !== null ? Object.values(costs).map((c) => (c as { mint?: unknown } | null)?.mint) : []);
  return (k.positions as Position[]).filter((p) => bought.has(p?.token));
}
function loadMemo(memo: PassMemo, v: unknown): void {
  const k = v as Partial<KeptPass> | null;
  if (typeof k !== "object" || k === null) return;
  if (typeof k.held === "object" && k.held !== null) for (const [key, a] of Object.entries(k.held)) if (typeof a === "string" && BASE.test(a)) memo.held.set(key, BigInt(a));
  if (Array.isArray(k.listed)) for (const key of k.listed) if (typeof key === "string") memo.listed.add(key);
  // each kept position's decimals, so a load asks no RPC for a token it showed
  if (Array.isArray(k.positions)) for (const p of k.positions as unknown[]) {
    const q = p as { token?: unknown; decimals?: unknown } | null;
    if (typeof q?.token === "string" && isDecimals(q.decimals) && !memo.decimals.has(q.token)) memo.decimals.set(q.token, q.decimals);
  }
}

/** One pass: the positions of this device's buy records, each from the finder's read of its W (see the header). */
export async function positionsPass(r: PositionsReads, memo: PassMemo = passMemo()): Promise<PassResult> {
  const stop = (): void => r.signal?.throwIfAborted();
  if (!memo.loaded) {
    memo.loaded = true;
    loadMemo(memo, await r.kept?.().catch(() => null));
  }
  let whole = true;
  const costs: PositionCosts = r.costs ? await r.costs().catch(() => ((whole = false), {})) : {};
  const sold = r.sold ? await r.sold().catch(() => ((whole = false), new Set<string>())) : new Set<string>();
  // the records that read: W's address, its mint and the units it received
  const records = Object.entries(costs).filter(([, c]) => typeof c?.mint === "string" && typeof c.received === "string" && DEC.test(c.received));
  for (const [, c] of records) if (isDecimals(c.decimals) && !memo.decimals.has(c.mint)) memo.decimals.set(c.mint, c.decimals);
  stop();
  let found: readonly FoundWallet[] | null = null;
  try {
    found = records.length === 0 ? [] : await r.wallets(new Set(records.map(([address]) => address)));
  } catch {
    stop();
    whole = false;
  }
  stop();
  const read = new Map<string, ReadonlyMap<string, bigint> | null>();
  for (const w of found ?? []) read.set(w.address, w.tokens);
  // each "W mint": its amount in base units, or the recorded amount (a decimal) until the mint's decimals are known
  const held = new Map<string, { address: string; mint: string; amount: bigint | string }>();
  const listed = new Set(memo.listed);
  for (const [address, c] of records) {
    const k = KEY(address, c.mint);
    const tokens = read.get(address);
    if (tokens) {
      const a = tokens.get(c.mint);
      // listed: the finder's amount stands (0: gone)
      if (a !== undefined) {
        listed.add(k);
        if (a > 0n) held.set(k, { address, mint: c.mint, amount: a });
        continue;
      }
      // read whole, not listed: gone once it was listed before or this device sold it all, else the record's amount
      if (!listed.has(k) && !sold.has(k)) held.set(k, { address, mint: c.mint, amount: c.received });
      continue;
    }
    // W unread, the finder down or not knowing W yet: W's last, else (never listed, not sold) the record's
    whole = false;
    const last = memo.held.get(k);
    if (last !== undefined) held.set(k, { address, mint: c.mint, amount: last });
    else if (!listed.has(k) && !sold.has(k)) held.set(k, { address, mint: c.mint, amount: c.received });
  }
  // a recorded mint whose record and kept pass name no decimals (a record from before they were kept): both RPCs, once
  for (const m of new Set([...held.values()].map((h) => h.mint))) {
    if (memo.decimals.has(m)) continue;
    try {
      memo.decimals.set(m, await r.decimals(m));
    } catch {
      stop();
      whole = false;
    }
  }
  stop();
  const by = new Map<string, { amount: bigint; wallets: string[]; held: { address: string; amount: bigint }[] }>();
  const nextHeld = new Map<string, bigint>();
  for (const [k, h] of held) {
    const d = memo.decimals.get(h.mint);
    // an amount whose decimals are not known yet: never dropped, shown once they are
    if (d === undefined) {
      whole = false;
      if (typeof h.amount === "bigint") nextHeld.set(k, h.amount);
      continue;
    }
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
  // only a whole pass is kept, never one a sign out overtook (its store is gone)
  if (whole && !memo.stale) await r.keep?.({ positions: out, held: Object.fromEntries([...nextHeld].map(([k, a]) => [k, a.toString()])), listed: [...listed] }).catch(() => {});
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
export type PoolBuyFacts = { token: string; spend: bigint; spendDecimals: number; price: PoolStatePrice | null; createdMs: number; wallet?: string; out?: string; decimals?: number };
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
 *  the token's decimals when told, and the USD it spent when a price was read), every other W's record kept. */
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
  const rec: PositionCost = { mint: f.token, received: f.out, ...(isDecimals(f.decimals) ? { decimals: f.decimals } : {}), ...(usd === null ? {} : { cost_usd: usd }) };
  await store.update("meta", POSITION_COSTS_KEY, (v) => ({ ...(typeof v === "object" && v !== null ? v : {}), [f.wallet!]: rec }));
}

export type PositionsCache = {
  /** The last pass (or the kept one before it), or null before either. */
  get(): readonly Position[] | null;
  /** Once per sign-in, before the first pass: the kept pass, if any, read into get(). */
  ready(): Promise<void>;
  /** Once the sign-in's first pass was asked: run a pass now, or once more after the one running. Before it, nothing
   *  (a trade's end after a sign out is no sign-in's first pass). */
  refresh(): void;
  /** The sign-in's first pass, once (a signed-in state read). */
  first(): void;
  /** A sell's own read of the Ws is coming: the running pass stops (its reads leave the finder's queue to the sell). */
  preempt(): void;
  /** The sell's read, the Ws as it found them: the next pass's read, in place of the finder's. */
  feed(found: readonly FoundWallet[]): void;
  /** `fn` runs when a pass changes the positions. */
  watch(fn: () => void): void;
  /** Sign out: the running pass stopped and its answer ignored, the positions and what the passes kept dropped, no
   *  retry left; the next sign-in reads its kept pass and runs its first pass again. */
  clear(): void;
  /** Settles once no pass runs (tests). */
  idle(): Promise<void>;
};

/** How the cache runs one pass: its stop signal, and the sell's read to use when one was fed. */
export type PassRun = { signal: AbortSignal; found?: readonly FoundWallet[] };

/** The positions of `pass`, one pass at a time, kept between passes. */
export function positionsCache(pass: (memo: PassMemo, run: PassRun) => Promise<PassResult>, o: { kept?: () => Promise<readonly Position[] | null>; retryMs?: number; retries?: number; setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): PositionsCache {
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
  // the running pass's stop
  let current: AbortController | null = null;
  let again = false;
  let fed: readonly FoundWallet[] | null = null;
  let gen = 0;
  let tries = 0;
  let timer: unknown = null;
  let started = false;
  let loading: Promise<void> | null = null;
  const run = (): void => {
    if (timer !== null) clearTimer(timer), (timer = null);
    if (running) return void (again = true);
    const g = gen;
    const stop = new AbortController();
    current = stop;
    const found = fed;
    fed = null;
    // a pass that a sign out or a sell stopped answers nothing
    const live = (): boolean => g === gen && !stop.signal.aborted;
    const retry = (): void => {
      if (!live() || tries >= retries) return;
      tries++;
      timer = setTimer(() => ((timer = null), run()), retryMs);
    };
    running = pass(memo, { signal: stop.signal, ...(found === null ? {} : { found }) }).then(
      (got) => {
        if (!live()) return;
        const changed = JSON.stringify(got.positions) !== JSON.stringify(last);
        last = got.positions;
        if (changed) for (const f of watchers) f();
        if (got.whole) tries = 0;
        else retry();
      },
      retry,
    ).finally(() => {
      running = null;
      if (current === stop) current = null;
      // asked while it ran, whoever asked: a sign-in's first pass after a sign out included
      if (again) {
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
      if (!started) return;
      tries = 0;
      run();
    },
    first: () => {
      if (started) return;
      started = true;
      run();
    },
    preempt: () => current?.abort(),
    feed: (found) => {
      if (!started) return;
      fed = found;
      tries = 0;
      run();
    },
    watch: (fn) => void watchers.add(fn),
    clear: () => {
      gen++;
      current?.abort();
      current = null;
      last = null;
      memo.stale = true;
      memo = passMemo();
      started = false;
      loading = null;
      again = false;
      fed = null;
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
