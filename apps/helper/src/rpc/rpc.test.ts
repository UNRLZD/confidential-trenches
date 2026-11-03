// node --test apps/helper/src/rpc/rpc.test.ts: POST /v1/rpc/{chain} (markets paper H7, M:3335, and 7.1, M:3275) against
// a local stub provider on a free port. Only allowlisted methods are forwarded, rebuilt from what was checked; every
// other request is refused before any call; the provider's URL key never reaches the answer; a failing provider
// answers 503 upstream. The allowlist is the kit's, compared through the kit's public entry.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { HELPER_RPC_BATCH_MAX, HELPER_RPC_METHODS, HELPER_V1_PATHS } from "../../../../packages/kit/src/index.ts";
import { RPC_BATCH_MAX, RPC_BODY_MAX, RPC_CHAINS, RPC_METHODS } from "./methods.ts";
import * as rpcModule from "./rpc.ts";
import { createRpc, readUpstreams, RPC_ANSWER_MAX, RPC_UPSTREAMS } from "./rpc.ts";
// read off the module, so this file still loads at a base without them and its tests fail on the behaviour (red runs)
const { RPC_CHAIN_MAX, RPC_CLIENT_MAX } = rpcModule as unknown as { RPC_CHAIN_MAX: number; RPC_CLIENT_MAX: number };

const KEY = "fake-helius-key-0123456789abcdef";
type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
// what the stub answers next: status, content type, body (a function of the request body)
let next: { status: number; type: string; body: (req: string) => string; headers?: Record<string, string> } = {
  status: 200,
  type: "application/json",
  body: () => "",
};
const stub = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body });
    res.writeHead(next.status, { "content-type": next.type, ...next.headers });
    res.end(next.body(body));
  });
});
let base = "";
before(() => new Promise<void>((ok) => stub.listen(0, "127.0.0.1", () => ((base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`), ok()))));
after(() => new Promise<void>((ok) => (stub.closeAllConnections(), stub.close(() => ok()))));

// a JSON-RPC echo: one result per request, the id kept
const echo = (req: string) => {
  const p = JSON.parse(req);
  const one = (r: { id: unknown }) => ({ jsonrpc: "2.0", id: r.id, result: "0x1" });
  return JSON.stringify(Array.isArray(p) ? p.map(one) : one(p));
};
const rpc = () => createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, BASE_RPC_URL: `${base}/v2/${KEY}`, ROBINHOOD_RPC_URL: base, NEAR_RPC_URL: base });
const JSON_T = "application/json";
const call = (r: ReturnType<typeof createRpc>, chain: string, body: unknown, type: string | undefined = JSON_T) =>
  r.handle(chain, type, typeof body === "string" ? body : JSON.stringify(body));
const code = (a: { body: string }) => JSON.parse(a.body).error?.code;

test("the allowlist, batch size and body limit are the kit's (a change goes through packages/kit/src/helper/v1.ts)", () => {
  assert.deepEqual([...RPC_CHAINS], Object.keys(HELPER_RPC_METHODS));
  for (const c of RPC_CHAINS) assert.deepEqual([...RPC_METHODS[c]], [...HELPER_RPC_METHODS[c]], c);
  assert.equal(RPC_BATCH_MAX, HELPER_RPC_BATCH_MAX);
  const row = HELPER_V1_PATHS.find((p) => p.path === "/v1/rpc/{chain}");
  assert.equal(row?.limitBytes, RPC_BODY_MAX);
  assert.equal(row?.part, "proxy");
  assert.deepEqual(Object.keys(RPC_UPSTREAMS), [...RPC_CHAINS]);
});

test("an allowlisted call on each chain is forwarded to that chain's provider and its answer passed back", async () => {
  next = { status: 200, type: "application/json; charset=utf-8", body: echo };
  const r = rpc();
  const cases: [string, string, string][] = [
    ["solana", "getBalance", `/?api-key=${KEY}`],
    ["base", "eth_blockNumber", `/v2/${KEY}`],
    ["robinhood", "eth_getLogs", "/"],
    ["near", "EXPERIMENTAL_tx_status", "/"],
  ];
  for (const [chain, method, url] of cases) {
    seen.length = 0;
    const a = await call(r, chain, { jsonrpc: "2.0", id: 7, method, params: [] });
    assert.equal(a.status, 200, chain);
    assert.deepEqual(JSON.parse(a.body), { jsonrpc: "2.0", id: 7, result: "0x1" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, url);
    assert.equal(seen[0]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen[0]!.body), { jsonrpc: "2.0", id: 7, method, params: [] });
  }
});

test("the kit's Solana set send reads are forwarded: isBlockhashValid (card solana-set-send), the finalized blockhash, statuses and the send", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = rpc();
  for (const [method, params] of [
    ["isBlockhashValid", ["J7rBdM6AecPDEZp8aPq5iPSNKVkU5Q76F3oAV4eW5wsW", { commitment: "processed" }]],
    ["getLatestBlockhash", [{ commitment: "finalized" }]],
    ["getSignatureStatuses", [["x"], { searchTransactionHistory: true }]],
    ["sendTransaction", ["AQ==", { encoding: "base64", skipPreflight: true, maxRetries: 0 }]],
  ] as const) {
    seen.length = 0;
    const a = await call(r, "solana", { jsonrpc: "2.0", id: "12", method, params });
    assert.equal(a.status, 200, method);
    assert.equal(seen.length, 1, method);
    assert.deepEqual(JSON.parse(seen[0]!.body), { jsonrpc: "2.0", id: "12", method, params });
  }
});

test("no header of the caller reaches the provider: the helper sends its own few", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  seen.length = 0;
  await call(rpc(), "near", { jsonrpc: "2.0", id: "a", method: "block", params: { finality: "final" } });
  const names = Object.keys(seen[0]!.headers).filter((h) => !["host", "connection", "content-length", "accept-encoding", "sec-fetch-mode", "accept-language", "user-agent"].includes(h));
  assert.deepEqual(names.sort(), ["accept", "content-type"]);
});

test("a batch of 1 to 10 allowlisted calls is forwarded as one; 11 is too_large, 0 is refused", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = rpc();
  const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getAccountInfo", params: ["x"] }));
  seen.length = 0;
  const ten = await call(r, "solana", batch(10));
  assert.equal(ten.status, 200);
  assert.equal(JSON.parse(ten.body).length, 10);
  assert.equal(seen.length, 1);
  const eleven = await call(r, "solana", batch(11));
  assert.deepEqual([eleven.status, code(eleven)], [413, "too_large"]);
  const none = await call(r, "solana", []);
  assert.deepEqual([none.status, code(none)], [400, "method_not_allowed"]);
  assert.equal(seen.length, 1, "nothing refused reaches the provider");
});

test("refused before any call: an unlisted method, alone or anywhere in a batch, and another chain's method", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = rpc();
  seen.length = 0;
  const refused: [string, unknown][] = [
    ["solana", { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }],
    ["base", { jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [] }],
    ["base", { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: [] }],
    ["near", { jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_changes", params: {} }],
    ["near", { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }],
    ["solana", { jsonrpc: "2.0", id: 1, method: "query", params: {} }],
    ["solana", { jsonrpc: "2.0", id: 1, method: "constructor" }],
    ["solana", { jsonrpc: "2.0", id: 1, method: "toString" }],
    ["base", [{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }, { jsonrpc: "2.0", id: 2, method: "admin_peers", params: [] }]],
  ];
  for (const [chain, body] of refused) {
    const a = await call(r, chain, body);
    assert.deepEqual([a.status, code(a)], [400, "method_not_allowed"], JSON.stringify(body));
  }
  assert.equal(seen.length, 0);
});

test("a repeated key cannot smuggle a method: what is forwarded is what was checked", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = rpc();
  seen.length = 0;
  // JSON.parse keeps the last "method"; a provider that keeps the first would have run debug_traceTransaction
  const a = await call(r, "base", '{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","method":"eth_call","params":[]}');
  assert.equal(a.status, 200);
  assert.equal(seen[0]!.body, '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}');
  // the other order: the last one is off the list, so it is refused
  const b = await call(r, "base", '{"jsonrpc":"2.0","id":1,"method":"eth_call","method":"debug_traceTransaction","params":[]}');
  assert.deepEqual([b.status, code(b)], [400, "method_not_allowed"]);
  assert.equal(seen.length, 1);
});

test("numbers in params reach the provider digit for digit, past 2^53 and as written", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  seen.length = 0;
  const text = '{"jsonrpc":"2.0","id":3,"method":"getAccountInfo","params":["x",{"minContextSlot":18446744073709551615,"f":1.50,"g":1e3}]}';
  const a = await call(rpc(), "solana", text);
  assert.equal(a.status, 200);
  assert.equal(seen[0]!.body, text);
});

test("refused: not JSON, wrong content type, a bad request shape, too large", async () => {
  const r = rpc();
  seen.length = 0;
  const ok = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [] };
  for (const type of [undefined, "", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"]) {
    const a = await r.handle("base", type, JSON.stringify(ok));
    assert.deepEqual([a.status, code(a)], [400, "method_not_allowed"], String(type));
  }
  const shapes: unknown[] = [
    "not json",
    "",
    "null",
    "1",
    '"eth_call"',
    { ...ok, jsonrpc: "1.0" },
    { id: 1, method: "eth_call" },
    { jsonrpc: "2.0", method: "eth_call", params: [] }, // a notification: no id
    { ...ok, id: null },
    { ...ok, id: 1.5 },
    { ...ok, id: { a: 1 } },
    { ...ok, id: "x".repeat(129) },
    '{"jsonrpc":"2.0","id":123456789012345678901,"method":"eth_call","params":[]}',
    { ...ok, params: "0x1" },
    { ...ok, params: 5 },
    { ...ok, extra: 1 },
    '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[],"__proto__":{"method":"admin_peers"}}',
    [[ok]],
    [null],
    "[".repeat(100_000) + "]".repeat(100_000),
  ];
  for (const body of shapes) {
    const a = await call(r, "base", body);
    assert.deepEqual([a.status, code(a)], [400, "method_not_allowed"], String(JSON.stringify(body)).slice(0, 80));
  }
  const big = await call(r, "base", { ...ok, params: ["x".repeat(RPC_BODY_MAX)] });
  assert.deepEqual([big.status, code(big)], [413, "too_large"]);
  const chain = await call(r, "ethereum", ok);
  assert.deepEqual([chain.status, code(chain)], [404, "not_found"]);
  for (const c of ["__proto__", "constructor", "Solana", "solana "]) assert.equal((await call(r, c, ok)).status, 404, c);
  assert.equal(seen.length, 0);
});

test("the provider's URL key never reaches the answer, in any form: 503 upstream", async () => {
  const r = rpc();
  const ok = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] };
  for (const leak of [KEY, Buffer.from(KEY).toString("base64"), Buffer.from(KEY).toString("base64url"), `${base}/?api-key=${KEY}`]) {
    next = { status: 200, type: JSON_T, body: () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `bad request to ${leak}` } }) };
    const a = await call(r, "solana", ok);
    assert.deepEqual([a.status, code(a)], [503, "upstream"], leak);
    assert.ok(!a.body.includes(KEY));
  }
  // the path key of an Alchemy-style URL too
  next = { status: 200, type: JSON_T, body: () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: `/v2/${KEY}` }) };
  assert.equal((await call(r, "base", { ...ok, method: "eth_call" })).status, 503);
});

test("a provider that fails answers 503 upstream: 5xx, 401, 403, a redirect, not JSON, oversize, a dead socket", async () => {
  const r = rpc();
  const ok = { jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } };
  const bad = [
    { status: 500, type: JSON_T, body: () => "{}" },
    { status: 502, type: "text/html", body: () => "<html>" },
    { status: 401, type: JSON_T, body: () => "{}" },
    { status: 403, type: JSON_T, body: () => "{}" },
    { status: 302, type: JSON_T, body: () => "{}", headers: { location: "https://example.com/" } },
    { status: 200, type: "text/plain", body: () => "{}" },
    { status: 200, type: JSON_T, body: () => "{not json" },
    { status: 200, type: JSON_T, body: () => JSON.stringify({ r: "x".repeat(RPC_ANSWER_MAX) }) },
  ];
  for (const b of bad) {
    next = b;
    const a = await call(r, "near", ok);
    assert.deepEqual([a.status, code(a)], [503, "upstream"], `${b.status} ${b.type}`);
  }
  // a JSON-RPC error answered as 400 by the provider is the provider's answer, passed back
  next = { status: 400, type: JSON_T, body: () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }) };
  const e = await call(r, "near", ok);
  assert.equal(e.status, 400);
  assert.equal(JSON.parse(e.body).error.code, -32602);
  const dead = createRpc({ NEAR_RPC_URL: "http://127.0.0.1:1" });
  assert.deepEqual(code(await call(dead, "near", ok)), "upstream");
});

// card helper-abuse-limits (M367 (3), review finding 3): the helper is the provider's one client, so a provider's 429
// holds the chain until the reset it named and every caller is told the seconds left as a 429 (at be4b353 the pause
// answered 503, which the device reads as fatal; at 06a656f the next caller still reached the provider)
test("a provider's 429 holds that chain until the reset it named (at most a minute): every caller, the helper's own reads included, gets 429 with the seconds left and nothing reaches the provider", async () => {
  let t = 1_800_000_000_000;
  const r = createRpc({ SOLANA_RPC_URL: base, NEAR_RPC_URL: base }, { now: () => t });
  const ok = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] };
  next = { status: 429, type: JSON_T, body: () => JSON.stringify({ error: "slow down from the provider" }), headers: { "retry-after": "5" } };
  seen.length = 0;
  const a = await r.handle("solana", JSON_T, JSON.stringify(ok), "heavy");
  assert.deepEqual([a.status, a.headers, JSON.parse(a.body)], [429, { "Retry-After": "5" }, { error: { code: "rate_limited" } }], "the code only: no provider text");
  next = { status: 200, type: JSON_T, body: echo };
  t += 2_000;
  const b = await r.handle("solana", JSON_T, JSON.stringify(ok), "honest");
  assert.deepEqual([b.status, b.headers?.["Retry-After"]], [429, "3"], "another caller waits out the provider's reset too");
  assert.equal((await call(r, "solana", ok)).status, 429, "and so does the helper's own read");
  assert.equal(seen.length, 1, "nothing reached the provider inside its reset");
  assert.equal((await call(r, "near", { ...ok, method: "block" })).status, 200, "another chain is not held");
  t += 3_000;
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "honest")).status, 200, "at the reset the chain is open");
  // a reset past a minute is held to 60 s, a missing one is 1 s
  next = { status: 429, type: JSON_T, body: () => "{}", headers: { "retry-after": "3600" } };
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "c")).headers?.["Retry-After"], "60");
  t += 60_000;
  next = { status: 429, type: JSON_T, body: () => "{}" };
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "c")).headers?.["Retry-After"], "1");
});

// a provider in memory that keeps its own published limit: past `limit` calls a window it answers 429 (Retry-After 10)
const keepsLimit = (limit: number, now: () => number) => {
  const p = { calls: 0, throttled: 0, window: -1, inWindow: 0 };
  const fetch = async (_u: string, init: RequestInit): Promise<Response> => {
    const w = Math.floor(now() / 10_000);
    if (w !== p.window) ((p.window = w), (p.inWindow = 0));
    const body = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
    const n = Array.isArray(body) ? body.length : 1;
    p.calls += n;
    p.inWindow += n;
    if (p.inWindow > limit) return (p.throttled++, new Response("slow down", { status: 429, headers: { "retry-after": "10" } }));
    const one = (r: { id: unknown }) => ({ jsonrpc: "2.0", id: r.id, result: 1 });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { p, fetch };
};
const getBalance = (id = 1) => ({ jsonrpc: "2.0", id, method: "getBalance", params: [] });

test("end state 2: no single caller can trigger a hold by itself, because the per-client share stays under the provider's own limit", async () => {
  let t = 1_800_000_000_000;
  const now = () => (t += 1);
  const provider = keepsLimit(RPC_CHAIN_MAX, () => t);
  const r = createRpc({}, { now, fetch: provider.fetch as never });
  assert.ok(RPC_CLIENT_MAX < RPC_CHAIN_MAX, "the share is under the provider's limit");
  const batch = JSON.stringify(Array.from({ length: RPC_BATCH_MAX }, (_, i) => getBalance(i + 1)));
  for (let i = 0; i < 300; i++) {
    await r.handle("solana", JSON_T, batch, "heavy");
    await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "heavy");
  }
  assert.equal(provider.p.throttled, 0, "the provider never throttled: no hold");
  assert.ok(provider.p.calls <= RPC_CLIENT_MAX, `one caller reached the provider ${provider.p.calls} times`);
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "honest")).status, 200, "an honest caller is served");
});

test("an EVM provider's -32005 (EIP-1474 limit exceeded) is its throttle: 429 with its backoff and the chain held; any other -320xx, and -32005 on Solana or NEAR, passes through", async () => {
  let t = 1_800_000_000_000;
  let calls = 0;
  let answer: unknown = null;
  const r = createRpc({}, { now: () => t, fetch: (async () => (calls++, new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }))) as never });
  const evm = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  answer = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "project ID request rate exceeded", data: { backoff_seconds: 3 } } };
  const a = await r.handle("base", JSON_T, evm, "x");
  assert.deepEqual([a.status, a.headers?.["Retry-After"], JSON.parse(a.body)], [429, "3", { error: { code: "rate_limited" } }], "the code only, the backoff named");
  answer = { jsonrpc: "2.0", id: 1, result: "0x1" };
  assert.equal((await r.handle("base", JSON_T, evm, "y")).status, 429, "the chain is held for every caller");
  assert.equal(calls, 1);
  t += 3_000;
  assert.equal((await r.handle("base", JSON_T, evm, "y")).status, 200, "at the backoff's end");
  // a batch with one -32005 in it; no backoff named: 1 s
  answer = [{ jsonrpc: "2.0", id: 1, result: "0x1" }, { jsonrpc: "2.0", id: 2, error: { code: -32005, message: "limit exceeded" } }];
  const b = await r.handle("robinhood", JSON_T, JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }]), "x");
  assert.deepEqual([b.status, b.headers?.["Retry-After"]], [429, "1"]);
  for (const [chain, body, code] of [["base", evm, -32002], ["base", evm, -32603], ["solana", JSON.stringify(getBalance()), -32005]] as const) {
    answer = { jsonrpc: "2.0", id: 1, error: { code, message: "x" } };
    const c = await r.handle(chain, JSON_T, body, "z");
    assert.deepEqual([c.status, JSON.parse(c.body).error.code], [200, code], `${chain} ${code} is the provider's answer`);
  }
});

test("review F-A: a batch draws its size, so the provider sees at most RPC_CLIENT_MAX calls per client and RPC_CHAIN_MAX per chain a window", async () => {
  let calls = 0;
  let t = 1_800_000_000_000;
  const r = createRpc({}, { now: () => (t += 1), fetch: (async (_u: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); calls += Array.isArray(b) ? b.length : 1; return new Response(JSON.stringify(Array.isArray(b) ? b.map((x: { id: number }) => ({ jsonrpc: "2.0", id: x.id, result: 1 })) : { jsonrpc: "2.0", id: b.id, result: 1 }), { status: 200, headers: { "content-type": "application/json" } }); }) as never });
  const batch = JSON.stringify(Array.from({ length: RPC_BATCH_MAX }, (_, i) => getBalance(i + 1)));
  for (let i = 0; i < RPC_CLIENT_MAX + 5; i++) await r.handle("solana", JSON_T, batch, "203.0.113.1");
  assert.ok(calls <= RPC_CLIENT_MAX, `one client: ${calls} provider calls`);
  for (let c = 2; c <= 20; c++) for (let i = 0; i < RPC_CLIENT_MAX; i++) await r.handle("solana", JSON_T, batch, `203.0.113.${c}`);
  assert.ok(calls <= RPC_CHAIN_MAX, `twenty clients: ${calls} provider calls > RPC_CHAIN_MAX ${RPC_CHAIN_MAX}`);
});

test("review F-B: after a provider 429 with Retry-After 30, zero provider calls inside those 30 s", async () => {
  let calls = 0;
  let t = 1_800_000_000_000;
  const r = createRpc({}, { now: () => (t += 1), fetch: (async () => (calls++, new Response("slow down", { status: 429, headers: { "retry-after": "30" } }))) as never });
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "203.0.113.1")).status, 429);
  for (let c = 2; c <= 21; c++) assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), `203.0.113.${c}`)).status, 429);
  t += 29_000;
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()))).status, 429, "the helper's own read waits too");
  assert.equal(calls, 1, `the provider was called ${calls - 1} more times inside the reset it named`);
});

test("review F-D: more than five addresses at their full share are needed to throttle an honest first-time caller (a provider with no limit per method)", async () => {
  let t = 1_800_000_000_000;
  const r = createRpc({ RPC_BUDGET_SOLANA: `${RPC_CHAIN_MAX},${RPC_CLIENT_MAX}` }, { now: () => (t += 1), fetch: (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as never });
  let n = 0;
  for (; n < 100; n++) {
    for (let i = 0; i < RPC_CLIENT_MAX; i++) await r.handle("solana", JSON_T, JSON.stringify(getBalance()), `198.51.100.${n}`);
    if ((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "192.0.2.200")).status === 429) break;
  }
  assert.ok(n + 1 > 5, `${n + 1} addresses lock out an honest caller`);
});

test("each chain's budget is RPC_BUDGET_<CHAIN> when set (\"<total>,<per client>[,<per method>]\"), else the provider's published limit; a bad value stops the start naming the variable", () => {
  let calls = 0;
  let t = 1_800_000_000_000;
  const f = (async () => (calls++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200, headers: { "content-type": "application/json" } }))) as never;
  assert.throws(() => createRpc({ RPC_BUDGET_BASE: "16,16" }, { fetch: f }), /^Error: RPC_BUDGET_BASE must be/);
  assert.throws(() => createRpc({ RPC_BUDGET_SOLANA: "lots" }, { fetch: f }), (e: Error) => !e.message.includes("lots"));
  const r = createRpc({ RPC_BUDGET_SOLANA: "20,12" }, { now: () => (t += 1), fetch: f });
  return (async () => {
    for (let i = 0; i < 13; i++) await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "a");
    assert.equal(calls, 12, "the share from the environment");
    for (let i = 0; i < 13; i++) await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "b");
    assert.equal(calls, 20, "the total from the environment (two numbers: no limit per method)");
    for (let i = 0; i < RPC_CLIENT_MAX + 1; i++) await r.handle("base", JSON_T, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), "a");
    assert.equal(calls, 20 + RPC_CLIENT_MAX, "another chain keeps the default");
  })();
});

test("re-check env: an RPC_BUDGET_<CHAIN> whose share is under a full batch (RPC_BATCH_MAX), or whose method limit is under a batch or over the total, stops the start naming the variable only", () => {
  for (const [name, bad] of [["RPC_BUDGET_SOLANA", "100,5"], ["RPC_BUDGET_SOLANA", `100,${RPC_BATCH_MAX - 1}`], ["RPC_BUDGET_BASE", "50,9"], ["RPC_BUDGET_SOLANA", "100,16,9"], ["RPC_BUDGET_NEAR", "100,16,101"]] as const)
    assert.throws(() => createRpc({ [name]: bad }), (e: Error) => e.message.startsWith(`${name} must be`) && !e.message.includes(bad), `${name}=${bad}`);
  assert.doesNotThrow(() => createRpc({ RPC_BUDGET_SOLANA: `100,${RPC_BATCH_MAX}`, RPC_BUDGET_BASE: "500,50,40" }));
});

test("re-check F-D solana: under the public endpoint's limits (100 a 10 s, 40 a 10 s for one method, rolling), callers at their share of one method never make it throttle, and an honest caller of another method is served", async () => {
  let t = 1_800_000_000_000;
  const all: number[] = [];
  const per = new Map<string, number[]>();
  let refused = 0;
  const roll = (a: number[]) => {
    while (a.length && t - a[0]! >= 10_000) a.shift();
  };
  const f = (async (_u: string, i: RequestInit) => {
    const b = JSON.parse(String(i.body));
    const reqs: { id: number; method: string }[] = Array.isArray(b) ? b : [b];
    roll(all);
    for (const q of reqs) {
      const a = per.get(q.method) ?? [];
      roll(a);
      per.set(q.method, a);
    }
    const asked = new Map<string, number>();
    for (const q of reqs) asked.set(q.method, (asked.get(q.method) ?? 0) + 1);
    if (all.length + reqs.length > 100 || [...asked].some(([m, k]) => per.get(m)!.length + k > 40)) return (refused++, new Response("slow", { status: 429 }));
    for (const q of reqs) (all.push(t), per.get(q.method)!.push(t));
    const out = reqs.map((q) => ({ jsonrpc: "2.0", id: q.id, result: 1 }));
    return new Response(JSON.stringify(Array.isArray(b) ? out : out[0]), { status: 200, headers: { "content-type": "application/json" } });
  }) as never;
  const r = createRpc({}, { now: () => t, fetch: f });
  const one = (method: string, id = 1) => ({ jsonrpc: "2.0", id, method, params: [] });
  let served = 0;
  let honest = 0;
  // two minutes: every 250 ms, 20 addresses send their share of getSignatureStatuses, one by one and in full batches;
  // each second the helper's own read and a fresh honest caller of another method go between
  for (let step = 0; step < 480; step++, t += 250) {
    for (let a = 0; a < 20; a++) {
      const body = a % 2 ? JSON.stringify(one("getSignatureStatuses")) : JSON.stringify(Array.from({ length: RPC_BATCH_MAX }, (_, k) => one("getSignatureStatuses", k + 1)));
      if ((await r.handle("solana", JSON_T, body, `198.51.100.${a}`)).status === 200) served++;
    }
    if (step % 4 === 1) await r.handle("solana", JSON_T, JSON.stringify(one("getLatestBlockhash")));
    if (step % 4 === 3 && (await r.handle("solana", JSON_T, JSON.stringify(one("getLatestBlockhash")), `192.0.2.${step % 250}`)).status === 200) honest++;
  }
  assert.equal(refused, 0, "the endpoint never answered 429");
  assert.equal(honest, 120, "every honest call of another method was served");
  assert.ok(served > 0, "the busy method is served up to its limit");
});

test("re-check F-D: the helper's own reads (no caller) draw from the chain's total, so with callers they never take it past the provider's limit", async () => {
  let calls = 0;
  let t = 1_800_000_000_000;
  const f = (async () => (calls++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200, headers: { "content-type": "application/json" } }))) as never;
  const r = createRpc({ RPC_BUDGET_SOLANA: "20,12" }, { now: () => t, fetch: f });
  for (let i = 0; i < 20; i++) assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()))).status, 200, `own read ${i + 1}`);
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()))).status, 429, "the 21st own read in 10 s waits");
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "device")).status, 429, "and so does a device: the total is spent");
  assert.equal(calls, 20);
  t += 11_000;
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "device")).status, 200, "once they leave the provider's window");
});

test("each chain is one budget callers draw from fairly: a heavy caller is throttled at RPC_CLIENT_MAX while an honest one still goes; the helper's own reads draw from no share", async () => {
  let t = 1_800_000_000_000;
  const r = createRpc({ SOLANA_RPC_URL: base, NEAR_RPC_URL: base }, { now: () => (t += 1) });
  const ok = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] });
  next = { status: 200, type: JSON_T, body: echo };
  seen.length = 0;
  for (let i = 0; i < RPC_CLIENT_MAX; i++) assert.equal((await r.handle("solana", JSON_T, ok, "heavy")).status, 200);
  const h = await r.handle("solana", JSON_T, ok, "heavy");
  assert.equal(h.status, 429);
  assert.deepEqual(JSON.parse(h.body), { error: { code: "rate_limited" } });
  const wait = Number(h.headers?.["Retry-After"]);
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 10, `Retry-After ${wait}`);
  assert.equal(seen.length, RPC_CLIENT_MAX, "the throttled draw never reached the provider");
  assert.equal((await r.handle("solana", JSON_T, ok, "honest")).status, 200, "an honest caller in the same window");
  assert.equal((await r.handle("near", JSON_T, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }), "heavy")).status, 200, "another chain is its own budget");
  assert.equal((await r.handle("solana", JSON_T, ok)).status, 200, "the helper's own read (no caller) draws from no share");
  t += wait * 1000;
  assert.equal((await r.handle("solana", JSON_T, ok, "heavy")).status, 200, "after the named wait the heavy caller goes again");
  assert.ok(RPC_CLIENT_MAX * 6 <= RPC_CHAIN_MAX, "six callers at their full share before anyone else is throttled");
});

test("provider URLs: from the environment, http(s) only; an error names the variable, never the value; a public default", () => {
  const d = readUpstreams({});
  for (const c of RPC_CHAINS) {
    assert.match(d[c].url, /^https:\/\//);
    assert.deepEqual(d[c].forms, []);
  }
  for (const bad of ["not a url", "ftp://x.example/", "file:///etc/passwd", "https://x.example/#frag", "javascript:alert(1)"]) {
    assert.throws(
      () => readUpstreams({ BASE_RPC_URL: bad }),
      (e: Error) => e.message.startsWith("BASE_RPC_URL must be") && !e.message.includes(bad),
      bad,
    );
  }
});
