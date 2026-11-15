// node --test packages/signpage/scripts/firefox-rpc-blocked.test.mjs: the check's verdict at its bound (BOUND_S), on the
// runs card firefox-restore-fast recorded on the heavy box (Firefox 155.0, Strict tracking protection, Workers, taskset to
// 4 cores, `--bound 45 --hosts mainnet.base.org`), the numbers as the check printed them:
//   - before, at origin/main 245496a84 (each pool's walk on BigInt): nothing failed, balance 39.32 s, restore done 67.92 s;
//     mainnet.base.org failed, balance 37.88 s, restore done 67.52 s: FAIL at 45 s;
//   - after (the walk's field in WebAssembly): nothing failed, balance 14.32 s, restore done 23.31 s; mainnet.base.org
//     failed, balance 12.01 s, restore done 20.25 s: PASS at 45 s.
// The merge queue's own run 43663711503 (BigInt, GitHub's runner): balance 49.9-50.8 s, restore 90.4-93.0 s: FAIL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUND_S, verdict } from "./firefox-rpc-blocked.mjs";

const run = (shown, done) => ({ shownMs: shown * 1000, doneMs: done * 1000, unanswered: [], after: { ended: true, how: "reason down", ms: 900 } });

test("the bound is 45 s", () => assert.equal(BOUND_S, 45));

test("the runs after card firefox-restore-fast pass at the bound", () => {
  for (const [s, d] of [[14.32, 23.31], [12.01, 20.25]]) assert.deepEqual(verdict(run(s, d), BOUND_S), { ok: true, why: [] });
});

test("the BigInt walk's runs fail at the bound: the box's and the merge queue's", () => {
  for (const [s, d] of [[39.32, 67.92], [37.88, 67.52], [50.83, 92.03], [49.9, 90.43]]) {
    const v = verdict(run(s, d), BOUND_S);
    assert.equal(v.ok, false);
    assert.ok(v.why.some((w) => /^the restore ended at .* past 45 s$/.test(w)), v.why.join("; "));
  }
  // and the balance alone past it fails too
  assert.equal(verdict(run(50.8, 30), BOUND_S).ok, false);
});
