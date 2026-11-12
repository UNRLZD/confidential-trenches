// node --test scripts/live-checks/signpage-restores-near-vault-notes.test.mjs: card
// signpage-restores-near-vault-notes's live check, replayed on its answers file (pool-restore-wired's own recorded runs,
// copied whole: see the file's first line). Good: the live page's run of 12 Nov 09:12Z (done, every request on a pinned
// host, both NEAR operators read) passes. Bad: the live page of 6 Nov, which refused restore and ran none, fails.
// Planted on the good run: the page's own line for a vault it could not read ("restore stalled: near vault: ..."), the
// run's progress ending stalled, and a NEAR operator the page's connect-src does not name each fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECK } from "./signpage-restores-near-vault-notes.mjs";
import { NEAR_OPS, judge } from "./pool-restore-wired.mjs";

const A = JSON.parse(readFileSync(new URL("./signpage-restores-near-vault-notes.answers.json", import.meta.url), "utf8"));
const WIRED = JSON.parse(readFileSync(new URL("./pool-restore-wired.answers.json", import.meta.url), "utf8"));
const mut = (f) => {
  const rec = structuredClone(A.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("the entry runs pool-restore-wired, whose run reads the vault's NEAR pair", () => {
  assert.equal(CHECK, "pool-restore-wired");
  assert.deepEqual([...NEAR_OPS], ["rpc.mainnet.fastnear.com", "near.drpc.org"]);
});

test("recorded good answer: the live page's run ends done with both NEAR operators read: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const op of NEAR_OPS) assert.ok(A.good.hosts[op] > 0, op);
});

test("recorded bad answer: the live page that refused restore and ran none: FAIL; both records are pool-restore-wired's own", () => {
  fails(judge(A.bad), /ran one restore with no tap/);
  assert.deepEqual(A.good, WIRED.live119);
  assert.deepEqual(A.bad, WIRED.bad);
});

test("planted bad answers: a vault the page could not read, a run that ends stalled, a NEAR operator out of the connect-src: FAIL", () => {
  fails(mut((rec) => (rec.console = ["warning: restore stalled: near vault: the providers differ at deposits 0"])), /the page logged no stalled restore \(warning: restore stalled: near vault/);
  fails(mut((rec) => (rec.steps.asked.stages = ["reading", "stalled"])), /never stalled/);
  fails(mut((rec) => (rec.connect = rec.connect.filter((h) => h !== "near.drpc.org"))), /not in its connect-src: near\.drpc\.org/);
});
