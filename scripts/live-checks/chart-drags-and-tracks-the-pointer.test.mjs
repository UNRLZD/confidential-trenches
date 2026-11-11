// node --test scripts/live-checks/chart-drags-and-tracks-the-pointer.test.mjs: the live check's verdict replays recorded
// answers (chart-drags-and-tracks-the-pointer.answers.json), each read on 2026-11-11 by its collect():
//   good: this card's terminal build (vite build, read from disk): a script rescales the chart's events under the zoom
//         and publishes its view, and the .tm rule sets pointer-events none: PASS;
//   bad:  APP_HOST as deployed (release 116), read over https: no rescale, no view, the marks pointer-events auto: FAIL.
// Planted from the good answer: a script without the rescale, a .tm rule given its pointer back, a stylesheet the host
// did not answer. And the facts each file is read for, on minified text in each quote the minifier writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cssFacts, jsFacts, judge } from "./chart-drags-and-tracks-the-pointer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "chart-drags-and-tracks-the-pointer.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the build rescales the chart's events, publishes its view, the marks take no pointer: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad answer: APP_HOST before this card: FAIL on all three", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => l.startsWith("BAD no script rescales the chart's events")), r.lines.join("\n"));
  assert.ok(b.some((l) => l.startsWith("BAD no script publishes the chart's view")), r.lines.join("\n"));
  assert.ok(b.some((l) => l === "BAD the .tm rules set pointer-events auto: a mark takes the pointer from the chart"), r.lines.join("\n"));
});

test("planted: a script without the rescale, a mark given its pointer back, a stylesheet not answered: each fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.rescale = false;
  });
  assert.equal(js.ok, false);
  const css = mut((rec) => {
    rec.css[0].tm = [...rec.css[0].tm, "auto"];
  });
  assert.equal(css.ok, false);
  assert.ok(bad(css.lines).some((l) => l.includes("none, auto: a mark takes the pointer")), css.lines.join("\n"));
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
});

test("the facts: the event list in any quote, the view's write, the bare .tm rule only", () => {
  const list = (q) => ["mousedown", "mousemove", "mouseup", "mouseenter", "mouseleave", "click", "dblclick", "contextmenu", "wheel", "touchstart", "touchmove", "touchend", "touchcancel"].map((e) => `${q}${e}${q}`).join(",");
  for (const q of ["`", '"', "'"]) assert.equal(jsFacts(`const T=[${list(q)}];`).rescale, true, q);
  assert.equal(jsFacts("const T=[`mousedown`,`mouseup`];").rescale, false);
  assert.equal(jsFacts("e.dataset.view=x").view, true);
  assert.equal(jsFacts("e.dataset.views").view, false);
  assert.deepEqual(cssFacts(".tm-layer{pointer-events:none}.tm{cursor:default;pointer-events:none}.tm:after{pointer-events:none}").tm, ["none"]);
  assert.deepEqual(cssFacts("a{}.tm{pointer-events:auto}").tm, ["auto"]);
});
