// The operator map and its scan: two NEAR RPCs of one operator are one read. Planted cases first, then the real tree.
//   node --test scripts/ci/near-rpc-operators.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEAR_RPC_OPERATORS, isNearRpc, lineProblems, networkOf, operatorOf, scanTree } from "./near-rpc-operators.mjs";
import { RPCS } from "./money-gate.mjs";
import { WATCH_RPCS } from "../../apps/helper/src/token-status/status.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("near.org's hosts are FastNEAR's; dRPC's are dRPC's; scheme, case and a trailing slash do not matter", () => {
  for (const u of ["https://rpc.mainnet.near.org", "https://archival-rpc.mainnet.near.org", "http://rpc.mainnet.near.org/", "https://RPC.testnet.near.org", "https://archival-rpc.testnet.near.org"])
    assert.equal(operatorOf(u), "fastnear", u);
  assert.equal(operatorOf("https://near.drpc.org/"), "drpc");
  assert.equal(operatorOf("https://near-testnet.drpc.org"), "drpc");
  assert.equal(operatorOf("https://rpc.ankr.com/near"), null);
  assert.equal(operatorOf("not a url"), null);
  for (const [host, { operator, network }] of Object.entries(NEAR_RPC_OPERATORS)) {
    assert.ok(["fastnear", "drpc"].includes(operator), host);
    assert.ok(["mainnet", "testnet"].includes(network), host);
  }
});

test("a NEAR RPC is a URL whose host and path say near and rpc, or one the map holds; nothing else is read", () => {
  for (const u of ["https://near.drpc.org", "https://1rpc.io/near", "https://rpc.ankr.com/near", "https://free.rpc.fastnear.com"]) assert.ok(isNearRpc(u), u);
  for (const u of ["https://near.org/packages", "https://nearblocks.io/txns/abc", "https://base.drpc.org", "https://mainnet.base.org", "nope"]) assert.ok(!isNearRpc(u), u);
});

test("planted: the README's loop over FastNEAR and near.org is one operator: refused", () => {
  const p = lineProblems("x\nfor RPC in https://rpc.mainnet.fastnear.com https://rpc.mainnet.near.org; do\n", "README.md");
  assert.deepEqual(p, ["README.md:2: https://rpc.mainnet.fastnear.com, https://rpc.mainnet.near.org are one operator (fastnear): two reads there are one read"]);
});

test("planted: a two-URL list of FastNEAR's and near.org's archival hosts is refused, on either network", () => {
  assert.equal(lineProblems('const RPCS = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];', "a.mjs").length, 1);
  assert.equal(lineProblems("near: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],", "a.mjs").length, 1);
  assert.equal(lineProblems("[`https://near.drpc.org`, `https://near.drpc.org/`]", "a.mjs").length, 0, "one URL twice is one URL, not a list");
});

test("FastNEAR with dRPC is two operators: passes", () => {
  assert.deepEqual(lineProblems('["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]', "a.mjs"), []);
  assert.deepEqual(lineProblems("for RPC in https://rpc.mainnet.fastnear.com https://near.drpc.org; do", "README.md"), []);
  assert.deepEqual(lineProblems('["https://archival-rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org"]', "a.mjs"), []);
});

test("a list keyed by its own operator's name is that operator's alternatives, not a pair: passes; keyed otherwise, refused", () => {
  assert.deepEqual(lineProblems('    fastnear: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],', "a.ts"), []);
  assert.deepEqual(lineProblems('  "fastnear": ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],', "a.json"), []);
  assert.equal(lineProblems('    pair: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],', "a.ts").length, 1);
  assert.equal(lineProblems('    drpc: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],', "a.ts").length, 1);
});

test("planted: a NEAR RPC the map does not hold is refused, alone or in a list", () => {
  assert.deepEqual(lineProblems('const A = "https://rpc.ankr.com/near";', "a.mjs"), ["a.mjs:1: https://rpc.ankr.com/near is a NEAR RPC the operator map does not hold (scripts/ci/near-rpc-operators.mjs)"]);
  assert.equal(lineProblems('["https://rpc.mainnet.fastnear.com", "https://1rpc.io/near"]', "a.mjs").length, 1);
});

test("the money gate's NEAR lists each name two operators of their own network, all in the map", () => {
  for (const [chain, network] of [["near", "mainnet"], ["near-testnet", "testnet"]]) {
    const ops = RPCS[chain].map(operatorOf);
    assert.ok(!ops.includes(null), `${chain}: ${RPCS[chain]}`);
    assert.equal(new Set(ops).size, 2, `${chain}: ${RPCS[chain]}`);
    for (const u of RPCS[chain]) assert.equal(networkOf(u), network, u);
  }
});

test("the helper's two token-status defaults are two operators, mainnet both", () => {
  const urls = WATCH_RPCS.map((r) => r.fallback);
  assert.equal(new Set(urls.map(operatorOf)).size, 2, urls.join(", "));
  for (const u of urls) assert.equal(networkOf(u), "mainnet", u);
});

test("the real tree: every NEAR RPC URL is in the map and no line pairs one operator", () => {
  assert.deepEqual(scanTree(ROOT), []);
});
