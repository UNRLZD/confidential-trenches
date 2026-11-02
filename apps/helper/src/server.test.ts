// node --test apps/helper/src/server.test.ts: the helper answers /v1/health with the six parts and its commit, and
// allows cross-origin reads for exactly the two origins (markets paper H7), on a real server on a free port.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { PARTS } from "./health.ts";
import { createRpc } from "./rpc/rpc.ts";
import { handler, start, WITHDRAW_BODY_MAX } from "./server.ts";
import { FeeReadRefused, type FeeQuoter } from "./withdraw/fee.ts";
import type { WithdrawSender } from "./withdraw/send.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://confidential.unrealized.trade";
const SIGN = "https://sign.confidential.unrealized.trade";
let port = 0;
const server = start(COMMIT, 0);
before(() => new Promise<void>((ok) => server.on("listening", () => ((port = (server.address() as AddressInfo).port), ok()))));
after(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));

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

test("GET /v1/health: 200, proxy up (/v1/proxy/ and /v1/rpc/ are mounted), relay up (/v1/token-status) and the other four down, the commit in the body and in X-Helper-Commit", async () => {
  const r = await call("GET", "/v1/health");
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  assert.deepEqual(b, { ok: true, commit: COMMIT, parts: Object.fromEntries(PARTS.map((p) => [p, p === "proxy" || p === "relay" ? "up" : "down"])) });
  assert.deepEqual(Object.keys(b.parts), ["proxy", "relay", "intents", "delegate", "orders", "log"]);
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["vary"], "Origin");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(Buffer.byteLength(r.body) <= 1024, "1 KB limit (H7)");
  assert.equal(r.headers["set-cookie"], undefined);
});

test("each of the two origins is echoed byte for byte, with Vary: Origin and no credentials", async () => {
  for (const o of [APP, SIGN]) {
    const r = await call("GET", "/v1/health", { origin: o });
    assert.equal(r.headers["access-control-allow-origin"], o);
    assert.equal(r.headers["vary"], "Origin");
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
    assert.equal(r.headers["access-control-expose-headers"], "X-Helper-Commit, X-Helper-Source, X-Fetched-At");
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

test("/v1/rpc forwards an allowlisted call to the configured provider and passes its answer back (local stub)", async () => {
  const seen: string[] = [];
  const stub = createServer((req, res) => {
    let b = "";
    req.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => {
      seen.push(b);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    });
  });
  await new Promise<void>((ok) => stub.listen(0, "127.0.0.1", () => ok()));
  const up = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  const helper = start(COMMIT, 0, undefined, createRpc({ SOLANA_RPC_URL: up }));
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

test("GET /v1/withdraw/fee: the quoter's answer for one carried token; another token, two tokens or none 404 not_found; reads refused 503 upstream; POST 405", async () => {
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

test("POST /v1/withdraw: the body parsed and handed to the sender, its status and code answered; not JSON 400 bad_shape; over 8 KB 413 too_large; GET 405", async () => {
  const seen: unknown[] = [];
  const withdraw: WithdrawSender = {
    carry: async (body) => {
      seen.push(body);
      const t = (body as { token?: unknown }).token;
      if (t === "halted.near") return { status: 503, body: { error: { code: "token_halted" } } };
      if (t === "carried.near") return { status: 200, body: { tx_hash: "4YsDRNYepeb4u16677E9WYB5DSF69EwnUuG6XLAV7eBL", state: "submitted" } };
      return { status: 400, body: { error: { code: "bad_shape" } } };
    },
    stop: () => undefined,
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, withdraw);
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
