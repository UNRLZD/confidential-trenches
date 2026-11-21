// card evm-warm-tap-ends-inside-two-seconds, round (F): a stand-in is asked for a post out past its provider's hedge
// time, and that time runs from the post's send, past the device's gate and the provider's pace (a post queued there is
// not late), against the 95th percentile of the provider's answers of the post's own kind (a head, or a batch of its
// size). Round (E)'s A/B (2026-11-21 15:27-15:44Z): ANTc's 40-post warm rounds drew stand-ins on mainnet.base.org and
// Pocket, and Base's warm taps over 2 s went from 1 in 62 to 3 in 62. Each provider answers after its own delay on the
// test's clock (test-clock.ts), so each time is exact.
//   node --test test/evm-hedge-clock.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmAgreeing, evmProviders, evmSpeedReset, type EvmGated, type EvmRpc } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { onTestClock } from "./test-clock.ts";
import { untilAborted } from "../src/abort.ts";

const v = evmPoolVenues().base;
const [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET] = v.providers!;
const head = [{ method: "eth_getBlockByNumber", params: ["latest", false] }];
const call = (n: number) => Array.from({ length: n }, (_, i) => ({ method: "eth_call", params: [{ to: "0x" + "1".repeat(40), data: "0x" + i.toString(16).padStart(2, "0") }, "latest"] }));

/** Base's providers on the test clock: each post answered `ms(url, calls)` after it leaves the device, or as `plan`
 *  says for that provider's next post ("hang": until its signal ends it, the 10 s timeout; a number: failed that many
 *  ms after it is sent). Posts counted per provider. */
function providers(ms: (url: string, calls: { method: string }[]) => number) {
  const posts = new Map<string, number>();
  const plan = new Map<string, ("hang" | number)[]>();
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    posts.set(u, (posts.get(u) ?? 0) + 1);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string }[];
    const next = plan.get(u)?.shift();
    if (next === "hang") await untilAborted(init?.signal);
    if (typeof next === "number") {
      await new Promise((go) => setTimeout(go, next));
      throw new TypeError("fetch failed");
    }
    await new Promise((go) => setTimeout(go, ms(u, body)));
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x1" }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const rpcs = evmProviders(v.providers!, fetchFn);
  const of = new Map(v.providers!.map((u, k) => [u, rpcs[k]!] as const));
  return { of, posts: (u: string) => posts.get(u) ?? 0, plan: (u: string, p: ("hang" | number)[]) => void plan.set(u, p) };
}

/** One round of agreeing over `list` asking `calls`, as a quote's reads ask (`moving`), with the spare budget spent:
 *  only a stand-in, or a failure's next, asks a third provider. */
const round = (list: EvmRpc[], calls: { method: string; params: unknown[] }[]) =>
  evmAgreeing(
    list,
    (rpc: EvmRpc, _k: number, gate: EvmGated) => (gate.sent(), rpc(calls, undefined, gate.wire)).then((a) => JSON.stringify(a)),
    (a: string, b: string) => a === b,
    () => assert.fail("the providers differ"),
    true,
    undefined,
    true,
    () => false,
  );

test("W1 a 40-post round on a provider paced at 12 calls a second draws no stand-in: a post waiting at its pace is not late", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 100);
  // each provider answers its kind first, so each has its hedge time (100 ms, under EVM_HEDGE_MS)
  for (const u of v.providers!) for (let i = 0; i < 3; i++) await p.of.get(u)!(call(1));
  await new Promise((r) => setTimeout(r, 5_000));
  const before = [BLASTAPI!, POCKET!].map(p.posts);
  // mainnet.base.org's pace (12 calls a second, 12 at once: pace.ts) sends 40 posts over about 2.3 s, each 100 ms on the wire
  const list = [BASE_ORG!, PUBLICNODE!, BLASTAPI!, POCKET!].map((u) => p.of.get(u)!);
  await Promise.all(Array.from({ length: 40 }, () => round(list, call(1))));
  const spares = [BLASTAPI!, POCKET!].map((u, i) => p.posts(u) - before[i]!);
  assert.deepEqual(spares, [0, 0], `stand-ins asked of blastapi and Pocket for posts queued at mainnet.base.org's pace: ${spares}`);
  evmPaceReset();
}));

test("W2 a batch answered within its own kind's time draws no stand-in, though the provider's heads answer faster", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  // heads in 100 ms, a batch of 3 calls in 600 ms (each provider), the round's own batch in 550: one batch among the
  // provider's 32 newest answers, so the 95th percentile of all of them is a head's
  let batchMs = 600;
  const p = providers((_, calls) => (calls.some((c) => c.method === "eth_call") ? batchMs : 100));
  for (const u of [PUBLICNODE!, BLASTAPI!]) {
    await p.of.get(u)!(call(3));
    for (let i = 0; i < 31; i++) await p.of.get(u)!(head);
  }
  batchMs = 550;
  const before = [BASE_ORG!, POCKET!].map(p.posts);
  const list = [PUBLICNODE!, BLASTAPI!, BASE_ORG!, POCKET!].map((u) => p.of.get(u)!);
  await round(list, call(3));
  const spares = [BASE_ORG!, POCKET!].map((u, i) => p.posts(u) - before[i]!);
  assert.deepEqual(spares, [0, 0], `a 550 ms batch, inside its kind's own 600 ms, drew stand-ins as late by the heads' time: ${spares}`);
  evmPaceReset();
}));

test("W3 a post lost while its stand-in hangs asks the next at once, with the spare budget spent: the round ends", () => onTestClock(async () => {
  evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 100);
  for (const u of v.providers!) for (let i = 0; i < 3; i++) await p.of.get(u)!(call(1));
  // blastapi's post is lost 600 ms after it is sent, after its stand-in (mainnet.base.org, asked at blastapi's 400 ms)
  // was sent; the stand-in hangs to its 10 s timeout
  p.plan(BLASTAPI!, [600]);
  p.plan(BASE_ORG!, ["hang"]);
  const list = [PUBLICNODE!, BLASTAPI!, BASE_ORG!, POCKET!].map((u) => p.of.get(u)!);
  const t0 = performance.now();
  await round(list, call(1));
  const ms = performance.now() - t0;
  assert.equal(p.posts(BASE_ORG!) > 3, true, "the stand-in was never asked");
  assert.ok(ms < 2_000, `the round waited ${Math.round(ms)} ms on the stand-in's hang`);
  evmPaceReset();
}));
