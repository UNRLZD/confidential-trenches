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
import { providerHolds, RETRY_AFTER_MAX_S } from "../limits/limits.ts";
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
  // the kit's chains, then the testnet build's second Solana provider (card pool-buy-send-fast) on the kit's Solana list
  assert.deepEqual([...RPC_CHAINS], [...Object.keys(HELPER_RPC_METHODS), "solana-devnet"]);
  // solana-devnet adds getGenesisHash alone (card live-check-devnet-pair)
  for (const c of RPC_CHAINS) assert.deepEqual([...RPC_METHODS[c]], c === "solana-devnet" ? [...HELPER_RPC_METHODS.solana, "getGenesisHash"] : [...HELPER_RPC_METHODS[c]], c);
  assert.equal(RPC_BATCH_MAX, HELPER_RPC_BATCH_MAX);
  const row = HELPER_V1_PATHS.find((p) => p.path === "/v1/rpc/{chain}");
  assert.equal(row?.limitBytes, RPC_BODY_MAX);
  assert.equal(row?.part, "proxy");
  assert.deepEqual(Object.keys(RPC_UPSTREAMS), [...RPC_CHAINS]);
});

test("card live-check-devnet-pair: solana-devnet forwards getGenesisHash to SOLANA_DEVNET_RPC_URL (the devnet live checks read the cluster on each provider); mainnet solana still refuses it before any call", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: `${base}/devnet` });
  seen.length = 0;
  const a = await call(r, "solana-devnet", { jsonrpc: "2.0", id: 4, method: "getGenesisHash", params: [] });
  assert.equal(a.status, 200);
  assert.deepEqual([seen.length, seen[0]?.url], [1, "/devnet"]);
  seen.length = 0;
  const m = await call(r, "solana", { jsonrpc: "2.0", id: 4, method: "getGenesisHash", params: [] });
  assert.deepEqual([m.status, code(m), seen.length], [400, "method_not_allowed", 0]);
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

test("solana-devnet (card pool-buy-send-fast): the kit's Solana list forwarded to SOLANA_DEVNET_RPC_URL, its key never in the answer; anything else refused before any call", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const DEV = "fake-devnet-key-0123456789abcdef";
  const r = createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: `${base}/devnet?api-key=${DEV}` });
  // the reads a pool buy makes (packages/signpage/src/pool-buy.ts), each to the devnet URL, never the mainnet one
  for (const method of ["getAccountInfo", "getMultipleAccounts", "getLatestBlockhash", "isBlockhashValid", "getBlockHeight", "getTransaction", "getSlot", "getSignaturesForAddress", "getFeeForMessage", "getBlockTime", "getEpochInfo"]) {
    seen.length = 0;
    const a = await call(r, "solana-devnet", { jsonrpc: "2.0", id: 3, method, params: [] });
    assert.equal(a.status, 200, method);
    assert.equal(seen.length, 1, method);
    assert.equal(seen[0]!.url, `/devnet?api-key=${DEV}`, method);
  }
  seen.length = 0;
  for (const method of ["eth_blockNumber", "EXPERIMENTAL_tx_status", "requestAirdrop", "getClusterNodes"])
    assert.deepEqual([(await call(r, "solana-devnet", { jsonrpc: "2.0", id: 1, method, params: [] })).status, seen.length], [400, 0], method);
  for (const c of ["solana_devnet", "Solana-devnet", "solana-devnet ", "solana-testnet"]) assert.equal((await call(r, c, { jsonrpc: "2.0", id: 1, method: "getSlot" })).status, 404, c);
  // the key never reaches the answer
  next = { status: 200, type: JSON_T, body: () => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `bad key ${DEV}` } }) };
  assert.deepEqual([(await call(r, "solana-devnet", { jsonrpc: "2.0", id: 1, method: "getSlot" })).status], [503]);
  // its own budget variable, a name a shell can set
  assert.equal(rpcModule.rpcBudgetEnv("solana-devnet"), "RPC_BUDGET_SOLANA_DEVNET");
});

// review L-2 and its re-review: getProgramAccounts only in the note restore's exact shape, on the route's own pinned
// pool program; an open or wider scan would spend the keyed provider's quota. SPENT and PRE are the two requests the
// wallet's solanaMarks sends (packages/wallet/src/pool/solana-restore.ts, captured from it on 5 Nov 23:33Z for bucket 0
// with minContextSlot 7): a 13-byte spent mark and a 17-byte pre-mark, memcmp at 9 on size - 9 bytes ending in tag 1.
const DEV_PROGRAM = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
const MAIN_PROGRAM = "11111111111111111111111111111111";
type ScanConfig = Record<string, unknown>;
const SPENT: ScanConfig = { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: 7, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] };
const PRE: ScanConfig = { commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: 7, filters: [{ dataSize: 17 }, { memcmp: { offset: 9, bytes: "11111112" } }] };
const scan = (program: string, config: unknown = SPENT, id = 5) => ({ jsonrpc: "2.0", id, method: "getProgramAccounts", params: [program, config] });
const withFilters = (filters: unknown, from: ScanConfig = SPENT): ScanConfig => ({ ...from, filters });
test("getProgramAccounts (review L-2): the restore's two exact shapes on the route's own pinned pool program are forwarded, alone or in a batch, with or without minContextSlot", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  const r = createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: `${base}/devnet`, POOL_SOLANA_PROGRAM_DEVNET: DEV_PROGRAM, POOL_SOLANA_PROGRAM_MAINNET: MAIN_PROGRAM });
  const { minContextSlot: _m, ...noMin } = SPENT;
  for (const [chain, program] of [["solana-devnet", DEV_PROGRAM], ["solana", MAIN_PROGRAM]] as const) {
    seen.length = 0;
    // and a higher bucket: the counter's bytes 05 01 00 past its low byte, then the tag ("8RGtg", @scure/base)
    for (const config of [SPENT, PRE, noMin, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "8RGtg" } }])]) {
      assert.equal((await call(r, chain, scan(program, config))).status, 200, `${chain} ${JSON.stringify(config)}`);
    }
    assert.equal((await call(r, chain, [scan(program, PRE)])).status, 200, `${chain} in a batch`);
    assert.equal(seen.length, 5, chain);
  }
});
// each case differs from SPENT (or PRE) in one thing only, so removing the one rule that refuses it lets it through
const ONE_OFF: readonly [string, string, unknown][] = [
  ["another cluster's program", MAIN_PROGRAM, SPENT],
  ["any other program", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", SPENT],
  ["two dataSize filters", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { dataSize: 13 }])],
  ["the tag byte alone at 12 (every spent mark at once)", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 12, bytes: "2" } }])],
  ["the tag byte alone at 9 (one byte, not 4)", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "2" } }])],
  ["a wrong offset", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 8, bytes: "1112" } }])],
  ["a wrong length: a spent mark's 4 bytes on the pre-mark's size", DEV_PROGRAM, withFilters([{ dataSize: 17 }, { memcmp: { offset: 9, bytes: "1112" } }])],
  ["a last byte that is not the tag", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1113" } }])],
  ["a large dataSize", DEV_PROGRAM, withFilters([{ dataSize: 10240 }, { memcmp: { offset: 9, bytes: "1112" } }])],
  ["another dataSize", DEV_PROGRAM, withFilters([{ dataSize: 12 }, { memcmp: { offset: 9, bytes: "112" } }])],
  ["the filters swapped", DEV_PROGRAM, withFilters([{ memcmp: { offset: 9, bytes: "1112" } }, { dataSize: 13 }])],
  ["a third filter", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }, { dataSize: 13 }])],
  ["the size filter alone", DEV_PROGRAM, withFilters([{ dataSize: 13 }])],
  ["no filters", DEV_PROGRAM, withFilters([])],
  ["a memcmp encoding key", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112", encoding: "base58" } }])],
  ["a size filter with a memcmp key too", DEV_PROGRAM, withFilters([{ dataSize: 13, memcmp: { offset: 9, bytes: "1112" } }, { memcmp: { offset: 9, bytes: "1112" } }])],
  ["a memcmp filter with a dataSize key too", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" }, dataSize: 13 }])],
  ["bytes off the base58 alphabet", DEV_PROGRAM, withFilters([{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "0OIl" } }])],
  ["encoding base64+zstd", DEV_PROGRAM, { ...SPENT, encoding: "base64+zstd" }],
  ["encoding jsonParsed", DEV_PROGRAM, { ...SPENT, encoding: "jsonParsed" }],
  ["a dataSlice", DEV_PROGRAM, { ...SPENT, dataSlice: { offset: 0, length: 0 } }],
  ["sortResults", DEV_PROGRAM, { ...SPENT, sortResults: true }],
  ["changedSinceSlot", DEV_PROGRAM, { ...SPENT, changedSinceSlot: 1 }],
  ["commitment processed", DEV_PROGRAM, { ...SPENT, commitment: "processed" }],
  ["withContext false", DEV_PROGRAM, { ...SPENT, withContext: false }],
  ["minContextSlot not a whole number", DEV_PROGRAM, { ...SPENT, minContextSlot: "7" }],
  ["minContextSlot 0", DEV_PROGRAM, { ...SPENT, minContextSlot: 0 }],
  ["no config", DEV_PROGRAM, undefined],
];
for (const [name, program, config] of ONE_OFF)
  test(`getProgramAccounts (review L-2) refused 400 before any call: ${name}`, async () => {
    next = { status: 200, type: JSON_T, body: echo };
    const r = createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: `${base}/devnet`, POOL_SOLANA_PROGRAM_DEVNET: DEV_PROGRAM, POOL_SOLANA_PROGRAM_MAINNET: MAIN_PROGRAM });
    seen.length = 0;
    const body = config === undefined ? { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [program] } : scan(program, config);
    for (const b of [body, [{ jsonrpc: "2.0", id: 2, method: "getSlot" }, body]]) {
      const a = await call(r, "solana-devnet", b);
      assert.deepEqual([a.status, code(a)], [400, "method_not_allowed"], JSON.stringify(b));
    }
    assert.equal(seen.length, 0, "nothing reached a provider");
  });
test("getProgramAccounts (review L-2): a host with no pinned pool program refuses every scan", async () => {
  const r = createRpc({ SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: `${base}/devnet` });
  seen.length = 0;
  for (const chain of ["solana", "solana-devnet"]) assert.equal((await call(r, chain, scan(DEV_PROGRAM))).status, 400, chain);
  assert.equal(seen.length, 0);
});

test("solana-devnet with no SOLANA_DEVNET_RPC_URL (review L-1): 503 upstream for every call and nothing sent, never the page's own first provider (api.devnet.solana.com) behind the helper's name", async () => {
  next = { status: 200, type: JSON_T, body: echo };
  for (const env of [{ SOLANA_RPC_URL: `${base}/?api-key=${KEY}` }, { SOLANA_RPC_URL: `${base}/?api-key=${KEY}`, SOLANA_DEVNET_RPC_URL: "" }]) {
    const r = createRpc(env);
    seen.length = 0;
    for (const body of [{ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }, [{ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [] }]]) {
      const a = await call(r, "solana-devnet", body);
      assert.deepEqual([a.status, code(a)], [503, "upstream"], JSON.stringify(body));
    }
    assert.equal(seen.length, 0, "nothing reached any provider");
    // the other chains are served as before
    assert.equal((await call(r, "solana", { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] })).status, 200);
  }
  assert.equal(RPC_UPSTREAMS["solana-devnet"].fallback, null);
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
    ["solana", { jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [] }],
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
test("a provider's 429 holds that chain until the reset it named (at most RETRY_AFTER_MAX_S): every caller, the helper's own reads included, gets 429 with the seconds left and nothing reaches the provider", async () => {
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
  // a reset past RETRY_AFTER_MAX_S is held to it (75 s), a missing one is 1 s
  next = { status: 429, type: JSON_T, body: () => "{}", headers: { "retry-after": "3600" } };
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(ok), "c")).headers?.["Retry-After"], String(RETRY_AFTER_MAX_S));
  // (on NEAR: a keyed Solana provider's 429 past its reset is its fall to the public endpoint, card helper-solana-failover)
  next = { status: 429, type: JSON_T, body: () => "{}" };
  assert.equal((await r.handle("near", JSON_T, JSON.stringify({ ...ok, method: "block" }), "c")).headers?.["Retry-After"], "1");
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
    assert.equal(calls, 17, "the total from the environment less Solana's own-read reserve of 3 (two numbers: no limit per method)");
    for (let i = 0; i < RPC_CLIENT_MAX + 1; i++) await r.handle("base", JSON_T, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), "a");
    assert.equal(calls, 17 + RPC_CLIENT_MAX, "another chain keeps the default");
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

test("fold 5: Solana keeps RPC_RESERVE (3 a 10 s) on the chain and on each method for Discover's own reads; callers and unreserved own reads stop short of it", async () => {
  let calls = 0;
  const t = 1_800_000_000_000;
  const f = (async () => (calls++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200, headers: { "content-type": "application/json" } }))) as never;
  const gma = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[]] });
  const r = createRpc({}, { now: () => t, fetch: f });
  let served = 0;
  for (let a = 0; a < 10; a++) for (let i = 0; i < RPC_CLIENT_MAX; i++) if ((await r.handle("solana", JSON_T, gma, `198.51.100.${a}`)).status === 200) served++;
  assert.equal(served, 40 - 3, "callers get the method's 40 less the reserve");
  assert.equal((await r.handle("solana", JSON_T, gma)).status, 429, "an own read not reserved (the token page's) stops with callers");
  for (let i = 0; i < 3; i++) assert.equal((await r.handle("solana", JSON_T, gma, undefined, true)).status, 200, `Discover's read ${i + 1}`);
  assert.equal((await r.handle("solana", JSON_T, gma, undefined, true)).status, 429, "the method's 40 is the limit");
  assert.equal(calls, 40);
  assert.throws(() => createRpc({ RPC_BUDGET_SOLANA: "100,16,12" }), (e: Error) => e.message.startsWith("RPC_BUDGET_SOLANA must be"), "a method's limit must leave a batch past the reserve");
});

test("re-check F-D: the helper's own reads (no caller) draw from the chain's total, so with callers they never take it past the provider's limit", async () => {
  let calls = 0;
  let t = 1_800_000_000_000;
  const f = (async () => (calls++, new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200, headers: { "content-type": "application/json" } }))) as never;
  const r = createRpc({ RPC_BUDGET_SOLANA: "20,12" }, { now: () => t, fetch: f });
  for (let i = 0; i < 20; i++) assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), undefined, true)).status, 200, `own read ${i + 1}`);
  assert.equal((await r.handle("solana", JSON_T, JSON.stringify(getBalance()), undefined, true)).status, 429, "the 21st own read in 10 s waits");
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
  assert.equal((await r.handle("solana", JSON_T, ok, undefined, true)).status, 200, "the helper's own reserved read (no caller) draws from no share");
  // card helper-ready-gate: a background read (no caller, not reserved) leaves the callers' half of the method's 40 free:
  // the callers drew 17 of the 37 they may, so 40 - 3 - 20 = 17 leaves it nothing
  assert.equal((await r.handle("solana", JSON_T, ok)).status, 429, "a background read goes behind callers");
  t += wait * 1000;
  assert.equal((await r.handle("solana", JSON_T, ok, "heavy")).status, 200, "after the named wait the heavy caller goes again");
  assert.ok(RPC_CLIENT_MAX * 6 <= RPC_CHAIN_MAX, "six callers at their full share before anyone else is throttled");
});

test("provider URLs: from the environment, http(s) only; an error names the variable, never the value; a public default (solana-devnet: none, off)", () => {
  const d = readUpstreams({});
  for (const c of RPC_CHAINS) {
    if (c === "solana-devnet") assert.equal(d[c].off, true, c);
    else assert.match(d[c].url, /^https:\/\//);
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

// a keyed provider in memory that keeps a per-second limit, as Helius free does (10 requests/s, research
// scripts/deploy/helius-key.sh:7): past `perSecond` requests sent in any 1 s it answers 429 (Retry-After 1)
// (its window on the monotonic clock, card helper-crowd-429: the box's wall clock steps back under a test)
const keepsPerSecond = (perSecond: number) => {
  const p = { calls: 0, throttled: 0, sent: [] as number[] };
  const fetch = async (_u: string, init: RequestInit): Promise<Response> => {
    const t = performance.now();
    const body = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
    const n = Array.isArray(body) ? body.length : 1;
    p.sent = p.sent.filter((x) => x > t - 1000);
    for (let i = 0; i < n; i++) p.sent.push(t);
    p.calls += n;
    if (p.sent.length > perSecond) return (p.throttled++, new Response("slow down", { status: 429, headers: { "retry-after": "1" } }));
    const one = (r: { id: unknown }) => ({ jsonrpc: "2.0", id: r.id, result: 1 });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { p, fetch };
};

test("card app-console-429: one caller's burst of 35 on a keyed provider (Helius free, 100 per 10 s = 10 a second) is paced to the provider's second, so it never throttles, nothing is held, and another caller's read answers 200", async () => {
  const provider = keepsPerSecond(10);
  const lines: string[] = [];
  const r = createRpc({ SOLANA_RPC_URL: `https://mainnet.helius-rpc.invalid/?api-key=${KEY}`, RPC_BUDGET_SOLANA: "100,16" }, { fetch: provider.fetch as never, log: (l) => lines.push(l) });
  const burst = await Promise.all(Array.from({ length: 35 }, (_, i) => r.handle("solana", JSON_T, JSON.stringify(getBalance(i + 1)), "203.0.113.7")));
  const other = await r.handle("solana", JSON_T, JSON.stringify(getBalance()), "203.0.113.8");
  assert.equal(provider.p.throttled, 0, `the provider never throttled (${provider.p.calls} sent)`);
  assert.deepEqual(lines.filter((l) => l.startsWith("rpc hold")), [], "no hold");
  assert.equal(other.status, 200, "another caller is served");
  assert.equal(burst.filter((a) => a.status === 200).length, 16, "the burst's caller gets its share, RPC_CLIENT_MAX");
  for (const a of burst.filter((x) => x.status !== 200)) assert.equal(a.status, 429, "the rest of the burst is that caller's own 429");
});

test("card app-console-429: past PACE_MAX_MS of queued sends, only the caller over it gets a 429 with no hold; the public endpoint is not paced", async () => {
  const lines: string[] = [];
  const env = { SOLANA_RPC_URL: `https://mainnet.helius-rpc.invalid/?api-key=${KEY}`, RPC_BUDGET_SOLANA: "1000,100" };
  // a plan of 1000 per 10 s is 100 a second: 40 callers at once all go now, none waits
  const r = createRpc(env, { fetch: keepsPerSecond(100).fetch as never, log: (l) => lines.push(l) });
  const t0 = performance.now();
  const all = await Promise.all(Array.from({ length: 40 }, (_, i) => r.handle("solana", JSON_T, JSON.stringify(getBalance(i + 1)), `198.51.100.${i}`)));
  assert.equal(all.filter((a) => a.status === 200).length, 40);
  assert.ok(performance.now() - t0 < 500, "within the plan's second nothing waits");
  const tight = createRpc({ SOLANA_RPC_URL: env.SOLANA_RPC_URL, RPC_BUDGET_SOLANA: "100,90" }, { fetch: keepsPerSecond(10).fetch as never, log: (l) => lines.push(l) });
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => tight.handle("solana", JSON_T, JSON.stringify(getBalance(i + 1)), `198.51.100.${i}`)));
  const refused = many.filter((a) => a.status === 429);
  assert.equal(many.filter((a) => a.status === 200).length, 20, "10 now, 10 a PACE_SECOND_MS later: the room within PACE_MAX_MS");
  assert.equal(refused.length, 20, "the rest are refused, each its own caller's 429");
  for (const a of refused) assert.equal(a.why, "solana pace", "named as the pace, not the provider");
  // the public endpoint (no SOLANA_RPC_URL): its limit is per 10 s, so 20 callers at once all go now
  const pub = createRpc({}, { fetch: keepsPerSecond(100).fetch as never, log: (l) => lines.push(l) });
  const t1 = performance.now();
  const open = await Promise.all(Array.from({ length: 20 }, (_, i) => pub.handle("solana", JSON_T, JSON.stringify(getBalance(i + 1)), `192.0.2.${i}`)));
  assert.deepEqual([open.filter((a) => a.status === 200).length, performance.now() - t1 < 500], [20, true], "not paced");
  assert.deepEqual(lines.filter((l) => l.startsWith("rpc hold")), [], "no hold");
});

test("card helper-rpc-hold-queued: a send waiting for a keyed provider's second is not sent once the provider has asked us to wait in the meantime: it answers 429 with the hold's seconds", async () => {
  // a keyed Base plan of 100 per 10 s: 10 sends go in a second, the 11th waits for the next; the first answer is a 429
  // naming 30 s, which arrives while the 11th waits
  const sent: number[] = [];
  const fetch = async (_u: string, init: RequestInit): Promise<Response> => {
    sent.push(performance.now());
    const body = JSON.parse(String(init.body)) as { id: unknown };
    if (sent.length === 1) return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const lines: string[] = [];
  const r = createRpc({ BASE_RPC_URL: `https://base-mainnet.example.invalid/v2/${KEY}`, RPC_BUDGET_BASE: "100,16" }, { fetch: fetch as never, log: (l) => lines.push(l), now: () => performance.timeOrigin + performance.now() });
  const blockNumber = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] });
  const t0 = performance.now();
  const all = await Promise.all(Array.from({ length: 11 }, (_, i) => r.handle("base", JSON_T, blockNumber(i + 1), `198.51.100.${i}`)));
  assert.ok(performance.now() - t0 >= 1_000, "the 11th waited for the provider's next second");
  assert.equal(sent.length, 10, `${sent.length} sent: the waiting send went out after the provider's 429`);
  const last = all[10]!;
  assert.equal(last.status, 429);
  assert.equal(last.why, "base held");
  assert.ok(Number(last.headers?.["Retry-After"]) >= 28, `Retry-After ${last.headers?.["Retry-After"]}: the hold's seconds`);
  assert.deepEqual(lines.filter((l) => l.startsWith("rpc hold")), ["rpc hold base caller 30 s"]);
});

// -- card evm-rpc-spare-list: a caller's read on an EVM chain reaches any listed provider that answers ----------------

/** What each listed provider answers a caller's read, by how it is down; the last answers. */
const SPARE_DOWN: [string, (url: string) => Promise<Response>][] = [
  ["HTTP 503", async () => new Response("down", { status: 503 })],
  ["a thrown connection error", async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); }],
  ["a JSON-RPC limit error (-32011 request limit reached, mainnet.base.org's answer to every eth_getLogs on 5 Nov)", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "request limit reached" } }), { status: 200, headers: { "content-type": "application/json" } })],
];
for (const [what, down] of SPARE_DOWN) {
  test(`card evm-rpc-spare-list: with the configured provider and the first pinned one down (${what}), the second pinned one's answer reaches the caller`, async () => {
    const asked: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(url);
      if (url === "https://cfg.test/" || url === "https://p1.test") return down(url);
      const b = JSON.parse(String(init.body)) as { id: unknown };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: "0x2a" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const t = { v: performance.timeOrigin + performance.now() };
    const r = createRpc({ BASE_RPC_URL: "https://cfg.test/" }, { fetch: fetch as never, holds: providerHolds(() => t.v), pinned: { base: ["https://p1.test", "https://p2.test", "https://p3.test"] }, now: () => t.v });
    const a = await call(r, "base", { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] }, JSON_T);
    assert.equal(a.status, 200, a.body);
    assert.equal(JSON.parse(a.body).result, "0x2a");
    assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test", "https://p2.test"], "each down provider asked once, then the one that answers; the last is not needed");
  });
}

// -- card evm-rpc-spare-list, task C: a provider that cannot serve a request's shape is out for that request only ------

const SHAPE_ERR = { jsonrpc: "2.0", id: 1, error: { code: -32701, message: "Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/base/host" } };
const jsonOk = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** An address-less Transfer filter over 1,000 blocks. */
const TRANSFERS = (id = 1) => ({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ fromBlock: "0x100", toBlock: "0x4e7", topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }] });

function shapeRig(answers: Record<string, (body: { id: unknown; method: string }) => Response>) {
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    const b = JSON.parse(String(init.body)) as { id: unknown; method: string };
    return answers[url]!(b);
  };
  const t = { v: performance.timeOrigin + performance.now() };
  const holds = providerHolds(() => t.v);
  const r = createRpc({ BASE_RPC_URL: "https://cfg.test/" }, { fetch: fetch as never, holds, pinned: { base: ["https://p1.test", "https://p2.test", "https://p3.test"] }, now: () => t.v });
  return { r, asked, holds };
}

test("card evm-rpc-spare-list: a provider that answers an address-less eth_getLogs -32701 is out for that read only: the next provider's array reaches the caller, and the first is not held", async () => {
  const logs = [{ address: "0x" + "ab".repeat(20), topics: [], data: "0x", blockNumber: "0x200", logIndex: "0x0", transactionHash: "0x" + "cd".repeat(32), removed: false }];
  const { r, asked, holds } = shapeRig({
    "https://cfg.test/": (b) => (b.method === "eth_getLogs" ? jsonOk(SHAPE_ERR) : jsonOk({ jsonrpc: "2.0", id: b.id, result: "0x1" })),
    "https://p1.test": (b) => jsonOk({ jsonrpc: "2.0", id: b.id, result: b.method === "eth_getLogs" ? logs : "0x2" }),
    "https://p2.test": (b) => jsonOk({ jsonrpc: "2.0", id: b.id, result: "0x3" }),
    "https://p3.test": (b) => jsonOk({ jsonrpc: "2.0", id: b.id, result: "0x4" }),
  });
  const a = await call(r, "base", TRANSFERS(), JSON_T);
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).result, logs);
  assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test"]);
  assert.equal(holds.heldMs("https://cfg.test/"), 0, "no hold");
  const b = await call(r, "base", { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }, JSON_T);
  assert.equal(JSON.parse(b.body).result, "0x1", "a plain read still goes to it first");
  assert.equal(asked.at(-1), "https://cfg.test/");
});

test("card evm-rpc-spare-list: the shape words are -32701, 'specify an address', Pocket's \"missing required field 'address'\" and -32601; one entry of a batch is enough", async () => {
  for (const error of [
    { code: -32701, message: "x" },
    { code: -32000, message: "Please specify an address in your request" },
    { code: -32602, message: "missing required field 'address' in filter" },
    { code: -32601, message: "method not available" },
  ]) {
    const { r, asked } = shapeRig({
      "https://cfg.test/": (b) => jsonOk([{ jsonrpc: "2.0", id: 0, result: "0x1" }, { jsonrpc: "2.0", id: 1, error }].map((x) => ({ ...x, id: x.id === 0 ? b.id : x.id }))),
      "https://p1.test": (b) => jsonOk([{ jsonrpc: "2.0", id: 1, result: "0x9" }]),
      "https://p2.test": () => jsonOk({}),
      "https://p3.test": () => jsonOk({}),
    });
    const a = await call(r, "base", [TRANSFERS(1), TRANSFERS(2)], JSON_T);
    assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test"], JSON.stringify(error));
    assert.equal(a.status, 200);
  }
});

test("card evm-rpc-spare-list: when every provider answers -32701 the caller gets the last such answer, 200 with the error", async () => {
  const same = () => jsonOk(SHAPE_ERR);
  const { r, asked } = shapeRig({ "https://cfg.test/": same, "https://p1.test": same, "https://p2.test": same, "https://p3.test": same });
  const a = await call(r, "base", TRANSFERS(), JSON_T);
  assert.equal(a.status, 200, a.body);
  assert.equal(JSON.parse(a.body).error.code, -32701);
  assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test", "https://p2.test", "https://p3.test"]);
});

test("card evm-rpc-spare-list: a range cap and a revert are the device's to read: answered as they are, the next provider not asked", async () => {
  for (const error of [
    { code: -32602, message: "block range limit exceeded" },
    { code: -32000, message: "query exceeds max block range 2000" },
    { code: 3, message: "execution reverted", data: "0x" },
  ]) {
    const { r, asked } = shapeRig({
      "https://cfg.test/": (b) => jsonOk({ jsonrpc: "2.0", id: b.id, error }),
      "https://p1.test": () => jsonOk({ jsonrpc: "2.0", id: 1, result: [] }),
      "https://p2.test": () => jsonOk({}),
      "https://p3.test": () => jsonOk({}),
    });
    const a = await call(r, "base", TRANSFERS(), JSON_T);
    assert.deepEqual(JSON.parse(a.body).error, error);
    assert.deepEqual(asked, ["https://cfg.test/"], JSON.stringify(error));
  }
});

test("card evm-rpc-spare-list: with the rest held for longer than the wait, a -32701 is never the caller's answer: a 429 with the hold's seconds, so the device asks again", async () => {
  const { r, asked, holds } = shapeRig({
    "https://cfg.test/": () => jsonOk(SHAPE_ERR),
    "https://p1.test": () => jsonOk(SHAPE_ERR),
    "https://p2.test": () => jsonOk({}),
    "https://p3.test": () => jsonOk({}),
  });
  holds.hold("https://p2.test", 30);
  holds.hold("https://p3.test", 30);
  const a = await call(r, "base", TRANSFERS(), JSON_T);
  assert.equal(a.status, 429, a.body);
  assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test"]);
});

// -- card evm-rpc-spare-list, 6 Nov: a provider that does not keep the blocks a read asks is out for that read only -----
// Live run 42206377652 (6 Nov 10:56Z), job wallet-restore-transfer-rpcs: /v1/rpc/robinhood answered a restore's read with
// rpc-robinhood.blockmachine.io's -32002 "keyless requests are served for the most recent 5000 blocks only", and the
// read stopped there although the list's next providers keep those blocks.

/** History refusals read live: blockmachine (-32002, its whole message as read 2026-11-06 12:51Z), blockvectra (-32011, 2026-11-04 14:4xZ),
 *  PublicNode's archive refusal, daybreak's state refusal and blockmachine's (a state read 600 s back, 2026-11-06 12:40Z). */
const HISTORY_ERRS = [
  { code: -32002, message: "keyless requests are served for the most recent 5000 blocks only; block 107541799 is older than that; use an API key for older blocks" },
  { code: -32011, message: "block reference is outside the public history window", data: { reason: "state_window", retryable: false } },
  { code: -32602, message: "Archive requests require a personal token. Get yours at https://www.allnodes.com/publicnode" },
  { code: -32000, message: "historical state 475cc231cbd3eb500d20ea718cb62c5432a04bb085fa5dbac39912ae52aa4590 is not available" },
  { code: -32000, message: "missing trie node" },
];
for (const error of HISTORY_ERRS) {
  test(`card evm-rpc-spare-list: with the configured provider and the first pinned one refusing the read's blocks (${error.code} ${error.message.slice(0, 40)}), the next provider's answer reaches the caller, and neither is held`, async () => {
    const logs = [{ address: "0x" + "ab".repeat(20), topics: [], data: "0x", blockNumber: "0x200", logIndex: "0x0", transactionHash: "0x" + "cd".repeat(32), removed: false }];
    const refuse = (b: { id: unknown }) => jsonOk({ jsonrpc: "2.0", id: b.id, error });
    const { r, asked, holds } = shapeRig({
      "https://cfg.test/": refuse,
      "https://p1.test": refuse,
      "https://p2.test": (b) => jsonOk({ jsonrpc: "2.0", id: b.id, result: logs }),
      "https://p3.test": () => jsonOk({}),
    });
    const a = await call(r, "base", TRANSFERS(), JSON_T);
    assert.equal(a.status, 200, a.body);
    assert.deepEqual(JSON.parse(a.body).result, logs);
    assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test", "https://p2.test"]);
    assert.equal(holds.heldMs("https://cfg.test/") + holds.heldMs("https://p1.test"), 0, "no hold: each still serves the newest blocks");
  });
}

test("card evm-rpc-spare-list: when every provider refuses the read's blocks the caller gets the last such answer, 200 with the error", async () => {
  const refuse = (b: { id: unknown }) => jsonOk({ jsonrpc: "2.0", id: b.id, error: HISTORY_ERRS[0] });
  const { r, asked } = shapeRig({ "https://cfg.test/": refuse, "https://p1.test": refuse, "https://p2.test": refuse, "https://p3.test": refuse });
  const a = await call(r, "base", TRANSFERS(), JSON_T);
  assert.equal(a.status, 200, a.body);
  assert.equal(JSON.parse(a.body).error.code, -32002);
  assert.deepEqual(asked, ["https://cfg.test/", "https://p1.test", "https://p2.test", "https://p3.test"]);
});
