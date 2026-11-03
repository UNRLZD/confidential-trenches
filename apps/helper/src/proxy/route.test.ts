// node --test apps/helper/src/proxy/route.test.ts: POST /v1/proxy/{vendor}/{path} on a real server on a free port,
// with a fake vendor behind it: the raw path is matched (never a normalised one), only POST, the 64 KB body cap on the
// wire, the caller's headers never reach the vendor, and every answer has the commit and the CORS rule (H7).
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { start } from "../server.ts";
import { createProxy } from "./proxy.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://confidential.unrealized.trade";
const KEY = "fake-jupiter-key-" + "j".repeat(16);
const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
const proxy = createProxy(
  { JUPITER_API_KEY: KEY },
  {
    fetch: async (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) }, body: init.body });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  },
);
let port = 0;
const server = start(COMMIT, 0, proxy);
before(() => new Promise<void>((ok) => server.on("listening", () => ((port = (server.address() as AddressInfo).port), ok()))));
after(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));

function call(method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", fail);
    r.end(body);
  });
}

test("a proxied read: 200, the vendor's body, the source, the commit and the CORS echo; no caller header reaches the vendor", async () => {
  seen.length = 0;
  const r = await call("POST", "/v1/proxy/jupiter/swap/v2/build?inputMint=So11&amount=5", {
    origin: APP,
    cookie: "session=1",
    "x-forwarded-for": "203.0.113.7",
    "user-agent": "phone",
    "x-api-key": "callers-own-key-000",
    authorization: "Bearer callers-own",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"ok":true}');
  assert.equal(r.headers["x-helper-source"], "jupiter");
  assert.match(String(r.headers["x-fetched-at"]), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.equal(r.headers["access-control-expose-headers"], "X-Helper-Commit, X-Helper-Source, X-Fetched-At, Retry-After");
  assert.equal(r.headers["vary"], "Origin");
  assert.equal(r.headers["access-control-allow-credentials"], undefined);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(seen, [{ url: "https://api.jup.ag/swap/v2/build?inputMint=So11&amount=5", headers: { accept: "application/json", "x-api-key": KEY }, body: undefined }]);
  assert.ok(!JSON.stringify(r.headers).includes(KEY) && !r.body.includes(KEY));
});

test("the raw path is matched: dot segments, encodings and a missing path never reach a vendor", async () => {
  seen.length = 0;
  for (const [path, status] of [
    ["/v1/proxy/jupiter/swap/v2/../v2/build", 400],
    ["/v1/proxy/jupiter/swap/v2/./build", 400],
    ["/v1/proxy/jupiter/swap%2Fv2%2Fbuild", 400],
    ["/v1/proxy/jupiter/swap/v2/buil%64", 400],
    ["/v1/proxy/jupiter", 404],
    ["/v1/proxy/jupiter/", 400],
    ["/v1/proxy//swap/v2/build", 404],
    ["/v1/proxy/nobody/x", 404],
  ] as const) {
    const r = await call("POST", path, { origin: APP });
    assert.equal(r.status, status, path);
    assert.equal(r.headers["access-control-allow-origin"], APP, path);
    assert.equal(r.headers["x-helper-commit"], COMMIT, path);
    assert.ok(JSON.parse(r.body).error.code, path);
  }
  assert.equal(seen.length, 0);
});

test("only POST; a body over 64 KB answers 413 too_large, by its length or as it arrives", async () => {
  seen.length = 0;
  const g = await call("GET", "/v1/proxy/jupiter/swap/v2/build");
  assert.equal(g.status, 405);
  assert.equal(g.headers["allow"], "POST, OPTIONS");
  const big = await call("POST", "/v1/proxy/jupiter/swap/v2/build", { "content-type": "application/json" }, Buffer.alloc(65_537, 0x20));
  assert.deepEqual([big.status, JSON.parse(big.body)], [413, { error: { code: "too_large" } }]);
  const chunked = await call("POST", "/v1/proxy/jupiter/swap/v2/build", { "transfer-encoding": "chunked" }, Buffer.alloc(70_000, 0x20));
  assert.equal(chunked.status, 413);
  assert.equal(seen.length, 0);
});

test("a preflight from APP_HOST for a proxy POST with content-type is allowed", async () => {
  const r = await call("OPTIONS", "/v1/proxy/relay/quote/v2", { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "content-type" });
  assert.equal(r.status, 204);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.equal(r.headers["access-control-allow-headers"], "content-type");
});
