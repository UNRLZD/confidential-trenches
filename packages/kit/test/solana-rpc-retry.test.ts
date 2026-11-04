// The kit's JSON-RPC client with `retry` (card signpage-rpc-throttle-retry): each transport fault form is tried again
// within the call's bounds and the call lands; a fault that outlasts them rejects as a SolanaRpcTransportError naming
// it; anything else rejects at once; without `retry` the client is one attempt, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_POOL_QUOTE_MAX_AGE_SLOTS } from "../src/trade/solana/pool-buy.ts";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaJsonRpc, type SolanaRpcRetry } from "../src/trade/solana/send.ts";

type Answer = { status?: number; body?: string; headers?: Record<string, string>; stall?: boolean; reject?: boolean };
const ok = (id: string): Answer => ({ body: JSON.stringify({ jsonrpc: "2.0", id, result: 7 }) });

/** A provider that answers `faults` in turn, then the call's result; it counts the attempts. */
function provider(faults: Answer[]) {
  let n = 0;
  const fetch = (_u: string, init: RequestInit): Promise<Response> => {
    const id = (JSON.parse(String(init.body)) as { id: string }).id;
    const a = n < faults.length ? faults[n]! : ok(id);
    n++;
    if (a.reject) return Promise.reject(new TypeError("fetch failed"));
    if (a.stall)
      return new Promise((_, rej) => {
        const s = init.signal!;
        s.addEventListener("abort", () => rej(s.reason), { once: true });
      });
    const body = (a.body ?? "").replaceAll("$ID", id);
    return Promise.resolve(new Response(body, { status: a.status ?? 200, headers: a.headers ?? {} }));
  };
  return { fetch, tries: () => n };
}

const FAST: SolanaRpcRetry = { deadlineMs: 1_500, attemptMs: 200, backoffMs: 10 };
const rpcError = (code: number) => ({ body: JSON.stringify({ jsonrpc: "2.0", id: "$ID", error: { code, message: "too many requests" } }) });

const FORMS: [string, Answer][] = [
  ["HTTP 429", { status: 429, body: "Too Many Requests" }],
  ["HTTP 429 with Retry-After 0", { status: 429, body: "", headers: { "retry-after": "0" } }],
  ["HTTP 502", { status: 502, body: "<html>bad gateway</html>" }],
  ["HTTP 503", { status: 503, body: "" }],
  ["-32029 in a 200", rpcError(-32029)],
  ["-32429 in a 200", rpcError(-32429)],
  ["a 200 that is not JSON", { body: "<html>rate limited</html>" }],
  ["a stall (no answer)", { stall: true }],
  ["no connection", { reject: true }],
];

for (const [name, fault] of FORMS) {
  test(`with retry, ${name} once and then the result: the call lands`, async () => {
    const p = provider([fault]);
    const got = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []);
    assert.equal(got, 7);
    assert.equal(p.tries(), 2);
  });
}

test("with retry, a fault that outlasts the deadline rejects as a SolanaRpcTransportError naming the fault, never a bare failure", async () => {
  const p = provider(Array.from({ length: 1000 }, () => rpcError(-32429)));
  const t0 = Date.now();
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []).catch((x: unknown) => x);
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.equal(e.fault, "rpc_throttled");
  assert.equal(e.host, "rpc.example");
  assert.ok(e.tries >= 3, `tries ${e.tries}`);
  assert.match(e.message, /RPC error -32429.*rpc_throttled.*rpc\.example/);
  assert.ok(Date.now() - t0 < FAST.deadlineMs + 100, `took ${Date.now() - t0} ms`);
});

test("with retry, Retry-After is honoured: a 429 naming 1 s is tried again only after it", async () => {
  const p = provider([{ status: 429, body: "", headers: { "retry-after": "1" } }]);
  const t0 = Date.now();
  assert.equal(await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getSlot", []), 7);
  assert.ok(Date.now() - t0 >= 990, `took ${Date.now() - t0} ms`);
});

test("with retry, a Retry-After that ends past the deadline is not waited: the call answers at once, the 429 named", async () => {
  const p = provider([{ status: 429, body: "", headers: { "retry-after": "30" } }]);
  const t0 = Date.now();
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getSlot", []).catch((x: unknown) => x);
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.equal(e.fault, "http_429");
  assert.equal(p.tries(), 1);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
});

test("with retry, a stall forever stops at the deadline, named a timeout", async () => {
  const p = provider(Array.from({ length: 1000 }, () => ({ stall: true })));
  const t0 = Date.now();
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []).catch((x: unknown) => x);
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.equal(e.fault, "timeout");
  assert.ok(Date.now() - t0 < FAST.deadlineMs + 150, `took ${Date.now() - t0} ms`);
});

test("the quote's age: the page's retry stops two calls (the venue, then the blockhash and its slot) inside 25 slots", () => {
  // a pool buy's reads after the reference: the venue (both RPCs at once) and the blockhash, whose slot is the device's
  // own; each call ends within its deadline, waits included, so the two together end inside the rule's window at a
  // 360 ms slot (the cluster's target is 400 ms)
  assert.ok(2 * SOLANA_RPC_RETRY.deadlineMs < SOLANA_POOL_QUOTE_MAX_AGE_SLOTS * 360);
  assert.ok(SOLANA_RPC_RETRY.attemptMs < SOLANA_RPC_RETRY.deadlineMs, "a stall leaves room for a second attempt");
});

test("with retry, a forever-throttled read ends inside the quote's window, measured", async () => {
  const p = provider(Array.from({ length: 1000 }, () => ({ status: 429, body: "", headers: { "retry-after": "1" } })));
  const t0 = Date.now();
  const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: SOLANA_RPC_RETRY })("getLatestBlockhash", []).catch((x: unknown) => x);
  const took = Date.now() - t0;
  assert.ok(e instanceof SolanaRpcTransportError);
  assert.ok(took <= SOLANA_RPC_RETRY.deadlineMs, `took ${took} ms`);
  assert.ok(2 * took < SOLANA_POOL_QUOTE_MAX_AGE_SLOTS * 360);
});

test("with retry, anything that is not a transport fault rejects at once: an RPC error, a 4xx, a foreign id", async () => {
  for (const a of [
    rpcError(-32602),
    { status: 403, body: "forbidden" },
    { body: JSON.stringify({ jsonrpc: "2.0", id: "x", result: 1 }) },
  ] as Answer[]) {
    const p = provider([a]);
    const e = await solanaJsonRpc("https://rpc.example", { fetch: p.fetch, retry: FAST })("getSlot", []).catch((x: unknown) => x);
    assert.ok(e instanceof Error && !(e instanceof SolanaRpcTransportError), String(e));
    assert.equal(p.tries(), 1);
  }
});

test("without retry, one attempt: a 429 rejects as HTTP 429, as before", async () => {
  const p = provider([{ status: 429, body: "" }]);
  await assert.rejects(solanaJsonRpc("https://rpc.example", { fetch: p.fetch })("getSlot", []), (e: Error) => e.message === "HTTP 429" && !(e instanceof SolanaRpcTransportError));
  assert.equal(p.tries(), 1);
});
