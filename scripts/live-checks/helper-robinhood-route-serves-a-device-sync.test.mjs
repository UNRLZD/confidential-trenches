// node --test scripts/live-checks/helper-robinhood-route-serves-a-device-sync.test.mjs: the live check judges recorded
// runs (helper-robinhood-route-serves-a-device-sync.answers.json). good: PASS. bad_live: the deployed helper at
// 19a264d25, the page's other reads at 27 of the share of 30 beside a 6-day sync, one post 429: FAIL. bad_alone: every
// post 200 but the share never held at its edge: FAIL. Planted from the good one: a post the kit gave up on, a 429 on the
// page's reads, a sync that ended short, no RateLimit-Policy: FAIL; no snapshot: INCONCLUSIVE, never PASS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, shareOf } from "./helper-robinhood-route-serves-a-device-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-robinhood-route-serves-a-device-sync.answers.json"), "utf8"));
const copy = (v) => JSON.parse(JSON.stringify(v));

test("the recorded good run passes", () => {
  const j = judge(A.good);
  assert.equal(j.verdict, "PASS", j.lines.join("\n"));
});

test("the deployed helper's run with one post 429 fails", () => {
  const j = judge(A.bad_live);
  assert.equal(j.verdict, "FAIL");
  assert.ok(j.lines.some((l) => l.startsWith("BAD the sync's") && l.includes("429")), j.lines.join("\n"));
});

test("a run that never held the share at its edge fails, whatever its answers", () => {
  const j = judge(A.bad_alone);
  assert.equal(j.verdict, "FAIL");
  assert.ok(j.lines.some((l) => l.startsWith("BAD the page's other reads held the share")), j.lines.join("\n"));
});

test("planted from the good run: each fault fails", () => {
  const gaveUp = copy(A.good);
  gaveUp.posts[3].status = "no answer (TimeoutError)";
  assert.equal(judge(gaveUp).verdict, "FAIL", "a post the kit gave up on");
  const passRefused = copy(A.good);
  passRefused.passes[5] = 429;
  assert.equal(judge(passRefused).verdict, "FAIL", "a 429 on the page's reads");
  const short = copy(A.good);
  short.sync.coversThrough = short.snapshot.through - 1;
  assert.equal(judge(short).verdict, "FAIL", "a sync that ended short of the snapshot");
  const limited = copy(A.good);
  limited.sync.limited = [0, 1];
  assert.equal(judge(limited).verdict, "FAIL", "a limited batch the posts did not show");
  const noPolicy = copy(A.good);
  noPolicy.policy = null;
  assert.equal(judge(noPolicy).verdict, "FAIL", "no RateLimit-Policy");
});

test("no snapshot is INCONCLUSIVE, never PASS", () => {
  assert.equal(judge({ policy: A.good.policy, passes: [200], snapshot: { status: 503 }, sync: null, posts: [] }).verdict, "INCONCLUSIVE");
});

test("the share is read off the route's RateLimit-Policy", () => {
  assert.equal(shareOf('"chain";q=139;w=10, "client";q=30;w=10'), 30);
  assert.equal(shareOf(null), null);
});
