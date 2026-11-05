// Weakens src/price/pool-usd.ts's agreement and staleness checks (Robinhood's hold to Base's ETH/USD among them) and its
// bounded retry of a slow or lagging provider, its one bound per read and its stop once the read ends (card
// signpage-price-read-retry), and
// src/trade/solana/pool-buy.ts's refusal of a Token-2022 mint that lists an extension twice, one at a time, and runs
// the tests named for each (test/pool-usd.test.ts "agreement", "staleness" and "retry", test/solana-pool-buy.test.ts
// "Token-2022"), and S6's Token-2022 sides of a shared route in src/checks/solana/checks.ts (test/solana-shared-route.test.ts,
// card solana-shared-2022-side): each named test passes on the code as it is and fails on every mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs), never the kit's own, and put back after each
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
const S6 = path.join(BASE, "src/checks/solana/checks.ts");
const S6_TEST = path.join(BASE, "test/solana-shared-route.test.ts");

const AGREE = "agreement";
const STALE = "staleness";
const RETRY = "retry";
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
  [PRICE, "if (Math.abs(blockNowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (false) fail(", AGREE],
  [PRICE, "if (Math.abs(blockNowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (false) fail(", STALE],
  [PRICE, "if (Math.abs(blockNowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (blockNowS - blockS > POOL_USD_BLOCK_MAX_AGE_S) fail(", STALE],
  [PRICE, "if (Math.abs(blockNowS - blockS) > POOL_USD_BLOCK_MAX_AGE_S) fail(", "if (Math.abs(blockNowS - blockS) >= POOL_USD_BLOCK_MAX_AGE_S) fail(", STALE],
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
  [PRICE, "checkAge(publishedS, feed.maxAgeS, nowAt(nowS, bound));\n  return { chain: \"solana\"", "return { chain: \"solana\"", STALE],
  [PRICE, "checkAge(publishedS, feed.maxAgeS, nowAt(nowS, bound));\n  return { chain, asset", "return { chain, asset", STALE],
  [PRICE, "    maxAgeS: 60,", "    maxAgeS: 600,", STALE],
  [PRICE, "maxAgeS: 1_500 }", "maxAgeS: 15_000 }", STALE],
  [PRICE, "maxAgeS: 86_700 }", "maxAgeS: 867_000 }", STALE],
  [PRICE, "if (updatedAt === 0n || updatedAt >= U64) fail(", "if (updatedAt >= U64) fail(", STALE],
  // the age as the read returns, not as it began
  [PRICE, "nowS + (Date.now() - bound.start) / 1000", "nowS", STALE],
  // retry: a provider behind (-32016) or slow (no answer in a try's bound, its own or its client's) is asked again, alone,
  // after a doubling backoff, inside the read's bound; nothing else is asked again
  [PRICE, "if (!behind(e) && !slow(e)) throw e;", "throw e;", RETRY],
  [PRICE, "if (!behind(e) && !slow(e)) throw e;", "", RETRY],
  [PRICE, 'e.message.startsWith("RPC error -32016:")', "false", RETRY],
  [PRICE, "e instanceof NoAnswer || (e instanceof", "(e instanceof", RETRY],
  [PRICE, '(e instanceof SolanaRpcTransportError && e.fault === "timeout")', "false", RETRY],
  [PRICE, '(e instanceof SolanaRpcTransportError && e.fault === "timeout")', "e instanceof SolanaRpcTransportError", RETRY],
  [PRICE, "const waitMs = POOL_USD_RETRY_BACKOFF_MS * 2 ** (tries - 1);", "const waitMs = 0;", RETRY],
  [PRICE, "const waitMs = POOL_USD_RETRY_BACKOFF_MS * 2 ** (tries - 1);", "const waitMs = POOL_USD_RETRY_BACKOFF_MS;", RETRY],
  [PRICE, "if (Date.now() + waitMs >= bound.end) return fail(", "if (false) return fail(", RETRY],
  [PRICE, "Math.min(POOL_USD_CALL_TIMEOUT_MS, left)", "POOL_USD_CALL_TIMEOUT_MS", RETRY],
  [PRICE, "export const POOL_USD_READ_DEADLINE_MS = 12_000;", "export const POOL_USD_READ_DEADLINE_MS = 120_000;", RETRY],
  // one bound for the whole read: every round of the Pyth read, and each Chainlink read, Robinhood's and Base's beside it
  [PRICE, "`rpc ${k} getMultipleAccounts`, bound)", "`rpc ${k} getMultipleAccounts`, { ...bound, end: Date.now() + POOL_USD_READ_DEADLINE_MS })", RETRY],
  [PRICE, "readPythOnce(rpcs[0], 0, feed.account, min, bound), readPythOnce(rpcs[1], 1, feed.account, min, bound)", "readPythOnce(rpcs[0], 0, feed.account, min, { ...bound, end: Date.now() + POOL_USD_READ_DEADLINE_MS }), readPythOnce(rpcs[1], 1, feed.account, min, { ...bound, end: Date.now() + POOL_USD_READ_DEADLINE_MS })", RETRY],
  [PRICE, 'if (chain !== "robinhood") return chainlinkPrice(chain as "base", feed, rpcs, nowS, bound);', 'if (chain !== "robinhood") return chainlinkPrice(chain as "base", feed, rpcs, nowS, { ...bound, end: Infinity });', RETRY],
  [PRICE, "`rpc ${k} eth_chainId`, bound)", "`rpc ${k} eth_chainId`, { ...bound, end: Infinity })", RETRY],
  [PRICE, 'chainlinkPrice("robinhood", feed, rpcs, nowS, bound)', 'chainlinkPrice("robinhood", feed, rpcs, nowS, { ...bound, end: Infinity })', RETRY],
  // only a timeout of the provider's client is slow: its other faults, already retried there, fail the read at once
  [PRICE, '(e instanceof SolanaRpcTransportError && e.fault === "timeout")', '(e instanceof SolanaRpcTransportError && e.fault !== "http_429")', RETRY],
  // a read that has ended asks no provider again
  [PRICE, "    bound.stopped = true;\n", "", RETRY],
  [PRICE, "if (bound.stopped) return fail(", "if (false) return fail(", RETRY],
  // a Token-2022 mint that lists one extension type twice
  [BUY, "if (seen.has(type)) throw", "if (false) throw", T22, BUY_TEST],
  [BUY, "    seen.add(type);\n", "", T22, BUY_TEST],
  // S6 on a shared route: each side the wallet's own account or the authority's ATA, the source side unbounded, a
  // Token-2022 destination through the authority's ATA only for a mint read equal on both providers without a transfer
  // fee or hook
  [S6, "if (key === solanaAta(c.req.wallet, mint, tp)) return;", "if (false) return;", "every recorded shared-route build passes", S6_TEST],
  [S6, "if (key !== solanaAta(pa, mint, tp)) { wrong.push(", "if (false) { wrong.push(", "Token-2022 sell", S6_TEST],
  [S6, "if (tp !== SOLANA_TOKEN_2022_PROGRAM) return;", "return;", "S6 refused", S6_TEST],
  [S6, "if (tp !== SOLANA_TOKEN_2022_PROGRAM) return;", "if (what !== \"destination\" || tp !== SOLANA_TOKEN_2022_PROGRAM) return;", "S6 refused: the recorded transfer-fee", S6_TEST],
  [S6, "if (tp !== SOLANA_TOKEN_2022_PROGRAM) return;", "if (what !== \"source\" || tp !== SOLANA_TOKEN_2022_PROGRAM) return;", "S6 refused: the recorded transfer-fee", S6_TEST],
  [S6, "  if (tp !== SOLANA_TOKEN_2022_PROGRAM) return;\n", "", "S6 pass: through the wallet's own", S6_TEST],
  [S6, "if (why) wrong.push(", "if (false) wrong.push(", "S6 refused", S6_TEST],
  [S6, "if (!a || !b) return \"the mint is not read", "if (!a) return \"the mint is not read", "S6 refused: the mint not read", S6_TEST],
  [S6, "if (a.owner !== b.owner || !eqBytes(a.data, b.data)) return \"the providers disagree", "if (!eqBytes(a.data, b.data)) return \"the providers disagree", "S6 refused: the providers disagree on the owner", S6_TEST],
  [S6, "if (a.owner !== b.owner || !eqBytes(a.data, b.data)) return \"the providers disagree", "if (a.owner !== b.owner) return \"the providers disagree", "S6 refused: the providers disagree: B reads", S6_TEST],
  [S6, "  if (d.length === 82) return null;\n", "", "S6 pass: every", S6_TEST],
  [S6, "if (d.length < 166 || d[165] !== 1) return `the mint of", "if (d.length < 166) return `the mint of", "S6 refused: no mint account type", S6_TEST],
  [S6, "if (o + 4 + len > d.length) return `the mint's extension", "if (false) return `the mint's extension", "S6 refused: an extension that runs past", S6_TEST],
  [S6, "if (type === EXT_TRANSFER_FEE_CONFIG) {", "if (false) {", "S6 refused: a transfer-fee mint", S6_TEST],
  [S6, "if (type === EXT_TRANSFER_HOOK) {", "if (false) {", "S6 refused: a transfer-hook mint", S6_TEST],
  [S6, "u16(d, slot + 16) !== 0 && u64(d, slot + 8) !== 0n", "true", "S6 pass: a fee config", S6_TEST],
  [S6, " && u64(d, slot + 8) !== 0n", "", "S6 pass: a fee config", S6_TEST],
  [S6, "u16(d, slot + 16) !== 0 && ", "", "S6 pass: a fee config", S6_TEST],
  [S6, "feeCharged(d, body + 72) || ", "", "S6 refused: a fee in the older slot only", S6_TEST],
  [S6, " || feeCharged(d, body + 90)", "", "S6 refused: a fee in the newer slot only", S6_TEST],
  [S6, "if (len !== 108) return", "if (false) return", "S6 refused: a fee config of 107 bytes", S6_TEST],
  [S6, "if (len !== 64) return", "if (false) return", "S6 refused: a transfer hook of 63 bytes", S6_TEST],
  [S6, "d.subarray(body + 32, body + 64).some((x) => x !== 0)", "d.subarray(body, body + 32).some((x) => x !== 0)", "S6 refused: a hook program with no hook authority", S6_TEST],
  [S6, "if (o !== d.length && d.subarray(o).some((x) => x !== 0)) return \"the mint has bytes", "if (false) return \"the mint has bytes", "S6 refused: bytes after", S6_TEST],
  [S6, "u16(d, slot + 16) !== 0 &&", "(d[slot + 16] as number) !== 0 &&", "S6 refused: a fee of 256 bps", S6_TEST],
  [S6, "d.subarray(body + 32, body + 64).some((x) => x !== 0)", "d.subarray(body + 32, body + 64).every((x) => x !== 0)", "S6 refused: a hook program whose last byte alone is set", S6_TEST],
  [S6, "d.subarray(body + 32, body + 64).some((x) => x !== 0)", "d[body + 32] !== 0", "S6 refused: a hook program whose first byte is 0", S6_TEST],
  [S6, "      if (feeCharged(d, body + 72) || feeCharged(d, body + 90)) return \"the mint charges a transfer fee (TransferFeeConfig)\";\n    }", "      if (feeCharged(d, body + 72) || feeCharged(d, body + 90)) return \"the mint charges a transfer fee (TransferFeeConfig)\";\n      return null;\n    }", "S6 refused: a zero fee config followed by a hook program", S6_TEST],
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
