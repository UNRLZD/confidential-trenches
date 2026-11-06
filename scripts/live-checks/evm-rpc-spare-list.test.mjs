// Replays evm-rpc-spare-list.answers.json through the live check. The good answer is a real run (this Mac, 2026-11-05,
// the kit at card/evm-rpc-spare-list): each chain's scan list of three on hosts of their own, the third's preflight
// allowing the app's origin, every quote with the first two scan providers held (no connection, HTTP 503) ending ok with
// the third asked for logs, every helper caller read with its first two held answered 200 past them, and the address-less
// Transfer read answered with a list on the checkout's reader and on a helper started from the branch (--base, this
// Mac); it passes. The bad answer is a real run at 66d7b60 (main before this card, 2026-11-05 20:09-20:11Z), the same
// holds: each scan list stops at two, so every held quote ends rpc_error and no third is asked, and the address-less
// Base read answers PublicNode's -32701 on the checkout and on the deployed helper (9041265); it fails on each of them.
//   node --test scripts/live-checks/evm-rpc-spare-list.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-rpc-spare-list.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-rpc-spare-list.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (card/evm-rpc-spare-list) passes: three scan providers a chain, every held quote ok on the third, every helper read past the first two", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS base scan list of 3, each on its own host: base-rpc\.publicnode\.com, base\.gateway\.tenderly\.co, base\.api\.pocket\.network$/);
  has(r.lines, /^PASS robinhood scan list of 3, each on its own host: rpc\.mainnet\.chain\.robinhood\.com, robinhood\.daybreak-rpc\.network, robinhood\.api\.pocket\.network$/);
  for (const n of ["base-hook", "robinhood-torch"]) for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^PASS ${n}, first two ${m}: ends ok in \\d+ ms`));
  for (const c of ["base", "robinhood"]) for (const m of ["refused", "503", "limit"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two ${m}: HTTP 200`));
  for (const c of ["base", "robinhood"]) for (const w of ["helper", "deployed helper"]) has(r.lines, new RegExp(`^PASS ${w} ${c}, an address-less Transfer read of 1,000 blocks: HTTP 200, \\d+ logs`));
});

test("the bad answer (66d7b60) fails: each scan list stops at two, and every held quote ends rpc_error with no third asked", () => {
  const r = check(A.bad);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base scan list of 2/);
  has(r.lines, /^FAIL robinhood scan list of 2/);
  for (const n of ["base-hook", "robinhood-torch"]) for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^FAIL ${n}, first two ${m}: ends rpc_error`));
  has(r.lines, /^FAIL helper base, an address-less Transfer read of 1,000 blocks: HTTP 200, error -32701 Please specify an address/);
  has(r.lines, /^FAIL deployed helper base, an address-less Transfer read of 1,000 blocks: HTTP 200, error -32701 Please specify an address/);
});

test("a run with a helper read answered by one of the first two fails", () => {
  const run = structuredClone(A.good);
  run.helper.base.held[0].answeredBy = run.helper.base.list[1];
  const r = check(run);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL helper base, first two refused: HTTP 200/);
});
