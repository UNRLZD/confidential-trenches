// node --test apps/helper/src/rpc/many.test.ts (card helper-serves-many-users-at-once): a keyed chain's 10 s total is
// its first key's plan plus its share of each company key the route holds, the first key is paced from its own plan
// alone, and a Solana read the first key has no room for in its second goes to a keyed spare at once. Every clock here
// is planted (scripts/ci/no-wall-clock-asserts.mjs): the budgets', the holds', the pacer's and the waits'.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";

/** A still clock: a caller's share and a provider's budget are fixed windows on the helper's clock (limits.ts
 *  clientWindow, upstreamBudget; card helper-share-tests-on-a-still-clock), so on the machine's clock a window's turn
 *  inside a test clears the share its counts and 429s assert (PR 979's merge queue run 44243609488). */
const STILL = (): number => 1_800_000_000_000;
// read off the module, so this file loads at a base without them and fails on the behaviour (red runs)
const M = rpcModule as unknown as { createPacer: (clock?: () => number) => unknown; KEYED_ROUTE_SHARE?: number };
const JSON_T = "application/json";
const HELIUS = "https://mainnet.helius-rpc.invalid/?api-key=fake-helius-key-0123456789abcdef";
const QN = (c: string) => `https://${c}-mainnet.quiknode.invalid/fake0123456789abcdef/`;
const DRPC = (c: string, n: number) => `https://lb.drpc.invalid/ogrpc?network=${c}&dkey=fake${n}0123456789abcdef`;
/** The deployed lists by provider (the health answer, 11 Nov 05:15Z): Solana Helius then QuickNode; Base and Robinhood
 *  QuickNode and three dRPC keys. */
const DEPLOYED = {
  SOLANA_RPC_URL: HELIUS,
  SOLANA_RPC_URL_QUICKNODE: QN("solana"),
  BASE_RPC_URL_QUICKNODE: QN("base"),
  ROBINHOOD_RPC_URL_QUICKNODE: QN("robinhood"),
  ...Object.fromEntries([1, 2, 3].flatMap((n) => [[`BASE_RPC_URL_DRPC_${n}`, DRPC("base", n)], [`ROBINHOOD_RPC_URL_DRPC_${n}`, DRPC("robinhood", n)]])),
};

/** A planted clock in epoch ms, at a 10 s window's start, and a sleep that moves it: concurrent sleeps end at the
 *  latest one's end, never at their sum. */
function planted() {
  const c = { t: 1_800_000_000_000 };
  const now = () => c.t;
  const sleep = (ms: number) => {
    const at = c.t + ms;
    return new Promise<void>((ok) => setImmediate(() => ((c.t = Math.max(c.t, at)), ok())));
  };
  return { c, now, sleep };
}
/** Every provider answers each read, each send recorded with its URL and the planted time. */
function providers(c: { t: number }) {
  const sent: { url: string; t: number }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, t: c.t });
    const b = JSON.parse(String(init.body)) as { id: unknown };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: 1 }), { status: 200, headers: { "content-type": JSON_T } });
  };
  return { sent, fetch };
}
const read = (i: number) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "getSlot", params: [] });
function client(env: Record<string, string>) {
  const p = planted();
  const pv = providers(p.c);
  const r = createRpc(env, { fetch: pv.fetch as never, now: p.now, sleep: p.sleep, log: () => {}, pacer: M.createPacer(() => p.c.t) as never });
  return { ...p, ...pv, r };
}

test("each keyed chain's 10 s total is its first key's plan (RPC_BUDGET_<CHAIN>, else 100) plus half of each company key's 10 s pace, one bucket counted once: Solana 100 + 35, Base and Robinhood 35 + 4 (dRPC's three keys on its one bucket for the helper's IP at 0.8 a second, its free plan's minute budget measured, limits.ts DRPC_IP_PACE) plus half of the walk's fallback (card helper-base-trade-reads-429: mainnet.base.org 50, Robinhood's own 5) on the deployed lists, no pinned list given", () => {
  assert.equal(M.KEYED_ROUTE_SHARE, 0.5);
  const b = (env: Record<string, string>, chain: string) => (createRpc(env, { now: STILL, log: () => {} }) as unknown as { policyOf: (c: string) => string | undefined }).policyOf(chain);
  const p = (total: number, share: number) => `"chain";q=${total};w=10, "client";q=${share};w=10`;
  assert.deepEqual(["solana", "base", "robinhood", "near"].map((c) => b(DEPLOYED, c)), [p(135, 42), p(89, 30), p(44, 30), p(100, 16)]);
  assert.equal(b({ ...DEPLOYED, RPC_BUDGET_SOLANA: "500,42" }, "solana"), p(535, 42), "Helius Developer's plan, plus QuickNode's half");
  assert.equal(b({ SOLANA_RPC_URL: HELIUS }, "solana"), p(100, 42), "no company key: the first key's plan alone");
  assert.equal(b({}, "solana"), p(100, 16), "the public endpoint, unchanged");
  assert.equal(b({}, "ethereum"), undefined);
});

test("with the sum in force, the first key is never sent more in any PACE_SECOND_MS than its own plan's second (100 per 10 s: 10)", async () => {
  const k = client(DEPLOYED);
  // three callers at once, each a page's 42
  await Promise.all([0, 1, 2].map((n) => (async () => {
    for (let i = 0; i < 42; i++) await k.r.handle("solana", JSON_T, read(i + 1), `198.51.100.${n}`);
  })()));
  const first = k.sent.filter((s) => s.url === HELIUS).map((s) => s.t);
  const peak = Math.max(...first.map((t) => first.filter((x) => x >= t && x < t + 1_100).length));
  assert.ok(first.length > 0);
  assert.ok(peak <= 10, `the first key got ${peak} in one second`);
});

test("Solana: a read the first key has no room for in its second goes to the keyed spare at once, drawing the chain's budget once", async () => {
  const k = client(DEPLOYED);
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => k.r.handle("solana", JSON_T, read(i + 1), "203.0.113.5")));
  assert.deepEqual(answers.map((a) => a.status), Array(12).fill(200));
  assert.equal(k.sent.filter((s) => s.url === HELIUS).length, 10, "the first key's second");
  assert.equal(k.sent.filter((s) => s.url === QN("solana")).length, 2, "the rest to the spare");
  assert.ok(k.sent.every((s) => s.t === 1_800_000_000_000), "nothing waited");
  // drawn once each: the caller's share (42) has 30 left
  let more = 0;
  for (let i = 0; i < 31; i++) if ((await k.r.handle("solana", JSON_T, read(100 + i), "203.0.113.5")).status === 200) more++;
  assert.equal(more, 30);
});

test("at the defaults on the deployed list, three callers at once are each served a page's draw (42) on Solana, and a fourth is refused with a Retry-After", async () => {
  const k = client(DEPLOYED);
  const served = await Promise.all([0, 1, 2].map((n) => (async () => {
    let s = 0;
    for (let i = 0; i < 42; i++) if ((await k.r.handle("solana", JSON_T, read(i + 1), `198.51.100.${n}`)).status === 200) s++;
    return s;
  })()));
  assert.deepEqual(served, [42, 42, 42]);
  assert.ok(k.c.t < 1_800_000_010_000, `inside one 10 s window (${k.c.t - 1_800_000_000_000} ms)`);
  let fourth = 0;
  let refused: { status: number; headers?: Record<string, string> } | undefined;
  for (let i = 0; i < 42 && refused === undefined; i++) {
    const a = await k.r.handle("solana", JSON_T, read(i + 1), "198.51.100.9");
    if (a.status === 200) fourth++;
    else refused = a;
  }
  assert.ok(fourth < 42, `the fourth got ${fourth}`);
  assert.equal(refused?.status, 429);
  assert.ok(Number(refused?.headers?.["Retry-After"]) >= 1);
});

// card helper-base-trade-reads-429: live run 44930704040 (helper 8713b1ca3, 21 Nov 17:34Z) refused
// helper-gives-a-trade-its-reads' 12th Base read with 429 while helper-receipts-past-retention, in the same run, drew
// Base's route at the same seconds (its own batch refused 429 at 17:34:31.8Z): the route's total was 39 (its
// RateLimit-Policy), the company keys' halves alone (QuickNode 35, dRPC 4 since base-reads-never-throttled), though the
// walk (listOf) sends to the pinned public list and the fallback as well, each held to its own pace. The total counts
// half of each of their paces too, one bucket once, so other callers' draws leave a page its share.
/** The helper's createRpc as server.ts builds it: the pinned public lists (swaps.ts SWAP_RPCS) and one holds with every
 *  provider's pace (PROVIDER_PACE and the keyed URLs'). */
async function deployedRpc(env: Record<string, string>) {
  const p = planted();
  const { SWAP_RPCS } = await import("../data/evm/swaps.ts");
  const { PROVIDER_PACE, providerHolds } = await import("../limits/limits.ts");
  const { keyedPaces } = rpcModule as unknown as { keyedPaces: (e: Record<string, string>) => Record<string, unknown> };
  const pv = providers(p.c);
  const holds = providerHolds(p.now, { ...PROVIDER_PACE, ...keyedPaces(env) } as never);
  const r = createRpc(env, { fetch: pv.fetch as never, now: p.now, sleep: p.sleep, log: () => {}, pacer: M.createPacer(() => p.c.t) as never, holds, pinned: SWAP_RPCS } as never);
  return { ...p, ...pv, r: r as typeof r & { policyOf: (c: string) => string | undefined } };
}
const block = (i: number) => JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_blockNumber", params: [] });

test("card helper-base-trade-reads-429: on the deployed lists Base's total counts half of each paced provider its walk sends to (the pinned public list too): three pages at their full share fit at once", async () => {
  const k = await deployedRpc(DEPLOYED);
  const m = /^"chain";q=(\d+);w=10, "client";q=(\d+);w=10$/.exec(k.r.policyOf("base") ?? "");
  assert.ok(m, `a policy: ${k.r.policyOf("base")}`);
  const [total, share] = [Number(m![1]), Number(m![2])];
  assert.equal(share, 30);
  // QuickNode 35, dRPC's keys 4, and the pinned list's paced ones: publicnode 15, Tenderly 10, Sentio 20, mainnet.base.org 50
  assert.equal(total, 134);
  assert.ok(Math.floor(total / share) >= 3, `${total} / ${share}`);
});

test("card helper-base-trade-reads-429: a caller drawing 28 Base reads at once (run 44930704040's other checks) leaves a page's 30 reads spread over 7 s all served", async () => {
  const k = await deployedRpc(DEPLOYED);
  // the other caller: two batches of 10 and 8 single reads, all at the window's start
  const batch = (b: number) => JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: b * 100 + i, method: "eth_blockNumber", params: [] })));
  const other = await Promise.all([k.r.handle("base", JSON_T, batch(1), "198.51.100.7"), k.r.handle("base", JSON_T, batch(2), "198.51.100.7"), ...Array.from({ length: 8 }, (_, i) => k.r.handle("base", JSON_T, block(300 + i), "198.51.100.7"))]);
  assert.deepEqual(other.map((a) => a.status), Array(10).fill(200));
  // the page: 30 reads a 30th of 7 s apart, from the same instant on (helper-gives-a-trade-its-reads' draw)
  const t0 = k.c.t;
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) {
    const left = t0 + Math.round((i * 7_000) / 30) - k.c.t;
    if (left > 0) await k.sleep(left);
    statuses.push((await k.r.handle("base", JSON_T, block(i + 1), "203.0.113.9")).status);
  }
  assert.ok(k.c.t - t0 < 10_000, `inside one 10 s window (${k.c.t - t0} ms)`);
  assert.deepEqual(statuses, Array(30).fill(200), `served ${statuses.filter((s) => s === 200).length} of 30, first refusal at read ${statuses.findIndex((s) => s !== 200) + 1}`);
});

test("card helper-base-trade-reads-429: four pages at their full share at once on Base are all served, and the company keys are sent no more of them in any 10 s than the keys' half (39), so the token page's reads keep the other half", async () => {
  const k = await deployedRpc(DEPLOYED);
  const t0 = k.c.t;
  const served = await Promise.all([0, 1, 2, 3].map((n) => (async () => {
    let s = 0;
    for (let i = 0; i < 30; i++) {
      const left = t0 + Math.round((i * 9_000) / 30) - k.c.t;
      if (left > 0) await k.sleep(left);
      if ((await k.r.handle("base", JSON_T, block(n * 100 + i + 1), `198.51.100.${n}`)).status === 200) s++;
    }
    return s;
  })()));
  assert.deepEqual(served, [30, 30, 30, 30]);
  const keyed = k.sent.filter((s) => s.url === QN("base") || s.url.startsWith("https://lb.drpc.invalid/")).map((s) => s.t);
  const peak = Math.max(0, ...keyed.map((t) => keyed.filter((x) => x >= t && x < t + 10_000).length));
  assert.ok(keyed.length > 0, "the keys take their half");
  assert.ok(peak <= 39, `the company keys were sent ${peak} callers' reads in one 10 s`);
});

test("card helper-base-trade-reads-429: ?keyed=only reads never go past the keys' half (39 in 10 s) though the route's total counts the public list", async () => {
  const k = await deployedRpc(DEPLOYED);
  const t0 = k.c.t;
  const statuses = await Promise.all([0, 1].map((n) => (async () => {
    const out: number[] = [];
    for (let i = 0; i < 30; i++) {
      const left = t0 + Math.round((i * 7_000) / 30) - k.c.t;
      if (left > 0) await k.sleep(left);
      out.push((await k.r.handle("base", JSON_T, block(n * 100 + i + 1), `198.51.100.${n}`, false, true)).status);
    }
    return out;
  })()));
  const ok = statuses.flat().filter((s) => s === 200).length;
  assert.ok(ok <= 39 + 1, `${ok} keyed-only reads served in one window`);
  assert.ok(statuses.flat().some((s) => s === 429), "past the keys' half a keyed-only read waits (429), never a public answer");
  assert.ok(k.sent.every((s) => s.url === QN("base") || s.url.startsWith("https://lb.drpc.invalid/")), "keyed-only reads reach the keys alone");
});
