// node --test scripts/live-checks/app-unavailable-before-the-tap.test.mjs: the live check's verdict replays recorded
// answers (app-unavailable-before-the-tap.answers.json), each read on 2026-11-19 by app-unavailable-before-the-tap.mjs
// collect():
//   good: this card's terminal build (vite build, read from disk): the page's script holds the dry's rule and the four
//         codes mapped to Unavailable: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script maps three codes for the tap only, with no
//         rule for the dry and no below_reference: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn), a script the host did not answer, no script.
// And the marks themselves on minified shapes: each quote style a minifier may pick, and the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf } from "./app-unavailable-before-the-tap.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-unavailable-before-the-tap.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's script holds the dry's rule and its four codes: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(NAMES));
});

test("recorded bad answer: APP_HOST before this card has no rule for the dry and no below_reference: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => l === "BAD the scripts lack: the dry's Unavailable before the tap; below_reference is Unavailable"), r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it", () => {
  for (const n of NAMES) {
    const r = mut((rec) => {
      for (const f of rec.js) f.found = f.found.filter((m) => m !== n);
    });
    assert.equal(r.ok, false, n);
    assert.ok(bad(r.lines).some((l) => l === `BAD the scripts lack: ${n}`), r.lines.join("\n"));
  }
});

test("planted: a script the host did not answer, or a page naming no script, fails", () => {
  const miss = mut((rec) => {
    rec.js[0].status = 404;
  });
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /script\(s\) named by the page, each answering 200/.test(l)), miss.lines.join("\n"));
  const none = mut((rec) => {
    rec.js = [];
  });
  assert.equal(none.ok, false);
});

test("the marks on minified shapes: any quote and name; a near miss is no mark", () => {
  // the shapes as the 19 Nov build holds them (apps/terminal/dist), with the other quotes a minifier may pick
  const all = [
    "zh=e=>!e.ok&&Lh(e.error.code)===`unavailable`",
    "Object.freeze({quote_check_failed:`priceCheck`,venue_not_pinned:`unavailable`,no_table_fits:\"unavailable\",venue_not_built:'unavailable',below_reference:`unavailable`})",
  ].join(";");
  assert.deepEqual(marksIn(all), NAMES);
  // the tap's own rule (an ended phase's code), a dry's other reason, the codes mapped to another reason
  const near = [
    "e.k===`ended`&&e.stage===`refused`&&Lh(e.code)===`unavailable`",
    "!e.ok&&Lh(e.error.code)===`priceCheck`",
    "{venue_not_pinned:`priceCheck`,no_table_fits:null,venue_not_built:`failed`,below_reference:`priceCheck`}",
  ].join(";");
  assert.deepEqual(marksIn(near), []);
});

test("the page's scripts: each script tag's src", () => {
  const html = '<link rel="stylesheet" href="/assets/a.css"><script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script>';
  assert.deepEqual(scriptsOf(html), ["/assets/a.js"]);
});
