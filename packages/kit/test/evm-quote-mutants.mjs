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
  [QUOTE, 'fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route', "fills(c) ? [{ route: c.route", Q, "Q3 "],
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
  [QUOTE, "for (const h of v.hookedPools) {\n      const from = h.from === \"native\" ? NATIVE : v.weth;", "for (const h of [] as typeof v.hookedPools) {\n      const from = h.from === \"native\" ? NATIVE : v.weth;", R, "R9 "],
  [QUOTE, 'const from = h.from === "native" ? NATIVE : v.weth;', "const from = NATIVE;", R, "R9 "],
  [QUOTE, 'if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");', "if (reference === null) return refuse(\"no_quote\", \"\");", R, "R4 "],
  // the union (review of 9a8265b, N1): the device's scan, the caller's list and the PoolManager's state of each
  [QUOTE, "for (const k of keys) {", "for (const k of [] as EvmPoolKey[]) {", R, "N1a "],
  // review of f44fbdb: every key's state before any bound, bounds by depth, the backstop, the fetch timeout, the full reference
  [QUOTE, "for (const k of keys) {", "for (const k of keys.slice(0, EVM_QUOTE_MAX_FOUND)) {", R, "T1 "],
  [QUOTE, "if (keys.length > EVM_QUOTE_MAX_KEYS) return refuse(", "if (false) return refuse(", R, "T1b "],
  [QUOTE, "(a.d > b.d ? -1 : a.d < b.d ? 1 : a.i - b.i)", "(a.i - b.i)", R, "X2 "],
  [QUOTE, "const xs = deepest([...xDeep.keys()], (x) => xDeep.get(x)!).slice(0, EVM_QUOTE_MAX_OTHER);", "const xs = deepest([...xDeep.keys()], (x) => xDeep.get(x)!);", R, "X2 "],
  [QUOTE, "    if (ks.size > budget) return null;\n", "", R, "X3 "],
  [QUOTE, "if (ms.length === 0) for (const via of", "if (false) for (const via of", R, "T3 "],
  [QUOTE, "const deeper = unpriced.find((f) => r === null || d(stateOf(f))! > r);", "const deeper = unpriced.find(() => false);", R, "K1b "],
  [QUOTE, "const deeper = unpriced.find((f) => r === null || d(stateOf(f))! > r);", "const deeper = unpriced.find((f) => r === null || d(stateOf(f))! < r);", R, "K1 "],
  [QUOTE, "    if (priced.length === 0) unpriced.push(f);\n", "", R, "K1b "],
  [QUOTE, "const pool = b.pool ?? lastPool(b.route, fifth);", "const pool = b.pool;", R, "K1 "],
  [QUOTE, ", signal: AbortSignal.timeout(timeoutMs) }", " }", R, "T4 "],
  [QUOTE, "  if (r.length !== 2 + 2 * (64 + 32 * n)) return refuse(", "  if (false) return refuse(", R, "T6 "],
  [QUOTE, "hops: [hopTo(ys.c, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)]", "hops: [hopTo(x, via.key), hopTo(lower(token), p.key)]", R, "T5 "],
  [QUOTE, "const keys = [...(scanned?.pools ?? []), ...hints].filter(", "const keys = [...hints].filter(", R, "N1a "],
  [QUOTE, "const hints = (Array.isArray(req.pools) ?", "const hints = (false ?", R, "N1b "],
  [QUOTE, "const from = cached === undefined || cached.to < floor ? floor : cached.to + 1;", "const from = floor;", R, "N1a "],
  [QUOTE, "if (!Array.isArray(r) || r.length > SCAN_MAX_LOGS) return refuse(", "if (false) return refuse(", R, "N1a "],
  [QUOTE, "return p !== null && (p & ((1n << 160n) - 1n)) !== 0n && l !== null && (l & ((1n << 128n) - 1n)) !== 0n;", "return true;", R, "N1d "],
  [QUOTE, "(p & ((1n << 160n) - 1n)) !== 0n &&", "", R, "N1d "],
  [QUOTE, " && (l & ((1n << 128n) - 1n)) !== 0n;", ";", R, "N1d "],
  [QUOTE, "const POOLS_SLOT = 6n;", "const POOLS_SLOT = 7n;", R, "N1b "],
  [QUOTE, "const replaced = (h: string) => h !== NATIVE && !pinned.has(h);", "const replaced = (h: string) => false;", R, "N1e "],
  [QUOTE, "const hs = [...new Set(hooks.filter(replaced))].sort();", "const hs: string[] = [];", R, "N1e "],
  // the scan reads Initialize's currencies (topics 2 and 3), up to the agreed block, kept once the block is confirmed
  [QUOTE, 'f(["0x" + INITIALIZE, null, null, t])', 'f(["0x" + INITIALIZE, t])', R, "N1a "],
  [QUOTE, "if (scanHead - b > maxLag || b - scanHead > maxLag) return refuse(", "if (false) return refuse(", R, "S2 "],
  [QUOTE, "  scanned?.commit();", "", R, "N1a "],
  [QUOTE, "  return { pools, commit };", "  commit();\n  return { pools, commit };", R, "S2b "],
  // review of 5452011: no override for a pool the PoolManager does not hold, one hook per override, never an address
  // the reads call; the route's own pools are not R; pools of other currencies priced through them, bounded
  [QUOTE, "deepest(held.filter((f) => startsBuy(f.other)), inToken)", "deepest(found.filter((f) => startsBuy(f.other)), inToken)", R, "S1c "],
  [QUOTE, "groups.set(r.group, [...(groups.get(r.group) ?? []), i]);", 'groups.set("one", [...(groups.get("one") ?? []), i]);', R, "S1c "],
  [QUOTE, "(v.called.has(k.hooks) || k.hooks", "(k.hooks", R, "S1e "],
  [QUOTE, "k.hooks !== NATIVE && (v.called.has", "(v.called.has", R, "H1 "],
  [QUOTE, "if (hooks.some((h) => v.called.has(h) || h === lower(token))) return refuse(", "if (false) return refuse(", R, "S1d "],
  [QUOTE, '...v.routers, own("v3"), own("v4"), pin("poolManager")', '...v.routers, own("v3"), pin("poolManager")', R, "S1e "],
  [QUOTE, '  for (const k of route.venue === "uniswap-v4" ? hopKeys(route) : []) seen.add(poolId(k));', "", R, "L1 "],
  [QUOTE, "  if (c0 !== t && c1 !== t) return null;", "  if (![c0, c1].includes(NATIVE) || (c0 !== t && c1 !== t)) return null;", R, "S3 "],
  // X's markets: the deepest X first, at most EVM_QUOTE_MAX_OTHER; a market whose hook is replaced only once it exists,
  // in one override with the pool's hook
  [QUOTE, "const xs = deepest([...xDeep.keys()], (x) => xDeep.get(x)!).slice(0, EVM_QUOTE_MAX_OTHER);", "const xs = [...xDeep.keys()].reverse().slice(0, EVM_QUOTE_MAX_OTHER);", R, "X1 "],
  [QUOTE, "deepest(side.markets.filter(holds), (m) => depthIn(m, side.c))", "deepest(side.markets, (m) => depthIn(m, side.c))", R, "S3c "],
  [QUOTE, "v4At(r, amountIn, [mk.key.hooks, p.key.hooks], third), twice: v4At(r, 2n * amountIn, [mk.key.hooks, p.key.hooks], third)", "v4At(r, amountIn, [p.key.hooks], third), twice: v4At(r, 2n * amountIn, [p.key.hooks], third)", R, "S3c "],
  // every scan of a quote shares one gate and one head; X's scan failing refuses the quote
  [QUOTE, "v.maxLag, gate, (headOfScan ??= scanHeadOf(scan, gate)))", "v.maxLag, gateOf(v.scan.parallel), (headOfScan ??= scanHeadOf(scan, gate)))", R, "G1 "],
  [QUOTE, "(headOfScan ??= scanHeadOf(scan, gate))", "scanHeadOf(scan, gate)", R, "G3 "],
  [QUOTE, "await Promise.all(xs.map((x) => scanOf(x)));", "await Promise.all(xs.map((x) => (scanOf(x) ?? Promise.resolve(null)).catch(() => null)));", R, "G2 "],
  [QUOTE, "if (next === undefined) free++;\n      else next();", "free++;\n      next?.();", R, "G1 "],
  [QUOTE, "(startsBuy(f.other) ? side.markets : side.vias).push(f);", "side.markets.push(f);", R, "K2 "],
  // the hook's take, and minOut from the route the hook runs in
  [QUOTE, "const take = h === null ? null : h > q ? h - q : 0n;", "const take = h === null ? null : h - q;", Q, "Q4 "],
  [QUOTE, "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h)", "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / q)", Q, "Q4 "],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = ((hook?.hookless ?? q) * BigInt(10000 - slippageBps)) / 10000n;", Q, "Q4 "],
  [QUOTE, "(r.override === undefined && r.state !== true ? [i] : [])", "(r.state !== true ? [i] : [])", Q, "Q4 "],
  [QUOTE, "const minOut = (q * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = q;", Q, "Q1 "],
  [QUOTE, 'if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");', "", Q, "Q10 "],
  // native first
  [QUOTE, "  if (nativeExists && wethStart && (nativeBest === null || q <= nativeBest.amountOut)) {", "  if (false) {", Q, "Q6 "],
  [QUOTE, 'nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true', "nativeFirst: false", Q, "Q6 "],
  [QUOTE, "const nativeBest = bestOf(filled.filter((c) => startsNative(c.route)));", "const nativeBest = bestOf(filled);", R, "N3a "],
  // native when at least as good: a WETH route equal to the best native route still refuses
  [QUOTE, "q <= nativeBest.amountOut", "q < nativeBest.amountOut", R, "N3b "],
  [QUOTE, "q <= nativeBest.amountOut", "q <= nativeBest.amountOut && false", R, "N3b "],
  [QUOTE, "(nativeBest === null || q <= nativeBest.amountOut)", "(nativeBest !== null && q <= nativeBest.amountOut)", R, "R7 "],
  [QUOTE, "  const reference = bestOf(filled);", "  const reference = bestOf(filled.filter((c) => !nativeExists || startsNative(c.route)));", R, "N1f "],
  [QUOTE, "|| firstHop.some((c) => fills(c)))", ")", R, "R7 "],
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
  [QUOTE, 'if (typeof url !== "string" || !/^https:\\/\\//.test(url)) return refuse(', "if (false) return refuse(", Q, "Q8 "],
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
