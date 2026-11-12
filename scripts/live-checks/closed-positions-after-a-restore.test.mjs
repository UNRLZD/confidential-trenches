// node --test scripts/live-checks/closed-positions-after-a-restore.test.mjs: the live check's verdict replays recorded
// answers (closed-positions-after-a-restore.answers.json), each read on 2026-11-12 by the check's collect():
//   good: this card's build of the signing page (build-app.mjs), read through scripts/ci/bundle-checks.mjs buildFetch:
//         the script is the one its page pins and holds each mark: PASS;
//   bad:  SIGN_HOST as deployed before this card (release 121), read over https: the script pinned, no mark: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn), a script the host did not answer, a script
// that is not the one its page pins or has no pin, no host at all. And the marks on the build's own minified shapes,
// with the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES } from "./closed-positions-after-a-restore.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "closed-positions-after-a-restore.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the build holds every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.sign.js.flatMap((f) => f.found)), new Set(NAMES.sign));
});

test("recorded bad answer: SIGN_HOST before this card holds none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).includes(`BAD sign: the scripts lack: ${NAMES.sign.join("; ")}`), r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it", () => {
  for (const n of NAMES.sign) {
    const r = mut((rec) => {
      for (const f of rec.sign.js) f.found = f.found.filter((m) => m !== n);
    });
    assert.equal(r.ok, false, n);
    assert.ok(bad(r.lines).includes(`BAD sign: the scripts lack: ${n}`), r.lines.join("\n"));
  }
});

test("planted: a script the host did not answer, a page naming none, no host read", () => {
  const miss = mut((rec) => void (rec.sign.js[0].status = 404));
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /^BAD sign: 1 script\(s\) named by the page, each answering 200$/.test(l)), miss.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails whatever marks it holds", () => {
  for (const pin of ["sha384-other", null]) {
    const r = mut((rec) => void (rec.sign.js[0].integrity = pin));
    assert.equal(r.ok, false, String(pin));
    assert.deepEqual(bad(r.lines), [`BAD sign: not the script its page pins: ${ANSWERS.good.sign.js[0].url}`], r.lines.join("\n"));
  }
  assert.equal(ANSWERS.bad.sign.js[0].integrity, ANSWERS.bad.sign.js[0].sha384, "the deployed host pins its own script");
});

test("the marks on the build's minified shapes, any quote; a near miss is no mark", () => {
  const sign = ["...a===void 0?{}:{until:a.after}}]", "{...e,fill_none:!0}", "n.push({key:`restored/${i}`,rec:{kind:`buy`,...s}})", "iJ=`owed/trades-sol-read`", "if(i.kind===`buy`&&i.amount_usd===void 0){"].join(";");
  assert.deepEqual(marksIn("sign", sign), NAMES.sign);
  const dq = ["...a===void 0?{}:{until:a.after}}]", "{...e,fill_none:!0}", 'n.push({key:"restored/"+i,rec:{kind:"buy",...s}})', 'iJ="owed/trades-sol-read"', 'if(i.kind==="buy"&&i.amount_usd===void 0){'].join(";");
  assert.deepEqual(marksIn("sign", dq), NAMES.sign);
  // the reader's list from the newest (no cursor), a cursor of another field, an op not marked, an op keyed by another name, the buy records' own key, a sale priced, a buy with USD
  const near = ["{before:n}", "{until:a.before}", "{...e,fill_none:!1}", "{key:`trade/${i}`,rec:{kind:`buy`}}", "`owed/buy-sol-none`", "i.kind===`sell`&&i.amount_usd===void 0", "i.kind===`buy`&&i.amount_usd!==void 0"].join(";");
  assert.deepEqual(marksIn("sign", near), []);
});
