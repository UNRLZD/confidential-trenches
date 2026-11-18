// node --test scripts/live-checks/evm-pool-spend-binds.test.mjs: card evm-pool-spend-binds's live check, replayed.
// evm-pool-spend-binds.answers.json holds three real runs from the Mac (`--record`), none edited:
// - good: `--local`, the SIGN_HOST build of card kit-rpc-client-takes-a-signal in SIGN_HOST's place: PASS;
// - bad_live_before: SIGN_HOST as served before this card (release 146: a fee seat that does not connect is asked again
//   inside the seat): FAIL;
// - bad_live_no_signal: SIGN_HOST as served before card kit-rpc-client-takes-a-signal (its seat drops the walk's
//   signal, so the walk's cut ends the wait and leaves the request open): FAIL.
// And plants on this tree's own build: each part changed fails that part alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { signBuilt } from "../signpage-built.mjs";
import { judge, pageFacts } from "./evm-pool-spend-binds.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-spend-binds.answers.json", import.meta.url), "utf8"));

test("the recorded good run passes: this card's build", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(A.good.from, "local build");
});

test("the recorded bad run fails: SIGN_HOST before this card asks a seat that does not connect again", () => {
  const v = judge(A.bad_live_before);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_before.from, "https://confidential.unrealized.trade");
  assert.equal(A.bad_live_before.page.seat, false);
});

test("the recorded bad run fails: SIGN_HOST before card kit-rpc-client-takes-a-signal hands its seat no signal", () => {
  const v = judge(A.bad_live_no_signal);
  assert.equal(v.verdict, "FAIL");
  assert.equal(A.bad_live_no_signal.from, "https://confidential.unrealized.trade");
  assert.equal(A.bad_live_no_signal.page.seat, false);
});

test("each part missing from the good run fails it", () => {
  for (const [k, v] of [["seat", false], ["uses", 1], ["uses", 3]]) {
    const a = structuredClone(A.good);
    a.page[k] = v;
    assert.equal(judge(a).verdict, "FAIL", `${k} ${v}`);
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
  assert.ok(js.match(from) !== null, `planted: ${from} is in the build`);
  return pageFacts(index, js.replace(from, to));
};

test("this tree's build as it is: the seat found once and used twice", () => {
  const f = pageFacts(index, js);
  assert.equal(f.seat, true);
  assert.equal(f.uses, 2);
});

test("planted on this tree's build: a seat that asks again, or a walk read without it, fails", () => {
  // the no-connection fault asked again like a throttle: no seat
  assert.equal(planted(/&&([\w$]+)\.fault===`network`\?/, (_m, e) => `&&${e}.fault===\`http_429\`?`).seat, false);
  // card kit-rpc-client-takes-a-signal: the seat that drops the call's signal (three arguments taken, two passed on), and
  // the seat as it was before it (two taken, two passed): no seat either way
  assert.equal(planted(/return await ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+)\)\}catch\(([\w$]+)\)\{throw \5\?\.name===`SolanaRpcTransportError`/, (m, e, t, n, r) => m.replace(`${e}(${t},${n},${r})`, `${e}(${t},${n})`)).seat, false);
  assert.equal(planted(/async\(([\w$]+),([\w$]+),([\w$]+)\)=>\{try\{return await ([\w$]+)\(\1,\2,\3\)\}catch/, (_m, t, n, _r, e) => `async(${t},${n})=>{try{return await ${e}(${t},${n})}catch`).seat, false);
  // the chain fee read on the bare seat: used once
  assert.equal(planted(/\(e,t\)=>Promise\.all\(([\w$]+)\.map\(([\w$]+)=>([\w$]+)\(([\w$]+)\(e\),/, (_m, o, r, v) => `(e,t)=>Promise.all(${o}.map(${r}=>${v}(e,`).uses, 1);
});
