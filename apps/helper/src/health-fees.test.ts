// node --test apps/helper/src/health-fees.test.ts (card helper-start-residuals, item 2): GET /v1/health never answers
// ready true while a mainnet EVM pool holds no fee for the running period, and names each mainnet pool's fee for it in
// X-Helper-Pool-Fees ("<network> <fee in wei>", "<network> reading" while that period's read ahead is under way, or
// "<network> none"), so the operator's live check reads which pool. A header, as X-Helper-Near-Pair: the body has 11 B
// left under the kit's 1 KB at its longest config (server.test.ts). The clock is the test's own.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { handler } from "./server.ts";
import type { EvmPoolSender } from "./pool/evm.ts";

/** server.ts POOL_FEES_HEADER, as the live check reads it (scripts/live-checks/helper-start-residuals.mjs). */
const POOL_FEES_HEADER = "X-Helper-Pool-Fees";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_800_000_030_000; // 30 s into a period
const PERIOD = NOW - (NOW % 60_000);

function get(port: number, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail).end();
  });
}

test("card helper-start-residuals 2: ready true only while every mainnet EVM pool names a fee or a read under way for the running period; a pool with none sets ready false and the header names it", async (t) => {
  const state: Record<string, bigint | "reading" | null> = { base: 1_234_567_890n, robinhood: null, "base-sepolia": null };
  const asked: number[] = [];
  const pool = (network: string) => ({ network, feeNow: (e: number) => (asked.push(e), state[network]!) }) as unknown as EvmPoolSender;
  const evmPools = new Map([["0xb", pool("base")], ["0xr", pool("robinhood")], ["0xs", pool("base-sepolia")]]);
  let gate = true;
  const h = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), evmPools, () => NOW, {}, {}, () => gate));
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((ok) => h.listen(0, "127.0.0.1", () => ok()));
  const port = (h.address() as AddressInfo).port;
  const read = async () => {
    const r = await get(port, "/v1/health");
    assert.equal(r.status, 200);
    return { ready: (JSON.parse(r.body) as { ready: unknown }).ready, fees: r.headers[POOL_FEES_HEADER.toLowerCase()] };
  };
  // a mainnet pool whose read of the running period ended with none: ready false, the pool named
  state.robinhood = null;
  assert.deepEqual(await read(), { ready: false, fees: "base 1234567890, robinhood none" });
  assert.ok(asked.length > 0 && asked.every((e) => e === PERIOD), `asked for the running period: ${asked.join(",")}`);
  // both mainnet pools hold the running period's fee: ready, each named with its fee in wei; the test network's is not
  state.robinhood = 98_765n;
  assert.deepEqual(await read(), { ready: true, fees: "base 1234567890, robinhood 98765" });
  // a read under way: named, ready kept (a fee read ahead takes up to its window at each period's start)
  state.robinhood = "reading";
  assert.deepEqual(await read(), { ready: true, fees: "base 1234567890, robinhood reading" });
  state.robinhood = null;
  state.base = null;
  assert.deepEqual(await read(), { ready: false, fees: "base none, robinhood none" });
  // every fee held but the start's gate not passed: not ready, as before
  state.base = 1n;
  state.robinhood = 2n;
  gate = false;
  assert.deepEqual(await read(), { ready: false, fees: "base 1, robinhood 2" });
});

test("card helper-start-residuals 2: a helper with no EVM pool names none in the header and keeps its ready as the gate says", async (t) => {
  const h = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null, new Map(), new Map(), () => NOW, {}, {}, () => true));
  t.after(() => new Promise<void>((done) => (h.closeAllConnections(), h.close(() => done()))));
  await new Promise<void>((ok) => h.listen(0, "127.0.0.1", () => ok()));
  const r = await get((h.address() as AddressInfo).port, "/v1/health");
  assert.equal((JSON.parse(r.body) as { ready: unknown }).ready, true);
  assert.equal(r.headers[POOL_FEES_HEADER.toLowerCase()], "");
});
