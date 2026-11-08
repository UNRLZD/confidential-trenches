// The quote-speed gate (scripts/ci/quote-speed.mjs) refuses its planted cases: a slowed quote and a skipped run, each on
// both tries; it passes the recorded good run, and a refused try then a good one (the one rerun); it skips a change
// that touches no file of the quote; every file the quote imports is under its PATHS; ci.yml runs it as main has it,
// in the required deep-import job, with nothing that lets the step pass on a failure. No network: every try is replayed
// from evm-quote-warm-round.answers.json through the check's own check().
//   node --test scripts/ci/quote-speed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "../live-checks/evm-quote-warm-round.mjs";
import { CHECK, PATHS, TRIES, gate, judgeTry, watched } from "./quote-speed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const A = JSON.parse(readFileSync(path.join(ROOT, "scripts/live-checks/evm-quote-warm-round.answers.json"), "utf8"));
const QUOTE = ["packages/kit/src/checks/evm/quote.ts"];

/** The recorded good run with `ms` added to every quote after the cold one: a 600 ms read lands on each warm quote. */
function slowed(ms) {
  const run = structuredClone(A.good);
  for (const c of Object.values(run.cases)) for (const q of c.quotes.slice(1)) q.ms += ms;
  return run;
}

/** The gate on `tries` (each a { status, record }), with its log and the tries it ran. */
async function play(tries, opts = {}) {
  const log = [];
  let ran = 0;
  const code = await gate({ files: QUOTE, ...opts, check, log: (l) => log.push(l), runTry: async () => tries[ran++] });
  return { code, ran, log: log.join("\n") };
}

test("the recorded good run passes on its first try", async () => {
  const r = await play([{ status: 0, record: A.good }]);
  assert.equal(r.code, 0, r.log);
  assert.equal(r.ran, 1);
  assert.match(r.log, /quote-speed: PASS \(try 1 of 2\)/);
});

test("planted: a slowed quote (600 ms on each warm quote) is refused on both tries", async () => {
  const run = slowed(600);
  const r = await play([{ status: 1, record: run }, { status: 1, record: run }]);
  assert.equal(r.code, 1, r.log);
  assert.equal(r.ran, TRIES);
  assert.match(r.log, /FAIL base-hook: warm p50 \d+ ms, p95 \d+ ms over 20 \(under 1000 ms\)/);
  assert.match(r.log, /quote-speed: FAIL/);
});

test("planted: the slowed quote is refused on the check's own verdict even when the run exits 0", async () => {
  const r = await play([{ status: 0, record: slowed(600) }, { status: 0, record: slowed(600) }]);
  assert.equal(r.code, 1, r.log);
});

test("planted: a skipped run (exit 0, no record) is refused on both tries", async () => {
  const r = await play([{ status: 0, record: null }, { status: 0, record: null }]);
  assert.equal(r.code, 1, r.log);
  assert.equal(r.ran, TRIES);
  assert.match(r.log, /FAIL no record: the run exited 0 and wrote none/);
});

test("a run that exits non-zero is refused though its record passes", async () => {
  const r = await play([{ status: 2, record: A.good }, { status: 2, record: A.good }]);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /FAIL the run exited 2/);
});

test("the one rerun: a refused try then a good one passes; a third try is never run", async () => {
  const once = await play([{ status: 1, record: slowed(600) }, { status: 0, record: A.good }]);
  assert.equal(once.code, 0, once.log);
  assert.equal(once.ran, 2);
  assert.match(once.log, /try 1 of 2 refused; once more/);
  const never = await play([{ status: 0, record: null }, { status: 0, record: null }, { status: 0, record: A.good }]);
  assert.equal(never.code, 1, never.log);
  assert.equal(never.ran, 2);
});

test("a slowed run just under the KPI passes and just over is refused (the gate adds no margin of its own)", () => {
  // the good run's warm p95s are 618 and 784 ms: base-partial-v4 crosses 1000 at +216
  assert.equal(judgeTry({ status: 0, record: slowed(200) }, check).ok, true);
  assert.equal(judgeTry({ status: 0, record: slowed(250) }, check).ok, false);
});

test("a change that touches no file of the quote is a skip; one under either path, or --all, is measured", async () => {
  const skip = await play([], { files: ["packages/kit/src/trade/solana/flow.ts", "apps/terminal/src/x.ts", "packages/kit/src/checks/evmish.ts"] });
  assert.equal(skip.code, 0);
  assert.equal(skip.ran, 0);
  assert.match(skip.log, /quote-speed: PASS \(skip: none of 3 changed file\(s\)/);
  assert.deepEqual(watched(["packages/kit/src/trade/evm/buy.ts", "packages/kit/src/checks/evm/quote.ts", "packages/kit/src/index.ts"]), ["packages/kit/src/trade/evm/buy.ts", "packages/kit/src/checks/evm/quote.ts"]);
  const all = await play([{ status: 0, record: null }, { status: 0, record: null }], { files: [], all: true });
  assert.equal(all.code, 1);
  assert.equal(all.ran, 2);
});

// the relative imports of a file, resolved (export ... from counts, `import type` too: a moved type file is a moved file)
function closure(start) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith(".")) walk(path.resolve(path.dirname(f), m[1]));
    }
  };
  walk(path.join(ROOT, start));
  return [...seen].map((f) => path.relative(ROOT, f));
}

test("every file the quote imports is under PATHS, and the kit's entry exports the quote from there", () => {
  const index = readFileSync(path.join(ROOT, "packages/kit/src/index.ts"), "utf8");
  const from = /\bevmPoolBuyQuote,[\s\S]*?\}\s*from\s+"\.\/([^"]+)"/.exec(index)?.[1];
  assert.ok(from, "index.ts exports evmPoolBuyQuote by name");
  const src = `packages/kit/src/${from}`;
  assert.deepEqual(watched([src]), [src], `${src} is under PATHS`);
  const files = closure(src);
  assert.ok(files.includes("packages/kit/src/trade/evm/buy-unpinned.ts"), files.join("\n"));
  assert.deepEqual(files.filter((f) => watched([f]).length === 0), [], "a file the quote imports outside PATHS");
  // planted: a quote that reads through a helper outside PATHS is caught
  assert.deepEqual(watched(["packages/kit/src/freeze.ts"]), []);
});

// the lines of one job of ci.yml, from its id to the next job
function job(yml, id) {
  const lines = yml.split("\n");
  const at = lines.findIndex((l) => l === `  ${id}:`);
  assert.ok(at >= 0, `ci.yml has job ${id}`);
  const end = lines.findIndex((l, i) => i > at && /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l));
  return lines.slice(at, end < 0 ? undefined : end);
}

test("ci.yml runs the gate as main has it in the required deep-import job, every event, nothing letting it pass on a failure", () => {
  const yml = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(yml, /required checks of main's ruleset: gitleaks, deep-import, verify-gate, money-gate, test\./);
  const lines = job(yml, "deep-import");
  const text = lines.join("\n");
  const start = lines.findIndex((l) => /^ {6}- name: .*evm-quote-warm-round/.test(l));
  assert.ok(start >= 0, text);
  const next = lines.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  const step = lines.slice(start, next < 0 ? undefined : next).join("\n");
  assert.doesNotMatch(step, /^\s+(if|continue-on-error):/m, step);
  assert.doesNotMatch(text, /^\s+continue-on-error:/m);
  assert.match(text, /^ {4}if: github\.event_name != 'schedule'$/m);
  assert.match(text, /^ {10}fetch-depth: 0$/m, "the base and the change are in the checkout");
  assert.match(text, /^ {6}- run: pnpm install --frozen-lockfile$/m);
  assert.ok(lines.findIndex((l) => /pnpm install --frozen-lockfile/.test(l)) < start, "the install comes before the step");
  // pull_request: the base's scripts/ tree, its gate on the head's change
  assert.match(step, /git archive "\$PR_BASE" scripts \| tar -x -f - -C "\$RUNNER_TEMP\/base"/);
  assert.match(step, /node "\$RUNNER_TEMP\/base\/scripts\/ci\/quote-speed\.mjs" "\$PR_BASE" "\$PR_HEAD"/);
  assert.match(step, /PR_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(step, /PR_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  // the head's own copy only while main has none
  assert.match(step, /\[ -e "\$RUNNER_TEMP\/base\/scripts\/ci\/quote-speed\.mjs" \] \|\| \{[^}]*node scripts\/ci\/quote-speed\.mjs --all; exit; \}/);
  // a push measures its own change, or everything when it names no before; any other event measures
  assert.match(step, /node scripts\/ci\/quote-speed\.mjs "\$BEFORE" "\$AFTER"/);
  assert.match(step, /\*\) node scripts\/ci\/quote-speed\.mjs --all ;;/);
  assert.equal(CHECK, "scripts/live-checks/evm-quote-warm-round.mjs");
  assert.deepEqual(PATHS, ["packages/kit/src/checks/evm/", "packages/kit/src/trade/evm/"]);
});
