// node --test scripts/live-checks/portfolio-moves-money-between-chains.test.mjs: the live check's verdict replays recorded
// answers (portfolio-moves-money-between-chains.answers.json), each read on 2026-11-13 by
// portfolio-moves-money-between-chains.mjs collect():
//   good: this card's terminal build (vite build, read from disk): the page's script holds Private balance's total, Move,
//         the move sheet's flow and button, and the kind it asks: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script holds none of them: FAIL.
// Planted from the good answer: a script that lost the sheet's flow, a stylesheet the host did not answer, no script at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JS_MARKERS, judge } from "./portfolio-moves-money-between-chains.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "portfolio-moves-money-between-chains.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's script holds Private balance's move: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds none of it: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /the scripts lack Private balance's move: data-pools-total, pool-move-, move-flow, move-go, pool\.move\.dry$/.test(l)), r.lines.join("\n"));
});

test("planted: a script without the move sheet's flow fails", () => {
  const r = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "move-flow");
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => /lack Private balance's move: move-flow$/.test(l)), r.lines.join("\n"));
});

test("planted: a stylesheet the host did not answer, or a page naming no script, fails", () => {
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /stylesheet\(s\) named by the page, each answering 200/.test(l)), miss.lines.join("\n"));
  const none = mut((rec) => {
    rec.js = [];
  });
  assert.equal(none.ok, false);
});
