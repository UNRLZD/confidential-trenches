// node packages/kit/test/near-rhea-mutants.mjs (card near-view-rhea): plants one weakening of the Rhea classic quote at a
// time in a copy of the kit's src/near/rhea.ts (test/mutant-copy.mjs), runs the named test of test/near-rhea.test.ts
// there, and expects it to fail: the pool fee dropped or a unit off, the rounding turned up, the fee left out of the
// denominator, each agreement of the two providers (bytes, block hash, height, lag) removed, and the token's fee
// left out of a buy or a sell.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSync } from "../../../scripts/group-run.mjs";
import { kitCopy } from "./mutant-copy.mjs";

const WITH_FEE = "  const withFee = amountIn * (RHEA_FEE_DIVISOR - BigInt(pool.feeBps));";
const OUT = "  return (withFee * rout) / (RHEA_FEE_DIVISOR * rin + withFee);";
// [name, the source text, its replacement, the test name pattern]
const M = [
  ["the pool fee dropped", WITH_FEE, "  const withFee = amountIn * RHEA_FEE_DIVISOR;", "^R1 "],
  ["the pool fee a unit low", WITH_FEE, "  const withFee = amountIn * (RHEA_FEE_DIVISOR - BigInt(pool.feeBps) + 1n);", "^R1 "],
  ["the pool fee a unit high", WITH_FEE, "  const withFee = amountIn * (RHEA_FEE_DIVISOR - BigInt(pool.feeBps) - 1n);", "^R1 "],
  ["the rounding turned up", OUT, "  return (withFee * rout + RHEA_FEE_DIVISOR * rin + withFee - 1n) / (RHEA_FEE_DIVISOR * rin + withFee);", "^R1 "],
  ["the fee left out of the denominator", OUT, "  return (withFee * rout) / (RHEA_FEE_DIVISOR * rin + amountIn * RHEA_FEE_DIVISOR);", "^R1 "],
  ["the providers' bytes not compared", " || !equalBytes(x.bytes, y.bytes)) throw", ") throw", "^Q2 "],
  ["the block hash not compared", "    if (x.hash !== y.hash || (blockHash", "    if ((blockHash", "^Q2 "],
  ["an answer at another height taken", "    if (x.height !== height || y.height !== height) throw", "    if (false) throw", "^Q2 "],
  ["the lag not checked", "  if (Math.abs(fa.height - fb.height) > RHEA_QUOTE_LAG_MAX) throw", "  if (false) throw", "^Q3 "],
  ["the paused exchange quoted", '  if (state !== "Running") throw', "  if (false) throw", "^Q5 "],
  ["a frozen token quoted", "  for (const t of new Set([tokenIn, tokenOut])) if (frozenList.includes(t)) throw", "  for (const t of new Set([tokenIn, tokenOut])) if (false) throw", "^Q5 "],
  ["the buy fee left out", "side === \"buy\" ? nearFeeBuyerReceives(fee, exchange, venueOut) : venueOut", "venueOut", "^F1 "],
  ["the lag bound raised to 4", "export const RHEA_QUOTE_LAG_MAX = 3;", "export const RHEA_QUOTE_LAG_MAX = 4;", "^Q3 "],
  ["the token code hashes not compared", "  if (x.code !== y.code) throw", "  if (false) throw", "^F6 "],
  ["the token code read at any block", "  same(`view_account ${token}`, x.at, y.at);\n", "", "^F6 "],
  ["stable or rated pools quoted as simple", 'if (row.pool_kind !== "SIMPLE_POOL") return null;', 'if (row.pool_kind === "DEGEN_SWAP") return null;', "^Q5 "],
  ["an unpinned plain token counted known", "  let fee: NearTokenFee = nearPlainTokenFee(account);", "  let fee: NearTokenFee = nearPlainTokenFee(\"3XbB1xkQTNFhtizVSCNW5xM9MyuF3AYhFKc8HAPc3pdx\");", "^F6 "],
  ["the sell fee left out", "side === \"sell\" ? nearFeeVenueReceives(fee, exchange, amountIn) : amountIn", "amountIn", "^F1 "],
];
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
const root = kitCopy();
const F = path.join(root, "src/near/rhea.ts");
const src = readFileSync(F, "utf8");
for (const [name, from] of M) {
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: its source text in rhea.ts`);
    process.exit(1);
  }
}
const base = runSync(process.execPath, ["--test", "test/near-rhea.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
if (base.status !== 0) {
  console.log(`the named tests fail on the code as it is:\n${base.stdout.slice(-2000)}`);
  process.exit(1);
}
let ok = 0;
for (const [name, from, repl, pat] of M) {
  writeFileSync(F, src.replace(from, repl));
  let r;
  try {
    r = runSync(process.execPath, ["--test", `--test-name-pattern=${pat}`, "test/near-rhea.test.ts"], { cwd: root, encoding: "utf8", env: CHILD_ENV, timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
else console.log(`every one of ${M.length} mutants fails its named test`);
