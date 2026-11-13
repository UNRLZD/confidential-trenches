// node --test scripts/live-checks/app-faults-seen-on-124.test.mjs: the live check's verdict replays recorded runs
// (app-faults-seen-on-124.answers.json), each read by app-faults-seen-on-124.mjs collect() in headless Chromium at
// 1440 x 900, ten page loads in one tab inside a minute:
//   good: this card's build at APP_HOST's name (--harness) in the stand-in shell, fault 9 built: deposit.assets never
//         asked, no request to a 1Click path, every load READY: PASS;
//   beforeFault9: the good answer of item h (its build: the shell's warm read asked deposit.assets once, by the first
//         load, at most once a minute per tab): FAIL, as a page load still asked it;
//   bad:  the deployed release 124, signed out: deposit.assets asked on every load, and the third load's token list read
//         answered 429 on /v1/proxy/oneclick/v0/tokens, where the run stopped: FAIL.
// Planted from the good run: a load that asks, a request or a 429 on a 1Click path, a load not READY, loads over a
// minute, a load missing, no screenshot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, LOADS, ROUTES } from "./app-faults-seen-on-124.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-faults-seen-on-124.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(bad(r).some((l) => re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: ten loads inside a minute never ask deposit.assets and send nothing to 1Click: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(ANSWERS.good.loads.length, LOADS);
  assert.deepEqual(ANSWERS.good.loads.map((l) => l.assets), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(ANSWERS.good.loads.map((l) => l.oneclickSent), Array.from({ length: LOADS }, () => []));
  assert.deepEqual([...new Set(ANSWERS.good.loads.map((l) => l.route))].sort(), [...ROUTES].sort(), "every route, /terms, /discover and a token page among them");
});

test("recorded bad answer: item h's build asked deposit.assets on the first load (once a minute per tab): FAIL", () => {
  const r = judge(ANSWERS.beforeFault9);
  assert.equal(r.ok, false);
  assert.deepEqual(ANSWERS.beforeFault9.loads.map((l) => l.assets), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(bad(r).some((l) => /^BAD deposit\.assets asked 1 time\(s\) over the loads \(1, 0, 0/.test(l)), r.lines.join("\n"));
});

test("recorded bad answer: release 124 asks on every load and its third load meets 429 on the token list: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /^BAD 429 on the helper's 1Click paths: load \d+ \/v1\/proxy\/oneclick\/v0\/tokens/.test(l)), r.lines.join("\n"));
  assert.ok(bad(r).some((l) => /^BAD deposit\.assets asked [2-9] time\(s\)/.test(l)), r.lines.join("\n"));
});

test("planted: a load that asks, a request or a 429 on a 1Click path fails", () => {
  fails(mut((rec) => (rec.loads[1].assets = 1)), /^BAD deposit\.assets asked 1 time\(s\) over the loads \(0, 1, 0/);
  fails(mut((rec) => rec.loads[4].oneclick.push({ path: "/v1/proxy/oneclick/v0/quote", status: 429 })), /^BAD 429 on the helper's 1Click paths: load 5 \/v1\/proxy\/oneclick\/v0\/quote/);
  fails(mut((rec) => rec.loads[3].oneclickSent.push("/v1/proxy/oneclick/v0/tokens")), /^BAD requests to the helper's 1Click paths: load 4 \/v1\/proxy\/oneclick\/v0\/tokens/);
  fails(mut((rec) => delete rec.loads[2].oneclickSent), /^BAD requests to the helper's 1Click paths: load 3 not recorded/);
});

test("planted: a load not READY, loads over a minute, a load missing, no screenshot fail", () => {
  fails(mut((rec) => (rec.loads[2].ready = false)), /^BAD load\(s\) 3 never read READY/);
  fails(mut((rec) => (rec.loads.at(-1).atMs = rec.loads[0].atMs + 61_000)), /^BAD the loads span 61 s/);
  fails(mut((rec) => rec.loads.pop()), /^BAD 9 load\(s\) of 10/);
  fails(mut((rec) => (rec.shot = null)), /^BAD screenshot none/);
});
