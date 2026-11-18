// node --test scripts/live-checks/base-buy-box-answers-a-fresh-account.test.mjs: cards base-buy-box-answers-a-fresh-account
// and evm-snapshots-fresh-at-every-cut. The live check replays its recorded answers
// (base-buy-box-answers-a-fresh-account.answers.json). good: the refreshed Base and Robinhood snapshots read from a folder
// holding them: PASS. bad: SIGN_HOST at release 171, both snapshots 45 hours behind: FAIL. bad_base_only: the first
// card's recorded run, Base alone (Base 809,329 behind, Robinhood unread): FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, HEAD_SPREAD_MAX, MAX_BEHIND, SYNC_MAX_MS, check } from "./base-buy-box-answers-a-fresh-account.mjs";

const A = JSON.parse(readFileSync(new URL("./base-buy-box-answers-a-fresh-account.answers.json", import.meta.url), "utf8"));
const bads = (r) => r.lines.filter((l) => l.startsWith("BAD")).map((l) => l.split(" (")[0]);

test("the recorded good answer passes on both chains", () => {
  assert.deepEqual(CHAINS, ["base", "robinhood"]);
  const r = check(A.good.run);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the recorded bad answer fails: both served snapshots 45 hours behind, Base's sync past its bound", () => {
  const r = check(A.bad.run);
  assert.equal(r.ok, false);
  assert.deepEqual(bads(r), ["BAD [base] snapshot 813910 blocks behind the head 58865458", "BAD [base] a fresh device's sync from it whole in 108755 ms, 70+68 posts, 315+307 getLogs, 3+1 limited", "BAD [robinhood] snapshot 1553624 blocks behind the head 117014540"]);
});

test("the first card's Base-only bad run still fails, and Robinhood unread fails", () => {
  const r = check(A.bad_base_only.run);
  assert.equal(r.ok, false);
  assert.ok(bads(r).includes("BAD [base] snapshot 809329 blocks behind the head 58860877"), r.lines.join("\n"));
  assert.ok(bads(r).includes("BAD [robinhood] snapshot HTTP not read, 0 bytes, 0 pools, through none"), r.lines.join("\n"));
});

test("per chain: past the head, one head, heads too far apart, a slow or partial sync, or no snapshot fails; the bound itself passes", () => {
  for (const chain of CHAINS) {
    const run = () => structuredClone(A.good.run);
    const c = (r) => r.chains[chain];
    const ahead = run();
    c(ahead).snapshot.through = Math.min(...c(ahead).heads) + 1;
    assert.equal(check(ahead).ok, false, `${chain}: past the head`);
    const oneHead = run();
    c(oneHead).heads = [c(oneHead).heads[0], null];
    assert.equal(check(oneHead).ok, false, `${chain}: one head`);
    const apart = run();
    c(apart).heads = [c(apart).heads[0], c(apart).heads[0] + HEAD_SPREAD_MAX[chain] + 1];
    assert.equal(check(apart).ok, false, `${chain}: heads too far apart`);
    const slow = run();
    c(slow).sync.ms = SYNC_MAX_MS + 1;
    assert.equal(check(slow).ok, false, `${chain}: slow sync`);
    const partial = run();
    c(partial).sync.served = false;
    assert.equal(check(partial).ok, false, `${chain}: partial sync`);
    const none = run();
    none.chains[chain] = { snapshot: { status: 404, bytes: 0 }, heads: c(none).heads, sync: null };
    assert.equal(check(none).ok, false, `${chain}: no snapshot`);
    const edge = run();
    c(edge).snapshot.through = Math.min(...c(edge).heads) - MAX_BEHIND[chain];
    assert.equal(check(edge).ok, true, `${chain}: exactly MAX_BEHIND passes`);
    c(edge).snapshot.through -= 1;
    assert.equal(check(edge).ok, false, `${chain}: one block past MAX_BEHIND fails`);
  }
});
