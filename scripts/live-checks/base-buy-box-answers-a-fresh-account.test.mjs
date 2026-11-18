// node --test scripts/live-checks/base-buy-box-answers-a-fresh-account.test.mjs: card base-buy-box-answers-a-fresh-account.
// The live check replays its recorded answers (base-buy-box-answers-a-fresh-account.answers.json). good: this branch's
// refreshed Base snapshot read from a folder holding it: PASS. bad: SIGN_HOST at release 171, whose Base snapshot was
// 809,329 blocks behind the head: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_BEHIND, SYNC_MAX_MS, check } from "./base-buy-box-answers-a-fresh-account.mjs";

const A = JSON.parse(readFileSync(new URL("./base-buy-box-answers-a-fresh-account.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes", () => {
  const r = check(A.good.run);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer fails: the served Base snapshot is 809,329 blocks behind the head", () => {
  const r = check(A.bad.run);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r).map((l) => l.split(" (")[0]), ["BAD [base] snapshot 809329 blocks behind the head 58860877"]);
});

test("a snapshot past the head, a head on one provider only, a slow or partial sync, or no snapshot fails", () => {
  const run = () => structuredClone(A.good.run);
  const ahead = run();
  ahead.snapshot.through = Math.min(...ahead.heads) + 1;
  assert.equal(check(ahead).ok, false, "past the head");
  const oneHead = run();
  oneHead.heads = [oneHead.heads[0], null];
  assert.equal(check(oneHead).ok, false, "one head");
  const slow = run();
  slow.sync.ms = SYNC_MAX_MS + 1;
  assert.equal(check(slow).ok, false, "slow sync");
  const partial = run();
  partial.sync.served = false;
  assert.equal(check(partial).ok, false, "partial sync");
  const none = run();
  none.snapshot = { status: 404, bytes: 0 };
  none.sync = null;
  assert.equal(check(none).ok, false, "no snapshot");
  const edge = run();
  edge.snapshot.through = Math.min(...edge.heads) - MAX_BEHIND;
  assert.equal(check(edge).ok, true, "exactly MAX_BEHIND passes");
  edge.snapshot.through -= 1;
  assert.equal(check(edge).ok, false, "one block past MAX_BEHIND fails");
});
