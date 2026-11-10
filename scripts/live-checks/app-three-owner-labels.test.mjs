// node --test scripts/live-checks/app-three-owner-labels.test.mjs: the live check's verdict replays recorded answers
// (app-three-owner-labels.answers.json), each read on 2026-11-10 by app-three-owner-labels.mjs collect():
//   good: this card's terminal build (vite build, read from disk): the page's script holds each of the owner's three labels
//         in its place: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script holds none of them: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn), a script the host did not answer, no script.
// And the marks themselves on minified shapes: each quote style a minifier may pick, and the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf } from "./app-three-owner-labels.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "app-three-owner-labels.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: the built page's script holds the three labels in their places: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.js.flatMap((f) => f.found)), new Set(NAMES));
});

test("recorded bad answer: APP_HOST before this card holds none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.ok(bad(r.lines).some((l) => l === `BAD the scripts lack: ${NAMES.join("; ")}`), r.lines.join("\n"));
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
  const all = [
    "txFailed:W(`Transaction failed`,`owner`)",
    '(0,U.jsx)(`span`,{className:"tag sell","data-failed":e.failed.reason??``})',
    "unavailable:Lg('Unavailable',`owner`)",
    "Object.freeze({quote_check_failed:`priceCheck`,venue_not_pinned:`unavailable`,no_table_fits:\"unavailable\"})",
    "s=i?.price!=null&&/[1-9]/.test(i.price)?gm(e.amount,i.price):null",
    '{"data-value":!0,"data-unread":e.value===null||void 0}',
  ].join(";");
  assert.deepEqual(marksIn(all), NAMES);
  // the words elsewhere, the codes mapped to another reason, the tag in another colour, a price read with no zero rule
  const near = [
    "refunded:W(`Refunded`,`owner`)",
    "`Transaction failed`",
    '{className:`tag warn`,"data-failed":x}',
    "notSent:Lg(`Not sent`,`x`),`Unavailable`",
    "{venue_not_pinned:`priceCheck`,no_table_fits:null}",
    "s=i?.price!=null?gm(e.amount,i.price):null",
    '{"data-value":!0}',
  ].join(";");
  assert.deepEqual(marksIn(near), []);
});

test("the page's scripts: each script tag's src", () => {
  const html = '<link rel="stylesheet" href="/assets/a.css"><script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script>';
  assert.deepEqual(scriptsOf(html), ["/assets/a.js"]);
});
