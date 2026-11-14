// node --test apps/helper/src/rpc/logs-cache.test.ts (card helper-pool-logs-outside-the-caller-budget): on the keyed-only
// route of an EVM chain (POST /v1/rpc/{base,robinhood}?keyed=only), an eth_getLogs whose range ends at or below the
// chain's finalized head, as the helper itself reads it, is answered from a cache keyed by the exact request, and those
// answers draw nothing of the caller's share; any other read, an unfinalized or tagged range included, counts and goes
// to the provider as before. The URLs are made up; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc, keyedBudget } from "./rpc.ts";

// read off the module, so this file loads at a base without them and fails on the behaviour (red runs)
const { LOG_CACHE_ENTRIES, LOG_CACHE_BYTES } = rpcModule as unknown as { LOG_CACHE_ENTRIES?: number; LOG_CACHE_BYTES?: number };

const CHAINS = ["robinhood", "base"] as const;
const ENV: Record<string, string> = {
  ROBINHOOD_RPC_URL: "https://robinhood-mainnet.alchemy.test/v2/plantedRHown000key123456789abcd",
  BASE_RPC_URL: "https://base-mainnet.alchemy.test/v2/plantedBASEown0key123456789abcd",
};
const FINAL = 120_000_000; // the chain's finalized head as its provider answers it
const POOL = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
/** Each chain's pool as the kit pins it (packages/kit/src/trade/evm/buy-unpinned.ts evmMainnetVenues) and its deploy block
 *  (packages/wallet/src/pool/evm.ts EVM_POOLS). */
const POOLS = { robinhood: { pool: POOL, from: 108_420_674 }, base: { pool: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf", from: 54_325_671 } } as const;
const TOPICS = [["0x1111111111111111111111111111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222222222222222222222222222"]];
const hex = (n: number): string => `0x${n.toString(16)}`;
const logsBody = (id: number, from: string, to: string, address: string = POOL): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ address, topics: TOPICS, fromBlock: from, toBlock: to }] });
/** A cold walk as the page makes it: from the pool's deploy block, pages of 100,000, 200,000, 400,000 blocks, then
 *  800,000, the last clipped to the round's anchor (unique to the sign-in). */
function walk(from: number, anchor: number): [string, string][] {
  const out: [string, string][] = [];
  for (let at = from, w = 100_000; at <= anchor; at += w, w = Math.min(w * 2, 800_000)) out.push([hex(at), hex(Math.min(at + w - 1, anchor))]);
  return out;
}
/** The pool's walk as the page pages it: 8 pages of 800,000 blocks from its deploy block, every one below FINAL. */
const PAGES: [string, string][] = Array.from({ length: 8 }, (_, i) => [hex(108_420_674 + i * 800_000), hex(108_420_674 + (i + 1) * 800_000 - 1)]);

function provider() {
  const sent: { method: string; params: unknown }[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    sent.push({ method: req.method, params: req.params });
    const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (req.method === "eth_getBlockByNumber" && req.params[0] === "finalized") return json({ number: hex(FINAL), hash: `0x${"ab".repeat(32)}` });
    if (req.method === "eth_getLogs") {
      const f = req.params[0] as { fromBlock: string; toBlock: string };
      return json([{ address: POOL, blockNumber: f.fromBlock, logIndex: "0x0", data: "0x", topics: [TOPICS[0]![0]] }]);
    }
    return json("0x1");
  };
  return { sent, fetch, logs: () => sent.filter((s) => s.method === "eth_getLogs").length };
}

for (const chain of CHAINS) {
  test(`${chain}: one caller walks the pool's 8 finalized pages five times (40 reads, past its share of ${keyedBudget(chain).perClient}): every read answered, the provider asked each page once, the repeats from the cache`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });
    const share = keyedBudget(chain).perClient;
    assert.ok(PAGES.length * 5 > share, "the walk asks more than one caller's share");
    const answers: { round: number; i: number; from: string; a: Awaited<ReturnType<typeof r.handle>> }[] = [];
    for (let round = 0; round < 5; round++) {
      for (const [i, [from, to]] of PAGES.entries()) answers.push({ round, i, from, a: await r.handle(chain, "application/json", logsBody(round * 100 + i, from, to, POOLS[chain].pool), "203.0.113.7", false, true) });
    }
    const refused = answers.filter((x) => x.a.status !== 200).map((x) => `round ${x.round} page ${x.i}: ${x.a.status} ${x.a.body}`);
    assert.deepEqual(refused, [], "every read answered, never the caller's 429");
    for (const { round, i, from, a } of answers) {
      const body = JSON.parse(a.body) as { id: number; result: { blockNumber: string }[] };
      assert.equal(body.id, round * 100 + i, "the caller's own id");
      assert.equal(body.result[0]!.blockNumber, from, "the page's own logs");
      if (round > 0) assert.ok(a.timing?.includes('rpc-cache;desc="hit"'), `round ${round} page ${i}: the cache's hit in Server-Timing (${a.timing?.join(", ")})`);
    }
    assert.equal(p.logs(), PAGES.length, "each page sent to the provider once");
    // the caller's share is untouched by the 32 hits: a read that is not cached still goes
    const other = await r.handle(chain, "application/json", JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_blockNumber", params: [] }), "203.0.113.7", false, true);
    assert.equal(other.status, 200);
  });

  test(`${chain}: a range past the finalized head, or a tag, is never cached and counts in the caller's share as before`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });
    const share = keyedBudget(chain).perClient;
    const unfinal = (id: number) => logsBody(id, hex(FINAL - 10), hex(FINAL + 5));
    const tagged = (id: number) => logsBody(id, hex(FINAL - 10), "latest");
    const statuses: number[] = [];
    for (let i = 0; i < share + 4; i++) {
      const a = await r.handle(chain, "application/json", i % 2 === 0 ? unfinal(i) : tagged(i), "203.0.113.8", false, true);
      statuses.push(a.status);
      assert.ok(!(a.timing ?? []).includes('rpc-cache;desc="hit"'), `read ${i}: never a cache hit`);
    }
    assert.deepEqual(statuses.slice(0, share), Array(share).fill(200), "the share's reads answered");
    assert.deepEqual(statuses.slice(share), Array(4).fill(429), "past the share: the caller's 429, as today");
    assert.equal(p.logs(), share, "every answered read sent to the provider, none from a cache");
  });

  test(`${chain}: a finalized page asked without ?keyed=only counts as before`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });
    const [from, to] = PAGES[0]!;
    for (let i = 0; i < 3; i++) {
      const a = await r.handle(chain, "application/json", logsBody(i, from, to), "203.0.113.9", false, false);
      assert.equal(a.status, 200);
      assert.ok(!(a.timing ?? []).includes('rpc-cache;desc="hit"'), "the public-fallback route keeps no cache");
    }
    assert.equal(p.logs(), 3);
  });
}

const blockNumber = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] });
for (const chain of CHAINS) {
  test(`${chain}: a cold walk (the cache empty, the helper just started) by a caller whose share is spent: every page of its pool's finalized history answered, the clipped last one too, each sent once, none counted in its share`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });
    const share = keyedBudget(chain).perClient;
    const me = "203.0.113.20";
    for (let i = 0; i < share; i++) assert.equal((await r.handle(chain, "application/json", blockNumber(i), me, false, true)).status, 200);
    assert.equal((await r.handle(chain, "application/json", blockNumber(99), me, false, true)).status, 429, "the share is spent");
    // Robinhood: the pool's life to an anchor 1,000 blocks under the head, 12 pages and the clipped last; Base: 3 pages
    const pages = walk(POOLS[chain].from, chain === "robinhood" ? 117_000_000 : POOLS[chain].from + 600_000);
    if (chain === "robinhood") assert.ok(pages.length >= 9 && pages.length <= share, `a full walk: ${pages.length} pages`);
    const refused: string[] = [];
    for (const [i, [from, to]] of pages.entries()) {
      const a = await r.handle(chain, "application/json", logsBody(100 + i, from, to, POOLS[chain].pool), me, false, true);
      if (a.status !== 200) refused.push(`page ${i} ${from}-${to}: ${a.status} ${a.body}`);
    }
    assert.deepEqual(refused, [], `every one of ${pages.length} pages answered, no 429`);
    assert.equal(p.logs(), pages.length, "each page sent once");
    assert.equal((await r.handle(chain, "application/json", blockNumber(98), me, false, true)).status, 429, "the share still spent: the walk drew none of it");
  });

  test(`${chain}: the cold walk's allowance is bounded: another address's finalized pages count in the caller's share as before, and the pool's past the chain's page share in one window draw the caller's 429`, async () => {
    const p = provider();
    const r = createRpc(ENV, { fetch: p.fetch as never, log: () => undefined });
    const share = keyedBudget(chain).perClient;
    const page = (i: number, address: string) => logsBody(i, hex(100_000_000 + i * 10), hex(100_000_000 + i * 10 + 9), address);
    const other: number[] = [];
    for (let i = 0; i < share + 2; i++) other.push((await r.handle(chain, "application/json", page(i, "0x00000000000000000000000000000000000000aa"), "203.0.113.21", false, true)).status);
    assert.deepEqual(other, [...Array(share).fill(200), 429, 429], "not the pool: the caller's share, as before");
    const pool: number[] = [];
    for (let i = 0; i < share + 2; i++) pool.push((await r.handle(chain, "application/json", page(i + 100, POOLS[chain].pool), "203.0.113.22", false, true)).status);
    assert.deepEqual(pool, [...Array(share).fill(200), 429, 429], "the pool's first asks: the whole allowance, then its 429");
    assert.equal((await r.handle(chain, "application/json", blockNumber(1), "203.0.113.22", false, true)).status, 200, "and the caller's own share untouched");
  });
}

test("the cache's bound is named: at most LOG_CACHE_ENTRIES answers and LOG_CACHE_BYTES bytes, the oldest used first out", async () => {
  assert.equal(typeof LOG_CACHE_ENTRIES, "number");
  assert.equal(typeof LOG_CACHE_BYTES, "number");
  const p = provider();
  // a clock the test moves: 10 s on every 25 reads, so the chain's total and each caller's share are new windows
  let t = 1_000_000;
  const r = createRpc(ENV, { fetch: p.fetch as never, now: () => t, sleep: async (ms: number) => void (t += ms), log: () => undefined });
  // LOG_CACHE_ENTRIES + 1 distinct finalized pages from many callers (each under its share): the first is out
  const n = LOG_CACHE_ENTRIES! + 1;
  for (let i = 0; i < n; i++) {
    if (i % 25 === 0) t += 10_001;
    const a = await r.handle("robinhood", "application/json", logsBody(i, hex(100_000_000 + i * 10), hex(100_000_000 + i * 10 + 9)), "198.51.100.1", false, true);
    assert.equal(a.status, 200);
  }
  const before = p.logs();
  const last = await r.handle("robinhood", "application/json", logsBody(1, hex(100_000_000 + (n - 1) * 10), hex(100_000_000 + (n - 1) * 10 + 9)), "192.0.2.1", false, true);
  assert.ok(last.timing?.includes('rpc-cache;desc="hit"'), "the newest kept");
  const first = await r.handle("robinhood", "application/json", logsBody(2, hex(100_000_000), hex(100_000_009)), "192.0.2.1", false, true);
  assert.ok(!(first.timing ?? []).includes('rpc-cache;desc="hit"'), "the oldest evicted");
  assert.equal(p.logs(), before + 1);
});

test("an answer that is not a result list (a provider's error) is never kept; a kept page is asked again once LOG_CACHE_MS has passed", async () => {
  const { LOG_CACHE_MS } = rpcModule as unknown as { LOG_CACHE_MS?: number };
  assert.equal(typeof LOG_CACHE_MS, "number");
  let t = 1_000_000;
  let fail = true;
  const sent: string[] = [];
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string };
    sent.push(req.method);
    const body = req.method === "eth_getBlockByNumber" ? { jsonrpc: "2.0", id: req.id, result: { number: hex(FINAL) } } : fail ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "header not found" } } : { jsonrpc: "2.0", id: req.id, result: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = createRpc(ENV, { fetch: fetch as never, now: () => t, sleep: async (ms: number) => void (t += ms), log: () => undefined });
  const [from, to] = PAGES[0]!;
  const ask = () => r.handle("robinhood", "application/json", logsBody(1, from, to), "203.0.113.10", false, true);
  assert.ok(!((await ask()).timing ?? []).includes('rpc-cache;desc="hit"'));
  fail = false;
  assert.ok(!((await ask()).timing ?? []).includes('rpc-cache;desc="hit"'), "the error was not kept: asked again");
  assert.ok((await ask()).timing?.includes('rpc-cache;desc="hit"'), "the result list kept");
  t += LOG_CACHE_MS!;
  assert.ok(!((await ask()).timing ?? []).includes('rpc-cache;desc="hit"'), "past LOG_CACHE_MS: asked again");
  assert.equal(sent.filter((m) => m === "eth_getLogs").length, 3);
});
