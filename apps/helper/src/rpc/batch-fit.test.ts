// node --test apps/helper/src/rpc/batch-fit.test.ts (card helper-rpc-batch-learns-reader-size): the /v1/rpc proxy fits
// each upstream's batch size. A device batch an upstream refuses for its size is split to the size the refusal names, or
// halved, sent again to the same upstream, and that size is kept per upstream for the process's life; the answers go
// back in the device's order. A throttle's 429 still holds the upstream. Each refusal is a mainnet reader's own answer
// to batches of eth_chainId, read from the Mac 2026-11-18 20:41Z (the kit's packages/kit/test/evm-batch-fit.test.ts
// holds the same shapes). Every URL is made up or the chain's public fallback; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, RPC_UPSTREAMS } from "./rpc.ts";
import { providerHolds, type Pace } from "../limits/limits.ts";

const SPARE = "https://spare.test";
const clock = () => {
  const t = { v: 1_800_000_000_000 };
  return { now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};
const json = (body: unknown, status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
type Req = { id: number; method: string };
/** The upstream refusing a post of `n` calls (null: it answers). */
type Refuse = (sent: Req[]) => Response | null;
const DRPC_MSG = "Batch of more than 3 requests are not allowed on free plan, to use this feature register paid account at drpc.org";
/** Each mainnet reader's refusal past its size, as read 2026-11-18 20:41Z, and the parts a batch of 10 must go as. */
const SHAPES: [string, Refuse, number][] = [
  ["Pocket: HTTP 413, plain text, past 5", (s) => (s.length > 5 ? new Response("request entity too large: the batch has more items than this window allows\n", { status: 413, headers: { "content-type": "text/plain" } }) : null), 5],
  ["daybreak: HTTP 413, JSON -32600 naming its max (planted at 4)", (s) => (s.length > 4 ? json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large: max 4 calls" } }, 413) : null), 4],
  ["dRPC free: HTTP 400, every call's error 31, past 3", (s) => (s.length > 3 ? json(s.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { message: DRPC_MSG, code: 31 } })), 400) : null), 3],
  ["Sentio: HTTP 429, code 8 naming its max of 5 (a size refusal, no throttle)", (s) => (s.length > 5 ? json({ code: 8, message: "JSON-RPC batch exceeds the maximum of 5 requests" }, 429) : null), 5],
  ["a 200 whose every error names the batch max (3)", (s) => (s.length > 3 ? json(s.map((r) => ({ jsonrpc: "2.0", id: r.id, error: { message: DRPC_MSG, code: 31 } })), 200) : null), 3],
  ["a refusal naming more than half (999): halved, never raised", (s) => (s.length > 5 ? json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large: max 999 calls" } }, 413) : null), 5],
];

/** A fake upstream set: `refuser` refuses by `refuse`, every other URL answers; each post's URL and size recorded. */
function upstream(refuser: string, refuse: Refuse) {
  const posts: [string, number][] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Req | Req[];
    const sent = Array.isArray(body) ? body : [body];
    posts.push([url, sent.length]);
    if (url === refuser) {
      const r = refuse(sent);
      if (r !== null) return r;
    }
    const who = url === refuser ? "A" : url === SPARE ? "spare" : "other";
    const one = (r: Req) => ({ jsonrpc: "2.0", id: r.id, result: `${who}:${r.id}` });
    return json(Array.isArray(body) ? body.map(one) : one(body), 200);
  };
  return { fetch, posts, to: (u: string) => posts.filter(([p]) => p === u).map(([, n]) => n) };
}
const batch = (chain: string, n: number, from = 1) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: from + i, method: chain === "solana" ? "getLatestBlockhash" : "eth_blockNumber", params: [] })));
const results = (body: string) => (JSON.parse(body) as { id: number; result?: string }[]).map((a) => [a.id, a.result]);
const want = (who: string, n: number, from = 1) => Array.from({ length: n }, (_, i) => [from + i, `${who}:${from + i}`]);
let ip = 0;
const client = () => `198.51.100.${++ip}`;

for (const chain of ["base", "robinhood"] as const) {
  const A = RPC_UPSTREAMS[chain].fallback!;
  for (const [what, refuse, most] of SHAPES) {
    test(`${chain}, ${what}: a batch of 10 is answered by the same upstream in parts of ${most}, in the device's order, and the next batch goes at that size at once`, async () => {
      const u = upstream(A, refuse);
      const c = clock();
      const r = createRpc({}, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
      const a = await r.handle(chain, "application/json", batch(chain, 10), client());
      assert.equal(a.status, 200, a.body);
      assert.deepEqual(results(a.body), want("A", 10), `posts ${JSON.stringify(u.posts)}`);
      assert.equal(u.to(SPARE).length, 0, "the upstream was dropped for its size and the read moved on");
      assert.equal(u.to(A)[0], 10, "the first post is the whole batch");
      assert.ok(u.to(A).slice(1).every((n) => n <= most), `parts past ${most}: ${u.to(A).join(",")}`);
      // kept for the process's life: the next batch leaves in parts at once, none refused
      u.posts.length = 0;
      const b = await r.handle(chain, "application/json", batch(chain, 10, 101), client());
      assert.equal(b.status, 200, b.body);
      assert.deepEqual(results(b.body), want("A", 10, 101));
      const parts = Array.from({ length: Math.ceil(10 / most) }, (_, i) => Math.min(most, 10 - i * most));
      assert.deepEqual(u.to(A), parts, "the kept size, no refused post");
      // a single read still goes whole, and the upstream is not held (Sentio's 429 was a size, no throttle)
      u.posts.length = 0;
      const one = await r.handle(chain, "application/json", JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_blockNumber", params: [] }), client());
      assert.equal((JSON.parse(one.body) as { result: string }).result, "A:9");
    });
  }

  test(`${chain}: a throttle's 429 on a batch (Retry-After 20, a rate limit body) still holds the upstream: the read and the next go to the spare`, async () => {
    for (const body of ["Too Many Requests", JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limit exceeded" } })]) {
      const u = upstream(A, () => new Response(body, { status: 429, headers: { "retry-after": "20" } }));
      const c = clock();
      const r = createRpc({}, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
      const a = await r.handle(chain, "application/json", batch(chain, 10), client());
      assert.equal(a.status, 200, a.body);
      assert.deepEqual(results(a.body), want("spare", 10));
      assert.deepEqual(u.to(A), [10], "a throttle is never split");
      const b = await r.handle(chain, "application/json", batch(chain, 10, 101), client());
      assert.deepEqual(results(b.body), want("spare", 10, 101));
      assert.deepEqual(u.to(A), [10], "held: not asked again inside its 20 s");
    }
  });

  test(`${chain}: a part that fails after the split (503) is that upstream down for the read: the spare answers the whole batch`, async () => {
    let n = 0;
    const u = upstream(A, (s) => (s.length > 5 ? new Response("too large", { status: 413 }) : ++n === 2 ? new Response("down", { status: 503 }) : null));
    const c = clock();
    const r = createRpc({}, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", batch(chain, 10), client());
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(results(a.body), want("spare", 10));
  });

  test(`${chain}: an upstream that refuses even one call for size ends at parts of one, a bounded number of posts, and the spare answers`, async () => {
    const u = upstream(A, () => new Response("request entity too large", { status: 413 }));
    const c = clock();
    const r = createRpc({}, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", batch(chain, 10), client());
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(results(a.body), want("spare", 10));
    assert.ok(u.to(A).length <= 20, `posts to the refuser: ${u.to(A).join(",")}`);
  });

  test(`${chain}: a keyed URL that refuses for size (413) serves the batch in parts, and the log line naming its size holds no key`, async () => {
    const key = "plantedBATCHkey0123456789abcdef";
    const K = `https://keyed.${chain}.test/${key}`;
    const lines: string[] = [];
    const u = upstream(K, (s) => (s.length > 5 ? new Response("request entity too large", { status: 413 }) : null));
    const c = clock();
    const r = createRpc({ [RPC_UPSTREAMS[chain].env]: K }, { fetch: u.fetch as never, holds: providerHolds(c.now, {}), pinned: { [chain]: [SPARE] }, now: c.now, sleep: c.sleep, log: (l) => lines.push(l) });
    const a = await r.handle(chain, "application/json", batch(chain, 10), client());
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(results(a.body), want("A", 10));
    assert.deepEqual(u.to(K), [10, 5, 5]);
    assert.ok(lines.some((l) => /rpc batch .* most 5/.test(l)), lines.join("\n"));
    assert.ok(!lines.join("\n").includes(key), "no key in a log line");
  });
}

test("a post-paced upstream's parts each draw a post of its pace", async () => {
  const A = RPC_UPSTREAMS.base.fallback!;
  const u = upstream(A, (s) => (s.length > 5 ? new Response("request entity too large", { status: 413 }) : null));
  const c = clock();
  const pace: Record<string, Pace> = { [A]: { perS: 0.001, burst: 4, unit: "post" } };
  const holds = providerHolds(c.now, pace);
  const r = createRpc({}, { fetch: u.fetch as never, holds, pinned: { base: [SPARE] }, now: c.now, sleep: c.sleep, log: () => undefined });
  assert.equal((await r.handle("base", "application/json", batch("base", 10), client())).status, 200);
  const before = holds.room(A);
  const b = await r.handle("base", "application/json", batch("base", 10, 101), client());
  assert.deepEqual(results(b.body), want("A", 10, 101));
  assert.equal(Math.round((before - holds.room(A)) * 4), 2, "two posts of five drew two of the bucket's four");
});

test("solana: the first key (call()) refusing a batch for its size (413) serves it in parts, never falling to the public endpoint", async () => {
  const K = "https://mainnet.helius.test/?api-key=plantedSOLbatchkey0123456789";
  const u = upstream(K, (s) => (s.length > 5 ? new Response("request entity too large", { status: 413 }) : null));
  const c = clock();
  const r = createRpc({ SOLANA_RPC_URL: K }, { fetch: u.fetch as never, now: c.now, sleep: c.sleep, log: () => undefined });
  const a = await r.handle("solana", "application/json", batch("solana", 10), client());
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(results(a.body), want("A", 10), `posts ${JSON.stringify(u.posts)}`);
  assert.deepEqual(u.to(RPC_UPSTREAMS.solana.fallback!), []);
});
