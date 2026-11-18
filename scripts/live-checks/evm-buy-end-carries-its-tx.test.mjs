// node --test scripts/live-checks/evm-buy-end-carries-its-tx.test.mjs: the live check's verdict replays recorded answers
// (evm-buy-end-carries-its-tx.answers.json), each read on 2026-11-18 by evm-buy-end-carries-its-tx.mjs collect():
//   good: this card's two builds (the signing page's build-app.mjs bundle() and the terminal's vite build), read through
//         scripts/ci/bundle-checks.mjs buildFetch: each host's script is the one its page pins and holds each of its
//         marks: PASS;
//   bad:  SIGN_HOST and APP_HOST as deployed before this card, read over https: each script pinned, neither holds one
//         mark: FAIL.
// Planted from the good answer: a script that lost one mark (each in turn, on its host), a script the host did not
// answer, a script that is not the one its page pins or has no pin, a host read alone (its own deploy's run), no host
// at all. And the marks on the builds' own minified shapes, with the near misses they must refuse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, marksIn, NAMES, scriptsOf, sha384 } from "./evm-buy-end-carries-its-tx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "evm-buy-end-carries-its-tx.answers.json"), "utf8"));
const bad = (lines) => lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("recorded good answer: both builds hold every mark: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
  for (const h of ["sign", "app"]) assert.deepEqual(new Set(ANSWERS.good[h].js.flatMap((f) => f.found)), new Set(NAMES[h]), h);
});

test("recorded bad answer: the hosts before this card hold none of them: FAIL", () => {
  const r = judge(ANSWERS.bad);
  assert.equal(r.ok, false);
  for (const h of ["sign", "app"]) assert.ok(bad(r.lines).includes(`BAD ${h}: the scripts lack: ${NAMES[h].join("; ")}`), r.lines.join("\n"));
});

test("planted: a script without any one mark fails, naming it and its host", () => {
  for (const h of ["sign", "app"])
    for (const n of NAMES[h]) {
      const r = mut((rec) => {
        for (const f of rec[h].js) f.found = f.found.filter((m) => m !== n);
      });
      assert.equal(r.ok, false, n);
      assert.ok(bad(r.lines).includes(`BAD ${h}: the scripts lack: ${n}`), r.lines.join("\n"));
    }
});

test("planted: a script the host did not answer, a page naming none, no host read; one host alone is its own run", () => {
  const miss = mut((rec) => void (rec.app.js[0].status = 404));
  assert.equal(miss.ok, false);
  assert.ok(bad(miss.lines).some((l) => /^BAD app: 1 script\(s\) named by the page, each answering 200$/.test(l)), miss.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.sign.js = [])).ok, false);
  assert.equal(mut((rec) => void (rec.sign.pageStatus = 404)).ok, false);
  assert.equal(judge({ at: "x" }).ok, false);
  assert.equal(judge({ sign: ANSWERS.good.sign }).ok, true);
  assert.equal(judge({ app: ANSWERS.good.app }).ok, true);
  assert.equal(judge({ app: ANSWERS.bad.app }).ok, false);
  assert.equal(judge({ sign: ANSWERS.bad.sign }).ok, false);
});

test("planted: a script that is not the one its page pins, or has no pin, fails", () => {
  const off = mut((rec) => void (rec.sign.js[0].sha384 = "sha384-AAAA"));
  assert.equal(off.ok, false);
  assert.ok(bad(off.lines).includes("BAD sign: not the script its page pins: /app.js"), off.lines.join("\n"));
  assert.equal(mut((rec) => void (rec.app.js[0].integrity = null)).ok, false);
});

test("the page's scripts and their pins are read from its tags; sha384 is the integrity form", () => {
  assert.deepEqual(scriptsOf(`<script type="module" crossorigin src="/app.js" integrity="sha384-x"></script><script>1</script>`), [{ src: "/app.js", integrity: "sha384-x" }]);
  assert.deepEqual(scriptsOf(`<script src="/a.js"></script>`), [{ src: "/a.js", integrity: null }]);
  // the recorded good answer's scripts are each the one its page pins (recorded hashes compared with each other)
  for (const h of ["sign", "app"]) for (const f of ANSWERS.good[h].js) assert.equal(f.sha384, f.integrity, `${h} ${f.url}`);
  assert.match(sha384("a"), /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.notEqual(sha384("a"), sha384("b"));
});

// The marks on the builds' minified shapes (each copied from this card's build), and the near misses they must refuse.
const SIGN_TEXT = [
  "const told=n!==null&&t.length>0?{...p,txs:t.map(e=>({chain:e?.chain,hash:e?.hash}))}:null;",
  "late:e=>r?.progress(e.stage,e.txs),",
  "late:e=>r?.progress(e.stage,e.txs),",
  ",{...t.holding,state:`withdrawn`,route:c}).catch(()=>{});try{e.carry?.()}catch{}return{stage:`owed_back`,txs:s}}return null}",
  "await W1(e,d,{end:`reverted`}).catch(()=>{}),h(),{stage:`owed_back`,txs:m};",
  "n.some(e=>e===`owed_back`)?{stage:`owed_back`,txs:t}:n.some(e=>e===`refused`)?{stage:`refused`,txs:t}:",
  "function $re(e,t){let n=e!==`current`&&t===`owed_back`?`refused`:t;return n}",
  "Ee=(e,t)=>({...t,progress:(n,r)=>{t.progress(n,r),Oe.has(n)&&Zt(e)?.refresh()}}),",
  "Oe=new Set([`filled`,`part_filled`,`not_landed`,`owed_back`]),",
  "let m=e(n,r===null?null:{...r,progress:(e,t)=>(c(`swap`,{stage:e}),r.progress(e,t))});",
].join("\n");
const APP_TEXT = [
  "function GS(e,t,n,r,i){if(n===`sent`&&e.id===t&&US(e))return WS(e);let a=i?.[0]?.hash,o=KS(e,t,n,a,r);return a?HS(o,{t:`tx`,id:t,tx:a}):o}",
  "e.stage===`part_filled`?{k:`partial`,reason:null}:e.stage===`owed_back`?{k:`owedBack`,reason:null}:{k:`failed`,reason:Lh(e.code)}",
  "e.k===`ended`&&e.stage===`refused`&&e.id===t&&n===`owed_back`?{k:`ended`,id:t,at:e.at,stage:n}:!Dh(e)||e.id!==t",
  "ended`&&e.stage!==`part_filled`&&e.stage!==`owed_back`&&!Rh(e);",
].join("\n");

test("the marks read the builds' minified shapes", () => {
  assert.deepEqual(marksIn("sign", SIGN_TEXT), NAMES.sign);
  assert.deepEqual(marksIn("app", APP_TEXT), NAMES.app);
  // any of the three quotes
  assert.deepEqual(marksIn("sign", SIGN_TEXT.replaceAll("`", '"')), NAMES.sign);
  assert.deepEqual(marksIn("app", APP_TEXT.replaceAll("`", "'")), NAMES.app);
});

test("near misses: the shapes before this card, or one piece cut, are refused", () => {
  const without = (host, text, name) => assert.ok(!marksIn(host, text).includes(name), name);
  // a stage event with no txs, or txs passed through as given (no own fields)
  without("sign", SIGN_TEXT.replace("txs:t.map(e=>({chain:e?.chain,hash:e?.hash}))", "txs:t"), NAMES.sign[0]);
  // only one kind's late end carries its txs (the sale's was cut), or the late end posts the stage alone
  without("sign", SIGN_TEXT.replace("late:e=>r?.progress(e.stage,e.txs),", "late:e=>r?.progress(e.stage),"), NAMES.sign[1]);
  without("sign", SIGN_TEXT.replaceAll("late:e=>r?.progress(e.stage,e.txs)", "late:e=>r?.progress(e.stage)"), NAMES.sign[1]);
  // a Withdrawn end that says refused (the build before this card)
  without("sign", SIGN_TEXT.replace("catch{}return{stage:`owed_back`", "catch{}return{stage:`refused`"), NAMES.sign[2]);
  without("sign", SIGN_TEXT.replace("{end:`reverted`}).catch(()=>{}),h(),{stage:`owed_back`", "{end:`reverted`}).catch(()=>{}),h(),{stage:`refused`"), NAMES.sign[3]);
  // the legs' end reads a refusal first
  without("sign", SIGN_TEXT.replace("n.some(e=>e===`owed_back`)?{stage:`owed_back`,txs:t}:", ""), NAMES.sign[4]);
  // owed_back sent as is to every kit
  without("sign", SIGN_TEXT.replace("let n=e!==`current`&&t===`owed_back`?`refused`:t;", "let n=t;"), NAMES.sign[5]);
  // the wrappers between a kind and the api pass the stage alone (the review of 167d9deea), or the ends leave owed_back out
  without("sign", SIGN_TEXT.replace("progress:(n,r)=>{t.progress(n,r),", "progress:n=>{t.progress(n),"), NAMES.sign[6]);
  without("sign", SIGN_TEXT.replace("progress:(n,r)=>{t.progress(n,r),", "progress:(n,r)=>{t.progress(n),"), NAMES.sign[6]);
  without("sign", SIGN_TEXT.replace(",`not_landed`,`owed_back`])", ",`not_landed`])"), NAMES.sign[7]);
  without("sign", SIGN_TEXT.replace("progress:(e,t)=>(c(`swap`,{stage:e}),r.progress(e,t))", "progress:e=>(c(`swap`,{stage:e}),r.progress(e))"), NAMES.sign[8]);
  without("sign", SIGN_TEXT.replace("r.progress(e,t))", "r.progress(t,e))"), NAMES.sign[8]);
  // the app: the end's tx never reaches the route, owed_back not its own end, a late owed_back left as Failed, Retry
  // shown on owed back
  without("app", APP_TEXT.replace("let a=i?.[0]?.hash,o=KS(e,t,n,a,r);return a?HS(o,{t:`tx`,id:t,tx:a}):o", "return KS(e,t,n,void 0,r)"), NAMES.app[0]);
  without("app", APP_TEXT.replace("e.stage===`owed_back`?{k:`owedBack`,reason:null}:", ""), NAMES.app[1]);
  without("app", APP_TEXT.replace("e.k===`ended`&&e.stage===`refused`&&e.id===t&&n===`owed_back`?{k:`ended`,id:t,at:e.at,stage:n}:", ""), NAMES.app[2]);
  without("app", APP_TEXT.replace("&&e.id===t&&n===`owed_back`", "&&n===`owed_back`"), NAMES.app[2]);
  without("app", APP_TEXT.replace("&&e.stage!==`owed_back`", ""), NAMES.app[3]);
});
