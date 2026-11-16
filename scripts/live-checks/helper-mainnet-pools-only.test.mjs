// node --test scripts/live-checks/helper-mainnet-pools-only.test.mjs: the live check replays its recorded runs
// (helper-mainnet-pools-only.answers.json). bad: a read of the helper before the card (6194790b7), serving every test
// pool: FAIL. good: made from it, each test pool answered 404 not_found: PASS. Made from the good run: a test pool
// served, loaded but down, unanswered or not read, the wrong commit, ready false: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, read, testPools } from "./helper-mainnet-pools-only.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-mainnet-pools-only.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: the deployed helper answers 404 not_found for every test pool: PASS", () => {
  const r = judge(A.good.run, A.good.commit);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
});

test("recorded bad run: the helper before the card serves every test pool (200): FAIL, one line per pool", () => {
  const r = judge(A.bad.run, A.bad.commit);
  assert.equal(r.verdict, "FAIL");
  assert.equal(bad(r).length, testPools().length, bad(r).join("\n"));
  assert.ok(bad(r).every((l) => / answers 200 \(served: /.test(l)), bad(r).join("\n"));
});

test("made from the good run: each break of the end state FAILs", () => {
  const fee = (i, answer) => ({ ...A.good.run, fees: A.good.run.fees.map((x, j) => (j === i ? { ...x, answer } : x)) });
  const health = (f) => ({ ...A.good.run, health: { ...A.good.run.health, body: JSON.stringify(f(JSON.parse(A.good.run.health.body))) } });
  const cases = {
    "a test pool served": fee(0, A.bad.run.fees[0].answer),
    "a devnet pool served": fee(A.good.run.fees.length - 1, A.bad.run.fees.at(-1).answer),
    "a test pool loaded but down": fee(1, { status: 503, commit: A.good.commit, body: JSON.stringify({ error: { code: "upstream" } }) }),
    "a test pool unanswered": fee(0, { error: "fetch failed" }),
    "a 404 from another commit": fee(0, { ...A.good.run.fees[0].answer, commit: "a".repeat(40) }),
    "a test pool not read": { ...A.good.run, fees: A.good.run.fees.slice(1) },
    "ready false": health((b) => ({ ...b, ready: false })),
    "health down": { ...A.good.run, health: { error: "fetch failed" } },
  };
  for (const [name, run] of Object.entries(cases)) assert.equal(judge(run, A.good.commit).verdict, "FAIL", name);
  assert.equal(judge(A.good.run, "6194790b7").verdict, "FAIL", "a short commit");
  assert.equal(judge(A.good.run, A.good.commit, []).verdict, "FAIL", "no test pool to read");
});

test("the pools read are every EVM test network the kit pins and the Solana devnet pools, and a read never throws", async () => {
  const pools = testPools();
  assert.deepEqual(pools.map((p) => `${p.chain} ${p.network}`), ["evm base-sepolia", "evm robinhood-testnet", "solana devnet", "solana devnet"]);
  for (const p of pools) assert.ok(A.bad.run.fees.some((f) => f.pool === p.pool), p.pool);
  assert.ok(pools.every((p) => !["base", "robinhood", "mainnet"].includes(p.network)));
  const run = await read("https://helper.invalid", async () => {
    throw new Error("fetch failed");
  });
  assert.equal(run.health.error, "fetch failed");
  assert.equal(judge(run, A.good.commit).verdict, "FAIL");
});
