// chain=near on the market routes (card helper-near-lists-and-token): with NEAR's reads mounted, the lists, token page,
// holders, candles and tape answer 200 in the other chains' headers (source, read time, CORS); with none mounted, and for
// a malformed request, 404 as before. The reads are stubs answering the local helper's recorded answers, so this file
// holds the routing alone (lists.test.ts and trades.test.ts hold the reads).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { start } from "../../server.ts";
// the candles' default limit is the other chains' (server.ts CANDLES_MAX)
import { CANDLES_MAX as CANDLES_DEFAULT } from "../solana/token.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const snapshot = readFileSync(new URL("./fixtures/snapshot-2026-11-11.json", import.meta.url), "utf8");
const AS_OF = (JSON.parse(snapshot) as { as_of_ms: number }).as_of_ms;
const ok = (body: unknown, src: string) => ({ status: 200, body: JSON.stringify(body), src, asOfMs: AS_OF });
const asked: string[] = [];
const near = {
  lists: { get: async () => ({ status: 200, body: snapshot, gzip: Buffer.from([]), asOfMs: AS_OF }) },
  token: {
    page: async (t: string) => (asked.push(`page ${t}`), ok({ row: { chain: "near", token: t } }, "chain")),
    holders: async (t: string) => (asked.push(`holders ${t}`), ok({ holders: [], total: null, top_bps: null, src: "none", as_of_ms: AS_OF }, "none")),
  },
  trades: {
    trades: async (t: string, limit: number) => (asked.push(`trades ${t} ${limit}`), ok({ trades: [], src: "fastnear", as_of_ms: AS_OF }, "fastnear")),
    candles: async (t: string, tf: string, to: number | null, limit: number) => (asked.push(`candles ${t} ${tf} ${to} ${limit}`), ok({ tf, candles: [], src: "fastnear", as_of_ms: AS_OF }, "fastnear")),
  },
};
const none = Array(21).fill(undefined);
none[0] = COMMIT;
none[1] = 0;
const mounted = [...none];
mounted[20] = near;
const servers = [start(...(mounted as Parameters<typeof start>)), start(...(none as Parameters<typeof start>))];
const ports: number[] = [];
before(() => Promise.all(servers.map((s, i) => new Promise<void>((done) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), done()))))));
after(() => Promise.all(servers.map((s) => new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done()))))));

function call(path: string, to = 0, headers: Record<string, string> = { origin: APP }) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((done, fail) => {
    const r = request({ host: "127.0.0.1", port: ports[to], method: "GET", path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", fail).end();
  });
}

test("GET /v1/market/lists?chain=near: 200, NEAR's snapshot, source chain, its read time and CORS", async () => {
  const r = await call("/v1/market/lists?chain=near");
  assert.equal(r.status, 200);
  const body = JSON.parse((r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.body).toString("utf8"));
  assert.equal(body.chain, "near");
  assert.ok(body.lists.new.length > 0 && body.lists.trending.length > 0);
  assert.equal(r.headers["x-helper-source"], "chain");
  assert.equal(r.headers["x-fetched-at"], new Date(AS_OF).toISOString());
  assert.equal(r.headers["access-control-allow-origin"], APP);
});

for (const [path, src, want] of [
  ["/v1/market/token?chain=near&token=token.rhealab.near", "chain", "page token.rhealab.near"],
  ["/v1/market/holders?chain=near&token=token.rhealab.near", "none", "holders token.rhealab.near"],
  ["/v1/market/trades?chain=near&token=token.rhealab.near", "fastnear", "trades token.rhealab.near 50"],
  ["/v1/market/trades?chain=near&token=token.rhealab.near&limit=7", "fastnear", "trades token.rhealab.near 7"],
  ["/v1/market/candles?chain=near&token=token.rhealab.near&tf=1m", "fastnear", "candles token.rhealab.near 1m null 1000"],
  ["/v1/market/candles?chain=near&token=token.rhealab.near&tf=1h&to=1794420000&limit=20", "fastnear", "candles token.rhealab.near 1h 1794420000 20"],
] as const) {
  test(`GET ${path}: 200 from NEAR's reads, source ${src}, its read time`, async () => {
    asked.length = 0;
    const r = await call(path);
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(r.headers["x-helper-source"], src);
    assert.equal(r.headers["x-fetched-at"], new Date(AS_OF).toISOString());
    assert.equal(r.headers["access-control-allow-origin"], APP);
    assert.deepEqual(asked, [want.replace(" 1000", ` ${CANDLES_DEFAULT}`)]);
  });
}

for (const path of [
  "/v1/market/trades?chain=near&token=token.rhealab.near&limit=51",
  "/v1/market/trades?chain=near&token=token.rhealab.near&limit=0",
  "/v1/market/candles?chain=near&token=token.rhealab.near",
  "/v1/market/candles?chain=near&token=token.rhealab.near&tf=1m&tf=1h",
  "/v1/market/token?chain=near",
  "/v1/market/token?chain=near&token=a&token=b",
  "/v1/market/lists?chain=near&chain=near",
]) {
  test(`GET ${path}: 404, nothing read`, async () => {
    asked.length = 0;
    assert.equal((await call(path)).status, 404);
    assert.deepEqual(asked, []);
  });
}

test("chain=near with no NEAR reads mounted: 404 on every route, as before", async () => {
  for (const p of ["/v1/market/lists?chain=near", "/v1/market/token?chain=near&token=token.rhealab.near", "/v1/market/trades?chain=near&token=token.rhealab.near", "/v1/market/candles?chain=near&token=token.rhealab.near&tf=1m"]) {
    assert.equal((await call(p, 1)).status, 404, p);
  }
});
