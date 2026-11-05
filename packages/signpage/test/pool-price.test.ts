// The page's own USD price per pool chain (card signpage-pool-price, src/pool-price.ts): read with the kit's
// poolUsdPrice on two RPCs of two providers, held only within the feed's bound, read again while a pool shows, and
// added to state.pools by withPools. The reads replay the kit's recorded answers (../../kit/test/fixtures/pool-usd.json:
// Pyth's SOL/USD account on two Solana RPCs, Chainlink's ETH/USD on two Base RPCs), one thing planted per case.
//   node --test test/pool-price.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { POOL_USD_FEEDS, type PoolUsdArgs, type PoolUsdPrice } from "../../kit/src/price/pool-usd.ts";
import { SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { BalancePool } from "../../wallet/src/pool/balances.ts";
import { POOL_PRICE_REFRESH_MS, POOL_PRICE_RETRY_AFTER_MAX_MS, POOL_PRICE_RETRY_MS, poolPrices, type PoolPriceDeps } from "../src/pool-price.ts";
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
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
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

test("retry: a read whose price is past its bound as it ends is a failure: read again in POOL_PRICE_RETRY_MS, the last good price kept", async () => {
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
  // the next read answers a price 64 s old (the kit's own bound is 60 s)
  ageS = maxS + 4;
  h.clock.ms += POOL_PRICE_REFRESH_MS;
  h.p.refresh(["solana"]);
  await settled();
  assert.equal(waits.at(-1), POOL_PRICE_RETRY_MS, "a failure: read again soon");
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

test("a clock behind the feed never stretches the bound: a price stamped 60 s ahead of its read is dropped 61 s after the read (review L2)", async () => {
  const readMs = FX.nowMs;
  const read = async (): Promise<PoolUsdPrice> => ({ chain: "solana", asset: "SOL", decimals: 9, price: 1n, expo: 0, publishedS: Math.floor(readMs / 1000) + 60, source: "pyth", at: 1n });
  const h = holder({ read });
  h.p.refresh(["solana"]);
  await settled();
  h.clock.ms = Math.floor(readMs / 1000) * 1000 + 60_000;
  assert.notEqual(h.p.get("solana"), null, "60 s after the read: held");
  h.clock.ms = readMs + 61_000;
  assert.equal(h.p.get("solana"), null, "61 s after the read: dropped");
});
