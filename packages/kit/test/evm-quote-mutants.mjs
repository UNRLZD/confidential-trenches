// Removes each of the EVM buy quote's checks (src/checks/evm/quote.ts, and the quoted builder in
// src/trade/evm/buy.ts), one at a time, and runs the test named for it in test/evm-quote.test.ts: each named test passes
// on the code as it is and fails on every mutant. A file is changed in place and put back after each mutant (and checked
// to be back); exits 1 when a named test passes on its mutant, fails or runs no test on the code as it is, or a mutant's
// text is not in its file exactly once.
//   node packages/kit/test/evm-quote-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const QUOTE = fileURLToPath(new URL("../src/checks/evm/quote.ts", import.meta.url));
const BUY = fileURLToPath(new URL("../src/trade/evm/buy.ts", import.meta.url));
const TEST = fileURLToPath(new URL("./evm-quote.test.ts", import.meta.url));

const AGREE = "Q1 ";
const DISAGREE = "Q2 ";
const PARTIAL = "Q3 ";
const HOOK = "Q4 ";
const BELOW = "Q5 ";
const NATIVE = "Q6 ";
const QUOTED = "Q7 ";
const REQUEST = "Q8 ";
const ANSWER = "Q9 ";
const MINOUT = "Q10 ";

// [file, text, replacement, the test that must fail]
export const MUTANTS = [
  // two providers at one block hash
  [QUOTE, 'const same = a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial;', "const same = true;", DISAGREE],
  [QUOTE, 'b.kind === "out" && a.amountOut === b.amountOut', 'b.kind === "out"', DISAGREE],
  [QUOTE, 'b.kind === "revert" && a.partial === b.partial', 'b.kind === "revert"', DISAGREE],
  [QUOTE, "const at = { blockHash: hash, requireCanonical: true };", "const at = { blockHash: hash };", AGREE],
  [QUOTE, "return a!.number <= b!.number ? a! : b!;", "return a!.number <= b!.number ? b! : a!;", AGREE],
  // a partial fill
  [QUOTE, 'if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");', "", PARTIAL],
  [QUOTE, "d.slice(8 + 128, 8 + 128 + 8) === NOT_ENOUGH_LIQUIDITY", "d.slice(8 + 64, 8 + 64 + 8) === NOT_ENOUGH_LIQUIDITY", PARTIAL],
  [QUOTE, "if (q2 !== null && q2 <= q) return refuse(", "if (q2 !== null && q2 < q) return refuse(", PARTIAL],
  [QUOTE, "if (q2 !== null && q2 <= q) return refuse(", "if (false) return refuse(", PARTIAL],
  [QUOTE, "return a !== null && a > 0n && (b === null || b > a);", "return a !== null && a > 0n;", PARTIAL],
  // the device's own reference
  [QUOTE, "if (reference !== null && q < reference.amountOut) {", "if (false) {", BELOW],
  [QUOTE, "if (reference !== null && q < reference.amountOut) {", "if (reference !== null && q <= reference.amountOut) {", AGREE],
  [QUOTE, "(m === null || c.amountOut > m.amountOut ? c : m)", "(m === null || c.amountOut < m.amountOut ? c : m)", BELOW],
  [QUOTE, "if (v.v4 !== undefined) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));", "", BELOW],
  // the hook's take, and minOut from the route the hook runs in
  [QUOTE, "const take = h === null ? null : h > q ? h - q : 0n;", "const take = h === null ? null : h - q;", HOOK],
  [QUOTE, "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h)", "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / q)", HOOK],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = ((hook?.hookless ?? q) * BigInt(10000 - slippageBps)) / 10000n;", HOOK],
  [QUOTE, '(r.override === undefined ? [i] : [])', "[i]", HOOK],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = q;", AGREE],
  [QUOTE, 'if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");', "", MINOUT],
  // native first
  [QUOTE, 'if (nativeExists && wethStart) return refuse("native_first",', 'if (false) return refuse("native_first",', NATIVE],
  [QUOTE, 'nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true', "nativeFirst: false", NATIVE],
  [QUOTE, "const pool = nativeExists ? filled.filter((c) => startsNative(c.route)) : filled;", "const pool = filled;", NATIVE],
  [QUOTE, "|| firstHop.some(fills)", "", NATIVE],
  // only a device quote builds
  [QUOTE, "QUOTED.add(quote);", "", QUOTED],
  [BUY, "if (!evmIsDeviceQuote(quote)) throw", "if (false) throw", QUOTED],
  // the request
  [QUOTE, "amountIn <= 0n || amountIn >= MAX_IN", "amountIn <= 0n", REQUEST],
  [QUOTE, "slippageBps < 0 || slippageBps >= 10000", "slippageBps < 0", REQUEST],
  [QUOTE, '|| rpcs[0] === rpcs[1]) {', ") {", REQUEST],
  [QUOTE, 'if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", REQUEST],
  // a provider's answer
  [QUOTE, "if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len)", "if (!Number.isSafeInteger(o) || o < 0)", ANSWER],
  [QUOTE, "return v > BigInt(len) ? refuse(", "return false ? refuse(", ANSWER],
  [QUOTE, "if (!Array.isArray(out) || out.length !== calls.length)", "if (!Array.isArray(out))", ANSWER],
];

// "pass", "fail" or "none" (no test ran) of the tests whose names start with `name`
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, TEST];
  try {
    const out = execFileSync("node", args, { stdio: "pipe", encoding: "utf8" });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = new Map([QUOTE, BUY].map((f) => [f, readFileSync(f, "utf8")]));
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[3]))) {
    const r = run(t);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([file, find, repl, t], i) => {
    const s = src.get(file);
    if (s.split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in ${file.split("/").pop()} exactly once`);
      bad++;
      return;
    }
    writeFileSync(file, s.replace(find, repl));
    let r;
    try {
      r = run(t);
    } finally {
      writeFileSync(file, s);
    }
    if (readFileSync(file, "utf8") !== s) throw new Error(`mutant ${i + 1} left ${file} changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
