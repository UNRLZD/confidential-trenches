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

// card helper-abuse-limits (M367 (3)): a provider's 429 is answered to the caller that drew it, as 429 with the
// provider's reset, and pauses nobody else (at be4b353 it paused the chain for every caller and answered 503)
test("a provider's 429 answers that caller 429 with its reset as Retry-After, and the chain stays open to the next caller", async () => {
  let t = 1_800_000_000_000;
  const r = createRpc({ SOLANA_RPC_URL: base, NEAR_RPC_URL: base }, { now: () => (t += 5) });
  const ok = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x"] };
  next = { status: 429, type: JSON_T, body: () => JSON.stringify({ error: "slow down from the provider" }), headers: { "retry-after": "5" } };
  seen.length = 0;
  const a = await r.handle("solana", JSON_T, JSON.stringify(ok), "heavy");
  assert.deepEqual([a.status, a.headers, JSON.parse(a.body)], [429, { "Retry-After": "5" }, { error: { code: "rate_limited" } }], "the code only: no provider text");
  next = { status: 200, type: JSON_T, body: echo };
  const b = await r.handle("solana", JSON_T, JSON.stringify(ok), "honest");
  assert.equal(b.status, 200, "another caller is not paused");
  assert.equal(seen.length, 2, "the chain was asked again at once");
  assert.equal((await call(r, "near", { ...ok, method: "block" })).status, 200);
  // a reset past a minute is held to 60 s, a missing one is 1 s
  next = { status: 429, type: JSON_T, body: () => "{}", headers: { "retry-after": "3600" } };
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "c")).headers?.["Retry-After"], "60");
  next = { status: 429, type: JSON_T, body: () => "{}" };
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "c")).headers?.["Retry-After"], "1");
});

test("each chain is one budget callers draw from fairly: a heavy caller is throttled at RPC_CLIENT_MAX while an honest one still goes; the helper's own reads draw nothing", async () => {
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
  assert.ok(RPC_CLIENT_MAX * 5 <= RPC_CHAIN_MAX, "five callers at their full share before anyone else is throttled");
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
