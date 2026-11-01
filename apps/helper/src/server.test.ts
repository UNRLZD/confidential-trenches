// node --test apps/helper/src/server.test.ts: the helper answers /v1/health with the six parts and its commit, and
// allows cross-origin reads for exactly the two origins (markets paper H7), on a real server on a free port.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { PARTS } from "./health.ts";
import { handler, start } from "./server.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://confidential.unrealized.trade";
const SIGN = "https://sign.confidential.unrealized.trade";
let port = 0;
const server = start(COMMIT, 0);
before(() => new Promise<void>((ok) => server.on("listening", () => ((port = (server.address() as AddressInfo).port), ok()))));
after(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));

// raw http, so the Origin header is sent exactly as written (fetch would add or forbid some headers)
function call(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail).end();
  });
}

test("GET /v1/health: 200, the six parts all down, the commit in the body and in X-Helper-Commit", async () => {
  const r = await call("GET", "/v1/health");
  assert.equal(r.status, 200);
  const b = JSON.parse(r.body);
  assert.deepEqual(b, { ok: true, commit: COMMIT, parts: Object.fromEntries(PARTS.map((p) => [p, "down"])) });
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
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(seen, []);
});
