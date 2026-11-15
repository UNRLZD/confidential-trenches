// node --test scripts/live-checks/move-parts-show-as-one.test.mjs: the live check's verdict replays recorded answers
// (move-parts-show-as-one.answers.json), each read on 2026-11-15 by move-parts-show-as-one.mjs collect():
//   good: this card's terminal build (vite build), read through scripts/ci/bundle-checks.mjs buildFetch: the script is
//         the one its page pins and holds each mark: PASS;
//   bad:  APP_HOST as deployed before this card, read over https: its script pinned, holding not one mark: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn), a script the host did not answer, a script
// that is not the one its page pins or has no pin, no host read. And the marks on the build's own minified shapes, with
// the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf, sha384 } from "./move-parts-show-as-one.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "move-parts-show-as-one.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: this card's build holds every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(new Set(ANSWERS.good.app.js.flatMap((f) => f.found)), new Set(NAMES));
});

test("recorded bad answer: APP_HOST before this card holds none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  assert.deepEqual(bad(r.lines), [`BAD the scripts lack: ${NAMES.join("; ")}`], r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it", () => {
  for (const n of NAMES) {
    const r = mut((rec) => {
      for (const f of rec.app.js) f.found = f.found.filter((m) => m !== n);
    });
    assert.equal(r.ok, false, n);
    assert.deepEqual(bad(r.lines), [`BAD the scripts lack: ${n}`], r.lines.join("\n"));
  }
});

test("planted: a script the host did not answer, a page naming none, a page not answering, no host read", () => {
  assert.equal(mut((rec) => void (rec.app.js[0].status = 404)).ok, false);
  assert.equal(mut((rec) => void (rec.app.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.app.pageStatus = 503)).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails whatever marks it holds", () => {
  for (const pin of ["sha384-other", null]) {
    const r = mut((rec) => void (rec.app.js[0].integrity = pin));
    assert.equal(r.ok, false, String(pin));
    assert.deepEqual(bad(r.lines), [`BAD not the script its page pins: ${ANSWERS.good.app.js[0].url}`], r.lines.join("\n"));
  }
  assert.equal(ANSWERS.good.app.js[0].integrity, ANSWERS.good.app.js[0].sha384);
  assert.equal(ANSWERS.bad.app.js[0].integrity, ANSWERS.bad.app.js[0].sha384, "the deployed host pins its own script");
});

// the build's own minified shapes (vite build of this card, 15 Nov), any quote
const BUILT = [
  "function _g(e,t){let n=t.filter(t=>t.kind===`move`&&t.id.startsWith(`${e.id}/`));if(n.length===0)return e;",
  "var mg=new Set([`done`,`failed`,`refunded`]),hg=/^[1-9]\\d*$/,gg=e=>{};let r=[e,...n.filter(t=>hg.test(t.id.slice(e.id.length+1)))]",
  "o=i.some(e=>e.stage===`failed`)?`failed`:a(r)??a(i)??(i.some(e=>e.stage===`refunded`)?`refunded`:`done`)",
  "d=gg(r.map(e=>e.amount)),f=gg(r.map(e=>e.out))",
  "e.id===t?n=e:r.push(e)}}return n===null?null:_g(n,r)}",
  "if(t.kind===`move`){let r=_g(t,e??[]),i={from:r.from,to:r.to,amount:r.amount??null}",
].join(";");

test("the marks on the build's minified shapes, any quote; a near miss is no mark", () => {
  assert.deepEqual(marksIn(BUILT), NAMES);
  assert.deepEqual(marksIn(BUILT.replaceAll("`move`", '"move"').replaceAll("`failed`", "'failed'")), NAMES);
  // before this card: the first part alone (moveOp's return on the id, Activity's row of the op itself), legs by their
  // last slash, a stage of the first op's, a part regex that also takes /0, the amount of one part
  const near = [
    "if(e.id!==t||e.kind!==`move`)continue;return e}return null}",
    "if(t.kind===`move`){let r={from:t.from,to:t.to,amount:t.amount??null}",
    "let n=e.id.lastIndexOf(`/`);return n<0||!t.has(e.id.slice(0,n))",
    "hg=/^\\d+$/;n.filter(t=>hg.test(t.id.slice(e.id.length+1)))",
    "o=i.some(e=>e.stage===`failed`)?`failed`:a(r)??`done`",
    "d=gg(r.map(e=>e.amount))",
    "t.filter(t=>t.kind===`move`&&t.id.startsWith(e.id))",
  ].join(";");
  assert.deepEqual(marksIn(near), []);
});

test("the page's scripts: each script tag's src and its integrity; sha384 as an integrity attribute names it", () => {
  assert.deepEqual(scriptsOf('<script type="module" src="/a.js" integrity="sha384-x"></script><script>1</script><script src="/b.js"></script>'), [
    { src: "/a.js", integrity: "sha384-x" },
    { src: "/b.js", integrity: null },
  ]);
  assert.match(sha384("x"), /^sha384-[A-Za-z0-9+/]{64}$/);
});
