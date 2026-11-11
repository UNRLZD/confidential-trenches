// node --test apps/helper/src/rpc/many.test.ts (card helper-serves-many-users-at-once): a keyed chain's 10 s total is
// its first key's plan plus its share of each company key the route holds, the first key is paced from its own plan
// alone, and a Solana read the first key has no room for in its second goes to a keyed spare at once. Every clock here
// is planted (scripts/ci/no-wall-clock-asserts.mjs): the budgets', the holds', the pacer's and the waits'.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";

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

test("each keyed chain's 10 s total is its first key's plan (RPC_BUDGET_<CHAIN>, else 100) plus half of each company key's 10 s pace: Solana 100 + 35, Base and Robinhood 35 + 3 x 40 on the deployed lists", () => {
  assert.equal(M.KEYED_ROUTE_SHARE, 0.5);
  const b = (env: Record<string, string>, chain: string) => (createRpc(env, { log: () => {} }) as unknown as { policyOf: (c: string) => string | undefined }).policyOf(chain);
  const p = (total: number, share: number) => `"chain";q=${total};w=10, "client";q=${share};w=10`;
  assert.deepEqual(["solana", "base", "robinhood", "near"].map((c) => b(DEPLOYED, c)), [p(135, 42), p(155, 30), p(155, 30), p(100, 16)]);
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
