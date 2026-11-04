// Weakens src/price/pool-usd.ts's agreement and staleness checks (Robinhood's hold to Base's ETH/USD among them), and
// src/trade/solana/pool-buy.ts's refusal of a Token-2022 mint that lists an extension twice, one at a time, and runs
// the tests named for each (test/pool-usd.test.ts "agreement" and "staleness", test/solana-pool-buy.test.ts
// "Token-2022"): each named test passes on the code as it is and fails on every mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs), never the kit's own, and put back after each
// mutant (and checked to be back); exits 1 when a named test passes on its mutant, fails or runs no test on the code as
// it is, or a mutant's text is not in its file exactly once.
//   node packages/kit/test/pool-usd-mutants.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIT, kitCopy } from "./mutant-copy.mjs";

// the sweep runs in a copy of the kit; imported (for its MUTANTS), the paths are the kit's own
const BASE = process.argv[1] === fileURLToPath(import.meta.url) ? kitCopy() : KIT;
const PRICE = path.join(BASE, "src/price/pool-usd.ts");
const TEST = path.join(BASE, "test/pool-usd.test.ts");
const BUY = path.join(BASE, "src/trade/solana/pool-buy.ts");
const BUY_TEST = path.join(BASE, "test/solana-pool-buy.test.ts");

const AGREE = "agreement";
const STALE = "staleness";
const T22 = "Token-2022";

// [file, text, replacement, the tests that must fail, their file (test/pool-usd.test.ts when none)]
export const MUTANTS = [
  // agreement: the Pyth account's bytes and owner on both RPCs
  [PRICE, "if (sameAccount(r[0].account, r[1].account)) {", "if (true) {", AGREE],
  [PRICE, "a.owner === b.owner && a.data.length", "a.data.length", AGREE],
  [PRICE, "a.data.every((x, i) => x === b.data[i])", "a.data.every((x, i) => i >= 73 || x === b.data[i])", AGREE],
  [PRICE, "min = Math.max(r[0].slot, r[1].slot);", "min = null;", AGREE],
  // agreement: Chainlink's words on both RPCs, at one block
  [PRICE, "if (a.decimals !== b.decimals) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (a.round[i] !== b.round[i]) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (a.round[i] !== b.round[i]) fail(", "if (i !== 0 && a.round[i] !== b.round[i]) fail(", AGREE],
  [PRICE, "[{ to: feed.proxy, data: LATEST_ROUND_DATA }, at]", '[{ to: feed.proxy, data: LATEST_ROUND_DATA }, "latest"]', AGREE],
  [PRICE, "const block = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;", "const block = heads[0]! > heads[1]! ? heads[0]! : heads[1]!;", AGREE],
  // agreement: the read's block is one block on both RPCs, and near the device's clock (one RPC's low head picks no
  // older round)
  [PRICE, "if (blocks[0]!.hash !== blocks[1]!.hash) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (blocks[0]!.timeS !== blocks[1]!.timeS) fail(", "if (false) fail(", AGREE],
  [PRICE, "!== block) fail(`rpc ${k}: answered another block", "!== block && false) fail(`rpc ${k}: answered another block", AGREE],
  [PRICE, "if (Math.abs(nowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (Math.abs(nowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (false) fail(", STALE],
  [PRICE, "if (Math.abs(nowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (nowS - blockS > POOL_USD_BLOCK_MAX_AGE_S) fail(", STALE],
  [PRICE, "if (Math.abs(nowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (Math.abs(nowS - blockS) >= POOL_USD_BLOCK_MAX_AGE_S) fail(", STALE],
  [PRICE, "export const POOL_USD_BLOCK_MAX_AGE_S = 60;", "export const POOL_USD_BLOCK_MAX_AGE_S = 1_500;", STALE],
  // agreement: Robinhood's ETH/USD held to Base's, read in the same call
  [PRICE, "if (gap * 10_000n > POOL_USD_CROSS_BPS * lo) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (gap * 10_000n > POOL_USD_CROSS_BPS * lo) fail(", "if (gap * 10_000n > 2n * POOL_USD_CROSS_BPS * lo) fail(", AGREE],
  [PRICE, "const lo = x < y ? x : y;", "const lo = x < y ? y : x;", AGREE],
  [PRICE, 'if (chain !== "robinhood") return chainlinkPrice', 'if (chain !== "robinhood" || args.baseRpcs === undefined) return chainlinkPrice', AGREE],
  // staleness: the age against the device's clock, both ways, and each bound
  [PRICE, "if (nowS > goodUntil(publishedS, nowS, maxAgeS)) fail(", "if (false) fail(", STALE],
  [PRICE, "if (nowS > goodUntil(publishedS, nowS, maxAgeS)) fail(", "if (nowS >= goodUntil(publishedS, nowS, maxAgeS)) fail(", STALE],
  [PRICE, "Math.min(publishedS, readS) + maxAgeS", "publishedS + maxAgeS", STALE],
  [PRICE, "if (publishedS - nowS > POOL_USD_MAX_AHEAD_S) fail(", "if (false) fail(", STALE],
  [PRICE, "checkAge(publishedS, feed.maxAgeS, nowS);\n  return { chain: \"solana\"", "return { chain: \"solana\"", STALE],
  [PRICE, "checkAge(publishedS, feed.maxAgeS, nowS);\n  return { chain, asset", "return { chain, asset", STALE],
  [PRICE, "    maxAgeS: 60,", "    maxAgeS: 600,", STALE],
  [PRICE, "maxAgeS: 1_500 }", "maxAgeS: 15_000 }", STALE],
  [PRICE, "maxAgeS: 86_700 }", "maxAgeS: 867_000 }", STALE],
  [PRICE, "if (updatedAt === 0n || updatedAt >= U64) fail(", "if (updatedAt >= U64) fail(", STALE],
  // a Token-2022 mint that lists one extension type twice
  [BUY, "if (seen.has(type)) throw", "if (false) throw", T22, BUY_TEST],
  [BUY, "    seen.add(type);\n", "", T22, BUY_TEST],
];

// a child test run must not inherit this process's own node --test context
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
// "pass", "fail" or "none" (no test ran) of the tests whose names start with `name`
function run(name, file = TEST) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name}`, file];
  try {
    const out = execFileSync("node", args, { stdio: "pipe", encoding: "utf8", env: CHILD_ENV });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const [t, f] of new Map(MUTANTS.map((m) => [m[3], m[4]]))) {
    const r = run(t, f);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([file, find, repl, t, testFile], i) => {
    const src = readFileSync(file, "utf8");
    if (src.split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in ${path.basename(file)} exactly once`);
      bad++;
      return;
    }
    writeFileSync(file, src.replace(find, repl));
    let r;
    try {
      r = run(t, testFile);
    } finally {
      writeFileSync(file, src);
    }
    if (readFileSync(file, "utf8") !== src) throw new Error(`mutant ${i + 1} left ${file} changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
