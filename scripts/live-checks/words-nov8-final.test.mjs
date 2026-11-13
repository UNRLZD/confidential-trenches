// node --test scripts/live-checks/words-nov8-final.test.mjs: the live check's verdict replays recorded answers
// (words-nov8-final.answers.json), each read on 2026-11-13 by words-nov8-final.mjs collect():
//   good: this card's checkout (--local): the terminal's fresh build holds the 16 kept words as final entries and none of
//         the removed texts ("Proof ready", "Making proof"; 13 Nov 07:53Z: removed, the app names no proof), the signing
//         page's committed bundle holds the 18 held and withdraw texts and writes data-draft-copy only through its key
//         helper, the two key sets naming only the unpicked words: PASS;
//   bad:  a terminal build of main 4c1826a75 (--local --build), which still draws the two proof words: FAIL.
// Planted from the good answer: one host's script lost a marker, a script the host did not answer, a page naming no script,
// a host this check does not know, no host at all. The markers themselves are run over the signing page's own bundle
// (the committed public/app.js) and over minified snippets in the shapes the terminal's build writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_WORDS, appFinal, found, judge, KEPT, MARKERS, NOT_SHIPPED, REMOVED_TEXTS, removedIn, scriptsOf, signMarks } from "./words-nov8-final.mjs";
import { signBuilt } from "../signpage-built.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "words-nov8-final.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: every kept word final on both hosts: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const h of ["sign", "app"]) assert.deepEqual(new Set(ANSWERS.good.hosts[h].js.flatMap((f) => f.found)), new Set(MARKERS[h]));
  assert.equal(MARKERS.app.length, 16);
  assert.ok(ANSWERS.good.hosts.app.js.every((f) => Array.isArray(f.removed) && f.removed.length === 0));
  assert.equal(MARKERS.sign.length, 21);
});

test("recorded bad answer: main's build still draws the two proof words: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), ["BAD app: the scripts still hold the removed texts: Proof ready, Making proof"], r.lines.join("\n"));
  assert.deepEqual(ANSWERS.bad.hosts.app.js[0].removed, REMOVED_TEXTS);
});

test("planted: one removed text back in a script, or an answer that does not say, fails", () => {
  const one = mut((rec) => void (rec.hosts.app.js[0].removed = ["Making proof"]));
  assert.deepEqual(bad(one.lines), ["BAD app: the scripts still hold the removed text: Making proof"]);
  const second = mut((rec) => rec.hosts.app.js.push({ url: "/assets/b.js", status: 200, found: [], removed: ["Proof ready"] }));
  assert.equal(second.ok, false);
  assert.ok(bad(second.lines).some((l) => /still hold the removed text: Proof ready$/.test(l)), second.lines.join("\n"));
  const silent = mut((rec) => void delete rec.hosts.app.js[0].removed);
  assert.deepEqual(bad(silent.lines), ["BAD app: the answer does not say which removed texts each script holds"]);
});

test("the removed texts are read in a script's text, in any quoting", () => {
  assert.deepEqual(removedIn("x={a:`Proof ready`}"), ["Proof ready"]);
  assert.deepEqual(removedIn('y="Making proof";z=\'Proof ready\''), ["Proof ready", "Making proof"]);
  assert.deepEqual(removedIn("x={a:`Proof`,b:`ready`}"), []);
});

test("planted: one marker lost on either host fails, naming it", () => {
  const sign = mut((rec) => {
    rec.hosts.sign.js[0].found = rec.hosts.sign.js[0].found.filter((m) => m !== "no draft mark for a fixed word");
  });
  assert.equal(sign.ok, false);
  assert.ok(bad(sign.lines).some((l) => /^BAD sign: the scripts lack 1 of 21: no draft mark for a fixed word$/.test(l)), sign.lines.join("\n"));
  const app = mut((rec) => {
    rec.hosts.app.js[0].found = rec.hosts.app.js[0].found.filter((m) => m !== "final trade.poolBare");
  });
  assert.equal(app.ok, false);
  assert.ok(bad(app.lines).some((l) => /^BAD app: the scripts lack 1 of 16: final trade\.poolBare$/.test(l)), app.lines.join("\n"));
});

test("planted: a script the host did not answer, a page naming no script, an unknown host, no host: each fails", () => {
  assert.equal(mut((rec) => void (rec.hosts.app.js[0].status = 404)).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.sign.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.app.pageStatus = 500)).ok, false);
  assert.equal(mut((rec) => void (rec.hosts.other = rec.hosts.app)).ok, false);
  assert.equal(judge({ hosts: {} }).ok, false);
  assert.equal(judge(undefined).ok, false);
});

test("the signing page's own bundle: every marker, and a draft mark written for a fixed word is not one", () => {
  const js = readFileSync(path.join(signBuilt(), "public/app.js"), "utf8");
  assert.deepEqual(new Set(found("sign", js)), new Set(MARKERS.sign));
  // the build before this card: a fixed word, a choice between words, a bare name in an element's own write
  for (const old of ["c.dataset.draftCopy=`withdraw`,t.handoff||0", "t.dataset.refusal=n,t.dataset.draftCopy=n===`unread`?`busy`:`invalid-address`;", "u.dataset.draftCopy=`gas`;let n"]) {
    assert.equal(signMarks(`${js};${old}`).bare, false, old);
    assert.ok(!found("sign", `${js};${old}`).includes("no draft mark for a fixed word"), old);
  }
  assert.equal(signMarks("function Pj(e,t,n){n.has(t)?e.dataset.draftCopy=t:delete e.dataset.draftCopy}").bare, true);
  assert.equal(signMarks("nothing here").bare, false);
  // a key set with a kept word in it, or one missing an unpicked word, is not the set
  assert.ok(!found("sign", js.replace("`min`,`unmatched`", "`min`,`busy`")).includes("the vault form's draft keys"));
  assert.ok(!found("sign", js.replace(/new Set\(\[`to`,`amount`\]\)/g, "new Set([`to`])")).includes("the pool form's draft keys"));
});

test("the terminal's build: a kept word is final only with its pick and a helper that sets draft:!1", () => {
  const def = (n, d) => `${n}=(e,t)=>({text:e,source:t,draft:!${d}})`;
  const call = (n, text, pick) => `x={k:${n}(\`${text}\`,\`${pick}; drafted on card x\`)}`;
  assert.equal(appFinal("Pool", KEPT, `${def("dm", 1)};${call("dm", "Pool", KEPT)}`), true);
  assert.equal(appFinal("Pool", KEPT, `${def("dm", 0)};${call("dm", "Pool", KEPT)}`), false, "the helper makes drafts");
  assert.equal(appFinal("Pool", KEPT, `${def("dm", 1)};x={k:dm(\`Pool\`,\`card trade-box-pool: the chain's pool\`)}`), false, "no pick on its source");
  assert.equal(appFinal("Pool", KEPT, call("dm", "Pool", KEPT)), false, "no definition of the helper");
  assert.equal(appFinal("Pool", KEPT, `${def("dm", 1)};${call("dm", "Making proof", KEPT)}`), false, "another word");
  // a literal entry (the search placeholder)
  const lit = (d) => `O={placeholder:{text:\`Name, symbol or address\`,source:\`8 Nov 19:40Z, kept as drawn; from R5 P.dc("Name, symbol or address", "CN-10")\`,draft:!${d}}}`;
  assert.equal(appFinal("Name, symbol or address", "8 Nov 19:40Z, kept as drawn", lit(1)), true);
  assert.equal(appFinal("Name, symbol or address", "8 Nov 19:40Z, kept as drawn", lit(0)), false);
  // the sell box's word is in no script until a mount imports its screen; once it is there it must be final
  assert.equal(appFinal("Back to Cash", KEPT, "nothing", "positions.toPool"), true);
  assert.equal(appFinal("Back to Cash", KEPT, `${def("z", 0)};x={k:z(\`Back to Cash\`,\`card trade-box-pool\`)}`, "positions.toPool"), false);
  assert.equal(appFinal("Back to Cash", KEPT, "nothing", "trade.poolBare"), false);
});

test("the page's scripts: the src of each script tag", () => {
  assert.deepEqual(scriptsOf('<script type="module" crossorigin src="/assets/a.js" integrity="sha384-x"></script><script>inline()</script>'), ["/assets/a.js"]);
});
