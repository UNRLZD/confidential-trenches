// node --test --test-isolation=none scripts/live-checks/wallet-per-buy.test.mjs: the live check replays recorded runs
// (wallet-per-buy.answers.json). good: a live run of the wallet's reader (2026-11-03 06:08Z, HOLDINGS_RPC_LIMIT): PASS.
// Each bad is that run with one change: one Solana round's slots split, one RPC's holdings changed, one answer a 429:
// each FAIL. Made here from the good run: a W missing, a pool failed, a W not the A.8 vector's, a Base W's reads at two
// blocks: each FAIL. Card solana-holdings-reads-inside-the-public-limit: goodPublicPace, a live run with the Solana
// public route at HOLDINGS_PUBLIC_RPC_LIMIT and the hosts' named limits: PASS; badLive429, the CO's recorded run of
// 2026-11-13 17:02Z (12 getTokenAccountsByOwner in 10 s on api.mainnet-beta, which names 10; 6 429s): FAIL; made from
// goodPublicPace, its public route's getTokenAccountsByOwner sent at the helper's pace with no 429: FAIL.
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

test("card solana-holdings-reads-inside-the-public-limit: the live run at the public pace passes, inside the 10 the host named; the recorded 17:02Z run fails on its 429s and its pace", () => {
  const g = judge(A.goodPublicPace);
  assert.deepEqual(bads(g), []);
  assert.ok(g.lines.includes("ok  https://api.mainnet-beta.solana.com/ getTokenAccountsByOwner: at most 8 in any 10 s, the host's limit 10"), g.lines.join("\n"));
  assert.ok(A.goodPublicPace.calls.some((c) => c.methodLimit === 10 && c.method === "getTokenAccountsByOwner"), "the host named its limit on the run's answers");
  const b = judge(A.badLive429);
  assert.equal(b.ok, false);
  assert.ok(bads(b).includes("BAD HTTP 429s: 6 of 69 calls"), bads(b).join(" | "));
  assert.ok(bads(b).includes("BAD https://api.mainnet-beta.solana.com/ getTokenAccountsByOwner: at most 12 in any 10 s, the host's limit 10"), bads(b).join(" | "));
});

test("card solana-holdings-reads-inside-the-public-limit: made from the live good run, the public route's getTokenAccountsByOwner at the helper's pace (12 in 10 s) fails with no 429 at all", () => {
  const fast = copy(A.goodPublicPace);
  const pub = fast.calls.filter((c) => c.route.includes("api.mainnet-beta"));
  const t0 = pub[0].ms;
  // each round 1,667 ms after the one before (its three calls share one start), in place of 2,500
  let round = -1;
  for (const c of pub) {
    if (c.method === "getBalance") round++;
    c.ms = t0 + Math.max(round, 0) * 1_667;
  }
  const r = judge(fast);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r), ["BAD https://api.mainnet-beta.solana.com/ getTokenAccountsByOwner: at most 12 in any 10 s, the host's limit 10"]);
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
  // the Solana public route is the device's own device-direct reader (card solana-holdings-reads-inside-the-public-limit)
  assert.match(src, /solanaHoldingsAt\(PUBLIC\.sol\)/);
});
