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
  assert.ok(events(GOOD).length >= 3);
});

test("recorded bad run (the build before this card): FAIL, no state event after any step", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const s of ["then the frame posts signed in", "then the frame posts code_saved true", "then the frame posts signed out"])
    assert.ok(r.lines.some((l) => l.startsWith(`BAD ${s}`)), `${s}\n${r.lines.join("\n")}`);
});

test("recorded bad run m4 (the frame's main.ts reads the seed): FAIL on the frames' IndexedDB reads only", () => {
  const r = judge(ANSWERS.m4);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 1, r.lines.join("\n"));
  assert.match(bad[0], /^BAD no SIGN_HOST frame reads the seed record .* get meta\/seed/);
});

test("recorded bad run m10 (no backfill at the top-level load): FAIL on the reload only", () => {
  const r = judge(ANSWERS.m10);
  assert.equal(r.ok, false);
  const bad = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(bad.length, 1, r.lines.join("\n"));
  assert.match(bad[0], /^BAD the top tab's reload brings back way passkey and code_saved true/);
});

test("a frame that reads the seed record fails, and so does a run whose frames the spy never reached", () => {
  const a = clone(GOOD);
  a.frames[1].seedReads.push("get meta/seed");
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  b.frames[0] = { calls: 0, seedReads: null };
  assert.equal(judge(b).ok, false);
  const c = clone(GOOD);
  c.frames = c.frames.slice(0, 1);
  assert.equal(judge(c).ok, false);
});

test("a state that carries one more key fails", () => {
  const rec = clone(GOOD);
  for (const e of events(rec)) e.data.state.entropy = "7f".repeat(16);
  const r = judge(rec);
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD then the frame posts signed in")), r.lines.join("\n"));
});

test("a signed-out state with a way, or a way outside passkey, words and wallet, fails", () => {
  const a = clone(GOOD);
  events(a).at(-1).data.state.way = "passkey";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  for (const e of events(b)) if (e.data.state.signed_in) e.data.state.way = "face";
  assert.equal(judge(b).ok, false);
});

test("an event later than EVENT_MS after its step fails", () => {
  const rec = clone(GOOD);
  for (const e of events(rec)) if (e.data.state.code_saved) e.t += 60_000;
  assert.equal(judge(rec).ok, false);
});

test("an event from another origin or not from the frame is not counted", () => {
  const a = clone(GOOD);
  events(a).at(-1).origin = "https://evil.ct.test";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  events(b).at(-1).fromFrame = false;
  assert.equal(judge(b).ok, false);
});

test("a first answer that says signed in fails", () => {
  const rec = clone(GOOD);
  const first = rec.messages.find((m) => m.data?.id === rec.steps.first.id);
  first.data.result = { ...first.data.result, signed_in: true, way: "words" };
  assert.equal(judge(rec).ok, false);
});
