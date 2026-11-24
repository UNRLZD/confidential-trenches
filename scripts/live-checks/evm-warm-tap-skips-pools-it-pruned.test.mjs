// The live check evm-warm-tap-skips-pools-it-pruned replayed on its recorded answers
// (evm-warm-tap-skips-pools-it-pruned.answers.json):
//   good: this card's kit on Base mainnet, NVDAc's warm tap asking none of the 93 pools its cold tap's prune asked: PASS;
//   bad_main: main b456b9b2c's kit, the warm tap asking 78 of them again, none moved: FAIL;
// and planted cases: a pool asked again unmoved fails; one that moved, or asked a smaller amount, passes; a cold tap
// whose prune dropped nothing, or whose answers name a SafeCastOverflow, has nothing to judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { exactOutReads, judge } from "./evm-warm-tap-skips-pools-it-pruned.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-warm-tap-skips-pools-it-pruned.answers.json", import.meta.url), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("the recorded good answer passes: the warm tap asked none of the pools the cold tap's prune asked", () => {
  const r = judge(A.good);
  assert.deepEqual([r.ok, r.quiet], [true, false], r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  0 of the 93 pools the cold tap's prune asked asked again by the warm tap, 0 of them moved since or asked less"), r.lines.join("\n"));
});

test("the recorded bad answer fails: main's kit asked 78 of the 93 pools again, none moved", () => {
  const r = judge(A.bad_main);
  assert.deepEqual([r.ok, r.quiet], [false, false]);
  assert.equal(bad(r).length, 1);
  assert.match(bad(r)[0], /^BAD 78 of the 93 pools the cold tap's prune asked asked again by the warm tap, 0 of them moved since or asked less; unmoved: 0x[0-9a-f]{40}\/0x[0-9a-f]{40}\/\d+\/-?\d+\/0x[0-9a-f]{40}, .* and 75 more$/);
});

test("planted cases: a pool asked again at the same amount unmoved fails; moved since, or asked a smaller amount, passes", () => {
  const edit = (f) => {
    const run = structuredClone(A.good);
    f(run);
    return judge(run);
  };
  const x = A.good.cold.reads[0];
  assert.equal(edit((r) => r.warm.reads.push({ ...x, block: x.block + 5 })).ok, false);
  assert.equal(edit((r) => r.warm.reads.push({ ...x, amount: String(BigInt(x.amount) + 1n), block: x.block + 5 })).ok, false);
  assert.equal(edit((r) => (r.warm.reads.push({ ...x, block: x.block + 5 }), r.moved.push(x.pool))).ok, true);
  assert.equal(edit((r) => r.warm.reads.push({ ...x, amount: String(BigInt(x.amount) - 1n), block: x.block + 5 })).ok, true);
  // a pool the cold tap never asked, asked by the warm tap: no re-ask
  assert.equal(edit((r) => r.warm.reads.push({ ...x, pool: x.pool.replace(/^0x[0-9a-f]{40}/, "0x" + "1".repeat(40)) })).ok, true);
});

test("nothing to judge: a cold tap that asked no exact-output read, whose answers name no NotEnoughLiquidity, or one a SafeCastOverflow", () => {
  const edit = (f) => {
    const run = structuredClone(A.bad_main);
    f(run);
    return judge(run);
  };
  for (const f of [(r) => (r.cold.reads = []), (r) => (r.cold.short = 0), (r) => (r.cold.over = 1)]) {
    const r = edit(f);
    assert.deepEqual([r.ok, r.quiet], [false, true], r.lines.join("\n"));
    assert.equal(bad(r).length, 0);
  }
});

test("exactOutReads reads each quoteExactOutputSingle a post carries: inside an aggregate3 and alone, its pool, amount and block", () => {
  const w = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, "0");
  const [c0, c1, hooks] = ["0x" + "0".repeat(39) + "1", "0x" + "ab".repeat(20), "0x" + "0".repeat(40)];
  const read = (amount) => "58733073" + w(0x20) + w(c0) + w(c1) + w(3000) + w(-60) + w(hooks) + w(1) + w(amount) + w(0x100) + w(0);
  const hash = "0x" + "cd".repeat(32);
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: "0xca11bde05977b3631167028862be2a173976ca11", data: "0x82ad56cb" + w(0x20) + read(5n) + "00".repeat(7) + read(7n) }, { blockHash: hash }] },
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0x0d5e0f971ed27fbff6c2837bf31316121532048d", data: "0x" + read(9n) }, "0x10"] },
    { jsonrpc: "2.0", id: 2, method: "eth_getLogs", params: [{ data: read(11n) }] },
  ]);
  const pool = `${c0}/${c1}/3000/-60/${hooks}`;
  assert.deepEqual(exactOutReads(body), [
    { pool, amount: "5", hash },
    { pool, amount: "7", hash },
    { pool, amount: "9", hash: "0x10" },
  ]);
  assert.deepEqual(exactOutReads("not json"), []);
});
