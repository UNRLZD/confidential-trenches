// One quote per ask (src/dry-join.ts), card dry-ask-joins-the-running-quote.
//   node --test test/dry-join.test.ts      (from packages/signpage)
// The buy box asks pool.buy.dry again once the kit's client gives up on it (10 s, packages/kit/src/signpage/client.ts),
// and each ask started a new quote on the same paced reads (NEAR: 148 seat reads for one coin, then "down"). A dry whose
// params match a running one exactly joins it: one quote runs and every asker gets its answer under its own request id
// (src/api.ts keeps ids apart). Any field that differs starts its own quote. Once the run settles the next ask starts
// fresh: no answer is served from memory. src/main.ts puts the join at the kinds map, above the routing to every chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dryKey, joinRunning } from "../src/dry-join.ts";
import { startApi, type HostAnswer, type HostRefusal, type IncomingMessage, type Running } from "../src/api.ts";
import { signedOutState } from "../src/api.ts";

const ORIGIN = "https://ct-app.unrealized.trade";
type Dry = HostAnswer<"pool.buy.dry"> | HostRefusal;

/** A router as main.ts's dryWithCash: a run per call, each settled by the test; the calls it got. */
function router() {
  const runs: { params: Record<string, unknown>; settle(a: Dry): void; fail(): void }[] = [];
  const route = (params: Record<string, unknown>): Running<"pool.buy.dry"> => {
    let answer: Dry = { error: "failed" };
    let settle!: (a: Dry) => void;
    let fail!: () => void;
    const after = new Promise<void>((ok, no) => {
      settle = (a) => ((answer = a), ok());
      fail = () => no(new Error("read failed"));
    });
    runs.push({ params, settle, fail });
    return { running: true, after, answer: () => answer };
  };
  return { runs, route };
}

/** The page's API with `kinds`: send a request, read the answer posted for an id. */
function page(kinds: Parameters<typeof startApi>[0]["kinds"]) {
  const posted: Record<string, unknown>[] = [];
  const parent = { postMessage: (m: unknown) => void posted.push(m as Record<string, unknown>) };
  let listener: (e: IncomingMessage) => void = () => {};
  const api = startApi({ parent, listen: (fn) => (listener = fn), state: () => signedOutState(), kinds });
  const ask = (type: string, params: Record<string, unknown>, id = crypto.randomUUID()) => (listener({ origin: ORIGIN, source: parent, data: { v: 1, id, type, ...params } }), id);
  const answerOf = (id: string) => posted.find((m) => m.id === id && "ok" in m);
  return { ask, answerOf, posted, idle: () => api.idle() };
}
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
const SOL = "So11111111111111111111111111111111111111112";
const COIN: Record<string, string> = { solana: SOL, base: "0x4200000000000000000000000000000000000006", robinhood: "0x0000000000000000000000000000000000000001", near: "token.rhealab.near" };
const result = (tap: string) => ({ result: { tap_max: tap } }) as Dry;

for (const chain of ["solana", "base", "robinhood", "near"]) {
  test(`${chain}: two asks for the same coin and amount make one quote, both answered under their own ids`, async () => {
    const r = router();
    const p = page({ "pool.buy.dry": joinRunning(r.route) });
    const params = { chain, token: COIN[chain], amount: "0.1" };
    const a = p.ask("pool.buy.dry", params);
    await p.idle();
    const b = p.ask("pool.buy.dry", params); // the box's ask again, 10 s on, under a new id
    await p.idle();
    assert.equal(r.runs.length, 1, "one quote runs");
    r.runs[0]!.settle(result("7"));
    await until(() => p.answerOf(a) !== undefined && p.answerOf(b) !== undefined, "both answers");
    assert.deepEqual(p.answerOf(a), { v: 1, id: a, ok: true, result: { tap_max: "7" } });
    assert.deepEqual(p.answerOf(b), { v: 1, id: b, ok: true, result: { tap_max: "7" } });
    assert.equal(r.runs.length, 1);
  });
}

test("a different amount, coin or chain, or an amount left out, starts its own quote", async () => {
  const r = router();
  const p = page({ "pool.buy.dry": joinRunning(r.route) });
  const base = { chain: "solana", token: SOL, amount: "0.1" };
  for (const params of [base, { ...base, amount: "0.2" }, { ...base, amount: "0.10" }, { ...base, token: COIN.base }, { ...base, chain: "base" }, { chain: "solana", token: SOL }]) p.ask("pool.buy.dry", params);
  await p.idle();
  assert.equal(r.runs.length, 6, "six asks that differ, six quotes");
});

test("pool.sell.dry: any field of the payload that differs (amount, share, slippage) starts its own quote; the same joins", async () => {
  const r = router();
  const p = page({ "pool.sell.dry": joinRunning(r.route) as never });
  const sell = { chain: "solana", token: SOL, amount: "5", slippage_bps: 300 };
  for (const params of [sell, sell, { ...sell, slippage_bps: 301 }, { chain: "solana", token: SOL, share_bps: 5000, slippage_bps: 300 }, { ...sell, amount: "6" }]) p.ask("pool.sell.dry", params);
  await p.idle();
  assert.equal(r.runs.length, 4, "the repeat joined; the three that differ ran");
});

test("the key holds every field exactly and in any order: equal payloads share one, any difference does not", () => {
  assert.equal(dryKey({ chain: "base", token: "t", amount: "1" }), dryKey({ amount: "1", token: "t", chain: "base" }));
  for (const other of [{ chain: "base", token: "t", amount: "1.0" }, { chain: "base", token: "T", amount: "1" }, { chain: "base", token: "t" }, { chain: "base", token: "t", amount: "1", with: true }, { chain: "base", token: "t", amount: 1 }]) assert.notEqual(dryKey({ chain: "base", token: "t", amount: "1" }), dryKey(other as Record<string, unknown>), JSON.stringify(other));
});

test("an ask after the running quote ended starts a new quote and gets the new answer, never the finished one", async () => {
  const r = router();
  const p = page({ "pool.buy.dry": joinRunning(r.route) });
  const params = { chain: "near", token: COIN.near, amount: "1" };
  const a = p.ask("pool.buy.dry", params);
  await p.idle();
  r.runs[0]!.settle(result("1"));
  await until(() => p.answerOf(a) !== undefined, "the first answer");
  const b = p.ask("pool.buy.dry", params);
  await p.idle();
  assert.equal(r.runs.length, 2, "a fresh quote");
  r.runs[1]!.settle(result("2"));
  await until(() => p.answerOf(b) !== undefined, "the second answer");
  assert.deepEqual(p.answerOf(b), { v: 1, id: b, ok: true, result: { tap_max: "2" } });
});

test("a refusal, or a run that throws, reaches every joined asker; a 'not now' refusal lets the next ask run again", async () => {
  const r = router();
  const p = page({ "pool.buy.dry": joinRunning(r.route) });
  const params = { chain: "near", token: COIN.near, amount: "1" };
  const ids = [p.ask("pool.buy.dry", params), p.ask("pool.buy.dry", params), p.ask("pool.buy.dry", params)];
  await p.idle();
  assert.equal(r.runs.length, 1);
  r.runs[0]!.settle({ error: "down" });
  await until(() => ids.every((id) => p.answerOf(id) !== undefined), "three refusals");
  for (const id of ids) assert.deepEqual(p.answerOf(id), { v: 1, id, ok: false, error: { code: "down" } });
  const more = [p.ask("pool.buy.dry", params), p.ask("pool.buy.dry", params)];
  await p.idle();
  assert.equal(r.runs.length, 2);
  r.runs[1]!.fail();
  await until(() => more.every((id) => p.answerOf(id) !== undefined), "two answers after a throw");
  for (const id of more) assert.deepEqual(p.answerOf(id), { v: 1, id, ok: false, error: { code: "failed" } });
});

test("ids stay api.ts's: the same id again joins nothing new and runs nothing; the same id with another body is id_reused", async () => {
  const r = router();
  const p = page({ "pool.buy.dry": joinRunning(r.route) });
  const params = { chain: "solana", token: SOL, amount: "0.1" };
  const id = p.ask("pool.buy.dry", params);
  p.ask("pool.buy.dry", params, id);
  p.ask("pool.buy.dry", { ...params, amount: "0.2" }, id);
  await p.idle();
  assert.equal(r.runs.length, 1);
  assert.deepEqual(p.answerOf(id), { v: 1, id, ok: false, error: { code: "id_reused" } }, "the other body is refused under that id at once");
  r.runs[0]!.settle(result("3"));
  await until(() => p.posted.filter((m) => m.id === id && m.ok === true).length === 1, "the one answer for the id");
});

test("a refusal given at once (no run: NEAR busy while a trade runs) is passed through and joins nothing", () => {
  let calls = 0;
  const join = joinRunning((_params: Record<string, unknown>): HostRefusal => (calls++, { error: "busy" }));
  assert.deepEqual(join({ chain: "near", token: "t" }), { error: "busy" });
  assert.deepEqual(join({ chain: "near", token: "t" }), { error: "busy" });
  assert.equal(calls, 2);
});

test("main.ts: the buy and sell dries join at the kinds map, above the routing to every chain", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(/"pool\.buy\.dry": joinRunning\(\(params\) => dryWithCash\(params\)\),/.test(src), "pool.buy.dry joins before dryWithCash routes it (NEAR, Base, Robinhood, Solana)");
  assert.ok(/"pool\.sell\.dry": joinRunning\(\(params\) => poolSellDry\(params\)\),/.test(src), "pool.sell.dry joins too");
  assert.equal((src.match(/joinRunning\(/g) ?? []).length, 2, "made once each, in the one kinds map");
});
