// node --test apps/helper/src/data/evm/swaps-route.test.ts: GET /v1/market/candles?chain=base and GET /v1/market/trades on a
// real server on a free port, with recorded Base logs behind a fake chain of three providers: the frozen wire fields,
// the commit, the source ("chain": our own reads), the read time and CORS rule; exactly one chain, token, tf; limits;
// a token that is not on the Discover lists, a chain this helper has no own reads for, and Solana's candles unchanged.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { start } from "../../server.ts";
import { fakeChain, ICNT, KNOWN, open, REC, timeOf, VVV } from "../../../test/evm-swaps/base.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://ct-app.unrealized.trade";
const chain = fakeChain();
chain.st.head = REC.firstHead + 400;
const swaps = open(chain, { t: 1_000_000 }, { listed: async (t) => t === ICNT, pools: new Map([[ICNT, KNOWN.get(ICNT)!]]) });
const server = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { base: swaps });
let port = 0;
before(async () => {
  await new Promise<void>((ok) => server.on("listening", () => ((port = (server.address() as AddressInfo).port), ok())));
});
after(() => new Promise<void>((ok) => (swaps.stop(), server.closeAllConnections(), server.close(() => ok()))));

function call(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail).end();
  });
}

test("GET /v1/market/candles?chain=base: 200, the frozen fields, bars from our own reads, source chain, the commit, read time and CORS", async () => {
  const r = await call("GET", `/v1/market/candles?chain=base&token=${ICNT}&tf=1m&limit=50`, { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["x-helper-source"], "chain");
  assert.equal(r.headers["access-control-allow-origin"], APP);
  assert.match(String(r.headers["x-fetched-at"]), /^\d{4}-\d\d-\d\dT/);
  const b = JSON.parse(r.body);
  assert.deepEqual(Object.keys(b), ["tf", "candles", "src", "own_from_s", "as_of_ms"]);
  assert.equal(b.tf, "1m");
  assert.equal(b.src, "chain");
  assert.ok(b.candles.length > 3 && b.candles.length <= 50);
  for (const c of b.candles) {
    assert.equal(c.length, 6);
    assert.equal(typeof c[0], "number");
    assert.equal(c[0] % 60, 0);
    for (const v of c.slice(1)) assert.match(v, /^\d+(\.\d+)?$/);
    assert.ok(c[0] <= timeOf(REC.firstHead + 400));
  }
  assert.deepEqual(b.candles.map((c: number[]) => c[0]), [...b.candles.map((c: number[]) => c[0])].sort((x, y) => x - y), "oldest first");
  assert.equal(b.own_from_s, b.candles[0][0]);
});

test("GET /v1/market/trades?chain=base: the tape newest first in the frozen fields, the traders read from the chain", async () => {
  const r = await call("GET", `/v1/market/trades?chain=base&token=${ICNT}&limit=20`, { origin: APP });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-helper-source"], "chain");
  assert.equal(r.headers["x-helper-commit"], COMMIT);
  assert.equal(r.headers["access-control-allow-origin"], APP);
  const b = JSON.parse(r.body);
  assert.deepEqual(Object.keys(b), ["trades", "src", "as_of_ms"]);
  assert.equal(b.trades.length, 20);
  for (const t of b.trades) {
    assert.deepEqual(Object.keys(t), ["t_ms", "side", "usd", "amt", "trader", "tx"]);
    assert.ok(t.side === "b" || t.side === "s");
    assert.match(t.usd, /^\d+(\.\d+)?$/);
    assert.match(t.amt, /^\d+(\.\d+)?$/);
    assert.match(t.tx, /^0x[0-9a-f]{64}$/);
    assert.match(t.trader, /^0x[0-9a-f]{40}$/);
  }
  const times = b.trades.map((t: { t_ms: number }) => t.t_ms);
  assert.deepEqual(times, [...times].sort((x: number, y: number) => y - x), "newest first");
  assert.ok(times[0] <= timeOf(REC.firstHead + 400) * 1000);
  const dflt = JSON.parse((await call("GET", `/v1/market/trades?chain=base&token=${ICNT}`)).body);
  assert.equal(dflt.trades.length, 50, "the default is the most the tape serves");
});

test("HEAD answers the headers alone, and a POST is refused 405", async () => {
  const h = await call("HEAD", `/v1/market/trades?chain=base&token=${ICNT}`);
  assert.equal(h.status, 200);
  assert.equal(h.body, "");
  assert.equal(h.headers["x-helper-source"], "chain");
  assert.equal((await call("POST", `/v1/market/trades?chain=base&token=${ICNT}`)).status, 405);
});

test("a read the helper does not serve is a 404: 1s on Base, another tf, a token off the lists, a bad address, a repeated or missing argument, a limit out of range", async () => {
  const q = (p: string) => `/v1/market/${p}`;
  for (const p of [
    `candles?chain=base&token=${ICNT}&tf=1s`,
    `candles?chain=base&token=${ICNT}&tf=2m`,
    `candles?chain=base&token=${ICNT}`,
    `candles?chain=base&token=${VVV}&tf=1m`,
    `candles?chain=base&token=0x12&tf=1m`,
    `candles?chain=base&token=${ICNT}&token=${ICNT}&tf=1m`,
    `candles?chain=base&chain=base&token=${ICNT}&tf=1m`,
    `candles?chain=base&token=${ICNT}&tf=1m&limit=0`,
    `candles?chain=base&token=${ICNT}&tf=1m&limit=501`,
    `candles?chain=base&token=${ICNT}&tf=1m&to=abc`,
    `candles?token=${ICNT}&tf=1m`,
    `candles?chain=robinhood&token=${ICNT}&tf=1m`,
    `candles?chain=ethereum&token=${ICNT}&tf=1m`,
    `candles?chain=constructor&token=${ICNT}&tf=1m`,
    `trades?chain=base&token=${ICNT}&limit=51`,
    `trades?chain=base&token=${ICNT}&limit=0`,
    `trades?chain=base&token=${ICNT}&limit=5&limit=6`,
    `trades?chain=base&token=${VVV}`,
    `trades?chain=base`,
    `trades?chain=solana&token=${ICNT}`,
    `trades?chain=robinhood&token=${ICNT}`,
  ]) {
    const r = await call("GET", q(p));
    assert.equal(r.status, 404, p);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found" } }, p);
  }
});

test("a server with no own reads: Base candles stay 404 and /v1/market/trades does not exist for any chain", async () => {
  const bare = start(COMMIT, 0);
  await new Promise<void>((ok) => bare.on("listening", ok));
  const p = (bare.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<number>((ok, fail) => request({ host: "127.0.0.1", port: p, path }, (res) => (res.resume(), ok(res.statusCode ?? 0))).on("error", fail).end());
  try {
    assert.equal(await get(`/v1/market/candles?chain=base&token=${ICNT}&tf=1m`), 404);
    assert.equal(await get(`/v1/market/trades?chain=base&token=${ICNT}`), 404);
  } finally {
    bare.closeAllConnections();
    bare.close();
  }
});

test("no provider can agree: 503 upstream, never an empty chart", async () => {
  const dead = fakeChain();
  dead.st.head = REC.firstHead + 400;
  for (const u of ["https://a.test", "https://b.test", "https://c.test"]) dead.st.faults.set(u, { down: true });
  const s = open(dead, { t: 1 }, { listed: async () => true });
  const srv = start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { base: s });
  await new Promise<void>((ok) => srv.on("listening", ok));
  const p = (srv.address() as AddressInfo).port;
  try {
    const r = await new Promise<{ status: number; body: string }>((ok, fail) =>
      request({ host: "127.0.0.1", port: p, path: `/v1/market/trades?chain=base&token=${ICNT}` }, (res) => {
        const c: Buffer[] = [];
        res.on("data", (d: Buffer) => c.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString("utf8") }));
      }).on("error", fail).end(),
    );
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "upstream" } });
  } finally {
    s.stop();
    srv.closeAllConnections();
    srv.close();
  }
});
