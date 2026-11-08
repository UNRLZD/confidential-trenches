// node --test apps/helper/src/data/evm/route.test.ts: GET /v1/market/lists?chain=base on a real server on a free port,
// with the recorded GeckoTerminal lists and the providers' recorded maker logs behind a fake fetch: the snapshot in the
// frozen fields with launchpad tags, the commit, source, read time and CORS rule; gzip when asked; exactly one chain;
// a chain this helper does not serve 404; 503 when GeckoTerminal has never answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { ROW_FIELDS } from "../../../../terminal/src/screens/discover/fields.ts";
import { start } from "../../server.ts";
import { geckoBudget } from "../gecko.ts";
import { createEvmLists, GT_BASE, GT_READS, MAKER_RPCS, makerFilters } from "./lists.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const GT: Record<string, string> = {
  [`${GT_BASE}/networks/base/${GT_READS.new}`]: fx("gt-base-new.json"),
  [`${GT_BASE}/networks/base/${GT_READS.trending_5m}`]: fx("gt-base-trending-5m.json"),
  [`${GT_BASE}/networks/base/${GT_READS.trending_1h}`]: fx("gt-base-trending-1h.json"),
};
const MAKERS = JSON.parse(fx("maker-logs-base.json")) as { recorded_at: string; cases: { address: string; range: [number, number]; pad: string | null; answers: (unknown[] | null)[][] }[] };
const NOW = Date.parse(MAKERS.recorded_at);
const fake = (gtStatus = 200) => async (url: string, init: RequestInit): Promise<Response> => {
  if (url.startsWith(GT_BASE)) return gtStatus === 200 ? new Response(GT[url]!, { status: 200 }) : new Response("{}", { status: gtStatus });
  const which = MAKER_RPCS.base.indexOf(url as never);
  const reqs = JSON.parse(String(init.body)) as { id: number; params: [{ fromBlock: string; toBlock: string }] }[];
  return new Response(JSON.stringify(reqs.map((r) => {
    const c = MAKERS.cases.find((x) => x.range[0] === parseInt(r.params[0].fromBlock, 16) && x.range[1] === parseInt(r.params[0].toBlock, 16))!;
    const logs = c.answers[which]![makerFilters("base", ...c.range).findIndex((f) => JSON.stringify(f) === JSON.stringify(r.params[0]))];
    return logs === null ? { jsonrpc: "2.0", id: r.id, error: { code: -32602 } } : { jsonrpc: "2.0", id: r.id, result: logs };
  })), { status: 200 });
};
const up = createEvmLists("base", geckoBudget(() => NOW), { fetch: fake(), now: () => NOW });
const down = createEvmLists("base", geckoBudget(() => NOW), { fetch: fake(503), now: () => NOW });

const servers = [start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { base: up }), start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { base: down })];
const ports: number[] = [];
before(async () => {
  await Promise.all(servers.map((s, i) => new Promise<void>((ok) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), ok())))));
  for (let i = 0; i < 6; i++) await up.tick();
});
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

test("GET /v1/market/lists?chain=base: 200, rows in the frozen fields, launchpad tags from the maker read, the commit, source, read time and CORS", async () => {
  const r = await call("GET", "/v1/market/lists?chain=base", { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["x-helper-source"], "geckoterminal");
  assert.equal(r.headers["x-fetched-at"], new Date(NOW).toISOString());
  assert.equal(r.headers["access-control-allow-origin"], APP);
  const s = JSON.parse(r.body.toString("utf8"));
  assert.equal(s.chain, "base");
  assert.deepEqual(Object.keys(s.lists), ["new", "trending", "trending_5m", "trending_1h", "graduating"]);
  const rows = Object.values(s.lists).flat() as Record<string, unknown>[];
  for (const row of rows) assert.deepEqual(Object.keys(row), [...ROW_FIELDS]);
  const tagged = rows.filter((x) => x.launchpad !== null);
  assert.ok(tagged.length > 0, "the recorded lists hold launchpad tokens");
  for (const t of tagged) assert.equal(MAKERS.cases.find((c) => c.address === t.token)!.pad, t.launchpad);
  const z = await call("GET", "/v1/market/lists?chain=base", { "accept-encoding": "gzip" });
  assert.equal(z.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(z.body), (await call("GET", "/v1/market/lists?chain=base")).body);
});

test("exactly one chain this helper serves: robinhood (not served here), BASE, base twice and eip155:8453 are 404", async () => {
  for (const q of ["?chain=robinhood", "?chain=BASE", "?chain=base&chain=base", "?chain=eip155:8453", "?chain=base&chain=solana", "?chain=__proto__", "?chain=constructor"]) {
    const r = await call("GET", `/v1/market/lists${q}`);
    assert.equal(r.status, 404, q);
    assert.deepEqual(JSON.parse(r.body.toString("utf8")), { error: { code: "not_found" } });
  }
});

test("GeckoTerminal never answered: 503 upstream, with the commit and CORS", async () => {
  const r = await call("GET", "/v1/market/lists?chain=base", { origin: APP }, 1);
  assert.equal(r.status, 503);
  assert.deepEqual(JSON.parse(r.body.toString("utf8")), { error: { code: "upstream" } });
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
});
