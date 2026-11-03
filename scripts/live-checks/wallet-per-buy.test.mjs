// node --test --test-isolation=none scripts/live-checks/wallet-per-buy.test.mjs: the live check replays recorded runs
// (wallet-per-buy.answers.json). good: a live run of the wallet's reader (2026-11-03 06:08Z, HOLDINGS_RPC_LIMIT): PASS.
// Each bad is that run with one change: one Solana round's slots split, one RPC's holdings changed, one answer a 429:
// each FAIL. Made here from the good run: a W missing, a pool failed, a W not the A.8 vector's, a Base W's reads at two
// blocks: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHILD, childArgs, judge } from "./wallet-per-buy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "wallet-per-buy.answers.json"), "utf8"));
const copy = (v) => JSON.parse(JSON.stringify(v));
const route = (run, chain, rpc) => run.routes.find((r) => r.chain === chain && r.rpc === rpc);
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good run passes, and prints each W's address, slot or block and holdings", () => {
  const r = judge(A.good);
  assert.deepEqual(bads(r), []);
  assert.equal(r.ok, true);
  assert.equal(r.lines.filter((l) => /^ {4}(sol|base) (helper|public) j=[0-3] \S+ (slot \d+\/\d+\/\d+|block 0x[0-9a-f]{64}): native \d+/.test(l)).length, 16);
  assert.ok(r.lines.includes("ok  HTTP 429s: 0 of 54 calls"));
});

test("the recorded bad runs fail: one round's slots split, one RPC's holdings changed, one 429", () => {
  for (const [k, want] of [["badSlotSplit", /\[sol helper\] W j=0 .*its last round at one slot/], ["badHoldings", /\[base\] W j=1: the same holdings on both RPCs/], ["bad429", /HTTP 429s: 1 of/]]) {
    const r = judge(A[k]);
    assert.equal(r.ok, false, k);
    assert.ok(bads(r).some((l) => want.test(l)), `${k}: ${bads(r).join(" | ")}`);
  }
});

test("made from the good run: a W missing, a pool failed, a W not the vector's, a Base W at two blocks: each fails", () => {
  const missing = copy(A.good);
  route(missing, "sol", "public").wallets.pop();
  const failed = copy(A.good);
  route(failed, "base", "helper").failed = [{ pool: "base-helper", error: "wallet 2: its reads drew the helper's 429 in 4 rounds" }];
  const other = copy(A.good);
  route(other, "sol", "helper").wallets[1].address = route(other, "sol", "helper").wallets[2].address;
  const blocks = copy(A.good);
  const w = route(blocks, "base", "public").wallets[0].address.toLowerCase();
  const call = blocks.calls.filter((c) => c.owner?.toLowerCase() === w && c.method === "eth_call" && c.route.includes("publicnode")).at(-1);
  call.at = `0x${"1".repeat(64)}`;
  for (const [name, run] of [["missing", missing], ["failed", failed], ["other", other], ["blocks", blocks]]) assert.equal(judge(run).ok, false, name);
});

test("the check runs the wallet's own reader, with the shared 2000 ms connect window imported first", () => {
  const a = childArgs("https://helper.example");
  assert.equal(a[0], "--import");
  assert.match(a[1], /\/scripts\/net-window\.mjs$/);
  assert.equal(a[2], CHILD);
  assert.match(CHILD, /\/packages\/wallet\/scripts\/buy-wallets-live\.ts$/);
  assert.deepEqual(a.slice(3), ["--helper", "https://helper.example"]);
  const src = readFileSync(CHILD, "utf8");
  assert.match(src, /from "\.\.\/src\/pool\/buy-wallets\.ts"/);
  assert.match(src, /solanaHelperHoldings\(HELPER\)/);
  assert.match(src, /evmHelperHoldings\(HELPER, "base"/);
});
