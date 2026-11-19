// node --test apps/helper/src/shed.test.ts: card helper-answers-through-a-burst. Past the helper's capacity
// (limits/loop-busy.ts loopShed) a market data read is answered at once a 503 the page reads: its CORS headers, the kit's
// `upstream` code and a Retry-After, with nothing read. A relay, a proof's fee, a quote, a device's RPC read, the pool
// list a buy reads, the token status, health and a preflight are never shed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { SHED_LATE_MS } from "./limits/loop-busy.ts";
import { handler, SHED_PATHS, shedsPath, start, UPSTREAM_RETRY_AFTER_S } from "./server.ts";
import { call as bounded, listening } from "../test/servers.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const MINT = "So11111111111111111111111111111111111111112";
const state = { shed: true };
// every argument but the shed at its default (server.ts handler: 25 between the commit and the shed), the shed the test's
// own switch
const server = createServer((handler as (...a: unknown[]) => ReturnType<typeof handler>)(COMMIT, ...Array.from({ length: 25 }, () => undefined), () => state.shed));
let port = 0;
server.listen(0, "127.0.0.1");
before(async () => void (port = await listening(server, "the helper")));
after(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));
const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => bounded(port, { method, path, headers: { origin: APP, ...headers }, body, agent: false }, "the helper");

const MARKET = [
  "/v1/market/lists?chain=solana",
  "/v1/market/lists?chain=base",
  `/v1/market/token?chain=solana&token=${MINT}`,
  `/v1/market/holders?chain=solana&token=${MINT}`,
  `/v1/market/candles?chain=solana&token=${MINT}&tf=15m&limit=2`,
  `/v1/market/trades?chain=solana&token=${MINT}&limit=50`,
  `/v1/market/held?chain=solana&tokens=${MINT}`,
  `/v1/logo/solana/${MINT}`,
];

test("past capacity every market data read is a 503 the page reads, before any read: CORS, the upstream code, a Retry-After", async () => {
  state.shed = true;
  for (const path of MARKET) {
    const r = await call("GET", path);
    assert.equal(r.status, 503, path);
    assert.equal(r.headers["access-control-allow-origin"], APP, `${path}: the page reads it`);
    assert.match(String(r.headers["access-control-expose-headers"]), /Retry-After/i, path);
    assert.equal(r.headers["retry-after"], String(UPSTREAM_RETRY_AFTER_S), path);
    assert.equal(r.headers["x-helper-commit"], COMMIT, path);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "upstream" } }, path);
  }
});

test("past capacity nothing that is not market data is shed: health, token status, the withdrawal fee, a pool's fee, a send, the buy's pool list, an RPC read, a quote, a bind, intents, a preflight", async () => {
  state.shed = true;
  // a shed answer: 503, the upstream code alone and the shed's wait
  const notShed = async (method: string, path: string, body?: string) => {
    const r = await call(method, path, body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body);
    assert.ok(!(r.status === 503 && r.body === '{"error":{"code":"upstream"}}' && r.headers["retry-after"] === String(UPSTREAM_RETRY_AFTER_S)), `${method} ${path}: shed`);
    return r;
  };
  assert.equal((await notShed("GET", "/v1/health")).status, 200);
  assert.equal((await notShed("GET", "/v1/token-status?token=nope")).status, 404);
  assert.equal((await notShed("GET", "/v1/withdraw/fee?token=nope")).status, 404);
  assert.equal((await notShed("GET", "/v1/market/pools?chain=base&token=0x0000000000000000000000000000000000000001")).status, 200);
  assert.notEqual((await notShed("GET", "/v1/pool/fee?pool=11111111111111111111111111111111")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/pool/solana/send", "{}")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/withdraw", "{}")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/bind", "{}")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/intents", "{}")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/rpc/solana", "not json")).status, 503);
  assert.notEqual((await notShed("POST", "/v1/proxy/nope/x", "{}")).status, 503);
  const pre = await call("OPTIONS", "/v1/market/lists?chain=solana", { "access-control-request-method": "GET" });
  assert.equal(pre.status, 204, "a preflight is answered, so the 503 behind it is read");
  assert.equal(pre.headers["access-control-allow-origin"], APP);
});

test("under capacity a market read is not shed (a logo path that names no token: its own 404)", async () => {
  state.shed = false;
  const r = await call("GET", "/v1/logo/solana/not-a-token");
  assert.equal(r.status, 404);
  state.shed = true;
  assert.equal((await call("GET", "/v1/logo/solana/not-a-token")).status, 503, "the same read past capacity is shed before it is parsed");
});

test("the shed set is market data only", () => {
  assert.deepEqual([...SHED_PATHS].sort(), ["/v1/market/candles", "/v1/market/held", "/v1/market/holders", "/v1/market/lists", "/v1/market/token", "/v1/market/trades"]);
  for (const p of ["/v1/health", "/v1/token-status", "/v1/withdraw", "/v1/withdraw/fee", "/v1/pool/fee", "/v1/pool/solana/send", "/v1/pool/solana/pieces", "/v1/pool/evm/send", "/v1/pool/evm/sell", "/v1/bind", "/v1/bind/record", "/v1/intents", "/v1/market/pools", "/v1/market/push", "/v1/rpc/solana", "/v1/proxy/jupiter/swap/v1/quote"]) {
    assert.equal(shedsPath(p), false, p);
  }
  assert.equal(shedsPath("/v1/logo/solana/x"), true);
});

test("start() sheds by the process's own loop: a market read that meets a loop held past SHED_LATE_MS is a 503, a health read beside it is not", async (t) => {
  const helper = start(COMMIT, 0);
  t.after(() => new Promise<void>((ok) => (helper.closeAllConnections(), helper.close(() => ok()))));
  const at = await listening(helper, "the started helper");
  const get = (path: string) => bounded(at, { method: "GET", path, headers: { origin: APP }, agent: false }, "the started helper");
  assert.equal((await get("/v1/logo/solana/not-a-token")).status, 404, "an idle loop sheds nothing");
  const reads = [get("/v1/logo/solana/not-a-token"), get("/v1/health")] as const;
  // hold this process's loop (the helper's own) past SHED_LATE_MS before either request is read
  const until = performance.now() + 2 * SHED_LATE_MS;
  while (performance.now() < until);
  const [logo, health] = await Promise.all(reads);
  assert.equal(logo.status, 503, "the market read is shed");
  assert.equal(logo.headers["access-control-allow-origin"], APP);
  assert.equal(health.status, 200, "health is never shed");
});
