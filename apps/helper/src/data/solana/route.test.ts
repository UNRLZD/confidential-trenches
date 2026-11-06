// node --test apps/helper/src/data/solana/route.test.ts: GET /v1/market/lists?chain=solana on a real server on a free
// port, with the recorded Jupiter lists behind a fake proxy: the snapshot with the commit, source, read time and CORS
// rule; gzip when asked; only GET and HEAD; exactly one chain, Solana; 503 when the vendor has never answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { start } from "../../server.ts";
import { createSolanaLists, pumpCurveAddress, READS, ROW_FIELDS } from "./lists.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const AT = "2026-11-01T15:16:30.000Z";
const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const BODY: Record<string, string> = { [READS.new]: fx("jupiter-recent.json"), [READS.trending_5m]: fx("jupiter-toptrending-5m.json"), [READS.trending_1h]: fx("jupiter-toptrending-1h.json") };
const CURVES = JSON.parse(fx("solana-pump-curves.json"));
// each account from the recording by its address (the recorded pump.fun curves), every other account none
const CURVE_BY_KEY = new Map((CURVES.request_mints as string[]).map((m, i) => [pumpCurveAddress(m), CURVES.answer.result.value[i]]));
const rpc = {
  handle: async (_c: string, _t: string | undefined, body: string) => {
    const keys = JSON.parse(body).params[0] as string[];
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: keys.map((k) => CURVE_BY_KEY.get(k) ?? null) } }) };
  },
};
const up = createSolanaLists({ handle: async (_v: string, p: string) => ({ status: 200, headers: { "X-Fetched-At": AT }, body: BODY[p]! }) }, rpc);
const down = createSolanaLists({ handle: async () => ({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' }) }, rpc);

const servers = [start(COMMIT, 0, undefined, undefined, undefined, up), start(COMMIT, 0, undefined, undefined, undefined, down)];
const ports: number[] = [];
before(() => Promise.all(servers.map((s, i) => new Promise<void>((ok) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), ok()))))));
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))));

function call(method: string, path: string, headers: Record<string, string> = {}, to = 0) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: ports[to], method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", fail).end();
  });
}

test("GET /v1/market/lists?chain=solana: 200, the snapshot of rows in the field list, the commit, source, read time and CORS echo", async () => {
  const r = await call("GET", "/v1/market/lists?chain=solana", { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["x-helper-source"], "jupiter");
  assert.equal(r.headers["x-fetched-at"], AT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.equal(r.headers["vary"], "Origin, Accept-Encoding");
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(Number(r.headers["content-length"]), r.body.length);
  const s = JSON.parse(r.body.toString("utf8"));
  assert.equal(s.chain, "solana");
  assert.equal(s.as_of_ms, Date.parse(AT));
  assert.deepEqual(Object.keys(s.lists), ["new", "trending", "trending_5m", "trending_1h", "graduating"]);
  for (const k of Object.keys(s.lists)) for (const row of s.lists[k]) assert.deepEqual(Object.keys(row), [...ROW_FIELDS]);
  assert.ok(s.lists.new.length > 0 && s.lists.trending_5m.length > 0 && s.lists.graduating.length > 0);
});

test("gzip when the caller accepts it: the same snapshot", async () => {
  const plain = await call("GET", "/v1/market/lists?chain=solana");
  const z = await call("GET", "/v1/market/lists?chain=solana", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(z.headers["content-encoding"], "gzip");
  assert.equal(Number(z.headers["content-length"]), z.body.length);
  assert.ok(z.body.length < plain.body.length / 4);
  assert.deepEqual(gunzipSync(z.body), plain.body);
});

test("HEAD answers the headers only; another method 405; any chain but exactly one solana 404", async () => {
  const h = await call("HEAD", "/v1/market/lists?chain=solana");
  assert.equal(h.status, 200);
  assert.equal(h.body.length, 0);
  for (const m of ["POST", "PUT", "DELETE"]) {
    const r = await call(m, "/v1/market/lists?chain=solana");
    assert.equal(r.status, 405, m);
    assert.equal(r.headers["allow"], "GET, HEAD, OPTIONS");
  }
  for (const q of ["", "?chain=base", "?chain=SOLANA", "?chain=solana&chain=solana", "?chain=eip155:4663", "?chain=near"]) {
    const r = await call("GET", `/v1/market/lists${q}`);
    assert.equal(r.status, 404, q);
    assert.deepEqual(JSON.parse(r.body.toString("utf8")), { error: { code: "not_found" } });
  }
  assert.equal((await call("GET", "/v1/market/lists/x?chain=solana")).status, 404);
});

test("the vendor never answered: 503 upstream, with the commit and CORS", async () => {
  const r = await call("GET", "/v1/market/lists?chain=solana", { origin: APP }, 1);
  assert.equal(r.status, 503);
  assert.deepEqual(JSON.parse(r.body.toString("utf8")), { error: { code: "upstream" } });
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
});
