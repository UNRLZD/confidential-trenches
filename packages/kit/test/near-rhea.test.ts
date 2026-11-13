// The Rhea classic quote (src/near/rhea.ts) and the token fee it counts (src/near/token-fee.ts), card near-view-rhea.
// - The math equals real mainnet swaps to the unit: each swap read back from archival RPC with the pools' state at the
//   block before its receipt (fixtures/near-rhea-swaps.json, its tx hashes).
// - The whole quote, replayed on real mainnet answers of both providers, equals the exchange's own get_return at the
//   quote's block, hop by hop (fixtures/near-rhea-quotes.json).
// - Two providers that disagree, lag or fail refuse the quote; so do a paused exchange, a frozen token, a missing pool, a
//   pool with no liquidity and a malformed row.
// test/mutants/near-rhea-mutants.test.mjs removes the fee, the rounding and each agreement check and runs the named
// test here: each must fail.
//   node --test test/near-rhea.test.ts      (from packages/kit)
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { onTestClock } from "./test-clock.ts";
import { rheaQuote, RheaQuoteRefused, type RheaRefusalCode } from "@blindfill/kit";
import { NEAR_RHEA, nearFinal, rheaSimpleOut, type RheaPool } from "../src/near/rhea.ts";
import { readNearHeld, readNearSwapPair, readNearSwapWallet } from "../src/trade/near/wallet.ts";
import { NEAR_PLAIN_TOKEN_CODES, NEAR_TOKEN_NO_FEE, nearPlainTokenFee, nearSellAmount, nearTokenFee, nearTokenFeeView } from "../src/near/token-fee.ts";

const FAST = "https://rpc.mainnet.fastnear.com";
const DRPC = "https://near.drpc.org";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WRAP = "wrap.near";
const EX = "v2.ref-finance.near";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// ---------- real swaps ----------
test("R1 the math equals real mainnet swaps to the unit, fee 0 and fee 30 pools", () => {
  const { swaps } = fixture("near-rhea-swaps.json");
  assert.ok(swaps.length >= 6);
  let fee30 = 0;
  for (const s of swaps) {
    const rows = JSON.parse(s.pools.text);
    const msg = JSON.parse(s.msg);
    const ids: number[] = [...new Set<number>(msg.actions.map((a: { pool_id: number }) => a.pool_id))];
    const pools = new Map<number, RheaPool>(ids.map((id, k) => [id, { id, tokens: rows[k].token_account_ids, amounts: rows[k].amounts.map(BigInt), feeBps: rows[k].total_fee }]));
    let x = BigInt(s.amount);
    const outs: string[] = [];
    for (const a of msg.actions) {
      const p = pools.get(a.pool_id) as RheaPool;
      if (p.feeBps > 0) fee30++;
      const out = rheaSimpleOut(p, a.token_in, a.amount_in ? BigInt(a.amount_in) : x, a.token_out);
      assert.ok(out !== null);
      outs.push(String(out));
      x = out;
    }
    const logged = s.logs.map((l: string) => l.split(" ")[4]);
    assert.deepEqual(outs, logged, `${s.tx}: the kit's amounts against the swap's own log`);
  }
  assert.ok(fee30 >= 2, "two swaps on a pool with a fee");
});

test("R2 the contract's refusals: no amount, a zero reserve, the same token, a token not in the pool", () => {
  const p: RheaPool = { id: 1, tokens: [USDC, WRAP], amounts: [10n ** 12n, 10n ** 27n], feeBps: 30 };
  assert.equal(rheaSimpleOut(p, USDC, 0n, WRAP), null);
  assert.equal(rheaSimpleOut({ ...p, amounts: [0n, 10n ** 27n] }, USDC, 1n, WRAP), null);
  assert.equal(rheaSimpleOut({ ...p, amounts: [10n ** 12n, 0n] }, USDC, 1n, WRAP), null);
  assert.equal(rheaSimpleOut(p, USDC, 1n, USDC), null);
  assert.equal(rheaSimpleOut(p, "x.near", 1n, WRAP), null);
  // floor: 1 unit in pays floor(9970·10^27 / (10^16 + 9970))
  assert.equal(rheaSimpleOut(p, USDC, 1n, WRAP), (9970n * 10n ** 27n) / (10n ** 16n + 9970n));
});

// ---------- real quotes, replayed ----------
type Logged = { url: string; params: Record<string, unknown>; answer: unknown };
function replay(log: Logged[]) {
  const key = (p: Record<string, unknown>) => JSON.stringify(p);
  return [FAST, DRPC].map((url) => ({
    name: url,
    async query(params: Record<string, unknown>) {
      const hit = log.find((l) => l.url === url && key(l.params) === key(params));
      if (!hit) throw new Error(`not recorded: ${url} ${key(params)}`);
      return hit.answer;
    },
  })) as unknown as [{ name: string; query: (p: Record<string, unknown>) => Promise<unknown> }, { name: string; query: (p: Record<string, unknown>) => Promise<unknown> }];
}

test("R3 replayed on real mainnet answers of both providers, the quote equals get_return at its block, hop by hop", async () => {
  const { runs } = fixture("near-rhea-quotes.json");
  assert.ok(runs.length >= 3);
  for (const r of runs) {
    const q = await rheaQuote({ network: "mainnet", rpcs: replay(r.log), side: r.side, token: r.token, amountIn: BigInt(r.amountIn), pools: r.pools });
    assert.equal(q.height, r.height);
    assert.deepEqual(q.hops.map((h) => String(h.amountOut)), r.getReturn, `${r.name}: each hop equals get_return`);
    assert.equal(String(q.amountOut), r.amountOut, r.name);
    // DIARHEA's real fee (nearly.trade get_tax, pinned code): 1% scoped to Rhea DCL only, so not counted on classic
    // wNEAR and RHEA run pinned plain codes, read on both providers at the quote's block: 0% and known
    if (r.token === "wrap.near" || r.token === RHEA) assert.equal(q.fee.unknown, false, r.name);
    if (r.token.endsWith(".nearlytrade.near")) assert.deepEqual([q.fee.buyBps, q.fee.scope, q.fee.unknown, q.amountOut === q.venueOut], [100, ["dclv2.ref-labs.near"], false, true]);
  }
  assert.ok(runs.some((r: { token: string }) => r.token.endsWith(".nearlytrade.near")));
});

// ---------- a world of two providers ----------
type Row = { pool_kind: string; token_account_ids: string[]; amounts: string[]; total_fee: number; shares_total_supply: string; amp: number };
const simple = (a: string, b: string, ra: bigint, rb: bigint, fee = 30): Row => ({ pool_kind: "SIMPLE_POOL", token_account_ids: [a, b], amounts: [String(ra), String(rb)], total_fee: fee, shares_total_supply: "1", amp: 0 });
const RHEA = "token.rhealab.near";
type World = {
  height: number;
  hash: string;
  state: string;
  frozen: string[];
  pools: Record<number, Row>;
  views: Record<string, unknown>;
  failed: Record<string, string>;
  codes: Record<string, string>;
};
function world(): World {
  return {
    height: 224_000_000,
    hash: "Hash1111111111111111111111111111111111111111",
    state: "Running",
    frozen: [],
    pools: { 4512: simple(USDC, WRAP, 1_100_000_000_000n, 230_000n * 10n ** 24n), 6458: simple(RHEA, WRAP, 7_600_000n * 10n ** 18n, 132_000n * 10n ** 24n), 9: simple(USDC, RHEA, 50_000_000n, 500n * 10n ** 18n, 100) },
    views: {},
    failed: {},
    codes: {},
  };
}
type Tweak = (name: string, params: Record<string, unknown>, answer: Record<string, unknown>) => unknown;
const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
function pair(w: World, tweak?: Tweak, lagB = 0) {
  return [FAST, DRPC].map((name) => ({
    name,
    async query(params: Record<string, unknown>) {
      const height = "finality" in params ? w.height + (name === DRPC ? lagB : 0) : (params.block_id as number);
      const base = { block_height: height, block_hash: height === w.height ? w.hash : `Other${height}` };
      let answer: Record<string, unknown>;
      if (params.request_type === "view_account") {
        answer = { jsonrpc: "2.0", id: "1", result: { ...base, amount: "1", locked: "0", code_hash: w.codes[params.account_id as string] ?? "11111111111111111111111111111111", storage_usage: 1, storage_paid_at: 0 } };
      } else {
        const method = `${params.account_id}.${params.method_name}`;
        const args = JSON.parse(atob(params.args_base64 as string));
        let value: unknown;
        let error: string | undefined = w.failed[method];
        if (method === `${EX}.metadata`) value = { version: "1.9.21", state: w.state, wnear_id: WRAP };
        else if (method === `${EX}.get_frozenlist_tokens`) value = w.frozen;
        else if (method === `${EX}.get_pool_by_ids`) {
          const ids = args.pool_ids as number[];
          if (ids.some((i) => !(i in w.pools))) error = "wasm execution failed with error: HostError(GuestPanic { panic_msg: \"panicked at 'E85: invalid pool id', ref-exchange/src/views.rs:404:33\" })";
          else value = ids.map((i) => w.pools[i]);
        } else if (method in w.views) value = w.views[method];
        else error ??= "wasm execution failed with error: MethodResolveError(MethodNotFound)";
        answer = { jsonrpc: "2.0", id: "1", result: error ? { ...base, error, logs: [] } : { ...base, logs: [], result: bytes(value) } };
      }
      return tweak ? tweak(name, params, answer) : answer;
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
}
const buy = (w: World, o: Partial<Parameters<typeof rheaQuote>[0]> = {}, tweak?: Tweak, lagB = 0) => rheaQuote({ network: "mainnet", rpcs: pair(w, tweak, lagB), side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9], ...o });
async function refused(p: Promise<unknown>, code: RheaRefusalCode, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RheaQuoteRefused, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("Q1 a quote of the world: the better of direct and through wNEAR, the contract's math on each hop", async () => {
  const w = world();
  const q = await buy(w);
  const p = (id: number) => ({ id, tokens: w.pools[id]!.token_account_ids as [string, string], amounts: w.pools[id]!.amounts.map(BigInt) as [bigint, bigint], feeBps: w.pools[id]!.total_fee });
  const direct = rheaSimpleOut(p(9), USDC, 1_000_000n, RHEA) as bigint;
  const mid = rheaSimpleOut(p(4512), USDC, 1_000_000n, WRAP) as bigint;
  const via = rheaSimpleOut(p(6458), WRAP, mid, RHEA) as bigint;
  assert.ok(via !== direct);
  assert.equal(q.amountOut, via > direct ? via : direct);
  assert.equal(q.hops.length, via > direct ? 2 : 1);
  assert.equal(q.height, w.height);
  assert.equal(q.exchange, EX);
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.hops));
  // a sell runs the other way
  const s = await rheaQuote({ network: "mainnet", rpcs: pair(w), side: "sell", token: RHEA, amountIn: 10n ** 18n, pools: [4512, 6458] });
  assert.deepEqual(s.hops.map((h) => [h.pool, h.tokenIn, h.tokenOut]), [[6458, RHEA, WRAP], [4512, WRAP, USDC]]);
});

test("Q2 the providers must agree: other bytes, another block hash, a failed view on one, one answer at another height", async () => {
  const w = world();
  // one reserve one unit apart on dRPC
  await refused(buy(w, {}, (name, p, a) => {
    if (name !== DRPC || p.method_name !== "get_pool_by_ids" || !("block_id" in p)) return a;
    const r = (a as { result: { result: number[] } }).result;
    const rows = JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
    rows[0].amounts[0] = String(BigInt(rows[0].amounts[0]) + 1n);
    return { ...a, result: { ...r, result: bytes(rows) } };
  }), "disagree", /differ/);
  await refused(buy(w, {}, (name, p, a) => (name === DRPC && "block_id" in p ? { ...a, result: { ...(a.result as object), block_hash: "Fork" } } : a)), "disagree", /two blocks/);
  await refused(buy(w, {}, (name, p, a) => (name === DRPC && p.method_name === "get_frozenlist_tokens" ? { ...a, result: { block_height: w.height, block_hash: w.hash, error: "boom", logs: [] } } : a)), "disagree");
  await refused(buy(w, {}, (name, p, a) => (name === FAST && p.method_name === "get_pool_by_ids" ? { ...a, result: { ...(a.result as object), block_height: w.height + 1 } } : a)), "rpc", /not at block/);
});

test("Q3 a lagging provider refuses past 3 blocks; within them the quote reads the lower height", async () => {
  const w = world();
  const ok = await buy(w, {}, undefined, 3);
  assert.equal(ok.height, w.height);
  await refused(buy(w, {}, undefined, 4), "lag");
});

test("Q4 a provider that fails, answers a JSON-RPC error, or answers too much refuses", async () => {
  const w = world();
  await refused(buy(w, {}, (name, _p, a) => { if (name === DRPC) throw new Error("socket hang up"); return a; }), "rpc", /socket hang up/);
  await refused(buy(w, {}, (name, _p, a) => (name === FAST ? { jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded" } } : a)), "rpc", /Rate limits/);
  await refused(buy(w, {}, (_n, p, a) => (p.method_name === "get_pool_by_ids" ? { ...a, result: { ...(a.result as object), result: new Array(70_000).fill(32) } } : a)), "rpc");
  await refused(buy(w, {}, (_n, p, a) => (p.method_name === "metadata" ? { ...a, result: { ...(a.result as object), result: [255, 254] } } : a)), "rpc");
});

test("Q5 a paused exchange, a frozen token, a missing pool, no liquidity, no simple pool: each refuses", async () => {
  await refused(buy({ ...world(), state: "Paused" }), "paused");
  await refused(buy({ ...world(), frozen: [RHEA] }), "frozen");
  await refused(buy({ ...world(), frozen: [USDC] }), "frozen");
  await refused(buy(world(), { pools: [4512, 6458, 777] }), "no-pool", /E85/);
  const empty = world();
  empty.pools = { 9: simple(USDC, RHEA, 0n, 500n * 10n ** 18n) };
  await refused(buy(empty, { pools: [9] }), "liquidity");
  const dry = world();
  dry.pools = { 9: simple(USDC, RHEA, 50_000_000n, 0n) };
  await refused(buy(dry, { pools: [9] }), "liquidity");
  // every other kind of pool is never priced by the simple pool's formula, even with good reserves
  for (const kind of ["STABLE_SWAP", "RATED_SWAP", "DEGEN_SWAP"]) {
    const other = world();
    other.pools = { 9: { ...simple(USDC, RHEA, 50_000_000n, 500n * 10n ** 18n), pool_kind: kind } };
    await refused(buy(other, { pools: [9] }), "no-pool");
  }
  // a frozen wNEAR leaves only the direct pool
  const q = await buy({ ...world(), frozen: [WRAP] });
  assert.equal(q.hops.length, 1);
});

test("Q6 a malformed pool row refuses", async () => {
  for (const bad of [{ total_fee: 10_000 }, { total_fee: 1.5 }, { token_account_ids: [USDC, RHEA, WRAP], amounts: ["1", "1", "1"] }, { token_account_ids: [USDC, USDC] }, { amounts: ["1", "-1"] }, { amounts: ["1", String(1n << 128n)] }, { amounts: ["01", "1"] }, { token_account_ids: [USDC, "Bad Token"] }]) {
    const w = world();
    w.pools[9] = { ...w.pools[9]!, ...bad } as Row;
    await refused(buy(w), "pool", undefined);
  }
});

test("Q7 the input: the network's pair only, a u128 above 0, a NEAR account other than USDC, 1 to 32 distinct pools", async () => {
  const w = world();
  const two = pair(w);
  await refused(rheaQuote({ network: "mainnet", rpcs: [two[0], { ...two[0], name: "https://rpc.mainnet.near.org" }] as unknown as typeof two, side: "buy", token: RHEA, amountIn: 1n, pools: [9] }), "input");
  await refused(rheaQuote({ network: "testnet", rpcs: two, side: "buy", token: RHEA, amountIn: 1n, pools: [9] }), "input");
  await refused(buy(w, { amountIn: 0n }), "input");
  await refused(buy(w, { amountIn: 1n << 128n }), "input");
  await refused(buy(w, { token: USDC }), "input");
  await refused(buy(w, { token: "Not An Account" }), "input");
  await refused(buy(w, { pools: [] }), "input");
  await refused(buy(w, { pools: [9, 9] }), "input");
  await refused(buy(w, { pools: Array.from({ length: 33 }, (_, i) => i) }), "input");
  await refused(buy(w, { pools: [-1] }), "input");
  await refused(buy(w, { side: "swap" as "buy" }), "input");
});

// ---------- the token's own fee ----------
const NEARPAID_CODE = "ALZF4JurwxqkfB8aktDiSkFxggh4Ec5EpdaU9CfVKTNg";
const NEARLY_CODE = "Cct6RbLZAEs5WmKkPFr4qqTAWKKzPhE4aTJHVwNLeGBS";
const NEARLY_UNTAXED_CODE = "B6EjqsNJXfQXYX1KkUaypN8z7KpYcBrf9JNwTVtWUUBY";

test("F1 a fee on every transfer: a buy delivers less than the exchange paid, a sell gives the exchange less", async () => {
  const T = "cat.nearpaid.near";
  const w = world();
  w.pools = { 4512: w.pools[4512]!, 20: simple(T, WRAP, 10n ** 24n, 10n ** 26n) };
  w.codes[T] = NEARPAID_CODE;
  w.views[`${T}.tax_info`] = { buy_bps: 500, sell_bps: 700 };
  const b = await buy(w, { token: T, pools: [4512, 20] });
  assert.equal(b.amountOut, (b.venueOut * 9500n) / 10_000n);
  assert.equal(b.fee.unknown, false);
  const s = await rheaQuote({ network: "mainnet", rpcs: pair(w), side: "sell", token: T, amountIn: 10n ** 20n, pools: [4512, 20] });
  assert.equal(s.venueIn, (10n ** 20n * 9300n) / 10_000n);
  assert.equal(s.hops[0]!.amountIn, s.venueIn);
  assert.equal(s.amountOut, s.venueOut);
});

test("F2 a fee scoped to another venue is not counted on Rhea classic; one that names it is", async () => {
  const T = "dog.nearlytrade.near";
  const w = world();
  w.pools = { 4512: w.pools[4512]!, 20: simple(T, WRAP, 10n ** 24n, 10n ** 26n) };
  w.codes[T] = NEARLY_CODE;
  w.views[`${T}.get_tax`] = { tax: { buy_bps: 300, sell_bps: 300, pairs: ["dclv2.ref-labs.near"], exempt: [] } };
  const off = await buy(w, { token: T, pools: [4512, 20] });
  assert.equal(off.amountOut, off.venueOut);
  w.views[`${T}.get_tax`] = { tax: { buy_bps: 300, sell_bps: 300, pairs: [EX], exempt: [] } };
  const on = await buy(w, { token: T, pools: [4512, 20] });
  assert.equal(on.amountOut, (on.venueOut * 9700n) / 10_000n);
  w.views[`${T}.get_tax`] = { tax: { buy_bps: 300, sell_bps: 300, pairs: [EX], exempt: [EX] } };
  const exempt = await buy(w, { token: T, pools: [4512, 20] });
  assert.equal(exempt.amountOut, exempt.venueOut);
});

test("F3 a fee that cannot be read with certainty is counted 0% and marked unknown; pinned code with no fee view is 0%", async () => {
  const T = "dog.nearlytrade.near";
  const w = world();
  w.pools = { 4512: w.pools[4512]!, 20: simple(T, WRAP, 10n ** 24n, 10n ** 26n) };
  w.codes[T] = "UnpinnedCode1111111111111111111111111111111";
  w.views[`${T}.get_tax`] = { tax: { buy_bps: 300, sell_bps: 300, pairs: [EX], exempt: [] } };
  const unpinned = await buy(w, { token: T, pools: [4512, 20] });
  assert.equal(unpinned.fee.unknown, true);
  assert.equal(unpinned.amountOut, unpinned.venueOut, "a rate read from code that is not pinned is counted 0%, as the terminal does");
  w.views[`${T}.get_tax`] = { tax: "garbled" };
  w.codes[T] = NEARLY_CODE;
  const garbled = await buy(w, { token: T, pools: [4512, 20] });
  assert.deepEqual([garbled.fee.unknown, garbled.amountOut === garbled.venueOut], [true, true]);
  delete w.views[`${T}.get_tax`];
  w.codes[T] = NEARLY_UNTAXED_CODE;
  const none = await buy(w, { token: T, pools: [4512, 20] });
  assert.deepEqual([none.fee.unknown, none.amountOut === none.venueOut], [false, true]);
  // a token under no listed launchpad reads no fee view at all
  assert.equal(nearTokenFeeView(RHEA), null);
  assert.equal(nearTokenFeeView("x.nearpaid.near")?.method, "tax_info");
  // the sender pays nucleus's fee on top: the exchange receives all that is sent
  const n = nearTokenFee("nucleus", "AcUSSxMmqbBmACUrThokZaYWHi3MaNXRStqbcC7mtaZz", { value: [400, EX, []] });
  assert.deepEqual([n.senderPays, n.sellBps, n.unknown], [true, 400, false]);
  // Hoot rounds pips up to whole bps
  assert.equal(nearTokenFee("hoot", "9afh213xddvqMpmz3sZXDwtvJ19hkTsQwFhpNEmrq8QN", { value: { transfer_fee_pips: 10_001, dcl_exchange_id: "dclv2.ref-labs.near" } }).buyBps, 101);
});

test("F5 a sender-pays fee on Rhea sizes a sell so the amount and its fee fit the balance; elsewhere the whole balance", () => {
  const n = nearTokenFee("nucleus", "AcUSSxMmqbBmACUrThokZaYWHi3MaNXRStqbcC7mtaZz", { value: [700, EX, []] });
  assert.equal(nearSellAmount(n, EX, 10_000n), 9_345n); // floor(10,000 x 10,000 / 10,700): 9,345 + 7% = 9,999.15
  assert.ok(nearSellAmount(n, EX, 10n ** 24n) * 10_700n <= 10n ** 24n * 10_000n);
  assert.equal(nearSellAmount(n, "dclv2.ref-labs.near", 10_000n), 10_000n);
  const paid = nearTokenFee("nearpaid", NEARPAID_CODE, { value: { buy_bps: 500, sell_bps: 700 } });
  assert.equal(nearSellAmount(paid, EX, 10_000n), 10_000n, "a receiver-pays fee comes off what the exchange gets, not the balance");
  assert.equal(nearSellAmount(NEAR_TOKEN_NO_FEE, EX, 10_000n), 10_000n);
});

test("F6 a token under no listed launchpad: 0% only for a pinned plain code, read alike on both providers at the quote's block; else marked unknown", async () => {
  const plain = world();
  plain.codes[RHEA] = "3XbB1xkQTNFhtizVSCNW5xM9MyuF3AYhFKc8HAPc3pdx";
  const known = await buy(plain);
  assert.deepEqual([known.fee.unknown, known.amountOut === known.venueOut], [false, true]);
  const other = world();
  other.codes[RHEA] = "UnpinnedCode1111111111111111111111111111111";
  const flagged = await buy(other);
  assert.deepEqual([flagged.fee.unknown, flagged.amountOut === flagged.venueOut], [true, true]);
  // one provider alone never decides pinned or unknown: another code hash, or its code read at another block
  await refused(buy(plain, {}, (name, p, a) => (name === DRPC && p.request_type === "view_account" ? { ...a, result: { ...(a.result as object), code_hash: "UnpinnedCode1111111111111111111111111111111" } } : a)), "disagree", /code hashes/);
  await refused(buy(plain, {}, (name, p, a) => (name === DRPC && p.request_type === "view_account" ? { ...a, result: { ...(a.result as object), block_height: plain.height - 1 } } : a)), "rpc", /not at block/);
  await refused(buy(plain, {}, (_n, p, a) => (p.request_type === "view_account" ? { ...a, result: { ...(a.result as object), block_height: plain.height - 1 } } : a)), "rpc", /not at block/);
  assert.equal(nearPlainTokenFee(null).unknown, true);
  assert.ok(Object.isFrozen(NEAR_PLAIN_TOKEN_CODES));
});

test("F4 the exchange and wNEAR ids per network are the UNRLZD trading terminal's venue facts", () => {
  assert.deepEqual(NEAR_RHEA, { mainnet: { exchange: "v2.ref-finance.near", wrap: "wrap.near" }, testnet: { exchange: "ref-finance-101.testnet", wrap: "wrap.testnet" } });
});

// ---------- the two final heights, of one moment (card near-quote-under-the-pace) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One provider on a chain that moves a block every BLOCK_MS: its "final" is the chain's tip less `behind`; each query
 *  waits `turnMs` for the provider's turn first (a paced provider), and its reserve() waits for that turn once and gives
 *  back a sender that asks at once. */
const BLOCK_MS = 20;
function clocked(w: World, behind: readonly [number, number], turnMs: readonly [number, number]) {
  const t0 = performance.now();
  const tip = () => w.height + Math.floor((performance.now() - t0) / BLOCK_MS);
  return pair(w).map((r, i) => {
    const at = (p: Record<string, unknown>) => {
      if (!("finality" in p)) return p;
      const { finality: _f, ...q } = p;
      return { ...q, block_id: tip() - behind[i]! };
    };
    const now = { name: r.name, query: (p: Record<string, unknown>, s?: AbortSignal) => r.query(at(p), s) };
    const turn = turnMs[i]!;
    return {
      name: r.name,
      async query(p: Record<string, unknown>, s?: AbortSignal) {
        await sleep(turn);
        return now.query(p, s);
      },
      ...(turn > 0 ? { reserve: async () => (await sleep(turn), now) } : {}),
    };
  }) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
}

test("Q8 the two final heights are of one moment: a provider's wait for its turn is never read as lag; a real lag still refuses", () => onTestClock(async () => {
  const w = world();
  // FastNEAR's turn 6 blocks off, dRPC's at once: both turns are taken before either height is asked
  const q = await rheaQuote({ network: "mainnet", rpcs: clocked(w, [0, 0], [6 * BLOCK_MS, 0]), side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9] });
  assert.ok(q.height >= w.height);
  // a provider 6 blocks behind the chain, its turn at once: the chain's lag, refused
  await refused(rheaQuote({ network: "mainnet", rpcs: clocked(w, [0, 6], [0, 0]), side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9] }), "lag");
}));

// ---------- W and the quote at one block (card near-quote-under-the-pace) ----------
const WID = "0".repeat(64);
function walletWorld(): World {
  const w = world();
  w.views[`${USDC}.ft_balance_of`] = "5000000";
  w.views[`${RHEA}.ft_balance_of`] = "7";
  w.views[`${RHEA}.storage_balance_of`] = null;
  w.views[`${RHEA}.storage_balance_bounds`] = { min: "1250000000000000000000", max: null };
  w.views[`${EX}.get_lostfound_token`] = "0";
  return w;
}
/** The world's pair, W's key list answered, every query counted per provider and per kind ("final" or the method). */
/** The world's pair with W's key list answered (W's own implicit key, nonce 40). */
function withKeys(w: World, tweak?: Tweak) {
  return pair(w, tweak).map((r) => ({
    name: r.name,
    async query(p: Record<string, unknown>, s?: AbortSignal) {
      if (p.request_type !== "view_access_key_list") return r.query(p, s);
      const height = "finality" in p ? w.height : (p.block_id as number);
      return { jsonrpc: "2.0", id: "1", result: { block_height: height, block_hash: height === w.height ? w.hash : `Other${height}`, keys: [{ public_key: `ed25519:${"1".repeat(32)}`, access_key: { nonce: 40, permission: "FullAccess" } }] } };
    },
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
}
/** withKeys, every query counted per provider and per kind ("final" or the method). */
function countedPair(w: World) {
  const asked: { name: string; what: string }[] = [];
  const rpcs = withKeys(w).map((r) => ({
    name: r.name,
    query: (p: Record<string, unknown>, s?: AbortSignal) => (asked.push({ name: r.name, what: "finality" in p ? "final" : String(p.method_name ?? p.request_type) }), r.query(p, s)),
  })) as unknown as Parameters<typeof rheaQuote>[0]["rpcs"];
  return { rpcs, asked };
}

test("P1 W and the quote at one block: one final height on each provider, then both reads at it, the baseline too", async () => {
  const w = walletWorld();
  const { rpcs, asked } = countedPair(w);
  const p = await readNearSwapPair({ network: "mainnet", rpcs, wallet: WID, side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9], baseline: RHEA });
  assert.equal(p.state.height, p.quote.height);
  assert.equal(p.state.blockHash, p.quote.blockHash);
  assert.equal(p.baseline, 7n);
  assert.equal(p.state.held, 5_000_000n);
  for (const name of [FAST, DRPC]) {
    const mine = asked.filter((x) => x.name === name);
    assert.equal(mine.filter((x) => x.what === "final").length, 1, `${name}: one final height for the pair`);
    // W: keys, ft_balance_of, storage_balance_of, storage_balance_bounds, get_lostfound_token; the quote: metadata,
    // get_frozenlist_tokens, get_pool_by_ids, view_account; the baseline: ft_balance_of
    assert.equal(mine.length, 11, `${name}: ${JSON.stringify(mine.map((x) => x.what))}`);
  }
});

test("P2 a final height no nearFinal read on these providers is refused; another block in one of the pair's reads is refused", async () => {
  const w = walletWorld();
  const { rpcs } = countedPair(w);
  const forged = Object.freeze({ network: "mainnet" as const, height: w.height - 500 });
  await refused(rheaQuote({ network: "mainnet", rpcs, side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9], final: forged }), "input", /nearFinal/);
  await refused(readNearSwapWallet({ network: "mainnet", rpcs, wallet: WID, side: "buy", token: RHEA, final: forged }), "input", /nearFinal/);
  const other = countedPair(w).rpcs;
  const f = await nearFinal("mainnet", other);
  await refused(rheaQuote({ network: "mainnet", rpcs, side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9], final: f }), "input", /nearFinal/);
  // the same final for both reads, one provider answering W's balance at another block hash
  const forked = withKeys(w, (name, p, a) => (name === DRPC && p.method_name === "ft_balance_of" ? { ...a, result: { ...(a.result as object), block_hash: "Fork" } } : a));
  await refused(readNearSwapPair({ network: "mainnet", rpcs: forked, wallet: WID, side: "buy", token: RHEA, amountIn: 1_000_000n, pools: [4512, 6458, 9] }), "disagree");
});

test("P3 what W holds and its registration, read alone: one final and one or two views on each provider, equal on both", async () => {
  const w = walletWorld();
  const { rpcs, asked } = countedPair(w);
  const h = await readNearHeld({ network: "mainnet", rpcs, wallet: WID, token: USDC, on: RHEA });
  assert.deepEqual([h.held, h.registered, h.height], [5_000_000n, false, w.height]);
  assert.equal(asked.length, 6);
  const only = await readNearHeld({ network: "mainnet", rpcs, wallet: WID, token: RHEA });
  assert.deepEqual([only.held, "registered" in only], [7n, false]);
  await refused(readNearHeld({ network: "mainnet", rpcs: pair(w, (name, p, a) => (name === DRPC && p.method_name === "ft_balance_of" ? { ...a, result: { ...(a.result as { result: number[] }), result: bytes("8") } } : a)), wallet: WID, token: RHEA }), "disagree");
});
