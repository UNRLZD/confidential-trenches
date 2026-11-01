// node --test scripts/live-checks/signpage-shell.test.mjs: the live check replays recorded runs
// (signpage-shell.answers.json). good.<engine>: this card's committed build on the harness, on the Mac's own WebKit
// (scripts/webkit-harness), Playwright's Chromium and Firefox: PASS. bad.webkit: main's build before this card
// (APP_HOST frames SIGN_HOST) on the Mac's WebKit: FAIL, its framed SIGN_HOST reading signed out after the sign-in.
// bad.chromium: the same build on Chromium: FAIL on the shell alone (there the old frame still reads the store).
// fstar.<engine>: this card's build with frame-src * in its _headers, on WebKit and Chromium: FAIL on the stranger
// alone, its frame sent to example.com. The rest are a good run with one thing changed each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, START } from "./signpage-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-shell.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

for (const engine of ["webkit", "chromium", "firefox"]) {
  test(`recorded good run on ${engine}: PASS`, () => {
    const rec = ANSWERS.good[engine];
    assert.equal(rec.engine, engine);
    const r = judge(rec);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("ok  then the frame gets signed in, way words, code_saved true")));
  });
}

test("the WebKit good run is the Mac's own WebKit, not Playwright's", () => {
  assert.match(ANSWERS.good.webkit.browser, /system WebKit/);
  assert.doesNotMatch(ANSWERS.good.webkit.browser, /Playwright/);
});

test("recorded bad run: main's build on the Mac's WebKit: FAIL, its framed SIGN_HOST reads signed out", () => {
  const r = judge(ANSWERS.bad.webkit);
  assert.equal(r.ok, false);
  const b = bad(r);
  assert.match(b[0], /^BAD SIGN_HOST is the top window and frames APP_HOST/);
  assert.match(b[1], /read \{"signed_in":false,"code_saved":false\} after the words signed SIGN_HOST in, signed-in\)$/);
});

test("recorded bad run: main's build on Chromium: FAIL on the shell", () => {
  const r = judge(ANSWERS.bad.chromium);
  assert.equal(r.ok, false);
  assert.match(bad(r)[0], /^BAD SIGN_HOST is the top window and frames APP_HOST/);
});

for (const engine of ["webkit", "chromium"]) {
  test(`recorded bad run: frame-src * on ${engine}: FAIL on the frame sent to another origin only`, () => {
    const r = judge(ANSWERS.fstar[engine]);
    assert.equal(r.ok, false);
    const b = bad(r);
    assert.equal(b.length, 2, r.lines.join("\n"));
    assert.match(b[0], /^BAD the frame cannot be sent to https:\/\/example\.com\/ \([1-9]\d* requests for it\)$/);
    assert.match(b[1], /^BAD no request leaves SIGN_HOST and APP_HOST \([1-9]\d*: example\.com/);
  });
}

const GOOD = ANSWERS.good.chromium;

test("a second ready while the frame shows APP_HOST fails", () => {
  const a = clone(GOOD);
  const r0 = a.messages.find((m) => m.data?.type === "ready");
  a.messages.push({ t: a.steps.words.t, data: r0.data });
  assert.equal(judge(a).ok, false);
});

test("a frame at another path or query fails", () => {
  for (const href of [`https://confidential.unrealized.trade/`, `https://confidential.unrealized.trade${START.split("?")[0]}`, `https://example.com${START}`]) {
    const a = clone(GOOD);
    a.steps.open.frameHref = href;
    assert.equal(judge(a).ok, false, href);
  }
});

test("a state event late, missing or with the wrong way fails", () => {
  const late = clone(GOOD);
  for (const m of late.messages) if (m.t >= late.steps.words.t && m.data?.type === "state" && !m.data.id) m.t += 60_000;
  assert.equal(judge(late).ok, false);
  const way = clone(GOOD);
  for (const m of way.messages) if (m.data?.type === "state" && m.data.state?.way === "words") m.data.state.way = "passkey";
  assert.equal(judge(way).ok, false);
});

test("a request to the stranger or to any third host fails, and so does a run that never tried the stranger", () => {
  const a = clone(GOOD);
  a.requests.push({ host: "example.com", path: "/", method: "GET" });
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  b.requests.push({ host: "evil.ct.test", path: "/x", method: "GET" });
  assert.equal(judge(b).ok, false);
  const c = clone(GOOD);
  delete c.steps.stranger;
  assert.equal(judge(c).ok, false);
});

test("a state with one more key, or a message of another kind, fails", () => {
  const a = clone(GOOD);
  const ev = a.messages.find((m) => m.data?.type === "state" && !m.data.id);
  ev.data.state.words = "x";
  assert.equal(judge(a).ok, false);
  const b = clone(GOOD);
  b.messages.push({ t: b.messages.at(-1).t, data: { v: 1, type: "debug", seed: "x" } });
  assert.equal(judge(b).ok, false);
});

test("the shell's layer left open over the frame after the sign-in fails", () => {
  const a = clone(GOOD);
  a.steps.words.layerHidden = false;
  assert.equal(judge(a).ok, false);
});
