// node --test scripts/live-checks/withdraw-form-shows-what-you-can-send.test.mjs: the live check replays its recorded
// answers (withdraw-form-shows-what-you-can-send.answers.json). good: this card's SIGN_HOST build, the pool withdraw
// screen's chain marks, its sendable control and its paste cleaning in the bundle: PASS. bad: main d97e984e's build:
// FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL. glued: this branch's earlier build, whose To took
// whitespace out inside the field: FAIL. Planted on the good one: another /app.js, no pin, a mark missing or not the
// app's file, no sendable control, each cleaning pattern, the glue: each FAIL. MARKS are the app's own files' sha256.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CLEAN, facts, GLUE, judge, MARKS } from "./withdraw-form-shows-what-you-can-send.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./withdraw-form-shows-what-you-can-send.answers.json", import.meta.url), "utf8"));
const NO_MARKS = "BAD the bundle draws no mark of solana, base, robinhood as the app's own file: the withdraw screen does not show its chain";
const NO_SENDABLE = "BAD the bundle has no sendable control: the withdraw screen does not show what can be sent";
const lacks = (k) => `BAD the bundle's To lacks its paste cleaning (${k}): a paste's hidden characters are not handled as the screen's rule says`;
const NO_CLEAN = lacks("ends, joiners, direction");
const GLUED = "BAD the bundle's To takes whitespace out inside the field: a row's pieces can be glued into another key";

test("recorded good answer: this card's build carries the chain marks, the sendable control and the paste cleaning: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

for (const k of ["bad", "liveBefore"]) {
  test(`recorded bad answer ${k}: FAIL, each fact named`, () => {
    const v = judge(ANSWERS[k]);
    assert.equal(v.ok, false);
    assert.deepEqual(v.lines, [NO_MARKS, NO_SENDABLE, NO_CLEAN]);
  });
}

test("recorded bad answer glued: the earlier build that took whitespace out inside To: FAIL on the cleaning alone", () => {
  const v = judge(ANSWERS.glued);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, [NO_CLEAN, GLUED]);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.deepEqual(judge({ ...g, marks: g.marks.filter((h) => h !== MARKS.base) }).lines, ["BAD the bundle draws no mark of base as the app's own file: the withdraw screen does not show its chain"]);
  assert.equal(judge({ ...g, marks: null }).ok, false);
  assert.deepEqual(judge({ ...g, sendable: false }).lines, [NO_SENDABLE]);
  assert.deepEqual(judge({ ...g, clean: null }).lines, [NO_CLEAN]);
  for (const k of Object.keys(CLEAN)) assert.deepEqual(judge({ ...g, clean: g.clean.filter((x) => x !== k) }).lines, [lacks(k)], k);
  assert.deepEqual(judge({ ...g, glue: true }).lines, [GLUED]);
  assert.equal(judge(null).ok, false);
});

test("MARKS are the app's own chain mark files", () => {
  const file = { solana: "solana.svg", base: "base.svg", robinhood: "robinhood.png" };
  for (const [c, h] of Object.entries(MARKS)) {
    const bytes = readFileSync(new URL(`../../apps/terminal/src/screens/market/logos/${file[c]}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), h, c);
  }
});

test("the facts read from a bundle", () => {
  const svg = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
  const js = `const a={logo:"${svg("<svg/>")}"},E=${CLEAN.ends},J=${CLEAN.joiners},D=${CLEAN.direction};b.dataset.action=\`sendable\`;`;
  const f = facts("", js);
  assert.deepEqual(f.marks, [createHash("sha256").update("<svg/>").digest("hex")]);
  assert.deepEqual(f.clean, ["ends", "joiners", "direction"]);
  assert.equal(f.glue, false);
  assert.equal(f.sendable, true);
  // a pattern without its u flag, or with a range cut: not read
  assert.deepEqual(facts("", js.replace(CLEAN.direction, CLEAN.direction.replace("/u", "/"))).clean, ["ends", "joiners"]);
  assert.deepEqual(facts("", js.replace(CLEAN.joiners, CLEAN.joiners.replace("\\u00AD", ""))).clean, ["ends", "direction"]);
  assert.equal(facts("", `${js}G=${GLUE};`).glue, true);
  assert.equal(facts("", js.replace("`sendable`", "`send`")).sendable, false);
});
