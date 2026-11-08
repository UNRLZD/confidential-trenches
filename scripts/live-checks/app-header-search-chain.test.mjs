// node --test scripts/live-checks/app-header-search-chain.test.mjs: the live check's verdict replays recorded answers
// (app-header-search-chain.answers.json), each read on 2026-11-08 by app-header-search-chain.mjs collect():
//   good: HELPER_HOST's lists read (200, Solana, 191 rows), its token read for the first listed mint (200 with that
//         mint's row) and this card's terminal build (vite build, read from disk), whose script and stylesheet hold the
//         search and its rules: PASS;
//   bad:  the same helper reads and APP_HOST as deployed before this card, read over https: its script and stylesheet
//         hold none of them: FAIL.
// Planted from the good answer: a 503, another chain, no row, a token read that 404s or answers another row, a script
// without the phone's button, a stylesheet without the narrow top bar's rule or not answered: each fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetsOf, CSS_MARKERS, JS_MARKERS, judge, listsFacts, tokenFacts } from "./app-header-search-chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-header-search-chain.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the lists the search searches, the token read and the built page's search: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(ANSWERS.good.lists.rows > 0 && ANSWERS.good.token.row === true);
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(JS_MARKERS));
  assert.deepEqual(new Set(ANSWERS.good.css.flatMap((f) => f.found)), new Set(CSS_MARKERS));
});

test("recorded bad answer: APP_HOST before this card holds no search: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => l === `BAD the scripts lack the search: ${JS_MARKERS.join(", ")}`), r.lines.join("\n"));
  assert.ok(b.some((l) => l === `BAD the stylesheets lack the search's rules: ${CSS_MARKERS.join(", ")}`), r.lines.join("\n"));
});

test("planted: a 503, another chain, no row, a token read that fails or answers another mint: each fails", () => {
  const cases = {
    "a 503": (rec) => (rec.lists.status = 503),
    "another chain": (rec) => (rec.lists.chain = "base"),
    "no row": (rec) => (rec.lists.rows = 0),
    "no Solana row": (rec) => (rec.lists.chains = []),
    "a token 404": (rec) => (rec.token.status = 404),
    "another row": (rec) => (rec.token.row = false),
    "another mint asked": (rec) => (rec.token.asked = "x"),
  };
  for (const [name, f] of Object.entries(cases)) assert.equal(mut(f).ok, false, name);
});

test("planted: a script without the phone's button, a stylesheet without the narrow rule or not answered: each fails", () => {
  const js = mut((rec) => {
    for (const f of rec.js) f.found = f.found.filter((m) => m !== "search-button-phone");
  });
  assert.equal(js.ok, false);
  assert.ok(bad(js.lines).some((l) => l === "BAD the scripts lack the search: search-button-phone"), js.lines.join("\n"));
  const css = mut((rec) => {
    for (const f of rec.css) f.found = f.found.filter((m) => m !== "1023.98px");
  });
  assert.equal(css.ok, false);
  assert.ok(bad(css.lines).some((l) => l === "BAD the stylesheets lack the search's rules: 1023.98px"), css.lines.join("\n"));
  assert.equal(mut((rec) => (rec.css[0].status = 404)).ok, false);
  assert.equal(mut((rec) => (rec.js = [])).ok, false);
});

test("the answers' facts: rows one per chain and token, their chains, the first Solana mint; a token row is the asked mint's", () => {
  const row = (chain, token) => ({ chain, token, symbol: token.toUpperCase() });
  const body = { chain: "solana", as_of_ms: 1, lists: { new: [row("solana", "a"), { token: "", symbol: "X" }], trending: [row("solana", "a"), row("base", "b"), row("solana", "c")] } };
  assert.deepEqual(listsFacts(200, body), { status: 200, chain: "solana", rows: 3, chains: ["base", "solana"], first: "a" });
  assert.deepEqual(listsFacts(503, { error: "x" }), { status: 503, chain: null, rows: 0, chains: [], first: null });
  assert.deepEqual(tokenFacts("a", 200, { row: row("solana", "a") }), { asked: "a", status: 200, row: true });
  assert.deepEqual(tokenFacts("a", 200, { row: row("solana", "b") }), { asked: "a", status: 200, row: false });
  assert.deepEqual(tokenFacts("a", 404, { error: { code: "not_found" } }), { asked: "a", status: 404, row: false });
});

test("the page's assets: its script and stylesheet tags", () => {
  const html = '<script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><link rel="stylesheet" crossorigin href="/assets/a.css">';
  assert.deepEqual(assetsOf(html), { js: ["/assets/a.js"], css: ["/assets/a.css"] });
});
