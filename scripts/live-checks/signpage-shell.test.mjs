// node --test scripts/live-checks/signpage-shell.test.mjs: the live check replays recorded runs
// (signpage-shell.answers.json). good.<engine>.<width>: this card's committed build on the harness, on the Mac's own
// WebKit (scripts/webkit-harness), Playwright's Chromium and Firefox, at 390 x 844 (phone) and 1440 x 900 (desktop):
// PASS. bad.webkit: main's build before this card
// (APP_HOST frames SIGN_HOST) on the Mac's WebKit: FAIL, its framed SIGN_HOST reading signed out after the sign-in.
// bad.chromium: the same build on Chromium: FAIL on the shell alone (there the old frame still reads the store).
// fstar.<engine>: this card's build with frame-src * in its _headers, on WebKit and Chromium: FAIL on the stranger
// alone, its frame sent to example.com. prefix.<engine>: this card's build at ea785a4, before the review's fixes (the
// layer over the terminal while signed out, the frame left under it, no signin.open, nav or reload): FAIL, and on
// Chromium the app takes the typed words. fstar and prefix run at phone width. bad.* were recorded before the check
// named its width, so their first line is the width's BAD and the tests read the lines after it. The rest are a good run with one thing changed each, among them the lines that
// signpage-frame-state judged (retired with this card): a reload while signed in, the status deleted raw, its backfill.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EVENT_MS, judge, START, WIDTHS } from "./signpage-shell.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "signpage-shell.answers.json"), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD") && !l.startsWith("BAD the view is"));

for (const engine of ["webkit", "chromium", "firefox"]) {
  for (const [width, size] of Object.entries(WIDTHS)) {
    test(`recorded good run on ${engine} at ${width} width: PASS`, () => {
      const rec = ANSWERS.good[engine][width];
      assert.equal(rec.engine, engine);
      const r = judge(rec);
      assert.equal(r.ok, true, r.lines.join("\n"));
      assert.ok(r.lines.includes(`ok  the view is ${width} ${size.width} x ${size.height} (the top window is ${size.width} px wide)`));
      assert.ok(r.lines.some((l) => l.startsWith("ok  the typed words sign the shell in, the layer closes and the new frame answers signed in, way words")));
      assert.ok(r.lines.some((l) => l.startsWith("ok  the 12 words typed while the app calls focus() every 20 ms: the shell holds all of them, the app none")));
    });
  }
}

test("the WebKit good runs are the Mac's own WebKit, not Playwright's", () => {
  for (const width of Object.keys(WIDTHS)) {
    assert.match(ANSWERS.good.webkit[width].browser, /system WebKit/);
    assert.doesNotMatch(ANSWERS.good.webkit[width].browser, /Playwright/);
  }
});

test("a run whose top window is not the width it names, or names no known width, fails", () => {
  const cases = {
    "the phone run read 800 px": (a) => (a.view.inner = 800),
    "an unknown width": (a) => (a.view.name = "tablet"),
    "no width": (a) => delete a.view,
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(ANSWERS.good.webkit.phone);
    change(a);
    const r = judge(a);
    assert.equal(r.ok, false, name);
    assert.match(r.lines[0], /^BAD the view is /, name);
  }
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

const GOOD = ANSWERS.good.chromium.desktop;

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
  for (const m of way.messages) {
    if (m.data?.type === "state" && m.data.state?.way === "words") m.data.state.way = "passkey";
    if (m.data?.result?.way === "words") m.data.result.way = "passkey";
  }
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
  a.steps.words.top.layerHidden = false;
  assert.equal(judge(a).ok, false);
});

const answerTo = (rec, id) => rec.messages.find((m) => m.data?.id === id && m.data.ok === true);

test("the shell reloaded while signed in: a frame reading signed out, another way or code_saved false, the layer open, or no reload fails", () => {
  const cases = {
    "signed out": (a) => (answerTo(a, a.steps.reload.id).data.result.signed_in = false),
    "way passkey": (a) => (answerTo(a, a.steps.reload.id).data.result.way = "passkey"),
    "code_saved false": (a) => (answerTo(a, a.steps.reload.id).data.result.code_saved = false),
    "layer open": (a) => (a.steps.reload.top.layerHidden = false),
    "no reload": (a) => delete a.steps.reload,
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(GOOD);
    change(a);
    assert.equal(judge(a).ok, false, name);
  }
});

test("with the status deleted raw, a frame answering a way or code_saved true fails", () => {
  for (const [k, v] of [["way", "words"], ["code_saved", true]]) {
    const a = clone(GOOD);
    answerTo(a, a.steps.statusGone.id).data.result[k] = v;
    assert.equal(judge(a).ok, false, k);
  }
});

test("the backfill: a frame still without its way fails; the full state in an event within EVENT_MS of the answer passes, a later one fails", () => {
  const full = clone(answerTo(GOOD, GOOD.steps.reload.id).data.result);
  const strip = () => {
    const a = clone(GOOD);
    const b = answerTo(a, a.steps.backfill.id);
    delete b.data.result.way;
    b.data.result.code_saved = false;
    a.messages = a.messages.filter((m) => !(m.t >= b.t && m.data?.type === "state" && !m.data.id && m.data.state?.way === "words"));
    return { a, b };
  };
  const none = strip();
  assert.equal(judge(none.a).ok, false);
  for (const [ms, ok] of [[500, true], [EVENT_MS + 1, false]]) {
    const { a, b } = strip();
    a.messages.push({ t: b.t + ms, data: { v: 1, type: "state", state: clone(full) } });
    a.messages.sort((x, y) => x.t - y.t);
    const r = judge(a);
    assert.equal(r.ok, ok, `${ms} ms\n${r.lines.join("\n")}`);
  }
});

test("the review's fixes, each undone in the good run: FAIL", () => {
  const ref = (a, id) => answerTo(a, id) ?? a.messages.find((m) => m.data?.id === id);
  const cases = {
    "the app got typed characters": (a) => (a.steps.wordsIn.typed.appChars = 3),
    "the shell's field lacks the words": (a) => (a.steps.wordsIn.typed.shellHasWords = false),
    "the frame kept under the open layer": (a) => (a.steps.wordsIn.layer.frames = 1),
    "signin.open refused": (a) => (ref(a, a.steps.wordsIn.openId).data = { v: 1, id: a.steps.wordsIn.openId, ok: false, error: { code: "not_allowed" } }),
    "the layer shown at open": (a) => (a.steps.open.top.layerHidden = false),
    "a sandbox with allow-top-navigation": (a) => (a.steps.open.attrs.sandbox += " allow-top-navigation"),
    "no sandbox": (a) => (a.steps.open.attrs.sandbox = null),
    "an allow attribute": (a) => (a.steps.open.attrs.allow = ""),
    "the top moved by the frame": (a) => (a.steps.topNav.href = "https://example.com/"),
    "nav not followed": (a) => (a.steps.nav.after = a.steps.nav.after.replace("holders", "trades")),
    "nav to another host answered ok": (a) => (ref(a, a.steps.nav.evilId).data = { v: 1, id: a.steps.nav.evilId, ok: true, result: {} }),
    "nav made a new frame": (a) => (a.steps.nav.frames = 2),
    "reload refused": (a) => (ref(a, a.steps.reload.reloadId).data = { v: 1, id: a.steps.reload.reloadId, ok: false, error: { code: "not_allowed" } }),
    "the reloaded frame at the old path": (a) => (a.steps.reload.frameHref = `https://confidential.unrealized.trade${START}`),
  };
  for (const [name, change] of Object.entries(cases)) {
    const a = clone(GOOD);
    change(a);
    assert.equal(judge(a).ok, false, name);
  }
});

for (const engine of ["webkit", "chromium"]) {
  test(`recorded bad run: this card's build before the review's fixes (ea785a4) on ${engine}: FAIL, the layer over the terminal signed out and signin.open, nav and reload refused`, () => {
    const r = judge(ANSWERS.prefix[engine]);
    assert.equal(r.ok, false);
    const b = bad(r).join("\n");
    assert.match(b, /^BAD signed out, the layer is hidden and the terminal shows \(signed-out, layer shown/m);
    assert.match(b, /^BAD signin\.open words: answered pending/m);
    assert.match(b, /^BAD nav /m);
    assert.match(b, /^BAD reload: /m);
  });
}

test("recorded bad run: ea785a4 on Chromium: the app takes the typed words", () => {
  const r = judge(ANSWERS.prefix.chromium);
  assert.ok(ANSWERS.prefix.chromium.steps.wordsIn.typed.appChars > 0);
  assert.ok(bad(r).some((l) => /^BAD the 12 words typed while the app calls focus\(\) every 20 ms: the shell holds all of them, the app none \(shell not all, app [1-9]\d* characters\)$/.test(l)), r.lines.join("\n"));
});
