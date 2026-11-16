// node --test scripts/live-checks/helper-ready-never-waits-on-a-testnet-pool.test.mjs: the live check replays its recorded
// runs (helper-ready-never-waits-on-a-testnet-pool.answers.json). good: the host serving and ready on its mainnet pools,
// judged for the commit it runs: PASS. bad: the same host after the 13:4xZ redeploy of 80f48ad9a, whose helper never got
// ready, still answering the commit before it: FAIL. Made from the good run: ready false, a mainnet pool down or on
// another network, a pool not read: each FAIL; a chain with no block for the minute: INCONCLUSIVE.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { judge, mainnetPools, read } from "./helper-ready-never-waits-on-a-testnet-pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-ready-never-waits-on-a-testnet-pool.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));

test("recorded good run: the helper runs the deployed commit, is ready, and serves every mainnet pool's fee: PASS", () => {
  const r = judge(A.good.run, A.good.commit);
  assert.equal(r.verdict, "PASS", r.lines.join("\n"));
  assert.deepEqual(A.good.run.fees.map((f) => `${f.chain} ${f.network}`), ["solana mainnet", "evm base", "evm robinhood"]);
});

test("recorded bad run: after a redeploy whose helper never got ready, the host answers the commit before it: FAIL", () => {
  const r = judge(A.bad.run, A.bad.commit);
  assert.equal(r.verdict, "FAIL");
  assert.ok(bad(r).some((l) => l.startsWith("BAD [health]") && l.includes(`deployed ${A.bad.commit}`)), bad(r).join("\n"));
});

test("made from the good run: each break of the end state FAILs; a chain with no block for the minute is INCONCLUSIVE", () => {
  const health = (f) => ({ ...A.good.run, health: { ...A.good.run.health, body: JSON.stringify(f(JSON.parse(A.good.run.health.body))) } });
  const fee = (network, f) => ({ ...A.good.run, fees: A.good.run.fees.map((x) => (x.network === network ? f(structuredClone(x)) : x)) });
  const cases = {
    "ready false": health((b) => ({ ...b, ready: false })),
    "ready missing": health(({ ready: _, ...b }) => b),
    "health down": { ...A.good.run, health: { error: "fetch failed" } },
    "Robinhood's pool down": fee("robinhood", (x) => ({ ...x, answer: { status: 503, commit: A.good.commit, body: JSON.stringify({ error: { code: "upstream" } }) } })),
    "Base's pool not served": fee("base", (x) => ({ ...x, answer: { status: 404, commit: A.good.commit, body: JSON.stringify({ error: { code: "not_found" } }) } })),
    "Solana's pool on devnet": fee("mainnet", (x) => ({ ...x, answer: { ...x.answer, body: JSON.stringify({ ...JSON.parse(x.answer.body), cluster: "devnet" }) } })),
    "a pool not read": { ...A.good.run, fees: A.good.run.fees.slice(1) },
  };
  for (const [name, run] of Object.entries(cases)) assert.equal(judge(run, A.good.commit).verdict, "FAIL", name);
  const quiet = fee("base", (x) => ({ ...x, answer: { status: 503, commit: A.good.commit, body: JSON.stringify({ error: { code: "index_behind" } }) } }));
  assert.equal(judge(quiet, A.good.commit).verdict, "INCONCLUSIVE");
  assert.equal(judge(A.good.run, "6194790b7").verdict, "FAIL", "a short commit");
});

test("the pools read are the mainnet deploy records' and the kit's pins, and a read records each answer without throwing", async () => {
  const pools = mainnetPools();
  assert.deepEqual(pools.map((p) => `${p.chain} ${p.network}`), ["solana mainnet", "evm base", "evm robinhood"]);
  for (const p of pools) assert.ok(A.good.run.fees.some((f) => f.pool === p.pool), p.pool);
  const run = await read("https://helper.invalid", async () => {
    throw new Error("fetch failed");
  });
  assert.equal(run.health.error, "fetch failed");
  assert.equal(judge(run, A.good.commit).verdict, "FAIL");
});
