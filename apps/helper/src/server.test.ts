// node --test apps/helper/src/server.test.ts: the helper answers /v1/health with the six parts and its commit, and
// allows cross-origin reads for exactly the two origins (markets paper H7), on a real server on a free port.
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { HELPER_BIND_ANSWER_MS } from "@blindfill/kit";
import { PARTS, releaseOf } from "./health.ts";
import { createRpc } from "./rpc/rpc.ts";
import { createProxy } from "./proxy/proxy.ts";
import { b58encode, createSolanaLists } from "./data/solana/lists.ts";
import { randomBytes } from "node:crypto";
import { heldPerClient, RETRY_AFTER_MAX_S, throttleOf, upstreamBudget } from "./limits/limits.ts";
import { nearRpc } from "./bind/send.ts";
import type { BindSender } from "./bind/env.ts";
import type { SolanaPoolSender } from "./pool/solana.ts";
import { BIND_BODY_MAX, CONNECT_ATTEMPT_MS, handler, start, WITHDRAW_BODY_MAX } from "./server.ts";
import { agreedBlock, FeeReadRefused, type FeeQuoter } from "./withdraw/fee.ts";
import type { WithdrawSender } from "./withdraw/send.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
/** Test values for the vendor keys a start requires (proxy.ts checkVendorPlans); no real key. */
const TEST_VENDOR_KEYS = { JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001" };
const APP = "https://confidential.unrealized.trade";
const SIGN = "https://sign.confidential.unrealized.trade";
let port = 0;
const server = start(COMMIT, 0);
before(() => new Promise<void>((ok) => server.on("listening", () => ((port = (server.address() as AddressInfo).port), ok()))));
after(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));
/** Closes a test's own server, from t.after: a failed assertion anywhere in the test can never leave it open and hold
 *  the file's process (a server closed already in the test's finally answers ERR_SERVER_NOT_RUNNING, which is fine). */
const closeServer = (s: ReturnType<typeof createServer>) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok())));
/** A server a helper function or a long test makes, closed when the file ends whatever failed (the same guard as t.after). */
const owned = new Set<ReturnType<typeof createServer>>();
const own = (s: ReturnType<typeof createServer>) => (owned.add(s), s);
after(() => Promise.all([...owned].map(closeServer)).then(() => undefined));

// raw http, so the Origin header is sent exactly as written (fetch would add or forbid some headers)
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string, to = port) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: to, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail).end(body);
  });
}

test("GET /v1/health: 200, proxy up (/v1/proxy/ and /v1/rpc/ are mounted), relay up (/v1/token-status), delegate up (/v1/bind) and the other three down, the commit in the body and in X-Helper-Commit", async () => {
  const r = await call("GET", "/v1/health");
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  // release: null, as this test's environment sets no HELPER_RELEASE
  // solana: this environment sets no SOLANA_RPC_URL, so the RPC slot is the public endpoint (card helper-solana-failover)
  assert.deepEqual(b, { ok: true, commit: COMMIT, release: null, ready: true, parts: Object.fromEntries(PARTS.map((p) => [p, p === "proxy" || p === "relay" || p === "delegate" ? "up" : "down"])), solana: { rpc: "public" } });
  assert.deepEqual(Object.keys(b.parts), ["proxy", "relay", "intents", "delegate", "orders", "log"]);
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["vary"], "Origin");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(Buffer.byteLength(r.body) <= 1024, "1 KB limit (H7)");
  assert.equal(r.headers["set-cookie"], undefined);
});

// card helper-release-bump: the release HELPER_RELEASE names (deploy/redeploy.sh raises it per new commit) is in the
// answer, so the live check can read that a deploy raised it
test("GET /v1/health carries HELPER_RELEASE as a number; none or a value the relayers would refuse is null", async (t) => {
  assert.equal(releaseOf({ HELPER_RELEASE: "12" }), 12);
  assert.equal(releaseOf({ HELPER_RELEASE: "999999999" }), 999999999);
  for (const v of [undefined, "", "0", "07", "1.5", "-1", " 3", "3\n", "1000000000", "abc"]) assert.equal(releaseOf({ HELPER_RELEASE: v }), null, JSON.stringify(v));
  const helper = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 12));
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.listen(0, "127.0.0.1", () => ok()));
  try {
    const r = await call("GET", "/v1/health", { origin: APP }, undefined, (helper.address() as AddressInfo).port);
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.release, 12);
    assert.deepEqual(Object.keys(b), ["ok", "commit", "release", "ready", "parts", "solana"]);
    assert.ok(Buffer.byteLength(r.body) <= 1024, "1 KB limit (H7)");
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

test("each of the two origins is echoed byte for byte, with Vary: Origin and no credentials; Retry-After is exposed", async () => {
  for (const o of [APP, SIGN]) {
    const r = await call("GET", "/v1/health", { origin: o });
    assert.equal(r.headers["access-control-allow-origin"], o);
    assert.equal(r.headers["vary"], "Origin");
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
    assert.equal(r.headers["access-control-expose-headers"], "X-Helper-Commit, X-Helper-Source, X-Fetched-At, Retry-After");
  }
});

test("any other origin gets no Access-Control-Allow-Origin, never *", async () => {
  const others = ["https://example.com", "null", "http://confidential.unrealized.trade", "https://confidential.unrealized.trade:443",
    "https://confidential.unrealized.trade/", "https://CONFIDENTIAL.unrealized.trade", "https://evil.confidential.unrealized.trade",
    `${APP}, ${SIGN}`, "*"];
  for (const o of others) {
    const r = await call("GET", "/v1/health", { origin: o });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], undefined, o);
    assert.equal(r.headers["vary"], "Origin", o);
  }
});

test("errors carry the commit and CORS too: 404 on another path, 405 on POST /v1/health", async () => {
  const nf = await call("GET", "/v1/nothing", { origin: SIGN });
  assert.equal(nf.status, 404);
  assert.deepEqual(JSON.parse(nf.body), { error: "not_found" });
  assert.equal(nf.headers["access-control-allow-origin"], SIGN);
  assert.equal(nf.headers["x-helper-commit"], COMMIT);
  const na = await call("POST", "/v1/health", { origin: APP });
  assert.equal(na.status, 405);
  assert.equal(na.headers["access-control-allow-origin"], APP);
});

test("preflight: allow headers only for the two origins, a listed method and content-type alone", async () => {
  const ok = await call("OPTIONS", "/v1/bind", { origin: SIGN, "access-control-request-method": "POST", "access-control-request-headers": "Content-Type" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers["access-control-allow-origin"], SIGN);
  assert.equal(ok.headers["access-control-allow-methods"], "GET, POST, PUT, DELETE");
  assert.equal(ok.headers["access-control-allow-headers"], "content-type");
  assert.equal(ok.headers["access-control-max-age"], "600");
  const refused: Record<string, string>[] = [
    { origin: "https://example.com", "access-control-request-method": "POST" },
    { origin: APP, "access-control-request-method": "PATCH" },
    { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "content-type, authorization" },
    { origin: APP },
  ];
  for (const h of refused) {
    const r = await call("OPTIONS", "/v1/health", h);
    assert.equal(r.status, 204);
    for (const k of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]) assert.equal(r.headers[k], undefined, JSON.stringify(h));
  }
});

test("HEAD answers the headers with no body; a commit that is not 40 hex refuses to start", async () => {
  const r = await call("HEAD", "/v1/health", { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.body, "");
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  for (const bad of ["", "main", COMMIT.slice(0, 12), COMMIT.toUpperCase(), `${COMMIT}0`]) assert.throws(() => handler(bad), /40-hex/);
});

// the server writes only through console (src/server.ts); the test runner owns stdout, so console is what is watched
test("the server writes no line while it answers (no request log)", async () => {
  const seen: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    await call("GET", "/v1/health", { origin: APP, "x-forwarded-for": "203.0.113.7" });
    await call("GET", "/v1/nothing?x=1", { "x-forwarded-for": "203.0.113.7" });
    await call("OPTIONS", "/v1/health", { origin: "https://example.com", "access-control-request-method": "GET" });
    await call("POST", "/v1/rpc/base", { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, '{"jsonrpc":"2.0","id":1,"method":"admin_peers"}');
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(seen, []);
});

const JSON_H = { "content-type": "application/json", origin: APP };
const rpcBody = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

test("POST /v1/rpc/{chain}: an unlisted method is refused 400 method_not_allowed, with the commit and CORS", async () => {
  const r = await call("POST", "/v1/rpc/base", JSON_H, rpcBody("debug_traceTransaction"));
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.body), { error: { code: "method_not_allowed" } });
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.equal(r.headers["vary"], "Origin");
});

test("/v1/rpc: another HTTP method 405, an unknown or nested chain 404, a body over 256 KB 413", async () => {
  const get = await call("GET", "/v1/rpc/solana", { origin: APP });
  assert.equal(get.status, 405);
  assert.equal(get.headers["allow"], "POST, OPTIONS");
  for (const p of ["/v1/rpc/ethereum", "/v1/rpc/", "/v1/rpc/solana/x", "/v1/rpc/%73olana", "/v1/rpc/../rpc/solana"]) {
    const r = await call("POST", p, JSON_H, rpcBody("getBalance"));
    assert.equal(r.status, 404, p);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found" } }, p);
  }
  const big = await call("POST", "/v1/rpc/solana", JSON_H, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x".repeat(262_144)] }));
  assert.equal(big.status, 413);
  assert.deepEqual(JSON.parse(big.body), { error: { code: "too_large" } });
});

test("/v1/rpc forwards an allowlisted call to the configured provider and passes its answer back (local stub)", async (t) => {
  const seen: string[] = [];
  const stub = createServer((req, res) => {
    let b = "";
    req.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => {
      seen.push(b);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    });
  });
  await new Promise<void>((ok) => stub.listen(0, "127.0.0.1", () => ok()));
  t.after(() => closeServer(stub));
  const up = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const helper = start(COMMIT, 0, undefined, createRpc({ SOLANA_RPC_URL: up }));
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  try {
    const r = await call("POST", "/v1/rpc/solana", JSON_H, rpcBody("getBalance"), (helper.address() as AddressInfo).port);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { jsonrpc: "2.0", id: 1, result: 42 });
    assert.equal(r.headers["x-helper-commit"], COMMIT);
    assert.equal(r.headers["access-control-allow-origin"], APP);
    assert.deepEqual(seen, [rpcBody("getBalance")]);
  } finally {
    helper.closeAllConnections();
    stub.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => stub.close(() => ok())));
  }
});

test("GET /v1/withdraw/fee: the quoter's answer for one carried token; another token, two tokens or none 404 not_found; reads refused 503 upstream; POST 405", async (t) => {
  const ANSWER = { relayer_account: "relayer.confidential.unrlzd.near", fee_recipient: "relayer.confidential.unrlzd.near", relay_fee: "207609", gp: "100000000", px: "4.135781763845", g_w: "92505000000000", valid_until_block: 222699586 };
  let failing = false;
  const fee: FeeQuoter = {
    networkOf: (t) => (t === "carried.near" ? "mainnet" : null),
    quote: async () => {
      if (failing) throw new FeeReadRefused("the providers' gas prices differ");
      return ANSWER;
    },
    reads: () => ({ feeMin: async () => 0n }),
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, fee);
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  try {
    const r = await call("GET", "/v1/withdraw/fee?token=carried.near", { origin: APP }, undefined, to);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), ANSWER);
    assert.equal(r.headers["x-helper-commit"], COMMIT);
    assert.equal(r.headers["access-control-allow-origin"], APP);
    for (const q of ["?token=other.near", "?token=carried.near&token=carried.near", ""]) {
      const n = await call("GET", `/v1/withdraw/fee${q}`, { origin: APP }, undefined, to);
      assert.equal(n.status, 404, q);
      assert.deepEqual(JSON.parse(n.body), { error: { code: "not_found" } }, q);
    }
    failing = true;
    const u = await call("GET", "/v1/withdraw/fee?token=carried.near", { origin: APP }, undefined, to);
    assert.equal(u.status, 503);
    assert.deepEqual(JSON.parse(u.body), { error: { code: "upstream" } });
    const p = await call("POST", "/v1/withdraw/fee?token=carried.near", JSON_H, "{}", to);
    assert.equal(p.status, 405);
    assert.equal(p.headers["allow"], "GET, HEAD, OPTIONS");
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

test("POST /v1/withdraw: the body parsed and handed to the sender, its status and code answered; not JSON 400 bad_shape; over 8 KB 413 too_large; GET 405", async (t) => {
  const seen: unknown[] = [];
  const withdraw: WithdrawSender = {
    carry: async (body) => {
      seen.push(body);
      const t = (body as { token?: unknown }).token;
      if (t === "halted.near") return { status: 503, body: { error: { code: "token_halted" } } };
      if (t === "carried.near") return { status: 200, body: { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL", state: "submitted" } };
      return { status: 400, body: { error: { code: "bad_shape" } } };
    },
    warm: () => void warmed++,
    stop: () => undefined,
  };
  let warmed = 0;
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, withdraw);
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await null; // once the senders are this process's (none to wait for here: a microtask)
  assert.equal(warmed, 1, "start warms the withdrawal relayer: a restart resends its open sends before any request");
  // and the helper's main starts the server with the relayer it built
  const main = readFileSync(join(import.meta.dirname, "server.ts"), "utf8").split("if (import.meta.main)")[1] ?? "";
  assert.match(main, /const withdraw = withdrawSenderFromEnv\(process\.env, fee, statusesOf\(watches\)\);/);
  assert.match(main, /const bind = bindSenderFromEnv\(process\.env, watches\);/);
  // card evm-buy-hookdata-fee, fold 4 MEDIUM-1: both pool kinds' start checks exit 2 on a refusal, and ready waits for them
  assert.match(main, /const checked = poolsChecked\(pools, evmPools, \(e\) => \(console\.error\(`helper: \$\{e\.message\}`\), process\.exit\(2\)\)\);/);
  assert.match(main, /const warmed = Promise\.all\(\[warmUntilReady\(\{ lists, evmLists, token \}\), checked\]\)\.then\(\(\) => void \(ready = true\)\);/);
  assert.doesNotMatch(main, /await[^;]*\.ready/, "a pool's rent read never holds up the helper's start");
  // the chains' own swap reads: the EVM chains' and Solana's (the token page's lists and candles as its history)
  assert.match(main, /const swaps: Swaps = \{ \.\.\.evmSwapsFromEnv\(process\.env, evmLists, gecko, holds\), solana: solanaTradesFromEnv\(process\.env, lists, token, rpc, slots\) \};/);
  // card helper-robinhood-capacity: one hold per provider, the same one handed to /v1/rpc, the EVM lists and the swap reads
  assert.equal(main.match(/const holds = providerHolds\(\);/g)?.length, 1);
  assert.match(main, /const rpc = createRpc\(process\.env, \{ holds, pinned: SWAP_RPCS \}\);/);
  assert.match(main, /server = start\(commit, port, proxy, rpc, watches, lists, fee, withdraw, token, bind, pools, evmLists, swaps, \(\) => ready, senders\.held, \(\) => Object\.fromEntries\(\[\.\.\.slots\]\.map\(\(\[k, v\]\) => \[k, v\.state\(\)\]\)\), release, evmPools\);/);
  // card helper-ready-without-gt: every environment read at the start, none left to handler()'s defaults at listen()
  assert.match(main, /const evmPools = evmPoolSendersFromEnv\(process\.env\);/);
  assert.match(main, /const release = releaseOf\(process\.env\);/);
  // card helper-ready-gate: the fee quoter is the senders' (their store handed over), and a replacing helper listens only once ready
  assert.match(main, /const senders = sendersFromEnv\(process\.env\);/);
  assert.match(main, /const fee = senders\.fee;/);
  assert.match(main, /if \(senders\.peer\) void warmed\.then\(listen, \(\) => undefined\);/);
  // the EVM lists (src/data/evm/lists.ts): each served chain's lists on GeckoTerminal's one budget, shared with the
  // Solana token page's candles, and warmed at start
  assert.match(main, /const SERVED_EVM: readonly EvmChain\[\] = \["base", "robinhood"\];/);
  assert.match(main, /const gecko = geckoBudget\(Date\.now\);/);
  // every outbound connect may try one address for CONNECT_ATTEMPT_MS, past one lost SYN, set before anything starts
  assert.match(main, /^ {1,}setDefaultAutoSelectFamilyAttemptTimeout\(CONNECT_ATTEMPT_MS\);/m);
  assert.ok(CONNECT_ATTEMPT_MS > 1_000, "past the 1 s SYN resend");
  assert.match(main, /const evmLists: EvmLists = Object\.fromEntries\(SERVED_EVM\.map\(\(c\) => \[c, createEvmLists\(c, gecko, \{ holds \}\)\]\)\);/);
  assert.match(main, /const token = solanaTokenFromEnv\(process\.env, proxy, lists, rpc, gecko, slots\);/);
  assert.match(main, /for \(const l of Object\.values\(evmLists\)\) l\.warm\(\);/);
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  try {
    const ok = await call("POST", "/v1/withdraw", { ...JSON_H, origin: APP }, JSON.stringify({ token: "carried.near" }), to);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL", state: "submitted" });
    assert.equal(ok.headers["x-helper-commit"], COMMIT);
    assert.equal(ok.headers["access-control-allow-origin"], APP);
    const h = await call("POST", "/v1/withdraw", JSON_H, JSON.stringify({ token: "halted.near" }), to);
    assert.equal(h.status, 503);
    assert.deepEqual(JSON.parse(h.body), { error: { code: "token_halted" } });
    const n = await call("POST", "/v1/withdraw", JSON_H, "{not json", to);
    assert.equal(n.status, 400);
    assert.deepEqual(JSON.parse(n.body), { error: { code: "bad_shape" } });
    assert.equal(seen.length, 2, "a body that does not parse never reaches the sender");
    const big = await call("POST", "/v1/withdraw", JSON_H, JSON.stringify({ pad: "x".repeat(WITHDRAW_BODY_MAX) }), to);
    assert.equal(big.status, 413);
    assert.deepEqual(JSON.parse(big.body), { error: { code: "too_large" } });
    assert.equal(seen.length, 2);
    const g = await call("GET", "/v1/withdraw", {}, undefined, to);
    assert.equal(g.status, 405);
    assert.equal(g.headers["allow"], "POST, OPTIONS");
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

test("POST /v1/bind: mounted; with no network set the helper starts and a body that does not decode is 400 bad_shape (networks.test.ts: a delegate on no carried token is token_not_accepted); over 4 KB 413; GET 405", async (t) => {
  // the deployed composition (no sender handed in, nothing set): the helper starts and answers its not-configured codes
  const decodable = "AAAAAA=="; // not one SignedDelegateAction: check 1
  const a = await call("POST", "/v1/bind", { ...JSON_H, origin: APP }, JSON.stringify({ signed_delegate: decodable }));
  assert.deepEqual([a.status, JSON.parse(a.body)], [400, { error: { code: "bad_shape" } }]);
  assert.equal(a.headers["x-helper-commit"], COMMIT);
  assert.equal(a.headers["access-control-allow-origin"], APP);
  const n = await call("POST", "/v1/bind", JSON_H, "{not json");
  assert.deepEqual([n.status, JSON.parse(n.body)], [400, { error: { code: "bad_shape" } }]);
  const big = await call("POST", "/v1/bind", JSON_H, JSON.stringify({ signed_delegate: "A".repeat(BIND_BODY_MAX) }));
  assert.deepEqual([big.status, JSON.parse(big.body)], [413, { error: { code: "too_large" } }]);
  const g = await call("GET", "/v1/bind");
  assert.deepEqual([g.status, g.headers["allow"]], [405, "POST, OPTIONS"]);
  // a sender handed in gets the parsed body, and start warms it
  const seen: unknown[] = [];
  let warmed = 0;
  const bind: BindSender = {
    carry: async (body) => (seen.push(body), { status: 200, body: { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL" } }),
    warm: () => void warmed++,
    stop: () => undefined,
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bind);
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await null; // once the senders are this process's (none to wait for here: a microtask)
  assert.equal(warmed, 1, "start warms the deposit relayer: a restart reads its open records before any request");
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  try {
    const ok = await call("POST", "/v1/bind", JSON_H, JSON.stringify({ signed_delegate: decodable }), (helper.address() as AddressInfo).port);
    assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL" }]);
    assert.deepEqual(seen, [{ signed_delegate: decodable }]);
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

test("POST /v1/bind answers within the kit's HELPER_BIND_ANSWER_MS, which the device's send waits for: a carry still running then answers in_flight and goes on to its own end; one that ends inside it answers its own", async (t) => {
  const TX = "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL";
  const turns = async (n = 50) => {
    for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok));
  };
  let entered: () => void = () => undefined;
  let finish: () => void = () => undefined;
  let finished = 0;
  const bind: BindSender = {
    carry: async () => {
      const gate = new Promise<void>((ok) => (finish = ok));
      // a loaded runner: real time passes between the bind's arrival and its carry, none on the clock the test drives
      for (const until = performance.now() + 5; performance.now() < until; );
      entered();
      await gate; // the prepay and the delegate, read at final
      finished++;
      return { status: 200, body: { tx_hash: TX } };
    },
    warm: () => undefined,
    stop: () => undefined,
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bind);
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  // one clock: the bound's timer and the helper's now() (which reads Date.now when called) both move only by tick
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    // a carry still running at the bound
    let inside = new Promise<void>((ok) => (entered = ok));
    let answered: { status: number; body: string } | null = null;
    const slow = call("POST", "/v1/bind", JSON_H, JSON.stringify({ signed_delegate: "AAAA" }), to).then((r) => (answered = r));
    await inside;
    mock.timers.tick(HELPER_BIND_ANSWER_MS - 1);
    await turns();
    assert.equal(answered, null, "answered before the bound");
    mock.timers.tick(1);
    await turns();
    if (answered === null) finish(); // no answer at the bound: let the carry end, so the assertion below names what came
    const a = (await slow) as { status: number; body: string };
    assert.deepEqual([a.status, JSON.parse(a.body)], [400, { error: { code: "in_flight" } }]);
    assert.equal(finished, 0, "the carry was still running when the helper answered");
    finish();
    await turns();
    assert.equal(finished, 1, "the carry went on to its own end");
    // a carry that ends inside the bound answers its own
    inside = new Promise<void>((ok) => (entered = ok));
    const fast = call("POST", "/v1/bind", JSON_H, JSON.stringify({ signed_delegate: "AAAA" }), to);
    await inside;
    mock.timers.tick(HELPER_BIND_ANSWER_MS - 1);
    finish();
    const b = await fast;
    assert.deepEqual([b.status, JSON.parse(b.body)], [200, { tx_hash: TX }]);
  } finally {
    mock.timers.reset();
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

test("POST /v1/bind is not tied to the request: a client that closes at 1 s does not cancel the carry, which runs to its answer and its record; the helper keeps serving", async (t) => {
  const records: string[] = [];
  let finished = 0;
  const bind: BindSender = {
    carry: async (body) => {
      await new Promise((ok) => setTimeout(ok, 2_000)); // longer than the client waits
      records.push(JSON.stringify(body)); // what the carry writes to its store
      finished++;
      return { status: 200, body: { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL" } };
    },
    warm: () => undefined,
    stop: () => undefined,
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bind);
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  try {
    const closed = await new Promise<string>((ok) => {
      const r = request({ host: "127.0.0.1", port: to, method: "POST", path: "/v1/bind", headers: JSON_H }, () => ok("answered"));
      r.on("error", () => ok("closed"));
      r.end(JSON.stringify({ signed_delegate: "AAAA" }));
      setTimeout(() => r.destroy(), 1_000); // the device's send gives up
    });
    assert.equal(closed, "closed", "the client gave up before the answer");
    assert.equal(finished, 0, "the carry was still running when the client closed");
    await new Promise((ok) => setTimeout(ok, 1_500));
    assert.equal(finished, 1, "the carry ran to its answer after the client closed");
    assert.deepEqual(records, ['{"signed_delegate":"AAAA"}']);
    const h = await call("GET", "/v1/health", {}, undefined, to);
    assert.equal(h.status, 200, "the helper still serves");
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

// M369 (M1): the pool's per-client hold (two mainnet tag 3 carries in flight) needs the caller's address: the route
// hands the pool clientOf(req), the last X-Forwarded-For hop Caddy writes, as the rate limit reads it.
test("M369 (M1): POST /v1/pool/solana/send hands the pool the caller's address", async (t) => {
  const seen: [unknown, string | undefined][] = [];
  const POOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const pool = { carry: async (body: unknown, client?: string) => (seen.push([body, client]), { status: 200, body: { signature: "s" } }) } as unknown as SolanaPoolSender;
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Map([[POOL, pool]]));
  t.after(() => closeServer(helper)); // closed even when an assertion throws before its try
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  try {
    const a = await call("POST", "/v1/pool/solana/send", { ...JSON_H, "x-forwarded-for": "198.51.100.1, 203.0.113.7" }, JSON.stringify({ pool: POOL, tx: "AA==" }), to);
    assert.equal(a.status, 200);
    assert.deepEqual(seen, [[{ pool: POOL, tx: "AA==" }, "203.0.113.7"]]);
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
});

// M362 (3): the helper's own main, as the host runs it, with one devnet Solana pool whose two RPCs are local stubs.
// A failed rent read takes down only that pool (503 upstream) and the rest answers; a configured fee that is not the
// kit's for the rent read makes the process exit 2. Test keys only: sha256 of a label.
test("M362 (3): a pool's failed rent read leaves the helper up with that pool 503; a mismatched configured fee exits 2", async (t) => {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { solanaPoolAccount } = await import("@blindfill/kit");
  const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
  const { base58 } = await import("./bind/checks.ts");
  const seed = new Uint8Array(createHash("sha256").update("helper-pool-senders/server/FP").digest());
  const feePayer = base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
  const program = base58(ed25519.getPublicKey(new Uint8Array(createHash("sha256").update("helper-pool-senders/server/PROGRAM").digest())));
  const RENT = "2BMAAAAAAAAAAAAAAADwPzI="; // the Rent sysvar devnet and mainnet answer (5,080 a byte, factor 1.0): fee 1,300,000
  let up = false;
  const rpc = () =>
    createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d)).on("end", () => {
        if (!up) return void res.writeHead(500).end();
        const { id } = JSON.parse(b);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { owner: SYSVAR_OWNER, data: [RENT, "base64"], lamports: 1, executable: false } } }));
      });
    }).listen(0, "127.0.0.1");
  const stubs = [rpc(), rpc()];
  t.after(() => Promise.all(stubs.map(closeServer)).then(() => undefined));
  await Promise.all(stubs.map((s) => new Promise((ok) => s.on("listening", ok))));
  const urls = stubs.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`).join(",");
  const free = createServer().listen(0, "127.0.0.1");
  await new Promise((ok) => free.on("listening", ok));
  const hp = (free.address() as AddressInfo).port;
  await new Promise((ok) => free.close(ok));
  const run = (fee: string) =>
    spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
      env: { PATH: process.env.PATH, HELPER_COMMIT: COMMIT, PORT: String(hp), ...TEST_VENDOR_KEYS, POOL_SOLANA_PROGRAM_DEVNET: program, POOL_SOLANA_FEE_PAYER_KEY_DEVNET: feePayer, POOL_SOLANA_FEE_DEVNET: fee, POOL_SOLANA_RPCS_DEVNET: urls },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const exited = (c: ReturnType<typeof run>) => new Promise<number | null>((ok) => c.on("exit", ok));
  const listening = (c: ReturnType<typeof run>) => new Promise<void>((ok) => c.stdout!.on("data", (d) => String(d).includes("listening") && ok()));
  const pool = solanaPoolAccount(program);
  try {
    // the RPCs down: the helper starts, answers its health, and the pool answers 503 upstream
    const a = run("1300000");
    try {
      await listening(a);
      assert.equal((await call("GET", "/v1/health", {}, undefined, hp)).status, 200);
      const f = await call("GET", `/v1/pool/fee?pool=${pool}`, {}, undefined, hp);
      assert.deepEqual([f.status, JSON.parse(f.body).error.code], [503, "upstream"]);
      const s = await call("POST", "/v1/pool/solana/send", { "content-type": "application/json" }, JSON.stringify({ pool, tx: "AA==" }), hp);
      assert.deepEqual([s.status, JSON.parse(s.body).error.code], [503, "upstream"], "the pool's send is down with it");
      // the RPCs back: the next ask reads, the configured fee is the kit's, and the pool answers
      up = true;
      const g = await call("GET", `/v1/pool/fee?pool=${pool}`, {}, undefined, hp);
      assert.deepEqual([g.status, JSON.parse(g.body).fee], [200, "1300000"]);
      assert.equal(a.exitCode, null);
    } finally {
      a.kill();
      await exited(a);
    }
    // a configured fee that is not the kit's for the rent read: the process exits 2
    const b = run("1400000");
    const code = await Promise.race([exited(b), new Promise<string>((ok) => setTimeout(() => ok("still running"), 10_000))]);
    if (code === "still running") b.kill();
    assert.equal(code, 2);
  } finally {
    await Promise.all(stubs.map((s) => new Promise((ok) => (s.closeAllConnections(), s.close(ok)))));
  }
});

// card helper-abuse-limits: one throttling contract on every route, keyed on the forwarded address in memory only.
// A helper on a real socket, its clock a fake that moves with time; the address is the last X-Forwarded-For hop, as
// Caddy writes it.
async function limited(o: { rpc?: ReturnType<typeof createRpc> } = {}) {
  let t = 1_800_000_000_000;
  const now = () => (t += 3);
  const h = own(createServer(handler(COMMIT, undefined, o.rpc, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), now)));
  await new Promise<void>((ok) => h.listen(0, "127.0.0.1", () => ok()));
  const to = (h.address() as AddressInfo).port;
  return {
    to,
    jump: (ms: number) => (t += ms),
    close: () => new Promise<void>((ok) => (h.closeAllConnections(), h.close(() => ok()))),
  };
}
const IP_A = "203.0.113.7";
const IP_B = "203.0.113.8";
/** The 429 contract: status, a whole-second Retry-After of 1 to RETRY_AFTER_MAX_S (75) that CORS lets the browser read,
 *  the code only. */
function isThrottle(r: { status: number; headers: Record<string, string | string[] | undefined>; body: string }, origin = APP) {
  assert.equal(r.status, 429);
  const wait = Number(r.headers["retry-after"]);
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= RETRY_AFTER_MAX_S, `Retry-After ${String(r.headers["retry-after"])}`);
  assert.equal(r.headers["access-control-allow-origin"], origin);
  assert.ok(String(r.headers["access-control-expose-headers"]).split(", ").includes("Retry-After"), "Retry-After is exposed");
  assert.deepEqual(JSON.parse(r.body), { error: { code: "rate_limited" } });
  return wait;
}

test("every route without its own budget: one client past API_RATE_MAX in a window gets 429 with a readable Retry-After; a second client in the same window still goes; after the wait the first goes again", async () => {
  const { API_RATE_MAX } = await import("./server.ts");
  const L = await limited();
  try {
    for (let i = 0; i < API_RATE_MAX; i++) assert.equal((await call("GET", "/v1/health", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to)).status, 200);
    const over = await call("GET", "/v1/health", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to);
    const wait = isThrottle(over);
    for (const p of ["/v1/token-status?token=x", "/v1/withdraw/fee?token=x", "/v1/market/lists?chain=solana", "/nope"]) isThrottle(await call("GET", p, { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to));
    isThrottle(await call("POST", "/v1/bind", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to));
    isThrottle(await call("POST", "/v1/withdraw", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to));
    assert.equal((await call("GET", "/v1/health", { origin: APP, "x-forwarded-for": IP_B }, undefined, L.to)).status, 200, "a second client in the same window");
    assert.ok(!over.body.includes(IP_A) && !JSON.stringify(over.headers).includes(IP_A), "the address is never answered");
    L.jump(wait * 1000);
    assert.equal((await call("GET", "/v1/health", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to)).status, 200, "after the named wait");
  } finally {
    await L.close();
  }
});

test("the pool routes: past POOL_RATE_MAX the same 429 contract (at be4b353 the wait was not readable by a browser)", async () => {
  const { POOL_RATE_MAX } = await import("./server.ts");
  const L = await limited();
  try {
    for (let i = 0; i < POOL_RATE_MAX; i++) assert.equal((await call("GET", "/v1/pool/fee?pool=x", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to)).status, 404);
    isThrottle(await call("GET", "/v1/pool/fee?pool=x", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to));
    isThrottle(await call("POST", "/v1/pool/solana/send", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to));
    isThrottle(await call("POST", "/v1/pool/evm/send", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to), APP);
    isThrottle(await call("GET", "/v1/pool/fee?pool=x", { origin: SIGN, "x-forwarded-for": IP_A }, undefined, L.to), SIGN);
    assert.equal((await call("GET", "/v1/pool/fee?pool=x", { origin: APP, "x-forwarded-for": IP_B }, undefined, L.to)).status, 404, "a second client");
  } finally {
    await L.close();
  }
});

test("the RPC route: the caller's address reaches the chain's budget, and a provider's 429 holds the chain for every caller as a readable 429 until its reset", async () => {
  let throttle = false;
  let rt = 1_800_000_000_000; // the RPC part's own clock
  const rpc = createRpc({}, { now: () => rt, fetch: async () => (throttle ? new Response("provider says slow down", { status: 429, headers: { "retry-after": "7" } }) : new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { "content-type": "application/json" } })) });
  const L = await limited({ rpc });
  const body = rpcBody("getBalance");
  try {
    const { RPC_CLIENT_MAX } = (await import("./rpc/rpc.ts")) as unknown as { RPC_CLIENT_MAX: number };
    for (let i = 0; i < RPC_CLIENT_MAX; i++) assert.equal((await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_A }, body, L.to)).status, 200);
    isThrottle(await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_A }, body, L.to));
    throttle = true;
    const up = await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_B }, body, L.to);
    assert.equal(isThrottle(up), 7, "the provider's reset");
    assert.ok(!up.body.includes("slow down"), "no provider text");
    throttle = false;
    isThrottle(await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": "203.0.113.9" }, body, L.to));
    rt += 7_000;
    assert.equal((await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": "203.0.113.9" }, body, L.to)).status, 200, "at the reset the chain is open");
  } finally {
    await L.close();
  }
});

test("the RPC and proxy routes: past UPSTREAM_ROUTE_MAX a client meets the same 429 before its body is read, a refused request counted too; a second client still goes", async () => {
  const { UPSTREAM_ROUTE_MAX } = (await import("./server.ts")) as unknown as { UPSTREAM_ROUTE_MAX: number };
  let calls = 0;
  const rpc = createRpc({}, { fetch: async () => (calls++, new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { "content-type": "application/json" } })) });
  const L = await limited({ rpc });
  try {
    for (let i = 0; i < UPSTREAM_ROUTE_MAX; i++) assert.equal((await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_A }, rpcBody("notAllowed"), L.to)).status, 400);
    isThrottle(await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_A }, rpcBody("getBalance"), L.to));
    isThrottle(await call("GET", "/v1/rpc/solana", { origin: APP, "x-forwarded-for": IP_A }, undefined, L.to));
    assert.equal(calls, 0, "nothing reached the provider");
    assert.equal((await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": IP_B }, rpcBody("getBalance"), L.to)).status, 200, "a second client");
    for (let i = 0; i < UPSTREAM_ROUTE_MAX; i++) assert.equal((await call("POST", "/v1/proxy/nope", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to)).status, 404);
    isThrottle(await call("POST", "/v1/proxy/nope", { ...JSON_H, "x-forwarded-for": IP_A }, "{}", L.to));
    assert.equal((await call("POST", "/v1/proxy/nope", { ...JSON_H, "x-forwarded-for": IP_B }, "{}", L.to)).status, 404, "a second client");
  } finally {
    await L.close();
  }
});

test("a throttle behind a read answers the same 429 contract, never 503: the market lists, token, holders and candles, the withdraw fee (a NEAR provider's 429) and the pool fee (a pool provider's 429)", async () => {
  const limitedRead = async () => ({ status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 9 });
  const lists = { get: limitedRead } as never;
  const token = { page: limitedRead, holders: limitedRead, candles: limitedRead } as never;
  // the NEAR client names a provider's 429 by its status, whatever its body, and the fee's read carries it
  const near = nearRpc("https://provider-a.example", (async () => new Response("", { status: 429 })) as never);
  const refused = await agreedBlock([near, near], Date.now).then(() => null, (e: unknown) => e);
  assert.ok(refused instanceof FeeReadRefused && throttleOf(refused) === 1, String(refused));
  const fee: FeeQuoter = { networkOf: () => "mainnet", quote: async () => { throw refused; }, reads: () => ({ feeMin: async () => 0n }) };
  const POOL = "11111111111111111111111111111111";
  const pools = new Map([[POOL, { fee: async () => { throw new Error("HTTP 429"); } }]]) as never;
  const h = own(createServer(handler(COMMIT, undefined, undefined, undefined, lists, fee, undefined, token, undefined, null, pools, new Map())));
  await new Promise<void>((ok) => h.listen(0, "127.0.0.1", () => ok()));
  const to = (h.address() as AddressInfo).port;
  try {
    const mint = "So11111111111111111111111111111111111111112";
    for (const p of ["/v1/market/lists?chain=solana", `/v1/market/token?chain=solana&token=${mint}`, `/v1/market/holders?chain=solana&token=${mint}`, `/v1/market/candles?chain=solana&token=${mint}&tf=1h`]) {
      assert.equal(isThrottle(await call("GET", p, { origin: APP }, undefined, to)), 9, p);
    }
    assert.equal(isThrottle(await call("GET", "/v1/withdraw/fee?token=x.near", { origin: APP }, undefined, to)), 1);
    assert.equal(isThrottle(await call("GET", `/v1/pool/fee?pool=${POOL}`, { origin: APP }, undefined, to)), 1);
  } finally {
    await new Promise<void>((ok) => (h.closeAllConnections(), h.close(() => ok())));
  }
});

// review F-C: a refusal before the budget draw (an off-list method) costs a full body read and parse, so the route
// itself is limited per client
function postRaw(port: number, path: string, body: string, xff: string): Promise<number> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff, "content-length": Buffer.byteLength(body) }, agent: false }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode!));
    });
    r.on("error", fail);
    r.end(body);
  });
}
test("review F-C: one address sending 600 off-list RPC calls of ~250 KB in one window meets a 429", async () => {
  let t = 1_800_000_000_000;
  const rpc = createRpc({}, { now: () => (t += 1), fetch: async () => new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { "content-type": "application/json" } }) });
  const h = own(createServer(handler(COMMIT, undefined, rpc, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), () => (t += 1))));
  await new Promise<void>((r) => h.listen(0, "127.0.0.1", () => r()));
  const to = (h.address() as AddressInfo).port;
  const nums = Array.from({ length: 62_000 }, (_, i) => i % 10).join(",");
  const big = `{"jsonrpc":"2.0","id":1,"method":"notAllowed","params":[${nums}]}`;
  assert.ok(Buffer.byteLength(big) < 262_144);
  const statuses = new Map<number, number>();
  try {
    for (let i = 0; i < 600; i++) {
      const s = await postRaw(to, "/v1/rpc/solana", big, "203.0.113.66");
      statuses.set(s, (statuses.get(s) ?? 0) + 1);
    }
  } finally {
    await new Promise<void>((r) => (h.closeAllConnections(), h.close(() => r())));
  }
  assert.ok((statuses.get(429) ?? 0) > 0, `no 429 for one address's 600 requests in one window: ${JSON.stringify([...statuses])}`);
});

// End state 5: no limit path writes or logs the address. Every console method (the helper's only logger) and every fs
// write are stubbed while each limit is driven past its edge from one address.
test("no IP stored: driving every limit past its edge logs nothing and writes nothing that holds the address", async () => {
  const IP = "198.51.100.77";
  const out: string[] = [];
  const keep = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  const mocks = [
    ...(["log", "error", "warn", "info", "debug", "trace"] as const).map((m) => mock.method(console, m, keep)),
    ...(["writeFileSync", "appendFileSync", "writeFile", "appendFile", "writeSync", "write", "createWriteStream", "openSync", "open", "renameSync", "mkdirSync"] as const).map((m) => mock.method(fs, m, (...a: unknown[]) => void keep("fs." + m, ...a))),
    ...(["writeFile", "appendFile", "open", "mkdir", "rename"] as const).map((m) => mock.method(fs.promises, m, async (...a: unknown[]) => void keep("fs.promises." + m, ...a))),
  ];
  syncBuiltinESMExports();
  // the provider answers the first RPC_CLIENT_MAX reads, then throttles
  const { RPC_CLIENT_MAX } = (await import("./rpc/rpc.ts")) as unknown as { RPC_CLIENT_MAX: number };
  let n = 0;
  const rpc = createRpc({}, { fetch: async () => (++n <= RPC_CLIENT_MAX ? new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { "content-type": "application/json" } }) : new Response("slow", { status: 429, headers: { "retry-after": "2" } })) });
  const L = await limited({ rpc });
  try {
    const { API_RATE_MAX, POOL_RATE_MAX, UPSTREAM_ROUTE_MAX } = (await import("./server.ts")) as unknown as Record<string, number>;
    const h = { ...JSON_H, "x-forwarded-for": IP };
    for (let i = 0; i <= API_RATE_MAX!; i++) await call("GET", "/v1/health", h, undefined, L.to);
    for (let i = 0; i <= POOL_RATE_MAX!; i++) await call("GET", "/v1/pool/fee?pool=x", h, undefined, L.to);
    await call("POST", "/v1/pool/solana/send", h, "{}", L.to);
    // the chain's budget: the share drawn, then refused (no provider call); another address meets the provider's 429,
    // which holds the chain, and this one's next draw is refused by the hold; then the route's own window
    for (let i = 0; i <= RPC_CLIENT_MAX; i++) await call("POST", "/v1/rpc/solana", h, rpcBody("getBalance"), L.to);
    await call("POST", "/v1/rpc/solana", { ...JSON_H, "x-forwarded-for": "192.0.2.1" }, rpcBody("getBalance"), L.to);
    await call("POST", "/v1/rpc/solana", h, rpcBody("getBalance"), L.to);
    for (let i = 0; i <= UPSTREAM_ROUTE_MAX!; i++) await call("POST", "/v1/rpc/solana", h, rpcBody("notAllowed"), L.to);
    for (let i = 0; i <= UPSTREAM_ROUTE_MAX!; i++) await call("POST", "/v1/proxy/nope", h, "{}", L.to);
    // and each refusal of the limits themselves, driven directly: a share, a total, a hold, a held-request limit
    const b = upstreamBudget(() => ({ total: 2, perClient: 1 }));
    b.take("k", IP);
    b.take("k", IP);
    b.take("k", "a");
    b.take("k", "b");
    b.hold("k", Date.now() + 1_000);
    b.take("k", IP);
    const held = heldPerClient(1);
    held.enter(IP);
    held.enter(IP);
    held.leave(IP);
  } finally {
    await L.close();
    for (const m of mocks) m.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(out.filter((l) => l.startsWith("fs.")), [], "no file written");
  assert.deepEqual(out.filter((l) => l.includes(IP) || l.includes("198.51.100")), [], "nothing logged holds the address");
});

// ---- fold 6 (card helper-abuse-limits, re-check 4) ----

test("re-check 4 finding 4: a start with a vendor's key unset and no PROXY_BUDGET_<VENDOR> exits 2, naming the variables only", async () => {
  const { spawn } = await import("node:child_process");
  for (const [key, budget] of [["JUPITER_API_KEY", "PROXY_BUDGET_JUPITER"], ["LIFI_API_KEY", "PROXY_BUDGET_LIFI"]] as const) {
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HELPER_COMMIT: COMMIT, PORT: "0", ...TEST_VENDOR_KEYS };
    delete env[key];
    const c = spawn(process.execPath, [join(import.meta.dirname, "server.ts")], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr!.on("data", (d) => (err += d));
    const code = await Promise.race([new Promise<number | null>((ok) => c.on("exit", ok)), new Promise<string>((ok) => setTimeout(() => ok("still running"), 10_000))]);
    if (code === "still running") c.kill();
    assert.equal(code, 2, `${key}: ${err}`);
    assert.equal(err.trim(), `helper: ${key} is unset: set it, or ${budget} to the plan without a key`);
  }
});

function postAs(port: number, path: string, body: string, xff: string): Promise<number> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff, "content-length": Buffer.byteLength(body) }, agent: false }, (res) => (res.resume(), res.on("end", () => ok(res.statusCode!))));
    r.on("error", fail);
    r.end(body);
  });
}
function getAs(port: number, path: string, xff: string): Promise<number> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { "x-forwarded-for": xff }, agent: false }, (res) => (res.resume(), res.on("end", () => ok(res.statusCode!))));
    r.on("error", fail);
    r.end();
  });
}
/** The helper as deployed, on a stub of the public Solana endpoint (100 a 10 s, 40 a 10 s for one method, rolling) and
 * a Jupiter that lists nothing: `pages` token pages of fresh mints opened by one address, then `then` while they run. */
async function tokenPagesThen(pages: number, then: (port: number) => Promise<number[]>) {
  const all: number[] = [];
  const per = new Map<string, number[]>();
  let refused = 0;
  const realFetch = globalThis.fetch;
  const stub = (async (u: string | URL | Request, i?: RequestInit) => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (!String(u).includes("api.mainnet-beta.solana.com")) return json({ tokens: [] });
    const t = Date.now();
    const b = JSON.parse(String(i?.body));
    const reqs: { id: unknown; method: string }[] = Array.isArray(b) ? b : [b];
    const roll = (a: number[]) => {
      while (a.length && t - a[0]! >= 10_000) a.shift();
    };
    roll(all);
    for (const r of reqs) {
      const a = per.get(r.method) ?? [];
      roll(a);
      per.set(r.method, a);
    }
    if (all.length + reqs.length > 100 || reqs.some((r) => per.get(r.method)!.length + 1 > 40)) return (refused++, new Response("slow", { status: 429, headers: { "retry-after": "10" } }));
    for (const r of reqs) (all.push(t), per.get(r.method)!.push(t));
    const one = (r: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "getMultipleAccounts" ? { context: { slot: 1 }, value: [null, null] } : 1 });
    return json(Array.isArray(b) ? reqs.map(one) : one(reqs[0]!));
  }) as typeof fetch;
  // the share is a fixed 10 s window: start early in one, so the run stays inside it
  while (Date.now() % 10_000 > 2_000) await new Promise((r) => setTimeout(r, 50));
  globalThis.fetch = stub;
  try {
    const proxy = createProxy({}, { fetch: stub });
    const rpc = createRpc({}, { fetch: stub });
    const lists = createSolanaLists(proxy, rpc);
    const h = own(createServer(handler(COMMIT, proxy, rpc, undefined, lists, undefined, undefined, undefined, undefined, null, new Map(), new Map())));
    await new Promise<void>((r) => h.listen(0, "127.0.0.1", () => r()));
    const port = (h.address() as AddressInfo).port;
    const opened = Array.from({ length: pages }, () => getAs(port, `/v1/market/token?chain=solana&token=${b58encode(randomBytes(32))}`, "198.51.100.77"));
    await new Promise((r) => setTimeout(r, 300));
    const st = await then(port);
    const ps = await Promise.all(opened);
    h.closeAllConnections();
    await new Promise<void>((r) => h.close(() => r()));
    return { refused, st, ps };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const someGma = () => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[b58encode(randomBytes(32))]] });

test("re-check 4 P5b: one address's token pages of fresh mints take only its own share; two honest devices' getMultipleAccounts in the same 10 s are all served", async () => {
  const r = await tokenPagesThen(40, async (port) => {
    const st: number[] = [];
    for (let d = 0; d < 2; d++) for (let i = 0; i < 10; i++) st.push(await postAs(port, "/v1/rpc/solana", someGma(), `192.0.2.${20 + d}`));
    return st;
  });
  assert.equal(r.refused, 0, "the endpoint never answered 429");
  assert.deepEqual(r.st.filter((x) => x !== 200), [], "every honest device read was served");
  assert.ok(r.ps.filter((x) => x === 429).length >= 40 - 16, `the address stops at its share: ${JSON.stringify(r.ps)}`);
});

test("re-check 4 R5e: the token page reads through the helper's one RPC budget: an address's pages spend its own share of the chain", async () => {
  const r = await tokenPagesThen(16, async (port) => [await postAs(port, "/v1/rpc/solana", someGma(), "198.51.100.77"), await postAs(port, "/v1/rpc/solana", someGma(), "192.0.2.30")]);
  assert.equal(r.refused, 0);
  assert.deepEqual(r.st, [429, 200], "the address's 16 pages spent its share of the one budget; another address still reads");
});
