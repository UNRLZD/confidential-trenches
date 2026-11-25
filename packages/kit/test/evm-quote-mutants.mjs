// Removes each of the EVM buy quote's checks (src/checks/evm/quote.ts, the quoted builder and signer in
// src/trade/evm/buy.ts, and the builder's admission of a device-quoted route's v4 middles in
// src/trade/evm/buy-unpinned.ts), one at a time, and runs the test named for it in test/evm-quote.test.ts or
// test/evm-quote-attacks.test.ts: each named test passes on the code as it is and fails on every mutant. The mutants are
// made in copies of the kit's sources and tests in fresh temporary folders inside the kit (so each copy resolves the
// same installed modules), removed at the end; the tree's own files are never changed. Exits 1 when a named test passes on its
// mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly once.
// The named tests are first run on the code as it is, then the mutants, each run judged the same way (one name alone, by
// its exit code) and JOBS at once, each in its own copy (each run is mostly a process's start: about 1 s each, 279 one
// after another took 266 s and the named tests one by one 140 s on GitHub's runner, readme-fresh-run at 47109a7).
// Each line prints its time.
//   node packages/kit/test/evm-quote-mutants.mjs [<k>/<n>]     (a heavy job: run it on a machine with spare cores)
// With <k>/<n> it runs part k of n only, mutant i in part (i % n) + 1 (scripts/mutant-part.mjs), and the named tests of those mutants
// on the code as it is; test:mutants runs the parts, one command each, so ci.yml's split shares them out.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as runGroup } from "../../../scripts/group-run.mjs";
import { sweepPartOrExit } from "../../../scripts/mutant-part.mjs";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const QUOTE = "src/checks/evm/quote.ts";
const BUY = "src/trade/evm/buy.ts";
const BUYU = "src/trade/evm/buy-unpinned.ts";
const Q = "test/evm-quote.test.ts";
const R = "test/evm-quote-attacks.test.ts";
const PR = "test/evm-pair-rank.test.ts";
const HP = "test/evm-hung-post.test.ts";
const FH = "test/evm-quote-follow-hung.test.ts";
const HC = "test/evm-hedge-clock.test.ts";
const H = "test/evm-quote-head.test.ts";
// a real cold and warm Robinhood quote's answers, replayed (card evm-quote-gas-used, review of e9b54f71, P2)
const RP = "test/evm-quote-gas-used-replay.test.ts";
// the sell quote (card evm-sell-device-quote) and the index's sell builder and signer that take only one
const SELLQ = "src/trade/evm/sell.ts";
const S = "test/evm-sell-quote.test.ts";
// the sim sell's builder and signer (card evm-quote-exec-sim)
const SELLU = "src/trade/evm/sell-unpinned.ts";
const QD = "src/trade/evm/quoted.ts";
const PF = "src/trade/evm/pool-fee.ts";
// W's releases at a sell (card evm-sell-no-release-in-flight, audit E-01): the verdict and the builder's guard
const SR = "src/trade/evm/sell-releases.ts";
const NR = "card evm-sell-no-release-in-flight";
const E = "test/evm-pool-fee.test.ts";

// [file, text, replacement, test file, the test that must fail]
export const MUTANTS = [
  // two providers at one block they both hold, no more than 30 s old
  [QUOTE, 'const same = (a: Answer, b: Answer) => (a.kind === "out" ? b.kind === "out" && a.amountOut === b.amountOut : b.kind === "revert" && a.partial === b.partial && a.overflow === b.overflow);', "const same = (a: Answer, b: Answer) => true;", Q, "Q2 "],
  [QUOTE, 'b.kind === "out" && a.amountOut === b.amountOut', 'b.kind === "out"', Q, "Q2 "],
  [QUOTE, 'b.kind === "revert" && a.partial === b.partial', 'b.kind === "revert"', Q, "Q2 "],
  // the X prune (card rh-cold-quote): an overflow named by one provider alone, the prune's verdict, its pinned-hook rule,
  // and one request a currency where fewer than the OR
  [QUOTE, " && a.partial === b.partial && a.overflow === b.overflow);", " && a.partial === b.partial);", R, "card rh-cold-quote: one provider that answers SafeCastOverflow"],
  [QUOTE, 'return r.kind === "revert" && (r.partial || r.overflow === true);', "return false;", R, "card rh-cold-quote: a cold Robinhood quote"],
  [QUOTE, "if (f.key.hooks !== NATIVE && !replaced(f.key)) continue;", "if (false) continue;", R, "card rh-cold-quote: a currency's pool behind a pinned hook"],
  // card evm-warm-tap-skips-pools-it-pruned: a pruned block another now (a reorg) proves nothing; a pool a log names is
  // asked again; each log read spans at most the chain's least provider's blocks
  [QUOTE, "if (a.pruned !== cut.hash || a.at !== lower(block.hash)) return new Set();", "if (false) return new Set();", R, "card evm-warm-tap-skips-pools-it-pruned"],
  [QUOTE, "if (same.has(f.id)) cutNow.set(f.id, cutBefore!.floors.get(f.id)!);", "if (true) cutNow.set(f.id, cutBefore!.floors.get(f.id)!);", R, "card evm-warm-tap-skips-pools-it-pruned"],
  [QUOTE, "const span = CUT_LOG_SPAN[chain];", "const span = 1_000n;", R, "card evm-warm-tap-skips-pools-it-pruned"],
  // card evm-cut-logs-only-where-served: a quote provider the venue does not list as answering logs is asked none, each
  // read by the URL its gate keeps
  [QUOTE, "return u === undefined || listed.includes(u);", "return true;", R, "card evm-cut-logs-only-where-served"],
  [QUOTE, "const u = GATED_URL.get(r) ?? URL_OF.get(r) ?? RPC_URL.get(r);", "const u = RPC_URL.get(r);", R, "card evm-cut-logs-only-where-served"],
  // card robinhood-cut-logs-off-the-index-seat: Robinhood's own RPC, the index sync's seat, is asked no cut log, and
  // dRPC alone proves nothing
  [BUYU, 'logProviders: Object.freeze(["https://robinhood.drpc.org"]),', 'logProviders: Object.freeze(["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"]),', R, "card robinhood-cut-logs-off-the-index-seat"],
  [QUOTE, "if (able.length < 2) return new Set();", "if (able.length < 1) return new Set();", R, "card robinhood-cut-logs-off-the-index-seat"],
  // card evm-spare-list-green: the prune skips only an X the token's last quote kept (main skipped any X whose markets
  // were ever scanned)
  [QUOTE, "const unsure = (x: string) => !keptBefore.has(x);", "const unsure = (x: string) => !SCANS.has(`${chain}:markets:${x}`);", R, "card evm-spare-list-green: a quote prunes a currency the quote before scanned"],
  [QUOTE, "const step = or < on.span && ", "const step = false && ", R, "card rh-cold-quote: a cold Robinhood quote"],
  // the prune's direction (the token out), a plain revert kept, and a cold request the first failed at once: asked as
  // its halves on the first, its newest blocks a request of their own (review of 9c962b6d)
  [QUOTE, "word(lower(k.currency1) === token ? 1n : 0n)", "word(lower(k.currency1) === token ? 0n : 1n)", R, "card rh-cold-quote: the prune reads the token out"],
  [QUOTE, 'return r.kind === "revert" && (r.partial || r.overflow === true);', 'return r.kind === "revert";', R, "card rh-cold-quote: a currency's pool whose exact-output read reverts with no data"],
  [QUOTE, "const alone = !fast && on.next !== undefined && b - a + 1 > SCAN_ALONE;", "const alone = false;", R, "card rh-cold-quote: a first whose cold requests over 100,000 blocks holding the real pool's block run out of time"],
  [QUOTE, "    if (on.next !== undefined && to === head && to - from + 1 > on.next.span) {", "    if (false && on.next !== undefined && to === head && to - from + 1 > on.next.span) {", R, "card rh-cold-quote: a first whose backend is a block behind"],
  [QUOTE, "const SCAN_ALONE = 100_000;", "const SCAN_ALONE = 1_000_000;", R, "card rh-cold-quote: a cached scan's 500,000-block gap with one 503"],
  // a cold scan's first throttled past the bound, any failure over SCAN_ALONE blocks, and a flood at the smallest span
  // (review of 8fd51265)
  [QUOTE, "if (next === undefined || e instanceof ScanStop) throw e;", "if (next === undefined) throw e;", R, "card rh-cold-quote: a cold scan's first throttled past"],
  [QUOTE, "throw fast ? new EvmQuoteError(\"rpc_error\", m) : new ScanStop(\"rpc_error\", m);", "throw new EvmQuoteError(\"rpc_error\", m);", R, "card rh-cold-quote: a cold scan's first throttled past"],
  // a 503 over SCAN_ALONE is asked again whole by the gate since card robinhood-quote-answers-cold, so neither 503 test
  // reaches the halving these two plant (nightly run 44385000155); a timeout, which spends its one try, does (card
  // mutants-killed-on-main)
  [QUOTE, "    if (alone) return halves(splits);\n", "", R, "card rh-cold-quote: a first whose cold requests over 100,000 blocks holding the real pool's block run out of time"],
  [QUOTE, "    if (answered || behind || rs !== null) return short();\n", "", R, "card rh-cold-quote: 12,000 made-up pools past the first's cap, answered in rpc.mainnet"],
  // card evm-quote-rides-out-a-one-block-answer: one block answered short is asked again of the same provider, never
  // the next, rpc_error where the last ask was not answered; logs behind a block the provider holds are asked again
  // whole, never as halves
  [QUOTE, "      for (let t = 1; t < SCAN_TRIES; t++) {", "      for (let t = 1; t < 1; t++) {", R, "OB1 "],
  [QUOTE, "            if (e instanceof ScanStop) throw e;\n            said = e instanceof ScanAnswered;", "            throw e;\n            said = e instanceof ScanAnswered;", R, "OB3 "],
  [QUOTE, "      if (!shortLast) throw new ScanStop(", "      if (false) throw new ScanStop(", R, "OB5 "],
  [QUOTE, "    if (behind && behindLeft > 0) {", "    if (false) {", R, "OB4 "],
  [QUOTE, "  shortMax += 2 * jobs.length;\n  // a scan the second carries whole", "  // a scan the second carries whole", R, "card rh-cold-quote: a cold Base scan whose first answers each of its starting requests once"],
  [QUOTE, "        if (shorts > shortMax) throw new ScanStop(", "        if (false) throw new ScanStop(", R, "card rh-cold-quote: a first that answers -32602 to every getLogs"],
  [QUOTE, "if (e instanceof BadAnswer) throw new ScanAnswered(", "if (false) throw new ScanAnswered(", R, "card rh-cold-quote: a first that answers HTTP 413"],
  [QUOTE, "if (text === null || !lagBody(text)) throw new BadAnswer(m);", "if (text === null || !lagBody(text)) throw new Error(m);", R, "card rh-cold-quote: a first that answers HTTP 413"],
  [QUOTE, "throw new ScanStop(\"too_many_pools\",", "throw new EvmQuoteError(\"too_many_pools\",", R, "card rh-cold-quote: one block holding more pools"],
  [QUOTE, "} else if (top && typeof h?.hash !== \"string\") return null;", "} else if (top && typeof h?.hash !== \"string\") return filters.map(() => undefined);", R, "SP3 "],
  [QUOTE, "const at = { blockHash: hash, requireCanonical: true };", "const at = { blockHash: hash };", Q, "Q1 "],
  [QUOTE, "const near = (x: Block, y: Block) => x.number - y.number <= maxLag && y.number - x.number <= maxLag;", "const near = (x: Block, y: Block) => true;", R, "R5 "],
  [QUOTE, "if (back.number !== lo.number || back.hash !== lo.hash || back.timestamp !== lo.timestamp || back.baseFeePerGas !== lo.baseFeePerGas) {", "if (false) {", R, "R1b "],
  [QUOTE, "back.number !== lo.number || back.hash !== lo.hash || back.timestamp", "back.number !== lo.number || back.timestamp", R, "R5 "],
  [QUOTE, " || back.timestamp !== lo.timestamp || back.baseFeePerGas", " || back.baseFeePerGas", R, "R5 "],
  [QUOTE, "const [lo, at, own] = a.number <= b.number ? [a, j, i] : [b, i, j];", "const [lo, at, own] = a.number <= b.number ? [a, i, i] : [b, j, j];", R, "R5 "],
  [QUOTE, 'if (confirmed.status === "rejected") throw confirmed.reason;', "", R, "R1b "],
  [QUOTE, "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (false) return refuse(", H, "held head: the watch itself refuses a block more than 30 s behind"],
  [QUOTE, "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS) return refuse(", "if (atMs - Number(lo.timestamp) * 1000 > EVM_QUOTE_MAX_AGE_MS + 1000) return refuse(", H, "held head: the watch itself refuses a block more than 30 s behind"],
  [QUOTE, 'if (!Number.isFinite(nowMs)) return refuse("bad_request", "the device\'s clock");', "", Q, "Q14 "],
  [QUOTE, "maxLag: Object.hasOwn(v, \"maxLag\") && Number.isSafeInteger(v.maxLag) ? BigInt(v.maxLag!) : 0n,", "maxLag: 1000n,", R, "R5 "],
  // a partial fill
  [QUOTE, 'if (m.kind === "revert" && m.partial) return missed("partial_fill", "a hookless hop runs out of liquidity (NotEnoughLiquidity)");', "", Q, "Q3 "],
  [QUOTE, "d.slice(8 + 128, 8 + 128 + 8) === NOT_ENOUGH_LIQUIDITY", "d.slice(8 + 64, 8 + 64 + 8) === NOT_ENOUGH_LIQUIDITY", Q, "Q3 "],
  [QUOTE, "if (q2 !== null && q2 <= q) return missed(", "if (q2 !== null && q2 < q) return missed(", Q, "Q3 "],
  [QUOTE, "if (q2 !== null && q2 <= q) return missed(", "if (false) return missed(", Q, "Q3 "],
  [QUOTE, 'if (q2 === null && route.venue === "uniswap-v3" && !gas2) return missed(', "if (false) return missed(", R, "R8 "],
  [QUOTE, "    if (!isV3) return true;\n", "    return true;\n", Q, "Q3 "],
  [QUOTE, "    if (y !== null) return y > x;", "    if (y !== null) return true;", Q, "Q3 "],
  [QUOTE, 'fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route', "fills(c) ? [{ route: c.route", Q, "Q3 "],
  // the device's own reference: every standard route through every listed middle on both venues, and the pinned
  // launchpad pools
  [QUOTE, "  if (value < reference.amountOut && !underHooked) {", "  if (false) {", Q, "Q5 "],
  [QUOTE, "  if (value < reference.amountOut && !underHooked) {", "  if (value <= reference.amountOut && !underHooked) {", Q, "Q1 "],
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
  [QUOTE, "      const signal = until === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), until]);", "      const signal = until;", R, "T4 "],
  [QUOTE, "  if (r.length !== 2 + 2 * (64 + 32 * n)) return refuse(", "  if (false) return refuse(", R, "T6 "],
  [QUOTE, "const hints = (Array.isArray(a.hints) ?", "const hints = (false ?", R, "N1b "],
  // (SP3, not N1a: N1a's provider answers its newest request's head block with an error too, refused there since card
  // evm-scan-second-provider)
  [QUOTE, "    if (rs !== null && fine(rs)) return void keep(rs);", "    if (rs !== null) return void keep(rs);", R, "card rh-cold-quote: one block holding more pools"],
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
  [QUOTE, "    const since = h === null ? -1 : m - h.at;\n    return h !== null && since >= 0 && since <= EVM_HEAD_REUSE_MS && h.age + since <= EVM_QUOTE_MAX_AGE_MS && t - Number(h.block.timestamp) * 1000 <= EVM_QUOTE_MAX_AGE_MS ? h.block : null;\n  };\n  return {\n    keep,\n    peek(nowMs) {\n      keep();\n      return fresh(Math.max(nowMs, clock()), mono());\n    },\n    // young on both clocks, as `fresh` (review of this card, P2-1: on the device's clock alone, one running 60 s slow\n    // let a block confirmed 70 s before be read as 10 s old): `mono` since it was confirmed, its age then plus that, and\n    // its age on the device's clock now\n    held(hash, nowMs) {\n      const c = confirmed.get(typeof hash === \"string\" ? hash.toLowerCase() : \"\");\n      if (c === undefined) return null;\n      const since = mono() - c.at;\n      const t = Math.max(nowMs, clock());\n      return since >= 0 && since <= EVM_FOLLOW_MAX_AGE_MS && c.age + since <= EVM_FOLLOW_MAX_AGE_MS && t - Number(c.block.timestamp) * 1000 <= EVM_FOLLOW_MAX_AGE_MS ? c.block : null;\n    },\n    async head(nowMs) {\n      keep();\n      // the device's clock now: a quote asks after its scan, which may have run for seconds since `nowMs`\n      const t = Math.max(nowMs, clock());\n      const m = mono();", "    const since = h === null ? -1 : m - h.at;\n    return h !== null && since <= EVM_HEAD_REUSE_MS && h.age + since <= EVM_QUOTE_MAX_AGE_MS && t - Number(h.block.timestamp) * 1000 <= EVM_QUOTE_MAX_AGE_MS ? h.block : null;\n  };\n  return {\n    keep,\n    peek(nowMs) {\n      keep();\n      return fresh(Math.max(nowMs, clock()), mono());\n    },\n    // young on both clocks, as `fresh` (review of this card, P2-1: on the device's clock alone, one running 60 s slow\n    // let a block confirmed 70 s before be read as 10 s old): `mono` since it was confirmed, its age then plus that, and\n    // its age on the device's clock now\n    held(hash, nowMs) {\n      const c = confirmed.get(typeof hash === \"string\" ? hash.toLowerCase() : \"\");\n      if (c === undefined) return null;\n      const since = mono() - c.at;\n      const t = Math.max(nowMs, clock());\n      return since >= 0 && since <= EVM_FOLLOW_MAX_AGE_MS && c.age + since <= EVM_FOLLOW_MAX_AGE_MS && t - Number(c.block.timestamp) * 1000 <= EVM_FOLLOW_MAX_AGE_MS ? c.block : null;\n    },\n    async head(nowMs) {\n      keep();\n      // the device's clock now: a quote asks after its scan, which may have run for seconds since `nowMs`\n      const t = Math.max(nowMs, clock());\n      const m = clock();", H, "held head (review of 4830f1f, L)"],
  // card evm-quote-one-round (review of c71a4d0..a9f1d32): every bound refuses, never cuts; the caller's list beside it
  [QUOTE, "    if (fromScan.length > keysLeft) return refuse(", "    if (false) return refuse(", R, "KB2 "],
  [QUOTE, "if (fromScan.length > keysLeft)", "if (keys.length > keysLeft)", R, "KB1 "],
  [QUOTE, 'if (ks.size > keysLeft) return refuse("too_many_pools", `the markets of', 'if (false) return refuse("too_many_pools", `the markets of', R, "KB3 "],
  [QUOTE, "      if (ks.length > keysLeft) return refuse(", "      if (false) return refuse(", R, "KB4 "],
  // the prune (review of 13a063e): a buy's pool, market or via dropped only where its bound (the amount at its spot
  // price after its fee) cannot give Q, a pinned hook never; every pool kept quoted, past the budgets a refusal
  [QUOTE, "    floor: (out) => lows.reduce((m, i) => {", "    floor: undefined, unused: (out: (i: number) => bigint | null) => lows.reduce((m: bigint, i: number) => {", R, "RK3 "],
  [QUOTE, "    if (x === null || (f.key.hooks !== NATIVE && !replaced(f.key))) return null;", "    if (x === null) return null;", R, "PROBE C "],
  [QUOTE, "    const y = cdiv(x * (1_000_000n - (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", "    const y = x;", R, "RK3 "],
  [QUOTE, "    const y = cdiv(x * (1_000_000n - (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", "    const y = cdiv(x * (1_000_000n - 2n * (fee < 1_000_000n ? fee : 1_000_000n)), 1_000_000n);", R, "RK8 "],
  [QUOTE, "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 192n, p * p);", "    return zf(f) ? cdiv(y * p * p, 1n << 193n) : cdiv(y << 192n, p * p);", R, "RK8 "],
  [QUOTE, "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 192n, p * p);", "    return zf(f) ? cdiv(y * p * p, 1n << 192n) : cdiv(y << 191n, p * p);", R, "RK8 "],
  [QUOTE, "  const zf = (f: Found) => f.other === f.key.currency0;", "  const zf = (f: Found) => f.other !== f.key.currency0;", R, "RK3 "],
  [QUOTE, "    return u === null || u >= floor;", "    return u !== null && u >= floor;", R, "PROBE C "],
  [QUOTE, "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn)) f.quotes.push(", "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn / 1000n)) f.quotes.push(", R, "PROBE D "],
  [QUOTE, "        if (!can(p, xa)) continue;\n        const e = viaX.get(earlyKey(mk, p));", "        if (!can(p, xa / 1000n)) continue;\n        const e = viaX.get(earlyKey(mk, p));", R, "PROBE A "],
  // since card frong-quotes-through-its-pools a market the prune leaves out may still be quoted (the best one left), so
  // the dust tick pushes the real market out only with that fallback gone too: both in one plant
  [QUOTE, "        if (!needs(c, ub)) {\n          // a market left out has a bound (one with none can always give Q); one with no hook first, whose bound is the\n          // pool's own (a hook replaced by one that does nothing may leave a pool whose real price its hook makes: of\n          // USDG's markets for FOBO the largest bound was such a pool's, 2,198,245 against the standard 0.01% pool's\n          // 1,867,080, and its quote did not fill)\n          const plain = mk.key.hooks === NATIVE;\n          if (ub !== null && (left === null || (plain && !left[2]) || (plain === left[2] && ub > left[1]))) left = [mk, ub, plain];\n          continue;\n        }\n        marketQuote.set(mk, leg === null ? quoteOf(into, routeOfKey(mk.key, c), [mk.key]) : quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount));\n      }\n      if (priceOf && !a.sell && left !== null) marketQuote.set(left[0], quoteOf(into, routeOfKey(left[0].key, c), [left[0].key]));", "        if (!needs(c, ubOf(mk, amountIn / 1000n))) {\n          // a market left out has a bound (one with none can always give Q); one with no hook first, whose bound is the\n          // pool's own (a hook replaced by one that does nothing may leave a pool whose real price its hook makes: of\n          // USDG's markets for FOBO the largest bound was such a pool's, 2,198,245 against the standard 0.01% pool's\n          // 1,867,080, and its quote did not fill)\n          const plain = mk.key.hooks === NATIVE;\n          if (ub !== null && (left === null || (plain && !left[2]) || (plain === left[2] && ub > left[1]))) left = [mk, ub, plain];\n          continue;\n        }\n        marketQuote.set(mk, leg === null ? quoteOf(into, routeOfKey(mk.key, c), [mk.key]) : quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount));\n      }\n      if (false) marketQuote.set(left[0], quoteOf(into, routeOfKey(left[0].key, c), [left[0].key]));", R, "PROBE A2 "],
  // the direct clause alone: PROBE A2's best market left out is still quoted by that fallback, so it passed this mutant
  // (nightly run 44385000155); RK5's narrow markets out-bound the real one, so the fallback quotes a narrow one and the
  // real market is quoted only through this clause (card mutants-killed-on-main)
  [QUOTE, "    (xPools.get(c) ?? []).some((p) => can(p, x)) ||", "    false ||", R, "RK5 "],
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
  [QUOTE, '  const scanning = scanOf([lower(token)], "all");', '  void agreedOnce();\n  const scanning = scanOf([lower(token)], "all");', R, "card evm-quote-head-watch: the agreed block is picked once"],
  // card evm-pool-index-route: a served index that covers the agreed head feeds the token's scan, its markets scans and the
  // warm round with no getLogs; one that is not whole is never served
  [QUOTE, "    const ixs = indexScanOf(chain, kind, c, weth, floor);\n", "    const ixs = undefined as ReturnType<typeof indexScanOf>;\n", R, "F10 "],
  [QUOTE, "    const ixs = indexScanOf(chain, kind, c, weth, floor);\n", "    const ixs = undefined as ReturnType<typeof indexScanOf>;\n", R, "F10w "],
  [QUOTE, "if (ix === undefined || ix.through < floor) return undefined;", "if (ix === undefined || ix.through < floor || kind === \"markets\") return undefined;", R, "F10 "],
  [QUOTE, "  const n = sync?.coversThrough;", "  const n = sync?.coversThrough ?? 5_000_000;", R, "F10p "],
  // card evm-first-quote-reads-its-coin-at-any-age: a coin's read past a stale whole index not read; a whole index that
  // leaves out its pool served
  [QUOTE, "  if (own !== undefined && (ix === undefined || own.through > ix.through)) return own;", "", R, "COINQ "],
  [QUOTE, "  if (!coinsAgree(chain, byCurrency, n)) return false;\n  INDEXES.set(", "  INDEXES.set(", R, "COINQ "],
  [QUOTE, "    return v.pools.every((p) => ids.has(poolId(p)));", "    return true;", R, "COINQ "],
  [QUOTE, "    if (!coinsAgree(chain, held.byCurrency, n)) return false;\n", "", R, "COINQ "],
  // card evm-index-kept-at-the-head: an index synced on to the head serves a new coin's cold buy with no getLogs
  [QUOTE, "    const ixs = indexScanOf(chain, kind, c, weth, floor);\n", "    const ixs = undefined as ReturnType<typeof indexScanOf>;\n", R, "F10k "],
  [QUOTE, "  if (held !== undefined && held.through >= n) return held.through === n && held.from === ix.from;", "  if (held !== undefined) return held.through === n && held.from === ix.from;", R, "F10k "],
  // card evm-index-kept-at-the-head: a gap sync with no new pool moves the served index's N alone (always re-serving fails)
  [QUOTE, "  if (held !== undefined && held.from === ix.from && held.count === sync.pools.length", "  if (false && held !== undefined && held.from === ix.from && held.count === sync.pools.length", R, "F10s "],
  [QUOTE, "  if (held !== undefined && held.from === ix.from && held.count === sync.pools.length && sync.pools.every((p) => held.ids.has(indexedName(p))))", "  if (held !== undefined && held.from === ix.from && held.count === sync.pools.length)", R, "F10s "],
  // card evm-quote-fast-from-asia: a warm buy's round beside its scan, used only where the scan agrees its block and pools
  [QUOTE, "    if (a.sell || a.minBlock !== undefined || a.speculate === false || ", "    if (true || ", R, "W7 "],
  [QUOTE, "  return a.size === b.size && [...a].every((id) => b.has(id));", "  return true;", R, "W8 "],
  [QUOTE, "if (agreedNow.block.number !== block.number || agreedNow.block.hash !== block.hash || !samePools(", "if (!samePools(", R, "W9 "],
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
  // card evm-scan-second-provider: a request the first scan provider fails goes to the second; the first passes on at
  // once a refused connection and a throttle held past 2 s; the newest request asks its head block in its batch
  [QUOTE, "      if (next === undefined || e instanceof ScanStop) throw e;", "      throw e;", R, "SP1 "],
  [QUOTE, "            if (spareNext && !deep) throw new ScanRefused(", "            if (false) throw new ScanRefused(", R, "SP1 "],
  // a fast request held at a slot when another request's Retry-After lands (the chain's tail read beside a `later` one,
  // after the answer): SP4's warm request is refused by its hold before it reaches the gate's slot
  [QUOTE, "      if (fast && resumeAt - now > EVM_SCAN_HOLD_MS) throw", "      if (false) throw", R, "SP4b "],
  [QUOTE, "    const left = fast && hedge === undefined ? Math.min(toBound, EVM_SCAN_HOLD_MS) : toBound;", "    const left = toBound;", R, "SP6 "],
  [QUOTE, "  const fast = second !== undefined && jobs.reduce(", "  const fast = second !== undefined && 0 * jobs.reduce(", R, "SP2 "],
  [QUOTE, "    const top = p === null;", "    const top = false;", R, "SP3 "],
  // review of 22e29c9, B2: the block check on the request up to the head alone; since card evm-rpc-spare-list a not-yet
  // newest request is asked again whole, never as halves (SL3), so SP7 and SP9 send no request below the head and pass
  // on this mutant: SL5 holds it, a lag over one span, so the lower request ends past the backend too
  [QUOTE, "    const top = p === null;", "    const top = p === null && b === head;", R, "SL5 "],
  // review of 22e29c9, B1: a head read on the second sent the scan's requests there too
  [QUOTE, "headFrom(f)).then((head) => ({ head, first: f, own: ownOf(f) })));", "headFrom(f)).then((head) => ({ head, first: f.next ?? f, own: ownOf(f) })));", R, "SP6 "],
  // card evm-quote-rides-a-scan-lag-at-max: a scan up to a head no scan provider named reads up to their own head where
  // its provider does not hold the newest block, within maxLag alone; a follow's pinned block is such a head too
  [QUOTE, "        if (h !== null && h < b && head - h <= lag) return ((ownTo = h), null);\n", "", R, "LAGMAX1 "],
  [QUOTE, "if (h !== null && h < b && head - h <= lag) return", "if (h !== null && h < b) return", R, "LAGMAX3 "],
  [QUOTE, "(a.pin === undefined && spec === null ? undefined :", "(spec === null ? undefined :", R, "LAGMAX4 "],
  // review of 22e29c9, N4: the 2 s hold where no second follows (the head read), and a not-yet block as an answer
  [QUOTE, "      fast &&= spareNext;", "", R, "SP8 "],
  [QUOTE, 'throw on.next !== undefined ? new ScanRefused("rpc_error", m) : new NotHeldYet("rpc_error", m);', "return out;", R, "SP3 "],
  [QUOTE, "    if (fast && on.next !== undefined) throw new ScanRefused(", "    if (false) throw new ScanRefused(", R, "SP5 "],
  // card evm-rpc-spare-list: a request the second fails goes to the third, the head too; a 5xx passes on at once; a
  // not-yet block is asked again whole; a one-call batch's bare answer is read
  [QUOTE, "      await settle(rest.map((r) => run({ ...r, into: j.into })));", "      await settle(rest.map((r) => one({ ...r, into: j.into })));", R, "SL1 "],
  [QUOTE, "(o.next === undefined ? Promise.reject(e) : inTurn(o.next))", "Promise.reject(e)", R, "SL1 "],
  // re-anchored (card evm-unreachable-moves-on): the 5xx test is serverFault's since card evm-5xx-holds-the-provider-
  // for-the-round; SL1 passes on it (the request still reaches the next after its tries), SP5xx does not
  [QUOTE, "          if (spareNext && out5xx && !deepCall) {", "          if (false && out5xx && !deepCall) {", R, "SP5xx "],
  [QUOTE, "    if (notYet) {", "    if (false) {", R, "SL3 "],
  [QUOTE, "calls.length === 1 && typeof parsed === \"object\" && parsed !== null ? [parsed] : parsed;", "false ? [parsed] : parsed;", R, "SL4 "],
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
  // a gate per scan never has more in flight; G1 and TH3 hold the scan gate's own limit, T8b the reads' gate's)
  [QUOTE, "(scanFrom ??= (a.pin !== undefined", "(scanFrom = (a.pin !== undefined", R, "G3 "],
  [QUOTE, "if (next === undefined) free++;\n      else next();", "free++;\n      next?.();", R, "T8b "],
  // review of 2afa8b6 (fold 8): every held pool and X priced at the user's amount within fixed-order bounds that never
  // refuse; a hooked route counts at the lower of its hook replaced and as it is; unlisted v4 middles of a device quote
  // build; scans as ORs within a provider's span; 429s asked again; each provider at most its limit at once
  [QUOTE, "    if (!out.some(notYet) || i === 3 || gate?.done?.() === true) return out;", "    return out;", R, "R10 "],
  // card evm-warm-tap-ends-inside-two-seconds: a seat whose round is agreed is asked again for a not-yet answer (Q6)
  [QUOTE, "    if (!out.some(notYet) || i === 3 || gate?.done?.() === true) return out;", "    if (!out.some(notYet) || i === 3) return out;", "test/evm-quorum.test.ts", "Q6 "],
  [QUOTE, "for (const { k, id } of ordered) {", "for (const { k, id } of [] as typeof ordered) {", R, "N1a "],
  [QUOTE, "    if (startsBuy(f.other) && f.quotes.length === 0 && can(f, amountIn)) f.quotes.push(", "    if (false) f.quotes.push(", R, "A1 "],
  // (no mutant reads `found` for `held` here: a buy's pool the PoolManager does not hold reads a price of 0, which the
  // prune's bound reads as giving nothing, so it is never quoted and its hook never replaced; S1c holds that rule)
  [QUOTE, "    if (!trades && markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n", "    if (!trades) return refuse(\"no_reference\", `${x} has no market`);\n", R, "B1 "],
  [QUOTE, "    if (!trades && markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);\n", "", R, "T3 "],
  // the warm round (card evm-quote-warm-round): the last quote's later reads asked in the first round within the range,
  // each counted only where the quote asks it again; its scans started beside the token's; a connect failure asked again
  [QUOTE, "      const i = kept.get(readKey(r));", "      const i = undefined as number | undefined;", R, "W1 "],
  [QUOTE, "  if (plan !== undefined && block.timestamp >= plan.ts && block.timestamp - plan.ts <= EVM_WARM_RANGE_S) {", "  if (plan !== undefined) {", R, "W4 "],
  [QUOTE, "  PLANS.set(planKey, {", "  if (false) PLANS.set(planKey, {", R, "W1 "],
  [QUOTE, 'r.override === undefined && !r.data.startsWith("0x" + SEL_V4_OUT_SINGLE) && (!kept.has(readKey(r)) || hit.has(first + j))', 'r.override === undefined && !r.data.startsWith("0x" + SEL_V4_OUT_SINGLE) && (!kept.has(readKey(r)) || true)', R, "W5 "],
  [QUOTE, "filter((r, j) => r.override === undefined && !r.data.startsWith(", "filter((r, j) => !r.data.startsWith(", R, "W6f "],
  [QUOTE, "  const early = plan === undefined ? [] : plan.scans.map((p) => scanAt(p.cs, p.kind, true));", "  const early: ReturnType<typeof scanAt>[] = [];", R, "W4 "],
  [QUOTE, "if (e instanceof TypeError && (cause === undefined || (typeof code === \"string\" && CONNECT_ERRORS.has(code)))) {", "if (false) {", R, "T7b "],
  [QUOTE, "if (e instanceof TypeError && (cause === undefined || (typeof code === \"string\" && CONNECT_ERRORS.has(code)))) {", "if (e instanceof Error) {", R, "T7b "],
  [QUOTE, "if (e instanceof TypeError && (cause === undefined || (typeof code === \"string\" && CONNECT_ERRORS.has(code)))) {", "if (e instanceof TypeError) {", R, "T7b "],
  [QUOTE, "!(e instanceof RateLimited || e instanceof Unreachable) || i === 3", "!(e instanceof RateLimited || e instanceof Unreachable) || i === 4", R, "T7b "],
  // the providers (card evm-quote-warm-round): any two that agree decide; a spare is asked when one fails, is slow or
  // differs; the quote's later rounds ask the two that agreed first; the next quote asks the fastest first
  [QUOTE, "          const peers = got.filter((x) => same(x.v, v));", "          const peers = got.filter(() => true);", Q, "Q2 "],
  [QUOTE, "          if (!contested && got.length >= 2) start();", "", R, "V3 "],
  [QUOTE, "      if (x !== undefined && y !== undefined) {\n        try {", "      if (false) {\n        try {", R, "V2 "],
  [QUOTE, "          failed ??= { e };\n          if (done) return;\n          start(true);", "          failed ??= { e };\n          if (done) return;", R, "V1 "],
  [QUOTE, "        timer = setTimeout(fire, ms);", "        timer = setTimeout(() => undefined, ms);", R, "V1 "],
  [QUOTE, "first < 0 ? 4 * EVM_HEDGE_MS : Math.max(EVM_HEDGE_MS, first));", "EVM_HEDGE_MS);", R, "V5 "],
  [QUOTE, "first < 0 ? 4 * EVM_HEDGE_MS : Math.max(EVM_HEDGE_MS, first));", "first < 0 ? 4 * EVM_HEDGE_MS : EVM_HEDGE_MS);", R, "V5 "],
  [QUOTE, "            first = performance.now() - (sentAt[k] ?? t0[k]!);\n            arm();", "            first = performance.now() - (sentAt[k] ?? t0[k]!);", R, "V1 "],
  [QUOTE, "        order.forEach((r, n) => ((rpcs as EvmRpc[])[n] = r));", "", R, "V1 "],
  [QUOTE, "        failed ??= { e };\n        if (n === 0) unsure = true;\n        continue;", "        throw e;", R, "V3 "],
  [QUOTE, "[rankClass(u, now), cost(u), k] as const;", "[0, cost(u), k] as const;", R, "V4 "],
  [QUOTE, "late.length > 0 && s!.last < Math.min(...late) ? 1 : 0);", "0);", "test/evm-pair-rank.test.ts", "R2 "],
  [QUOTE, "  if (till > now) return 20 + last;", "  if (till > now) return 1 + last;", R, "V4 "],
  [QUOTE, "      if (out.some(limited) || out.some(stateless)) s.held = performance.now() + (out.some(stateless) ? EVM_HOLD_MS : throttleHoldMs(url, null));\n      // an answer for a block the provider does not hold yet is no measure of its speed (re-review INFO 4)\n      else if (!out.some(notYet)) {", "      {", R, "V4 "],
  // card evm-quote-lag-held: a lower head more than maxLag below the scan provider's holds its provider and the block
  // is agreed again without it; a 200 carrying a state error holds its provider in the ranking
  [QUOTE, "    if (!(await behind(got.block))) return got;\n    if (got.low === undefined) {", "    return got;\n    if (got.low === undefined) {", R, "LH1 "],
  [QUOTE, "    const low = got.low!;\n    HOLD.get(low)?.();", "    const low = got.low!;", R, "LH1 "],
  [QUOTE, "    if (!Object.isFrozen(rpcs)) [...rest, low].forEach((r, n) => ((rpcs as EvmRpc[])[n] = r));", "", R, "LH1 "],
  [QUOTE, "return { block: lo, confirm, low: list[own]! };", "return { block: lo, confirm, low: list[at]! };", R, "LH1 "],
  [QUOTE, "if (out.some(limited) || out.some(stateless)) s.held", "if (out.some(limited)) s.held", R, "LH2 "],
  // the review of the lag hold: each no-longer answer, never a revert, a non-2xx answer, the whole list's majority, the
  // two-provider list, one wait
  [QUOTE, "/historical state \\S+ is not available|archive", "/archive", R, "LH2b "],
  [QUOTE, "|archive requests require a personal token|", "|", R, "LH2b "],
  [QUOTE, "!reverted(a) && /historical state", "/historical state", R, "LH2b "],
  [QUOTE, "  return e?.code === 3 || (typeof e?.message", "  return (typeof e?.message", R, "LH2b "],
  [QUOTE, " || (typeof e?.message === \"string\" && /^execution reverted/i.test(e.message));", ";", R, "LH2b "],
  [QUOTE, "    if (!res.ok && lagText === null) {", "    if (false) {", R, "LH3 "],
  // the re-review of the fold: drpc's no-longer answer, a revert never a state or a limit, a refused answer's body, a
  // not-yet answer untimed, a compute-units limit
  [QUOTE, "|^unknown state\\b/i", "/i", R, "LH2b "],
  [QUOTE, "|^unknown state\\b/i", "/i", R, "RQ1 "],
  [QUOTE, "return !reverted(a) && typeof m === \"string\" && evmNotYetWords(m);", "return typeof m === \"string\" && evmNotYetWords(m);", R, "RQ2 "],
  [QUOTE, "!reverted(a) && /request limit", "/request limit", R, "RQ3 "],
  [QUOTE, "!reverted(a) && /request limit", "/request limit", R, "RQ4 "],
  [QUOTE, "      await res.body?.cancel().catch(() => {});\n", "", R, "LQ3 "],
  [QUOTE, "      else if (!out.some(notYet)) {", "      else {", R, "LQ4 "],
  [QUOTE, "|too many requests|exceeded its compute units per second/i", "|too many requests/i", R, "LQ5 "],
  [QUOTE, "const need = Math.floor(Math.max(of, list.length) / 2) + 1;", "const need = Math.floor(list.length / 2) + 1;", R, "LM2 "],
  [QUOTE, "    if (rest.length < 2) return got;", "", R, "LL4 "],
  [QUOTE, "(waitFrom ??= (a.mono ?? monotonic)())", "(a.mono ?? monotonic)()", R, "LW "],
  [QUOTE, "      if (s.last <= t || now - s.failed < EVM_HOLD_MS) s.held = now + (e instanceof RateLimited ? throttleHoldMs(url, e.afterMs) : EVM_HOLD_MS);\n      s.failed = now;\n      throw e;", "      s.failed = now;\n      throw e;", R, "V4 "],
  // card evm-warm-tap-ends-inside-two-seconds, round (D): a lost post holds its provider at a stall (R4) or at its second
  // loss within EVM_HOLD_MS (R5), never at one loss among answers (R3)
  [QUOTE, "if (s.last <= t || now - s.failed < EVM_HOLD_MS) s.held", "if (now - s.failed < EVM_HOLD_MS) s.held", PR, "R4 "],
  [QUOTE, "if (s.last <= t || now - s.failed < EVM_HOLD_MS) s.held", "if (s.last <= t) s.held", PR, "R5 "],
  [QUOTE, "if (s.last <= t || now - s.failed < EVM_HOLD_MS) s.held", "if (true) s.held", PR, "R3 "],
  // round (E): a post out past its provider's hedge time has a stand-in asked, in agreeing (H4), in the block's confirm
  // (H1) and in the follow's pin confirm (H2); the hedge time is read from the provider's answers (H1)
  [QUOTE, "        hedgedK[n] = true;\n        start(true, n);", "        hedgedK[n] = true;", HP, "H4 "],
  [QUOTE, "  if (t === undefined || t.length === 0) return null;", "  return null;", HP, "H1 "],
  [QUOTE, "        times.push(ms);\n", "", HP, "H1 "],
  [QUOTE, "if (n + 1 < order.length && (await hedged(", "if (false && (await hedged(", HP, "H1 "],
  [QUOTE, "const by2 = next < rpcs.length ? await hedged(", "const by2 = false ? await hedged(", FH, "H2 "],
  // round (F): the hedge clock runs from the post's send, past its gate and pace (W1), against its own kind's time (W2);
  // a seat's failure while its stand-in is out asks the next (W3)
  [QUOTE, "wire: (calls) => void ((wireAt[k] = performance.now()),", "wire: (calls) => void ((wireAt[k] = sentAt[k] ?? performance.now()),", HC, "W1 "],
  [QUOTE, "\"logs\" : calls.every((c) => c.method === \"eth_getBlockByNumber\"", "\"logs\" : \"all\" || calls.every((c) => c.method === \"eth_getBlockByNumber\"", HC, "W2 "],
  [QUOTE, "          if (voted[seat[k]!]) {\n            gone++;", "          if (voted[seat[k]!] || Array.from({ length: started }, (_, n) => n).some((n) => n !== k && seat[n] === seat[k] && !settledK[n])) {\n            gone++;", HC, "W3 "],
  // round (F): a warm scan request out past its provider's own getLogs time from its send has the next raced (SP2H)
  [QUOTE, "    fast && j.on.next !== undefined ? raced(j) :", "    false ? raced(j) :", R, "SP2H "],
  [QUOTE, "timer = setTimeout(standIn, evmHedgeAfter(url, \"logs\") ?? EVM_SCAN_HOLD_MS);", "timer = setTimeout(standIn, EVM_SCAN_HOLD_MS);", R, "SP2H "],
  // a stand-in answering for the other head's provider is a spare's: the block then needs more than half (V12H)
  [QUOTE, "        [order[n], order[n + 1]] = [order[n + 1]!, order[n]!];\n        if (n === 0) unsure = true;", "        [order[n], order[n + 1]] = [order[n + 1]!, order[n]!];", R, "V12H "],
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
  [QUOTE, "        against.push(order[n]!);\n      } else holds++;", "        return refuse(\"rpc_disagree\", \"another block\");\n      } else holds++;", R, "V7 "],
  [QUOTE, "            first = performance.now() - (sentAt[k] ?? t0[k]!);", "            first = performance.now() - (sentAt[0] ?? t0[0]!);", R, "V8 "],
  [QUOTE, "      if (started >= 2) arm();\n", "", R, "V8 "],
  [QUOTE, "const q = await evmPoolBuyQuoteWith(asked, evmProviders(evmRanked(p, undefined, sizeOf(v, chain, \"buy\", asked.token)), fetch, later),", "const q = await evmPoolBuyQuoteWith(asked, evmProviders(p, fetch, later),", R, "V9 "],
  // the re-review of fd9dd16: no confirm from the other head's provider asks a majority (MEDIUM-1); a head is held only
  // more than maxLag below the pair, and heads are no vote (LOW-1, U6); a contested round out of reach ends at once
  // (U1), and so does a confirm (U5)
  [QUOTE, "    const enough = () => holds >= (strict() ? need : 2);", "    const enough = () => holds >= (against.length > 0 ? need : 2);", R, "V12 "],
  [QUOTE, "        failed ??= { e };\n        if (n === 0) unsure = true;\n", "        failed ??= { e };\n", R, "V12 "],
  [QUOTE, "    let holds = 1;\n", "    let holds = 2;\n", R, "V12 "],
  [QUOTE, "    let holds = 1;\n", "    let holds = 0;\n", R, "V3 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => !near(x, a) && !near(x, b),", R, "V13 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    () => false,", R, "V13 "],
  [QUOTE, "      // a head past maxLag is a missing answer, not a vote\n      false,\n", "", R, "V13 "],
  [QUOTE, "      if (contested && Math.max(...got.map((x) => got.filter((y) => same(x.v, y.v)).length)) + list.length - got.length - fails - gone < need) return lose();\n", "", R, "V14 "],
  [QUOTE, "      if (strict() && holds + order.length - n < need) break;\n", "", R, "V15 "],
  // the re-review of 47109a7: the held head's edges (E3, E4) and the confirm's early stop without a vote against (E6)
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => x.number + maxLag <= (a.number <= b.number ? a.number : b.number),", R, "V13 "],
  [QUOTE, "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? a.number : b.number),", "    (x, a, b) => x.number + maxLag < (a.number <= b.number ? b.number : a.number),", R, "V13 "],
  [QUOTE, "      if (strict() && holds + order.length - n < need) break;", "      if (against.length > 0 && holds + order.length - n < need) break;", R, "V15 "],
  // the scan's spans: each that came back is kept, also when another failed, never past a head named beyond maxLag;
  // a throttled span is asked again whole
  [QUOTE, "  await settle(jobs.map(shared)).catch((e) => failing(e));", "  await settle(jobs.map(shared));", R, "J1 "],
  [QUOTE, "    if (a > at) out.push([at, a - 1]);", "", R, "J1 "],
  [QUOTE, "      if (!(e instanceof TailFlood) && scanHead - b.number <= maxLag) commit();", "      if (!(e instanceof TailFlood)) commit();", R, "J3 "],
  // the review of bc189de: a kept scan started early waits for the quote's pick when it ends (L-3) and when it fails
  // (M12); a span is kept only for the currencies of the request that came back (M20)
  [QUOTE, "v.scan, at, v.maxLag, scanFromOf(firstOn), at, deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later, fillOf);", "v.scan, agreedHead, v.maxLag, scanFromOf(firstOn), at, deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later, fillOf);", R, "J4 "],
  // (card evm-scan-chain-tail: J5, main's killer of this one, is a Base case, and Base reads the chain's tail; J5r is its
  // Robinhood port, by currency past the tail's budget)
  [QUOTE, "v.scan, at, v.maxLag, scanFromOf(firstOn), at, deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later, fillOf);", "v.scan, at, v.maxLag, scanFromOf(firstOn), agreedHead, deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later, fillOf);", R, "J5r "],
  [QUOTE, "for (const g of got) if (g.part.includes(e)) e.spans", "for (const g of got) e.spans", R, "J6r "],
  // fold 5: the scan's gate, per quote: a 429, a named limit or a timeout halves its parallelism (to 1), answers raise
  // it again; a throttle holds the next requests for its Retry-After or a doubling backoff, spends no try, and past
  // the quote's bound refuses (re-review of 037627c, MEDIUM-1; GitHub's runner at 7d6ec94: the cold quote's getLogs
  // timed out at 20 at once)
  [QUOTE, "          if (e instanceof RateLimited) {\n            held(sent, e.afterMs);\n            continue;", "          if (e instanceof RateLimited) {\n            held(sent, e.afterMs);\n            if (++i >= tries) throw e;\n            continue;", R, "TH1 "],
  [QUOTE, "        if (Array.isArray(out) && out.some(limited)) {\n          held(sent, null);\n          continue;", "        if (false) {\n          held(sent, null);\n          continue;", R, "J2 "],
  [QUOTE, 'retryAfterMs(res.headers.get("retry-after"))', "null", R, "TH1 "],
  [QUOTE, "Math.min(SCAN_BACKOFF_MAX_MS, SCAN_BACKOFF_MS * 2 ** Math.max(0, strikes - 1))", "SCAN_BACKOFF_MS", R, "TH2 "],
  [QUOTE, "SCAN_BACKOFF_MS * 2 ** Math.max(0, strikes - 1)", "SCAN_BACKOFF_MS * 2 ** strikes", R, "TH2 "],
  [QUOTE, "    limit = sst = Math.max(1, Math.floor(limit / 2));", "    sst = limit;", R, "TH3 "],
  [QUOTE, "      else if (flying < Math.floor(limit)) {", "      else if (true) {", R, "TH3 "],
  [QUOTE, "limit = Math.min(parallel, limit < sst ? limit + 1 : limit + 1 / limit);", "limit = Math.min(parallel, limit);", R, "TH3 "],
  [QUOTE, "      if (resumeAt > untilMs) {\n        const m =", "      if (false) {\n        const m =", R, "TH4 "],
  [QUOTE, '          if ((e as Error | null)?.name === "TimeoutError") congest(sent);', "", R, "TH5 "],
  [QUOTE, "    if (sent !== cuts) return false;", "", R, "TH6 "],
  [QUOTE, "      if (now >= untilMs) throw past();", "", R, "TH7 "],
  [QUOTE, "    const wait = Math.max(afterMs ?? 0, Math.min(SCAN_BACKOFF_MAX_MS, SCAN_BACKOFF_MS * 2 ** Math.max(0, strikes - 1)));", "    const wait = afterMs ?? Math.min(SCAN_BACKOFF_MAX_MS, SCAN_BACKOFF_MS * 2 ** Math.max(0, strikes - 1));", R, "TH8 "],
  [QUOTE, "          if (e instanceof Unreachable || (out5xx && deepCall)) {", "          if (out5xx && deepCall) {", R, "TH9 "],
  // re-review of b282ce0: a request's refusals counted, the fourth in a row refusing it, never its halves (LOW-C); a
  // browser's fetch failure, a TypeError with no cause, asked again whole too (LOW-B); the bound's race and abort, the
  // refusals' backoff and the per-round list, each held by a named test (LOW-A)
  [QUOTE, "            if (++refused >= SCAN_TRIES) {", "            if (false) {", R, "B1r "],
  [QUOTE, "if (e instanceof ScanStop || (e instanceof ScanRefused && !alone) || last) throw e;", "if (e instanceof ScanStop || last) throw e;", R, "B1r "],
  [QUOTE, "            else await nap(SCAN_BACKOFF_MS * 2 ** (refused - 1));", "            else await nap(0);", R, "B1r "],
  [QUOTE, "            else await nap(SCAN_BACKOFF_MS * 2 ** (refused - 1));", "            else await nap(0);", R, "B1a "],
  [QUOTE, 'if (e instanceof TypeError && (cause === undefined || (typeof code === "string" && CONNECT_ERRORS.has(code))))', 'if (e instanceof TypeError && typeof code === "string" && CONNECT_ERRORS.has(code))', R, "B8 "],
  [QUOTE, "    if (left >= EVM_RPC_TIMEOUT_MS) return rpc(calls);", "    return rpc(calls);", R, "B2a "],
  [QUOTE, "        stop.abort(e);\n", "", R, "B2a "],
  [QUOTE, "    list = [...rpcs];\n", "", R, "B6 "],
  [QUOTE, "    resumeAt = Math.max(resumeAt, performance.now() + wait);", "    resumeAt = performance.now() + wait;", R, "TH10 "],
  [QUOTE, "        strikes = 0;\n", "", R, "TH11 "],
  [QUOTE, "  return Number.isFinite(at) && /[a-z]/i.test(t) ? Math.max(0, at - now) : null;", "  return null;", R, "TH12 "],
  [QUOTE, "export const EVM_QUOTE_MAX_KEYS = 65_536;", "export const EVM_QUOTE_MAX_KEYS = 16_384;", R, "X3 "],
  [QUOTE, "    if (hooks.some(replaced)) c.real =", "    if (false) c.real =", R, "H2 "],
  [QUOTE, "    let m = out(c.at)! < out(c.real.at)! ? out(c.at)! : out(c.real.at)!;", "    let m = out(c.at)!;", R, "H2 "],
  [QUOTE, ": part.length === 1 ? on.span : or;", ": on.span;", R, "B1 "],
  [QUOTE, "    const t = part.length === 1 ? w(part[0]!.c) : part.map((e) => w(e.c));", "    const t = w(part[0]!.c);", R, "X4f "],
  [QUOTE, "[[e0, null, w(NATIVE), t], [e0, null, w(weth), t], [e0, null, t, w(weth)]]", "[[e0, null, w(weth), t], [e0, null, t, w(weth)]]", R, "S3 "],
  [QUOTE, "[e0, null, null, t]", "[e0, t]", R, "N1ar "],
  [QUOTE, "const fromScan = scanned?.pools.get(lower(token)) ?? [];", "const fromScan: EvmPoolKey[] = [];", R, "N1a "],
  [QUOTE, "gaps: gapsOf(spans, floor, head),", "gaps: [[floor, head]] as Spans,", R, "G4r "],
  [QUOTE, "  return {\n    pools: new Map(each.map((e, i) => [e.c, [...new Map(", "  commit();\n  return {\n    pools: new Map(each.map((e, i) => [e.c, [...new Map(", R, "S2b "],
  // card evm-buy-and-sell-on-mainnet: the blocks within maxLag of a kept scan read beside the quote, not before it
  [QUOTE, "    const held = (e.tail ? each.every((x) => x.pools.length > 0) : e.pools.length > 0) || kind === \"markets\";", "    const held = true;", R, "card evm-buy-and-sell-on-mainnet: a coin the served index holds no pool of"],
  [QUOTE, "    if (held && e.gaps.length > 0 && unread.every(([a]) => a > head - lag)) {", "    if (held && e.gaps.length > 0) {", R, "W2g "],
  [QUOTE, "      e.later = lagged.reduce((sp, [x, y]) => withSpan(sp, x, y), kept);\n      e.gaps = [];\n", "", R, "W2c "],
  // card evm-scan-chain-tail: the tail of the chain, read from a near start with the event alone, kept per provider
  [QUOTE, "  for (const c of new Set([k.currency0, k.currency1])) append(t.byCurrency, c, k);", "  for (const c of new Set([k.currency0])) append(t.byCurrency, c, k);", R, "X4 "],
  [QUOTE, "  return other === NATIVE || other === weth;\n};\n", "  return other === weth;\n};\n", R, "S3 "],
  [QUOTE, "    const filters = part[0]!.tail ? [[e0]] : ", "    const filters = part[0]!.tail ? [[e0, null, \"0x\" + \"0\".repeat(64)]] : ", R, "TAIL1 "],
  [QUOTE, "(e.tail ? each.every((x) => x.pools.length > 0) : e.pools.length > 0)", "(e.tail ? true : e.pools.length > 0)", R, "TAIL3 "],
  [QUOTE, "        const t: Tail = byChain.get(chain) ?? { spans: [], byCurrency: new Map(), ids: new Set(), at: new Map() };", "        const t: Tail = { spans: [], byCurrency: new Map(), ids: new Set(), at: new Map() };", R, "W2f "],
  [QUOTE, "  const near = !byCurrency && !cold && head - start <= tailBudgetOf(s);", "  const near = true;", R, "TAIL5 "],
  [QUOTE, "  const near = !byCurrency && !cold && head - start <= tailBudgetOf(s);", "  const near = false;", R, "TAIL1 "],
  [QUOTE, "Math.floor((SCAN_MAX_LOGS * s.initialized.blocks) / s.initialized.pools)", "Math.floor((2 * SCAN_MAX_LOGS * s.initialized.blocks) / s.initialized.pools)", R, "TAIL5 "],
  [QUOTE, "const tailHolds: Spans = start >= floor ? withSpan(kept0, floor, start) : kept0;", "const tailHolds: Spans = kept0;", R, "TAIL5 "],
  [QUOTE, "        if (k !== null) tailAdd(tailFound, k, n);", "        if (k !== null && false) tailAdd(tailFound, k, n);", R, "TAIL1 "],
  // the independent review of 266cca1b4: the tail keeps no block within the index's margin of its head (M1), those blocks
  // count as read for the deferral rule alone and P2-1 counts from the first unread block; a flood of the tail's
  // answers drops the tail for the quote (M3), each tail request a quarter of its budget, no request after it, and the
  // quote scans by currency; the budget of no measured pools is the depth (L2)
  [QUOTE, "        const top = head - tailLag;", "        const top = head;", R, "TAIL7 "],
  [QUOTE, "band.filter(([, y]) => y > top).map(([x, y]): [number, number] => [Math.max(x, top + 1), y])", "([] as Spans)", R, "TAIL2 "],
  // card evm-tap-reads-no-block-the-index-holds: the band's blocks at or below the scan's start are read, never asked again
  [QUOTE, "  const band: Spans = (tail0?.band ?? []).filter(([, y]) => y > start).map(([x, y]): [number, number] => [Math.max(x, start + 1), y]);", "  const band: Spans = tail0?.band ?? [];", R, "TAIL11k "],
  [QUOTE, "    } else if (e.tail && held && unread.length > 0) {", "    } else if (false) {", R, "W2b "],
  [QUOTE, "          if (g.b > top) t.band = withSpan(", "          if (false) t.band = withSpan(", R, "W2b "],
  [QUOTE, "          if (g.spare) continue;\n", "", R, "TAIL4b "],
  [QUOTE, "n.length > Math.max(1, (TAIL_FLOOD * (b - a + 1) * s.initialized.pools) / s.initialized.blocks)", "n.length > Math.max(1, (1000 * TAIL_FLOOD * (b - a + 1) * s.initialized.pools) / s.initialized.blocks)", R, "TAIL8 "],
  [QUOTE, "    if (flooded) throw new TailFlood(", "    if (false) throw new TailFlood(", R, "TAIL8 "],
  [QUOTE, "Math.max(1, Math.min(on.span, Math.floor(tailBudgetOf(s) / TAIL_FLOOD)))", "on.span", R, "TAIL8 "],
  [QUOTE, "    again[14] = true;", "    again[14] = false;", R, "X4f "],
  // card evm-scan-chain-tail, round 5: a chain's tail with no block read is read after the answer (TAILF1 to TAILF6)
  [QUOTE, "  const cold = fill !== true && (tail0?.spans.length ?? 0) === 0 && (tail0?.band?.length ?? 0) === 0;", "  const cold = false;", R, "TAILF1 "],
  [QUOTE, "  const cold = fill !== true && (tail0?.spans.length ?? 0) === 0 && (tail0?.band?.length ?? 0) === 0;", "  const cold = (tail0?.spans.length ?? 0) === 0 && (tail0?.band?.length ?? 0) === 0;", R, "TAILF1 "],
  // card evm-tail-warms-with-the-index-at-the-head: a tail read only inside the index's margin is no cold tail
  [QUOTE, " && (tail0?.spans.length ?? 0) === 0 && (tail0?.band?.length ?? 0) === 0;", " && (tail0?.spans.length ?? 0) === 0;", R, "GUARD "],
  // a band block counts as read only within maxLag of the head (independent review of c6cf1927d, HIGH 1, HIGH 2, MEDIUM 3)
  [QUOTE, "    const unread = e.tail ? gapsOf(lagged.reduce(", "    const unread = e.tail ? gapsOf((tail0?.band ?? []).reduce(", R, "TAIL11 "],
  [QUOTE, ".filter(([, y]) => y > head - lag).map(([x, y]): [number, number] => [Math.max(x, head - lag + 1), y]) : [];", ".filter(([, y]) => y > head - lag) : [];", R, "TAIL2 "],
  // past maxLag, only the unread spans that start past it go before the answer; those within it go after, counted from
  // their first block (P2-1)
  [QUOTE, "      const now = unread.filter(([a]) => a <= head - lag);", "      const now = unread;", R, "W2b "],
  // a quote's tail scans that read the same blocks before the answer at once share one request (TAIL_READING)
  [QUOTE, "  await settle(jobs.map(shared)).catch((e) => failing(e));", "  await settle(jobs.map(run)).catch((e) => failing(e));", R, "TAILF12 "],
  // the shared answer is the taker's whole, a stand-in's included, and a spare's stays a spare's
  [QUOTE, "g.a >= j.a && g.b <= j.b && j.part.every((e) => g.part.includes(e))", "g.part === j.part && g.a >= j.a && g.b <= j.b", R, "TAIL11g "],
  [QUOTE, "void got.push(...gs.map((g) => ({ ...g, part: j.part })))", "void got.push(...gs.map((g) => ({ ...g, spare: false, part: j.part })))", R, "TAIL11g "],
  // the band counted read within maxLag of the scan head goes with the read after the answer, and P2-1 counts from its
  // first block against the agreed block (independent review of 7ed7d86f9, H1); a taker waits EVM_SCAN_HOLD_MS (M1)
  [QUOTE, "      e.later = lagged.reduce((sp, [x, y]) => withSpan(sp, x, y), kept);", "      e.later = kept;", R, "RVW5 "],
  [QUOTE, "      const from = Math.min(unread[0]?.[0] ?? Infinity, laggedFrom ?? Infinity);", "      const from = unread[0]?.[0] ?? Infinity;", R, "RVW5 "],
  [QUOTE, "      e.later = lagged.reduce((sp, [x, y]) => withSpan(sp, x, y), gapsOf(now.reduce(", "      e.later = ([] as Spans).reduce((sp, [x, y]) => withSpan(sp, x, y), gapsOf(now.reduce(", R, "RVW3 "],
  [QUOTE, "      e.laterFrom = Math.min(unread.find(([a]) => a > head - lag)?.[0] ?? head + 1, laggedFrom ?? head + 1);", "      e.laterFrom = unread.find(([a]) => a > head - lag)?.[0] ?? head + 1;", R, "RVW6 "],
  [QUOTE, "      return Promise.race([led, held]).then((gs) => {", "      return led.then((gs) => {", R, "TAIL11j "],
  [QUOTE, "reach(fill === true ? e.ix : e.spans)", "reach(e.spans)", R, "TAILF1 "],
  [QUOTE, "      if (wantFill && !got.some((g) => g.spare)) (fill", "      if (wantFill) (fill", R, "TAILF6 "],
  [QUOTE, "  if (running.has(chain) || FLOODED.get(src)?.has(chain) === true) return;", "  if (FLOODED.get(src)?.has(chain) === true) return;", R, "TAILF2 "],
  [QUOTE, "  if (running.has(chain) || FLOODED.get(src)?.has(chain) === true) return;", "  if (running.has(chain)) return;", R, "TAIL8 "],
  [QUOTE, "    .finally(() => (running.delete(chain), ", "    .finally(() => (", R, "TAILF5 "],
  [QUOTE, " || laterOf(firstOn.rpc) === undefined) return;", ") return;", R, "TAILF4 "],
  [QUOTE, "({ ...o, rpc: laterOf(o.rpc) ?? o.rpc,", "({ ...o, rpc: o.rpc,", R, "TAILF3 "],
  [QUOTE, "    RPC_TWIN.set(rpc, () => (twin ??= evmJsonRpc(url, fetchFn, maxBytes, timeoutMs, true)));", "", R, "TAILF3 "],
  [QUOTE, "deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later, fillOf);", "deferTo(kind), a.scanless === true, firstOn.rpc, v.indexMargin, false, later);", R, "TAILF1 "],
  // the fill's start waits for its chain's quotes to end (quiet), so it starts after the answer
  [QUOTE, "  const p = quiet(chain)\n    .then(read)", "  const p = Promise.resolve()\n    .then(read)", R, "TAILF7 "],
  // a fill waits for its chain's quotes to end (quiet): a tap's next quote, asked right after the last answered, goes first
  [QUOTE, "      if ((QUOTING.get(chain) ?? 0) > 0) QUIET.set(", "      if (false) QUIET.set(", R, "TAILF9 "],
  [QUOTE, "  if (n > 0) return;\n  QUOTING.delete(chain);", "  QUOTING.delete(chain);", R, "TAILF9 "],
  [QUOTE, "  for (const f of QUIET.get(chain) ?? []) setTimeout(f, 0);", "  ", R, "TAILF9 "],
  [QUOTE, "  const chainOf = chainKey(req);\n  quoting(chainOf, 1);\n  try {\n    return await buyQuoteWith(", "  const chainOf = chainKey(req);\n  try {\n    return await buyQuoteWith(", R, "TAILF9 "],
  [QUOTE, "    quoting(chainOf, -1);\n  }\n}\n\nasync function buyQuoteWith(", "  }\n}\n\nasync function buyQuoteWith(", R, "TAILF9 "],
  [QUOTE, "  quoting(chainOf, 1);\n  try {\n    return await sellQuoteWith(", "  try {\n    return await sellQuoteWith(", R, "TAILF10 "],
  [QUOTE, "  return typeof c === \"string\" ? c : \"\";", "  return String(c ?? \"\");", R, "TAILF11 "],
  [QUOTE, "    quoting(chainOf, -1);\n  }\n}\nasync function sellQuoteWith(", "  }\n}\nasync function sellQuoteWith(", R, "TAILF10 "],
  [QUOTE, " >= floor || asked.has(k.currency0) || asked.has(k.currency1));", " >= floor);", R, "TAIL9 "],
  [QUOTE, "          const left = ks.filter((k: EvmPoolKey) => (t.at.get(poolId(k)) ?? floor) >= floor || asked", "          const left = ks.filter((k: EvmPoolKey) => true || asked", R, "TAIL9 "],
  [QUOTE, "      done = done.then(() => scanOrByCurrency(", "      void done;\n      void Promise.resolve().then(() => scanOrByCurrency(", R, "TAILF12 "],
  [QUOTE, "    laterJobs(scans);\n", "", R, "W2d "],
  [QUOTE, "    await settle(js.map(run));\n    commit();\n", "    await settle(js.map(run));\n", R, "W2b "],
  [QUOTE, "(cs);\n      if (later.length === 0) return;", "(cs);\n      return;", R, "W2b "],
  // review of 98a87843b: a gap left for later that starts more than maxLag before the agreed block is read before the
  // answer (P2-1), and a later commit keeps what a newer quote kept (P3)
  [QUOTE, "    laterJobs(scans.filter((e) => e.later.length > 0 && b - BigInt(e.laterFrom ?? Math.min(...e.later.map(([x]) => x))) + 1n > maxLag));\n", "", R, "W2e "],
  [QUOTE, "b - BigInt(e.laterFrom ?? Math.min(...e.later.map(([x]) => x))) + 1n > maxLag", "b - BigInt(e.laterFrom ?? Math.min(...e.later.map(([x]) => x))) + 1n > 2n * maxLag", R, "W2e "],
  [QUOTE, "now === undefined ? { spans: e.spans, pools: e.pools } :", "true ? { spans: e.spans, pools: e.pools } :", R, "W2fc "],
  [QUOTE, "    const sc = await scanOf(cs, \"markets\");", "    const sc = await (scanOf(cs, \"markets\") ?? Promise.resolve(null)).catch(() => null);", R, "G2r "],
  [QUOTE, "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [mk.key, p.key]))", "hops: [hopTo(x, mk.key), hopTo(lower(token), p.key)] }, [p.key]))", R, "S3c "],
  [QUOTE, "hops: [hopTo(via.other, mk.key), hopTo(x, via.key), hopTo(lower(token), p.key)]", "hops: [hopTo(x, via.key), hopTo(lower(token), p.key)]", R, "T5 "],
  [QUOTE, "    if (res.status === 429) {", "    if (false) {", R, "T7 "],
  [QUOTE, "      if (!(e instanceof RateLimited || e instanceof Unreachable) || i === 3 || gate?.spare?.() === true || gate?.done?.() === true) {", "      if (true) {", R, "T7 "],
  // card evm-unreachable-moves-on: a request that made no connection goes to the next at once while one is left
  [QUOTE, " || i === 3 || gate?.spare?.() === true || gate?.done?.() === true) {", " || i === 3 || (e instanceof RateLimited && gate?.spare?.() === true) || gate?.done?.() === true) {", R, "FU1 "],
  // card evm-warm-tap-ends-inside-two-seconds: a seat whose round is agreed is asked again after a lost connection (Q6b)
  [QUOTE, " || i === 3 || gate?.spare?.() === true || gate?.done?.() === true) {", " || i === 3 || gate?.spare?.() === true) {", "test/evm-quorum.test.ts", "Q6b "],
  [QUOTE, "      if (i < 3 && Array.isArray(out) && out.some(limited)) throw", "      if (false) throw", R, "T7 "],
  // card evm-lag-answer-read-again: a not-yet answer goes to the next provider at once while one is left (LG5); the last
  // provider left is asked again (LG3)
  [QUOTE, "    if (gate?.spare?.() === true) throw new EvmQuoteError(\"rpc_error\", \"a provider does not hold the block yet\");\n", "", R, "LG5 "],
  [QUOTE, "    if (gate?.spare?.() === true) throw new EvmQuoteError(\"rpc_error\", \"a provider does not hold the block yet\");", "    if (true) throw new EvmQuoteError(\"rpc_error\", \"a provider does not hold the block yet\");", R, "LG3 "],
  [QUOTE, "    GATED.set(f as unknown as EvmRpc, (calls, gate) =>\n      g(() => {", "    GATED.set(f as unknown as EvmRpc, (calls, gate) =>\n      ((x: () => Promise<readonly unknown[]>) => x())(() => {", R, "T8 "],
  // each read's own gas (card evm-quote-read-gas-starve): the code at Multicall3 and the call's gas, success word 2,
  // the read again alone, the agreement on it, and the buy's own route refused by name
  [QUOTE, "data: aggregate(part.map((i) => reads[i]!)), gas: READ_CALL_GAS_HEX }, at, { ...o, [MULTICALL3]: { code: EVM_READ_GAS_CODE } }]", "data: aggregate(part.map((i) => reads[i]!)), gas: READ_CALL_GAS_HEX }, at, { ...o }]", R, "GS1 "],
  [QUOTE, "data: aggregate(part.map((i) => reads[i]!)), gas: READ_CALL_GAS_HEX }", "data: aggregate(part.map((i) => reads[i]!)) }", R, "GS4 "],
  [QUOTE, "if ((ok !== 0 && ok !== 1 && ok !== 2) || at(e + 64) !== 0x60)", "if ((ok !== 0 && ok !== 1) || at(e + 64) !== 0x60)", R, "GS1 "],
  [QUOTE, "    if (ok === 2) out.push({ kind: \"revert\", partial: false, gas: true, used });\n    else if (ok === 0) {", "    if (ok === 0 || ok === 2) {", R, "GS2 "],
  [QUOTE, "for (const per of again === undefined ? [READ_AGAIN_PER_CALL, 1] : []) {", "for (const per of [] as number[]) {", R, "GS2 "],
  [QUOTE, "for (const per of again === undefined ? [READ_AGAIN_PER_CALL, 1] : []) {", "for (const per of again === undefined ? [1] : []) {", R, "GS11 "],
  // a buy's quote is kept by its route too (routeSizes, card evm-warm-tap-reads-in-one-round), so GS12's warm quote
  // sends it in the size kept for the route; GS11 reads the size kept for the calldata, as a sell's read is sent by it
  [QUOTE, "    readSizes.set(key, n);\n", "", R, "GS11 "],
  // review of baac0ecb: the kept size not the one read at (P3-2); the reads a burner starved kept alone, or its own second
  // read not kept alone (P2-2); half a share kept for each read after the one run, not a quarter (P2-1)
  [QUOTE, "    readSizes.set(key, n);\n", "    readSizes.set(key, 1);\n", R, "GS11 "],
  // card evm-quote-gas-used: each read's gas used, agreed by two providers, picks the read kept apart: the read that used
  // more than its call's even share (not every read before), kept alone; a read that needs more than that share kept at
  // the size it was read again at; the gas used agreed, and read from the code's answer
  // every read before the starved one counted as a user: since the review of e9b54f71's fold keeps a light one at 6, not
  // alone, GS18's warm quotes no longer tell it (sweep of ad945b7f); GS22 (a) keeps the starved read itself
  [QUOTE, "const users = part.slice(0, k).filter((j) => firstUsed[j]! > S);", "const users = part.slice(0, k);", R, "GS22 "],
  [QUOTE, "      } else for (const j of users) keepAt(j, firstUsed[j]! > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", "      }", R, "GS18 "],
  [QUOTE, "      } else for (const j of users) keepAt(j, firstUsed[j]! > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", "      }", R, "GS19 "],
  // review of e9b54f71, P2: the reads that used the gas kept alone, not at 6 where they used no more than a share of 6
  [QUOTE, "      } else for (const j of users) keepAt(j, firstUsed[j]! > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", "      } else for (const j of users) keepAt(j, 1);", R, "GS21 "],
  [QUOTE, "      } else for (const j of users) keepAt(j, firstUsed[j]! > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", "      } else for (const j of users) keepAt(j, 1);", RP, "a real Robinhood quote "],
  // review of e9b54f71, P3: the reads after the starved one counted as its users, Math.min dropped, the final gas used for
  // the first (in the ladder, then in the users' filter)
  [QUOTE, "const users = part.slice(0, k).filter(", "const users = part.filter((_, x) => x !== k).filter(", R, "GS22 "],
  [QUOTE, "keep.set(i, Math.min(keep.get(i) ?? n, n))", "keep.set(i, n)", R, "GS22 "],
  [QUOTE, "      } else for (const j of users) keepAt(j, firstUsed[j]! > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", "      } else for (const j of users) keepAt(j, (all[j]!.used ?? 0) > share(READ_AGAIN_PER_CALL) ? 1 : READ_AGAIN_PER_CALL);", R, "GS22 "],
  [QUOTE, "const users = part.slice(0, k).filter((j) => firstUsed[j]! > S);", "const users = part.slice(0, k).filter((j) => (all[j]!.used ?? 0) > S);", R, "GS22 "],
  [QUOTE, "if ((all[i] as { gas?: true }).gas === true || (all[i]!.used ?? 0) > S || users.length === 0) {", "if ((all[i] as { gas?: true }).gas === true || users.length === 0) {", R, "GS17 "],
  [QUOTE, "if ((all[i] as { gas?: true }).gas === true || (all[i]!.used ?? 0) > S || users.length === 0) {", "if ((all[i] as { gas?: true }).gas === true || (all[i]!.used ?? 0) > S || true) {", R, "GS18 "],
  [QUOTE, " && a.used === b.used;", ";", R, "GS20 "],
  [QUOTE, "    const used = at(e + 32);", "    const used = 0;", R, "GS18 "],
  [QUOTE, "const share = (n: number) => Number(EVM_READ_CALL_GAS - 100_000n) / n;", "const share = (n: number) => Number(EVM_READ_CALL_GAS - 100_000n);", R, "GS18 "],
  [QUOTE, "5760021c60a0526020", "5760011c60a0526020", R, "GS16 "],
  // the per-read gas code as merged at 206d625f, an even share for each read: a hookless warm quote's heavy reverts read
  // again alone (warm p95 1,440 ms, live check evm-quote-warm-round)
  [QUOTE, "0x60003560e01c80634d2301cc1461001f576382ad56cb1461002d576101db565b506004353160005260206000f35b602435600052600051156101db57610400600051116101db57620186a05a106101db57600051620186a05a030480617530116101db5760021c60a0526020610100526000516101205260005160081b6101400160805260006040525b60005160405110156101a15760405160e00260005160051b0160405160051b610140015260405160e00260005160051b016101400160405160051b604401356044018060400135810180358082602001608051376001604051600051030360a05102620222e001806064015a10610165575a0361271001603f0260061c60205260205180603f900401612710015a10610167575a606052600060008260805160008735602051f15a60605103806060529061014e5760205160011c111560011b610152565b5060015b3d8060611161015f575060605b90610171565b505b6000606052600060025b85526060518560200152606085604001528085606001526000856080013e50505050604051600101604052610089565b7fd5d2d81c98f7eef530d209f98d24b60e8438438a742f7e3b44efbbe020fed2a060005160081b610140015260005160081b606001610100f35b600080fd", "0x60003560e01c80634d2301cc1461001f576382ad56cb1461002d576101b5565b506004353160005260206000f35b602435600052600051156101b557610400600051116101b557620186a05a106101b557600051620186a05a030480617530116101b5576175309003603f0260061c6020526020610100526000516101205260005160081b6101400160805260006040525b600051604051101561017b5760405160e00260005160051b0160405160051b610140015260405160e00260005160051b016101400160405160051b6044013560440180604001358101803580826020016080513760205180603f900401612710015a10610141575a606052600060008260805160008735602051f15a60605103806060529061012a5760205160011c111560011b61012e565b5060015b3d8060611161013b575060605b9061014b565b6000606052600060025b85526060518560200152606085604001528085606001526000856080013e50505050604051600101604052610091565b7fd5d2d81c98f7eef530d209f98d24b60e8438438a742f7e3b44efbbe020fed2a060005160081b610140015260005160081b606001610100f35b600080fd", R, "GS15 "],
  [QUOTE, "if (len < 96 || r.slice(2 + 2 * (len - 32)).toLowerCase() !== READ_MARKER) return refuse(", "if (len < 64) return refuse(", R, "GS8 "],
  [QUOTE, "    if (c.route?.venue === \"uniswap-v3\" && c.route.tokens.length === 2) return true;\n", "", R, "GS6 "],
  [QUOTE, "    if (c.route?.venue === \"uniswap-v3\" && c.route.tokens.length === 2) return true;\n", "", S, "GS9 "],
  [QUOTE, "  if (value < reference.amountOut) ranOut(reference, \"the best route that fits\");\n", "", R, "GS7 "],
  [QUOTE, "  if (value < reference.amountOut) ranOut(reference, \"the best route that fits\");\n", "", R, "GS13 "],
  [QUOTE, "    if (listed !== null && near(listed.amountOut, value)) ranOut(listed, \"the best route through listed pools within the slippage\");\n", "", R, "GS14 "],
  [QUOTE, "    { l: priced, band: ownFits ? (c) => c.amountOut >= value : all },", "    { l: filled, band: ownFits ? (c) => c.amountOut >= value : all },", R, "GS13 "],
  [QUOTE, "if (q2 === null && route.venue === \"uniswap-v3\" && gas2 && route.tokens.length > 2) return refuse(", "if (false) return refuse(", R, "GS7 "],
  [QUOTE, "    if (c.route !== undefined) outOfGas.set(c.at, { route: c.route, amountOut: x });\n", "", S, "GS10 "],
  [QUOTE, "if (q2 === null && route.venue === \"uniswap-v3\" && !gas2) return missed(\"partial_fill\"", "if (q2 === null && route.venue === \"uniswap-v3\") return missed(\"partial_fill\"", R, "GS6 "],
  [QUOTE, "const agreed = (a: Answer, b: Answer) => same(a, b) && (a.kind === \"out\" || a.gas === (b as { gas?: true }).gas) && a.used === b.used;", "const agreed = (a: Answer, b: Answer) => same(a, b) && a.used === b.used;", R, "GS5 "],
  [QUOTE, "      if (m.kind === \"revert\" && m.gas === true) return missed(\"no_quote\", ", "      if (false) return missed(\"no_quote\", ", R, "GS3 "],
  // a route that quotes nothing names R (card evm-buy-and-sell-on-mainnet)
  [QUOTE, "    return refuse(noMainCode, noMain, await named(r));", "    return refuse(noMainCode, noMain);", R, "card evm-buy-and-sell-on-mainnet: an asked route with no pool"],
  [BUYU, "  if (!(quoted && route.venue === \"uniswap-v4\")) {", "  if (!quoted) {", R, "D1 "],
  [BUYU, "  return routeData(chain, route, true);", "  return routeData(chain, route, false);", R, "D1 "],
  [BUYU, "  const { data, token: buys } = routeData(chain, route, quoted);", "  const { data, token: buys } = routeData(chain, route, false);", R, "D1 "],
  // the hook's take, and minOut from the route the hook runs in
  [QUOTE, "const take = h === null ? null : h > q ? h - q : 0n;", "const take = h === null ? null : h - q;", Q, "Q4 "],
  [QUOTE, "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / h)", "takeBps: h === null || take === null || h === 0n ? null : Number((take * 10000n) / q)", Q, "Q4 "],
  [QUOTE, "const minOut = (value * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = ((hook?.hookless ?? q) * BigInt(10000 - slippageBps)) / 10000n;", Q, "Q4 "],
  [QUOTE, "(r.override === undefined && r.state !== true ? [i] : [])", "(r.state !== true ? [i] : [])", Q, "Q4 "],
  [QUOTE, "const minOut = (value * BigInt(10000 - slippageBps)) / 10000n;", "const minOut = q;", Q, "Q1 "],
  [QUOTE, 'if (minOut === 0n) return refuse("no_quote", "the route quotes too little to set a minimum above 0");', "", Q, "Q10 "],
  // native first
  [QUOTE, "  if (nativeExists && wethStart && (nativeBest === null || value <= nativeBest.amountOut)) {", "  if (false) {", Q, "Q6 "],
  [QUOTE, 'nativeFirst: Object.hasOwn(v, "nativeFirst") && v.nativeFirst === true', "nativeFirst: false", Q, "Q6 "],
  [QUOTE, "const natives = ownFits && v.nativeFirst && wethStart ? priced.filter((c) => startsNative(c.route)) : [];", "const natives = ownFits && v.nativeFirst && wethStart ? priced : [];", R, "N3a "],
  // native when at least as good: a WETH route equal to the best native route still refuses
  [QUOTE, "(nativeBest === null || value <= nativeBest.amountOut)", "(nativeBest === null || value < nativeBest.amountOut)", R, "N3b "],
  [QUOTE, "(nativeBest === null || value <= nativeBest.amountOut)", "(nativeBest === null || value <= nativeBest.amountOut && false)", R, "N3b "],
  [QUOTE, "(nativeBest === null || value <= nativeBest.amountOut)", "(nativeBest !== null && value <= nativeBest.amountOut)", R, "R7 "],
  [QUOTE, "    { l: priced, band: ownFits ? (c) => c.amountOut >= value : all },", "    { l: priced.filter((c) => !v.nativeFirst || startsNative(c.route)), band: ownFits ? (c) => c.amountOut >= value : all },", R, "N1f "],
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
  [QUOTE, "|| new Set(rpcsIn).size !== rpcsIn.length) {", ") {", Q, "Q8 "],
  [QUOTE, 'if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", Q, "Q8 "],
  [QUOTE, 'if (new Set(hosts).size !== hosts.length) return refuse("bad_request", "two providers are on one host");', "", Q, "Q8 "],
  [QUOTE, 'if (typeof url !== "string" || !/^https:\\/\\//.test(url)) return refuse(', "if (false) return refuse(", Q, "Q8 "],
  // a provider's answer
  [QUOTE, "if (!Number.isSafeInteger(o) || o < 0 || o + 32 > len)", "if (!Number.isSafeInteger(o) || o < 0)", Q, "Q9 "],
  [QUOTE, "if (e + 128 + dl > len - 32) return refuse(", "if (false) return refuse(", Q, "Q9 "],
  [QUOTE, "\n  if (!Array.isArray(out) || out.length !== calls.length)", "\n  if (!Array.isArray(out))", Q, "Q9 "],
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
  // (card evm-sell-hook-converge: no mutant takes the first route the builder takes for the best: where that pick is
  // more than the slippage under the reference, the pick falls back to the reference's own route, so best() decides only
  // among routes within the slippage, at one minOut, the reference's)
  [QUOTE, 'fills(c, c.route.venue === "uniswap-v3") ? [{ route: c.route, amountOut: out(c.at)! }] : []', "out(c.at) !== null ? [{ route: c.route, amountOut: out(c.at)! }] : []", S, "planted: a pool that runs out"],
  [QUOTE, "    if (!isV3) return true;\n", "    return true;\n", S, "planted: a pool that runs out"],
  [QUOTE, "    if (y !== null) return y > x;", "    if (y !== null) return true;", S, "planted: a pool that runs out"],
  [QUOTE, "? pick.amountOut : reference!.amountOut) * BigInt(10000 - slippageBps)) / 10000n;", "? pick.amountOut : reference!.amountOut));", S, "the device picks the pool"],
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
  // (card evm-buy-hook-converge: a hook the venue does not list no longer refuses no_exit; a route its sell cannot
  // leave by any hook still does)
  [QUOTE, 'if (!evmSellExits(chain, token, route, true)) return refuse("no_exit",', 'if (false) return refuse("no_exit",', R, "L1b "],
  // (card evm-sell-hook-converge: no mutant drops the below_reference refusal itself: a reference's route is always one
  // the builder takes with any hook, so the pick falls back to it first; the refusal is the backstop)
  [QUOTE, "p.amountOut * 10000n < reference.amountOut * BigInt(10000 - slippageBps));", "p.amountOut * 10000n < reference.amountOut * 10000n);", R, "HC4 "],
  [QUOTE, "let pick = best(routes.filter((r) => evmSellExits(chain, t, r.route)));", "let pick = best(routes);", R, "HC4 "],
  [QUOTE, "  if (bought !== null) {\n    const x = bought.route.venue", "  if (false) {\n    const x = bought.route.venue", R, "P3 "],
  [QUOTE, 'if (lower(evmPoolRouteDataQuoted(chain, bought).token) !== lower(token)) return refuse("token_mismatch", "the bought route buys another token");', "", R, "P3 "],
  [QUOTE, "rpcs, scan, reads, bought: exits, seen: [], banned, hints: undefined, sell: true, minBlock: boughtBlock, mono, start });", "rpcs, scan: undefined, reads, bought: exits, seen: [], banned, hints: undefined, sell: true, minBlock: boughtBlock, mono, start });", R, "P1 "],
  // the review of edb4dbb: F1 the sell goes further where the buy does; F2 X's markets at the X the token's pool
  // gives; F5 `bought` kept only where the sell builder takes it; F6 minOut off the reference
  [QUOTE, "if (!trades && markets.has(x) && (!a.sell || legOf(x) !== null)) further.push(x);", "if (!trades && markets.has(x) && !a.sell) further.push(x);", R, "PA "],
  [QUOTE, "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, leg.amount));", "quoteOf(into, routeOfKey(mk.key, c), [mk.key], c, amountIn));", R, "PB2 "],
  [QUOTE, "        append(legs, x, { q: quoteOf(second, { venue: \"uniswap-v4\", currencyIn: x, hops: [hopTo(lower(token), p.key)] }, [p.key]), p });\n", "", R, "PB "],
  // (card evm-buy-hook-converge: `bought` is now kept through any hook, and the mutant that keeps it whatever the
  // builder takes is left out: the routes it would add are only those the buy quote refuses no_exit, L1b; the mutant
  // below keeps the hook rule itself under PC)
  // (no mutant swaps the reference for the pick where the reference is through no unlisted hook: a reference the sell
  // builder takes is the pick itself; review of 72e28658, M2)
  // review of 72e28658, M2: a reference through an unlisted hook that is not the pick's route sets no minOut
  [QUOTE, "const minOut = ((hookedRoute(chain, reference!.route) && JSON", "const minOut = ((false && JSON", R, "review of 72e28658, M2 (sell)"],
  [QUOTE, "return Object.freeze({ venue: r.venue, hops: Object.freeze(hops.reverse()) });", "return Object.freeze({ venue: r.venue, hops: Object.freeze(hops) });", R, "P4 "],
  // card evm-quote-exec-sim: a route through an unlisted hook above the builder's best counts only where W's own sell
  // through it executes (the sim), where the chain pins a sell delegate; elsewhere the lower of its two quotes stays
  [QUOTE, 'const hooked = routes.filter((r) => r.amountOut > floor && simRule(chain, r.route, pins) !== "quoter");', "const hooked: Filled[] = [];", R, "PE a pool"],
  [QUOTE, 'const toSim = hooked.filter((r) => simRule(chain, r.route, pins) === "sim");', "const toSim: Filled[] = [];", R, "PE a pool"],
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
  // card evm-sell-hook-converge: a route through an unlisted hook that sets the reference is the pick at its minOut, its
  // pools named (hooked); a banned pool is no route; the builder takes such a hook only on the device's quote, and the
  // sender's read-back takes any
  [QUOTE, "if (under(pick) && reference !== null && evmSellExits(chain, t, reference.route, true)) pick =", "if (false) pick =", R, "HC1 "],
  [QUOTE, "evmSellExits(chain, t, reference.route, true)) pick =", "evmSellExits(chain, t, reference.route)) pick =", R, "HC1 "],
  [QUOTE, "if (under(pick) && reference !== null && evmSellExits", "if (reference !== null && evmSellExits", R, "HC4 "],
  // the ban acts inside routeSet, before any pick (review of 919742f5, F1); the filter on its finished routes only holds it
  // once more, so dropping that alone is equivalent (the review's M1) and the mutant drops the ban where it acts
  [QUOTE, "const isBanned = (k: EvmPoolKey) => a.banned !== undefined && a.banned.has(\"0x\" + poolId(k));", "const isBanned = (_k: EvmPoolKey) => false;", R, "RV1 "],
  [QUOTE, "const isBanned = (k: EvmPoolKey) => a.banned !== undefined && a.banned.has(\"0x\" + poolId(k));", "const isBanned = (_k: EvmPoolKey) => false;", R, "RV4 "],
  [QUOTE, "if (!Array.isArray(b) || b.length > EVM_SELL_BANNED_MAX) return refuse(", "if (!Array.isArray(b)) return refuse(", R, "HC5 "],
  [QUOTE, "if (typeof x !== \"string\" || !/^0x[0-9a-fA-F]{64}$/.test(x)) return refuse(", "if (typeof x !== \"string\") return refuse(", R, "HC5 "],
  [QUOTE, "    out.add(x.toLowerCase());", "    out.add(x);", R, "HC5 "],
  [QUOTE, "const hooked = Object.freeze(pick.route.venue === \"uniswap-v4\" ?", "const hooked = Object.freeze(false ?", R, "HC1 "],
  [QUOTE, ".filter((k) => k.hooks !== NATIVE && !evmHookListed(chain, k.hooks, k.fee, k.tickSpacing)).map((k) => \"0x\" + poolId(k))", ".filter((k) => k.hooks !== NATIVE).map((k) => \"0x\" + poolId(k))", S, "planted: an unlisted hook"],
  [QD, "nonce }, hooked.length > 0);", "nonce });", R, "HC6 "],
  // the evidence for a ban (review of 919742f5, F2): the trigger is the device's own evidence, never a revert alone (a
  // moved price bans nothing); its scope is the one pool whose hook alone explains the revert, never every hooked pool
  // of the route; the replay runs at the sale's block number and time; the market held at the parent block; the sale
  // reverted, went to W and the replay reverts too; providers that disagree ban nothing; a hook behind two pools of the
  // route explains neither
  [QUOTE, "  const rpcs = [...rpcsIn];\n  try {\n    // 1. the sale", "  const rpcs = [...rpcsIn];\n  if (h !== \"\") return quote.hooked;\n  try {\n    // 1. the sale", R, "RV5 "],
  [QUOTE, "        if (done(await replay(Object.fromEntries(set.map((hk) => [hk, { code }]))))) got.push(set);", "        got.push(set);", R, "RV4 "],
  [QUOTE, "        if (done(await replay(Object.fromEntries(set.map((hk) => [hk, { code }]))))) got.push(set);", "        got.push(set);", R, "RV7 "],
  [QUOTE, "params: [call, parent, state, env] }]", "params: [call, parent, state] }]", R, "HC1 "],
  [QUOTE, "  if (held!.kind !== \"out\" || held!.amountOut < quote.minOut) return unread ? again() : [];\n", "", R, "RV9 "],
  // (card evm-sell-hook-intrablock: the as-is check is `asIs`; the line that returns where it passes and the trace names
  // no hook, left out, is equivalent: the fault set is then the trace's errored hooks, none, so nothing is banned)
  [QUOTE, "  const asIs = failed(await replay({}));\n", "  const asIs = true;\n", R, "HC2 "],
  // review of a2d82dc6, F1: the replay runs at the trade's own gas less its authorizations (more gas, or the sender's
  // balance overridden, tells a hook it is replayed), and a sale is evidence only at the gas the device pins
  [QUOTE, "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);\n", "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths) + 2_000_000n;\n", R, "review of a2d82dc6, F1 (buy)"],
  [QUOTE, "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);\n", "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths) + 2_000_000n;\n", R, "review of a2d82dc6, F1 (sell)"],
  [QUOTE, "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);\n", "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths) + 2_000_000n;\n", R, "review of a2d82dc6, F3"],
  [QUOTE, "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);\n", "  const gas = BigInt(sale.gas);\n", R, "review of a2d82dc6, F3"],
  [QUOTE, "  const gas = BigInt(sale.gas) - EVM_7702_AUTH_GAS * BigInt(sale.auths);\n", "  const gas = BigInt(sale.gas);\n", R, "review of a2d82dc6, F1 (sell)"],
  [QUOTE, "    const state: Record<string, Override> = { ...base };", "    const state: Record<string, Override> = { ...base, [sale.from]: { balance: \"0x\" + (10n ** 30n).toString(16) } };", R, "review of a2d82dc6, F1 (buy)"],
  [QUOTE, "    const state: Record<string, Override> = { ...base };", "    const state: Record<string, Override> = { ...base, [sale.from]: { balance: \"0x\" + (10n ** 30n).toString(16) } };", R, "review of a2d82dc6, F1 (sell)"],
  [QUOTE, "    if (BigInt(sale.gas) !== EVM_POOL_SELL_GAS) return [];\n", "", R, "review of 72e28658, M3 (sell)"],
  [QUOTE, "    if (BigInt(sale.gas) !== EVM_POOL_SELL_GAS) return [];\n", "    if (BigInt(sale.gas) < EVM_POOL_SELL_GAS) return [];\n", R, "review of 72e28658, M3 (sell)"],
  [QUOTE, " || BigInt(sale.status) !== 0n || sale.to !== lower(w)) return [];", " || sale.to !== lower(w)) return [];", R, "RV8 "],
  [QUOTE, " || BigInt(sale.status) !== 0n || sale.to !== lower(w)) return [];", " || BigInt(sale.status) !== 0n) return [];", R, "RV8 "],
  [QUOTE, "(r) => r.ok, (r) => !r.ok, preStateOf(v, trace));\n  } catch (e) {\n    if (e instanceof EvmQuoteError && e.code === \"rpc_disagree\") return [];\n", "(r) => r.ok, (r) => !r.ok, preStateOf(v, trace));\n  } catch (e) {\n", R, "RV8 "],
  [QUOTE, "(r) => boughtOf(r) === false, preStateOf(v, trace));\n  } catch (e) {\n    if (e instanceof EvmQuoteError && e.code === \"rpc_disagree\") return [];\n", "(r) => boughtOf(r) === false, preStateOf(v, trace));\n  } catch (e) {\n", R, "HB6 "],
  [QUOTE, "(x, y) => (x.ok && y.ok && x.result === y.result) || (!x.ok && !y.ok && x.data === y.data && x.halt === y.halt),", "(x, y) => x.ok === y.ok,", R, "RV8 "],
  [QUOTE, "  for (const k of keys) if (fault.has(k.hooks) && !out.includes(", "  for (const k of keys.filter((x, i, a) => a.findIndex((y) => y.hooks === x.hooks) === i)) if (fault.has(k.hooks) && !out.includes(", R, "RV10 "],
  // the sets of hooks (review of c1f486ae, M1; review of 72e28658, H3): where no one hook's no-op rescues the trade, a
  // larger set's, on providers that agree, bans every pool of the route behind any hook of a smallest such set; never
  // only sets of one, never on one provider's word, never fewer than every smallest set's hooks, never a set holding a
  // smaller one that rescued it (an honest hook beside them is never banned)
  [QUOTE, "  for (const set of subsetsOf(hooks)) {", "  for (const set of subsetsOf(hooks).filter((x) => x.length === 1)) {", R, "RVX "],
  // Retired by card evm-quote-x-leg-held-to-its-market: each line marked "retired" was killed only by a buy route of
  // more than one hop through hooks the venue does not list, which the quote now refuses before any read; no EVM test
  // file kills the mutant now (each run on every test/evm*.test.ts, 17 Nov). The buy's multi-hook evidence and lows
  // subsets they mutate serve only such routes, as read; a follow-up card removes or re-covers them.
  // retired: `for (const set of subsetsOf(hooks)) {` (N1D), its only killer a route this card refuses
  [QUOTE, "  const fault = new Set(asIs ? (none ? named : rescued.flat()) : errored);", "  const fault = new Set(asIs ? (none ? named : rescued.slice(0, 1).flat()) : errored);", R, "review of 72e28658, H3 (sell)"],
  // (no N1D entry for this line since rule C, review of 2fccaa67, 1: in N1D the fee-0 pass rescues the same two hooks, so
  // evmFaultSets puts that set in place of every larger stored-fee set and N1D holds without the skip; the same break
  // stays killed by "review of 72e28658, L2 (RV4)" below, retired by card evm-quote-x-leg-held-to-its-market)
  // review of 72e28658, L2: the RV4 mutant ("step 5 always") is not equivalent: a set holding the one hook that rescued
  // the trade, asked anyway, bans an honest capped hook beside it
  // retired: `if (got.some((r) => r.every((h) => set.includes(h)))) contin` (review of 72e28658, L2 (RV4)), its only killer a route this card refuses
  // card evm-buy-hook-converge: the buy takes a route through an unlisted hook (its sell leaves through it), at the lowest
  // of its reads, only where no route through listed pools is within the slippage of it; a listed route within the
  // slippage of such a reference is taken at the reference's minOut; a banned pool is no route; each unlisted hook is
  // read alone (N1, the buy's route and routeSet's); the sale's bought route takes such a hook too
  [QUOTE, 'if (!evmSellExits(chain, token, route, true)) return refuse("no_exit"', 'if (!evmSellExits(chain, token, route)) return refuse("no_exit"', R, "HB1 "],
  [QUOTE, "if (listed !== null && near(listed.amountOut, value)) return refuse(", "if (false) return refuse(", R, "HB4 "],
  [QUOTE, "const underHooked = value < reference.amountOut && hookedRef && unlisted.length === 0 && near(value, reference.amountOut);", "const underHooked = false;", R, "HB4 "],
  // review of 72e28658, M2: a reference through an unlisted hook never sets the buy's minOut
  [QUOTE, "  const minOut = (value * BigInt(10000 - slippageBps)) / 10000n;", "  const minOut = ((underHooked ? reference.amountOut : value) * BigInt(10000 - slippageBps)) / 10000n;", R, "review of 72e28658, M2 (buy)"],
  // review of 72e28658, H1: the prune's floor is the route's value, never the hook's Q
  [QUOTE, "      return x !== null && x > 0n && x < m ? x : m;", "      return m;", R, "review of 72e28658, H1 an"],
  [QUOTE, "      return x !== null && x > 0n && x < m ? x : m;", "      return m;", R, "review of 72e28658, H1b"],
  [QUOTE, "the sale's and the buy's alike (card evm-buy-hook-converge)\n  const banned = bannedOf(req.banned);", "the sale's and the buy's alike (card evm-buy-hook-converge)\n  const banned = bannedOf(undefined);", R, "HB5 "],
  [QUOTE, "if (keys.some((k) => banned.has(\"0x\" + poolId(k)))) return refuse(", "if (false) return refuse(", R, "HB5 "],
  [QUOTE, "    banned,\n    hints: req.pools,", "    hints: req.pools,", R, "HB1 "],
  [QUOTE, "const hooked = Object.freeze(hookedKeys.map(", "const hooked = Object.freeze([].map(", R, "HB1 "],
  // card evm-buy-quotes-pass-on-helper-178: R holds the route's own pool read as it is (PONS), never its own pool with
  // its hook replaced
  [QUOTE, "    seen: hookedKeys.map(poolId),", "    seen: keys.map(poolId),", R, "PO1 "],
  [QUOTE, "    seen: hookedKeys.map(poolId),", "    seen: [],", R, "PO2 "],
  // card evm-quote-x-leg-held-to-its-market: a buy's route of more than one hop through a hook the venue does not list is
  // refused before any read; a single hop through any hook, and hookless pools and listed hooks at any length, are not
  [QUOTE, "route.hops.length > 1) {\n    const k = hopKeys(route).find(", "route.hops.length > 2) {\n    const k = hopKeys(route).find(", R, "XL1 "],
  [QUOTE, "route.hops.length > 1) {\n    const k = hopKeys(route).find(", "route.hops.length > 0) {\n    const k = hopKeys(route).find(", R, "PO2 "],
  [QUOTE, "    if (k !== undefined) return refuse(\"unlisted_hook_route\", ", "    if (false) return refuse(\"unlisted_hook_route\", ", R, "XL1 "],
  [QUOTE, ".find((x) => x.hooks !== NATIVE && !evmHookListed(chain, x.hooks, x.fee, x.tickSpacing));", ".find((x) => !evmHookListed(chain, x.hooks, x.fee, x.tickSpacing));", R, "XL2 "],
  [QUOTE, ".find((x) => x.hooks !== NATIVE && !evmHookListed(chain, x.hooks, x.fee, x.tickSpacing));", ".find((x) => x.hooks !== NATIVE);", R, "XL3 "],
  // a route through a banned pool counts for nothing in the prune's floor, as one that quotes nothing
  [QUOTE, "}, noMain !== null || keys.some((k) => banned.has(\"0x\" + poolId(k))) ? 1n : out(main)!),", "}, noMain !== null ? 1n : out(main)!),", R, "XL8 "],
  [QUOTE, "    if (x < value) value = x;\n", "", R, "review of 72e28658, H1 "],
  // retired: `const lows = subsetsOf(unlisted).map(` (N1B (buy), its only killer a route this card refuses
  // review of 72e28658, M1: every set of the unlisted hooks, never only each alone and all together
  // retired: `const lows = subsetsOf(unlisted).map(` (review of 72e28658, M1 (buy)), its only killer a route this card refuses
  [QUOTE, "c.alone = subsetsOf(hs).filter((s) => s.length < hs.length).map(", "c.alone = subsetsOf(hs).filter((s) => s.length === 1).map(", R, "review of 72e28658, M1 (sell)"],
  // review of a2d82dc6, F2: every read of the route with a set of its unlisted hooks replaced must answer above 0, or the
  // route is refused (the buy's own) or counts for nothing (routeSet's); never only the read with every hook replaced
  // retired: `for (const i of noMain === null ? lows : []) {` (review of a2d82dc6, F2), its only killer a route this card refuses
  [QUOTE, "    if (x === null || x === 0n) return refuse(\"no_quote\", \"the route with a hook the venue does not list replaced", "    if (false) return refuse(\"no_quote\", \"the route with a hook the venue does not list replaced", R, "XL9 "],
  [QUOTE, "      if (x === null || x === 0n) return null;\n", "      if (x === null || x === 0n) continue;\n", R, "review of a2d82dc6, F2 (sell)"],
  [QUOTE, "if (hs.length > 1) c.alone = ", "if (false) c.alone = ", R, "N1B (sell"],
  [QUOTE, "    for (const i of c.alone ?? []) {", "    for (const i of []) {", R, "N1C (sell"],
  [QUOTE, "const exits = evmSellExits(chain, t, bought, true) ? bought : undefined;", "const exits = evmSellExits(chain, t, bought) ? bought : undefined;", R, "PC "],
  // review of 72e28658, L2: the PC mutant `exits = bought` is not equivalent: a bought route through the native asset
  // in its middle would set the reference
  [QUOTE, "const exits = evmSellExits(chain, t, bought, true) ? bought : undefined;", "const exits = bought;", R, "review of 72e28658, L2 (PC)"],
  // the buy's evidence: the quote's own buy, landed with its swap undone (status 1, the pool's Withdrawn, no Bought; review
  // of 72e28658, H2), to the pinned pool through the pinned adapter, its bytes the route's, its withdrawn value less the
  // fee the quote's amount (L3), its replays judged by the `_bought` they return
  [QUOTE, " || BigInt(buy.status) !== 1n || buy.to !== v.pool) return [];", " || buy.to !== v.pool) return [];", R, "HB6 "],
  [QUOTE, " || BigInt(buy.status) !== 1n || buy.to !== v.pool) return [];", " || BigInt(buy.status) !== 1n) return [];", R, "HB6 "],
  [QUOTE, "    if (!buy.logs.includes(`${v.pool}:${TOPIC_WITHDRAWN}`) || buy.logs.includes(`${v.pool}:${TOPIC_BOUGHT}`)) return [];\n", "", R, "HB6 "],
  [QUOTE, "if (!buy.logs.includes(`${v.pool}:${TOPIC_WITHDRAWN}`) || buy.logs", "if (buy.logs", R, "HB6 "],
  [QUOTE, " || buy.logs.includes(`${v.pool}:${TOPIC_BOUGHT}`)) return [];", ") return [];", R, "HB6 "],
  [QUOTE, "    if (withdrawn < 0n || fee < 0n || withdrawn - fee !== quote.amountIn) return [];\n", "", R, "HB6 "],
  // review of a2d82dc6, L3: a sender that takes a bigger fee, so the pool swaps less than the quote's amount
  [QUOTE, "withdrawn - fee !== quote.amountIn", "withdrawn - fee > quote.amountIn", R, "review of a2d82dc6, L3"],
  // review of da11bbb6, H1: every replay sees the trade's block as the trade saw it: the system calls' storage read at
  // the block on two providers that agree word for word, and its header's base fee and (Base) PREVRANDAO
  [QUOTE, "  const base: Record<string, Override> = { ...sys };", "  const base: Record<string, Override> = {};", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where block.number"],
  [QUOTE, "  const base: Record<string, Override> = { ...sys };", "  const base: Record<string, Override> = {};", R, "review of da11bbb6, H1 (sell) the same hook on a sale, where block.number"],
  [QUOTE, "(x, y) => JSON.stringify(x) === JSON.stringify(y),\n      () => refuse(\"rpc_disagree\", `the providers answer the system state", "(x, y) => true,\n      () => refuse(\"rpc_disagree\", `the providers answer the system state", R, "review of da11bbb6, H1 the system slots are read"],
  [QUOTE, "params: [a, s, { blockHash: blk.hash, requireCanonical: true }]", "params: [a, s, { blockHash: blk.parentHash, requireCanonical: true }]", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where block.number"],
  [QUOTE, "params: [a, s, { blockHash: blk.hash, requireCanonical: true }]", "params: [a, s, { blockHash: blk.parentHash, requireCanonical: true }]", R, "review of da11bbb6, H1 the system slots are read"],
  [QUOTE, "baseFeePerGas: qty(BigInt(blk.baseFeePerGas)), ", "", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where BASEFEE"],
  [QUOTE, ", ...(opStack ? { prevRandao: blk.mixHash } : {}) };", " };", R, "review of da11bbb6, H1 (sell) the same hook on a sale, where PREVRANDAO"],
  [QUOTE, "[EVM_L1_BLOCK, Array.from({ length: 16 },", "[EVM_L1_BLOCK, Array.from({ length: 3 },", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where block.number"],
  [QUOTE, "[EVM_BEACON_ROOTS, [time % 8191n, (time % 8191n) + 8191n]]", "[EVM_BEACON_ROOTS, [time % 8191n]]", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where EIP-4788"],
  [QUOTE, "[EVM_HISTORY, [(n - 1n) % 8191n]]", "[EVM_HISTORY, [n % 8191n]]", R, "review of da11bbb6, H1 (sell) the same hook on a sale, where EIP-2935"],
  [QUOTE, "[[EVM_HISTORY, [(n - 1n) % 393168n]]]", "[[EVM_HISTORY, [(n - 1n) % 8191n]]]", R, "review of da11bbb6, H1 evmSystemSlotsOf"],
  // review of da11bbb6, L1: a trade with Nitro poster gas is no evidence
  [QUOTE, "  if (BigInt(sale.l1Gas) !== 0n) return [];\n", "", R, "review of da11bbb6, L1"],
  [QUOTE, "l1Gas: rc.gasUsedForL1 === undefined ? \"0x0\" : num(rc, \"gasUsedForL1\", who),", "l1Gas: \"0x0\",", R, "review of da11bbb6, L1"],
  // review of da11bbb6, L2: a proper set's read that answers 0 counts the sale's route for nothing (mutant R6)
  [QUOTE, "      if (x === null || x === 0n) return null;\n", "      if (x === null) return null;\n", R, "review of da11bbb6, L2"],
  // review of ca907a05: its mutants Y1-Y3 and Y6-Y9, and PREVRANDAO set on Robinhood. Its Y4 (a trade's override
  // replaces the whole account) and Y5 (a system word kept as the provider wrote it) are equivalent: no trade override
  // names a system account (an L1Block or EIP-2935 hook fails v4's flag rule, EIP-4788's code reverts beforeInitialize),
  // and every provider read pads its words to 32 bytes
  [QUOTE, 'const opStack = chain === "base" || chain === "base-sepolia";', 'const opStack = chain === "base";', R, "review of ca907a05, LOW 2 (buy, base-sepolia)"],
  [QUOTE, 'const opStack = chain === "base" || chain === "base-sepolia";', "const opStack = true;", R, "review of ca907a05, LOW 2 (buy, Robinhood)"],
  [QUOTE, "[[EVM_HISTORY, [(n - 1n) % 393168n]]]", "[[EVM_HISTORY, [n % 393168n]]]", R, "review of ca907a05, LOW 2 (buy, Robinhood)"],
  [QUOTE, 'if (chain === "robinhood" || chain === "robinhood-testnet") return', 'if (chain === "robinhood") return', R, "review of da11bbb6, H1 evmSystemSlotsOf"],
  [QUOTE, 'ss.map((s) => [a, "0x" + word(s)] as const)', 'ss.map((s) => [a, "0x" + s.toString(16)] as const)', R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where block.number"],
  [QUOTE, '() => refuse("rpc_disagree", `the providers answer the system state', '() => refuse("rpc_error", `the providers answer the system state', R, "review of da11bbb6, H1 the system slots are read"],
  [QUOTE, "  if (sysSlots.length > 0) {\n", "  if (sysSlots.length > 19) {\n", R, "review of da11bbb6, H1 (buy) a hook that fails the real buy only where block.number"],
  [QUOTE, "  if (BigInt(sale.l1Gas) !== 0n) return [];\n", "  if (BigInt(sale.l1Gas) > 1n) return [];\n", R, "review of da11bbb6, L1"],
  // card evm-sell-hook-intrablock: on Robinhood the replay at the trade's traced pre-state, ArbOS's state left out; the
  // as-is leg on an errored frame into the route's unlisted hook; the trace two companies' word for the trade, bounded.
  // Not listed: the PoolManager's frame left out of `errored` (equivalent while no route's unlisted hook is the
  // PoolManager, which the hooks compared against never are); the merge's order, the system slot's word over the
  // trace's (equivalent: on Robinhood the one system slot, EIP-2935's, the trace names with the same word); the walk's
  // bound on the stack (equivalent: the frame count's own bound refuses the same answers, and a throw adds nothing,
  // review of 29498693, HIGH)
  [QUOTE, "Object.entries(p?.over ?? {})", "Object.entries({} as Record<string, Override>)", R, "card evm-sell-hook-intrablock, HC2 (buy, Robinhood) a hook flipped"],
  [QUOTE, "(r) => r.ok, (r) => !r.ok, preStateOf(v, trace));", "(r) => r.ok, (r) => !r.ok, undefined);", R, "card evm-sell-hook-intrablock, HC2 and HIGH 1 (sell, Robinhood)"],
  [QUOTE, "(r) => boughtOf(r) === false, preStateOf(v, trace));", "(r) => boughtOf(r) === false, undefined);", R, "card evm-sell-hook-intrablock, HC2 (buy, Robinhood) a hook flipped"],
  [QUOTE, "    if (!arbos && !precompileAccount(lower(a))) out[lower(a)] = one;", "    out[lower(a)] = one;", R, "card evm-sell-hook-intrablock, HC2 (buy, Robinhood) a hook flipped"],
  [QUOTE, "  if (!asIs && errored.length === 0) return legUnread ? ", "  if (!asIs) return legUnread ? ", R, "review of ca907a05, HIGH 1 (buy, Robinhood)"],
  // (the trace names only the route's hooks now, review of f0f983d2 item 2, so the off-route frame of the as-is leg's
  // test no longer tells this one: an honest hook beside the errored one does)
  // retired: `hooks.filter((hk) => seen.includes(lower(hk)))` (review of 29498693, MEDIUM), its only killer a route this card refuses
  [QUOTE, '      (x, y) => JSON.stringify(x) === JSON.stringify(y),\n      () => refuse("rpc_disagree", `the trace providers', '      (x, y) => true,\n      () => refuse("rpc_disagree", `the trace providers', R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, ' || typeof root.input !== "string" || lower(root.input) !== sale.input', "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "  if (accounts.filter(([a]) => lower(a) !== EVM_ARBOS_STATE).length > b.accounts) return null;\n", "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "(arbos ? st.length > b.arbosSlots : (slots += st.length) > b.slots)", "(arbos ? st.length > b.arbosSlots : false)", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "(arbos ? st.length > b.arbosSlots : (slots += st.length) > b.slots)", "(arbos ? false : (slots += st.length) > b.slots)", R, "card evm-sell-hook-intrablock, a trace that"],
  // (review of f0f983d2, item 3: the code cap's mutant is gone with the code it bounded: the prestate is asked with
  // disableCode and an account's code is never read; the mutant below drops disableCode)
  [QUOTE, "  if (sale.index !== sale.rcIndex) return [];\n", "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "!isAddress(root.from) || lower(root.from) !== sale.from || ", "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "!isAddress(root.to) || lower(root.to) !== sale.to || ", "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, ' || q(root.value ?? "0x0") !== BigInt(sale.value)', "", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "  const frames = Math.floor(g / 100) + 2;", "  const frames = Math.floor(g / 100) + 3;", R, "card evm-sell-hook-intrablock, a trace that"],
  // review of 29498693: a trace that adds nothing leaves the parent replay's evidence (HIGH); the as-is leg on the trace
  // bans the hooks it names errored alone, each a frame the PoolManager called (MEDIUM)
  [QUOTE, "  try {\n    p = pre === undefined ? undefined : ((await pre(sale, hooks)) ?? undefined);\n  } catch (e) {\n", "  {\n    p = pre === undefined ? undefined : ((await pre(sale, hooks)) ?? undefined);\n  }\n  if (false as boolean) {\n    const e: unknown = null;\n", R, "review of 29498693, HIGH"],
  // retired: `new Set(asIs ? (none ? named : rescued.flat()) : errored)` (review of 29498693, MEDIUM), its only killer a route this card refuses
  // retired: `&& isAddress(f.from) && lower(f.from) === pm` (review of 29498693, MEDIUM), its only killer a route this card refuses
  // review of f0f983d2: a caught frame never counts, the outermost route hook alone (item 2); the bounds from the
  // trade's gas, the prestate with no code (item 3); a trace not answered where nothing else bans is asked again (item
  // 5a). Item 4's PoolManager-slot compare is gone (review of de4e3ed5, 1: the market is read on the replay's own
  // basis instead), and its mutant with it: the test "review of f0f983d2, item 4" now holds the same-basis read below
  // retired: `const chain = enters ? errored : inPm && unbroken && errored` (review of f0f983d2, item 2), its only killer a route this card refuses
  // retired: `&& chain && !underHook && byOwn && isAddress(f.from)` (review of f0f983d2, item 2), its only killer a route this card refuses
  [QUOTE, "  const accounts = Math.floor(g / 2400) + 64;", "  const accounts = Math.floor(g / 2400) + 65;", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "  const slots = Math.floor(g / 1900) + 64;", "  const slots = Math.floor(g / 1900) + 65;", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "  const arbosSlots = Math.floor(g / 800) + 256;", "  const arbosSlots = Math.floor(g / 800) + 257;", R, "card evm-sell-hook-intrablock, a trace that"],
  [QUOTE, "  const accounts = Math.floor(g / 2400) + 64;", "  const accounts = 256;", R, "review of f0f983d2, item 3"],
  [QUOTE, '{ tracer: "prestateTracer", tracerConfig: { disableCode: true } }', '{ tracer: "prestateTracer" }', R, "card evm-sell-hook-intrablock, HC2 (buy, Robinhood) the replay's override"],
  // card evm-sell-ban-reads-a-root-halt: a replay that halts as the sale did at its root is the sale failed; any other
  // halt is a refusal; with no callTracer read, the sale's halt is its receipt's every unit of gas spent
  [QUOTE, "  if (halt !== null && said === halt) return { ok: false, data: \"\", halt };\n", "", R, "card evm-sell-ban-reads-a-root-halt (sell, Base and Robinhood) a hook that burns"],
  [QUOTE, "  if (halt !== null && said === halt) return", "  if (halt !== null && said !== undefined) return", R, "card evm-sell-ban-reads-a-root-halt (sell, Base and Robinhood) a halt that is not"],
  [QUOTE, "o.error.message === `out of gas: gas required exceeds: ${gas}` ?", "o.error.message.startsWith(\"out of gas\") ?", R, "card evm-sell-ban-reads-a-root-halt (sell, Base and Robinhood) a halt that is not"],
  [QUOTE, "BigInt(sale.status) === 0n && BigInt(sale.gasUsed) === BigInt(sale.gas) ? \"out of gas\"", "BigInt(sale.status) === 0n ? \"out of gas\"", R, "card evm-sell-ban-reads-a-root-halt (sell, Base and Robinhood) a halt that is not"],
  [QUOTE, "  if (!asIs && errored.length === 0) return legUnread ? again() : [];", "  if (!asIs && errored.length === 0) return false ? again() : [];", R, "review of f0f983d2, item 5a"],
  [QUOTE, '    if (!(e instanceof EvmQuoteError) || e.code !== "rpc_disagree") unread = true;\n', "", R, "review of f0f983d2, item 5a"],
  // review of de4e3ed5: the market read on the replay's own basis, its state and its block (1); the trace's rpc_error
  // its own reason (2); a hook frame counts only under a PoolManager frame the trade's own target or the pinned v4
  // adapter entered (3); the bounds from the gas the trade used and a quarter more (5)
  [QUOTE, "[{ ...held0, override: base, env }]", "[held0]", R, "review of de4e3ed5, 1"],
  [QUOTE, "[{ ...held0, override: base, env }]", "[{ ...held0, override: base }]", R, "review of de4e3ed5, 1"],
  [QUOTE, "[{ ...held0, override: base, env }]", "[{ ...held0, override: sys, env }]", R, "review of de4e3ed5, 1"],
  [QUOTE, ", reads[i]!.override, ...(reads[i]!.env !== undefined ? [reads[i]!.env] : [])] })),", ", reads[i]!.override] })),", R, "review of de4e3ed5, 1"],
  [QUOTE, "refuse(\"rpc_error\", `${EVM_TRACE_UNANSWERED}: ${sale.hash}`)", "refuse(\"rpc_error\", `${sale.hash}`)", R, "review of de4e3ed5, 2"],
  // retired: `&& chain && !underHook && byOwn && isAddress(f.from)` (review of de4e3ed5, 3), its only killer a route this card refuses
  // retired: `const own = new Set([lower(sale.to), ...(adapter !== undefin` (review of de4e3ed5, 3), its only killer a route this card refuses
  [QUOTE, "const own = new Set([lower(sale.to), ...(adapter !== undefined ? [lower(adapter)] : [])]);", "const own = new Set([...(adapter !== undefined ? [lower(adapter)] : [])]);", R, "review of ca907a05, HIGH 1"],
  // retired: `const ownPm = intoPm && isAddress(f.from) && own.has(lower(f` (review of de4e3ed5, 3), its only killer a route this card refuses
  [QUOTE, "  const used = (gas * 5n) / 4n;", "  const used = (gas * 3n) / 2n;", R, "card evm-sell-hook-intrablock, a trace that"],
  // review of fb923143: each tracer two companies' word apart, so a callTracer no provider answered keeps the prestate
  // both did, and only the as-is leg is unread (1); a callTracer answered apart or not the trade's own call still drops
  // the prestate with it (1d); with the prestate unread, step 3's and step 4's [] are asked again (2); a numeric field
  // that is not a number refuses (question 5)
  [QUOTE, '    if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined, halt: undefined };\n', "", R, "review of fb923143, 1a"],
  [QUOTE, '    if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined, halt: undefined };\n', "", R, "review of fb923143, 1b"],
  // (the 1d mutant that kept the prestate on any EvmQuoteError is gone: since review of 1ee73a00, 2 the catch keeps it
  // on rpc_disagree too, and the agreed read of a callTracer throws no other code, so it is equivalent)
  [QUOTE, "  return errored === null ? null : { over, errored: errored.errored, halt: errored.halt };", "  return { over, errored: errored?.errored, halt: errored?.halt };", R, "review of fb923143, 1d"],
  [QUOTE, "  if (over === null) return null;\n", "", R, "review of fb923143, 1e"],
  [QUOTE, "  const legUnread = unread || (p !== undefined && p.errored === undefined);", "  const legUnread = unread;", R, "review of fb923143, 1c"],
  [QUOTE, "  if (held!.kind !== \"out\" || held!.amountOut < quote.minOut) return unread ? again() : [];", "  if (held!.kind !== \"out\" || held!.amountOut < quote.minOut) return [];", R, "review of fb923143, 2 (buy"],
  [QUOTE, "  return out.length === 0 && (unread || (none && legUnread)) ? again() : out;", "  return out;", R, "review of fb923143, 2 step 4"],
  [QUOTE, '!/^0x[0-9a-fA-F]{1,64}$/.test(v)) return refuse("rpc_error", `${who}\'s ${k} is not a number`);', '!/^0x[0-9a-fA-F]{0,64}$/.test(v)) return refuse("rpc_error", `${who}\'s ${k} is not a number`);', R, "review of fb923143, question 5"],
  // review of 1ee73a00: where the replay failed and no set's no-op rescued it, the hooks the callTracer names errored are
  // at fault, asked again while it is unread (1); the evidence's no-op takes LP fee 0, apart from the quote's (1); a
  // callTracer one provider answers apart keeps the prestate (2); each tracer read on its own byte cap (3)
  [QUOTE, "  const fault = new Set(asIs ? (none ? named : rescued.flat()) : errored);", "  const fault = new Set(asIs ? rescued.flat() : errored);", R, "review of 1ee73a00, 1b"],
  [QUOTE, "  const fault = new Set(asIs ? (none ? named : rescued.flat()) : errored);", "  const fault = new Set(asIs ? rescued.flat() : errored);", R, "review of 1ee73a00, 1c"],
  [QUOTE, "  const fault = new Set(asIs ? (none ? named : rescued.flat()) : errored);", "  const fault = new Set(asIs ? (none ? [] : rescued.flat()) : errored);", R, "review of 1ee73a00, 1a"],
  [QUOTE, "  const named = seen === undefined ? [] : hooks.filter((hk) => seen.includes(lower(hk)));", "  const named = seen === undefined ? [] : hooks;", R, "review of fb923143, 2 step 4"],
  [QUOTE, "  return out.length === 0 && (unread || (none && legUnread)) ? again() : out;", "  return out.length === 0 && unread ? again() : out;", R, "review of 1ee73a00, 1b"],
  [QUOTE, "  return out.length === 0 && (unread || (none && legUnread)) ? again() : out;", "  return out.length === 0 && unread ? again() : out;", R, "review of 1ee73a00, 1c"],
  [QUOTE, "  return out.length === 0 && (unread || (none && legUnread)) ? again() : out;", "  return out.length === 0 && (unread || none) ? again() : out;", R, "review of fb923143, 2 step 4"],
  [QUOTE, "    const atZero = await pass(EVM_EVIDENCE_NOOP_HOOK_CODE);", "    const atZero: string[][] = [];", R, "review of 1ee73a00, 1d"],
  [QUOTE, "    const atZero = await pass(EVM_EVIDENCE_NOOP_HOOK_CODE);", "    const atZero: string[][] = [];", R, "review of 1ee73a00, 1e"],
  // review of d6d055bf, 1: the stored-fee pass's sets count, the fee-0 pass's only where it has none
  [QUOTE, "  for (const s of atStored.length > 0 ? atStored : atZero) {", "  for (const s of atZero) {", R, "review of 2fccaa67, 1 rule"],
  // retired: `const atStored = await pass(EVM_NOOP_HOOK_CODE);` (review of d6d055bf, 1), its only killer a route this card refuses
  [QUOTE, "  for (const s of atStored.length > 0 ? atStored : atZero) {", "  for (const s of atStored) {", R, "review of 1ee73a00, 1d"],
  // review of 2fccaa67, 1: a stored-fee set yields to the smaller fee-0 sets inside it
  [QUOTE, "    const under = atZero.filter((t) => t.length < s.length && t.every((h) => s.includes(h)));", "    const under: string[][] = [];", R, "review of 2fccaa67, 1 "],
  [QUOTE, "    const under = atZero.filter((t) => t.length < s.length && t.every((h) => s.includes(h)));", "    const under: string[][] = [];", R, "review of 2fccaa67, 1 rule"],
  [QUOTE, "    const under = atZero.filter((t) => t.length < s.length && t.every((h) => s.includes(h)));", "    const under = atZero.filter((t) => t.length < s.length);", R, "review of 2fccaa67, 1 rule"],
  // ("<=" for "<" in that filter is equivalent on every input step 4 makes: the hooks are distinct (new Set), so a set
  // inside s as large as s is s; and atZero holds no set inside another (pass skips every superset of one it found,
  // subsetsOf smallest first), so s in atZero has no smaller fee-0 set inside it: either way the output is [s])
  [QUOTE, "    for (const x of under.length > 0 ? under : [s]) if (", "    for (const x of under.length > 0 ? under.slice(0, 1) : [s]) if (", R, "review of 2fccaa67, 1 rule"],
  // retired: `for (const x of under.length > 0 ? under : [s]) if (` (review of 6e8d18ad, nit), the entry above is the same mutant
  [QUOTE, "if (!out.some((r) => r.length === x.length && r.every((h) => x.includes(h)))) out.push([...x]);", "out.push([...x]);", R, "review of 2fccaa67, 1 rule"],
  [QUOTE, "5b6240000060405260606000f3\";", "5b6200000060405260606000f3\";", R, "review of 1ee73a00, 1 "],
  [QUOTE, "5b6240000060405260606000f3\";", "5b6200000060405260606000f3\";", R, "review of 1ee73a00, 1d"],
  [QUOTE, "export const EVM_NOOP_HOOK_CODE = \"0x6004600060003760003560e01c63575e24b414601b5760406000f35b60606000f3\";", "export const EVM_NOOP_HOOK_CODE = \"0x6004600060003760003560e01c63575e24b414601b5760406000f35b6240000060405260606000f3\";", R, "review of 1ee73a00, 1 "],
  [QUOTE, 'if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined, halt: undefined };', 'if (e instanceof EvmQuoteError && e.code === "rpc_error") return { over, errored: undefined, halt: undefined };', R, "review of 1ee73a00, 2c"],
  [QUOTE, 'if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined, halt: undefined };', 'if (e instanceof EvmQuoteError && e.code === "rpc_error") return { over, errored: undefined, halt: undefined };', R, "review of 1ee73a00, 2d"],
  [QUOTE, 'if (e instanceof EvmQuoteError && (e.code === "rpc_error" || e.code === "rpc_disagree")) return { over, errored: undefined, halt: undefined };', 'if (e instanceof EvmQuoteError && e.code === "rpc_error") return { over, errored: undefined, halt: undefined };', R, "review of fb923143, 1d"],
  [QUOTE, "      trace.map((t) => t[at]),", "      trace.map((t) => t[0]),", R, "review of 1ee73a00, 3 "],
  [QUOTE, "[evmJsonRpc(u, fetch, b.preBytes), evmJsonRpc(u, fetch, b.callBytes)]", "[evmJsonRpc(u, fetch, b.preBytes), evmJsonRpc(u, fetch, b.preBytes)]", R, "review of 1ee73a00, 3 "],
  [QUOTE, "(r) => boughtOf(r) === true, (r) => boughtOf(r) === false, preStateOf(v, trace));", "(r) => r.ok, (r) => boughtOf(r) === false, preStateOf(v, trace));", R, "review of fb923143, 2 step 4"],
  [QUOTE, "(r) => boughtOf(r) === true, (r) => boughtOf(r) === false, preStateOf(v, trace));", "(r) => boughtOf(r) === true, (r) => !r.ok, preStateOf(v, trace));", R, "HB1 "],
  [QUOTE, "if (bAdapter !== BigInt(v.adapterV4) || bToken", "if (bToken", R, "HB6 "],
  [QUOTE, " || bMinOut !== quote.minOut) return [];", ") return [];", R, "HB6 "],
  [QUOTE, "    if (data !== \"0x\" + hex(evmPoolRouteDataQuoted(chain, route).data)) return [];\n", "", R, "HB6 "],
  // the sale is the quote's own: each field of the Sell and its route bound (a sale with one off is never evidence)
  [QUOTE, "if (sToken !== BigInt(token) || sAmount", "if (sAmount", R, "RV11 "],
  [QUOTE, " || sAmount !== quote.amountIn || sTarget", " || sTarget", R, "RV11 "],
  [QUOTE, " || sTarget !== BigInt(quote.target) || sMinOut", " || sMinOut", R, "RV11 "],
  [QUOTE, " || sMinOut !== quote.minOut) return [];", ") return [];", R, "RV11 "],
  [QUOTE, "    if (JSON.stringify(signed) !== JSON.stringify(route)) return [];\n", "", R, "RV11 "],
  [SELLU, "if (swapData(chain, token, route, target, w, amount, minOut, true) !== lower(data))", "if (swapData(chain, token, route, target, w, amount, minOut) !== lower(data))", R, "HC6 "],
  [SELLU, "  evmSellRouteCheck(chain, token, route, true);\n  return route;", "  evmSellRouteCheck(chain, token, route);\n  return route;", R, "HC6 "],
  [SELLU, "return v4Data(chain, token, (route as Record<string, unknown>).hops, anyHook);", "return v4Data(chain, token, (route as Record<string, unknown>).hops, true);", R, "HC6 "],
  [SELLU, "const built = evmPoolBuildSellUnpinned(chain, { ...req, pool }, anyHook);", "const built = evmPoolBuildSellUnpinned(chain, { ...req, pool });", R, "HC6 "],
  [SELLU, "  if (route.venue === \"uniswap-v4\") v4Data(chain, token, route.hops, anyHook);", "  if (route.venue === \"uniswap-v4\") v4Data(chain, token, route.hops, true);", R, "HC6 "],
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
  [QUOTE, "override: asW, tx }], lim);", "override: asW }], lim);", R, "PE6 "],
  // the sender's balance is its own (review point 4, 4 Nov): a balance override on it, on the nonce read or the sim, is caught,
  // and a sender too low to pay the sim's gas, read at the block, skips the sim and keeps every route at its keep-min
  // value (card evm-sell-unfunded-sim-keeps-route: dropping them let a seeded pool set the price), never the sale
  [QUOTE, "override: asW, tx }], lim);", "override: { ...asW, [sender]: { balance: qty(gas * maxFee + 10n ** 18n) } }, tx }], lim);", R, "PE6 "],
  [QUOTE, "override: { ...asW, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", "override: { ...asW, [sender]: { balance: qty(gas * maxFee + 10n ** 18n) }, [EVM_SELL_SIM]: { code: SIM_POOL_CODE } }, tx };", R, "PE6 "],
  [QUOTE, "if (bal!.kind !== \"out\" || bal!.amountOut < gas * maxFee) return { routes, sim: \"skipped\" };", "if (false) return { routes, sim: \"skipped\" };", R, "PE8 "],
  [QUOTE, "if (bal!.kind !== \"out\" || bal!.amountOut < gas * maxFee) return { routes, sim: \"skipped\" };", "if (false) return { routes, sim: \"skipped\" };", R, "PE9 "],
  [QUOTE, "maxFee) return { routes, sim: \"skipped\" };", "maxFee) return { routes: routes.filter((r) => !toSim.includes(r)), sim: \"skipped\" };", R, "PE9 "],
  [QUOTE, "maxFee) return { routes, sim: \"skipped\" };", "maxFee) return { routes, sim: \"ran\" };", R, "PE8 "],
  [QUOTE, "maxFee) return { routes, sim: \"skipped\" };", "maxFee) return { routes, sim: \"ran\" };", R, "PE9 "],
  [QUOTE, "if (hooked.length === 0) return { routes, sim: \"none\" };", "if (hooked.length === 0) return { routes, sim: \"ran\" };", R, "PE8 "],
  [QUOTE, "return { routes: kept, sim: \"ran\" };", "return { routes: kept, sim: \"skipped\" };", R, "PE8 "],
  // review of 1c31d81a: a balance read that does not answer skips the sim (L1); a chain that pins no delegate or sender
  // says the sim was skipped (L3); a simmed route counts at the lower of its keep-min value and W's gain in the sim,
  // dropped only where the sim reverts at one wei above the floor (M1)
  [QUOTE, "if (bal!.kind !== \"out\" || bal!.amountOut", "if (bal!.amountOut", R, "PE11 "],
  [QUOTE, "if (toSim.length === 0) return { routes, sim: \"skipped\" };", "if (toSim.length === 0) return { routes, sim: \"none\" };", R, "PE12 "],
  [QUOTE, "minOut: floor + 1n,", "minOut: r.amountOut,", R, "PE10 "],
  [QUOTE, "kept.push(a.amountOut < r.amountOut ? { route: r.route, amountOut: a.amountOut } : r);", "kept.push(r);", R, "PE10 "],
  [QUOTE, "kept.push(a.amountOut < r.amountOut ? { route: r.route, amountOut: a.amountOut } : r);", "kept.push({ route: r.route, amountOut: a.amountOut });", R, "PE9 "],
  [QUOTE, "    if (i < 0) kept.push(r);\n", "    if (i < 0) continue;\n", R, "PE a pool"],
  [QUOTE, "feeMax, hooked, releases, sim, outOfGas: ", "feeMax, hooked, releases, outOfGas: ", R, "PE9 "],
  [QUOTE, "bal!.amountOut < gas * maxFee)", "bal!.amountOut < gas * maxFee - 1n)", R, "PE8 "],
  [QUOTE, "bal!.amountOut < gas * maxFee)", "bal!.amountOut <= gas * maxFee)", R, "PE8 "],
  // card evm-buy-gas-floor (audit I-4): a buy's route is taken, named or priced against only where its swap, run as
  // the pool runs it, fits EVM_BUY_SWAP_FIT
  [QUOTE, "  if (own === null) {\n", "  if (false) {\n", R, "GF1 "],
  [QUOTE, "  if (reference === null && filled.length > 0) return refuse(", "  if (false) return refuse(", R, "GF7 "],
  [QUOTE, "asked.forEach((r, i) => fit.set(r.data, a[i]!.kind === \"out\"));", "asked.forEach((r) => fit.set(r.data, true));", R, "GF3 "],
  [QUOTE, "fit.set(reads[ownFit]!.data, out(ownFit) !== null);", "fit.set(reads[ownFit]!.data, true);", R, "GF1 "],
  [QUOTE, "const b = best(l.filter((c) => fits(c.route) !== false));", "const b = best(l);", R, "GF1 "],
  [QUOTE, "natives.some((c) => fits(c.route) === true)", "natives.length > 0", R, "GF8 "],
  [QUOTE, "  const listed = fitted[3] ?? null;", "  const listed = bestOf(exits);", R, "GF9 "],
  [QUOTE, "  const reference = fitted[1] ?? null;", "  const reference = bestOf(filled);", R, "GF3 "],
  [QUOTE, "  const nativeBest = fitted[2] ?? null;", "  const nativeBest = bestOf(natives);", R, "GF8 "],
  [QUOTE, "export const EVM_BUY_SWAP_FIT = 476_190n;", "export const EVM_BUY_SWAP_FIT = 500_000n;", R, "GF6 "],
  [QUOTE, "export const EVM_BUY_SWAP_GAS = 500_000n;", "export const EVM_BUY_SWAP_GAS = 476_190n;", R, "GF5 "],
  [QUOTE, "gas: \"0x\" + (intrinsic + exec).toString(16)", "gas: \"0x\" + exec.toString(16)", R, "GF6 "],
  [QUOTE, "intrinsic += call.slice(k, k + 2) === \"00\" ? 4n : 16n;", "intrinsic += 16n;", R, "GF5 "],
  [QUOTE, "override: { [v.pool]: { balance: \"0x\" + amount.toString(16) } }", "override: {}", R, "GF2 "],
  [QUOTE, "tx: { from: v.pool, gas:", "tx: { from: adapter, gas:", R, "GF2 "],
  [QUOTE, "    if (oog && typeof message === \"string\" && OUT_OF_GAS_WORDS.test(message)) return { kind: \"revert\", partial: false };\n", "", R, "GF1 "],
  [QUOTE, "/^out of gas(: (gas required exceeds:?|gas exhausted during memory expansion:|gas exhausted during precompiled contract execution:|invalid operand to an opcode:) \\d+)?$/i", "/^out of gas$/i", R, "GF5 "],
  [QUOTE, "/^out of gas(: (gas required exceeds:?|gas exhausted during memory expansion:|gas exhausted during precompiled contract execution:|invalid operand to an opcode:) \\d+)?$/i", "/^out of gas/i", R, "GF5 "],
  // review of 498eae83: L5 (the out-of-gas words only for the swap read; each read's own answer), L3 (reth's words),
  // L2 (the block's recipient), M2 (every route that can change the verdict in one round, at most two)
  [QUOTE, "if (oog && typeof message", "if (typeof message", R, "GF11 "],
  [QUOTE, "asked.forEach((r, i) => fit.set(r.data, a[i]!.kind === \"out\"));", "asked.forEach((r) => fit.set(r.data, a[0]!.kind === \"out\"));", R, "GF10 "],
  [QUOTE, "|gas exhausted during memory expansion:|gas exhausted during precompiled contract execution:|invalid operand to an opcode:", "", R, "GF5 "],
  [QUOTE, "word(BigInt(\"0x\" + fitTo(blockHash)))", "word(0x9116a1e7147d594ae107fe8b0e67f9d4de4b1e76n)", R, "GF5 "],
  [QUOTE, "for (const c of round === 0 ? firstFew(first.length > 0 ? first : unknown) : unknown) ask.set(", "for (const c of [b]) ask.set(", R, "GF10 "],
  [QUOTE, "      fitAt = b.hash;\n", "", R, "GF2 "],
  // review 2 of c9a8df14: the second fit round (L1, the reviewer's mutant J) and the fit call's bounds (L2)
  [QUOTE, "for (const c of round === 0 ? firstFew(first.length > 0 ? first : unknown) : unknown) ask.set(", "for (const c of round === 0 ? firstFew(first.length > 0 ? first : unknown) : [b]) ask.set(", R, "GF12 "],
  [QUOTE, "  if (typeof amount !== \"bigint\" || amount <= 0n || amount >= MAX_IN) return refuse(\"bad_request\", \"the amount in is above 0 and below 2^127\");\n", "", R, "GF13 "],
  [QUOTE, "  if (typeof exec !== \"bigint\" || exec <= 0n) return refuse(\"bad_request\", \"the swap's gas cap is above 0\");\n", "", R, "GF13 "],
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
  // the fee recipient is the caller's, the one its pin names (card pool-review-3, L-1), never another
  [QD, "precommitment, feeCap, feeRecipient, deadline, nonce }, hooked", 'precommitment, feeCap, feeRecipient: "0x000000000000000000000000000000000000beef", deadline, nonce }, hooked', S, "planted: the sender's fee cap"],
  [SELLU, "feeCap: 0n, feeRecipient: EVM_SELL_SIM,", "feeCap: 0n, feeRecipient: lower(w),", S, "planted: the sim signer"],
  [QUOTE, 'if (typeof boughtBlock !== "bigint" || boughtBlock < 1n) return refuse(', "if (false) return refuse(", S, "planted: a sell quote takes the buy's block"],
  [QUOTE, "boughtBlock < 1n) return refuse(", "boughtBlock < 0n) return refuse(", S, "planted: a sell quote takes the buy's block"],
  [QUOTE, "if (got.a.number >= minBlock && got.b.number >= minBlock) break;", "break;", R, "L5 "],
  [QUOTE, "if (got.a.number >= minBlock && got.b.number >= minBlock) break;", "if (got.a.number >= minBlock || got.b.number >= minBlock) break;", R, "L5 "],
  [QUOTE, "if (got.a.number >= minBlock && got.b.number >= minBlock) break;", "if (got.a.number > minBlock && got.b.number > minBlock) break;", R, "L5 "],
  [QUOTE, "    if (left() <= 0) return late();\n", "", R, "L5b "],
  [QUOTE, "export const EVM_MIN_BLOCK_WAIT_MS = 30_000;", "export const EVM_MIN_BLOCK_WAIT_MS = 3_000;", R, "L5b "],
  [QUOTE, "const EVM_MIN_BLOCK_EVERY_MS = 500;", "const EVM_MIN_BLOCK_EVERY_MS = 1_000;", R, "L5b "],
  // the reviewer's two survivors (review fold 1, L3): the wait's sleep gone, or of 0 ms
  [QUOTE, "    await new Promise((r) => setTimeout(r, EVM_MIN_BLOCK_EVERY_MS));\n", "", R, "L5b "],
  [QUOTE, "setTimeout(r, EVM_MIN_BLOCK_EVERY_MS)", "setTimeout(r, 0)", R, "L5b "],
  // review fold 1 M2 and L2: one deadline over the reads and the sleeps; the age at the clock after the wait
  [QUOTE, "    got = minBlock === 0n ? await round : await within(round, left(), late);", "    got = await round;", R, "M2 "],
  [QUOTE, "const left = () => EVM_MIN_BLOCK_WAIT_MS - (mono() - t0);", "const left = () => EVM_MIN_BLOCK_WAIT_MS;", R, "M2 "],
  [QUOTE, "const atMs = nowMs + Math.max(0, mono() - start);", "const atMs = nowMs;", H, "held head: the watch counts the time its head reads took"],
  // the age from the quote's entry, the scan's time included, on a sell and a buy (review fold 2, LOW-1): its three
  // mutants are equivalent since card evm-buy-quote-ends-on-node and are left out. `start` is a quote's entry only on a
  // quote's path (routeSet's fresh, evmPoolBuyQuoteWith's and evmPoolSellQuoteWith's routeSet args); the head watch calls
  // agreedBlock with start = t0. On a quote's path, the deadline (gated's past, its `now` the quote's own entry clock,
  // set at the block's agreement in agreedOnce) refuses stale_quote at the block's confirmation, before any request
  // leaves its gate, wherever the age line would: the same code, and no request sent. LOW-1's tests still hold it.
  [QUOTE, "agreedBlock(on, v.maxLag, a.nowMs, a.minBlock, a.mono, a.start,", "agreedBlock(on, v.maxLag, a.nowMs, undefined, undefined, undefined,", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, mono, start });", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, minBlock: boughtBlock - 1n, mono, start });", R, "L5 "],
  [QUOTE, "sell: true, minBlock: boughtBlock, mono, start });", "sell: true, minBlock: boughtBlock, start, after });", R, "M2 "],
  // the hook data rule on any hop, the first included (review fold 1, L3)
  [QUOTE, 'route.hops.some((h) => h.hookData !== "0x")) return refuse(', 'route.hops.slice(-1).some((h) => h.hookData !== "0x")) return refuse(', R, "HD1 "],
  [QUOTE, 'if (fee !== undefined && (typeof fee !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(fee))) return refuse(', "if (false) return refuse(", R, "R11 "],
  // the sim signer's signature recovers to W over SellDelegate's own digest (review of the exec sim, LOW 3)
  [SELLU, "      word(BigInt(chainId)),", "      word(0n),", S, "planted: the sim signer"],
  // no sell while a release that pays W ETH is not final on two RPCs (card evm-sell-no-release-in-flight, audit E-01):
  // the builder's guard, the verdict's record, its chain, W and block, and each rule of what is pending
  [QD, "  evmSellReleasesClear(quote);\n", "", S, NR],
  [SR, "!MADE.has(releases as EvmSellReleases)", "false", S, NR],
  [SR, "  MADE.add(v);\n", "", S, NR],
  [SR, "if (v.chain !== quote.chain || ", "if (", S, NR],
  [SR, " || v.w !== quote.w.toLowerCase()) throw", ") throw", S, NR],
  [SR, "v.w !== quote.w.toLowerCase())", "v.w !== quote.w)", S, NR],
  // the verdict's block is the quote's (review of 982a19bd, F1b)
  [SR, "if (v.block !== quote.block.number) throw", "if (false) throw", S, NR],
  [SR, "if (v.block !== quote.block.number) throw", "if (v.block < quote.block.number) throw", S, NR],
  [SR, "if (v.pending.length > 0) {", "if (false) {", S, NR],
  // every release in the tail is pending, in the agreed range and above the quote's block (F3), but one buy that funded
  // the sale: its token and its block (review of 982a19bd, F2; of 181fd050, R2-3)
  [SR, "  for (const e of [...r.agreed, ...r.above]) {\n    if (!funded", "  for (const e of [...r.agreed]) {\n    if (!funded", S, NR],
  [SR, "  for (const e of [...r.agreed, ...r.above]) {\n    if (!funded", "  for (const e of [...r.above]) {\n    if (!funded", S, NR],
  [SR, "if (!funded && e.kind === \"buy\"", "if (e.kind === \"buy\"", S, NR],
  [SR, " && e.token === r.funding.token.toLowerCase() && e.block", " && e.block", S, NR],
  [SR, " && e.block === r.funding.block) funded = true;", ") funded = true;", S, NR],
  [SR, "if (!funded && e.kind === \"buy\" && e.token === r.funding.token.toLowerCase() && e.block === r.funding.block) funded = true;", "if (false) funded = true;", S, NR],
  [SR, "noteOf.get(e.nullifier) ?? null", "null", S, NR],
  [SR, "    landed.add(e.nullifier);\n", "", S, NR],
  [SR, "if (landed.has(e.nullifier)) throw", "if (false) throw", S, NR],
  [SR, "if (!landed.has(s.nullifier) && (s.deadlineMs", "if ((s.deadlineMs", S, NR],
  [SR, "|| finalMs <= s.deadlineMs))", "|| finalMs < s.deadlineMs))", S, NR],
  [SR, "(s.deadlineMs === undefined || finalMs <= s.deadlineMs)", "true", S, NR],
  [SR, "(s.deadlineMs === undefined || finalMs", "(finalMs", S, NR],
  [SR, "const finalMs = fin.timestamp * 1000n;", "const finalMs = fin.timestamp;", S, NR],
  // the quote's own read (review of 982a19bd, F1): the device's list, the finalized block, the pages, the agreed block,
  // the agreement up to it, the logs' checks
  [QUOTE, "evmSellSentOf(req.sent) ?? refuse(", "evmSellSentOf(req.sent ?? []) ?? refuse(", S, NR],
  [QUOTE, "hooked, releases, sim, outOfGas: ", "hooked, sim, outOfGas: ", S, NR],
  [QUOTE, "if (n - fin.number > EVM_SELL_TAIL_MAX) return refuse(", "if (false) return refuse(", S, NR],
  [QUOTE, "if (n - fin.number > EVM_SELL_TAIL_MAX) return refuse(", "if (n - fin.number >= EVM_SELL_TAIL_MAX) return refuse(", S, NR],
  [QUOTE, "for (let a = low(fin.number + 1n, n); ", "for (let a = low(fin.number, n); ", S, NR],
  [QUOTE, 'toBlock: b === null ? "latest" : hx(b)', "toBlock: b === null ? hx(n) : hx(b)", S, NR],
  [QUOTE, "if (header(got[part.length], who).hash !== block.hash) return refuse(", "if (false) return refuse(", S, NR],
  [QUOTE, "(x, y) => upTo(x) === upTo(y),", "() => true,", S, NR],
  [QUOTE, 't0 === TOPIC_BOUGHT ? "buy" : null', 't0 === TOPIC_BOUGHT ? "withdraw" : null', S, NR],
  [QUOTE, 'nullifier: BigInt("0x" + data.slice(2 + 64 * 3, 2 + 64 * 4))', 'nullifier: BigInt("0x" + data.slice(2 + 64 * 2, 2 + 64 * 3))', S, NR],
  [QUOTE, "|| removed === true) {", ") {", S, NR],
  [QUOTE, "if (kind === null || lower(topics[1]) !== wTopic) return refuse(", "if (kind === null) return refuse(", S, NR],
  [QUOTE, "if (keys.size !== out.length) return refuse(", "if (false) return refuse(", S, NR],
  // a log above the quote's block one provider alone gave counts only once a second confirms it (review of 181fd050,
  // R2-1, R2-2); the funding buy is the quote's token at its boughtBlock (R2-3)
  [QUOTE, "const above = [...inA.values()].filter((e) => inB.has(e.key));", "const above: ReleaseLog[] = [];", S, NR],
  [QUOTE, "above.push(...confirmed);", "above.push(...at);", S, NR],
  [QUOTE, "for (const x of at) if (keys.has(x.key)) confirmed.add(x.key);", "for (const x of at) if (false) confirmed.add(x.key);", S, NR],
  // review of 9c2a87d5, I-1: m1, the claimant asked to confirm its own log, and m3, a denial that holds no one
  [QUOTE, "const others = list.map((_, k) => k).filter((k) => k !== claimant);", "const others = list.map((_, k) => k).filter(() => true);", S, NR],
  [QUOTE, "    if (deny >= need) {\n      HOLD.get(list[claimant]!)?.();\n", "    if (deny >= need) {\n", S, NR],
  // R3-1: a low head within maxLag, a block of another hash, an error to the logs by hash; R4-1: a denial only by more
  // than half of the whole list
  [QUOTE, "if (e.block > head + maxLag) deny++;", "if (false) deny++;", S, NR],
  [QUOTE, "if (h.hash !== e.hash) deny++;", "if (h.hash !== e.hash) {}", S, NR],
  [QUOTE, "if (!at.every((x) => keys.has(x.key))) deny++;", "if (false) deny++;", S, NR],
  [QUOTE, "else if (Array.isArray(r)) {\n          const keys = new Set(r.map(", "else {\n          const keys = new Set((Array.isArray(r) ? r : []).map(", S, NR],
  [QUOTE, "if (deny >= need) {", "if (deny >= need - 1) {", S, NR],
  [QUOTE, "confirmed.has(x.key));\n  const need = Math.floor(list.length / 2) + 1;", "confirmed.has(x.key));\n  const need = 1;", S, NR],
  // R4-4: the stall refuses and holds the claimant
  [QUOTE, "    if (monotonic() >= until) {\n      HOLD.get(list[claimant]!)?.();\n", "    if (monotonic() >= until) {\n", S, NR],
  [QUOTE, "    if (monotonic() >= until) {", "    if (false) {", S, NR],
  // the wait runs as long as another provider's head moves toward the block (base-sepolia's maxLag is about 20 s)
  [QUOTE, "if (head > best && head < e.block) [best, until]", "if (false) [best, until]", S, NR],
  // R3-2: by EVM_SELL_CONFIRM_BY_MS after the quote's block, a refusal that holds the claimant
  [QUOTE, "    if (clock() >= byMs) {\n      HOLD.get(list[claimant]!)?.();\n", "    if (clock() >= byMs) {\n", S, NR],
  [QUOTE, "    if (clock() >= byMs) {", "    if (false) {", S, NR],
  // R3-3: the cap, and nothing past a claimant's first denial
  [QUOTE, "if (out.filter((e) => e.block > n).length > EVM_SELL_ABOVE_MAX) return refuse(", "if (false) return refuse(", S, NR],
  [QUOTE, "if (out.filter((e) => e.block > n).length > EVM_SELL_ABOVE_MAX) return refuse(", "if (out.filter((e) => e.block > n).length >= EVM_SELL_ABOVE_MAX) return refuse(", S, NR],
  [QUOTE, "      if (denied) break;", "      if (false) break;", S, NR],
  [QUOTE, "{ token: t, block: boughtBlock }", "{ token: t, block: 0n }", S, NR],
  [QUOTE, "data.slice(2 + 64 * 5 + 24, 2 + 64 * 6)", "data.slice(2 + 64 * 4 + 24, 2 + 64 * 5)", S, NR],
  // I-3: the Bought token in lower case, whatever the provider's hex
  [QUOTE, 'lower("0x" + data.slice(2 + 64 * 5 + 24, 2 + 64 * 6))', '("0x" + data.slice(2 + 64 * 5 + 24, 2 + 64 * 6))', S, NR],
  [QUOTE, "poolRpcs === rpcsIn ? rpcs : gated(poolRpcs, v.scan?.parallel ?? 2, DEADLINE.get(rpcs))", "rpcs", S, NR],
  // card evm-buy-quote-ends-on-node: each round's batches agreed one at a time; a late batch's spare budget; a stalled
  // provider's queued requests moved, and dropped unsent; a request late only from its send; the quote's deadline, set
  // at the block's agreement, held in the reads' gate, the scan provider's and the pool's releases read, and passed
  // through ask unwrapped. Left out, as harmless: T4 (gated's plain call, \`f\`, which no request of a quote calls: ask
  // sends a gated provider's through GATED) and A2 (ask's \`e === MOVED\`: a moved request's rejection is dropped by
  // agreeing, which marks it moved before it rejects, as an rpc_error or MOVED alike).
  [QUOTE, "    starts.map(async (c0, n) => {\n      const batch = calls.slice(c0, starts[n + 1] ?? calls.length);", "    starts.slice(0, 1).map(async (c0, n) => {\n      const batch = calls.slice(c0);", R, "QE1 "],
  [QUOTE, "        past();\n        gate?.sent();\n", "        past();\n", R, "QE1 "],
  [QUOTE, "  const late = () => spares > 0 && (spares--, true);", "  const late = () => true;", R, "QE4 "],
  [QUOTE, "() => flying > 0 && performance.now() - lastAt > 4 * EVM_HEDGE_MS);", "() => false);", R, "QE3 "],
  [QUOTE, "          if (movedK[k]) return done ? undefined : end();\n", "", R, "QE5 "],
  [QUOTE, "      if (out.length > 0 && since < lateAfter()) return arm(lateAfter() - since);\n", "", R, "QE6 "],
  [QUOTE, "        if (gate?.moved() === true) return Promise.reject(MOVED);\n        past();", "        if (gate?.moved() === true) return Promise.reject(MOVED);", R, "QE2 (buy) "],
  [QUOTE, "        if (deadline !== undefined) deadline.until = Number(x.block.timestamp) * 1000 + EVM_QUOTE_MAX_AGE_MS;", "", R, "QE2 (buy) "],
  // no deadline at the block's agreement (as at 2d9a7bd9, where it was set once the token's scan returned): the scan's
  // catch-up to the agreed block is asked again past it
  [QUOTE, "        if (deadline !== undefined) deadline.until = Number(x.block.timestamp) * 1000 + EVM_QUOTE_MAX_AGE_MS;", "", R, "QE11 "],
  [QUOTE, 'if (e === MOVED || e === DROPPED || (e instanceof EvmQuoteError && e.code === "stale_quote")) throw e;', "if (e === MOVED || e === DROPPED) throw e;", R, "QE2 (buy) "],
  [QUOTE, "      if (left() < 0 || resumeAt - now > left()) throw stale();\n", "", R, "QE7 "],
  [QUOTE, "scanGateOf(c.parallel, t0 + scanBoundMs, next !== undefined, DEADLINE.get(rpcs), scanRpcs[i]!,", "scanGateOf(c.parallel, t0 + scanBoundMs, next !== undefined, undefined, scanRpcs[i]!,", R, "QE7 "],
  [QUOTE, "gated(poolRpcs, v.scan?.parallel ?? 2, DEADLINE.get(rpcs))", "gated(poolRpcs, v.scan?.parallel ?? 2)", R, "QE8 "],
  // card evm-5xx-holds-the-provider-for-the-round: a provider that answers HTTP 5xx is held for the rest of its round, so
  // the round's batches queued in its gate go to the next unsent, and the scan's requests the next would be handed too
  [QUOTE, "        late,\n        down,\n        roomOf(batch),\n      );", "        late,\n        undefined,\n        roomOf(batch),\n      );", R, "FH1 "],
  [QUOTE, "          if (serverFault(e)) gate?.down?.();\n          throw e;", "          throw e;", R, "FH1 "],
  [QUOTE, "            down = true;\n", "", R, "SP5xx "],
  [QUOTE, "readBoth(rpcs, block.hash, third.slice(own), v.reads, undefined, down)", "readBoth(rpcs, block.hash, third.slice(own), v.reads)", R, "FH4 "],
  [QUOTE, "fitsEarly = readBoth(rpcs, b.hash, early, v.reads, undefined, down)", "fitsEarly = readBoth(rpcs, b.hash, early, v.reads)", R, "FH5 "],
  [QUOTE, "const reading = readAgreed(confirm, rpcs, block.hash, reads, v.reads, firstDown);", "const reading = readAgreed(confirm, rpcs, block.hash, reads, v.reads);", R, "FH5 "],
  // card evm-buy-quote-in-window: a round's reads 64 to a call
  [BUYU, "      reads: bare({ perCall: 64, maxBytes: 200_000 }),", "      reads: Object.freeze({ perCall: 6, maxBytes: 200_000 }),", R, "QE9 "],
  // review of 2c02f7df: each venue's reads pinned, and no request past the venue's bytes (a call's split, a batch's cut)
  [BUYU, "took 200,000\n      reads: bare({ perCall: 6, maxBytes: 24_000 }),", "took 200,000\n      reads: Object.freeze({ perCall: 64, maxBytes: 24_000 }),", R, "QE14 "],
  [QUOTE, "    if (part.length > 1 && bytesOf(callOf(part)) > lim.maxBytes) {", "    if (false) {", R, "QE14 "],
  [QUOTE, "    if (k === CALLS_PER_BATCH || size + b > lim.maxBytes) {", "    if (k === CALLS_PER_BATCH) {", R, "QE14 "],
  // past the scan's bound a plain rpc_error: its halves and the spare's spans are asked past it
  [QUOTE, '  const past = () => new ScanStop("rpc_error", ', '  const past = () => new EvmQuoteError("rpc_error", ', R, "QE12 "],
  // the counter QE12 reads: without it the scan's asks read 0
  [QUOTE, "      scanAsks++;\n", "", R, "QE12 "],
  // a request queued at the gate past the bound: a plain rpc_error there is asked as its halves and handed to the spare
  [QUOTE, "      if (now >= untilMs) throw past();", '      if (now >= untilMs) throw new EvmQuoteError("rpc_error", "past the bound");', R, "QE13 "],
  // card evm-buy-never-below-a-hidden-market: a buy's route that fills with its hooks replaced but not as it is counts in
  // R at the lowest of its reads that answer, X's best market ranked the same, only where its read with its hooks
  // replaced fills; R's swap read through a hook the venue does not list with those hooks replaced, the route's own as it is
  [QUOTE, "    if (x !== null || c.real === undefined || !fills(c) || fills(c.real)) return x;", "    return x;", R, "ZZ1 "],
  [QUOTE, "    if (x !== null || c.real === undefined || !fills(c) || fills(c.real)) return x;", "    if (x !== null || a.sell || c.real === undefined || !fills(c) || fills(c.real)) return x;", R, "ZZ7 "],
  [QUOTE, " || c.real === undefined || !fills(c) || fills(c.real)) return x;", " || c.real === undefined || fills(c.real)) return x;", R, "ZZ5 "],
  [QUOTE, " || c.real === undefined || !fills(c) || fills(c.real)) return x;", " || c.real === undefined || !fills(c)) return x;", R, "review of a2d82dc6, F2 "],
  [QUOTE, "      if (y !== null && y > 0n && y < m) m = y;", "      if (false as boolean) m = y;", R, "ZZ6 "],
  [QUOTE, "    const h = bestBy(c, heldOf);", "    const h = bestBy(c, valueOf);", R, "ZZ2 "],
  [QUOTE, "    return { mks: h === null ? [] : t === null || t === h ? [h] : [h, t], trades: t !== null };", "    return { mks: h === null ? [] : [h], trades: t !== null };", R, "ZZ7b "],
  [QUOTE, "    return { mks: h === null ? [] : t === null || t === h ? [h] : [h, t], trades: t !== null };", "    return { mks: h === null ? [] : t === null || t === h ? [h] : [h, t], trades: h !== null };", R, "ZZ7c "],
  [QUOTE, "      const x = heldOf(c);\n      if (x !== null) filled.push", "      const x = valueOf(c);\n      if (x !== null) filled.push", R, "ZZ1 "],
  [QUOTE, "      fitReads.set(r, f === null || hs.length === 0 ? f : { ...f, override: { ...f.override, ...noopOf(hs) } });", "      fitReads.set(r, f);", R, "ZZ1c "],
  [QUOTE, "      const hs = r === route || r.venue", "      const hs = r.venue", R, "ZZ1c "],
  // a refusal whose R the device can read but not trade through names the best open route within the slippage of R
  [QUOTE, "    if (r === null || !heldRoutes.has(JSON.stringify(r.route))) return r;", "    return r;", R, "ZZ9 "],
  [QUOTE, "!hookedRoute(chain, c.route) && near(c.amountOut, r.amountOut)", "near(c.amountOut, r.amountOut)", R, "ZZ9 "],
  [QUOTE, "!hookedRoute(chain, c.route) && near(c.amountOut, r.amountOut)", "!hookedRoute(chain, c.route)", R, "ZZ8 "],
  [QUOTE, "    return refuse(noMainCode, noMain, await named(r));", "    return refuse(noMainCode, noMain, r);", R, "ZZ9 "],
  [QUOTE, "below the standard pool's ${reference.amountOut}`, await named(reference));", "below the standard pool's ${reference.amountOut}`, reference);", R, "ZZ9 "],
  [QUOTE, '", and no route does" : ""}`, await named(reference));', '", and no route does" : ""}`, reference);', R, "ZZ9 "],
  [QUOTE, "valueOf(c) === null ? { route: c.route, amountOut: x, held: true } : ", "", R, "ZZ9 "],
  // card evm-warm-tap-reads-in-one-round: a tap at another amount than the warm sends each read the warm needed fewer a
  // call in that many, and the routes through X's markets the last quote did not take beside the first round
  [QUOTE, " ?? routeSizes.get(reads[i]!.size ?? \"\")", "", R, "GS23 "],
  [QUOTE, "    routeSizes.set(route, n);", "", R, "GS23 "],
  [QUOTE, "    for (const kept0 of plan.early) {", "    for (const kept0 of [] as Read[]) {", R, "RX2 "],
  [QUOTE, "  if (earlyAns !== null) {", "  if (false) {", R, "RX2 "],
  // card evm-tap-never-restarts-after-the-fit: a follow at the refusal's block sends no read the refused quote read
  [QUOTE, "    agreedKeep(hash, miss.map((i) => [keys[i]!, out[i]!] as const));", "    agreedKeep(hash, miss.flatMap((i) => ((out[i] as { gas?: true }).gas === true ? [] : [[keys[i]!, out[i]!] as const])));", R, "GS24 "],
  // card evm-pinned-follow-reads-no-scan-past-its-block: a follow pinned to a refusal's block scans up to it, no head read
  [QUOTE, "(a.pin !== undefined ? Promise.resolve(a.pin.number) : spec !== null ? Promise.resolve(spec.number) : headFrom(f))", "(spec !== null ? Promise.resolve(spec.number) : headFrom(f))", R, "GS25 "],
  // card evm-warm-quote-inside-the-kpi-with-room: a warm buy's scan reads up to its held head, its scan provider's head
  // read beside it; and each batch of a round asks first the two providers that answer it soonest
  [QUOTE, "(a.pin !== undefined ? Promise.resolve(a.pin.number) : spec !== null ? Promise.resolve(spec.number) : headFrom(f))", "(a.pin !== undefined ? Promise.resolve(a.pin.number) : headFrom(f))", R, "WS1 "],
  // card evm-cold-quote-inside-the-kpi: a first scan provider still out past its hedge time for its head has the next
  // asked beside it; the first head answered is kept, and the first's failure still asks the next
  [QUOTE, "evmHedgeAfter(URL_OF.get(o.rpc), \"head\") ?? EVM_HEDGE_MS);", "EVM_SCAN_HOLD_MS * 10);", R, "KPI1 "],
  [QUOTE, "      const timer = setTimeout(() => void spare().then(win, () => {}), evmHedgeAfter(", "      const timer = setTimeout(() => void spare().then(win, (e: unknown) => ((over = true), no(e))), evmHedgeAfter(", R, "KPI2 "],
  [QUOTE, "      scanHeadOf(o.rpc, o.gate).then(win, () => {\n        clearTimeout(timer);", "      scanHeadOf(o.rpc, o.gate).then(win, (e: unknown) => {\n        if (theirs === undefined) return no(e);\n        clearTimeout(timer);", R, "KPI2 "],
  [QUOTE, "      const spare = () => (theirs ??= inTurn(next));", "      const spare = () => (theirs ??= headFrom(next));", R, "KPI3 "],
  // bloXroute's Robinhood endpoint paced to 10 calls in any second, its 429 from runners at 11 and 12 (card
  // robinhood-blxrbdn-under-the-runner-limit; 16 before, its 429 at 17 in live run 45043534742)
  ["src/checks/evm/pace.ts", '"https://robinhood.rpc.blxrbdn.com": Object.freeze({ perS: 6, burst: 4, unit: "call" }),', '"https://robinhood.rpc.blxrbdn.com": Object.freeze({ perS: 10, burst: 6, unit: "call" }),', "test/evm-pace-provider-limits.test.ts", "card robinhood-taps-meet-no-429: a burst of a tap's posts to robinhood.rpc.blxrbdn.com from later runners"],
  // card evm-quote-fewer-rounds: a held provider after every one not held, quoteLast too; half open after its hold
  // until it answers; held by the pace's own hold as by the ranking's
  [QUOTE, '  if (till > now) return 20 + last;', '  if (till > now) return 2 + last;', "test/evm-pair-rank.test.ts", "R6 "],
  [QUOTE, '  if (till > 0 && (s?.last ?? 0) < till) return (s?.out.some((t) => t >= till) ? 10 : 2) + last;', '  if (false && till > 0 && (s?.last ?? 0) < till) return (s?.out.some((t) => t >= till) ? 10 : 2) + last;', "test/evm-pair-rank.test.ts", "R7 "],
  // the half-open provider is probed: seated once before quoteLast, never left last with the rest healthy (review of A+B, 3)
  [QUOTE, '  if (till > 0 && (s?.last ?? 0) < till) return (s?.out.some((t) => t >= till) ? 10 : 2) + last;', '  if (till > 0 && (s?.last ?? 0) < till) return 10 + last;', "test/evm-pair-rank.test.ts", "R7 "],
  [QUOTE, '  if (till > 0 && (s?.last ?? 0) < till) return (s?.out.some((t) => t >= till) ? 10 : 2) + last;', '  if (till > 0 && (s?.last ?? 0) < till) return 2 + last;', "test/evm-pair-rank.test.ts", "R7 "],
  [QUOTE, "        if (probe && open && ms > (evmHedgeAfter(url, kind) ?? EVM_HEDGE_MS)) s.held = performance.now() + EVM_HOLD_MS;", "", "test/evm-pair-rank.test.ts", "R9 "],
  [QUOTE, "        if (probe && open && ms > (evmHedgeAfter(url, kind) ?? EVM_HEDGE_MS))", "        if (probe && ms > (evmHedgeAfter(url, kind) ?? EVM_HEDGE_MS))", "test/evm-pair-rank.test.ts", "R9b "],
  // every hook-replaced read a warm quote sends is pinned to its own block (review of 7c0291eb2, LOW)
  [QUOTE, "  const heldReading = heldFirst.length === 0 ? Promise.resolve(null) : readBoth(rpcs, block.hash, heldFirst, v.reads, undefined, firstDown).catch(() => null);", "  const heldReading = heldFirst.length === 0 ? Promise.resolve(null) : (readBoth(rpcs, block.parentHash, heldFirst, v.reads, undefined, firstDown).catch(() => null), readBoth(rpcs, block.hash, heldFirst, v.reads, undefined, firstDown).catch(() => null));", R, "W6c "],
  [QUOTE, "    const probe = till > 0 && till <= t && s.last < till;", "    const probe = false;", "test/evm-pair-rank.test.ts", "R9 "],
  [QUOTE, 'undefined): number => Math.max(s?.held ?? 0, evmProviderHeldMs(u, 0));', 'undefined): number => s?.held ?? 0;', "test/evm-pair-rank.test.ts", "R6 "],
  // card evm-quote-fewer-rounds, S1 as the rule it holds: a speculative read's answer is used only for a pool held at the
  // quote's block (W6), only by the very same read (W6e), only from the quote's own block (W6c), and a hook that is an
  // address the reads call is still dropped (W6d)
  [QUOTE, "  const held = found.filter(holds);", "  const held = found;", R, "W6 "],
  [QUOTE, "const readKey = (r: Read) => JSON.stringify([r.to, r.data, r.override ?? null, r.group ?? null,", "const readKey = (r: Read) => JSON.stringify([r.to, r.data, null, null,", R, "W6e "],
  [QUOTE, "readBoth(rpcs, block.hash, heldFirst, v.reads, undefined, firstDown)", "readBoth(rpcs, block.parentHash, heldFirst, v.reads, undefined, firstDown)", R, "W6c "],
  [QUOTE, "const droppable = (k: EvmPoolKey) => k.hooks !== NATIVE && (v.called.has(k.hooks) ||", "const droppable = (k: EvmPoolKey) => k.hooks !== NATIVE && (false ||", R, "W6d "],
  // card evm-quote-no-30s-head-wait: a request handed to the chain's last scan provider waits EVM_SCAN_LAST_MS at most
  // (L1), its throttle stops the scan (L2), and only the last with providers before it is so bound (L1, L2)
  [QUOTE, "    if (handOff && hedge === undefined) return sendLast(", "    if (false && hedge === undefined) return sendLast(", "test/evm-scan-last-provider.test.ts", "L1 "],
  // card rh-scan-last-provider-case: the last provider's bound runs from the post leaving the device, past the kit's own
  // pace wait (L3: from the ask, the warm tap ends rpc_error at 4 s as on main), and all a scan hands it ends by
  // EVM_SCAN_LAST_WHOLE_MS (L4: without it the warm tap grinds on to 33.4 s)
  [QUOTE, "      return await Promise.race([rpc(calls, stop.signal, sent), bound]);", "      sent();\n      return await Promise.race([rpc(calls, stop.signal), bound]);", "test/evm-scan-last-provider.test.ts", "L3 "],
  [QUOTE, "    const carry = handedAt + EVM_SCAN_LAST_WHOLE_MS - now;", "    const carry = Infinity;", "test/evm-scan-last-provider.test.ts", "L4 "],
  [QUOTE, '        if (handOff) throw new ScanStop("rpc_error", "the last scan provider limited its rate");\n', "", "test/evm-scan-last-provider.test.ts", "L2 "],
  [QUOTE, "next === undefined ? 0 : next.span * next.parallel, next === undefined && i > 0)", "next === undefined ? 0 : next.span * next.parallel, false)", "test/evm-scan-last-provider.test.ts", "L1 "],
];
// every mutant's name, in the order the parts take them
export const NAMES = MUTANTS.map(([, find, , , t]) => `${find.split("\n")[0].slice(0, 70)} -> "${t}"`);

const esc = (n) => `^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
// each test run's own environment: without the node --test runner's NODE_TEST_CONTEXT, which turns a child's report
// from TAP into the runner's own stream (the runner's test calls these judges from inside node --test)
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
// The longest one test run takes before it is killed and counts as failed: a mutant that leaves a wait with no end
// (the scan gate's bound removed, a Retry-After of 120 s asked again for ever) never holds up the sweep; the run's whole
// process group is killed with it (scripts/group-run.mjs), so node --test's per-file child never lives on
const RUN_MS = 60_000;
// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`
let lastFail = "";
async function run(dir, file, name) {
  const r = await runGroup("node", ["--test", "--test-reporter=tap", "--test-name-pattern", esc(name), file], { cwd: dir, env: ENV, maxBuffer: 1 << 26, timeoutMs: RUN_MS });
  if (r.status !== 0) {
    lastFail = (r.timedOut ? `killed after ${RUN_MS} ms\n` : "") + `${r.stdout}${r.stderr}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 8).join("\n");
    return "fail";
  }
  // a test of that name passed: a file that runs no test still reports itself as one that passed
  const ran = [...r.stdout.matchAll(/^\s*ok \d+ - (.*?)(?: # .*)?$/gm)].some((m) => m[1].replace(/\\#/g, "#").replace(/\\\\/g, "\\").startsWith(name));
  return ran ? "pass" : "none";
}
/** Each named test's "pass", "fail" or "none" on the code as it is, judged as the kill phase judges a mutant: each name
 *  alone, by its run's exit code (`run`), as many at once as there are copies `dirs` (re-review of 037627c, LOW-1: one
 *  run per file read from its TAP lines passed a test that passed and then threw from a timer, which alone exits 1).
 *  `byFile` maps a test file to its names. */
export async function baseline(dirs, byFile) {
  const jobs = [...byFile].flatMap(([file, names]) => names.map((name) => ({ file, name })));
  const out = [];
  let next = 0;
  await Promise.all(dirs.map(async (dir) => {
    for (let i = next++; i < jobs.length; i = next++) {
      const r = await run(dir, jobs[i].file, jobs[i].name);
      // why a run failed, read before another run ends: a clean-code failure in CI printed only its name
      out[i] = { ...jobs[i], r, why: r === "fail" ? lastFail : "" };
    }
  }));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const part = sweepPartOrExit(process.argv.slice(2), NAMES);
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
    const src = new Map([QUOTE, BUY, BUYU, SELLQ, SELLU, QD, PF, SR].map((f) => [f, readFileSync(join(dirs[0], f), "utf8")]));
    const byFile = new Map();
    for (const m of part.at.map((i) => MUTANTS[i])) byFile.set(m[3], [...new Set([...(byFile.get(m[3]) ?? []), m[4]])]);
    const tb = performance.now();
    for (const { file, name: n, r, why } of await baseline(dirs, byFile)) {
      if (r !== "pass") {
        console.log(`FAIL "${n}" in ${file} ${r === "none" ? "names no test" : "fails on the code as it is"}${why ? `:\n${why}` : ""}`);
        bad++;
      }
    }
    console.log(`the ${[...byFile.values()].flat().length} named tests on the code as it is: ${s(tb)}`);
    if (bad === 0) {
      let next = 0;
      const worker = async (dir) => {
        for (let j = next++; j < part.at.length; j = next++) {
          const i = part.at[j];
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
      console.log(`${part.at.length} mutants, ${JOBS} at once: ${s(tm)}`);
    }
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${part.at.length} mutants fails its named test (${s(t0)})` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
