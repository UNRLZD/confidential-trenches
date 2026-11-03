// Removes each of the EVM buy quote's checks (src/checks/evm/quote.ts, and the quoted builder and signer in
// src/trade/evm/buy.ts), one at a time, and runs the test named for it in test/evm-quote.test.ts or
// test/evm-quote-attacks.test.ts: each named test passes on the code as it is and fails on every mutant. The mutants are
// made in a copy of the kit's sources and tests in a fresh temporary folder inside the kit (so the copy resolves the
// same installed modules), removed at the end; the tree's own files are never changed. Exits 1 when a named test passes on its
// mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly once.
//   node packages/kit/test/evm-quote-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const QUOTE = "src/checks/evm/quote.ts";
const BUY = "src/trade/evm/buy.ts";
const Q = "test/evm-quote.test.ts";
const R = "test/evm-quote-attacks.test.ts";

// [file, text, replacement, test file, the test that must fail]
export const MUTANTS = [
  // two providers at one block they both hold, no more than 30 s old
  [QUOTE, 'const same = a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial;', "const same = true;", Q, "Q2 "],
  [QUOTE, 'b.kind === "out" && a.amountOut === b.amountOut', 'b.kind === "out"', Q, "Q2 "],
  [QUOTE, 'b.kind === "revert" && a.partial === b.partial', 'b.kind === "revert"', Q, "Q2 "],
  [QUOTE, "const at = { blockHash: hash, requireCanonical: true };", "const at = { blockHash: hash };", Q, "Q1 "],
  [QUOTE, "if (a.number - b.number > maxLag || b.number - a.number > maxLag) return refuse(", "if (false) return refuse(", R, "R5 "],
  [QUOTE, "if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp) {", "if (false) {", R, "R1b "],
  [QUOTE, "back.number !== lo.number || back.hash !== lo.hash || back.timestamp", "back.number !== lo.number || back.timestamp", R, "R5 "],
  [QUOTE, " || back.timestamp !== lo.timestamp) {", ") {", R, "R5 "],
  [QUOTE, '? [a, rpcs[1], "provider 2"] : [b, rpcs[0], "provider 1"]', '? [a, rpcs[0], "provider 2"] : [b, rpcs[1], "provider 1"]', R, "R5 "],
  [QUOTE, 'if (confirmed.status === "rejected") throw confirmed.reason;', "", R, "R1b "],
  [QUOTE, "  if (!behind) return out;", "  return out;", R, "R10 "],
  [QUOTE, "if (nowMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (false) return refuse(", Q, "Q14 "],
  [QUOTE, "if (nowMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (nowMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS + 1000) return refuse(", R, "R6 "],
  [QUOTE, 'if (!Number.isFinite(nowMs)) return refuse("bad_request", "the device\'s clock");', "", Q, "Q14 "],
  [QUOTE, "maxLag: Object.hasOwn(v, \"maxLag\") && Number.isSafeInteger(v.maxLag) ? BigInt(v.maxLag!) : 0n,", "maxLag: 1000n,", R, "R5 "],
  // a partial fill
  [QUOTE, 'if (m.kind === "revert" && m.partial) return refuse("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");', "", Q, "Q3 "],
  [QUOTE, "d.slice(8 + 128, 8 + 128 + 8) === NOT_ENOUGH_LIQUIDITY", "d.slice(8 + 64, 8 + 64 + 8) === NOT_ENOUGH_LIQUIDITY", Q, "Q3 "],
  [QUOTE, "if (q2 !== null && q2 <= q) return refuse(", "if (q2 !== null && q2 < q) return refuse(", Q, "Q3 "],
  [QUOTE, "if (q2 !== null && q2 <= q) return refuse(", "if (false) return refuse(", Q, "Q3 "],
  [QUOTE, 'if (q2 === null && route.venue === "uniswap-v3") return refuse(', "if (false) return refuse(", R, "R8 "],
  [QUOTE, "return a !== null && a > 0n && (b === null ? !v3 : b > a);", "return a !== null && a > 0n && (b === null ? true : b > a);", Q, "Q3 "],
  [QUOTE, "return a !== null && a > 0n && (b === null ? !v3 : b > a);", "return a !== null && a > 0n && (b === null ? !v3 : true);", Q, "Q3 "],
  [QUOTE, '(fills(c, c.route.venue === "uniswap-v3") ?', "(fills(c) ?", Q, "Q3 "],
  // the device's own reference: every standard route through every listed middle on both venues, and the pinned
  // launchpad pools
  [QUOTE, "  if (q < reference.amountOut) {", "  if (false) {", Q, "Q5 "],
  [QUOTE, "  if (q < reference.amountOut) {", "  if (q <= reference.amountOut) {", Q, "Q1 "],
  [QUOTE, "(m === null || c.amountOut > m.amountOut ? c : m)", "(m === null || c.amountOut < m.amountOut ? c : m)", Q, "Q5 "],
  [QUOTE, "if (v.v3 !== undefined) for (const fee of V3_FEES) candidate(v3Direct(v.weth, token, fee));", "", Q, "Q5 "],
  [QUOTE, "if (v.v4 !== undefined) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));", "", Q, "Q5 "],
  [QUOTE, "for (const middle of v.middles) {", "for (const middle of [] as string[]) {", R, "R2 "],
  [QUOTE, "if (v.v3 !== undefined) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate(", "if (false) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate(", R, "R3 "],
  [QUOTE, "      for (const k2 of V4_KEYS) {", "      for (const k2 of [] as (readonly [number, number])[]) {", Q, "Q12 "],
  [QUOTE, "for (const h of v.hookedPools) {", "for (const h of [] as typeof v.hookedPools) {", R, "R9 "],
  [QUOTE, 'const from = h.from === "native" ? NATIVE : v.weth;', "const from = NATIVE;", R, "R9 "],
  [QUOTE, 'if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");', "if (reference === null) return refuse(\"no_quote\", \"\");", R, "R4 "],
  // the hook's take, and minOut from the route the hook runs in
  [QUOTE, "const take = h === null ? null : h > q ? h - q : 0n;", "const take = h === null ? null : h - q;", Q, "Q4 "],
  [QUOTE, "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h)", "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / q)", Q, "Q4 "],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = ((hook?.hookless ?? q) * BigInt(10000 - slippageBps)) / 10000n;", Q, "Q4 "],
  [QUOTE, "(r.override === undefined ? [i] : [])", "[i]", Q, "Q4 "],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = q;", Q, "Q1 "],
  [QUOTE, 'if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");', "", Q, "Q10 "],
  // native first
  [QUOTE, "  if (nativeExists && wethStart) return refuse(", "  if (false) return refuse(", Q, "Q6 "],
  [QUOTE, 'nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true', "nativeFirst: false", Q, "Q6 "],
  [QUOTE, "const pool = nativeExists ? filled.filter((c) => startsNative(c.route)) : filled;", "const pool = filled;", Q, "Q6 "],
  [QUOTE, "|| firstHop.some((c) => fills(c)))", ")", R, "R7 "],
  [
    QUOTE,
    '  if (nativeExists && wethStart) return refuse("native_first", `${chain}\'s WETH is behind an upgradeable proxy and a native v4 pool exists`, reference);\n  if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");',
    '  if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");\n  if (nativeExists && wethStart) return refuse("native_first", `${chain}\'s WETH is behind an upgradeable proxy and a native v4 pool exists`, reference);',
    R,
    "R7 ",
  ],
  // only a device quote builds, within 30 s, and W signs only that build
  [QUOTE, "QUOTED.add(quote);", "", Q, "Q7 "],
  [BUY, "if (!evmIsDeviceQuote(quote)) throw", "if (false) throw", Q, "Q7 "],
  [BUY, "if (!Number.isFinite(nowMs) || nowMs - Number(quote.block.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {", "if (!Number.isFinite(nowMs)) {", Q, "Q7 "],
  [BUY, "if (!QUOTED_BUILDS.has(built)) throw", "if (false) throw", Q, "Q7 "],
  // the request and the providers
  [QUOTE, "amountIn <= 0n || amountIn >= MAX_IN", "amountIn <= 0n", Q, "Q8 "],
  [QUOTE, "slippageBps < 0 || slippageBps >= 10000", "slippageBps < 0", Q, "Q8 "],
  [QUOTE, "|| rpcs[0] === rpcs[1]) {", ") {", Q, "Q8 "],
  [QUOTE, 'if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", Q, "Q8 "],
  [QUOTE, 'if (hosts[0] === hosts[1]) return refuse("bad_request", "the two providers are on one host");', "", Q, "Q8 "],
  [QUOTE, 'if (x.protocol !== "https:") throw new Error("not https");', "", Q, "Q8 "],
  // a provider's answer
  [QUOTE, "if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len)", "if (!Number.isSafeInteger(o) || o < 0)", Q, "Q9 "],
  [QUOTE, "if (e + 96 + dl > len) return refuse(", "if (false) return refuse(", Q, "Q9 "],
  [QUOTE, "if (!Array.isArray(out) || out.length !== calls.length)", "if (!Array.isArray(out))", Q, "Q9 "],
];

// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`
let lastFail = "";
function run(dir, file, name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, file];
  try {
    const out = execFileSync("node", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch (e) {
    lastFail = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 4).join("\n");
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // the copy: the kit's sources, tests and package file, with its installed modules linked
  const dir = mkdtempSync(join(KIT, ".evm-quote-mutants-"));
  let bad = 0;
  try {
    for (const p of ["src", "test", "package.json"]) cpSync(join(KIT, p), join(dir, p), { recursive: true });
    const src = new Map([QUOTE, BUY].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    for (const [file, t] of [...new Set(MUTANTS.map((m) => `${m[3]}\u0000${m[4]}`))].map((k) => k.split("\u0000"))) {
      const r = run(dir, file, t);
      if (r !== "pass") {
        console.log(`FAIL "${t}" in ${file} ${r === "none" ? "names no test" : `fails on the code as it is:\n${lastFail}`}`);
        bad++;
      }
    }
    if (bad === 0) {
      MUTANTS.forEach(([file, find, repl, tf, t], i) => {
        const s = src.get(file);
        if (s.split(find).length !== 2) {
          console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
          bad++;
          return;
        }
        writeFileSync(join(dir, file), s.replace(find, repl));
        const r = run(dir, tf, t);
        writeFileSync(join(dir, file), s);
        console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
        if (r !== "fail") bad++;
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
