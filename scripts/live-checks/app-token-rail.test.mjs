// node --test scripts/live-checks/app-token-rail.test.mjs: the live check's verdict replays recorded answers
// (app-token-rail.answers.json), each read on 2026-11-18 by app-token-rail.mjs collect():
//   good: HELPER_HOST's lists read (200, Solana, Trending rows traded in the hour, New rows) and this card's terminal
//         build (vite build, read from disk and drawn at APP_HOST's name in the stand-in shell), whose script and
//         stylesheet hold the rail and its width modes and whose rail is drawn full at 1440: PASS;
//   bad:  the same helper read and APP_HOST as deployed before card app-token-rail-r5-fit, read over https and drawn in
//         SIGN_HOST's shell: its files hold the rail, but its rail is slim at 1440, where the full one fits: FAIL.
// Planted from the good answer: a 503, another chain, an empty Trending or New list, a script without the expand
// button, a stylesheet without the hidden mode, a stylesheet the host did not answer, a slim, missing or headless rail
// or a page not drawn at 1440: each fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetsOf, CSS_MARKERS, JS_MARKERS, judge, listsFacts } from "./app-token-rail.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-token-rail.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the lists the rail draws and the built page's rail, full at 1440: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(ANSWERS.good.drawn, { state: "ready", mode: "full", width: 340, head: true });
  assert.ok(ANSWERS.good.lists.trending > 0 && ANSWERS.good.lists.new > 0);
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card draws the slim rail at 1440: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.equal(ANSWERS.bad.drawn.mode, "slim");
  assert.ok(b.includes(`BAD at 1440: the rail is slim (${ANSWERS.bad.drawn.width} layout px, no head); want the full rail (340 with its head), as R5 draws it at 1440`), r.lines.join("\n"));
  // its files hold the rail and the slim rule at the screen's 1500, not at the page box's 1527
  assert.deepEqual(b.filter((l) => !l.startsWith("BAD at 1440")), ["BAD the stylesheets lack the rail's rules: 1526.98px"], r.lines.join("\n"));
});

test("planted: a slim, missing or headless rail, or a page not drawn, at 1440: each fails", () => {
  const cases = {
    slim: (d) => Object.assign(d, { mode: "slim", width: 78, head: false }),
    "slim opened": (d) => (d.mode = "slim"),
    none: (d) => Object.assign(d, { mode: "none", width: null, head: false }),
    "no head": (d) => (d.head = false),
    "a narrower column": (d) => (d.width = 300),
    "not read": (d) => Object.assign(d, { mode: null, width: null, head: false, state: null }),
    "an error page": (d) => (d.state = "error"),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(mut((rec) => f(rec.drawn)).ok, false, name);
  assert.equal(mut((rec) => delete rec.drawn).ok, false, "no drawn read");
});

test("planted: a 503, another chain, an empty Trending or New list: each fails", () => {
  const cases = {
    "a 503": (l) => (l.status = 503),
    "another chain": (l) => (l.chain = "base"),
    "no Trending row": (l) => (l.trending = 0),
    "no Trending list": (l) => (l.trending = null),
    "no New row": (l) => (l.new = 0),
    "no New list": (l) => (l.new = null),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(mut((rec) => f(rec.lists)).ok, false, name);
});

test("planted: a script without the expand button, a stylesheet without the hidden mode or not answered: each fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "rail-expand");
  });
  assert.equal(js.ok, false);
  assert.ok(bad(js.lines).some((l) => l === "BAD the scripts lack the rail: rail-expand"), js.lines.join("\n"));
  const css = mut((rec) => {
    for (const f of rec.css) f.found = f.found.filter((m) => m !== "1179.98px");
  });
  assert.equal(css.ok, false);
  assert.ok(bad(css.lines).some((l) => l === "BAD the stylesheets lack the rail's rules: 1179.98px"), css.lines.join("\n"));
  assert.equal(mut((rec) => (rec.css[0].status = 404)).ok, false);
  assert.equal(mut((rec) => (rec.css = [])).ok, false);
});

test("the lists answer's facts: Trending as Discover's column takes it (the 1h list, rows traded in the hour), New every row", () => {
  const row = (token, vol) => ({ token, symbol: token.toUpperCase(), vol_1h_usd: vol });
  const body = { chain: "solana", as_of_ms: 1, lists: { new: [row("a", null), { token: "", symbol: "X" }], trending: [row("t", "5")], trending_1h: [row("b", "10"), row("c", "0"), row("d", null)] } };
  assert.deepEqual(listsFacts(200, body), { status: 200, chain: "solana", trending: 1, new: 1 });
  assert.deepEqual(listsFacts(200, { ...body, lists: { new: [], trending: [row("t", "5")] } }), { status: 200, chain: "solana", trending: 1, new: 0 });
  assert.deepEqual(listsFacts(503, { error: "unavailable" }), { status: 503, chain: null, trending: null, new: null });
});

test("the page's assets: its script and stylesheet tags", () => {
  const html = '<script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(assetsOf(html), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
