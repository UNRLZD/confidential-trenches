// node --test scripts/live-checks/balances-per-chain.test.mjs: the live check's verdict on recorded runs
// (balances-per-chain.answers.json), each read by balances-per-chain.mjs collect() in headless Chromium: the terminal on
// APP_HOST's real name inside the stand-in shell that answers `state` with three pools.
//   good:     this card's terminal build with Portfolio mounted on /portfolio (the one route line of card
//             app-portfolio-mount; this branch does not mount it) (--harness): every pool a row at both widths, in
//             cents, the pool sent with no ready drawn with dashes: PASS;
//   deployed: APP_HOST as served on 3 Nov before this card and app-portfolio-mount deploy: /portfolio draws no pool
//             block: FAIL;
//   planted from good: a pool row missing, a false 0 in Ready where the pool sent none, a SOL balance drawn as dollars
//             ("$12.50"), and the wrong asset: each FAIL.
// Each answer's `at` is when it was recorded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ANSWER, base, judge, POOLS } from "./balances-per-chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS = JSON.parse(readFileSync(path.join(HERE, "balances-per-chain.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const mut = (f) => {
  const rec = structuredClone(ANSWERS.good);
  f(rec);
  return judge(rec);
};

test("base units at the kit's decimals: rounded down, garbage and an unknown asset null", () => {
  assert.equal(base("12.5", "SOL"), "12500000000");
  assert.equal(base("0.25", "ETH"), "250000000000000000");
  assert.equal(base("1.0000001", "USDC"), "1000000");
  assert.equal(base("-1", "SOL"), null);
  assert.equal(base("1e3", "SOL"), null);
  assert.equal(base("1", "BTC"), null);
});

test("the recorded answers are the shell's answer as this check sends it", () => {
  assert.deepEqual(ANSWERS.good.answer, ANSWER);
  assert.deepEqual(ANSWER.pools, POOLS);
});

test("good: this card's build draws every pool at both widths: PASS", () => {
  const r = judge(ANSWERS.good);
  assert.ok(r.ok, bad(r).join("\n"));
});

test("deployed before this card: no pool block: FAIL", () => {
  const r = judge(ANSWERS.deployed);
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /pool block is not drawn|want rows/.test(l)), bad(r).join("\n"));
});

test("planted: a pool row missing: FAIL", () => {
  const r = mut((rec) => {
    for (const run of rec.runs) run.rows = run.rows.filter((x) => x.chain !== "base");
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /no row for base/.test(l)), bad(r).join("\n"));
});

test("planted: a SOL balance drawn as dollars: FAIL", () => {
  const r = mut((rec) => {
    rec.runs.find((y) => y.width === "phone").rows.find((y) => y.chain === "solana").text[1] = "$12.50";
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /solana drawn .*no dollar figure/.test(l)), bad(r).join("\n"));
});

test("planted: the wrong asset on a row: FAIL", () => {
  const r = mut((rec) => {
    rec.runs.find((y) => y.width === "desktop").rows.find((y) => y.chain === "base").asset = "SOL";
  });
  assert.equal(r.ok, false);
});

test("planted: a false 0 where the pool sent no ready: FAIL", () => {
  const r = mut((rec) => {
    const x = rec.runs.find((y) => y.width === "desktop").rows.find((y) => y.chain === "base");
    x.ready = "0";
    x.pending = "250000000000000000";
    x.text[2] = "0";
    x.text[3] = "0.25";
  });
  assert.equal(r.ok, false);
  assert.ok(bad(r).some((l) => /base sends no ready/.test(l)), bad(r).join("\n"));
});

test("planted: a ready drawn as a dash where the pool sent one: FAIL", () => {
  const r = mut((rec) => {
    const x = rec.runs.find((y) => y.width === "phone").rows.find((y) => y.chain === "solana");
    x.ready = "none";
    x.text[2] = "—";
  });
  assert.equal(r.ok, false);
});
