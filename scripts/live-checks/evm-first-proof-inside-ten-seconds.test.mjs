// node --test scripts/live-checks/evm-first-proof-inside-ten-seconds.test.mjs: card evm-first-proof-inside-ten-seconds's
// live check, replayed. evm-first-proof-inside-ten-seconds.answers.json holds two real runs from the Mac (`--record`),
// none edited:
// - good: `--local`, this card's SIGN_HOST build in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (its landing's pass on the pass pool, no history read before
//   the landing): FAIL.
// And plants on this tree's own build: each part's code changed back to its shape before this card, or a second landing
// pass asked some other way, FAILs that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./evm-first-proof-inside-ten-seconds.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-first-proof-inside-ten-seconds.answers.json", import.meta.url), "utf8"));
const PARTS = ["landed", "proofs", "lanes", "warm", "wait"];

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card, every part", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  for (const k of PARTS) assert.equal(A.bad_live_before.page[k], false, k);
});

test("each part missing from the good run fails it", () => {
  for (const k of PARTS) {
    const a = structuredClone(A.good);
    a.page[k] = false;
    assert.equal(judge(a).verdict, "FAIL", k);
  }
  const a = structuredClone(A.good);
  a.page.pin = "sha384-other";
  assert.equal(judge(a).verdict, "FAIL", "an /app.js its index does not pin");
});

const dir = signBuilt();
const index = readFileSync(path.join(dir, "index.html"), "utf8");
const js = readFileSync(path.join(dir, "public/app.js"), "utf8");
/** The build with `from` replaced by `to` (once; it must be there): the parts judged on it. */
const planted = (from, to) => {
  const at = js.match(from);
  assert.ok(at !== null, `planted: ${from} is in the build`);
  return pageFacts(index, js.replace(from, to));
};
const off = (facts) => PARTS.filter((k) => facts[k] !== true);

test("this tree's build as it is: every part found", () => {
  assert.deepEqual(off(pageFacts(index, js)), []);
});

test("planted on this tree's build: each part back to its shape before this card fails that part alone", () => {
  // a landing's pass asked as any other pass (`landed:()=>void F(t)`)
  assert.deepEqual(off(planted(/landed:\(\)=>\{([\w$]+)\.has\(([\w$]+)\)\|\|\(\1\.add\(\2\),queueMicrotask\(\(\)=>\{\1\.delete\(\2\),([\w$]+)\(\2,!0\)\}\)\)\}/, (_m, _r, t, f) => `landed:()=>void ${f}(${t})`)), ["landed", "proofs"]);
  // the queue handed no landing signal
  assert.deepEqual(off(planted(/\.queue\.refresh\(([\w$]+)\?([\w$]+)\.landing\?\.\(\):void 0\)/, ".queue.refresh()")), ["proofs"]);
  // a second refresh with a signal, beside the landing's
  assert.deepEqual(off(planted(/\.queue\.refresh\(\)/, ".queue.refresh(void 0)")), ["proofs"]);
  // the routed pool's trees on the deposit's pool for every signal
  assert.deepEqual(off(planted(/trees:\(([\w$]+),([\w$]+),([\w$]+)\)=>\(([\w$]+)\(\2\)\?([\w$]+):([\w$]+)\)\.trees/, (_m, a, b, c, _f, l) => `trees:(${a},${b},${c})=>(${l}).trees`)), ["lanes"]);
  // the history read on the deposit's own sync (its trade pair), not the pass sync
  assert.deepEqual(off(planted(/([\w$]+)\.passSync\.events\(([\w$]+)\.signal\)\.then\(/, (_m, t, s) => `${t}.sync.events(${s}.signal).then(`)), ["warm", "wait"]);
  // evmPoolOf that never starts it
  assert.deepEqual(off(planted(/evmPoolOf:([\w$]+)=>\(([\w$]+)=>\2===null\?null:\(([\w$]+)\(\1\),/, (_m, e, t) => `evmPoolOf:${e}=>(${t}=>${t}===null?null:(void 0,`)), ["warm"]);
  // the deposit's round not behind the wait
  assert.deepEqual(off(planted(/:\(([\w$]+)=>async ([\w$]+)=>\(await ([\w$]+)\(([\w$]+),\2\),\1\(\2\)\)\)\(/, (_m, t, n) => `:(${t}=>async ${n}=>${t}(${n}))(`)), ["wait"]);
  // the bound gone
  assert.deepEqual(off(planted(/\.evmWarmWaitMs\?\?2e4/, ".evmWarmWaitMs??1/0")), ["wait"]);
});

// The mainnet copies this build was measured on (packages/signpage/scripts/pool-fork-evm-carry-withdraw.mjs, three per
// chain, each with its book to replay offline): every step held, the first leaf's proof ready inside 10 s of its block,
// at most 80 requests per pool host in any 10 s from 10 s before that block to the proof, and no log read from the pool's
// deploy block among them.
const RUNS = path.join(path.dirname(new URL(import.meta.url).pathname), "../../packages/signpage/scripts/evm-mainnet-copy-runs");
const COPIES = ["base-11", "base-12", "base-13", "robinhood-11", "robinhood-12", "robinhood-13"].map((n) => `first-proof-${n}.json`);
test("the recorded mainnet copies: ready inside 10 s, each pool host at most 80 requests per 10 s, no deploy-block log read", () => {
  for (const f of COPIES) {
    const r = JSON.parse(readFileSync(path.join(RUNS, f), "utf8"));
    assert.deepEqual(r.failures, [], f);
    assert.equal(r.run.dirty, false, `${f}: a clean tree`);
    const s = r.steps.find((x) => x.name === "first leaf: ready inside 10 s, each pool host inside its window");
    assert.ok(s?.ok === true, f);
    assert.ok(s.readyMsAfterDeposit <= 10_000, `${f}: ready ${s.readyMsAfterDeposit} ms`);
    assert.ok(s.hostWindowBound === 80 && s.hostWindowMost <= 80, `${f}: ${s.hostWindowMost} per host`);
    assert.equal(s.deployPages, 0, f);
  }
});
