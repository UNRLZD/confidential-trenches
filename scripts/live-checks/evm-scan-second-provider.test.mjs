// Replays evm-scan-second-provider.answers.json through the live check. The good answer is a real run at 7c3cecb (this
// Mac, 2026-11-05 17:2xZ): Base's second bloXroute and Robinhood's second daybreak, each preflight allowing the app's
// origin, and every quote with the first scan provider held (refused, no logs) ending ok with the second asked for
// logs; it passes. The bad answer is a real run at 0273ca1 (16:57-17:03Z) with Globalstake as Robinhood's second:
// three of its four held quotes ended rpc_error at the 60 s bound; it fails on each of them.
//   node --test scripts/live-checks/evm-scan-second-provider.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-scan-second-provider.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-scan-second-provider.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (7c3cecb) passes: both seconds on other hosts, their preflights, every held quote ok on the second", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS robinhood pins a second scan provider on another host: rpc\.mainnet\.chain\.robinhood\.com, then robinhood\.daybreak-rpc\.network$/);
  has(r.lines, /^PASS base pins a second scan provider on another host: base-rpc\.publicnode\.com, then base\.rpc\.blxrbdn\.com$/);
  has(r.lines, /^PASS robinhood-torch, first refused: ends ok in \d+ ms/);
  has(r.lines, /^PASS robinhood-torch, first no logs: ends ok in \d+ ms/);
  has(r.lines, /^PASS base-hook, first refused: ends ok in \d+ ms/);
});

test("the bad answer (0273ca1, Globalstake) fails: Robinhood's held quotes end rpc_error at the bound", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL robinhood-torch, first refused: ends rpc_error: .* in 600\d\d ms/);
  has(r.lines, /^FAIL robinhood-torch, first no logs: ends rpc_error: .* in 600\d\d ms/);
});

test("each rule fails alone on the good answer with one thing changed", () => {
  const noSpare = structuredClone(A.good);
  noSpare.scans.base.spare = null;
  assert.equal(check(noSpare).ok, false, "no second on Base");
  const sameHost = structuredClone(A.good);
  sameHost.scans.robinhood.spare = sameHost.scans.robinhood.first;
  assert.equal(check(sameHost).ok, false, "a second on the first's host");
  const cors = structuredClone(A.good);
  cors.preflight[cors.scans.base.spare].allow = null;
  assert.equal(check(cors).ok, false, "a preflight with no allow-origin");
  const unasked = structuredClone(A.good);
  unasked.cases["base-hook"].held[0].spareLogs = 0;
  assert.equal(check(unasked).ok, false, "a held quote the second did not carry");
  const late = structuredClone(A.good);
  late.cases["robinhood-torch"].held[3].ms = 60_000;
  assert.equal(check(late).ok, false, "a held quote at the bound");
  const short = structuredClone(A.good);
  short.cases["robinhood-torch"].held = short.cases["robinhood-torch"].held.filter((q) => q.mode !== "no logs" || q !== short.cases["robinhood-torch"].held.at(-1));
  assert.equal(check(short).ok, false, "one held quote short");
  const cold = structuredClone(A.good);
  cold.cases["base-hook"].first = [{ code: "rpc_error", ms: 60_000 }];
  assert.equal(check(cold).ok, false, "no warm-up quote ended ok");
});
