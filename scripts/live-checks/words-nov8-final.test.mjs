// node --test scripts/live-checks/words-nov8-final.test.mjs: the live check's verdict replays recorded answers
// (words-nov8-final.answers.json), each read on 2026-11-08 by words-nov8-final.mjs collect():
//   good: this card's checkout (--local): the terminal's fresh build holds the 18 kept words as final entries, the signing
//         page's committed bundle holds the 18 held and withdraw texts and writes data-draft-copy only through its key
//         helper, the two key sets naming only the unpicked words: PASS;
//   bad:  SIGN_HOST and APP_HOST as deployed before this card, read over https: the kept words are drafts there: FAIL.
// Planted from the good answer: one host's script lost a marker, a script the host did not answer, a page naming no script,
// a host this check does not know, no host at all. The markers themselves are run over the signing page's own bundle
// (the committed public/app.js) and over minified snippets in the shapes the terminal's build writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { APP_WORDS, appFinal, found, judge, KEPT, MARKERS, NOT_SHIPPED, scriptsOf, signMarks } from "./words-nov8-final.mjs";
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
  assert.equal(MARKERS.app.length, 18);
  assert.equal(MARKERS.sign.length, 21);
});

test("recorded bad answer: the hosts before this card draw the kept words as drafts: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  const b = bad(r.lines);
  assert.ok(b.some((l) => /^BAD sign: the scripts lack 3 of 21: no draft mark for a fixed word, the vault form's draft keys, the pool form's draft keys$/.test(l)), r.lines.join("\n"));
  const app = b.find((l) => l.startsWith("BAD app: the scripts lack 17 of 18"));
  assert.ok(app, r.lines.join("\n"));
  for (const [id] of APP_WORDS.filter(([id]) => !NOT_SHIPPED.includes(id))) assert.ok(app.includes(`final ${id}`), id);
});

test("planted: one marker lost on either host fails, naming it", () => {
  const sign = mut((rec) => {
    rec.hosts.sign.js[0].found = rec.hosts.sign.js[0].found.filter((m) => m !== "no draft mark for a fixed word");
  });
  assert.equal(sign.ok, false);
  assert.ok(bad(sign.lines).some((l) => /^BAD sign: the scripts lack 1 of 21: no draft mark for a fixed word$/.test(l)), sign.lines.join("\n"));
  const app = mut((rec) => {
    rec.hosts.app.js[0].found = rec.hosts.app.js[0].found.filter((m) => m !== "final trade.proofReady");
  });
  assert.equal(app.ok, false);
  assert.ok(bad(app.lines).some((l) => /^BAD app: the scripts lack 1 of 18: final trade\.proofReady$/.test(l)), app.lines.join("\n"));
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
  assert.equal(appFinal("Proof ready", KEPT, `${def("dm", 1)};${call("dm", "Proof ready", KEPT)}`), true);
  assert.equal(appFinal("Proof ready", KEPT, `${def("dm", 1)};${call("dm", "Proof ready", KEPT)}`), true);
  assert.equal(appFinal("Proof ready", KEPT, `${def("dm", 0)};${call("dm", "Proof ready", KEPT)}`), false, "the helper makes drafts");
  assert.equal(appFinal("Proof ready", KEPT, `${def("dm", 1)};x={k:dm(\`Proof ready\`,\`card trade-box-pool: the chain's pool\`)}`), false, "no pick on its source");
  assert.equal(appFinal("Proof ready", KEPT, call("dm", "Proof ready", KEPT)), false, "no definition of the helper");
  assert.equal(appFinal("Proof ready", KEPT, `${def("dm", 1)};${call("dm", "Making proof", KEPT)}`), false, "another word");
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
