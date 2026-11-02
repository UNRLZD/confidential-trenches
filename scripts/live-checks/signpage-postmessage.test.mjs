// node --test scripts/live-checks/signpage-postmessage.test.mjs: the live check replays recorded runs
// (signpage-postmessage.answers.json). good: packages/signpage's build at card signpage-shell (frame-ancestors 'none'),
// answered by `--local` (no network): PASS, APP_HOST blocked like every stranger. framed: SIGN_HOST as deployed before
// card signpage-shell (frame-ancestors APP_HOST): FAIL, APP_HOST frames it and its ready arrives. planted: an earlier
// build with the page's origin check taken out and its answers posted to "*": FAIL on every stranger with
// frame-ancestors lifted. The rest are the good run with one thing changed each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_HOST, headersOf, judge } from "./signpage-postmessage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-postmessage.answers.json"), "utf8"));
const GOOD = ANSWERS.good;
const clone = (x) => JSON.parse(JSON.stringify(x));
const run = (rec, parent, headers) => rec.runs.find((r) => r.parent === parent && r.headers === headers);
const STRANGERS = ["https://example.com", "https://evil.ct.test", "https://app.other.test"];

test("recorded good run (local build): PASS, APP_HOST blocked by frame-ancestors", () => {
  const r = judge(GOOD);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  from APP_HOST: the frame is blocked by frame-ancestors"), r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  from APP_HOST: 0 message(s) reached the parent, want none"), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.startsWith("ok  from APP_HOST with frame-ancestors lifted")));
  assert.ok(r.lines.includes("ok  from https://example.com: the frame is blocked by frame-ancestors"));
  assert.ok(r.lines.includes("ok  from https://evil.ct.test with frame-ancestors lifted: the frame loads and its script runs"));
  assert.ok(r.lines.includes("ok  from https://app.other.test with frame-ancestors lifted: 0 message(s) reached the parent, want none"));
});

test("recorded bad run: SIGN_HOST before card signpage-shell, framed by APP_HOST: FAIL, the frame loads and its ready arrives", () => {
  const r = judge(ANSWERS.framed);
  assert.equal(r.ok, false);
  const b = r.lines.filter((l) => l.startsWith("BAD"));
  assert.equal(b.length, 2, r.lines.join("\n"));
  assert.equal(b[0], "BAD from APP_HOST: the frame is loaded");
  assert.match(b[1], /^BAD from APP_HOST: [1-9]\d* message\(s\) reached the parent \(\[\{"v":1,"type":"ready",/);
});

test("recorded bad run: a page that answers every origin: FAIL on every stranger with frame-ancestors lifted", () => {
  const r = judge(ANSWERS.planted);
  assert.equal(r.ok, false);
  for (const s of STRANGERS) {
    assert.ok(r.lines.some((l) => l.startsWith(`BAD from ${s} with frame-ancestors lifted: `) && /message\(s\) reached the parent/.test(l)), `${s}\n${r.lines.join("\n")}`);
  }
});

test("the good run with one change each: FAIL", () => {
  const cases = {
    "APP_HOST's frame loads": (rec) => (run(rec, APP_HOST, "served").loaded = true),
    "a message reaches APP_HOST": (rec) => run(rec, APP_HOST, "served").messages.push({ t: 1, origin: "https://sign.confidential.unrealized.trade", fromFrame: true, data: { v: 1, type: "ready", release: "x", api: 1 } }),
    "the APP_HOST run missing": (rec) => (rec.runs = rec.runs.filter((r) => r.parent !== APP_HOST)),
    "a stranger's frame loads under the served headers": (rec) => (run(rec, "https://example.com", "served").loaded = true),
    "a stranger's lifted frame runs no script": (rec) => (run(rec, "https://evil.ct.test", "lifted").scriptRan = false),
    "a message reaches a lifted stranger": (rec) => run(rec, "https://app.other.test", "lifted").messages.push({ t: 1, origin: "https://sign.confidential.unrealized.trade", fromFrame: true, data: { v: 1, type: "ready" } }),
    "a stranger run missing": (rec) => (rec.runs = rec.runs.filter((r) => r.parent !== "https://app.other.test")),
  };
  for (const [name, change] of Object.entries(cases)) {
    const rec = clone(GOOD);
    change(rec);
    assert.equal(judge(rec).ok, false, name);
  }
});

test("headersOf reads the /* rule of SIGN_HOST's _headers", () => {
  const h = headersOf(readFileSync(path.join(HERE, "../../packages/signpage/public/_headers"), "utf8"));
  // SIGN_HOST is the top window since card signpage-shell: nothing may frame it
  assert.match(h["content-security-policy"], /frame-ancestors 'none';/);
  assert.equal(h["integrity-policy"], "blocked-destinations=(script)");
  assert.deepEqual(headersOf("/x\n  A: 1\n/*\n  B: 2\n"), { b: "2" });
});
