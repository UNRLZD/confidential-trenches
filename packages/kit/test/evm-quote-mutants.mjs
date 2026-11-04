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
  // review of 4830f1f: H1 the catch-up only up to a head the scan provider names again; L its depth, an answer at the
  // cap asked by halves, the hold timed on a clock that never steps back; H2 a cut set refuses
  [QUOTE, "    if (b - again > maxLag) return refuse(", "    if (false) return refuse(", R, "review of 4830f1f, H1"],
  [QUOTE, "    if (b - scanHead > BigInt(s.span)) return refuse(", "    if (false) return refuse(", R, "review of 4830f1f, L"],
  [QUOTE, "r.length < SCAN_MAX_LOGS)", "r.length <= SCAN_MAX_LOGS)", R, "review of 4830f1f, L"],
  [QUOTE, "      const m = mono();\n      const since = h === null ? -1 : m - h.at;\n      if (h !== null && since >= 0 && ", "      const m = clock();\n      const since = h === null ? -1 : m - h.at;\n      if (h !== null && ", H, "held head (review of 4830f1f, L)"],
  [QUOTE, "    if (keys.length > keysLeft) return refuse(", "    if (false) return refuse(", R, "review of 4830f1f, H2"],
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
  [QUOTE, "  for (const f of held) {\n    if (!startsBuy(f.other) || f.quotes.length > 0) continue;", "  for (const f of [] as Found[]) {\n    if (!startsBuy(f.other) || f.quotes.length > 0) continue;", R, "A1 "],
  [QUOTE, "  for (const f of held) {\n    if (!startsBuy(f.other) || f.quotes.length > 0) continue;", "  for (const f of found) {\n    if (!startsBuy(f.other) || f.quotes.length > 0) continue;", R, "S1c "],
  [QUOTE, "    if (keys.length > keysLeft) return refuse(", "    if (false) return refuse(", R, "T1b "],
  [QUOTE, "      if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n      continue;", "      return refuse(\"no_reference\", `${x} has no market`);", R, "B1 "],
  [QUOTE, "      if (markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n", "", R, "T3 "],
  [QUOTE, "    if (ks.size > keysLeft) return null;\n", "", R, "X3 "],
  [QUOTE, "    if (hooks.some(replaced)) c.real =", "    if (false) c.real =", R, "H2 "],
  [QUOTE, "    return x < y ? x : y;", "    return x;", R, "H2 "],
  [QUOTE, "      const span = part.length === 1 ? s.span : Math.min(s.span, s.orSpan ?? s.span);", "      const span = s.span;", R, "B1 "],
  [QUOTE, "    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));", "    const t = w(part[0]!.c);", R, "X2 "],
  [QUOTE, "[[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]]", "[[e0, null, w(weth), t], [e0, null, t, w(weth)]]", R, "S3 "],
  [QUOTE, "[e0, null, null, t]", "[e0, t]", R, "N1a "],
  [QUOTE, "const keys = [...(scanned?.pools.get(lower(token)) ?? []), ...hints].flatMap(", "const keys = [...hints].flatMap(", R, "N1a "],
  [QUOTE, "from: cached === undefined || cached.to < floor ? floor : cached.to + 1,", "from: floor,", R, "G4 "],
  [QUOTE, "  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", "  commit();\n  return { pools: new Map(each.map((e) => [e.c, e.pools])), commit };", R, "S2b "],
  [QUOTE, "    const sc = await scanOf(cs, \"markets\");", "    const sc = await (scanOf(cs, \"markets\") ?? Promise.resolve(null)).catch(() => null);", R, "G2 "],
  [QUOTE, "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]);", "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [p.key]);", R, "S3c "],
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
  [BUY, "if (!evmIsDeviceQuote(quote)) throw", "if (false) throw", Q, "Q7 "],
  [BUY, "if (!Number.isFinite(nowMs) || nowMs - Number(quote.block.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) {", "if (!Number.isFinite(nowMs)) {", Q, "Q7 "],
  [BUY, "if (!QUOTED_BUILDS.has(built)) throw", "if (false) throw", Q, "Q7 "],
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
  [QUOTE, "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount);", "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, amountIn);", R, "PB2 "],
  [QUOTE, "if (q !== null) append(legs, x, { q, p });", "", R, "PB "],
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
  [QUOTE, "override: { ...funded, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...funded }, tx };", R, "PE a pool"],
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
  [QUOTE, "override: { ...funded, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...funded, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } } };", R, "PE1 "],
  [QUOTE, "override: funded, tx }]);", "override: funded }]);", R, "PE6 "],
  [QUOTE, "balance: qty(gas * maxFee + 10n ** 18n)", "balance: qty(gas * maxFee - 1n)", R, "PE1 "],
  [QUOTE, "data: reads[i]!.data, ...reads[i]!.tx }", "data: reads[i]!.data }", R, "PE1 "],
  [QUOTE, 'if (block.baseFeePerGas === null) return refuse("rpc_error",', 'if (false) return refuse("rpc_error",', R, "PE7 "],
  [QUOTE, " || back.baseFeePerGas !== lo.baseFeePerGas) {", ") {", R, "R11 "],
  [QUOTE, 'if (fee !== undefined && (typeof fee !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(fee))) return refuse(', "if (false) return refuse(", R, "R11 "],
  // the sim signer's signature recovers to W over SellDelegate's own digest (review of the exec sim, LOW 3)
  [SELLU, "      word(BigInt(chainId)),", "      word(0n),", S, "planted: the sim signer"],
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
    const src = new Map([QUOTE, BUY, BUYU, SELLQ, SELLU].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
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
