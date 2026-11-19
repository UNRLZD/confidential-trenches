// Every EVM batch fits the reader it goes to (card evm-batch-fits-each-reader): evmJsonRpc, the kit's one EVM batch
// sender, halves a batch its provider refuses for its size and asks the halves of the same provider, keeping the
// provider's most calls a batch for the page's life. Each refusal below is a mainnet provider's own answer to batches
// of eth_chainId, read from the Mac 2026-11-18 20:41Z (5, 10, 50, 200 and 1,000 calls a batch).
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmJsonRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import { evmPaceReset, evmProviderHeldMs } from "../src/checks/evm/pace.ts";

type Refusal = (n: number) => Response | null;
/** A provider that answers every call `{ result: <its method>:<its first param> }` by id, or `refuse(n)` for a post of n. */
function provider(refuse: Refusal) {
  const sizes: number[] = [];
  const asked: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const sent = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    sizes.push(sent.length);
    const r = refuse(sent.length);
    if (r !== null) return r;
    asked.push(...sent.map((c) => `${c.method}:${String(c.params[0])}`));
    return new Response(JSON.stringify(sent.map((c) => ({ jsonrpc: "2.0", id: c.id, result: `${c.method}:${String(c.params[0])}` }))), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, sizes, asked };
}
const calls = (n: number): EvmRpcCall[] => Array.from({ length: n }, (_, i) => ({ method: "eth_getTransactionReceipt", params: ["0x" + i.toString(16).padStart(64, "0")] }));
const results = (out: readonly unknown[]) => out.map((o) => (o as { result?: unknown } | null)?.result);
const want = (n: number) => calls(n).map((c) => `${c.method}:${String(c.params[0])}`);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("BFS1 Pocket: HTTP 413 with a plain-text body past 5 calls: halved to 5, every call answered in order, later batches start at 5", async () => {
  evmPaceReset();
  const p = provider((n) => (n > 5 ? new Response("request entity too large: the batch has more items than this window allows\n", { status: 413 }) : null));
  const rpc = evmJsonRpc("https://pocket.example", p.fetchFn);
  assert.deepEqual(results(await rpc(calls(10))), want(10));
  assert.deepEqual(p.sizes, [10, 5, 5]);
  p.sizes.length = 0;
  assert.deepEqual(results(await rpc(calls(23))), want(23));
  assert.deepEqual(p.sizes.sort((a, b) => a - b), [3, 5, 5, 5, 5], "the kept size: no post past 5, no second refusal");
  evmPaceReset();
});

test("BFS2 daybreak: HTTP 413 with a JSON-RPC error naming its maximum (20): the batch goes at that maximum, never more than half", async () => {
  evmPaceReset();
  const p = provider((n) => (n > 20 ? json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large: max 20 calls" } }, 413) : null));
  const rpc = evmJsonRpc("https://daybreak.example", p.fetchFn);
  assert.deepEqual(results(await rpc(calls(50))), want(50));
  assert.deepEqual(p.sizes, [50, 20, 20, 10]);
  evmPaceReset();
});

test("BFS3 dRPC: HTTP 400 with every call's error naming the batch limit (more than 3): split to 3s", async () => {
  evmPaceReset();
  const msg = "Batch of more than 3 requests are not allowed on free plan, to use this feature register paid account at drpc.org";
  const p = provider((n) => (n > 3 ? json(Array.from({ length: n }, (_, id) => ({ jsonrpc: "2.0", id, error: { message: msg, code: 31 } })), 400) : null));
  const rpc = evmJsonRpc("https://drpc.example", p.fetchFn);
  assert.deepEqual(results(await rpc(calls(7))), want(7));
  assert.deepEqual(p.sizes, [7, 3, 3, 1]);
  evmPaceReset();
});

test("BFS4 Sentio: HTTP 429 whose error names the batch maximum (5) is a size refusal: split, and the provider is not held", async () => {
  evmPaceReset();
  const p = provider((n) => (n > 5 ? json({ code: 8, message: "JSON-RPC batch exceeds the maximum of 5 requests" }, 429) : null));
  const url = "https://sentio.example/base";
  const rpc = evmJsonRpc(url, p.fetchFn);
  assert.deepEqual(results(await rpc(calls(12))), want(12));
  assert.deepEqual(p.sizes, [12, 5, 5, 2]);
  assert.equal(evmProviderHeldMs(url), 0, "a size refusal is no throttle");
  evmPaceReset();
});

test("BFS5 a 200 whose one answer is an error naming the batch size: halved", async () => {
  evmPaceReset();
  const p = provider((n) => (n > 4 ? json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch size too large" } }, 200) : null));
  const rpc = evmJsonRpc("https://another.example", p.fetchFn);
  assert.deepEqual(results(await rpc(calls(16))), want(16));
  assert.deepEqual(p.sizes, [16, 8, 8, 4, 4, 4, 4], "both halves leave at once, each met once more, then 4s");
  evmPaceReset();
});

test("BFS6 a stated maximum never raises a batch: 'max 50' to a batch of 10 is halved to 5, 'max 0' halved too", async () => {
  for (const said of ["batch too large: max 50 calls", "batch too large: max 0 calls"]) {
    evmPaceReset();
    const p = provider((n) => (n > 5 ? json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: said } }, 413) : null));
    const rpc = evmJsonRpc("https://liar.example", p.fetchFn);
    assert.deepEqual(results(await rpc(calls(10))), want(10));
    assert.deepEqual(p.sizes, [10, 5, 5], said);
  }
  evmPaceReset();
});

test("BFS7 unchanged: a throttle's 429 still throws and holds; a rate limit inside a 200 is answered as is and holds; 413 to one call, another 4xx and a 5xx throw", async () => {
  evmPaceReset();
  const t = provider(() => json({ id: 0, jsonrpc: "2.0", error: { code: -32005, message: "rate limit exceeded" } }, 429));
  await assert.rejects(evmJsonRpc("https://tenderly.example", t.fetchFn)(calls(50)), /429 Too Many Requests/);
  assert.deepEqual(t.sizes, [50], "a throttle is never split");
  assert.ok(evmProviderHeldMs("https://tenderly.example") > 0);

  const lim = (async (_u: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { id: number }[];
    return json(sent.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32007, message: "25/second request limit reached" } })), 200);
  }) as unknown as typeof fetch;
  const out = await evmJsonRpc("https://base-org.example", lim)(calls(30));
  assert.equal(out.length, 30);
  assert.ok(evmProviderHeldMs("https://base-org.example") > 0);

  const one = provider(() => new Response("request entity too large", { status: 413 }));
  await assert.rejects(evmJsonRpc("https://one.example", one.fetchFn)(calls(1)), /HTTP 413/);
  assert.deepEqual(one.sizes, [1]);

  const bad = provider(() => json({ error: { code: -32600, message: "invalid request" } }, 400));
  await assert.rejects(evmJsonRpc("https://bad.example", bad.fetchFn)(calls(8)), /HTTP 400/);
  assert.deepEqual(bad.sizes, [8]);

  const down = provider(() => new Response("bad gateway: batch too large", { status: 502 }));
  await assert.rejects(evmJsonRpc("https://down.example", down.fetchFn)(calls(8)), /HTTP 502/);
  assert.deepEqual(down.sizes, [8]);
  evmPaceReset();
});

test("BFS8 a split batch asks the same calls of the same provider, each once, and keeps the kit's signal", async () => {
  evmPaceReset();
  const p = provider((n) => (n > 5 ? new Response("request entity too large: the batch has more items than this window allows", { status: 413 }) : null));
  const rpc = evmJsonRpc("https://same.example", p.fetchFn);
  await rpc(calls(12));
  assert.deepEqual([...p.asked].sort(), [...want(12)].sort());
  const stop = new AbortController();
  stop.abort(new Error("the quote's bound"));
  await assert.rejects(rpc(calls(12), stop.signal), /bound|abort/i);
  evmPaceReset();
});
