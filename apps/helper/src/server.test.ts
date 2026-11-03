// node --test apps/helper/src/server.test.ts: the helper answers /v1/health with the six parts and its commit, and
// allows cross-origin reads for exactly the two origins (markets paper H7), on a real server on a free port.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { HELPER_BIND_ANSWER_MS } from "@blindfill/kit";
import { PARTS, releaseOf } from "./health.ts";
import { createRpc } from "./rpc/rpc.ts";
import type { BindSender } from "./bind/env.ts";
import { BIND_BODY_MAX, handler, start, WITHDRAW_BODY_MAX } from "./server.ts";
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

test("GET /v1/health: 200, proxy up (/v1/proxy/ and /v1/rpc/ are mounted), relay up (/v1/token-status), delegate up (/v1/bind) and the other three down, the commit in the body and in X-Helper-Commit", async () => {
  const r = await call("GET", "/v1/health");
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  // release: null, as this test's environment sets no HELPER_RELEASE
  assert.deepEqual(b, { ok: true, commit: COMMIT, release: null, parts: Object.fromEntries(PARTS.map((p) => [p, p === "proxy" || p === "relay" || p === "delegate" ? "up" : "down"])) });
  assert.deepEqual(Object.keys(b.parts), ["proxy", "relay", "intents", "delegate", "orders", "log"]);
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["vary"], "Origin");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(Buffer.byteLength(r.body) <= 1024, "1 KB limit (H7)");
  assert.equal(r.headers["set-cookie"], undefined);
});

// card helper-release-bump: the release HELPER_RELEASE names (deploy/redeploy.sh raises it per new commit) is in the
// answer, so the live check can read that a deploy raised it
test("GET /v1/health carries HELPER_RELEASE as a number; none or a value the relayers would refuse is null", async () => {
  assert.equal(releaseOf({ HELPER_RELEASE: "12" }), 12);
  assert.equal(releaseOf({ HELPER_RELEASE: "999999999" }), 999999999);
  for (const v of [undefined, "", "0", "07", "1.5", "-1", " 3", "3\n", "1000000000", "abc"]) assert.equal(releaseOf({ HELPER_RELEASE: v }), null, JSON.stringify(v));
  const helper = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 12));
  await new Promise<void>((ok) => helper.listen(0, "127.0.0.1", () => ok()));
  try {
    const r = await call("GET", "/v1/health", { origin: APP }, undefined, (helper.address() as AddressInfo).port);
    assert.equal(r.status, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.release, 12);
    assert.deepEqual(Object.keys(b), ["ok", "commit", "release", "parts"]);
    assert.ok(Buffer.byteLength(r.body) <= 1024, "1 KB limit (H7)");
  } finally {
    helper.closeAllConnections();
    await new Promise<void>((ok) => helper.close(() => ok()));
  }
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
    warm: () => void warmed++,
    stop: () => undefined,
  };
  let warmed = 0;
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, withdraw);
  assert.equal(warmed, 1, "start warms the withdrawal relayer: a restart resends its open sends before any request");
  // and the helper's main starts the server with the relayer it built
  const main = readFileSync(join(import.meta.dirname, "server.ts"), "utf8").split("if (import.meta.main)")[1] ?? "";
  assert.match(main, /const withdraw = withdrawSenderFromEnv\(process\.env, fee, statusesOf\(watches\)\);/);
  assert.match(main, /const bind = bindSenderFromEnv\(process\.env, watches\);/);
  assert.match(main, /for \(const p of pools\.values\(\)\) p\.ready\.catch\(\(e: Error\) => \(console\.error\(`helper: \$\{e\.message\}`\), process\.exit\(2\)\)\);/);
  assert.doesNotMatch(main, /await[^;]*\.ready/, "a pool's rent read never holds up the helper's start");
  assert.match(main, /server = start\(commit, port, proxy, rpc, watches, lists, fee, withdraw, undefined, bind, pools\);/);
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

test("POST /v1/bind: mounted; with no network set the helper starts and a body that does not decode is 400 bad_shape (networks.test.ts: a delegate on no carried token is token_not_accepted); over 4 KB 413; GET 405", async () => {
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

test("POST /v1/bind answers within the kit's HELPER_BIND_ANSWER_MS, which the device's send waits for: a carry still running then answers in_flight and goes on to its own end; one that ends inside it answers its own", async () => {
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
      entered();
      await gate; // the prepay and the delegate, read at final
      finished++;
      return { status: 200, body: { tx_hash: TX } };
    },
    warm: () => undefined,
    stop: () => undefined,
  };
  const helper = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, bind);
  await new Promise<void>((ok) => helper.on("listening", () => ok()));
  const to = (helper.address() as AddressInfo).port;
  mock.timers.enable({ apis: ["setTimeout"] });
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

test("POST /v1/bind is not tied to the request: a client that closes at 1 s does not cancel the carry, which runs to its answer and its record; the helper keeps serving", async () => {
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

// M362 (3): the helper's own main, as the host runs it, with one devnet Solana pool whose two RPCs are local stubs.
// A failed rent read takes down only that pool (503 upstream) and the rest answers; a configured fee that is not the
// kit's for the rent read makes the process exit 2. Test keys only: sha256 of a label.
test("M362 (3): a pool's failed rent read leaves the helper up with that pool 503; a mismatched configured fee exits 2", async () => {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { solanaPoolAccount } = await import("@blindfill/kit");
  const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
  const { base58 } = await import("./bind/checks.ts");
  const seed = new Uint8Array(createHash("sha256").update("helper-pool-senders/server/FP").digest());
  const feePayer = base58(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]));
  const program = base58(ed25519.getPublicKey(new Uint8Array(createHash("sha256").update("helper-pool-senders/server/PROGRAM").digest())));
  const RENT = "2BMAAAAAAAAAAAAAAADwPzI="; // the Rent sysvar devnet and mainnet answer (5,080 a byte, factor 2): fee 1,300,000
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
  await Promise.all(stubs.map((s) => new Promise((ok) => s.on("listening", ok))));
  const urls = stubs.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`).join(",");
  const free = createServer().listen(0, "127.0.0.1");
  await new Promise((ok) => free.on("listening", ok));
  const hp = (free.address() as AddressInfo).port;
  await new Promise((ok) => free.close(ok));
  const run = (fee: string) =>
    spawn(process.execPath, [join(import.meta.dirname, "server.ts")], {
      env: { PATH: process.env.PATH, HELPER_COMMIT: COMMIT, PORT: String(hp), POOL_SOLANA_PROGRAM_DEVNET: program, POOL_SOLANA_FEE_PAYER_KEY_DEVNET: feePayer, POOL_SOLANA_FEE_DEVNET: fee, POOL_SOLANA_RPCS_DEVNET: urls },
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
