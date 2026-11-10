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
  "apps/helper/src/ready.test.ts": { count: 1, why: "to convert" },
  "packages/kit/test/evm-quote-attacks.test.ts": { count: 21, why: "to convert" },
  "packages/kit/test/evm-sell-quote.test.ts": { count: 5, why: "to convert" },
  "packages/kit/test/prove-e2e.test.ts": { count: 1, why: "to convert" },
  "packages/kit/test/signpage-client.test.mjs": { count: 3, why: "to convert" },
  "packages/kit/test/solana-answer-caps.test.ts": { count: 2, why: "to convert" },
  "packages/kit/test/solana-send.test.ts": { count: 2, why: "to convert" },
  "packages/kit/test/test-clock.test.ts": { count: 4, why: "it tests the test clock against the real one" },
  "packages/kit/test/vault-settle.test.ts": { count: 1, why: "to convert" },
  "packages/kit/test/vault-sync.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/api.test.ts": { count: 2, why: "to convert" },
  "packages/signpage/test/deposit-dry.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/pool-deposit-evm.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/pool-deposit.test.ts": { count: 1, why: "to convert" },
  "packages/signpage/test/pool-restore.test.ts": { count: 2, why: "to convert" },
  "packages/wallet/test/arm-ladder.test.ts": { count: 1, why: "to convert" },
  "packages/wallet/test/buy-wallets.test.ts": { count: 2, why: "to convert" },
  "packages/wallet/test/deposit-bind.test.ts": { count: 2, why: "to convert" },
  "packages/wallet/test/deposit-moveout.test.ts": { count: 1, why: "to convert" },
  "packages/wallet/test/pace.test.ts": { count: 2, why: "to convert" },
  "packages/wallet/test/pool-solana.test.ts": { count: 1, why: "to convert" },
  "packages/wallet/test/restore-id-reader.test.ts": { count: 1, why: "to convert" },
  "scripts/ci/near-rpc-operators.test.mjs": { count: 1, why: "to convert" },
  "scripts/ci/quote-speed.test.mjs": { count: 1, why: "to convert (card quote-speed-preflight-busy)" },
  "scripts/ci/readme-fresh-run.test.mjs": { count: 1, why: "to convert" },
};

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

/** Every tracked unit test in SCOPE with what it reads. */
export function scan(root = ROOT) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE.map((g) => `:(glob)${g}`)], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => UNIT_TEST.test(f));
  const out = {};
  for (const f of files) {
    const found = findings(readFileSync(path.join(root, f), "utf8"));
    if (found.length > 0) out[f] = found;
  }
  return out;
}

/** What the rule refuses: a file outside LISTED that reads one, or a file reading more than LISTED lists for it. */
export function refusals(found, before = LISTED) {
  const out = [];
  for (const [f, list] of Object.entries(found)) {
    const allowed = before[f]?.count ?? 0;
    if (list.length > allowed) out.push(`${f}: ${list.length} real elapsed time${list.length === 1 ? "" : "s"} (${allowed} listed): ${list.map((x) => `line ${x.line}`).join(", ")}`);
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
  const bad = refusals(found);
  if (bad.length > 0) {
    console.error(`\n${bad.join("\n")}\n\nAssert what the time stood for: work counted, waits asked of an injected sleep, an injected clock, t.mock.timers, or the test's own { timeout }.`);
    process.exit(1);
  }
}
