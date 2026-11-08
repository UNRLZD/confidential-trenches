// node --test scripts/live-checks/app-token-lower-panel.test.mjs: the live check's verdict replays recorded answers
// (app-token-lower-panel.answers.json), each read on 2026-11-08 by app-token-lower-panel.mjs collect():
//   good: HELPER_HOST's holders read for the top Trending mint (200, its total, the holders key's 20 rows) and this card's
//         terminal build (vite build, read from disk), whose script and stylesheet hold the lower panel and About: PASS;
//   bad:  the same helper read and APP_HOST as deployed before this card, read over https: its script and stylesheet
//         hold none of them: FAIL.
// Planted from the good answer: Jupiter's fallback (no rows, its total) passes; no total, a total of 0, a 404, a
// top share over all, rows under Jupiter's name, rows not of the shape, over 20 rows, a script without the holders
// read, a stylesheet the host did not answer: each fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetsOf, CSS_MARKERS, holdersFacts, JS_MARKERS, judge } from "./app-token-lower-panel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-token-lower-panel.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the holders total for the mint and the built page's lower panel: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(ANSWERS.good.holders.total > 0);
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds no lower panel: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => l === `BAD the scripts lack the lower panel: ${JS_MARKERS.join(", ")}`), r.lines.join("\n"));
  assert.ok(b.some((l) => l === `BAD the stylesheets lack the lower panel's rules: ${CSS_MARKERS.join(", ")}`), r.lines.join("\n"));
});

test("planted: Jupiter's fallback (no rows, its count) passes", () => {
  const r = mut((rec) => Object.assign(rec.holders, { src: "jupiter", rows: 0, rowsOk: true, top_bps: 1627 }));
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("planted: no total, a total of 0, a 404, a top share over all, rows under Jupiter's name, bad rows, over 20 rows: each fails", () => {
  const cases = {
    "no total": (h) => (h.total = null),
    "a total of 0": (h) => (h.total = 0),
    "a fraction": (h) => (h.total = 1.5),
    "a 404": (h) => (h.status = 404),
    "top over all": (h) => (h.top_bps = 10_001),
    "jupiter with rows": (h) => (h.src = "jupiter"),
    "chain with no rows": (h) => (h.rows = 0),
    "rows not of the shape": (h) => (h.rowsOk = false),
    "over 20 rows": (h) => (h.rows = 21),
    "no source": (h) => (h.src = null),
  };
  for (const [name, f] of Object.entries(cases)) {
    const r = mut((rec) => f(rec.holders));
    assert.equal(r.ok, false, name);
  }
});

test("planted: a script without the holders read, or a stylesheet the host did not answer, fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "/v1/market/holders");
  });
  assert.equal(js.ok, false);
  assert.ok(bad(js.lines).some((l) => /the scripts lack the lower panel: \/v1\/market\/holders$/.test(l)), js.lines.join("\n"));
  const miss = mut((rec) => {
    rec.css[0].status = 404;
  });
  assert.equal(miss.ok, false);
});

test("the holders answer's facts: counted rows, each checked; a body not of the shape has none", () => {
  const body = { holders: [{ addr: "A", amt: "10", bps: 5 }, { addr: "B", amt: "1", bps: null }], total: 9, top_bps: 5, src: "chain", as_of_ms: 1 };
  assert.deepEqual(holdersFacts(200, body), { status: 200, total: 9, top_bps: 5, src: "chain", rows: 2, rowsOk: true });
  assert.equal(holdersFacts(200, { ...body, holders: [{ addr: "A", amt: "-1", bps: 5 }] }).rowsOk, false);
  assert.deepEqual(holdersFacts(404, { error: { code: "not_found" } }), { status: 404, total: null, top_bps: null, src: null, rows: null, rowsOk: false });
});

test("the page's assets: its script and stylesheet tags", () => {
  const html = '<script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(assetsOf(html), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
