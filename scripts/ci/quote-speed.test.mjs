// The quote-speed gate (scripts/ci/quote-speed.mjs) refuses its planted cases: a slowed quote and a skipped run, each on
// both tries; it passes the recorded good run, and a refused try then a good one (the one rerun); it skips a change
// that touches no file of the quote (read from the merge base); every file node loads for the quote is under its PATHS
// or a package they pin; the glue (runCheck, its kill, the main block, linkKit) on a stub check; ci.yml runs it as main has it,
// in the required deep-import job, with nothing that lets the step pass on a failure. No network: every try is replayed
// from evm-quote-warm-round.answers.json through the check's own check().
//   node --test scripts/ci/quote-speed.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check } from "../live-checks/evm-quote-warm-round.mjs";
import { CHECK, PATHS, TRIES, changedFiles, gate, judgeTry, linkKit, runCheck, watched } from "./quote-speed.mjs";

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

// Every file node loads for `entry` (its resolve hook, so a bare `import "./x"`, an `import()` and a package are all
// seen), as paths from ROOT, in a child process of its own.
const TRACE = `import { registerHooks } from "node:module";
const seen = new Set();
registerHooks({ resolve(s, c, n) { const r = n(s, c); if (r.url.startsWith("file:")) seen.add(r.url); return r; } });
await import(process.argv[1]);
process.stdout.write(JSON.stringify([...seen]));`;
function traced(entry) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", TRACE, pathToFileURL(entry).href], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(out).map((u) => realpathSync(fileURLToPath(u)));
}
// The npm packages the kit pins in its package.json (with pnpm-lock.yaml, both in PATHS).
const PINNED = Object.keys(JSON.parse(readFileSync(path.join(ROOT, "packages/kit/package.json"), "utf8")).dependencies ?? {});
/** Each loaded file that is neither under PATHS nor inside a pinned package's install. */
function outside(files) {
  return files.filter((f) => {
    const rel = path.relative(ROOT, f);
    if (!rel.startsWith("..") && watched([rel]).length === 1) return false;
    const pkg = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(f)?.[1];
    return !(pkg !== undefined && PINNED.includes(pkg));
  });
}

test("every file node loads for the quote is under PATHS or a package the kit pins, and the kit's entry exports it from there", () => {
  const index = readFileSync(path.join(ROOT, "packages/kit/src/index.ts"), "utf8");
  const from = /\bevmPoolBuyQuote,[\s\S]*?\}\s*from\s+"\.\/([^"]+)"/.exec(index)?.[1];
  assert.ok(from, "index.ts exports evmPoolBuyQuote by name");
  const src = `packages/kit/src/${from}`;
  assert.deepEqual(watched([src]), [src], `${src} is under PATHS`);
  const files = traced(path.join(ROOT, src));
  assert.ok(files.some((f) => f.endsWith("packages/kit/src/trade/evm/buy-unpinned.ts")), files.join("\n"));
  assert.ok(files.some((f) => /node_modules\/.*@noble\/hashes/.test(f)), "the trace sees the npm packages too");
  assert.deepEqual(outside(files), [], "a file the quote loads outside PATHS and the pinned packages");
  // planted: a helper outside PATHS, and a package the kit does not pin, are both caught
  assert.equal(outside([path.join(ROOT, "packages/kit/src/freeze.ts"), "/x/node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js"]).length, 2);
  assert.deepEqual(watched(["packages/kit/package.json", "pnpm-lock.yaml", "packages/wallet/package.json"]), ["packages/kit/package.json", "pnpm-lock.yaml"]);
});

test("planted: the trace sees a bare import and a dynamic import()", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "quote-trace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "entry.mjs"), 'import "./side.mjs";\nawait import("./dyn.mjs");\n');
  writeFileSync(path.join(dir, "side.mjs"), "");
  writeFileSync(path.join(dir, "dyn.mjs"), "");
  const files = traced(path.join(dir, "entry.mjs")).map((f) => path.basename(f));
  assert.deepEqual(files.filter((f) => f !== "entry.mjs").sort(), ["dyn.mjs", "side.mjs"]);
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

test("planted: a pull request branched before main changed the quote skips (the change is read from the merge base)", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "quote-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = "packages/kit/src/checks/evm/quote.ts";
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(path.join(dir, path.dirname(q)), { recursive: true });
  mkdirSync(path.join(dir, "apps"));
  writeFileSync(path.join(dir, q), "a\n");
  writeFileSync(path.join(dir, "apps/x.ts"), "a\n");
  git(dir, "add", "--", q, "apps/x.ts");
  git(dir, "commit", "-qm", "m0", "--", q, "apps/x.ts");
  git(dir, "checkout", "-qb", "pr");
  writeFileSync(path.join(dir, "apps/x.ts"), "b\n");
  git(dir, "commit", "-qm", "pr", "--", "apps/x.ts");
  git(dir, "checkout", "-q", "main");
  writeFileSync(path.join(dir, q), "main's change\n");
  git(dir, "commit", "-qm", "m1", "--", q);
  const files = changedFiles(git(dir, "rev-parse", "main"), git(dir, "rev-parse", "pr"), dir);
  assert.deepEqual(files, ["apps/x.ts"]);
  assert.deepEqual(watched(files), []);
  // and a pull request that does change the quote is measured
  git(dir, "checkout", "-q", "pr");
  writeFileSync(path.join(dir, q), "the pr's change\n");
  git(dir, "commit", "-qm", "pr2", "--", q);
  assert.deepEqual(watched(changedFiles(git(dir, "rev-parse", "main"), git(dir, "rev-parse", "pr"), dir)), [q]);
});

// A temp root holding this gate and a stub CHECK: MODE pass writes a passing record, none writes none, fail a failing
// one, exit2 a passing record then exit 2, hang never ends. The stub's check() passes a record with ok: true.
const STUB = `import { writeFileSync } from "node:fs";
export const check = (r) => ({ ok: r?.ok === true, lines: [\`\${r?.ok === true ? "PASS" : "FAIL"} stub\`] });
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const mode = process.env.MODE, at = process.argv.indexOf("--record"), file = process.argv[at + 1];
  if (mode === "hang") setInterval(() => {}, 1000);
  else {
    if (mode !== "none") writeFileSync(file, JSON.stringify({ ok: mode !== "fail" }));
    process.exit(mode === "exit2" ? 2 : mode === "fail" ? 1 : 0);
  }
}
`;
function stubRoot(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "quote-glue-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "base");
  mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
  mkdirSync(path.join(root, "scripts/live-checks"), { recursive: true });
  copyFileSync(path.join(ROOT, "scripts/ci/quote-speed.mjs"), path.join(root, "scripts/ci/quote-speed.mjs"));
  writeFileSync(path.join(root, CHECK), STUB);
  const checkout = path.join(dir, "checkout");
  mkdirSync(path.join(checkout, "packages"), { recursive: true });
  return { dir, root, checkout };
}

test("runCheck: a stub's record comes back; no record, a failing one, exit 2 and a hang past its bound are refused", async (t) => {
  const { root, checkout } = stubRoot(t);
  const run = async (mode, killMs) => {
    process.env.MODE = mode;
    try {
      return await runCheck(root, checkout, killMs)();
    } finally {
      delete process.env.MODE;
    }
  };
  // the stub's own check(), as STUB writes it
  const stub = (r) => ({ ok: r?.ok === true, lines: [`${r?.ok === true ? "PASS" : "FAIL"} stub`] });
  const pass = await run("pass");
  assert.deepEqual(pass, { status: 0, record: { ok: true } });
  assert.equal(judgeTry(pass, stub).ok, true);
  for (const mode of ["none", "fail", "exit2"]) assert.equal(judgeTry(await run(mode), stub).ok, false, mode);
  assert.equal((await run("none")).record, null);
  const t0 = Date.now();
  const hang = await run("hang", 500);
  assert.ok(Date.now() - t0 < 5000, "the hang was killed at its bound");
  assert.equal(hang.killed, true);
  assert.match(judgeTry(hang, stub).lines.join("\n"), /FAIL the try ran past \d+ s and was killed/);
});

test("the main block measures with --all from a root apart from the checkout: links the kit, passes a passing run, refuses the rest", (t) => {
  const { root, checkout } = stubRoot(t);
  const main = (mode) => spawnSync(process.execPath, [path.join(root, "scripts/ci/quote-speed.mjs"), "--all"], { cwd: checkout, encoding: "utf8", env: { ...process.env, MODE: mode } });
  const ok = main("pass");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /quote-speed: PASS \(try 1 of 2\)/);
  assert.equal(realpathSync(path.join(root, "packages")), realpathSync(path.join(checkout, "packages")), "ROOT/packages is the checkout's");
  for (const mode of ["none", "fail", "exit2"]) {
    const r = main(mode);
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /quote-speed: FAIL \(2 tries refused/);
  }
});

test("linkKit refuses a packages link that is not the checkout's", (t) => {
  const { dir, root, checkout } = stubRoot(t);
  mkdirSync(path.join(dir, "elsewhere"));
  symlinkSync(path.join(dir, "elsewhere"), path.join(root, "packages"), "dir");
  assert.throws(() => linkKit(root, checkout), /is not the checkout's packages/);
  const r = spawnSync(process.execPath, [path.join(root, "scripts/ci/quote-speed.mjs"), "--all"], { cwd: checkout, encoding: "utf8", env: { ...process.env, MODE: "pass" } });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /quote-speed: ERROR .*is not the checkout's packages/);
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
  const header = yml.split(/\n(?!#)/)[0].replace(/\n# ?/g, " ");
  assert.match(header, /required checks of main's ruleset \([^)]*\): [a-z, -]*\bdeep-import\b[a-z, -]*\./);
  const lines = job(yml, "deep-import");
  const text = lines.join("\n");
  const start = lines.findIndex((l) => /^ {6}- name: .*evm-quote-warm-round/.test(l));
  assert.ok(start >= 0, text);
  const next = lines.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  const step = lines.slice(start, next < 0 ? undefined : next).join("\n");
  assert.doesNotMatch(step, /^\s+(if|continue-on-error):/m, step);
  // GitHub's bash is "bash --noprofile --norc -eo pipefail {0}": a failed git archive stops the step
  assert.match(step, /^ {8}shell: bash$/m, step);
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
  assert.match(step, /\[ -e "\$RUNNER_TEMP\/base\/scripts\/ci\/quote-speed\.mjs" \] \|\| \{[^}]*node scripts\/ci\/quote-speed\.mjs "\$PR_BASE" "\$PR_HEAD"; exit; \}/);
  // a push measures its own change, or everything when it names no before; any other event measures
  assert.match(step, /node scripts\/ci\/quote-speed\.mjs "\$BEFORE" "\$AFTER"/);
  assert.match(step, /\*\) node scripts\/ci\/quote-speed\.mjs --all ;;/);
  assert.equal(CHECK, "scripts/live-checks/evm-quote-warm-round.mjs");
  assert.deepEqual(PATHS, ["packages/kit/src/checks/evm/", "packages/kit/src/trade/evm/", "packages/kit/package.json", "pnpm-lock.yaml"]);
});
