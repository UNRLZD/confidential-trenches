// Replays the sign-in e2e's recorded launches through its verdict (card app-harness-signin-e2e): the good launches
// recorded pass, and each planted launch fails on the line its plant breaks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOUND, judge, RUNS, SIGNIN_SWAP_NODES } from "./run.mjs";

const answers = JSON.parse(readFileSync(new URL("./run.answers.json", import.meta.url), "utf8"));

test("every good launch passes, each at both widths", () => {
  assert.deepEqual(answers.good.map((r) => r.run), RUNS);
  for (const rec of answers.good) {
    const v = judge(rec);
    assert.equal(v.ok, true, v.lines.filter((l) => l.startsWith("BAD")).join("\n"));
    assert.deepEqual(rec.widths.map((w) => w.width), ["390", "1440"]);
  }
});

const WANT = {
  jump: /BAR-04 CLS in step signin/,
  "missing-frame": /AS-01 shots: missing fr-P1-S2.1/,
  "prf-off": /prf\.enabled on the create: false \(want true\)/,
};
for (const [plant, line] of Object.entries(WANT)) {
  test(`the planted ${plant} fails at both widths`, () => {
    const rec = answers.bad[plant];
    assert.equal(rec.plant, plant);
    const v = judge(rec);
    assert.equal(v.ok, false);
    for (const width of ["390", "1440"]) assert.ok(v.lines.some((l) => l.startsWith(`BAD prf @${width}`) && line.test(l)), `${plant} @${width}: ${v.lines.join("\n")}`);
  });
}

test("a launch with no widths, or a width that broke, fails", () => {
  assert.equal(judge({ run: "prf", widths: [] }).ok, false);
  assert.equal(judge({ run: "wallet", widths: [{ width: "390", error: "boom" }] }).ok, false);
});

test("the wallet way may land on its restore (S19), never another open sheet; a new account's way lands with none", () => {
  const wallet = answers.good.find((r) => r.run === "wallet");
  const prf = answers.good.find((r) => r.run === "prf");
  const withSheet = (rec, sheetState) => ({ ...rec, widths: rec.widths.map((w) => ({ ...w, landing: { ...w.landing, sheet: 1, sheetState } })) });
  const bad = (v) => v.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(judge(withSheet(wallet, "S19.5")).ok, true, bad(judge(withSheet(wallet, "S19.5"))).join("\n"));
  // S19.2 is no state the sheet emits (SigninSheet.tsx emits S19.1, S19.3, S19.4 and S19.5): never a landing
  for (const [rec, state] of [[wallet, "S2.1"], [wallet, null], [wallet, "S19.2"], [prf, "S19.5"]]) {
    const v = judge(withSheet(rec, state));
    assert.equal(v.ok, false);
    for (const width of ["390", "1440"]) assert.ok(bad(v).some((l) => l.startsWith(`BAD ${rec.run} @${width} the sign-in sheet closed (1`)), `${rec.run} ${state} @${width}: ${bad(v).join("\n")}`);
  }
});

// BAR-04's one allowance (card signing-views-open-over-the-app): the header's account slot taking its signed-in width
// in the step the sign-in lands in, the listed nodes only, at most BOUND.signinSwap. Each plant below must fail.
const prfGood = () => structuredClone(answers.good.find((r) => r.run === "prf"));
const swapStep = (w) => w.cls.steps.find((s) => s.sum > 0);
const bad04 = (rec) => judge(rec).lines.filter((l) => l.startsWith("BAD") && /BAR-04 CLS in step/.test(l));

test("the good launches use the allowance only in the step the sign-in lands in, on the listed nodes, under the bound", () => {
  assert.equal(BOUND.signinSwap, 0.005);
  for (const rec of answers.good.filter((r) => r.run !== "wallet"))
    for (const w of rec.widths) {
      const moved = w.cls.steps.filter((s) => s.sum > 0);
      assert.deepEqual(moved.map((s) => [s.step, s.landed]), [["create", true]], `${rec.run} @${w.width}`);
      assert.ok(moved[0].sum <= BOUND.signinSwap);
      assert.ok(moved[0].entries.every((e) => e.sources.every((x) => SIGNIN_SWAP_NODES.includes(x.split(" ")[0]))));
    }
  // the good before the sheet: a new document after the sign-in, no shift in any step
  for (const rec of answers.goodPageOfItsOwn) assert.equal(judge(rec).ok, true, rec.run);
});

test("planted: the same nodes shifting in another step fail", () => {
  const rec = prfGood();
  for (const w of rec.widths) {
    const s = swapStep(w);
    const other = w.cls.steps.find((x) => x.step === "passkey");
    Object.assign(other, { sum: s.sum, sources: s.sources, entries: structuredClone(s.entries), landed: false });
  }
  assert.equal(bad04(rec).length, 2, judge(rec).lines.join("\n"));
  assert.ok(bad04(rec).every((l) => /in step passkey/.test(l)));
});

test("planted: one more node moving in the sign-in's step fails (a row, the trade box, a sheet)", () => {
  for (const extra of ["div.dcol-row 10,200,300,60 -> 10,240,300,60", "div.tbox 0,500,390,300 -> 0,520,390,300", "aside.sgn-box 100,100,300,300 -> 100,140,300,300"]) {
    const rec = prfGood();
    for (const w of rec.widths) swapStep(w).entries[0].sources.push(extra);
    assert.equal(bad04(rec).length, 2, extra);
  }
  // an entry that names 5 sources may hide more (the API names at most 5): never the allowance
  const rec = prfGood();
  for (const w of rec.widths) {
    const e = swapStep(w).entries[0];
    while (e.sources.length < 5) e.sources.push(e.sources[0]);
  }
  assert.equal(bad04(rec).length, 2);
});

test("planted: the listed nodes moving more than the bound fail", () => {
  const rec = prfGood();
  for (const w of rec.widths) {
    const s = swapStep(w);
    s.sum = BOUND.signinSwap + 0.0001;
    s.entries[0].value = s.sum;
  }
  assert.equal(bad04(rec).length, 2);
});

test("planted: the same shift with no sign-in landing in that step fails", () => {
  const rec = prfGood();
  for (const w of rec.widths) swapStep(w).landed = false;
  assert.equal(bad04(rec).length, 2);
  const none = prfGood();
  for (const w of none.widths) delete swapStep(w).landed;
  assert.equal(bad04(none).length, 2);
});
