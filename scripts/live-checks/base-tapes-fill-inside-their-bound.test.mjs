// node --test scripts/live-checks/base-tapes-fill-inside-their-bound.test.mjs: the live check's verdict replays recorded runs
// (base-tapes-fill-inside-their-bound.answers.json):
//   good:    the deployed helper (f28b6bd56) read from the Mac at 21 Nov 21:29Z with no other check loading it,
//            the 12 listed Base coins opened at once: every tape whole inside 45 s, the last at 13.6 s: PASS;
//   bad_run: live run 44942886709 (21 Nov 20:14Z, helper at 61fa14a08), robinhood-tapes-read-ahead-bounded's Base lines
//            as this check records them: 6 tapes still filling past 45 s, one CoinGecko's rows: FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./base-tapes-fill-inside-their-bound.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "base-tapes-fill-inside-their-bound.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes: 12 listed Base coins opened at once on a helper with no other load, every tape whole inside 45 s", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(A.good.answers.length, 12);
  assert.ok(r.lines.some((l) => /^ {4}base: 12 of 12 tapes whole inside 45 s/.test(l)), r.lines.join("\n"));
});

test("the recorded bad answer of live run 44942886709 fails: 6 Base tapes still filling past 45 s, 1 CoinGecko's", () => {
  const r = judge(A.bad_run);
  assert.equal(r.ok, false);
  assert.equal(bad(r).filter((l) => /^BAD base trades 0x[0-9a-f]{40}: still filling 4[5-6]\d{3} ms after its first read \(\d+ reads\), past 45000 ms$/.test(l)).length, 6, bad(r).join("\n"));
  assert.equal(bad(r).filter((l) => / 200 src "coingecko" /.test(l)).length, 1, bad(r).join("\n"));
});

test("planted faults fail: the lists not read, a tape 503, a fill past 45 s, a tape that never filled, too few tokens, another source", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  assert.equal(edit((r) => (r.lists.status = 500)).ok, false);
  assert.equal(edit((r) => Object.assign(r.answers[0], { status: 503, shape: null, body: "busy" })).ok, false);
  assert.equal(edit((r) => Object.assign(r.answers[0], { filling: true, filled: { status: 200, filling: false, shape: "tape", ms: 45_001, reads: 22 } })).ok, false);
  assert.equal(edit((r) => Object.assign(r.answers[1], { filling: true, filled: { status: 200, filling: true, shape: "tape", ms: 45_200, reads: 21 } })).ok, false);
  assert.equal(edit((r) => Object.assign(r.answers[1], { filling: true, filled: undefined })).ok, false);
  assert.equal(edit((r) => (r.answers = r.answers.slice(0, 5)) && (r.lists.tokens = 5)).ok, false);
  assert.equal(edit((r) => (r.answers[0].shape = 'src "coingecko"')).ok, false);
});
