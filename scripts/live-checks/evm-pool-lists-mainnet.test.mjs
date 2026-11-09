// node --test scripts/live-checks/evm-pool-lists-mainnet.test.mjs: card evm-pool-lists-mainnet's live check, replayed.
// evm-pool-lists-mainnet.answers.json holds a real run on the kit's Base and Robinhood mainnet pool lists (good: on each
// chain both seats answer the pool's filter over 10,000 blocks to the head, 1,000,000 back and from the deploy block,
// the same logs on both, and the PoolManager's Swap logs the same and some at the head and 1,000,000 back, 2026-11-09
// 11:28Z from this Mac, every answer provider-answer.mjs's) and a real run of Base on its pair before (its quote list's
// first two: blastapi's "up to a 10 block range"). Good passes; the bad run fails, and so do the good answers under one
// operator twice or a seat whose logs differ; a seat that answers nothing is INCONCLUSIVE, never a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE_BEFORE, check, checkChain, judgePage, kitList, replayer } from "./evm-pool-lists-mainnet.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-lists-mainnet.answers.json", import.meta.url), "utf8"));

test("the check reads the kit's own Base and Robinhood pool lists, and the good run is a run on them", () => {
  assert.deepEqual(A.good.kits.base, kitList("base"));
  assert.deepEqual(A.good.kits.robinhood, kitList("robinhood"));
});

test("the recorded good answer passes: on both chains two operators, each paging the pool's filter at the head, 1,000,000 back and from the deploy block, their logs one", async () => {
  const r = await check(replayer(A.good.log), A.good.kits, A.good.page);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.verdict, "PASS");
  assert.equal(r.lines.length, 11);
  assert.equal(r.lines[0], "SIGN_HOST's connect-src names every seat (4)");
  for (const chain of ["base", "robinhood"]) {
    const own = r.lines.filter((l) => l.startsWith(`${chain}: `));
    assert.equal(own.filter((l) => /the pool's filter over 10000 blocks (to the head|1000000 back|from the deploy block) \(\d+-\d+\), \d+ logs on both$/.test(l)).length, 3, own.join("\n"));
    assert.equal(own.filter((l) => /both seats: the PoolManager's Swap logs (at the head|1000000 back) \(\d+-\d+\), [1-9]\d* logs, digest [0-9a-f]{16} on both$/.test(l)).length, 2, own.join("\n"));
  }
  assert.match(r.lines[1], /^base: base-rpc\.publicnode\.com \(publicnode\.com\) and base\.api\.pocket\.network \(pocket\.network\): /);
  assert.match(r.lines[6], /^robinhood: rpc\.mainnet\.chain\.robinhood\.com \(robinhood\.com\) and robinhood\.api\.pocket\.network \(pocket\.network\): /);
});

test("the recorded bad answer fails: Base on its pair before, blastapi's 10-block cap", async () => {
  assert.deepEqual(A.baseBefore.kit.list, BASE_BEFORE);
  const r = await checkChain(replayer(A.baseBefore.log), "base", A.baseBefore.kit);
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^base: base-mainnet\.public\.blastapi\.io: the pool's filter over 10000 blocks to the head \(\d+-\d+\): RPC error -32600: You can make eth_getLogs requests with up to a 10 block range/);
});

// card pool-lists-check-provider-answer: only a missing answer is INCONCLUSIVE (exit 3); a wrong one is FAIL (exit 1)
test("planted: a seat that answers nothing leaves the check INCONCLUSIVE, naming it; a wrong answer elsewhere is FAIL over it", async () => {
  const pocket = "https://robinhood.api.pocket.network";
  const quiet = (e) => (e.url === pocket && e.method === "eth_getLogs" ? { url: e.url, method: e.method, params: e.params, noAnswer: "robinhood.api.pocket.network HTTP 200: empty body" } : e);
  const r = await check(replayer(A.good.log.map(quiet)), A.good.kits, A.good.page);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^robinhood: the pool's filter over 10000 blocks to the head \(\d+-\d+\): no answer: robinhood\.api\.pocket\.network HTTP 200: empty body$/);
  assert.ok(r.lines.some((l) => l.startsWith("base: both seats: the PoolManager's Swap logs 1000000 back")), "Base is still judged");
  const cut = { ...A.good.page, csp: A.good.page.csp.replace(" https://base.api.pocket.network", "") };
  const both = await check(replayer(A.good.log.map(quiet)), A.good.kits, cut);
  assert.equal(both.verdict, "FAIL", both.lines.join("\n"));
  assert.equal((await checkChain(() => ({ noAnswer: "x: no answer (ECONNREFUSED)" }), "base", A.good.kits.base)).verdict, "INCONCLUSIVE");
});

test("planted: the good answers under one operator twice fail before any read", async () => {
  const kits = { ...A.good.kits, base: { ...A.good.kits.base, list: ["https://base-rpc.publicnode.com", "https://base-sepolia-rpc.publicnode.com"] } };
  const r = await check(replayer(A.good.log), kits, A.good.page);
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("base: the two seats are one operator (publicnode.com): base-rpc.publicnode.com and base-sepolia-rpc.publicnode.com"), r.lines.join("\n"));
});

test("planted: a seat that answers the Swap logs with none where the other has some fails, naming both", async () => {
  // Pocket's Base gateway answered 0 logs 5M back where Sentio and Tenderly answered 142 (2026-11-09 05:5xZ)
  const log = A.good.log.map((e) => {
    const p = e.params?.[0];
    if (e.method === "eth_getLogs" && e.url === "https://base.api.pocket.network" && p?.topics?.length === 1 && Array.isArray(p.topics[0]) === false) return { ...e, result: [] };
    return e;
  });
  const r = await checkChain(replayer(log), "base", A.good.kits.base);
  assert.equal(r.ok, false);
  assert.match(r.lines.at(-1), /^base: the seats' answers to the PoolManager's Swap logs at the head \(\d+-\d+\) differ: base-rpc\.publicnode\.com [1-9]\d* logs [0-9a-f]{16}, base\.api\.pocket\.network 0 logs [0-9a-f]{16}$/);
});

test("planted: SIGN_HOST's policy without a seat's origin, or a page with no CSP, fails, naming what it lacks", async () => {
  const cut = { ...A.good.page, csp: A.good.page.csp.replace(" https://base.api.pocket.network", "") };
  const r = await check(replayer(A.good.log), A.good.kits, cut);
  assert.equal(r.ok, false);
  assert.equal(r.lines[0], "SIGN_HOST's connect-src lacks https://base.api.pocket.network");
  assert.equal(judgePage({ status: 200, csp: null }, A.good.kits).ok, false);
  assert.equal(judgePage({ status: 404, csp: A.good.page.csp }, A.good.kits).ok, false);
  assert.equal(judgePage(undefined, A.good.kits).ok, false);
});
