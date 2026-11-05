// Removes each of the EVM buy quote's checks (src/checks/evm/quote.ts, the quoted builder and signer in
// src/trade/evm/buy.ts, and the builder's admission of a device-quoted route's v4 middles in
// src/trade/evm/buy-unpinned.ts), one at a time, and runs the test named for it in test/evm-quote.test.ts or
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
const BUYU = "src/trade/evm/buy-unpinned.ts";
const Q = "test/evm-quote.test.ts";
const R = "test/evm-quote-attacks.test.ts";
const H = "test/evm-quote-head.test.ts";
// the sell quote (card evm-sell-device-quote) and the index's sell builder and signer that take only one
const SELLQ = "src/trade/evm/sell.ts";
const S = "test/evm-sell-quote.test.ts";
// the sim sell's builder and signer (card evm-quote-exec-sim)
const SELLU = "src/trade/evm/sell-unpinned.ts";
const QD = "src/trade/evm/quoted.ts";
const PF = "src/trade/evm/pool-fee.ts";
const E = "test/evm-pool-fee.test.ts";

// [file, text, replacement, test file, the test that must fail]
export const MUTANTS = [
  // two providers at one block they both hold, no more than 30 s old
  [QUOTE, 'const same = a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial;', "const same = true;", Q, "Q2 "],
  [QUOTE, 'b.kind === "out" && a.amountOut === b.amountOut', 'b.kind === "out"', Q, "Q2 "],
  [QUOTE, 'b.kind === "revert" && a.partial === b.partial', 'b.kind === "revert"', Q, "Q2 "],
  [QUOTE, "const at = { blockHash: hash, requireCanonical: true };", "const at = { blockHash: hash };", Q, "Q1 "],
  [QUOTE, "if (a.number - b.number > maxLag || b.number - a.number > maxLag) return refuse(", "if (false) return refuse(", R, "R5 "],
  [QUOTE, "if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp || back.baseFeePerGas !== lo.baseFeePerGas) {", "if (false) {", R, "R1b "],
  [QUOTE, "back.number !== lo.number || back.hash !== lo.hash || back.timestamp", "back.number !== lo.number || back.timestamp", R, "R5 "],
  [QUOTE, " || back.timestamp !== lo.timestamp || back.baseFeePerGas", " || back.baseFeePerGas", R, "R5 "],
  [QUOTE, '? [a, rpcs[1], "provider 2"] : [b, rpcs[0], "provider 1"]', '? [a, rpcs[0], "provider 2"] : [b, rpcs[1], "provider 1"]', R, "R5 "],
  [QUOTE, 'if (confirmed.status === "rejected") throw confirmed.reason;', "", R, "R1b "],
  [QUOTE, "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (false) return refuse(", Q, "Q14 "],
  [QUOTE, "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS + 1000) return refuse(", R, "R6 "],
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
  [QUOTE, "if (rs !== null && fine(rs)) return rs.map(", "if (rs !== null) return rs.map(", R, "card evm-quote-head-watch: a scan provider that fails a full span"],
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
  [QUOTE, "export const EVM_QUOTE_MAX_KEYS = 65_536;", "export const EVM_QUOTE_MAX_KEYS = 16_384;", R, "X3 "],
  [QUOTE, "    if (hooks.some(replaced)) c.real =", "    if (false) c.real =", R, "H2 "],
  [QUOTE, "    return x < y ? x : y;", "    return x;", R, "H2 "],
  [QUOTE, "      const span = part.length === 1 ? s.span : Math.min(s.span, s.orSpan ?? s.span);", "      const span = s.span;", R, "B1 "],
  [QUOTE, "    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));", "    const t = w(part[0]!.c);", R, "X4 "],
  [QUOTE, "[[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]]", "[[e0, null, w(weth), t], [e0, null, t, w(weth)]]", R, "S3 "],
  [QUOTE, "[e0, null, null, t]", "[e0, t]", R, "N1a "],
  [QUOTE, "const fromScan = scanned?.pools.get(lower(token)) ?? [];", "const fromScan: EvmPoolKey[] = [];", R, "N1a "],
  [QUOTE, "from: cached === undefined || cached.to < floor ? floor : cached.to + 1,", "from: floor,", R, "G4 "],
  [QUOTE, "  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", "  commit();\n  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", R, "S2b "],
  [QUOTE, "    const sc = await scanOf(cs, \"markets\");", "    const sc = await (scanOf(cs, \"markets\") ?? Promise.resolve(null)).catch(() => null);", R, "G2 "],
  [QUOTE, "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]))", "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [p.key]))", R, "S3c "],
  [QUOTE, "hops: [hopTo(via.other, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)]", "hops: [hopTo(x, via.key), hopTo(lower(token), p.key)]", R, "T5 "],
  [QUOTE, "    if (res.status === 429) throw new RateLimited(", "    if (false) throw new RateLimited(", R, "T7 "],
  [QUOTE, "      if (!(e instanceof RateLimited) || i === 3) return refuse(", "      if (true) return refuse(", R, "T7 "],
  [QUOTE, "      if (i < 3 && Array.isArray(out) && out.some(limited)) throw", "      if (false) throw", R, "T7 "],
  [QUOTE, "    return (calls: readonly EvmRpcCall[]) => g(() => rpc(calls));", "    return (calls: readonly EvmRpcCall[]) => rpc(calls);", R, "T8 "],
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
  [QD, "if (!evmIsDeviceQuote(quote)) throw", "if (false) throw", Q, "Q7 "],
  [QD, "if (!Number.isFinite(nowMs) || nowMs - Number(blockTimestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {", "if (!Number.isFinite(nowMs)) {", Q, "Q7 "],
  [QD, "  fresh(quote.block.timestamp, nowMs);\n  const built = pinnedBuildQuoted(", "  const built = pinnedBuildQuoted(", Q, "Q7 "],
  [BUY, "if (!evmIsQuotedBuy(built)) throw", "if (false) throw", Q, "Q7 "],
  [QD, "  QUOTED_BUILDS.add(built);", "", Q, "Q7 "],
  // the request and the providers
  [QUOTE, "amountIn <= 0n || amountIn >= MAX_IN", "amountIn <= 0n", Q, "Q8 "],
  [QUOTE, "(slippageBps as number) < 0 || (slippageBps as number) >= 10000", "(slippageBps as number) < 0", Q, "Q8 "],
  [QUOTE, "|| rpcsIn[0] === rpcsIn[1]) {", ") {", Q, "Q8 "],
  [QUOTE, 'if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", Q, "Q8 "],
  [QUOTE, 'if (hosts[0] === hosts[1]) return refuse("bad_request", "the two providers are on one host");', "", Q, "Q8 "],
  [QUOTE, 'if (typeof url !== "string" || !/^https:\\/\\//.test(url)) return refuse(', "if (false) return refuse(", Q, "Q8 "],
  // a provider's answer
  [QUOTE, "if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len)", "if (!Number.isSafeInteger(o) || o < 0)", Q, "Q9 "],
  [QUOTE, "if (e + 96 + dl > len) return refuse(", "if (false) return refuse(", Q, "Q9 "],
  [QUOTE, "if (!Array.isArray(out) || out.length !== calls.length)", "if (!Array.isArray(out))", Q, "Q9 "],
  // the sell quote: no route from a caller, the device's own pool, minOut, probe and age
  [QUOTE, 'if (Object.hasOwn(req, "route")) return refuse("bad_request", "a sell quote takes no route: the device picks the pool");', "", S, "planted: a server's route"],
  [QUOTE, "QUOTED_SELLS.add(quote);", "", S, "planted: a server's route"],
  [QD, "if (!evmIsDeviceSellQuote(quote)) throw new EvmQuoteError(", "if (false) throw new EvmQuoteError(", S, "planted: a server's route"],
  [SELLQ, 'if (!evmIsQuotedSell(built)) throw new EvmPoolSellError("not_built"', 'if (false) throw new EvmPoolSellError("not_built"', S, "planted: a server's route"],
  [QD, "QUOTED_SELLS.add(built);", "", S, "planted: a server's route"],
  [QD, "  fresh(quote.block.timestamp, nowMs);\n  if (typeof fields", "  if (typeof fields", S, "planted: a stale quote"],
  [QD, "> EVM_QUOTE_MAX_AGE_MS) {\n    throw new EvmQuoteError(\"stale_quote\"", "> 10 * EVM_QUOTE_MAX_AGE_MS) {\n    throw new EvmQuoteError(\"stale_quote\"", S, "planted: a stale quote"],
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
  [QUOTE, "rpcs, scan, reads, bought: exits, seen: [], hints: undefined, sell: true, minBlock: boughtBlock, mono, start });", "rpcs, scan: undefined, reads, bought: exits, seen: [], hints: undefined, sell: true, minBlock: boughtBlock, mono, start });", R, "P1 "],
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
  [QUOTE, 'if (block.baseFeePerGas === null) return refuse("rpc_error", `block ${block.number} has no base fee: the sim', 'if (false) return refuse("rpc_error", `block ${block.number} has no base fee: the sim', R, "PE7 "],
  [QUOTE, " || back.baseFeePerGas !== lo.baseFeePerGas) {", ") {", R, "R11 "],
  // card evm-buy-hookdata-fee: (1) a buy's hook data is the device's own, none; (2) the sender's fee cap is the device's
  // own rule's at the agreed block, never above it; (3) a sell quote reads at a block at or past its buy's
  [QUOTE, 'if (route.venue === "uniswap-v4" && route.hops.some((h) => h.hookData !== "0x")) return refuse(', "if (false) return refuse(", R, "HD1 "],
  [QUOTE, 'route.hops.some((h) => h.hookData !== "0x")) return refuse(', 'route.hops.slice(1).some((h) => h.hookData !== "0x")) return refuse(', R, "HD1 "],
  [QUOTE, "const feeMax = evmPoolSellFeeMax(chain, block.baseFeePerGas, chainFee);", "const feeMax = 10n ** 18n;", S, "planted: the sender's fee cap"],
  [QUOTE, 'if (block.baseFeePerGas === null) return refuse("rpc_error", `block ${block.number} has no base fee: the sale', 'if (false) return refuse("rpc_error", `block ${block.number} has no base fee: the sale', S, "planted: the sender's fee cap"],
  [PF, "const f = 2n * (gas * gasPrice + chainFee);", "const f = gas * gasPrice + chainFee;", S, "planted: the sender's fee cap"],
  [SELLU, "gasPrice: baseFeePerGas + evmPoolSellTip(chain)", "gasPrice: baseFeePerGas", S, "planted: the sender's fee cap"],
  // the kit's one floor (fold 3, review fold 2 LOW-A): evmPoolFee applies it, the sell's cap passes none
  [PF, "return stepped > EVM_POOL_FEE_FLOOR ? stepped : EVM_POOL_FEE_FLOOR;", "return stepped;", S, "planted: the sender's fee cap"],
  [PF, "export const EVM_POOL_FEE_FLOOR = EVM_POOL_FEE_STEP;", "export const EVM_POOL_FEE_FLOOR = 0n;", S, "planted: the sender's fee cap"],
  [PF, "export const EVM_POOL_FEE_STEP = 10_000_000_000_000n;", "export const EVM_POOL_FEE_STEP = 1_000_000_000_000n;", S, "planted: the sender's fee cap"],
  [QUOTE, "const feeMax = evmPoolSellFeeMax(chain, block.baseFeePerGas, chainFee);", "const feeMax = evmPoolSellFeeMax(chain, 2n * block.baseFeePerGas, chainFee);", S, "planted: the sender's fee cap"],
  // review fold 1 L1: the chain fee, read at the agreed block on both providers, in the one rule (pool-fee.ts)
  [QUOTE, "evmPoolSellFeeMax(chain, block.baseFeePerGas, chainFee)", "evmPoolSellFeeMax(chain, block.baseFeePerGas, 0n)", S, "L1 "],
  [QUOTE, "    ...evmPoolChainFeeReads(chain, EVM_POOL_SELL_GAS),\n", "", S, "L1 "],
  [QUOTE, 'if (chainFees.some((a) => a!.kind !== "out")) return refuse(', "if (false) return refuse(", S, "L1 "],
  [PF, "if (op(chain) && ok(2)) return answers[0]! + answers[1]!;", "if (op(chain) && ok(2)) return answers[0]!;", E, "L1 "],
  [PF, "const ARB_GAS_PER_CALLDATA_BYTE = 16n;", "const ARB_GAS_PER_CALLDATA_BYTE = 1n;", E, "L1 "],
  [PF, 'data: "0x" + SEL_OPERATOR_FEE + word(gas) }', 'data: "0x" + SEL_OPERATOR_FEE + word(txBytes) }', E, "L1 "],
  [PF, "export const EVM_POOL_TX_BYTES = 2_600n;", "export const EVM_POOL_TX_BYTES = 600n;", E, "L1 "],
  // review fold 1 L5: no sell whose deposit back would revert
  [QUOTE, "if (minOut - feeMax < EVM_POOL_MIN_DEPOSIT) return refuse(", "if (false) return refuse(", S, "L5 "],
  [QUOTE, "if (minOut - feeMax < EVM_POOL_MIN_DEPOSIT) return refuse(", "if (minOut - feeMax <= EVM_POOL_MIN_DEPOSIT) return refuse(", S, "L5 "],
  [PF, "export const EVM_POOL_MIN_DEPOSIT = 100_000_000_000_000n;", "export const EVM_POOL_MIN_DEPOSIT = 10_000_000_000_000n;", S, "L5 "],
  [PF, "((f + EVM_POOL_FEE_STEP - 1n) / EVM_POOL_FEE_STEP) * EVM_POOL_FEE_STEP", "(f / EVM_POOL_FEE_STEP) * EVM_POOL_FEE_STEP", S, "planted: the sender's fee cap"],
  [QD, "if (feeCap > feeMax) throw", "if (false) throw", S, "planted: the sender's fee cap"],
  [QD, "if (feeCap > feeMax) throw", "if (feeCap > feeMax + 1n) throw", S, "planted: the sender's fee cap"],
  [QD, "const feeCap = asked === undefined ? feeMax : asked;", "const feeCap = asked === undefined ? feeMax - 1n : asked;", S, "planted: the sender's fee cap"],
  [QUOTE, 'if (typeof boughtBlock !== "bigint" || boughtBlock < 1n) return refuse(', "if (false) return refuse(", S, "planted: a sell quote takes the buy's block"],
  [QUOTE, "boughtBlock < 1n) return refuse(", "boughtBlock < 0n) return refuse(", S, "planted: a sell quote takes the buy's block"],
  [QUOTE, "if (a.number >= minBlock && b.number >= minBlock) break;", "break;", R, "L5 "],
  [QUOTE, "if (a.number >= minBlock && b.number >= minBlock) break;", "if (a.number >= minBlock || b.number >= minBlock) break;", R, "L5 "],
  [QUOTE, "if (a.number >= minBlock && b.number >= minBlock) break;", "if (a.number > minBlock && b.number > minBlock) break;", R, "L5 "],
  [QUOTE, "    if (left() <= 0) return late();\n", "", R, "L5b "],
  [QUOTE, "export const EVM_MIN_BLOCK_WAIT_MS = 30_000;", "export const EVM_MIN_BLOCK_WAIT_MS = 3_000;", R, "L5b "],
  [QUOTE, "const EVM_MIN_BLOCK_EVERY_MS = 500;", "const EVM_MIN_BLOCK_EVERY_MS = 1_000;", R, "L5b "],
  // the reviewer's two survivors (review fold 1, L3): the wait's sleep gone, or of 0 ms
  [QUOTE, "    await new Promise((r) => setTimeout(r, EVM_MIN_BLOCK_EVERY_MS));\n", "", R, "L5b "],
  [QUOTE, "setTimeout(r, EVM_MIN_BLOCK_EVERY_MS)", "setTimeout(r, 0)", R, "L5b "],
  // review fold 1 M2 and L2: one deadline over the reads and the sleeps; the age at the clock after the wait
  [QUOTE, "const heads = minBlock === 0n ? await read : await within(read, left(), late);", "const heads = await read;", R, "M2 "],
  [QUOTE, "const left = () => EVM_MIN_BLOCK_WAIT_MS - (mono() - t0);", "const left = () => EVM_MIN_BLOCK_WAIT_MS;", R, "M2 "],
  [QUOTE, "const atMs = nowMs + Math.max(0, mono() - start);", "const atMs = nowMs;", R, "L2 "],
  // the age from the quote's entry, the scan's time included, on a sell and a buy (review fold 2, LOW-1)
  [QUOTE, "const atMs = nowMs + Math.max(0, mono() - start);", "const atMs = nowMs + Math.max(0, mono() - t0);", R, "LOW-1 "],
  [QUOTE, "agreedBlock(rpcs, v.maxLag, a.nowMs, a.minBlock, a.mono, a.start)", "agreedBlock(rpcs, v.maxLag, a.nowMs, a.minBlock, a.mono)", R, "LOW-1 "],
  [QUOTE, "    watch,\n    mono,\n    start,\n", "    watch,\n    mono,\n", R, "LOW-1 "],
  [QUOTE, "agreedBlock(rpcs, v.maxLag, a.nowMs, a.minBlock, a.mono, a.start)", "agreedBlock(rpcs, v.maxLag, a.nowMs)", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, mono, start });", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, minBlock: boughtBlock - 1n, mono, start });", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, minBlock: boughtBlock, start });", R, "M2 "],
  // the hook data rule on any hop, the first included (review fold 1, L3)
  [QUOTE, 'route.hops.some((h) => h.hookData !== "0x")) return refuse(', 'route.hops.slice(-1).some((h) => h.hookData !== "0x")) return refuse(', R, "HD1 "],
  [QUOTE, 'if (fee !== undefined && (typeof fee !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(fee))) return refuse(', "if (false) return refuse(", R, "R11 "],
  // the sim signer's signature recovers to W over SellDelegate's own digest (review of the exec sim, LOW 3)
  [SELLU, "      word(BigInt(chainId)),", "      word(0n),", S, "planted: the sim signer"],
];

// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`
let lastFail = "";
function run(dir, file, name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, file];
  try {
    // a mutant that hangs its test (a wait with no sleep) is killed by the time limit, never a sweep that hangs
    const out = execFileSync("node", args, { cwd: dir, stdio: "pipe", encoding: "utf8", timeout: 300_000 });
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
    const src = new Map([QUOTE, BUY, BUYU, SELLQ, SELLU, QD, PF].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const named = [...new Set(MUTANTS.map((m) => `${m[3]}\u0000${m[4]}`))].map((k) => k.split("\u0000"));
    const t0 = performance.now();
    for (const [file, t] of named) {
      const r = run(dir, file, t);
      if (r !== "pass") {
        console.log(`FAIL "${t}" in ${file} ${r === "none" ? "names no test" : `fails on the code as it is:\n${lastFail}`}`);
        bad++;
      }
    }
    console.log(`the ${named.length} named tests on the code as it is: ${Math.round(performance.now() - t0)} ms`);
    if (bad === 0) {
      MUTANTS.forEach(([file, find, repl, tf, t], i) => {
        const s = src.get(file);
        if (s.split(find).length !== 2) {
          console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
          bad++;
          return;
        }
        writeFileSync(join(dir, file), s.replace(find, repl));
        const t0 = performance.now();
        const r = run(dir, tf, t);
        const ms = Math.round(performance.now() - t0);
        writeFileSync(join(dir, file), s);
        console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"} (${ms} ms)`);
        if (r !== "fail") bad++;
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
