// node --test scripts/live-checks/withdraw-form-shows-what-you-can-send.test.mjs: the live check replays its recorded
// answers (withdraw-form-shows-what-you-can-send.answers.json). good: this card's SIGN_HOST build, the pool withdraw
// screen's chain marks, its sendable control and its paste cleaning in the bundle: PASS. bad: main d97e984e's build:
// FAIL. liveBefore: SIGN_HOST before this card's deploy: FAIL. Planted on the good one: another /app.js, no pin, a mark
// missing or not the app's file, no sendable control, no cleaning: each FAIL. MARKS are the app's own files' sha256.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, MARKS } from "./withdraw-form-shows-what-you-can-send.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./withdraw-form-shows-what-you-can-send.answers.json", import.meta.url), "utf8"));
const NO_MARKS = "BAD the bundle draws no mark of solana, base, robinhood as the app's own file: the withdraw screen does not show its chain";
const NO_SENDABLE = "BAD the bundle has no sendable control: the withdraw screen does not show what can be sent";
const NO_CLEAN = "BAD the bundle does not take what a paste carries out of To: a pasted address with an invisible character is refused";

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

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.ok(judge({ ...g, sha384: "sha384-other" }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...g, index: "<html></html>" }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
  assert.deepEqual(judge({ ...g, marks: g.marks.filter((h) => h !== MARKS.base) }).lines, ["BAD the bundle draws no mark of base as the app's own file: the withdraw screen does not show its chain"]);
  assert.equal(judge({ ...g, marks: null }).ok, false);
  assert.deepEqual(judge({ ...g, sendable: false }).lines, [NO_SENDABLE]);
  assert.deepEqual(judge({ ...g, clean: null }).lines, [NO_CLEAN]);
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
  const js = `const a={logo:"${svg("<svg/>")}"},U=/[\\p{White_Space}\\p{Cf}]/gu;b.dataset.action=\`sendable\`;`;
  const f = facts("", js);
  assert.deepEqual(f.marks, [createHash("sha256").update("<svg/>").digest("hex")]);
  assert.equal(f.clean, "/[\\p{White_Space}\\p{Cf}]/gu");
  assert.equal(f.sendable, true);
  // the pattern without its u flag, or another class: not read
  assert.equal(facts("", js.replace("/gu", "/g")).clean, null);
  assert.equal(facts("", js.replace("\\p{Cf}", "\\s")).clean, null);
  assert.equal(facts("", js.replace("`sendable`", "`send`")).sendable, false);
});
