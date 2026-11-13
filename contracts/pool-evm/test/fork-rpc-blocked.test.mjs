// SPDX-License-Identifier: Apache-2.0
// The fork RPC's upstream list on the pools book (fork-rpc.mjs answer): an upstream that answers 403 has refused this
// machine, so it is asked nothing more this run while another upstream is left. No network: the upstreams are this
// file's fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
process.env.FORK_RPC_UPSTREAM_MS = "50";
// the pools book, as a copy run starts it (`--book pools --`), read once at the import
process.argv.push("--book", "pools", "--");
const { answer } = await import("./fork-rpc.mjs");

const logs = (from, id) => ({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${(from + 9).toString(16)}` }] });

test("an upstream that answers 403 is asked nothing more this run, while another is left", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const later = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...a) => later(fn, ms >= 500 ? 0 : ms, ...a));
  const asked = [];
  globalThis.fetch = async (url) => {
    const host = new URL(url).host;
    asked.push(host);
    if (host === "robinhood-rpc.publicnode.com") return new Response("forbidden", { status: 403 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
  };
  for (let i = 0; i < 6; i++) assert.deepEqual((await answer({ robinhood: {} }, "robinhood", logs(1_000 + 100 * i, i), true)).result, []);
  // the log reads go to the chain's own RPC and publicnode in turn (drpc serves no wide range): publicnode once, never again
  assert.equal(asked.filter((h) => h === "robinhood-rpc.publicnode.com").length, 1, asked.join(","));
  assert.equal(asked.filter((h) => h === "rpc.mainnet.chain.robinhood.com").length, 6, asked.join(","));
});

test("when every upstream left has answered 403, they are still asked: the read is named as failed, never sent nowhere", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const later = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...a) => later(fn, ms >= 500 ? 0 : ms, ...a));
  let calls = 0;
  globalThis.fetch = async () => (calls++, new Response("forbidden", { status: 403 }));
  await assert.rejects(answer({ base: {} }, "base", logs(5_000, 1), true), /did not answer eth_getLogs .* in 5 tries/);
  assert.equal(calls, 5);
});
