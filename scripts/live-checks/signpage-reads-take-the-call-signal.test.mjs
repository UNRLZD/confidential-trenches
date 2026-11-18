// node --test scripts/live-checks/signpage-reads-take-the-call-signal.test.mjs: the live check replays its recorded
// answers (signpage-reads-take-the-call-signal.answers.json). good: this card's SIGN_HOST build: PASS. bad: SIGN_HOST as
// served before this card (main 30583519e's release): FAIL, every wrapper named. Planted on the good answer: another
// /app.js, no pin, each fact taken away: each FAIL. Planted in the bundle's own excerpt
// (signpage-reads-take-the-call-signal.excerpt.txt, cut from this card's public/app.js): each wrapper dropping the
// call's signal, or failing over after a stop, or a bound that no longer aborts: each FAIL on its own fact.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge } from "./signpage-reads-take-the-call-signal.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-reads-take-the-call-signal.answers.json", import.meta.url), "utf8"));
const KEYS = ["laned", "seat", "watch", "kept", "young", "switched", "routes", "trade", "gated", "decimals", "fill", "dry", "timed"];

test("recorded good answer: this card's build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded bad answer: SIGN_HOST before this card: FAIL, every wrapper named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.equal(v.lines.length, KEYS.length, v.lines.join("\n"));
});

test("planted on the good answer: each fact taken away FAILs alone", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD SIGN_HOST's served /app.js is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD SIGN_HOST's index.html pins no /app.js"]);
  for (const k of KEYS) {
    const v = judge({ ...g, [k]: false });
    assert.equal(v.ok, false, k);
    assert.equal(v.lines.length, 1, k);
  }
  assert.equal(judge(null).ok, false);
});

test("planted in the bundle's excerpt: each wrapper that drops the signal FAILs on its own fact", () => {
  const js = readFileSync(new URL("./signpage-reads-take-the-call-signal.excerpt.txt", import.meta.url), "utf8");
  const f = facts("", js);
  for (const k of KEYS) assert.equal(f[k], true, `the excerpt holds ${k}`);
  for (const [what, from, to, key] of [
    ["the attempt never hands the stop to the kit client", "retry:{deadlineMs:n,backoffMs:n}})(r,i,a)", "retry:{deadlineMs:n,backoffMs:n}})(r,i)", "laned"],
    ["the ask hands no stop to its attempt", "e-performance.now())),r,s,t)", "e-performance.now())),r,s,void 0)", "laned"],
    ["the call's own signal never joined (the reader's alone)", "iue(i===void 0?t.signal:t.signal===void 0?i:AbortSignal.any([t.signal,i]))", "iue(t.signal)", "laned"],
    ["the seat's first member asked without the signal", "r[l].fast(e,n,o).catch(", "r[l].fast(e,n).catch(", "seat"],
    ["the seat fails over after a stop", "||o?.aborted)throw t", ")throw t", "seat"],
    ["the seat's call drops its signal", "(e,t,n)=>a(e,t,new Set,n)", "(e,t,n)=>a(e,t,new Set)", "seat"],
    ["the watch's call drops the signal", "try{return await r(e,a,o)}", "try{return await r(e,a)}", "watch"],
    ["the watch's default call drops the signal", "r=(t,n,r)=>e(t,n,r))=>", "r=(t,n,r)=>e(t,n))=>", "watch"],
    ["a kept read asked without the signal", "e(r,i,a).then(", "e(r,i).then(", "kept"],
    ["a young read no leg shares asked without the signal", "return e(i,o,s);", "return e(i,o);", "young"],
    ["the switched pair drops the signal", "](r,i,a)))", "](r,i)))", "switched"],
    ["one helper route drops the signal", "Object.assign((e,n,r)=>t(e,n,r),", "Object.assign((e,n,r)=>t(e,n),", "routes"],
    ["the trade's watch drops the signal", "e(t,n,r).catch(", "e(t,n).catch(", "trade"],
    ["the positions gate hands no stop to its call", "e(r,i,a===void 0?n:AbortSignal.any([a,n]))", "e(r,i,a)", "gated"],
    ["the decimals read drops its signal", "`latest`],r.signal)", "`latest`])", "decimals"],
    ["the fill reader drops the call's own signal", "i(e,t,n===void 0?r:AbortSignal.any([n,r]))", "i(e,t,r)", "fill"],
    ["the preview's bound never aborts its reads", "g.abort(Error(`the preview's bound`)),", "", "dry"],
    ["the preview's reads carry no bound", "e(r,i,a===void 0?g.signal:AbortSignal.any([a,g.signal]))", "e(r,i,a)", "dry"],
    ["the timed slot read drops the signal", "e.rpcs[0](t,n,r).then(", "e.rpcs[0](t,n).then(", "timed"],
  ]) {
    const bad = js.replace(from, to);
    assert.notEqual(bad, js, what);
    const b = facts("", bad);
    assert.equal(b[key], false, what);
    for (const k of KEYS.filter((x) => x !== key)) assert.equal(b[k], true, `${what}: ${k} untouched`);
  }
});
