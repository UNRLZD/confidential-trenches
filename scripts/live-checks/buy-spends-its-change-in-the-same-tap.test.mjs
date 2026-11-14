// node --test scripts/live-checks/buy-spends-its-change-in-the-same-tap.test.mjs: the live check's verdict replays
// recorded answers (buy-spends-its-change-in-the-same-tap.answers.json), each facts() over a tree's index.html and app.js:
//   good: this card's branch, built with packages/signpage/scripts/build-app.mjs --out: the index pins the bundle, and it
//         weighs the carried change, proves a first round's change to its W, and hands the settled change over: PASS;
//   bad:  SIGN_HOST as served before the card: none of the three: FAIL.
// Planted from those: each mark alone missing, and an index that pins another bundle or none.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { facts, judge } from "./buy-spends-its-change-in-the-same-tap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "buy-spends-its-change-in-the-same-tap.answers.json"), "utf8"));
const mut = (f) => {
  const a = structuredClone(ANSWERS.good);
  f(a);
  return judge(a);
};
const fails = (r, re) => {
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith("BAD") && re.test(l)), r.lines.join("\n"));
};

test("recorded good answer: the branch's build: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST before the card: FAIL on all three marks", () => {
  const r = judge(ANSWERS.bad);
  fails(r, /no carried change/);
  fails(r, /cannot prove/);
  fails(r, /no first round/);
});

test("planted: each mark alone, and the index's pin", () => {
  fails(mut((a) => (a.carry = false)), /no carried change/);
  fails(mut((a) => (a.prove = false)), /cannot prove/);
  fails(mut((a) => (a.round = false)), /no first round/);
  fails(mut((a) => (a.sha384 = ANSWERS.bad.sha384)), /not the one index\.html pins/);
  fails(mut((a) => (a.index = "<html></html>")), /pins no \/app\.js/);
});

test("facts() reads each mark from the minified code as the build writes it, and misses each when it is gone", () => {
  const index = '<script src="/app.js" integrity="x"></script>';
  const carry = "r.push({...a,noteId:`${a.noteId}#change`,chunk:o,root:`newest`,carryOf:a.noteId})";
  const prove = "throw Error(`proveFor: note ${e} is not a landed note of this pool with a listed piece, UNSPENT or held by its own proof alone`)";
  const round = "throw Error(`no change written for note ${t}`)";
  const all = facts(index, `${carry};${prove};${round}`);
  assert.deepEqual([all.carry, all.prove, all.round], [true, true, true]);
  const none = facts(index, "r.push({...a,noteId:a.noteId});throw Error(`no ready proof for note ${e}`)");
  assert.deepEqual([none.carry, none.prove, none.round], [false, false, false]);
});
