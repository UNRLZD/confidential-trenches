// No unit test judges the machine's real elapsed time. A test that holds `performance.now() - t0 < 2_000` fails
// whenever a shared CI runner is slow, not when the code is (main ff43356d, run 42718247693: 2,025 ms against 2,000 on a
// runner shared with five other runs), and each such red holds every merge behind a rerun.
//
// A unit test asserts what the time stood for instead:
//   - work counted: calls to a stub, derivations, reads ("nothing derived again" counts derivations);
//   - waits asked of an injected sleep, or time on an injected clock (`clock`/`sleep` options that default to the real
//     ones, as jitoSender's);
//   - node:test's mock timers (`t.mock.timers`) where the code under test calls setTimeout itself;
//   - a hang bound as the test's own `{ timeout }`, which the runner enforces;
//   - what the code reports it was given (a fault naming the limit its try ran under).
// A speed budget lives in the perf runs (perf/runs) and the live checks, never in a unit test.
//
// What it refuses, in a unit test file (*.test.*) of SCOPE: any real elapsed time, i.e. `performance.now()` or
// `Date.now()` less something other than a number or an UPPER_CASE constant (that is a timestamp, not a duration), or
// a difference of two variables read from the real clock. Two places may still read one: the condition of a `while` or
// `for` that polls for something to happen (it ends on that, the time only caps it), and the arguments of a console
// call. Strings and comments are left out, so a message may print one.
//
// And a second form of the same fault, which reads no clock in the test's text (card ci-fresh-run-ends-with-room): a test that
// runs the kit's EVM pool-buy quote on its default monotonic clock (`evmPoolBuyQuoteWith(...)` with no sixth argument, the
// `mono`), outside `onTestClock(...)`, hands the quote's 30 s age rule and 60 s scan bound the machine's speed. KB1, KB3 and
// KB4 (a quote over 65,000 made-up pools) refused stale_quote at 37 to 47 s when the packages' tests ran side by side, and
// the rule above could not see it: the clock is read inside the code under test. A call passes `mono` (a fixed clock when
// the test is pure work: quoteOnStill) or runs on the test clock; QUOTE_LISTED counts the calls still to convert, never a place for a new one.
//
// And a third (card helper-share-tests-on-a-still-clock): a helper unit test that builds a caller's share or a provider's
// budget on its default clock (apps/helper/src/limits/limits.ts clientWindow and upstreamBudget default to Date.now,
// providerHolds and rpc.ts createRpc to the performance clock) hands its counts, 429s and holds to the machine's speed: a
// window that turns inside the test's loop clears the share its 429s assert (PR 979's merge queue run 44243609488,
// logs-cache.test.ts: 32 answers of 200 where the last two were 429). A call passes a clock: createRpc's deps name `now`
// (or spread a test's `...testClock()`, its now, pacer and sleep on one clock),
// clientWindow and upstreamBudget take it second, providerHolds first; or it runs inside onVirtualTime(...) or
// onTestClock(...), where the clock is the test's. SHARE_LISTED counts the calls still to convert, each with its reason.
//   node scripts/ci/no-wall-clock-asserts.mjs    lists what it refuses in the tracked unit tests, exit 1 on any
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// the folders whose unit tests this rule covers
export const SCOPE = ["packages/*/test/**", "packages/*/src/**", "apps/helper/src/**", "apps/terminal/src/**", "apps/terminal/test/**", "scripts/ci/**"];
const UNIT_TEST = /\.test\.[cm]?[jt]sx?$/;

// The files that may still read such a difference, with how many and why: a Date.now() that the test mocks (the rule
// cannot tell it from the real one), a sanity bound that names the regression it still catches, or a test written before
// this rule and still to convert. A file may read no more than its count; a count above what a file reads is only
// noted, so two changes that each convert some merge in either order. Never a place to add a new one.
export const LISTED = {
  "apps/helper/src/data/evm/swaps-capacity.test.ts": { count: 1, why: "Date.now is mocked here (onVirtualTime)" },
  "apps/helper/src/data/evm/swaps-lanes.test.ts": { count: 1, why: "Date.now is mocked here (onVirtualTime)" },
  "apps/helper/src/data/evm/swaps-pace.test.ts": { count: 1, why: "Date and performance.now are mocked here (onVirtualTime)" },
  "apps/helper/src/data/evm/swaps-search.test.ts": { count: 1, why: "Date.now is mocked here (onVirtualTime)" },
  "apps/helper/src/data/evm/swaps-v4key.test.ts": { count: 2, why: "a stall bound of 1 s, about 50 times the 15-19 ms measured: it catches v4Key's search run in one go (3.1 s and 4.0 s at 6509fd7)" },
  "apps/helper/src/data/solana/page-chain.test.ts": { count: 1, why: "Date.now is mocked here (enableTimers with Date)" },
  "apps/helper/src/data/solana/page-filling.test.ts": { count: 1, why: "Date.now is mocked here (enableTimers with Date)" },
  "apps/helper/src/data/solana/search.test.ts": { count: 2, why: "Date.now is mocked here (enableTimers with Date)" },
  "apps/helper/src/pool/solana-attacks.test.ts": { count: 2, why: "one paces a driver loop on real time (the assert counts refusals); the other runs on a mocked Date" },
  "apps/helper/src/ready.test.ts": { count: 1, why: "an event-loop stall bound: the peer's lock tries run on SQLite's busy timeout, which blocks the thread itself, so only the real gaps between a 10 ms interval's ticks show a stall (50 ms each, 5 times the interval); no clock in the test moves it" },
  "packages/kit/test/evm-quote-attacks.test.ts": { count: 20, why: "performance.now is the test clock here: each runs in onTestClock (SP2H, V1, V2, V3, V8, V14, TH4, TH5, TH8, B1a, B2a, RQ1, SL2, SL6, the -32602 first, QE3 by sixACall), so a time under a wait's length proves it was not waited" },
  "packages/kit/test/evm-hedge-clock.test.ts": { count: 1, why: "performance.now is the test clock here (W3 runs in onTestClock: the stand-in's hang is its 10 s timeout on the clock, card evm-warm-tap-ends-inside-two-seconds)" },
  "packages/kit/test/evm-hung-post.test.ts": { count: 1, why: "performance.now is the test clock here (H1, H3, H4, H5 run in onTestClock: each hung post's 10 s timeout and the hedge's 400 ms are the clock's, card evm-warm-tap-ends-inside-two-seconds)" },
  "packages/kit/test/evm-quote-follow-hung.test.ts": { count: 1, why: "performance.now is the test clock here (H2 runs in onTestClock: the hung post's 10 s timeout and the hedge's 400 ms are the clock's, card evm-warm-tap-ends-inside-two-seconds)" },
  "packages/kit/test/evm-sell-quote.test.ts": { count: 5, why: "performance.now and Date.now are the test clock here (the three release-in-flight tests run in onTestClock: the honest heads move a block per 250 ms or 1.5 s of it, and a time at least the confirm wait proves it was waited)" },
  "packages/kit/test/prove-e2e.test.ts": { count: 1, why: "a report, never an assert: the node prover's proveMs is printed in a diagnostic line only" },
  "packages/kit/test/near-rhea.test.ts": { count: 1, why: "performance.now is the test clock here (Q8 runs in onTestClock: its fake chain's tip moves with the provider's turn the clock skips, so a turn reads as the very blocks it took)" },
  "packages/kit/test/solana-send.test.ts": { count: 2, why: "Date.now is mocked here (enableTimers with Date)" },
  "packages/kit/test/test-clock.test.ts": { count: 10, why: "it tests the test clock against the real one, and that real work moves it by 0 ms (card test-clock-runs-on-virtual-time)" },
  "packages/kit/test/vault-settle.test.ts": { count: 1, why: "Date.now is the test clock here (the in-flight spend runs in onTestClock, so the 60 s wait, if waited, reads its full length)" },
  "packages/kit/test/vault-sync.test.ts": { count: 1, why: "Date.now is the test clock here (the busy read runs in onTestClock, so it reads the waits set)" },
  "packages/signpage/test/near-seat-down.test.ts": { count: 4, why: "performance.now is the test clock here (every test runs in onTestClock: the fake chain moves a block every 600 ms of it, and a time under a wait's length proves it was not waited)" },
  "packages/signpage/test/near-seat-two-devices.test.ts": { count: 1, why: "performance.now is the test clock here (the two devices run in onTestClock: the fake chain moves a block every 600 ms of it)" },
  "packages/signpage/test/passes-yield.test.ts": { count: 4, why: "performance.now is the test clock here (onProvider runs each of these tests in onTestClock); A, A2 and D, on the real clock, read none" },
  "packages/signpage/test/pool-sell.test.ts": { count: 1, why: "performance.now is the test clock here (planOver runs the sale's plan in onTestClock, which jumps over every wait at the finder's real pace, so a time under one window proves no finder round was waited)" },
  "packages/signpage/test/page-rpc.test.ts": { count: 5, why: "performance.now is the test clock here (onSeat and the parked-reads stall test run in onTestClock, which jumps over every wait, so a time under a wait's length proves it was not waited; the fifth, card move-sends-or-says-why's seat past publicnode and Pocket, runs in onSeat too)" },
  "packages/signpage/test/trade.test.ts": { count: 1, why: "performance.now is the test clock here (the reference-down tests run in onTestClock): the time to down, measured" },
  "packages/signpage/test/pool-deposit.test.ts": { count: 1, why: "Date.now is the test clock here (the sign-out end runs in onTestClock, so the 2 s wait, if not cut, reads its full length)" },
  "packages/signpage/test/pool-deposit-evm.test.ts": { count: 1, why: "Date.now is the test clock here (the sign-out end runs in onTestClock, so the 10 s wait, if not cut, reads its full length)" },
  "packages/signpage/test/pool-restore.test.ts": { count: 2, why: "performance.now is the test clock here (the measured step 5 and the sign-out test run in onTestClock: a run's time is the waits it set, and the busy wait's 50 s, if not cut, reads its full length)" },
  "packages/wallet/test/buy-wallets.test.ts": { count: 2, why: "Date.now is the test clock here (the moving-slot and the 429 Retry-After tests run in onTestClock)" },
  "packages/wallet/test/deposit-bind.test.ts": { count: 2, why: "performance.now and Date.now are the test clock here (both stops run in onTestClock, so a wait not cut by the stop reads its full length)" },
  "packages/wallet/test/pace.test.ts": { count: 6, why: "performance.now is the test clock here (the five chains, the busy, the reserve and the seat tests run in onTestClock, so a time at least a gap proves it was waited and one under a gap that it was not); the deadline test's bound, on the real clock, is still to convert" },
  "packages/wallet/test/restore-id-reader.test.ts": { count: 1, why: "performance.now is the test clock here (the transport's ninth request runs in onTestClock, so its 2.6 s gap, if waited, reads its full length)" },
  "scripts/ci/near-rpc-operators.test.mjs": { count: 1, why: "to convert" },
  "scripts/ci/quote-speed.test.mjs": { count: 1, why: "to convert (card quote-speed-preflight-busy)" },
  "scripts/ci/readme-fresh-run.test.mjs": { count: 1, why: "to convert" },
};

// Calls of evmPoolBuyQuoteWith on the real monotonic clock, per file (the count of calls still to convert). A file may make
// no more than its count; a new call passes `mono` or runs inside onTestClock.
export const QUOTE_LISTED = {
  "packages/kit/test/evm-quote-attacks.test.ts": { count: 143, why: "to convert" },
  "packages/signpage/test/pool-buy-evm-kind.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/pool-buy-evm.test.ts": { count: 2, why: "to convert" },
  "packages/signpage/test/rules-pool-attacks.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/rules-pool.test.ts": { count: 1, why: "to convert" },
};
const QUOTE_CALL = /\b(evmPoolBuyQuoteWith|quoteOn)\(/g; // quoteOn: the attack tests' helper that calls it on the real clock (quoteOnStill does not)

/** The index just past the bracket that closes the one opened at `open`, and how many commas sit at its top level. */
function closeOf(src, open) {
  let depth = 0;
  let commas = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return { end: i + 1, commas };
    } else if (c === "," && depth === 1) commas++;
  }
  return { end: src.length, commas };
}

/** Every call of evmPoolBuyQuoteWith with fewer than six arguments (or of the attack tests' quoteOn), outside an onTestClock( ... ) call: [{ line, text }]. */
export function quoteFindings(text) {
  const src = code(text);
  const clocks = [...src.matchAll(/\bonTestClock\(/g)].map((m) => [m.index, closeOf(src, m.index + m[0].length - 1).end]);
  const out = [];
  for (const m of src.matchAll(QUOTE_CALL)) {
    if (m[1] === "evmPoolBuyQuoteWith" && closeOf(src, m.index + m[0].length - 1).commas + 1 >= 6) continue; // `mono` passed
    if (clocks.some(([a, b]) => m.index > a && m.index < b)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, text: text.split("\n")[line - 1].trim().slice(0, 160) });
  }
  return out;
}

// Calls that build a share, a budget or the holds on the helper's default clock, per file (the count still to convert, and
// why). A file may make no more than its count; a new call passes a clock.
export const SHARE_LISTED = {};
const SHARE_CALL = /(?<![\w$.])(createRpc|clientWindow|upstreamBudget|providerHolds)\(/g;

/** True when createRpc's deps are a name (`deps`, `w.deps`) and the file's one object assigned to `deps` names `now`. */
function depsClocked(src, args) {
  if (!/,\s*(?:[A-Za-z_$][\w$]*\.)?deps\s*$/.test(args)) return false;
  const objs = [...src.matchAll(/\bdeps\s*=\s*\{/g)].map((d) => src.slice(d.index, closeOf(src, d.index + d[0].length - 1).end));
  return objs.length > 0 && objs.every((o) => /(?<![\w$.])now\s*[:(,]/.test(o));
}

/** Every helper share, budget or holds built on its default clock outside onVirtualTime(...) or onTestClock(...): a
 *  createRpc whose deps name no `now`, a clientWindow or upstreamBudget with no second argument, a providerHolds with
 *  none: [{ line, text }]. */
export function shareFindings(text) {
  const src = code(text);
  const clocks = [...src.matchAll(/\b(?:onVirtualTime|onTestClock)\(/g)].map((m) => [m.index, closeOf(src, m.index + m[0].length - 1).end]);
  const out = [];
  for (const m of src.matchAll(SHARE_CALL)) {
    if (/\bfunction\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // a declaration
    const open = m.index + m[0].length - 1;
    const { end, commas } = closeOf(src, open);
    const args = src.slice(open + 1, end - 1);
    const n = args.trim() === "" ? 0 : commas + 1;
    const clocked = m[1] === "createRpc" ? n >= 2 && (/(?<![\w$.])now(?![\w$])/.test(args) || /\.\.\.\s*testClock\(\)/.test(args) || depsClocked(src, args)) : m[1] === "providerHolds" ? n >= 1 : n >= 2;
    if (clocked || clocks.some(([a, b]) => m.index > a && m.index < b)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, text: text.split("\n")[line - 1].trim().slice(0, 160) });
  }
  return out;
}

const CLOCK = String.raw`(?:performance|Date)\.now\(\)`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;

/** The text with every string, template and comment blanked to spaces (lines kept), so a message never counts. */
export function code(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const [c, n] = [text[i], text[i + 1]];
    let end = i + 1;
    if (c === "/" && (n === "/" || n === "*")) {
      const j = n === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      end = j === -1 ? text.length : n === "/" ? j : j + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      end = Math.min(j + 1, text.length);
    } else {
      out += c;
      i++;
      continue;
    }
    out += text.slice(i, end).replace(/[^\n]/g, " ");
    i = end;
  }
  return out;
}

/** True when `at` sits in a while/for header or a console call, reached before any enclosing `{` or `[`. */
function polledOrPrinted(src, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (c !== "(") return false;
      if (/(?:\bwhile|\bfor|\bconsole\.\w+)\s*$/.test(src.slice(Math.max(0, i - 40), i))) return true;
    }
  }
  return false;
}

/** Every real elapsed time a unit test's text reads outside a poll's condition or a console call: [{ line, text }]. */
export function findings(text) {
  const src = code(text);
  const clocks = new Set([...src.matchAll(new RegExp(String.raw`(${NAME})\s*(?:\?\?)?=\s*${CLOCK}(?!\s*[-+*/])`, "g"))].map((m) => m[1]));
  const vars = [...clocks].map((c) => c.replace(/\$/g, "\\$")).join("|");
  const not = String.raw`(?!\s*(?:[\d(]|[A-Z][A-Z0-9_]*(?![\w$.(\[])))`; // less a number or a constant: a timestamp
  const re = new RegExp(String.raw`${CLOCK}\s*-${not}` + (vars ? String.raw`|(?<![\w$.])(?:${vars})\s*-\s*(?:${vars})(?![\w$])` : ""), "g");
  const out = [];
  for (const m of src.matchAll(re)) {
    if (polledOrPrinted(src, m.index)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, text: text.split("\n")[line - 1].trim().slice(0, 160) });
  }
  return out;
}

/** Every tracked unit test in SCOPE with what it reads (`quote`: [{ line, text }] per file, its quote calls on the real clock). */
export function scan(root = ROOT, finder = findings) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE.map((g) => `:(glob)${g}`)], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => UNIT_TEST.test(f));
  const out = {};
  for (const f of files) {
    const found = finder(readFileSync(path.join(root, f), "utf8"));
    if (found.length > 0) out[f] = found;
  }
  return out;
}

/** What the rule refuses: a file outside LISTED that reads one, or a file reading more than LISTED lists for it. */
export function refusals(found, before = LISTED, what = "real elapsed time") {
  const out = [];
  for (const [f, list] of Object.entries(found)) {
    const allowed = before[f]?.count ?? 0;
    if (list.length > allowed) out.push(`${f}: ${list.length} ${what}${list.length === 1 ? "" : "s"} (${allowed} listed): ${list.map((x) => `line ${x.line}`).join(", ")}`);
  }
  return out;
}

/** LISTED's counts above what their files read now: each can be lowered, or its entry removed at zero. */
export function stale(found, before = LISTED) {
  return Object.entries(before).flatMap(([f, { count }]) => ((found[f]?.length ?? 0) < count ? [`${f}: ${found[f]?.length ?? 0} of ${count}`] : []));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan();
  for (const [f, list] of Object.entries(found)) for (const x of list) console.log(`${f}:${x.line}  ${x.text}`);
  for (const x of stale(found)) console.log(`LISTED can be lowered: ${x}`);
  const quote = scan(ROOT, quoteFindings);
  for (const [f, list] of Object.entries(quote)) for (const x of list) console.log(`${f}:${x.line}  (quote on the real clock) ${x.text}`);
  const share = scan(ROOT, shareFindings);
  for (const [f, list] of Object.entries(share)) for (const x of list) console.log(`${f}:${x.line}  (a share on the default clock) ${x.text}`);
  const bad = [...refusals(found), ...refusals(quote, QUOTE_LISTED, "quote on the real monotonic clock"), ...refusals(share, SHARE_LISTED, "share on the default clock")];
  if (bad.length > 0) {
    console.error(`\n${bad.join("\n")}\n\nAssert what the time stood for: work counted, waits asked of an injected sleep, an injected clock, t.mock.timers, or the test's own { timeout }; build a helper share or budget on a still or test clock.`);
    process.exit(1);
  }
}
