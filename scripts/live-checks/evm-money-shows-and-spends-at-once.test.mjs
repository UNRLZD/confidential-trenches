// Replays of live check evm-money-shows-and-spends-at-once: the recorded good answer (12 Nov 20:49Z: both mainnet pool
// pairs agreeing on a block 3 to 4 s old, with this branch's signing page build) passes; the recorded bad one (SIGN_HOST
// as deployed then, before the head rule) fails; and each rule alone on the good answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FRESH_S, judge, LAG_TRIES, POOL_RPCS } from "./evm-money-shows-and-spends-at-once.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-money-shows-and-spends-at-once.answers.json", import.meta.url), "utf8"));
const one = (f) => {
  const g = structuredClone(A.good);
  f(g);
  return judge(g);
};

test("the recorded good answer passes: both chains' newest agreed block seconds old, the finalized lag printed", () => {
  const r = judge(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  for (const chain of ["base", "robinhood"]) {
    assert.ok(r.lines.some((l) => new RegExp(`^ok {2}${chain}: the newest agreed block \\d+ is \\d+ s old, at most ${FRESH_S} s`).test(l)), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => new RegExp(`^-- {2}${chain}: the finalized block \\d+ is \\d+ s behind it`).test(l)), r.lines.join("\n"));
  }
});

test("the recorded bad answer (SIGN_HOST before the head rule) fails", () => {
  const r = judge(A.bad);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.lines.some((l) => /^BAD SIGN_HOST's note store writes EVM notes at the newest agreed block/.test(l)), r.lines.join("\n"));
});

test("the check's pool pairs are the page's own (MAINNET_POOL_RPCS), two operators each", () => {
  const src = readFileSync(new URL("../../packages/signpage/src/pool-testnet.ts", import.meta.url), "utf8");
  const m = /export const MAINNET_POOL_RPCS[^=]*=[^{]*\{([\s\S]*?)\n\}\);/.exec(src);
  assert.ok(m, "MAINNET_POOL_RPCS read");
  for (const chain of Object.keys(POOL_RPCS)) {
    const row = new RegExp(`${chain}: [^\\[]*\\[([^\\]]*)\\]`).exec(m[1]);
    assert.deepEqual([...row[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), [...POOL_RPCS[chain]], chain);
    assert.notEqual(new URL(POOL_RPCS[chain][0]).host.split(".").slice(-2).join("."), new URL(POOL_RPCS[chain][1]).host.split(".").slice(-2).join("."), `${chain}: two operators`);
  }
});

test("each rule alone on the good answer", () => {
  const block = (g, chain) => g.chains[chain].tries.at(-1);
  assert.equal(one((g) => (g.sign.guard = false)).verdict, "FAIL", "a store with no guard");
  assert.equal(one((g) => (g.sign.finalKey = false)).verdict, "FAIL", "a store with no finalized key");
  assert.equal(one((g) => (g.sign.sha384 = "sha384-other")).verdict, "FAIL", "a served script the index does not pin");
  assert.equal(one((g) => (g.chains.base.chainId[1] = { result: "0x1" })).verdict, "FAIL", "another chain");
  assert.equal(one((g) => (block(g, "base").byNumber[1].result.hash = `0x${"ee".repeat(32)}`)).verdict, "FAIL", "two blocks at one height on the last try");
  assert.equal(one((g) => (g.at = Number(g.at) + (FRESH_S + 5) * 1000)).verdict, "FAIL", "a newest agreed block older than the bound");
  assert.equal(one((g) => (block(g, "robinhood").newest[0] = { result: null })).verdict, "FAIL", "no newest block");
  // two blocks at one height on an earlier try, one on the last: a pass, the try named
  const again = one((g) => g.chains.base.tries.unshift({ ...structuredClone(block(g, "base")), byNumber: [block(g, "base").byNumber[0], { result: { ...block(g, "base").byNumber[1].result, hash: `0x${"ee".repeat(32)}` } }] }));
  assert.equal(again.verdict, "PASS", again.lines.join("\n"));
  assert.ok(again.lines.some((l) => new RegExp(`^ok {2}base: .* hold one block at \\d+ .*, on try 2 of ${LAG_TRIES}`).test(l)));
  // no answer: never a pass, never a fail
  assert.equal(one((g) => (g.chains.robinhood.chainId[0] = { noAnswer: "x HTTP 429: 429 Too Many Requests" })).verdict, "INCONCLUSIVE");
  assert.equal(one((g) => (block(g, "base").newest[1] = { noAnswer: "x HTTP 0: timeout" })).verdict, "INCONCLUSIVE");
  // a no-answer beside a wrong answer still fails
  assert.equal(one((g) => ((g.chains.robinhood.chainId[0] = { noAnswer: "x" }), (g.sign.guard = false))).verdict, "FAIL");
  // the finalized block unread is a "--" line, never a fail: the page no longer waits for it
  assert.equal(one((g) => (g.chains.base.finalized = [{ noAnswer: "x" }, { noAnswer: "y" }])).verdict, "PASS");
});
