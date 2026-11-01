// node --test scripts/live-checks/signpage-frame-state.test.mjs: the live check replays recorded runs
// (signpage-frame-state.answers.json). good: packages/signpage's build at this card on the app's browser harness
// (--harness): PASS. bad: the build before this card (main 7419700, whose frame answers signedOutState() always and posts
// no state event), on the same harness (--harness --site): FAIL. The rest are the good run with one thing changed each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge } from "./signpage-frame-state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-frame-state.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const clone = (x) => JSON.parse(JSON.stringify(x));
const events = (rec) => rec.messages.filter((m) => m.data?.type === "state");

test("recorded good run (this card's build, harness): PASS", () => {
  const r = judge(GOOD);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(events(GOOD).length, 3);
});

test("recorded bad run (the build before this card): FAIL, no state event after any step", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const s of ["then the frame posts signed in", "then the frame posts code_saved true", "then the frame posts signed out"])
    assert.ok(r.lines.some((l) => l.startsWith(`BAD ${s}`)), `${s}\n${r.lines.join("\n")}`);
});

test("a state that carries one more key fails", () => {
  const rec = clone(GOOD);
  events(rec)[0].data.state.entropy = "7f".repeat(16);
  const r = judge(rec);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD then the frame posts signed in")), r.lines.join("\n"));
});

test("a signed-out state with a way, or a signed-in one without, fails", () => {
  const a = clone(GOOD);
  events(a)[2].data.state.way = "passkey";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  delete events(b)[0].data.state.way;
  assert.equal(judge(b).ok, false);
});

test("an event later than EVENT_MS after its step fails", () => {
  const rec = clone(GOOD);
  events(rec)[1].t += 60_000;
  assert.equal(judge(rec).ok, false);
});

test("an event from another origin or not from the frame is not counted", () => {
  const a = clone(GOOD);
  events(a)[2].origin = "https://evil.ct.test";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  events(b)[2].fromFrame = false;
  assert.equal(judge(b).ok, false);
});

test("a first answer that says signed in fails", () => {
  const rec = clone(GOOD);
  const first = rec.messages.find((m) => m.data?.id === rec.steps.first.id);
  first.data.result = { ...first.data.result, signed_in: true, way: "words" };
  assert.equal(judge(rec).ok, false);
});
