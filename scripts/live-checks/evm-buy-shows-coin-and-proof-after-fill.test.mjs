// node --test scripts/live-checks/evm-buy-shows-coin-and-proof-after-fill.test.mjs: the live check replays its recorded
// reads (evm-buy-shows-coin-and-proof-after-fill.answers.json), each written by its own --record or pageFacts:
//   good: this card's build (build-app.mjs --out at the card's tip): PASS, the positions pass with no list-size gate;
//   bad: SIGN_HOST at release 144 (main 837d9d810, read 14 Nov 21:12Z): FAIL, the gate `r.passList.length!==2?null:`.
// Then cases planted on the good read, one end state undone each, and pageFacts on planted bundles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, pageFacts, PASS_MARK } from "./evm-buy-shows-coin-and-proof-after-fill.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "evm-buy-shows-coin-and-proof-after-fill.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (rec, start) => {
  const r = judge(rec);
  assert.equal(r.ok, false, r.lines.join("\n"));
  assert.ok(r.lines.some((l) => l.startsWith(`BAD ${start}`)), `${start}\n${r.lines.join("\n")}`);
};

test("recorded good answer: this card's build reads positions on any list size: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: SIGN_HOST at release 144 reads positions only on a list of two: FAIL", () => {
  assert.match(ANSWERS.bad.source, /^live https:\/\/confidential\.unrealized\.trade$/);
  bad(ANSWERS.bad, "the bundle reads positions on a pass list of any size");
});

test("planted on the good answer: an unpinned bundle, no positions pass, or a gate: FAIL", () => {
  let r = clone(ANSWERS.good);
  r.facts.pin = "sha384-other";
  bad(r, "the served /app.js is the one index.html pins");
  r = clone(ANSWERS.good);
  r.facts.marks.pass = 0;
  bad(r, "the bundle carries the EVM positions pass");
  r = clone(ANSWERS.good);
  r.facts.marks.gate = 1;
  bad(r, "the bundle reads positions on a pass list of any size");
  bad({}, "the served /app.js is the one index.html pins");
});

test("pageFacts: release 144's minified gate and any other size are counted, the fixed form is not", () => {
  const index = (js) => `<script src="/app.js" integrity="${pageFacts("", js).sha384}"></script>`;
  const was = `Bt.set(n,r===null||r.passList.length!==2?null:WQ(()=>"${PASS_MARK}"))`;
  assert.deepEqual(pageFacts(index(was), was).marks, { pass: 1, gate: 1 });
  const three = was.replace("!==2", "!==3");
  assert.equal(pageFacts(index(three), three).marks.gate, 1);
  const fixed = `Bt.set(n,r===null?null:WQ(()=>"${PASS_MARK}"))`;
  const f = pageFacts(index(fixed), fixed);
  assert.deepEqual(f.marks, { pass: 1, gate: 0 });
  assert.equal(f.pin, f.sha384);
});
