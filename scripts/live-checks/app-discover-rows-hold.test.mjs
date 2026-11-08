// node --test scripts/live-checks/app-discover-rows-hold.test.mjs: the live check's verdict replays recorded answers
// (app-discover-rows-hold.answers.json), each read on 2026-11-08 by app-discover-rows-hold.mjs collect():
//   good: this card's terminal build at APP_HOST's name in the stand-in shell, the helper live: the lists reordered in
//         the hold and no element moved, at both widths: PASS;
//   bad:  APP_HOST as deployed before this card (Discover's rows keyed by token): a refresh reordered a list and every
//         row under the change moved down a slot: FAIL, each moved row named.
// Planted from the good answer: a row's shift fails and names it, text or a slot's own content re-laid out passes, the
// same element outside a row's content fails, no reorder in the hold is
// INCONCLUSIVE (exit 3, never a PASS), no rows, a short hold, a page error or a missing width fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changedSlots, EXIT, judge } from "./app-discover-rows-hold.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-discover-rows-hold.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the lists reordered in the hold and no element moved, at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const l of ANSWERS.good.loads) assert.ok(l.reorders > 0 && l.rows > 0, `${l.width} reordered`);
});

test("recorded bad answer: the deployed rows moved down a slot when a refresh reordered a list: FAIL, each row named", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => /shift\(s\) moved an element \[\+\d+ms: div /.test(l)), r.lines.join("\n"));
});

const row = { text: "div 7,133 351x72 -> 7,205 351x72", cell: false };
const text = { text: "#text 300,150 40x12 -> 296,150 44x12", cell: true };
const name = { text: "span.dsc-name 120,430 74x13 -> 135,430 41x13", cell: true };

test("planted: a row that moves fails and names its element and rects; text or a slot's own content re-laid out passes", () => {
  const moved = mut((rec) => rec.loads[1].shifts.push({ at: 24_500, value: 0.002, input: false, sources: [row, text, name] }));
  assert.equal(moved.verdict, "FAIL");
  assert.ok(bad(moved).some((l) => l.includes("[+24500ms: div 7,133 351x72 -> 7,205 351x72]")), moved.lines.join("\n"));
  assert.equal(mut((rec) => rec.loads[1].shifts.push({ at: 24_500, value: 0.00002, input: false, sources: [text, name] })).verdict, "PASS");
  // the same element outside a row's content (a header, the tabs) fails
  assert.equal(mut((rec) => rec.loads[0].shifts.push({ at: 12_900, value: 0.0001, input: false, sources: [{ ...name, cell: false }] })).verdict, "FAIL");
});

test("planted: a width whose lists never reordered is INCONCLUSIVE (exit 3), never a PASS; with a BAD line it is a FAIL", () => {
  const quiet = mut((rec) => (rec.loads[0].reorders = 0));
  assert.equal(quiet.verdict, "INCONCLUSIVE");
  assert.equal(quiet.ok, false);
  assert.equal(EXIT[quiet.verdict], 3);
  assert.ok(quiet.lines.some((l) => l.startsWith("INCONCLUSIVE phone")), quiet.lines.join("\n"));
  assert.equal(mut((rec) => ((rec.loads[0].reorders = 0), rec.loads[1].errors.push("TypeError: x"))).verdict, "FAIL");
});

test("planted: no rows, a short hold, a page error or a missing width fails", () => {
  for (const f of [
    (rec) => (rec.loads[0].rows = 0),
    (rec) => (rec.loads[1].heldMs = 12_000),
    (rec) => rec.loads[0].errors.push("TypeError: x is undefined"),
    (rec) => rec.loads.pop(),
    (rec) => (rec.loads = []),
  ]) {
    assert.equal(mut(f).verdict, "FAIL");
  }
});

test("changedSlots: a slot drawn before that shows another token counts; a longer or equal list does not", () => {
  assert.equal(changedSlots([["a", "b", "c"]], [["n", "a", "b", "c"]]), 3);
  assert.equal(changedSlots([["a", "b"]], [["a", "b", "c"]]), 0);
  assert.equal(changedSlots([["a", "b"], ["x"]], [["a", "b"], ["y"]]), 1);
  assert.equal(changedSlots([["a", "b", "c"]], [["a", "b"]]), 0);
});
