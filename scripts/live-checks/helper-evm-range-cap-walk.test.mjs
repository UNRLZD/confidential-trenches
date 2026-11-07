// Replays card helper-evm-range-cap-walk's live check, evm-rpc-spare-list (helper-evm-range-cap-walk.mjs runs it), on its
// recorded answers (evm-rpc-spare-list.answers.json). Good: `good`, a real run on this card's branch (this Mac,
// 2026-11-07 00:48Z, the branch merged with main 63c90229 at 988aa0e7, a keyless helper started from it as --base): the helper's caller read with its first two answering
// nodies' 50-block cap answered 200 past them on both chains, and the address-less Transfer read a list. Bad:
// `badRangeCap`, a real run of this check at main 1e3e9a05 (the deployed helper at 1e3e9a0, 2026-11-06 16:1xZ): the
// planted cap held on the first two is the caller's answer on both chains; and live run 42241935061's line (15:19Z,
// HELPER_HOST at f1d5298f), the deployed helper's address-less read answered nodies' cap, set on the good run.
//   node --test scripts/live-checks/helper-evm-range-cap-walk.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECKS } from "./helper-evm-range-cap-walk.mjs";
import { check } from "./evm-rpc-spare-list.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-rpc-spare-list.answers.json", import.meta.url), "utf8"));
const has = (lines, re) => assert.ok(lines.some((l) => re.test(l)), `a line matches ${re}:\n${lines.join("\n")}`);

test("the entry runs evm-rpc-spare-list", () => {
  assert.deepEqual(CHECKS, ["evm-rpc-spare-list"]);
});

test("the good answer (this card's branch) passes: with the first two capping at 50 blocks, each chain's read is answered past them", () => {
  const r = check(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^PASS helper ${c}, first two cap: HTTP 200, \\d+ logs, answered by `));
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^PASS deployed helper ${c}, an address-less Transfer read of 1,000 blocks: HTTP 200, \\d+ logs`));
});

test("the bad answer at main 1e3e9a05 fails: the cap held on the first two is the caller's answer on both chains", () => {
  const r = check(A.badRangeCap);
  assert.equal(r.ok, false);
  for (const c of ["base", "robinhood"]) has(r.lines, new RegExp(`^FAIL helper ${c}, first two cap: HTTP 200, no logs`));
});

test("live run 42241935061's answer fails: the deployed helper's address-less read answered base-pokt.nodies.app's 50-block cap", () => {
  const run = structuredClone(A.good);
  run.addressless.base.deployed = { status: 200, results: null, error: "-32001 Block range too large: maximum allowed is 50 blocks on your current plan", commit: "f1d5298f" };
  const r = check(run);
  assert.equal(r.ok, false);
  has(r.lines, /^FAIL deployed helper base, an address-less Transfer read of 1,000 blocks: HTTP 200, error -32001 Block range too large: maximum allowed is 50 blocks on your current plan \(a list wanted\)$/);
});
