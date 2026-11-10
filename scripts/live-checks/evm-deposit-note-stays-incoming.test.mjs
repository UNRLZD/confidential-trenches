// node --test scripts/live-checks/evm-deposit-note-stays-incoming.test.mjs: card evm-deposit-note-stays-incoming's
// live check, replayed. evm-deposit-note-stays-incoming.answers.json holds a real run of the EVM deposit path's state
// reads on the page's Base and Robinhood mainnet pool pairs (good: every read answered on both seats) and a real run of
// the read the path made before (U's nonce at "finalized": Robinhood's own node refuses it with -32000 "historical
// state ... is not available"). Good passes, the read before fails, and planted refusals of the new reads fail too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { check, pagePairs, replayer } from "./evm-deposit-note-stays-incoming.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-deposit-note-stays-incoming.answers.json", import.meta.url), "utf8"));
const run = (r, o = {}) => check(replayer(r.log), { pairs: r.pairs, ...o });
const REFUSED = { code: -32000, message: "historical state bac0f84b9ba5e79e767198a3fb6d8dacc874bc06b584baf3a3e35c8ebda3f78d is not available" };

test("the check reads the page's own pool pairs, and the good run is a run on them", () => {
  assert.deepEqual(A.good.pairs, pagePairs());
});

test("the recorded good run passes: every state read of the path answered on both seats of Base and Robinhood", async () => {
  const r = await run(A.good);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.match(r.lines[0], /^base \(base-rpc\.publicnode\.com, base\.api\.pocket\.network\): newest agreed block \d+; .* all answered$/);
  assert.match(r.lines[1], /^robinhood \(rpc\.mainnet\.chain\.robinhood\.com, robinhood\.api\.pocket\.network\): newest agreed block \d+; .* all answered$/);
});

test("the recorded bad run, the read the path made before (U's nonce at finalized), fails on Robinhood's refusal", async () => {
  const r = await run(A.before, { before: true });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.at(-1), /^rpc\.mainnet\.chain\.robinhood\.com: U's nonce at finalized: RPC error -32000: historical state [0-9a-f]+ is not available$/);
});

test("planted: a seat that refuses U's nonce at the newest block's hash, or at its number, fails", async () => {
  for (const pick of [(e) => typeof e.params[1] === "object", (e) => typeof e.params[1] === "string" && e.params[1] !== "latest"]) {
    const log = A.good.log.map((e) => (e.url === A.good.pairs[1].seats[0] && e.method === "eth_getTransactionCount" && pick(e) ? { url: e.url, method: e.method, params: e.params, error: REFUSED } : e));
    const r = await run({ ...A.good, log });
    assert.equal(r.verdict, "FAIL", r.lines.join("\n"));
    assert.match(r.lines.at(-1), /^rpc\.mainnet\.chain\.robinhood\.com: U's nonce at the newest .*RPC error -32000: historical state/);
  }
});

test("planted: a seat whose finalized header is refused, or two seats on different final blocks, fail", async () => {
  const noFin = A.good.log.map((e) => (e.url === A.good.pairs[0].seats[1] && e.method === "eth_getBlockByNumber" && e.params[0] === "finalized" ? { url: e.url, method: e.method, params: e.params, error: { code: -32000, message: "finalized block not supported" } } : e));
  assert.equal((await run({ ...A.good, log: noFin })).verdict, "FAIL");
  const lowOf = (seat) => A.good.log.filter((e) => e.url === seat && e.method === "eth_getBlockByNumber" && /^0x/.test(e.params[0])).at(-1);
  const last = lowOf(A.good.pairs[0].seats[1]);
  const fork = A.good.log.map((e) => (e === last ? { ...e, result: { ...e.result, hash: `0x${"22".repeat(32)}` } } : e));
  const r = await run({ ...A.good, log: fork });
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.at(-1), /^base: the seats hold different final blocks at \d+$/);
});

test("planted: a seat that answers nothing on every try is INCONCLUSIVE, never a pass; a pair of one seat fails", async () => {
  const quiet = A.good.log.map((e) => (e.url === A.good.pairs[1].seats[1] && e.method === "eth_getBalance" ? { url: e.url, method: e.method, params: e.params, noAnswer: "robinhood.api.pocket.network HTTP 429" } : e));
  assert.equal((await run({ ...A.good, log: quiet })).verdict, "INCONCLUSIVE");
  const one = await run({ ...A.good, pairs: [{ ...A.good.pairs[0], seats: [A.good.pairs[0].seats[0]] }] });
  assert.equal(one.verdict, "FAIL");
  assert.equal(one.lines.at(-1), "base: the pool list seats 1 providers, not two");
});
