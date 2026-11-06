// Replays evm-rpc-spare-list.answers.json through the live check. The good answer is a real run (this Mac, 2026-11-06,
// this card's kit, base-rpc-list-fix, recorded at 4008d804 with the same kit diff; the deployed helper at 2e7ec335): Base's scan list of four and Robinhood's of
// three, on hosts of their own, each spare past the second allowing the app's origin in its preflight and its POST,
// each held Base quote 11.5 s after the one before (past Base's maxLag), every quote with the first two scan providers held (no connection, HTTP 503) ending ok with
// the third asked for logs, every helper caller read with its first two held answered 200 past them, and the address-less
// Transfer read answered with a list on the checkout's reader and on a helper started from the branch (--base, this
// Mac); it passes. The bad answer is a real run at 66d7b60 (main before this card, 2026-11-05 20:09-20:11Z), the same
// holds: each scan list stops at two, so every held quote ends rpc_error and no third is asked, and the address-less
// Base read answers PublicNode's -32701 on the checkout and on the deployed helper (9041265); it fails on each of them.
// The 6 Nov half (the history refusals and the maker list): `good` is re-recorded on this card's branch (8940e38, a
// keyless helper started from it on this Mac as --base), every helper read with its first two held -32002 answered past
// them, the deployed-helper read 50,000 blocks back a list on each chain, and the maker lists of seven and five, each
// spare past the second answering its chain id and that read; it passes. `badHistory` is a real run at 0d130f2f (main
// before this half) against the deployed helper: the -32002 held on the first two is the caller's answer on both chains
// and each maker list is three; it fails on each.
//   node --test scripts/live-checks/evm-rpc-spare-list.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check } from "./evm-rpc-spare-list.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-rpc-spare-list.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the good answer (card base-rpc-list-fix) passes: Base's four scan providers and Robinhood's three, every held quote ok on the third, every helper read past the first two", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  has(r.lines, /^PASS base scan list of 4, each on its own host: base-rpc\.publicnode\.com, base\.gateway\.tenderly\.co, base\.api\.pocket\.network, rpc\.sentio\.xyz \(4 at least\)$/);
  has(r.lines, /^PASS base fourth scan provider preflight from https:\/\/ct-app\.unrealized\.trade: 200, allow-origin https:\/\/ct-app\.unrealized\.trade/);
  has(r.lines, /^PASS robinhood scan list of 3, each on its own host: rpc\.mainnet\.chain\.robinhood\.com, robinhood\.daybreak-rpc\.network, robinhood\.api\.pocket\.network \(3 at least\)$/);
  for (const n of ["base-hook", "robinhood-torch"]) for (const m of ["refused", "503"]) has(r.lines, new RegExp(`^PASS ${n}, first two ${m}: ends ok in \\d+ ms`));
  for (const c of ["base", "robinhood"]) for (const m of ["refused", "503", "limit", "history"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two ${m}: HTTP 200`));
  for (const c of ["base", "robinhood"]) for (const w of ["helper", "deployed helper"]) has(r.lines, new RegExp(`^PASS ${w} ${c}, an address-less Transfer read of 1,000 blocks: HTTP 200, \\d+ logs`));
  for (const c of ["base", "robinhood"]) {
    has(r.lines, new RegExp(`^PASS deployed helper ${c}, the PoolManager's logs of 100 blocks 50000 back: HTTP 200, \\d+ logs`));
    has(r.lines, new RegExp(`^PASS helper ${c} maker list of [5-9], each on its own host`));
  }
});

test("the bad answer at 0d130f2f (main before the card's 6 Nov half) fails: a history refusal on the first two is the caller's answer, and each maker list stops at three", () => {
  const r = check(A.badHistory);
  assert.equal(r.ok, false);
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^FAIL helper ${c}, first two history: HTTP 200, no logs`));
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^FAIL helper ${c} maker list of 3`));
  // the rest of the card's first half still holds there
  for (const c of ["base", "robinhood"]) for (const m of ["refused", "503", "limit"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two ${m}: HTTP 200`));
});

test("a run whose deployed helper answers a history read with -32002, or a maker spare of another chain, fails", () => {
  const run = structuredClone(A.good);
  run.history.robinhood = { status: 200, results: null, error: "-32002 keyless requests are served for the most recent 5000 blocks only" };
  has(check(run).lines, /^FAIL deployed helper robinhood, the PoolManager's logs of 100 blocks 50000 back: HTTP 200, error -32002/);
  const other = structuredClone(A.good);
  const u = other.makers.base.list[2];
  other.makers.base.spares[u] = { ...other.makers.base.spares[u], chainId: 1 };
  assert.equal(check(other).ok, false);
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

test("card base-rpc-list-fix: Base's list of three, or a fourth whose POST names no origin, fails", () => {
  const three = structuredClone(A.good);
  three.scans.base = three.scans.base.slice(0, 3);
  const r = check(three);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL base scan list of 3, each on its own host: .* \(4 at least\)$/);
  const blind = structuredClone(A.good);
  blind.preflight[blind.scans.base[3]] = { ...blind.preflight[blind.scans.base[3]], post: null };
  assert.equal(check(blind).ok, false);
});
