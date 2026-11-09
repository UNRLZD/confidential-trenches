// node --test scripts/live-checks/evm-pool-leaves-any-source.test.mjs: card evm-pool-leaves-any-source's live check,
// replayed through the wallet's own sync (packages/wallet/scripts/evm-pool-sources-check.ts).
// evm-pool-leaves-any-source.answers.json holds a real run (good: both pools' lists and the helper's ?keyed=only route,
// every seat's logs refused so every log comes from the sources; its note names the one answer per chain that is not
// real, the redeployed helper's 400 to ?keyed=bogus), the bad run (its `bad.note`: a planted leaf on every source, since
// both pools hold none yet) and `today`, the deployed helper's real answer to ?keyed=bogus before this card's redeploy.
// Good passes; bad fails naming the tree that is not the pool's; today fails on the helper's missing mode. Planted on
// the good one: one honest operator alone, every other source lying, fails; every source silent is INCONCLUSIVE, never
// judged; a helper silent on the probe is INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHAINS, POOL_TOPICS, check, fabricated, plantedBad, replayer } from "./evm-pool-leaves-any-source.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-pool-leaves-any-source.answers.json", import.meta.url), "utf8"));
const run = (log, chains = A.good.chains) => check(replayer(log), chains, { wait: false });
const base = A.good.chains[0];
const inBase = (e) => e.method === "eth_getLogs" && e.params[0].address === base.pool;

test("the good run is a run on both pools: the signing page's mainnet lists, the helper's keyed-only route", () => {
  assert.deepEqual(A.good.chains, JSON.parse(JSON.stringify(CHAINS)));
  assert.deepEqual(A.good.chains.map((c) => c.name), ["base", "robinhood"]);
  for (const c of A.good.chains) assert.equal(c.helper, `https://ct-api.unrealized.trade/v1/rpc/${c.name}?keyed=only`);
  assert.ok(A.good.log.some((e) => e.url.endsWith("?keyed=only") && e.method === "eth_getLogs"), "the helper's route was read");
});

test("the recorded good run passes: each pool's trees from the sources alone, two operators answering", async () => {
  const r = await run(A.good.log);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.equal(r.lines.length, 2);
  for (const [i, name] of ["base", "robinhood"].entries())
    assert.match(r.lines[i], new RegExp(`^PASS ${name}: head \\d+ 0x[0-9a-f]{64}, state size \\d+ root 0x[0-9a-f]+, label size \\d+ root 0x[0-9a-f]+, \\d+ events from the sources alone; log reads answered: `));
});

test("the recorded bad run fails: two operators agree on a leaf the pool does not hold, its tree not the pool's", async () => {
  const r = await run(A.bad.log, A.bad.chains);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines[0], /^FAIL base: .*no two sources of two operators gave the same logs making the pool's trees .*the state tree from the logs \(1 leaves\) is not the pool's/);
  assert.match(r.lines[1], /^PASS robinhood: /);
});

test("the bad run is the good one with that leaf planted: plantedBad builds the file's bad run", () => {
  assert.deepEqual(plantedBad({ chains: A.good.chains, log: A.good.log }), { chains: A.bad.chains, log: A.bad.log });
});

test("today's helper (before this card's redeploy) answers ?keyed=bogus: the check fails on both chains before any sync", async () => {
  const r = await run([...A.today.log, ...A.good.log.filter((e) => !e.url.endsWith("?keyed=bogus"))]);
  assert.equal(r.verdict, "FAIL");
  for (const [i, name] of ["base", "robinhood"].entries()) assert.match(r.lines[i], new RegExp(`^FAIL ${name}: the helper's route answered \\?keyed=bogus .*no keyed-only mode is deployed`));
});

test("one honest operator alone is never taken: every other source's Base logs carry another leaf, and the check fails", async () => {
  const honest = base.list[0];
  const log = A.good.log.map((e) => (inBase(e) && e.url !== honest && Array.isArray(e.result) ? { ...e, result: [fabricated(base.pool, Number(BigInt(e.params[0].fromBlock))), ...e.result] } : e));
  const r = await run(log);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines[0], /^FAIL base: .*no two sources of two operators/);
});

test("every source silent on Base's logs is INCONCLUSIVE, never judged; the other pool still passes", async () => {
  const log = A.good.log.map((e) => (inBase(e) ? { url: e.url, method: e.method, params: e.params, noAnswer: `${new URL(e.url).host} HTTP 429: 429 Too Many Requests` } : e));
  const r = await run(log);
  assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
  assert.match(r.lines[0], /^INCONCLUSIVE base: /);
  assert.match(r.lines[1], /^PASS robinhood: /);
});

test("a helper silent on the probe is INCONCLUSIVE for that chain", async () => {
  const log = A.good.log.map((e) => (e.url === base.helper.replace("?keyed=only", "?keyed=bogus") ? { url: e.url, method: e.method, params: e.params, noAnswer: "ct-api.unrealized.trade: no answer (TimeoutError)" } : e));
  const r = await run(log);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.match(r.lines[0], /^INCONCLUSIVE base: the helper's route gave no answer/);
});

test("the pool's topics are robinhood-mainnet-rpcs's, and the check reads providers only through provider-answer.mjs", async () => {
  const { POOL_TOPICS: theirs } = await import("./robinhood-mainnet-rpcs.mjs");
  assert.deepEqual([...POOL_TOPICS], [...theirs]);
  const src = readFileSync(new URL("./evm-pool-leaves-any-source.mjs", import.meta.url), "utf8");
  assert.match(src, /from "\.\/provider-answer\.mjs"/);
  assert.doesNotMatch(src, /jsonrpc/);
});
