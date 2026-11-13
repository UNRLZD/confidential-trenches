// node --test packages/signpage/scripts/load-count-browser.test.mjs: the per-route count of one signed-in load
// (load-count-browser.mjs) against the helper's window for one device. The windows are the helper's own numbers, read
// from its source here, so a change to them changes the check. A planted load that draws 43 calls of /v1/rpc/solana in
// 10 s FAILs on that window, one that draws 42 passes it, and a load with a "restore: <chain> walked" line is named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { busiest10, HELPER_WINDOW, helperWindowsOf, summarize } from "./load-count-browser.mjs";

const src = (p) => readFileSync(new URL(`../../../apps/helper/src/${p}`, import.meta.url), "utf8");
const num = (text, name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(text)?.[1]);

test("the windows are the helper's own: UPSTREAM_ROUTE_MAX, POOL_RATE_MAX, API_RATE_MAX and RPC_PAGE_NEED by chain", () => {
  const server = src("server.ts");
  assert.equal(HELPER_WINDOW["/v1/rpc"], num(server, "UPSTREAM_ROUTE_MAX"));
  assert.equal(HELPER_WINDOW["/v1/proxy"], num(server, "UPSTREAM_ROUTE_MAX"));
  assert.equal(HELPER_WINDOW["/v1/pool"], num(server, "POOL_RATE_MAX"));
  assert.equal(HELPER_WINDOW.other, num(server, "API_RATE_MAX"));
  const need = /export const RPC_PAGE_NEED[^=]*= \{([^}]*)\}/.exec(src("rpc/rpc.ts"))?.[1] ?? "";
  for (const chain of ["solana", "solana-marks", "base", "robinhood", "near"]) {
    const n = Number(new RegExp(`(?:^|[ ,])"?${chain}"?: (\\d+)`).exec(need)?.[1]);
    assert.equal(HELPER_WINDOW[`/v1/rpc/${chain}`], n, chain);
  }
});

test("busiest10 counts the most calls inside any 10 s", () => {
  assert.equal(busiest10([]), 0);
  assert.equal(busiest10([0, 9.99, 10, 20]), 2);
  assert.equal(busiest10([5, 1, 2, 3]), 4);
  assert.deepEqual(helperWindowsOf("/v1/rpc/solana"), ["/v1/rpc", "/v1/rpc/solana"]);
  assert.deepEqual(helperWindowsOf("/v1/market/lists"), ["other"]);
});

const load = (n, path = "/v1/rpc/solana", lines = []) => ({ requests: Array.from({ length: n }, (_, k) => ({ s: k * 0.2, host: "ct-api.unrealized.trade", path })), lines, prover: null });

test("a plain load at the share passes; one call past it in 10 s FAILs; a re-walk is named", () => {
  assert.deepEqual(summarize(load(42)).over, []);
  assert.deepEqual(summarize(load(43)).over, ["/v1/rpc/solana"]);
  assert.deepEqual(summarize(load(31, "/v1/rpc/base")).over, ["/v1/rpc/base"]);
  const walked = summarize(load(1, "/v1/rpc/solana", [{ s: 3.7, text: "restore: solana walked" }]));
  assert.deepEqual(walked.walked, ["restore: solana walked @3.7s"]);
});
