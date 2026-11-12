// node --test scripts/live-checks/restore-shows-the-balance-in-seconds.test.mjs: the live check's verdict replays recorded
// answers (restore-shows-the-balance-in-seconds.answers.json), each read on 2026-11-12 by the check's collect():
//   good: this card's build of the signing page (build-app.mjs), read through scripts/ci/bundle-checks.mjs buildFetch:
//         the script is the one its page pins and holds each mark, /walk-worker.js the walk's: PASS;
//   bad:  SIGN_HOST as deployed before this card, read over https: the script pinned, no mark, and /walk-worker.js
//         answered 200 with the page's index (a path with no file), so none of the walk's marks: FAIL.
// Planted from the good answer: a script or the walk file without any one mark (each in turn), the walk file not
// answered, a script that is not the one its page pins, no host at all. And the marks on the build's own minified
// shapes, with the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, WALK_PATH } from "./restore-shows-the-balance-in-seconds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "restore-shows-the-balance-in-seconds.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the build holds every mark, the walk file its own: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.sign.js.flatMap((f) => f.found)), new Set(NAMES.sign));
  assert.deepEqual(ANSWERS.good.sign.walk.found, NAMES.walk);
});

test("recorded bad answer: SIGN_HOST before this card holds none of them, its /walk-worker.js is the index: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [`BAD sign: the scripts lack: ${NAMES.sign.join("; ")}`, `BAD sign: ${WALK_PATH} lacks: ${NAMES.walk.join("; ")}`], r.lines.join("\n"));
  assert.equal(ANSWERS.bad.sign.walk.status, 200, "the host answers a path with no file");
});

test("planted: a script without any one mark fails, naming it; the walk file too", () => {
  for (const n of NAMES.sign) {
    const r = mut((rec) => {
      for (const f of rec.sign.js) f.found = f.found.filter((m) => m !== n);
    });
    assert.deepEqual(bad(r.lines), [`BAD sign: the scripts lack: ${n}`], n);
  }
  for (const n of NAMES.walk) {
    const r = mut((rec) => void (rec.sign.walk.found = rec.sign.walk.found.filter((m) => m !== n)));
    assert.deepEqual(bad(r.lines), [`BAD sign: ${WALK_PATH} lacks: ${n}`], n);
  }
});

test("planted: the walk file not answered or not read, a script not answered, no host read", () => {
  const gone = mut((rec) => void (rec.sign.walk.status = 404));
  assert.deepEqual(bad(gone.lines), [`BAD sign: ${WALK_PATH} answers 404`], gone.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.walk = null)).ok, false);
  assert.equal(mut((rec) => void (rec.sign.js[0].status = 404)).ok, false);
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails whatever marks it holds", () => {
  for (const pin of ["sha384-other", null]) {
    const r = mut((rec) => void (rec.sign.js[0].integrity = pin));
    assert.deepEqual(bad(r.lines), [`BAD sign: not the script its page pins: ${ANSWERS.good.sign.js[0].url}`], String(pin));
  }
});

test("the marks on the build's minified shapes, any quote; a near miss is no mark", () => {
  const sign = ["return new Worker(g$(),{type:`module`,name:`walk`})", "var p$=`walk-worker`,m$=`/walk-worker.js`,h$=null", "asked again: ${t}`)},walkers:_$}),E$=y$?null:1"].join(";");
  assert.deepEqual(marksIn("sign", sign), NAMES.sign);
  const dq = ['return new Worker(a(),{type:"module",name:"walk"})', 'var p="walk-worker",m="/walk-worker.js"', "step5:a=>{b()},walkers:c})"].join(";");
  assert.deepEqual(marksIn("sign", dq), NAMES.sign);
  const walk = ["throw Error(`lane: not 0-7`)", "throw Error(`scope and masters: not bigints`)"].join(";");
  assert.deepEqual(marksIn("walk", walk), NAMES.walk);
  // the prover's worker, a classic walk Worker, another policy, the restore's own pass-through (no port from the page),
  // walkers anywhere but the host's last key (where it sat once, between `written` and `ux`, which wallet-restore-reads-ux pins)
  const near = ["new Worker(a(),{type:`module`,name:`prover`})", "new Worker(a(),{name:`walk`})", "p=`prover-worker`,m=`/prover-worker.js`", "e.walkers?{walkers:e.walkers}:{}", "walkers:_$,ux:e=>e$(e)"].join(";");
  assert.deepEqual(marksIn("sign", near), []);
  assert.deepEqual(marksIn("walk", "lane: not 0-9;masters: not bigints"), []);
});
