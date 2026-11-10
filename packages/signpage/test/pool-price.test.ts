// The page's own USD price per pool chain (card signpage-pool-price, src/pool-price.ts): read with the kit's
// poolUsdPrice on two RPCs of two providers, held only within the feed's bound, read again while a pool shows, and
// added to state.pools by withPools. The reads replay the kit's recorded answers (../../kit/test/fixtures/pool-usd.json:
// Pyth's SOL/USD account on two Solana RPCs, Chainlink's ETH/USD on two Base RPCs), one thing planted per case.
//   node --test test/pool-price.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { POOL_USD_FEEDS, poolUsdPrice, type PoolUsdArgs, type PoolUsdPrice } from "../../kit/src/price/pool-usd.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { BalancePool } from "../../wallet/src/pool/balances.ts";
import { POOL_PRICE_REFRESH_MS, POOL_PRICE_RETRY_AFTER_MAX_MS, POOL_PRICE_RETRY_MS, POOL_PRICE_WRITE_LEAD_MS, POOL_PRICE_WRITE_POLL_MS, poolPrices, wakeWhenShown, type PoolPriceDeps } from "../src/pool-price.ts";
import { withPools } from "../src/pools.ts";
import { stateOf } from "../src/state.ts";

type Call = { url: string; method: string; params: unknown[]; result: unknown };
type Recorded = { rpcs: [string, string]; calls: Call[] };
const FX = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/pool-usd.json", import.meta.url), "utf8")) as {
  nowMs: number;
  solana: Recorded;
  base: Recorded;
};
const key = (params: readonly unknown[]): string =>
  JSON.stringify(params.map((x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? { ...x, minContextSlot: undefined } : x)));
function replay(rec: Recorded, k: 0 | 1, edit?: (method: string, result: unknown) => unknown): SolanaRpc {
  const url = rec.rpcs[k];
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const c = rec.calls.find((x) => x.url === url && x.method === method && key(x.params) === key(params));
    if (c === undefined) throw new Error(`no recorded answer for ${method} on ${url}`);
    const r = structuredClone(c.result);
    return edit ? edit(method, r) : r;
  };
  return Object.assign(rpc, { url });
}
/** RPC 1's Pyth account with its price word changed: the two providers answer different bytes on every read. */
const lyingPrice = (method: string, r: unknown): unknown => {
  if (method !== "getMultipleAccounts") return r;
  const acc = (r as { value: { data: [string, string] }[] }).value[0]!;
  const b = base64.decode(acc.data[0]);
  new DataView(b.buffer, b.byteOffset).setBigInt64(73, 1n, true);
  acc.data = [base64.encode(b), "base64"];
  return r;
};
const SOL_RPCS = [replay(FX.solana, 0), replay(FX.solana, 1)] as const;
const SOL_BYTES = base64.decode((FX.solana.calls.find((c) => c.method === "getMultipleAccounts")!.result as { value: { data: [string] }[] }).value[0]!.data[0]);
const SOL_PUBLISHED_S = Number(new DataView(SOL_BYTES.buffer, SOL_BYTES.byteOffset).getBigInt64(93, true));
const SOL_PRICE = new DataView(SOL_BYTES.buffer, SOL_BYTES.byteOffset).getBigInt64(73, true);

/** A page's price holder at `clock.ms`, ticks kept for the test to run. */
function holder(over: Partial<PoolPriceDeps> = {}) {
  const clock = { ms: FX.nowMs };
  const ticks: (() => void)[] = [];
  const told: number[] = [];
  const p = poolPrices({ rpcs: (c) => (c === "solana" ? SOL_RPCS : null), now: () => clock.ms, after: (_ms, fn) => void ticks.push(fn), ...over });
  p.watch(() => told.push(clock.ms));
  return { p, clock, ticks, told };
}
// a turn of the event loop (setImmediate: a setTimeout(0) waits at least 1 ms, which made each of the sweep's runs
// seconds long)
const settle = () => new Promise<void>((r) => setImmediate(r));
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await settle();
}

const SOL: BalancePool = { id: "sol:p", chain: "solana", scope: 11n, asset: "SOL" };
const SIGNED_IN = stateOf(true, { source: "code", code_saved: true }, []);
const note: NoteRecord = { id: "a", ref: { kind: "deposit", s: SOL.scope, i: 0 }, scope: SOL.scope, precommitment: 1n, state: "UNSPENT", leaf: { value: 10_000_000n, label: 1n, commitment: 1n, leafIndex: 0n } };

test("a fresh read: the page's own price reaches state.pools[solana].price with its read time, valid for the kit's schema", async () => {
  const h = holder();
  assert.equal(h.p.get("solana"), null, "nothing before a read");
  h.p.refresh(["solana"]);
  await settled();
  const got = h.p.get("solana");
  assert.deepEqual(got, { price: SOL_PRICE.toString(), expo: -8, published_s: SOL_PUBLISHED_S, read_ms: FX.nowMs });
  const out = await withPools(SIGNED_IN, async () => [note], [SOL], undefined, h.p.get);
  assert.deepEqual(out.pools, [{ chain: "solana", asset: "SOL", balance: "0.01", price: got }]);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
  // no price given: the entry as it was
  assert.deepEqual((await withPools(SIGNED_IN, async () => [note], [SOL])).pools, [{ chain: "solana", asset: "SOL", balance: "0.01" }]);
});

test("agreement: two RPCs that disagree on the Pyth account give no price, and the state's entry has none", async () => {
  const h = holder({ rpcs: (c) => (c === "solana" ? [replay(FX.solana, 0), replay(FX.solana, 1, lyingPrice)] : null) });
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(h.p.get("solana"), null);
  const out = await withPools(SIGNED_IN, async () => [note], [SOL], undefined, h.p.get);
  assert.equal(Object.hasOwn(out.pools![0]!, "price"), false);
});

test("staleness: a price past its feed's bound on the device's clock leaves the state; a read of a stale feed gives none", async () => {
  const h = holder();
  h.p.refresh(["solana"]);
  await settled();
  const maxS = POOL_USD_FEEDS.solana.maxAgeS;
  h.clock.ms = (SOL_PUBLISHED_S + maxS) * 1000;
  assert.notEqual(h.p.get("solana"), null, "at the bound: still fresh");
  h.clock.ms = (SOL_PUBLISHED_S + maxS) * 1000 + 1;
  assert.equal(h.p.get("solana"), null, "past it: none");
  // a feed read already older than its bound: the kit refuses it, no price
  const late = holder();
  late.clock.ms = (SOL_PUBLISHED_S + maxS + 5) * 1000;
  late.p.refresh(["solana"]);
  await settled();
  assert.equal(late.p.get("solana"), null);
});

test("a failed read keeps the last good one only within its bound", async () => {
  let fail = false;
  const read = async (): Promise<PoolUsdPrice> => {
    if (fail) throw new Error("the two RPCs disagree");
    return { chain: "solana", asset: "SOL", decimals: 9, price: 9_301_048_308n, expo: -8, publishedS: Math.floor(FX.nowMs / 1000), source: "pyth", at: 1n };
  };
  const h = holder({ read });
  h.p.refresh(["solana"]);
  await settled();
  const first = h.p.get("solana");
  assert.notEqual(first, null);
  fail = true;
  h.clock.ms += POOL_PRICE_REFRESH_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.deepEqual(h.p.get("solana"), first, "the last good read stands");
  h.clock.ms = FX.nowMs + (POOL_USD_FEEDS.solana.maxAgeS + 1) * 1000;
  assert.equal(h.p.get("solana"), null, "until its bound");
});

test("refresh: one read per chain at a time, again only once its last try is POOL_PRICE_REFRESH_MS old; the watchers hear each end and the tick after it", async () => {
  const asked: string[] = [];
  let release: () => void = () => {};
  const read = (a: PoolUsdArgs): Promise<PoolUsdPrice> => {
    asked.push(a.chain);
    return new Promise((res) => {
      release = () => res({ chain: "solana", asset: "SOL", decimals: 9, price: 1n, expo: 0, publishedS: Math.floor(FX.nowMs / 1000), source: "pyth", at: 1n });
    });
  };
  const h = holder({ read });
  h.p.refresh(["solana", "solana"]);
  h.p.refresh(["solana"]);
  await settled();
  assert.deepEqual(asked, ["solana"], "one read while one runs");
  h.clock.ms += POOL_PRICE_REFRESH_MS * 2;
  h.p.refresh(["solana"]);
  await settled();
  assert.deepEqual(asked, ["solana"], "a read that outlasts POOL_PRICE_REFRESH_MS is still the only one");
  h.clock.ms -= POOL_PRICE_REFRESH_MS * 2;
  release();
  await settled();
  assert.equal(h.told.length, 1, "the read's end is told");
  assert.equal(h.ticks.length, 1, "the next tick is set");
  h.clock.ms += POOL_PRICE_REFRESH_MS - 1;
  h.p.refresh(["solana"]);
  await settled();
  assert.deepEqual(asked, ["solana"], "not due yet");
  h.ticks.shift()!();
  assert.equal(h.told.length, 2, "the tick tells the watchers, so a state read follows");
  h.clock.ms += 1;
  h.p.refresh(["solana"]);
  await settled();
  assert.deepEqual(asked, ["solana", "solana"], "due: read again");
});

test("retry: a failed first read is read again within 2 s and its good price reaches the state; failures in a row wait longer, up to POOL_PRICE_REFRESH_MS", async () => {
  // the kit's read fails as sign live run 41920575578 did (4 Nov 22:00Z), then answers
  // (false: it throws; "base": an answer of another chain, which is a failure too)
  const outcomes: (boolean | "base")[] = [false, true];
  const asked: number[] = [];
  const read = async (): Promise<PoolUsdPrice> => {
    asked.push(h.clock.ms);
    const o = outcomes.shift() ?? true;
    if (o === false) throw new Error("rpc 0 getMultipleAccounts: no answer in 3500 ms (timeout, 1 try at solana-rpc.publicnode.com)");
    return { chain: o === "base" ? "base" : "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: Math.floor(h.clock.ms / 1000), source: "pyth", at: 1n };
  };
  const waits: { ms: number; fn: () => void }[] = [];
  const h = holder({ read, after: (ms, fn) => void waits.push({ ms, fn }) });
  /** A tick: the clock moves to it and the watchers hear it, and the state read that follows refreshes the chain. */
  const tick = async (): Promise<number> => {
    const w = waits.shift()!;
    h.clock.ms += w.ms;
    w.fn();
    h.p.refresh(["solana"]);
    await settled();
    return w.ms;
  };
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(h.p.get("solana"), null, "the first read failed: no price");
  assert.equal(h.told.length, 1, "a failed read's end is told");
  assert.equal(await tick(), POOL_PRICE_RETRY_MS);
  assert.ok(POOL_PRICE_RETRY_MS <= 2_000);
  assert.deepEqual(asked, [FX.nowMs, FX.nowMs + POOL_PRICE_RETRY_MS], "read again at the failure's tick");
  assert.notEqual(h.p.get("solana"), null, "the good read is in the state");
  // a good read: the next one POOL_PRICE_REFRESH_MS on, as before, and a state read before then starts none
  assert.equal(waits.at(-1)!.ms, POOL_PRICE_REFRESH_MS);
  h.clock.ms += POOL_PRICE_REFRESH_MS - 1;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(asked.length, 2, "not due before POOL_PRICE_REFRESH_MS");
  h.clock.ms -= POOL_PRICE_REFRESH_MS - 1;
  // failures in a row: 1 s, 2 s, 4 s, 8 s, then POOL_PRICE_REFRESH_MS, each read at its tick; a good read ends the run
  outcomes.push(false, false, false, false, false, false, true, false);
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) {
    seen.push(await tick());
    if (i === 0) assert.notEqual(h.p.get("solana"), null, "a failed read keeps the last good one");
  }
  assert.deepEqual(seen, [POOL_PRICE_REFRESH_MS, 1_000, 2_000, 4_000, 8_000, POOL_PRICE_REFRESH_MS, POOL_PRICE_REFRESH_MS, POOL_PRICE_REFRESH_MS]);
  assert.equal(asked.length, 10, "every tick read once");
  assert.equal(waits.at(-1)!.ms, POOL_PRICE_RETRY_MS, "the failure after a good read waits POOL_PRICE_RETRY_MS again");
  outcomes.push("base");
  assert.equal(await tick(), POOL_PRICE_RETRY_MS);
  assert.equal(waits.at(-1)!.ms, 2 * POOL_PRICE_RETRY_MS, "an answer of another chain is a failure in the run");
  // not due before its wait: a state read 1 ms early starts nothing
  h.clock.ms += POOL_PRICE_RETRY_MS - 1;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(asked.length, 11);
});

test("retry: a failed read is due POOL_PRICE_RETRY_MS after it ends, not after it began", async () => {
  const asked: number[] = [];
  const read = async (): Promise<PoolUsdPrice> => {
    asked.push(h.clock.ms);
    // the read takes 3 s, then fails
    h.clock.ms += 3_000;
    throw new Error("rpc 0 getMultipleAccounts: no answer in 3000 ms");
  };
  const h = holder({ read });
  h.p.refresh(["solana"]);
  await settled();
  const end = h.clock.ms;
  h.clock.ms = end + POOL_PRICE_RETRY_MS - 1;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(asked.length, 1, "not due before POOL_PRICE_RETRY_MS after its end");
  h.clock.ms = end + POOL_PRICE_RETRY_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(asked.length, 2, "due then");
});

test("retry: a read whose price is past its bound as it ends is not held: the last good price kept, read again in POOL_PRICE_WRITE_POLL_MS (a late feed, card pool-usd-price-never-stale)", async () => {
  const maxS = POOL_USD_FEEDS.solana.maxAgeS;
  let ageS = 0;
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: Math.floor(h.clock.ms / 1000) - ageS, source: "pyth", at: 1n });
  const waits: number[] = [];
  const h = holder({ read, after: (ms) => void waits.push(ms) });
  h.p.refresh(["solana"]);
  await settled();
  const good = h.p.get("solana");
  assert.notEqual(good, null);
  assert.equal(waits.at(-1), POOL_PRICE_REFRESH_MS);
  // the next read answers a price 4 s past the kit's own bound
  ageS = maxS + 4;
  h.clock.ms += POOL_PRICE_REFRESH_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(waits.at(-1), POOL_PRICE_WRITE_POLL_MS, "a late feed: read again soon");
  assert.deepEqual(h.p.get("solana"), good, "the last good price stands");
});

test("retry: a provider's Retry-After is waited before the chain is read again, up to POOL_PRICE_RETRY_AFTER_MAX_MS", async () => {
  const faults: unknown[] = [
    new SolanaRpcTransportError("http_429", "HTTP 429", 3, "rpc.example", 5_000),
    new Error("rpc 0 getMultipleAccounts: no answer in 3500 ms"),
    new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc.example", 600_000),
    new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc.example"),
  ];
  const read = async (): Promise<PoolUsdPrice> => {
    throw faults.shift();
  };
  const waits: number[] = [];
  const h = holder({ read, after: (ms) => void waits.push(ms) });
  for (let i = 0; i < 4; i++) {
    h.p.refresh(["solana"]);
    await settled();
    h.clock.ms += waits.at(-1)!;
  }
  assert.deepEqual(waits, [5_000, 2 * POOL_PRICE_RETRY_MS, POOL_PRICE_RETRY_AFTER_MAX_MS, 8 * POOL_PRICE_RETRY_MS], "Retry-After when longer, capped; the backoff otherwise");
});

test("no pair, NEAR or no chain named: no read and no price; Robinhood reads on its pair with Base's pair beside it", async () => {
  const asked: PoolUsdArgs[] = [];
  const read = async (a: PoolUsdArgs): Promise<PoolUsdPrice> => {
    asked.push(a);
    throw new Error("planted");
  };
  const none = holder({ rpcs: () => null, read });
  none.p.refresh(["solana", "base", "robinhood", "near"]);
  none.p.refresh([]);
  await settled();
  assert.equal(asked.length, 0);
  assert.equal(none.p.get("near"), null);
  const BASE = [replay(FX.base, 0), replay(FX.base, 1)] as const;
  const RH = [Object.assign(async () => null, { url: "https://rh-a.example" }), Object.assign(async () => null, { url: "https://rh-b.example" })] as const;
  const rh = holder({ rpcs: (c) => (c === "robinhood" ? RH : c === "base" ? BASE : null), read });
  rh.p.refresh(["robinhood"]);
  await settled();
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.rpcs, RH);
  assert.equal(asked[0]!.baseRpcs, BASE);
  // Robinhood with no Base pair: not read (the kit would refuse it)
  const lone = holder({ rpcs: (c) => (c === "robinhood" ? RH : null), read });
  lone.p.refresh(["robinhood"]);
  await settled();
  assert.equal(asked.length, 1);
});

test("a clock behind the feed never stretches the bound: a price stamped 60 s ahead of its read is dropped once its bound past the read (review L2)", async () => {
  const readMs = FX.nowMs;
  const maxMs = POOL_USD_FEEDS.solana.maxAgeS * 1000;
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: 1n, expo: 0, publishedS: Math.floor(readMs / 1000) + 60, source: "pyth", at: 1n });
  const h = holder({ read });
  h.p.refresh(["solana"]);
  await settled();
  h.clock.ms = Math.floor(readMs / 1000) * 1000 + maxMs;
  assert.notEqual(h.p.get("solana"), null, "the bound after the read: held");
  h.clock.ms = readMs + maxMs + 1_000;
  assert.equal(h.p.get("solana"), null, "a second past it: dropped");
});

// ------------------------------------------------------------------------------------------------ at the feed's write
// Card pool-usd-price-never-stale. Pyth's sponsored SOL/USD account, read 10 Nov 03:56-04:26Z: written when its price is
// 50 to 57 s old, landing 1 to 3 s later. The page reads the kit's own poolUsdPrice on two replayed providers whose
// account carries, at the page's clock, the publish time the timeline has landed by then. Each tick the page sets runs
// in time order and is followed by a state read (the API reads the state when its watchers are told, src/api.ts), and
// the held price is looked at every 100 ms.
const T = SOL_PUBLISHED_S;
type Write = { atMs: number; pubS: number };
/** A timeline's or a stepped run's bound on timers run: a page whose timers come due at the same instant forever (a
 *  mutant of its schedule) fails at once, not at the test's timeout. A 30 min run sets about 1,500. */
const TIMERS_MAX = 20_000;
async function timeline(writes: Write[], fromMs: number, toMs: number, opts: { over?: Partial<PoolPriceDeps>; fault?: (ms: number, k: 0 | 1) => unknown; at?: (ms: number, h: ReturnType<typeof holder>) => boolean } = {}) {
  const pubAt = (ms: number) => writes.filter((w) => w.atMs <= ms).at(-1)!.pubS;
  const waits: { at: number; fn: () => void }[] = [];
  const readsAt: number[] = [];
  const rpc = (k: 0 | 1): SolanaRpc => {
    const r = replay(FX.solana, k, (method, res) => {
      if (method !== "getMultipleAccounts") return res;
      const acc = (res as { value: { data: [string, string] }[] }).value[0]!;
      const b = base64.decode(acc.data[0]);
      new DataView(b.buffer, b.byteOffset).setBigInt64(93, BigInt(pubAt(h.clock.ms)), true);
      acc.data = [base64.encode(b), "base64"];
      return res;
    });
    return Object.assign(async (m: string, p: readonly unknown[]) => {
      const f = opts.fault?.(h.clock.ms, k);
      if (f !== undefined) throw f;
      return r(m, p);
    }, { url: FX.solana.rpcs[k] });
  };
  const pair = [rpc(0), rpc(1)] as const;
  const h = holder({
    rpcs: (c) => (c === "solana" ? pair : null),
    read: (a) => (readsAt.push(h.clock.ms), poolUsdPrice(a)),
    after: (ms, fn) => void waits.push({ at: h.clock.ms + ms, fn }),
    ...opts.over,
  });
  const nulls: number[] = [];
  const heldAt = new Map<number, number>();
  let fired = 0;
  h.clock.ms = fromMs;
  h.p.refresh(["solana"]);
  await settled();
  for (let t = fromMs; t <= toMs; t += 100) {
    waits.sort((a, b) => a.at - b.at);
    while (waits.length > 0 && waits[0]!.at <= t) {
      if (++fired > TIMERS_MAX) throw new Error(`${TIMERS_MAX} timers run by ${(t - fromMs) / 1000} s: the page's timers never let the clock move`);
      const w = waits.shift()!;
      h.clock.ms = w.at;
      w.fn();
      h.p.refresh(["solana"]);
      await settled();
    }
    h.clock.ms = t;
    if (opts.at?.(t, h)) await settled();
    const g = h.p.get("solana");
    if (g === null) nulls.push(t);
    else if (!heldAt.has(g.published_s)) heldAt.set(g.published_s, t);
  }
  return { nulls, heldAt, readsAt };
}
const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

test("at the feed's write: a write landing at T+55.5 s (its price 54 s old) is held within POOL_PRICE_WRITE_POLL_MS, and the price is never gone from T to T+120 (card pool-usd-price-never-stale)", async () => {
  const w: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 55.5) * 1000, pubS: T + 54 }];
  const r = await timeline(w, (T + 3) * 1000, (T + 120) * 1000);
  // at main 53b56ccd: no price from T+60 s to T+63 s (the 60 s bound, and the next read 15 s after the last)
  assert.deepEqual(r.nulls, [], `no price at ${r.nulls.slice(0, 3).map((ms) => ms / 1000 - T).join(", ")} s past T`);
  const held = r.heldAt.get(T + 54)!;
  assert.ok(held - w[1]!.atMs <= POOL_PRICE_WRITE_POLL_MS, `the write is held ${(held - w[1]!.atMs) / 1000} s after it lands`);
  // read again POOL_PRICE_WRITE_POLL_MS apart from publish + 55 s (the bound less POOL_PRICE_WRITE_LEAD_MS) until the
  // write is in, then POOL_PRICE_REFRESH_MS on
  const first = T * 1000 + POOL_USD_FEEDS.solana.maxAgeS * 1000 - POOL_PRICE_WRITE_LEAD_MS;
  assert.equal(first, (T + 55) * 1000);
  const near = r.readsAt.filter((ms) => ms >= first && ms <= held);
  assert.ok(near.length >= 2, String(near.length));
  assert.equal(near[0], first, "the first read at publish + 55 s");
  assert.deepEqual(gaps(near), near.slice(1).map(() => POOL_PRICE_WRITE_POLL_MS), "each POOL_PRICE_WRITE_POLL_MS, no backoff");
  const next = r.readsAt.find((ms) => ms > held)!;
  assert.equal(next - held, POOL_PRICE_REFRESH_MS, "a newer price: back to POOL_PRICE_REFRESH_MS");
  assert.ok(gaps(r.readsAt.filter((ms) => ms < first - POOL_PRICE_REFRESH_MS)).every((g) => g === POOL_PRICE_REFRESH_MS), "before the window: every POOL_PRICE_REFRESH_MS");
});

test("at the feed's write: a late write at T+70 s is held within POOL_PRICE_WRITE_POLL_MS and the price is never gone; none by T+80 s: gone from T+75 s, read each POOL_PRICE_WRITE_POLL_MS (no backoff), back within POOL_PRICE_WRITE_POLL_MS of the write", async () => {
  const late: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 70) * 1000, pubS: T + 68 }];
  const a = await timeline(late, (T + 3) * 1000, (T + 100) * 1000);
  assert.deepEqual(a.nulls, []);
  assert.ok(a.heldAt.get(T + 68)! - late[1]!.atMs <= POOL_PRICE_WRITE_POLL_MS);
  const later: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 80) * 1000, pubS: T + 78 }];
  const b = await timeline(later, (T + 3) * 1000, (T + 100) * 1000);
  const maxMs = POOL_USD_FEEDS.solana.maxAgeS * 1000;
  assert.equal(b.nulls[0], T * 1000 + maxMs + 100, "gone just past the bound, not before");
  assert.ok(b.nulls.at(-1)! < later[1]!.atMs + POOL_PRICE_WRITE_POLL_MS, `back ${(b.nulls.at(-1)! - later[1]!.atMs) / 1000} s after the write`);
  assert.ok(b.heldAt.get(T + 78)! - later[1]!.atMs <= POOL_PRICE_WRITE_POLL_MS);
  const between = b.readsAt.filter((ms) => ms >= T * 1000 + maxMs - POOL_PRICE_WRITE_POLL_MS && ms <= later[1]!.atMs + POOL_PRICE_WRITE_POLL_MS);
  assert.ok(between.length >= 3, String(between.length));
  assert.ok(gaps(between).every((g) => g === POOL_PRICE_WRITE_POLL_MS), `a late feed read each POOL_PRICE_WRITE_POLL_MS: ${gaps(between)}`);
});

test("at the feed's write: a late feed is read each POOL_PRICE_WRITE_POLL_MS for POOL_PRICE_WRITE_LEAD_MS past its end, then backs off as a failure", async () => {
  const r = await timeline([{ atMs: 0, pubS: T }], (T + 3) * 1000, (T + 160) * 1000);
  const end = T * 1000 + POOL_USD_FEEDS.solana.maxAgeS * 1000;
  const after = r.readsAt.filter((ms) => ms > end + POOL_PRICE_WRITE_LEAD_MS);
  assert.deepEqual(gaps(after).slice(0, 4), [1_000, 2_000, 4_000, 8_000], "past the window: the failure backoff");
});

test("at the feed's write: a provider that fails inside the window still backs off; Retry-After still wins", async () => {
  const w: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 58) * 1000, pubS: T + 56 }];
  // provider 1 answers nothing from T+55 s to T+62 s: the kit's read fails as unreachable, not as a late feed
  const down = (ms: number, k: 0 | 1) => (k === 1 && ms >= (T + 55) * 1000 && ms < (T + 62) * 1000 ? new SolanaRpcTransportError("http_5xx", "HTTP 503", 1, "rpc.example") : undefined);
  const a = await timeline(w, (T + 3) * 1000, (T + 70) * 1000, { fault: down });
  const inside = a.readsAt.filter((ms) => ms >= (T + 55) * 1000 && ms < (T + 62) * 1000);
  assert.ok(inside.length >= 3, String(inside.length));
  assert.deepEqual(gaps(inside), [1_000, 2_000, 4_000].slice(0, inside.length - 1), `a failing provider backs off: ${gaps(inside)}`);
  // a 429 with Retry-After 5 s at T+55 s: not asked again for 5 s
  const busy = (ms: number, k: 0 | 1) => (k === 0 && ms === (T + 55) * 1000 ? new SolanaRpcTransportError("http_429", "HTTP 429", 1, "rpc.example", 5_000) : undefined);
  const b = await timeline(w, (T + 3) * 1000, (T + 70) * 1000, { fault: busy });
  const i = b.readsAt.indexOf((T + 55) * 1000);
  assert.ok(i >= 0);
  assert.equal(b.readsAt[i + 1]! - b.readsAt[i]!, 5_000);
});

test("at the feed's write: a hidden page reads every POOL_PRICE_REFRESH_MS and never each second; shown again, it reads at once", async () => {
  let shown = false;
  let woke = false;
  const w: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 55.5) * 1000, pubS: T + 54 }];
  const r = await timeline(w, (T + 3) * 1000, (T + 100) * 1000, {
    over: { visible: () => shown },
    at: (ms, h) => {
      if (ms === (T + 90) * 1000) {
        shown = true;
        const n = h.told.length;
        h.p.wake();
        woke = h.told.length > n;
        h.p.refresh(["solana"]);
        return true;
      }
      return false;
    },
  });
  const hidden = r.readsAt.filter((ms) => ms < (T + 90) * 1000);
  assert.ok(gaps(hidden).every((g) => g >= POOL_PRICE_REFRESH_MS), `hidden: ${gaps(hidden)}`);
  assert.ok(woke, "wake tells the watchers, so a state read follows");
  assert.ok(r.readsAt.includes((T + 90) * 1000), `shown again: read at once: ${r.readsAt.map((ms) => ms / 1000 - T)}`);
  // hidden with the feed late (no write past T+75 s): no read each second, the failure backoff
  const late = await timeline([{ atMs: 0, pubS: T }], (T + 3) * 1000, (T + 110) * 1000, { over: { visible: () => false } });
  const past = late.readsAt.filter((ms) => ms > (T + 75) * 1000);
  assert.deepEqual(gaps(past).slice(0, 3), [1_000, 2_000, 4_000], `hidden and late: the failure backoff, ${gaps(past)}`);
});

test("at the feed's write: with no visible() given, a page whose document is hidden reads every POOL_PRICE_REFRESH_MS", async () => {
  const g = globalThis as { document?: unknown };
  g.document = { visibilityState: "hidden" };
  try {
    const r = await timeline([{ atMs: 0, pubS: T }, { atMs: (T + 55.5) * 1000, pubS: T + 54 }], (T + 3) * 1000, (T + 70) * 1000);
    assert.ok(gaps(r.readsAt).every((x) => x === POOL_PRICE_REFRESH_MS), String(gaps(r.readsAt)));
  } finally {
    delete g.document;
  }
});

test("at the feed's write: a price past its bound by the page's clock as the read ends (a slow read) is a late feed: read again each POOL_PRICE_WRITE_POLL_MS, no backoff", async () => {
  const maxS = POOL_USD_FEEDS.solana.maxAgeS;
  // the kit's read passes on its own clock, and the page's clock is 2 s past the price's bound when it ends
  const read = async (): Promise<PoolUsdPrice> => {
    const publishedS = Math.floor(h.clock.ms / 1000) - maxS + 1;
    h.clock.ms += 3_000;
    return { chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS, source: "pyth", at: 1n };
  };
  const waits: number[] = [];
  const h = holder({ read, after: (ms) => void waits.push(ms) });
  for (let i = 0; i < 3; i++) {
    h.p.refresh(["solana"]);
    await settled();
    h.clock.ms += waits.at(-1)!;
  }
  assert.deepEqual(waits, [POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_WRITE_POLL_MS]);
  assert.equal(h.p.get("solana"), null);
});

test("at the feed's write: an older price than the one held never replaces it", async () => {
  const pubs = [T + 10, T + 5];
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: pubs.shift() ?? T + 5, source: "pyth", at: 1n });
  const h = holder({ read });
  h.clock.ms = (T + 11) * 1000;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(h.p.get("solana")?.published_s, T + 10);
  h.clock.ms += POOL_PRICE_REFRESH_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(h.p.get("solana")?.published_s, T + 10);
});

test("at the feed's write: the live check's follower (scripts/live-checks/pool-usd-price-never-stale.mjs) reads on this page's schedule: the same numbers, and the same read times on one timeline", async () => {
  // a script, not a package file: its URL, so the type check reads it as the module it is at run time
  const CHECK = new URL("../../../scripts/live-checks/pool-usd-price-never-stale.mjs", import.meta.url).href;
  const { SCHEDULE, follow } = (await import(CHECK)) as {
    SCHEDULE: { refreshMs: number; leadMs: number; pollMs: number; retryMs: number; retryAfterMaxMs: number };
    follow: (o: object) => Promise<{ reads: { startMs: number }[] }>;
  };
  assert.deepEqual(SCHEDULE, { refreshMs: POOL_PRICE_REFRESH_MS, leadMs: POOL_PRICE_WRITE_LEAD_MS, pollMs: POOL_PRICE_WRITE_POLL_MS, retryMs: POOL_PRICE_RETRY_MS, retryAfterMaxMs: POOL_PRICE_RETRY_AFTER_MAX_MS });
  // one timeline: a write at T+55.5 s, a late one at T+136 s (its price 132 s old: past the first's bound of T+129 s)
  const w: Write[] = [{ atMs: 0, pubS: T }, { atMs: (T + 55.5) * 1000, pubS: T + 54 }, { atMs: (T + 136) * 1000, pubS: T + 132 }];
  const page = await timeline(w, (T + 3) * 1000, (T + 160) * 1000);
  let t = (T + 3) * 1000;
  const pubAt = () => w.filter((x) => x.atMs <= t).at(-1)!.pubS;
  const rpc = (k: 0 | 1): SolanaRpc =>
    replay(FX.solana, k, (method, res) => {
      if (method !== "getMultipleAccounts") return res;
      const acc = (res as { value: { data: [string, string] }[] }).value[0]!;
      const b = base64.decode(acc.data[0]);
      new DataView(b.buffer, b.byteOffset).setBigInt64(93, BigInt(pubAt()), true);
      acc.data = [base64.encode(b), "base64"];
      return res;
    });
  const pair = [rpc(0), rpc(1)] as const;
  const check = await follow({ read: () => poolUsdPrice({ chain: "solana", rpcs: pair, nowMs: t }), now: () => t, sleep: async (ms: number) => void (t += ms), untilMs: (T + 160) * 1000 });
  assert.deepEqual(check.reads.map((r) => r.startMs), page.readsAt.filter((ms) => ms < (T + 160) * 1000));
});

test("at the feed's write: a chain with no RPCs yet (a read never started) is asked for them again only each POOL_PRICE_REFRESH_MS, however often the state is read", async () => {
  let asked = 0;
  const h = holder({ rpcs: () => (asked++, null) });
  for (let s = 0; s < 31; s++) {
    h.p.refresh(["solana"]);
    await settled();
    h.clock.ms += 1_000;
  }
  assert.equal(asked, 3, "at 0, 15 and 30 s");
  assert.equal(h.p.get("solana"), null);
});

// ------------------------------------------------------------------------------------------------ the timer's own read
// Review of eb2dfdc5, P2-2 (its probes early.mjs and coarse.mjs, as tests): each timer set the read due at its own end
// and, if the clock ran a hair short of that end as it fired, the state read it started found nothing due and no timer
// was set again: the chain was never read again. Fake clock, fake read (the feed's write each 52 to 58 s).
/** A run of `minutes` on a clock `now()` that may lag the true time `tau` (steps of `stepMs`, timers `shortMs` early). */
async function stepped({ minutes, stepMs = 1, shortMs = 0, readMs = 217 }: { minutes: number; stepMs?: number; shortMs?: number; readMs?: number }) {
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let tau = 1_800_000_000_123;
  const T0 = tau, end = T0 + minutes * 60_000;
  const writes = [{ at: T0 - 20_000, pub: Math.floor((T0 - 22_000) / 1000) }];
  for (;;) {
    const last = writes.at(-1)!;
    const at = last.pub * 1000 + Math.round((52 + rnd() * 6) * 1000);
    if (at > end + 120_000) break;
    writes.push({ at, pub: Math.floor(at / 1000 - (1 + rnd() * 2)) });
  }
  const pubAt = (t: number) => writes.filter((w) => w.at <= t).at(-1)!.pub;
  const events: { at: number; fn: () => void }[] = [];
  let reads = 0;
  let lastRead = T0;
  const p = poolPrices({
    rpcs: () => SOL_RPCS,
    now: () => Math.floor(Math.floor(tau / stepMs) * stepMs),
    visible: () => true,
    after: (ms, fn) => void events.push({ at: tau + ms - shortMs, fn }),
    read: () =>
      new Promise((res) => {
        reads++;
        lastRead = tau;
        events.push({ at: tau + readMs, fn: () => res({ chain: "solana", asset: "SOL", decimals: 9, price: 1n, expo: -8, publishedS: pubAt(tau), source: "pyth", at: 1n }) });
      }),
  });
  // the API: one state read after each tell
  let queued = false;
  p.watch(() => {
    if (queued) return;
    queued = true;
    events.push({ at: tau, fn: () => ((queued = false), p.refresh(["solana"])) });
  });
  // nothing in a stepped run waits on a real timer (after, the read and the API's state read are its events), so
  // microtasks settle it: a real timer turn per event made a 30 min run take 30 s
  const drained = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  p.refresh(["solana"]);
  await drained();
  let gone = 0, samples = 0, next = T0, held = false, fired = 0;
  while (tau < end) {
    events.sort((a, b) => a.at - b.at);
    const e = events[0];
    if (e && e.at <= next) {
      if (++fired > TIMERS_MAX) throw new Error(`${TIMERS_MAX} events by ${(tau - T0) / 1000} s: the page's timers never let the clock move`);
      tau = Math.max(tau, e.at);
      events.shift();
      e.fn();
      await drained();
      continue;
    }
    tau = next;
    if (p.get("solana")) held = true;
    else if (held) gone++;
    samples++;
    next += 100;
  }
  return { reads, lastS: (lastRead - T0) / 1000, gonePct: (100 * gone) / samples, pending: events.length };
}

test("at the feed's write, review P2-2: every timer run 1 ms short of its time: the chain is read on to the end, never stopped", async () => {
  const r = await stepped({ minutes: 10, shortMs: 1 });
  assert.ok(r.pending > 0, "a timer is still set at the end");
  assert.ok(r.lastS > 10 * 60 - 20, `the last read ${r.lastS} s into a 600 s run`);
  assert.equal(r.gonePct, 0, `no price ${r.gonePct}% of the time`);
});

test("at the feed's write, review P2-2: a timer that is no longer the chain's (a wake read since) leaves the newer due time as it is: no read before it", async () => {
  let reads = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const read = async (): Promise<PoolUsdPrice> => (reads++, { chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: Math.floor(h.clock.ms / 1000) - 2, source: "pyth", at: 1n });
  const h = holder({ read, after: (ms, fn) => void timers.push({ at: h.clock.ms + ms, fn }), visible: () => true });
  const t0 = h.clock.ms;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(reads, 1);
  const first = timers.at(-1)!;
  assert.equal(first.at, t0 + POOL_PRICE_REFRESH_MS, "a fresh price: read again in POOL_PRICE_REFRESH_MS");
  // shown again 5 s on: read at once, due POOL_PRICE_REFRESH_MS from then
  h.clock.ms = t0 + 5_000;
  h.p.wake();
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(reads, 2);
  // the first read's timer runs at its time: it is no longer the chain's, so the read stays due at t0 + 20 s
  h.clock.ms = first.at;
  first.fn();
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(reads, 2, "no read at the old timer's time, 5 s before the one due");
  h.clock.ms = t0 + 5_000 + POOL_PRICE_REFRESH_MS;
  timers.at(-1)!.fn();
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(reads, 3, "read at its own due time");
});

test("at the feed's write, review P2-2: a Date.now() in 16.67 ms steps (and in 100 ms steps): read on for 30 min, never stopped, never without a price", async () => {
  for (const stepMs of [16.67, 100]) {
    const r = await stepped({ minutes: 30, stepMs });
    assert.ok(r.lastS > 30 * 60 - 20, `steps of ${stepMs} ms: the last read ${r.lastS} s into the run, after ${r.reads} reads`);
    assert.equal(r.gonePct, 0, `steps of ${stepMs} ms: no price ${r.gonePct}% of the time`);
    // about a read at the write and two polls a minute, never each 100 ms
    assert.ok(r.reads / 30 < 8, `${(r.reads / 30).toFixed(1)} reads a minute`);
  }
});

test("at the feed's write, review P3: a price ahead of the device's clock as the read ends is no late feed: it backs off as a failure", async () => {
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: Math.floor(h.clock.ms / 1000) + 120, source: "pyth", at: 1n });
  const waits: number[] = [];
  const h = holder({ read, after: (ms) => void waits.push(ms), visible: () => true });
  for (let i = 0; i < 3; i++) {
    h.p.refresh(["solana"]);
    await settled();
    h.clock.ms += waits.at(-1)!;
  }
  assert.deepEqual(waits, [POOL_PRICE_RETRY_MS, 2 * POOL_PRICE_RETRY_MS, 4 * POOL_PRICE_RETRY_MS]);
  assert.equal(h.p.get("solana"), null);
});

test("at the feed's write, review P4: a PoolUsdStale with no whole publish time (none, a fraction, past 2^53) is no late feed: it backs off as a failure", async () => {
  for (const publishedS of [undefined, T + 0.5, 2 ** 53, Number.NaN]) {
    const read = async (): Promise<PoolUsdPrice> => {
      throw Object.assign(new Error("the price is older than 75 s"), { name: "PoolUsdStale", publishedS });
    };
    const waits: number[] = [];
    const h = holder({ read, after: (ms) => void waits.push(ms), visible: () => true });
    for (let i = 0; i < 3; i++) {
      h.p.refresh(["solana"]);
      await settled();
      h.clock.ms += waits.at(-1)!;
    }
    assert.deepEqual(waits, [POOL_PRICE_RETRY_MS, 2 * POOL_PRICE_RETRY_MS, 4 * POOL_PRICE_RETRY_MS], String(publishedS));
  }
  // control: a whole publish time is a late feed, read each POOL_PRICE_WRITE_POLL_MS
  const late = async (): Promise<PoolUsdPrice> => {
    throw Object.assign(new Error("the price is older than 75 s"), { name: "PoolUsdStale", publishedS: Math.floor(h.clock.ms / 1000) - 80 });
  };
  const waits: number[] = [];
  const h = holder({ read: late, after: (ms) => void waits.push(ms), visible: () => true });
  for (let i = 0; i < 3; i++) {
    h.p.refresh(["solana"]);
    await settled();
    h.clock.ms += waits.at(-1)!;
  }
  assert.deepEqual(waits, [POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_WRITE_POLL_MS, POOL_PRICE_WRITE_POLL_MS]);
});

test("at the feed's write, review P3: a read of the price already held leaves the held read as it was (its first read_ms): the state is the same, so no state event goes to the app", async () => {
  const pub = Math.floor(FX.nowMs / 1000) - 10;
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: SOL_PRICE, expo: -8, publishedS: pub, source: "pyth", at: 1n });
  const h = holder({ read, visible: () => true });
  h.p.refresh(["solana"]);
  await settled();
  const first = h.p.get("solana");
  const state = await withPools(SIGNED_IN, async () => [note], [SOL], [], h.p.get);
  h.clock.ms += POOL_PRICE_REFRESH_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(h.p.get("solana"), first, "the same object: not replaced");
  assert.deepEqual(await withPools(SIGNED_IN, async () => [note], [SOL], [], h.p.get), state, "the same state");
});

test("at the feed's write, review P3: wakeWhenShown (main.ts) wakes the prices when the document is shown again, never when it is hidden", () => {
  const doc = { visibilityState: "hidden" as DocumentVisibilityState, fn: null as null | (() => void), addEventListener(type: string, fn: () => void) {
    assert.equal(type, "visibilitychange");
    this.fn = fn;
  } };
  let woke = 0;
  wakeWhenShown(doc as unknown as Document, { wake: () => void woke++ });
  doc.fn!();
  assert.equal(woke, 0, "hidden: no wake");
  doc.visibilityState = "visible";
  doc.fn!();
  assert.equal(woke, 1, "shown: woken");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /\n {2}wakeWhenShown\(document, prices\);\n/, "main.ts wires the page's own document to its prices");
});
