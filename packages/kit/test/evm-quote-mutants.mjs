// Removes each of the EVM buy quote's checks (src/checks/evm/quote.ts, the quoted builder and signer in
// src/trade/evm/buy.ts, and the builder's admission of a device-quoted route's v4 middles in
// src/trade/evm/buy-unpinned.ts), one at a time, and runs the test named for it in test/evm-quote.test.ts or
// test/evm-quote-attacks.test.ts: each named test passes on the code as it is and fails on every mutant. The mutants are
// made in copies of the kit's sources and tests in fresh temporary folders inside the kit (so each copy resolves the
// same installed modules), removed at the end; the tree's own files are never changed. Exits 1 when a named test passes on its
// mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly once.
// The named tests are first run on the code as it is, all of one test file in one run; then the mutants, JOBS at once,
// each in its own copy (each run is mostly a process's start: about 1 s each, 279 one after another took 266 s and the
// named tests one by one 140 s on GitHub's runner, readme-fresh-run at 47109a7). Each line prints its time.
//   node packages/kit/test/evm-quote-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const QUOTE = "src/checks/evm/quote.ts";
const BUY = "src/trade/evm/buy.ts";
const BUYU = "src/trade/evm/buy-unpinned.ts";
const Q = "test/evm-quote.test.ts";
const R = "test/evm-quote-attacks.test.ts";
const H = "test/evm-quote-head.test.ts";
// the sell quote (card evm-sell-device-quote) and the index's sell builder and signer that take only one
const SELLQ = "src/trade/evm/sell.ts";
const S = "test/evm-sell-quote.test.ts";
// the sim sell's builder and signer (card evm-quote-exec-sim)
const SELLU = "src/trade/evm/sell-unpinned.ts";

// [file, text, replacement, test file, the test that must fail]
export const MUTANTS = [
  // two providers at one block they both hold, no more than 30 s old
  [QUOTE, 'const same = (a: Answer, b: Answer) => (a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial);', "const same = (a: Answer, b: Answer) => true;", Q, "Q2 "],
  [QUOTE, 'b.kind === "out" && a.amountOut === b.amountOut', 'b.kind === "out"', Q, "Q2 "],
  [QUOTE, 'b.kind === "revert" && a.partial === b.partial', 'b.kind === "revert"', Q, "Q2 "],
  [QUOTE, "const at = { blockHash: hash, requireCanonical: true };", "const at = { blockHash: hash };", Q, "Q1 "],
  [QUOTE, "const near = (x: Block, y: Block) => x.number - y.number <= maxLag && y.number - x.number <= maxLag;", "const near = (x: Block, y: Block) => true;", R, "R5 "],
  [QUOTE, "if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp || back.baseFeePerGas !== lo.baseFeePerGas) {", "if (false) {", R, "R1b "],
  [QUOTE, "back.number !== lo.number || back.hash !== lo.hash || back.timestamp", "back.number !== lo.number || back.timestamp", R, "R5 "],
  [QUOTE, " || back.timestamp !== lo.timestamp || back.baseFeePerGas", " || back.baseFeePerGas", R, "R5 "],
  [QUOTE, "const [lo, at] = a.number <= b.number ? [a, j] : [b, i];", "const [lo, at] = a.number <= b.number ? [a, i] : [b, j];", R, "R5 "],
  [QUOTE, 'if (confirmed.status === "rejected") throw confirmed.reason;', "", R, "R1b "],
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
  [QUOTE, "return x !== null && x > 0n && (y === null ? !isV3 : y > x);", "return x !== null && x > 0n && (y === null ? true : y > x);", Q, "Q3 "],
  [QUOTE, "return x !== null && x > 0n && (y === null ? !isV3 : y > x);", "return x !== null && x > 0n && (y === null ? !isV3 : true);", Q, "Q3 "],
  [QUOTE, 'fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route', "fills(c) ? [{ route: c.route", Q, "Q3 "],
  // the device's own reference: every standard route through every listed middle on both venues, and the pinned
  // launchpad pools
  [QUOTE, "  if (q < reference.amountOut) {", "  if (false) {", Q, "Q5 "],
  [QUOTE, "  if (q < reference.amountOut) {", "  if (q <= reference.amountOut) {", Q, "Q1 "],
  [QUOTE, "(m === null || c.amountOut > m.amountOut ? c : m)", "(m === null || c.amountOut < m.amountOut ? c : m)", Q, "Q5 "],
  [QUOTE, "if (v3) for (const fee of V3_FEES) candidate(v3Direct(v.weth, token, fee));", "", Q, "Q5 "],
  [QUOTE, "if (v4) for (const key of V4_KEYS) candidate(v4Direct(NATIVE, token, key));", "", Q, "Q5 "],
  [QUOTE, "for (const middle of v.middles) {", "for (const middle of [] as string[]) {", R, "R2 "],
  [QUOTE, "if (v3) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate(", "if (false) for (const f1 of V3_FEES) for (const f2 of V3_FEES) candidate(", R, "R3 "],
  [QUOTE, "      for (const k2 of V4_KEYS) {", "      for (const k2 of [] as (readonly [number, number])[]) {", Q, "Q12 "],
  [QUOTE, "for (const h of v.hookedPools) {\n      // never a pool whose hook is the token itself", "for (const h of [] as typeof v.hookedPools) {\n      // never a pool whose hook is the token itself", R, "R9 "],
  [QUOTE, 'const from = h.from === "native" ? NATIVE : v.weth;', "const from = NATIVE;", R, "R9 "],
  [QUOTE, 'if (reference === null) return refuse("no_reference", "no standard pool and no pinned launchpad pool answers for the token");', "if (reference === null) return refuse(\"no_quote\", \"\");", R, "R4 "],
  // the union (review of 9a8265b, N1): the device's scan, the caller's list and the PoolManager's state of each
  [QUOTE, ", signal: AbortSignal.timeout(timeoutMs) }", " }", R, "T4 "],
  [QUOTE, "  if (r.length !== 2 + 2 * (64 + 32 * n)) return refuse(", "  if (false) return refuse(", R, "T6 "],
  [QUOTE, "const hints = (Array.isArray(a.hints) ?", "const hints = (false ?", R, "N1b "],
  [QUOTE, "if (!fine(rs)) return refuse(", "if (false) return refuse(", R, "N1a "],
  // card evm-quote-head-watch: a scan request that fails or overflows is asked by halves; one ending past maxLag behind
  // the agreed block is scanned on to it
  [QUOTE, "rs.every((r) => Array.isArray(r) && r.length < SCAN_MAX_LOGS)", "rs.every((r) => Array.isArray(r))", R, "card evm-quote-head-watch: a scan provider that fails a full span"],
  // review of 4830f1f: H1 the catch-up only on a backend that holds the agreed block (card evm-quote-one-round: by its
  // hash in each request's batch, review of a9f1d32, MEDIUM); L its depth, an answer at the cap asked by halves, the hold
  // timed on a clock that never steps back; H2 a cut set refuses
  [QUOTE, 'if (typeof h?.hash !== "string" || lower(h.hash) !== p.hash) return refuse(', "if (false) return refuse(", R, "review of a9f1d32, MEDIUM"],
  [QUOTE, "    pin = agreedAt;\n", "", R, "review of a9f1d32, MEDIUM"],
  [QUOTE, "    if (b - scanHead > BigInt(s.span)) return refuse(", "    if (false) return refuse(", R, "review of 4830f1f, L"],
  [QUOTE, "r.length < SCAN_MAX_LOGS)", "r.length <= SCAN_MAX_LOGS)", R, "review of 4830f1f, L"],
  [QUOTE, "      const m = mono();\n      const since = h === null ? -1 : m - h.at;\n      if (h !== null && since >= 0 && ", "      const m = clock();\n      const since = h === null ? -1 : m - h.at;\n      if (h !== null && ", H, "held head (review of 4830f1f, L)"],
  // card evm-quote-one-round (review of c71a4d0..a9f1d32): every bound refuses, never cuts; the caller's list beside it
  [QUOTE, "    if (fromScan.length > keysLeft) return refuse(", "    if (false) return refuse(", R, "KB2 "],
  [QUOTE, "if (fromScan.length > keysLeft)", "if (keys.length > keysLeft)", R, "KB1 "],
  [QUOTE, 'if (ks.size > keysLeft) return refuse("too_many_pools", `the markets of', 'if (false) return refuse("too_many_pools", `the markets of', R, "KB3 "],
  [QUOTE, "      if (ks.length > keysLeft) return refuse(", "      if (false) return refuse(", R, "KB4 "],
  // the prune (review of 13a063e): a buy's pool, market or via dropped only where its bound (the amount at its spot
  // price after its fee) cannot give Q, a pinned hook never; every pool kept quoted, past the budgets a refusal
  [QUOTE, "    floor: (out) => out(main)!,\n", "", R, "RK3 "],
  [QUOTE, "    if (x === null || (f.key.hooks !== NATIVE && !replaced(f.key))) return null;", "    if (x === null) return null;", R, "PROBE C "],
  [QUOTE, "    const y = cdiv(x * (1_000_000n - (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", "    const y = x;", R, "RK3 "],
  [QUOTE, "    const y = cdiv(x * (1_000_000n - (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", "    const y = cdiv(x * (1_000_000n - 2n * (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", R, "RK8 "],
  [QUOTE, "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 192n, p * p);", "    return zf(f) ? cdiv(y * p * p, 1n << 193n) : cdiv(y << 192n, p * p);", R, "RK8 "],
  [QUOTE, "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 192n, p * p);", "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 191n, p * p);", R, "RK8 "],
  [QUOTE, "  const zf = (f: Found) => f.other === f.key.currency0;", "  const zf = (f: Found) => f.other !== f.key.currency0;", R, "RK3 "],
  [QUOTE, "    return u === null || u >= floor;", "    return u !== null && u >= floor;", R, "PROBE C "],
  [QUOTE, "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn)) f.quotes.push(", "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn / 1000n)) f.quotes.push(", R, "PROBE D "],
  [QUOTE, "      if (!can(p, xa)) continue;\n      p.quotes.push(quoteOf(fourth,", "      if (!can(p, xa / 1000n)) continue;\n      p.quotes.push(quoteOf(fourth,", R, "PROBE A "],
  [QUOTE, "        if (marketQuote.has(mk) || !needs(c, ubOf(mk, amountIn))) continue;", "        if (marketQuote.has(mk) || !needs(c, ubOf(mk, amountIn / 1000n))) continue;", R, "PROBE A2 "],
  [QUOTE, "    (xPools.get(c) ?? []).some((p) => can(p, x)) ||", "    false ||", R, "PROBE A2 "],
  [QUOTE, "    [...vias].some(([x2, fs]) => fs.some((via) => via.other === c && (xPools.get(x2) ?? []).some((p) => can(p, ubOf(via, x)))));", "    false;", R, "RK7 "],
  [QUOTE, "(xPools.get(x2) ?? []).some((p) => can(p, ubOf(via, x)))", "(xPools.get(x2) ?? []).some((p) => can(p, ubOf(via, x === null ? null : x / 1000n)))", R, "PROBE E "],
  [QUOTE, "      const xa = ubOf(via, out(marketQuote.get(mk)!.at)!);", "      const xa = out(marketQuote.get(mk)!.at)! / 1000n;", R, "PROBE E "],
  [QUOTE, "  for (const [x, fs] of vias) vias.set(x, fs.filter(holds));", "  for (const [x, fs] of vias) vias.set(x, fs.filter(holds).slice(0, 4));", R, "RK7 "],
  [QUOTE, "    if (quotesLeft-- === 0) return refuse(", "    if (false) return refuse(", R, "card evm-quote-one-round: pools that cannot beat"],
  [QUOTE, "export const EVM_QUOTE_MAX_QUOTED = 1_024;", "export const EVM_QUOTE_MAX_QUOTED = 2_048;", R, "card evm-quote-one-round: pools that cannot beat"],
  [QUOTE, "    if (n > EVM_QUOTE_MAX_OTHER) return refuse(", "    if (false) return refuse(", R, "card evm-quote-one-round: pools that cannot beat"],
  [QUOTE, "  priced(xs.length + ys.filter((y) => !xs.includes(y)).length);", "  priced(xs.length);", R, "card evm-quote-one-round: pools that cannot beat"],
  [QUOTE, "export const EVM_QUOTE_MAX_OTHER = 1_024;", "export const EVM_QUOTE_MAX_OTHER = 2_048;", R, "card evm-quote-one-round: pools that cannot beat"],
  [QUOTE, "export const EVM_QUOTE_MAX_KEYS = 65_536;", "export const EVM_QUOTE_MAX_KEYS = 16_384;", R, "review of a9f1d32, HIGH: 16,000 and 16,381"],
  [QUOTE, "export const EVM_QUOTE_MAX_KEYS = 65_536;", "export const EVM_QUOTE_MAX_KEYS = 16_384;", R, "T1b "],
  [QUOTE, "  const asked: EvmPoolSellQuoteRequest = { ...req };", "  const asked: EvmPoolSellQuoteRequest = req;", S, "the sell quote reads each field"],
  [QUOTE, "if (rs !== null && fine(rs)) return void keep(rs);", "if (rs !== null) return void keep(rs);", R, "card evm-quote-head-watch: a scan provider that fails a full span"],
  [QUOTE, "  if (b - scanHead > maxLag) {", "  if (false) {", R, "card evm-quote-head-watch: a scan that ends more than maxLag"],
  [QUOTE, '  const scanned = await scanOf([lower(token)], "all");', '  void agreedOnce();\n  const scanned = await scanOf([lower(token)], "all");', R, "card evm-quote-head-watch: the agreed block is picked once"],
  // the held head: reused only while read under EVM_HEAD_REUSE_MS ago, and held only once confirmed by number
  [QUOTE, "since >= 0 && since <= EVM_HEAD_REUSE_MS && ", "", H, "held head: read more than"],
  // a held head is reused only while fresh on both clocks: its age when read plus the time since, and the device's clock
  [QUOTE, "h.age + since <= EVM_QUOTE_MAX_AGE_MS && ", "", H, "held head: under 5 s since"],
  [QUOTE, " && t - Number(h.block.timestamp) * 1000 <= EVM_QUOTE_MAX_AGE_MS", "", H, "held head: a device asleep"],
  [QUOTE, "          await a.confirm();\n          hold(a.block, m, t);", "          hold(a.block, m, t);\n          await a.confirm();", H, "held head: a block the other provider"],
  [QUOTE, "return p !== null && (p & ((1n << 160n) - 1n)) !== 0n && l !== null && (l & ((1n << 128n) - 1n)) !== 0n;", "return true;", R, "N1d "],
  [QUOTE, "(p & ((1n << 160n) - 1n)) !== 0n &&", "", R, "N1d "],
  [QUOTE, " && (l & ((1n << 128n) - 1n)) !== 0n;", ";", R, "N1d "],
  [QUOTE, "const POOLS_SLOT = 6n;", "const POOLS_SLOT = 7n;", R, "N1b "],
  [QUOTE, "=> k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing);", "=> false;", R, "N1e "],
  [QUOTE, "const hs = [...new Set(keys.filter(replaced).map((k) => k.hooks))].sort();", "const hs: string[] = [];", R, "N1e "],
  // card evm-route-parity: a pinned hook is trusted as it is only in a shape the sell builder takes (the old trust by
  // address alone)
  [QUOTE, "=> k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing);", "=> k.hooks !== NATIVE && !v.hookedPools.some((h) => lower(h.hooks) === k.hooks);", R, "P5 "],
  // the scan reads Initialize's currencies (topics 2 and 3), up to the agreed block, kept once the block is confirmed
  [QUOTE, "if (scanHead - b > maxLag) return refuse(", "if (false) return refuse(", R, "S2 "],
  [QUOTE, "  scanned?.commit();", "", R, "N1a "],
  // review of 5452011: no override for a pool the PoolManager does not hold, one hook per override, never an address
  // the reads call; the route's own pools are not R; pools of other currencies priced through them, bounded
  [QUOTE, "append(groups, r.group, i);", 'append(groups, "one", i);', R, "S1c "],
  [QUOTE, "(v.called.has(k.hooks) || k.hooks", "(k.hooks", R, "S1e "],
  [QUOTE, "k.hooks !== NATIVE && (v.called.has", "(v.called.has", R, "H1 "],
  [QUOTE, "if (hooks.some((h) => v.called.has(h) || h === lower(token))) return refuse(", "if (false) return refuse(", R, "S1d "],
  [QUOTE, '...v.routers, own("v3"), own("v4"), pin("poolManager")', '...v.routers, own("v3"), pin("poolManager")', R, "S1e "],
  // (no mutant leaves the route's own pools out of the found ones: since card evm-route-parity a route's pool is
  // hookless or of a listed launchpad shape, each read as it is, so its quote there equals the route's own and leaving
  // it out only saves reads)
  [QUOTE, "  if (c0 !== t && c1 !== t) return null;", "  if (![c0, c1].includes(NATIVE) || (c0 !== t && c1 !== t)) return null;", R, "S3 "],
  // every scan of a quote shares one gate and one head; X's scan failing refuses the quote
  // (no mutant gives each scan its own gate: the token's scan and the one scan of every X run one after the other, so
  // a gate per scan never has more in flight; G1 holds the gate's own limit)
  [QUOTE, "(headOfScan ??= scanHeadOf(scan, gate))", "scanHeadOf(scan, gate)", R, "G3 "],
  [QUOTE, "if (next === undefined) free++;\n      else next();", "free++;\n      next?.();", R, "G1 "],
  // review of 2afa8b6 (fold 8): every held pool and X priced at the user's amount within fixed-order bounds that never
  // refuse; a hooked route counts at the lower of its hook replaced and as it is; unlisted v4 middles of a device quote
  // build; scans as ORs within a provider's span; 429s asked again; each provider at most its limit at once
  [QUOTE, "    if (!behind || i === 3) return out;", "    return out;", R, "R10 "],
  [QUOTE, "for (const { k, id } of ordered) {", "for (const { k, id } of [] as typeof ordered) {", R, "N1a "],
  [QUOTE, "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn)) f.quotes.push(", "    if (false) f.quotes.push(", R, "A1 "],
  // (no mutant reads `found` for `held` here: a buy's pool the PoolManager does not hold reads a price of 0, which the
  // prune's bound reads as giving nothing, so it is never quoted and its hook never replaced; S1c holds that rule)
  [QUOTE, "      if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n      continue;", "      return refuse(\"no_reference\", `${x} has no market`);", R, "B1 "],
  [QUOTE, "      if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n", "", R, "T3 "],
  // the warm round (card evm-quote-warm-round): the last quote's later reads asked in the first round within the range,
  // each counted only where the quote asks it again; its scans started beside the token's; a connect failure asked again
  [QUOTE, "      const i = kept.get(readKey(r));", "      const i = undefined as number | undefined;", R, "W1 "],
  [QUOTE, "  if (plan !== undefined && block.timestamp >= plan.ts && block.timestamp - plan.ts <= EVM_WARM_RANGE_S) {", "  if (plan !== undefined) {", R, "W4 "],
  [QUOTE, "  PLANS.set(planKey, {", "  if (false) PLANS.set(planKey, {", R, "W1 "],
  [QUOTE, "(!kept.has(readKey(r)) || hit.has(first + j))", "(!kept.has(readKey(r)) || true)", R, "W5 "],
  [QUOTE, "filter((r, j) => r.override === undefined && (", "filter((r, j) => (", R, "W6 "],
  [QUOTE, "  const early = plan === undefined ? [] : plan.scans.map((p) => scanAt(p.cs, p.kind, true));", "  const early: ReturnType<typeof scanAt>[] = [];", R, "W1b "],
  [QUOTE, "if (e instanceof TypeError && typeof code === \"string\" && CONNECT_ERRORS.has(code)) throw new Unreachable(", "if (false) throw new Unreachable(", R, "T7b "],
  [QUOTE, "if (e instanceof TypeError && typeof code === \"string\" && CONNECT_ERRORS.has(code)) throw new Unreachable(", "if (e instanceof Error) throw new Unreachable(", R, "T7b "],
  [QUOTE, "if (e instanceof TypeError && typeof code === \"string\" && CONNECT_ERRORS.has(code)) throw new Unreachable(", "if (e instanceof TypeError) throw new Unreachable(", R, "T7b "],
  [QUOTE, "!(e instanceof RateLimited || e instanceof Unreachable) || i === 3", "!(e instanceof RateLimited || e instanceof Unreachable) || i === 4", R, "T7b "],
  // the providers (card evm-quote-warm-round): any two that agree decide; a spare is asked when one fails, is slow or
  // differs; the quote's later rounds ask the two that agreed first; the next quote asks the fastest first
  [QUOTE, "          const peers = got.filter((x) => same(x.v, v));", "          const peers = got.filter(() => true);", Q, "Q2 "],
  [QUOTE, "          if (!contested && got.length >= 2) start();", "", R, "V3 "],
  [QUOTE, "      if (x !== undefined && y !== undefined) {\n        try {", "      if (false) {\n        try {", R, "V2 "],
  [QUOTE, "          failed ??= { e };\n          if (done) return;\n          start();", "          failed ??= { e };\n          if (done) return;", R, "V1 "],
  [QUOTE, "timer = setTimeout(() => (done ? undefined : start()), first < 0", "timer = setTimeout(() => undefined, first < 0", R, "V1 "],
  [QUOTE, "first < 0 ? 4 * EVM_HEDGE_MS : Math.max(EVM_HEDGE_MS, first));", "EVM_HEDGE_MS);", R, "V5 "],
  [QUOTE, "first < 0 ? 4 * EVM_HEDGE_MS : Math.max(EVM_HEDGE_MS, first));", "first < 0 ? 4 * EVM_HEDGE_MS : EVM_HEDGE_MS);", R, "V5 "],
  [QUOTE, "            first = performance.now() - t0[k]!;\n            arm();", "            first = performance.now() - t0[k]!;", R, "V1 "],
  [QUOTE, "        order.forEach((r, n) => ((rpcs as EvmRpc[])[n] = r));", "", R, "V1 "],
  [QUOTE, "        failed ??= { e };\n        if (n === 0) unsure = true;\n        continue;", "        throw e;", R, "V3 "],
  [QUOTE, "    return [slow, s?.ms ?? Number.MAX_VALUE, k] as const;", "    return [0, s?.ms ?? Number.MAX_VALUE, k] as const;", R, "V4 "],
  [QUOTE, "s.out.some((t) => now - t > EVM_HEDGE_MS) ? 1 : 0;", "0;", R, "V4 "],
  [QUOTE, "s.held > now ? 2 : ", "s.held > now ? 1 : ", R, "V4 "],
  [QUOTE, "      if (out.some(limited)) s.held = performance.now() + EVM_HOLD_MS;\n      else s.ms", "      s.ms", R, "V4 "],
  [QUOTE, "      s.held = performance.now() + EVM_HOLD_MS;\n      throw e;", "      throw e;", R, "V4 "],
  // the review of bc189de: a contested value needs more than half the listed providers, on the reads (M-1) and the
  // block's confirmation (M-2); a provider that differs from what the quote used is held; the spare's timer counts
  // from its own request (L-2); the pinned quote ranks (M14), a spare is asked while none answered (M15)
  [QUOTE, "          if (vote && peers.length < got.length && !contested) {", "          if (false) {", R, "V6 "],
  [QUOTE, "  const need = Math.floor(list.length / 2) + 1;\n  return new Promise", "  const need = 2;\n  return new Promise", R, "V6 "],
  [QUOTE, "          if (contested && peers.length >= need) return win(", "          if (contested && peers.length >= 2) return win(", R, "V6 "],
  [QUOTE, "      for (const x of got) if (held(x.v, g.v, h.v)) HOLD.get(list[x.k]!)?.();", "", R, "V11 "],
  [QUOTE, "= (x, a, b) => !same(a, x) && !same(b, x),", "= () => false,", R, "V11 "],
  [QUOTE, "    if (hold !== undefined) HOLD.set(f as unknown as EvmRpc, hold);", "", R, "V11 "],
  [QUOTE, "  HOLD.set(f, () => void (speedOf(url).held = performance.now() + EVM_HOLD_MS));", "", R, "V11 "],
  [QUOTE, "    const enough = () => holds >= (strict() ? need : 2);", "    const enough = () => holds >= 2;", R, "V10 "],
  [QUOTE, "    if (enough()) return against.forEach((k) => HOLD.get(list[k]!)?.());", "    if (enough()) return;", R, "V7 "],
  [QUOTE, "        against.push(others[n]!);\n      } else holds++;", "        return refuse(\"rpc_disagree\", \"another block\");\n      } else holds++;", R, "V7 "],
  [QUOTE, "            first = performance.now() - t0[k]!;", "            first = performance.now() - t0[0]!;", R, "V8 "],
  [QUOTE, "      if (started >= 2) arm();\n", "", R, "V8 "],
  [QUOTE, "return evmPoolBuyQuoteWith(asked, evmProviders(evmRanked(p), fetch),", "return evmPoolBuyQuoteWith(asked, evmProviders(p, fetch),", R, "V9 "],
  // the re-review of fd9dd16: no confirm from the other head's provider asks a majority (MEDIUM-1); a head is held only
  // more than maxLag below the pair, and heads are no vote (LOW-1, U6); a contested round out of reach ends at once
  // (U1), and so does a confirm (U5)
  [QUOTE, "    const enough = () => holds >= (strict() ? need : 2);", "    const enough = () => holds >= (against.length > 0 ? need : 2);", R, "V12 "],
  [QUOTE, "        if (n === 0) unsure = true;", "", R, "V12 "],
  [QUOTE, "    let holds = 1;\n", "    let holds = 2;\n", R, "V12 "],
  [QUOTE, "    let holds = 1;\n", "    let holds = 0;\n", R, "V3 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => !near(x, a) && !near(x, b),", R, "V13 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    () => false,", R, "V13 "],
  [QUOTE, "    // a head past maxLag is a missing answer, not a vote\n    false,\n", "", R, "V13 "],
  [QUOTE, "      if (contested && Math.max(...got.map((x) => got.filter((y) => same(x.v, y.v)).length)) + list.length - got.length - fails < need) return lose();\n", "", R, "V14 "],
  [QUOTE, "      if (strict() && holds + others.length - n < need) break;\n", "", R, "V15 "],
  // the re-review of 47109a7: the held head's edges (E3, E4) and the confirm's early stop without a vote against (E6)
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => x.number + maxLag <= (a.number <= b.number ? a.number : b.number),", R, "V13 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? b.number : a.number),", R, "V13 "],
  [QUOTE, "      if (strict() && holds + others.length - n < need) break;", "      if (against.length > 0 && holds + others.length - n < need) break;", R, "V15 "],
  // the scan's spans: each that came back is kept, also when another failed, never past a head named beyond maxLag;
  // a throttled span is asked again whole
  [QUOTE, "  await settle(jobs.map((j) => one(j))).catch((e) => failing(e));", "  await settle(jobs.map((j) => one(j)));", R, "J1 "],
  [QUOTE, "    if (a > at) out.push([at, a - 1]);", "", R, "J1 "],
  [QUOTE, "      if (scanHead - b.number <= maxLag) commit();", "      commit();", R, "J3 "],
  // the review of bc189de: a kept scan started early waits for the quote's pick when it ends (L-3) and when it fails
  // (M12); a span is kept only for the currencies of the request that came back (M20)
  [QUOTE, "v.scan, at, v.maxLag, gate,", "v.scan, agreedHead, v.maxLag, gate,", R, "J4 "],
  [QUOTE, "(headOfScan ??= scanHeadOf(scan, gate)), at);", "(headOfScan ??= scanHeadOf(scan, gate)), agreedHead);", R, "J5 "],
  [QUOTE, "for (const g of got) if (g.part.includes(e)) e.spans", "for (const g of got) e.spans", R, "J6 "],
  [QUOTE, "(out) => (out.some(limited) ? ((throttled = true), null) : logsOf(out)),", "(out) => logsOf(out),", R, "J2 "],
  [QUOTE, "          throttled = THROTTLED.has(e as Error);", "          throttled = false;", R, "J2 "],
  [QUOTE, "        if (e instanceof RateLimited) THROTTLED.add(err);", "", R, "J2 "],
  [QUOTE, "export const EVM_QUOTE_MAX_KEYS = 65_536;", "export const EVM_QUOTE_MAX_KEYS = 16_384;", R, "X3 "],
  [QUOTE, "    if (hooks.some(replaced)) c.real =", "    if (false) c.real =", R, "H2 "],
  [QUOTE, "    return x < y ? x : y;", "    return x;", R, "H2 "],
  [QUOTE, "      const span = part.length === 1 ? s.span : Math.min(s.span, s.orSpan ?? s.span);", "      const span = s.span;", R, "B1 "],
  [QUOTE, "    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));", "    const t = w(part[0]!.c);", R, "X4 "],
  [QUOTE, "[[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]]", "[[e0, null, w(weth), t], [e0, null, t, w(weth)]]", R, "S3 "],
  [QUOTE, "[e0, null, null, t]", "[e0, t]", R, "N1a "],
  [QUOTE, "const fromScan = scanned?.pools.get(lower(token)) ?? [];", "const fromScan: EvmPoolKey[] = [];", R, "N1a "],
  [QUOTE, "gaps: gapsOf(spans, floor, head),", "gaps: [[floor, head]] as Spans,", R, "G4 "],
  [QUOTE, "  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", "  commit();\n  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", R, "S2b "],
  [QUOTE, "    const sc = await scanOf(cs, \"markets\");", "    const sc = await (scanOf(cs, \"markets\") ?? Promise.resolve(null)).catch(() => null);", R, "G2 "],
  [QUOTE, "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]))", "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [p.key]))", R, "S3c "],
  [QUOTE, "hops: [hopTo(via.other, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)]", "hops: [hopTo(x, via.key), hopTo(lower(token), p.key)]", R, "T5 "],
  [QUOTE, "    if (res.status === 429) throw new RateLimited(", "    if (false) throw new RateLimited(", R, "T7 "],
  [QUOTE, "      if (!(e instanceof RateLimited || e instanceof Unreachable) || i === 3) {", "      if (true) {", R, "T7 "],
  [QUOTE, "      if (i < 3 && Array.isArray(out) && out.some(limited)) throw", "      if (false) throw", R, "T7 "],
  [QUOTE, "    const f = (calls: readonly EvmRpcCall[]) => g(() => rpc(calls));", "    const f = (calls: readonly EvmRpcCall[]) => rpc(calls);", R, "T8 "],
  [BUYU, "  if (!(quoted && route.venue === \"uniswap-v4\")) {", "  if (!quoted) {", R, "D1 "],
  [BUYU, "  return routeData(chain, route, true);", "  return routeData(chain, route, false);", R, "D1 "],
  [BUYU, "  const { data, token: buys } = routeData(chain, route, quoted);", "  const { data, token: buys } = routeData(chain, route, false);", R, "D1 "],
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
  [QUOTE, "(slippageBps as number) < 0 || (slippageBps as number) >= 10000", "(slippageBps as number) < 0", Q, "Q8 "],
  [QUOTE, "|| new Set(rpcsIn).size !== rpcsIn.length) {", ") {", Q, "Q8 "],
  [QUOTE, 'if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", Q, "Q8 "],
  [QUOTE, 'if (new Set(hosts).size !== hosts.length) return refuse("bad_request", "two providers are on one host");', "", Q, "Q8 "],
  [QUOTE, 'if (typeof url !== "string" || !/^https:\\/\\//.test(url)) return refuse(', "if (false) return refuse(", Q, "Q8 "],
  // a provider's answer
  [QUOTE, "if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len)", "if (!Number.isSafeInteger(o) || o < 0)", Q, "Q9 "],
  [QUOTE, "if (e + 96 + dl > len) return refuse(", "if (false) return refuse(", Q, "Q9 "],
  [QUOTE, "if (!Array.isArray(out) || out.length !== calls.length)", "if (!Array.isArray(out))", Q, "Q9 "],
  // the sell quote: no route from a caller, the device's own pool, minOut, probe and age
  [QUOTE, 'if (Object.hasOwn(req, "route")) return refuse("bad_request", "a sell quote takes no route: the device picks the pool");', "", S, "planted: a server's route"],
  [QUOTE, "QUOTED_SELLS.add(quote);", "", S, "planted: a server's route"],
  [SELLQ, "if (!evmIsDeviceSellQuote(quote)) throw new EvmQuoteError(", "if (false) throw new EvmQuoteError(", S, "planted: a server's route"],
  [SELLQ, 'if (!QUOTED_SELLS.has(built)) throw new EvmPoolSellError("not_built"', 'if (false) throw new EvmPoolSellError("not_built"', S, "planted: a server's route"],
  [SELLQ, "QUOTED_SELLS.add(built);", "", S, "planted: a server's route"],
  [SELLQ, "|| nowMs - Number(quote.block.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {", ") {", S, "planted: a stale quote"],
  [SELLQ, "> EVM_QUOTE_MAX_AGE_MS) {\n    throw new EvmQuoteError(\"stale_quote\"", "> 10 * EVM_QUOTE_MAX_AGE_MS) {\n    throw new EvmQuoteError(\"stale_quote\"", S, "planted: a stale quote"],
  [QUOTE, 'if (probe!.kind !== "out" || probe!.amountOut !== amountIn) {', "if (false) {", S, "planted: a fee-on-transfer"],
  [QUOTE, 'if (probe!.kind !== "out" || probe!.amountOut !== amountIn) {', 'if (probe!.kind !== "out") {', S, "planted: a fee-on-transfer"],
  [QUOTE, 'if (probe!.kind !== "out" || probe!.amountOut !== amountIn) {', 'if (probe!.kind !== "out" || probe!.amountOut < amountIn) {', S, "planted: a fee-on-transfer"],
  [QUOTE, "override: { [lower(w)]: { code: EVM_SELL_PROBE_CODE } }", "override: { [lower(w)]: { code: EVM_NOOP_HOOK_CODE } }", S, "the device picks the pool"],
  [QUOTE, 'if (route.venue === "uniswap-v4") to = v.poolManager!;', 'if (route.venue === "uniswap-v4") to = lower(w);', S, "the device picks the pool"],
  [QUOTE, 'to = "0x" + p.toString(16).padStart(40, "0");', "to = router!;", S, "a v3 pool is picked"],
  [QUOTE, "const pick = best(routes.filter((r) => evmSellExits(chain, t, r.route)));", "const pick = routes.filter((r) => evmSellExits(chain, t, r.route))[0] ?? null;", S, "the device picks the pool"],
  [QUOTE, 'fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route, amountOut: out(c.at)! }] : []', "out(c.at) !== null ? [{ route: c.route, amountOut: out(c.at)! }] : []", S, "planted: a pool that runs out"],
  [QUOTE, "return x !== null && x > 0n && (y === null ? !isV3 : y > x);", "return x !== null && x > 0n && (y === null ? true : y > x);", S, "planted: a pool that runs out"],
  [QUOTE, "return x !== null && x > 0n && (y === null ? !isV3 : y > x);", "return x !== null && x > 0n && (y === null ? !isV3 : true);", S, "planted: a pool that runs out"],
  [QUOTE, "const minOut = (reference!.amountOut * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = reference!.amountOut;", S, "the device picks the pool"],
  [QUOTE, 'if (minOut === 0n) return refuse("no_quote", "the pool quotes too little to set a minimum above 0");', "", S, "planted: a pool that runs out"],
  [QUOTE, 'hooks: lower(h.hooks), hookData: "0x" }));', 'hooks: lower(h.hooks), hookData: "0x00" }));', S, "the device picks the pool"],
  [QUOTE, 'const from = h.from === "native" ? NATIVE : v.weth;\n      candidate({', 'const from = h.from === "native" ? v.weth : NATIVE;\n      candidate({', S, "planted: an unlisted hook"],
  [QUOTE, "if (lower(h.hooks) === lower(token) || v.called.has(lower(h.hooks))) continue;", "", S, "planted: an unlisted hook"],
  [QUOTE, 'const target = route.venue === "uniswap-v3" ? router! : v.poolManager!;', 'const target = route.venue === "uniswap-v3" ? v.poolManager! : router!;', S, "the device picks the pool"],
  [QUOTE, '|| v.called.has(lower(w)) || v.hookedPools.some', "|| v.hookedPools.some", S, "a chain with no v3 router"],
  [QUOTE, '|| lower(token) === lower(v.weth)) return refuse("bad_request", "the token is not an address, or is WETH");', ') return refuse("bad_request", "the token is not an address, or is WETH");', S, "a chain with no v3 router"],
  [QUOTE, "const v4 = v.v4 !== undefined && (!a.sell || v.poolManager !== undefined);", "const v4 = !a.sell && v.v4 !== undefined;", S, "a chain with no v3 router"],
  // card evm-route-parity: the buy enters only where its sell can leave; the sell's set is the buy's (its scan, the
  // markets of another currency, the bought-in pool), and its pick is held to a reference
  [QUOTE, 'if (!evmSellExits(chain, token, route)) return refuse("no_exit",', 'if (false) return refuse("no_exit",', R, "L1 "],
  [QUOTE, 'if (!evmSellExits(chain, token, route)) return refuse("no_exit",', 'if (false) return refuse("no_exit",', R, "P4 "],
  [QUOTE, "if (reference !== null && pick.amountOut * 10000n < reference.amountOut * BigInt(10000 - slippageBps)) {", "if (false) {", R, "P2 "],
  [QUOTE, "pick.amountOut * 10000n < reference.amountOut * BigInt(10000 - slippageBps)) {", "pick.amountOut * 10000n < reference.amountOut * 10000n) {", R, "P2 "],
  [QUOTE, "const pick = best(routes.filter((r) => evmSellExits(chain, t, r.route)));", "const pick = best(routes);", R, "P2 "],
  [QUOTE, "  if (bought !== null) {\n    const x = bought.route.venue", "  if (false) {\n    const x = bought.route.venue", R, "P3 "],
  [QUOTE, 'if (lower(evmPoolRouteDataQuoted(chain, bought).token) !== lower(token)) return refuse("token_mismatch", "the bought route buys another token");', "", R, "P3 "],
  [QUOTE, "rpcs, scan, reads, bought: exits, seen: [], hints: undefined, sell: true });", "rpcs, scan: undefined, reads, bought: exits, seen: [], hints: undefined, sell: true });", R, "P1 "],
  // the review of edb4dbb: F1 the sell goes further where the buy does; F2 X's markets at the X the token's pool
  // gives; F5 `bought` kept only where the sell builder takes it; F6 minOut off the reference
  [QUOTE, "if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);", "if (markets.has(x) && !a.sell) further.push(x);", R, "PA "],
  [QUOTE, "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount));", "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, amountIn));", R, "PB2 "],
  [QUOTE, "        append(legs, x, { q: quoteOf(second, { venue: \"uniswap-v4\", currencyIn: x, hops: [hopTo(lower(token), p.key)] }, [p.key]), p });\n", "", R, "PB "],
  [QUOTE, "const exits = evmSellExits(chain, t, bought) ? bought : undefined;", "const exits = bought;", R, "PC "],
  [QUOTE, "const minOut = (reference!.amountOut * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = (pick.amountOut * BigInt(10000 - slippageBps)) / 10000n;", R, "PD "],
  [QUOTE, "return Object.freeze({ venue: r.venue, hops: Object.freeze(hops.reverse()) });", "return Object.freeze({ venue: r.venue, hops: Object.freeze(hops) });", R, "P4 "],
  // card evm-quote-exec-sim: a route through an unlisted hook above the builder's best counts only where W's own sell
  // through it executes (the sim), where the chain pins a sell delegate; elsewhere the lower of its two quotes stays
  [QUOTE, 'const toSim = routes.filter((r) => r.amountOut > floor && simRule(chain, r.route, pins) === "sim");', "const toSim: Filled[] = [];", R, "PE a pool"],
  [QUOTE, 'return pins.sellDelegate !== undefined && pins.sellSender !== undefined ? "sim" : "keep-min";', 'return "sim";', R, "PE (keep-min)"],
  [QUOTE, 'return pins.sellDelegate !== undefined && pins.sellSender !== undefined ? "sim" : "keep-min";', 'return "keep-min";', R, "PE a pool"],
  [QUOTE, 'if (typeof signSim !== "function") return refuse("bad_request",', 'if (false) return refuse("bad_request",', R, "PE a pool"],
  [QUOTE, "nonce: n!.amountOut, deadline: block.timestamp });", "nonce: n!.amountOut, deadline: block.timestamp + 60n });", R, "PE a pool"],
  [QUOTE, "override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...asW }, tx };", R, "PE a pool"],
  [QUOTE, "const asW = { [lower(w)]: { code: designator(delegate!) } };", "const asW = { [lower(w)]: { code: EVM_NOOP_HOOK_CODE } };", R, "PE a pool"],
  [QUOTE, "const takes = best(filled.filter((r) => evmSellExits(chain, t, r.route)));", "const takes = best(filled);", R, "PE a pool"],
  // (no mutant drops the signer's pool check: only a sim the builder made is signed, frozen with EVM_SELL_SIM as its
  // pool, so the check cannot fail there; the signing page's rule, which takes any object, holds it: sim_pool)
  [SELLU, "sim.deadline > blockTimestamp) return refuse(", "sim.deadline > blockTimestamp + 1n) return refuse(", S, "planted: the sim signer"],
  [SELLU, "if (!Number.isFinite(nowMs) || blockTimestamp * 1000n > BigInt(Math.floor(nowMs))) return refuse(", "if (!Number.isFinite(nowMs)) return refuse(", S, "planted: the sim signer"],
  [SELLU, 'if (!SIMS.has(sim) || sim.chain !== chain) return refuse("not_built", "W signs only a sim', 'if (sim.chain !== chain) return refuse("not_built", "W signs only a sim', S, "planted: the sim signer"],
  [SELLU, 'if (addressOf(secretKey) !== lower(sim.w)) return refuse("bad_key", "the key is not W\'s");\n  return signDigest(secretKey, sellDigest(sim));', "return signDigest(secretKey, sellDigest(sim));", S, "planted: the sim signer"],
  [SELLU, 'if (pinsOf(venues, chain).sellDelegate === undefined) return refuse("not_deployed", `${chain} has no pinned sell delegate yet`);\n  return evmPoolSignSimSellUnpinned', "return evmPoolSignSimSellUnpinned", S, "planted: the sim signer"],
  [SELLU, "pool: EVM_SELL_SIM, precommitment: 0n, feeCap: 0n,", "pool: venue.weth, precommitment: 0n, feeCap: 0n,", S, "planted: the sim signer"],
  [SELLU, "    if (!anyHook && lower(hooks as string) !== NATIVE) {", "    if (lower(hooks as string) !== NATIVE) {", R, "PE a pool"],
  // the sim sent as the sale (review of the exec sim, HIGH 1): from the pinned sender, the sale's gas and fees, the
  // agreed block's base fee agreed on both providers; no sender pinned, no sim
  [QUOTE, 'pins.sellDelegate !== undefined && pins.sellSender !== undefined ? "sim"', 'pins.sellDelegate !== undefined ? "sim"', R, "PE5 "],
  [QUOTE, "const tx: SimTx = { from: sender,", "const tx: SimTx = { from: NATIVE,", R, "PE4 "],
  [QUOTE, "gas: qty(gas), maxFeePerGas: qty(maxFee),", "gas: qty(50_000_000n), maxFeePerGas: qty(maxFee),", R, "PE3 "],
  [QUOTE, "maxFeePerGas: qty(maxFee), maxPriorityFeePerGas: qty(tip) };", 'maxFeePerGas: "0x0", maxPriorityFeePerGas: "0x0" };', R, "PE1 "],
  [QUOTE, "const maxFee = block.baseFeePerGas + tip;", "const maxFee = tip;", R, "PE6 "],
  [QUOTE, "const gas = EVM_POOL_SELL_GAS - EVM_7702_AUTH_GAS;", "const gas = EVM_POOL_SELL_GAS;", R, "PE6 "],
  [QUOTE, "const tip = evmPoolSellTip(chain);", "const tip = 0n;", R, "PE6 "],
  [QUOTE, "override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } } };", R, "PE1 "],
  [QUOTE, "override: asW, tx }]);", "override: asW }]);", R, "PE6 "],
  // the sender's balance is its own (review point 4, 4 Nov): a balance override on it, on the nonce read or the sim, is caught,
  // and a sender too low to pay the sim's gas, read at the block, drops the sim's routes, never the sale
  [QUOTE, "override: asW, tx }]);", "override: { ...asW, [sender]: { balance: qty(gas * maxFee + 10n ** 18n) } }, tx }]);", R, "PE6 "],
  [QUOTE, "override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...asW, [sender]: { balance: qty(gas * maxFee + 10n ** 18n) }, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", R, "PE6 "],
  [QUOTE, "if (bal!.kind !== \"out\" || bal!.amountOut < gas * maxFee) return routes.filter", "if (false) return routes.filter", R, "PE8 "],
  [QUOTE, "bal!.amountOut < gas * maxFee)", "bal!.amountOut < gas * maxFee - 1n)", R, "PE8 "],
  [QUOTE, "bal!.amountOut < gas * maxFee)", "bal!.amountOut <= gas * maxFee)", R, "PE8 "],
  [QUOTE, "bal!.amountOut < gas * maxFee)", "bal!.amountOut < gas)", R, "PE8 "],
  [QUOTE, "SEL_ETH_BALANCE + sender.slice(2)", "SEL_ETH_BALANCE + lower(w).slice(2)", R, "PE8 "],
  [QUOTE, "data: reads[i]!.data, ...reads[i]!.tx }", "data: reads[i]!.data }", R, "PE1 "],
  [QUOTE, 'if (block.baseFeePerGas === null) return refuse("rpc_error",', 'if (false) return refuse("rpc_error",', R, "PE7 "],
  [QUOTE, " || back.baseFeePerGas !== lo.baseFeePerGas) {", ") {", R, "R11 "],
  [QUOTE, 'if (fee !== undefined && (typeof fee !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(fee))) return refuse(', "if (false) return refuse(", R, "R11 "],
  // the sim signer's signature recovers to W over SellDelegate's own digest (review of the exec sim, LOW 3)
  [SELLU, "      word(BigInt(chainId)),", "      word(0n),", S, "planted: the sim signer"],
];

const esc = (n) => `^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
const run$ = promisify(execFile);
// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`
let lastFail = "";
async function run(dir, file, name) {
  try {
    const { stdout } = await run$("node", ["--test", "--test-reporter=tap", "--test-name-pattern", esc(name), file], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
    return /^# pass ([1-9]\d*)$/m.test(stdout) ? "pass" : "none";
  } catch (e) {
    lastFail = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 4).join("\n");
    return "fail";
  }
}
// each name's "pass", "fail" or "none" on the code as it is: every named test of `file` in one run, each top-level
// result read from the TAP lines (a name passes when some test starts with it and none of those fails)
function runAll(dir, file, names) {
  let out = "";
  try {
    out = execFileSync("node", ["--test", "--test-reporter=tap", ...names.flatMap((n) => ["--test-name-pattern", esc(n)]), file], { cwd: dir, stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 26 });
  } catch (e) {
    out = `${e.stdout ?? ""}`;
  }
  const results = [...out.matchAll(/^(not )?ok \d+ - (.*?)(?: # .*)?$/gm)].map((m) => ({ ok: m[1] === undefined, name: m[2].replace(/\\#/g, "#").replace(/\\\\/g, "\\") }));
  return new Map(names.map((n) => {
    const of = results.filter((r) => r.name.startsWith(n));
    return [n, of.length === 0 ? "none" : of.every((r) => r.ok) ? "pass" : "fail"];
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const JOBS = Math.max(1, Math.min(4, availableParallelism()));
  const t0 = performance.now();
  const s = (t) => `${((performance.now() - t) / 1000).toFixed(1)} s`;
  // the copies: the kit's sources, tests and package file, with its installed modules linked
  const dirs = [];
  let bad = 0;
  try {
    for (let w = 0; w < JOBS; w++) {
      const dir = mkdtempSync(join(KIT, ".evm-quote-mutants-"));
      dirs.push(dir);
      for (const p of ["src", "test", "package.json"]) cpSync(join(KIT, p), join(dir, p), { recursive: true });
    }
    const src = new Map([QUOTE, BUY, BUYU, SELLQ, SELLU].map((f) => [f, readFileSync(join(dirs[0], f), "utf8")]));
    const byFile = new Map();
    for (const m of MUTANTS) byFile.set(m[3], [...new Set([...(byFile.get(m[3]) ?? []), m[4]])]);
    for (const [file, names] of byFile) {
      const t = performance.now();
      for (const [n, r] of runAll(dirs[0], file, names)) {
        if (r !== "pass") {
          console.log(`FAIL "${n}" in ${file} ${r === "none" ? "names no test" : "fails on the code as it is"}`);
          bad++;
        }
      }
      console.log(`the ${names.length} named tests of ${file} on the code as it is: ${s(t)}`);
    }
    if (bad === 0) {
      let next = 0;
      const worker = async (dir) => {
        for (let i = next++; i < MUTANTS.length; i = next++) {
          const [file, find, repl, tf, t] = MUTANTS[i];
          const sf = src.get(file);
          if (sf.split(find).length !== 2) {
            console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
            bad++;
            continue;
          }
          const tm = performance.now();
          writeFileSync(join(dir, file), sf.replace(find, repl));
          const r = await run(dir, tf, t);
          writeFileSync(join(dir, file), sf);
          console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"} (${s(tm)})`);
          if (r !== "fail") bad++;
        }
      };
      const tm = performance.now();
      await Promise.all(dirs.map((d) => worker(d)));
      console.log(`${MUTANTS.length} mutants, ${JOBS} at once: ${s(tm)}`);
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test (${s(t0)})` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
