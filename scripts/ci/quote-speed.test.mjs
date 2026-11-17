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

const CI_YML = () => readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
/** ci.yml's quote-speed step (in the deep-import job), with that job's lines. */
function gateStep(yml) {
  const lines = job(yml, "deep-import");
  const start = lines.findIndex((l) => /^ {6}- name: .*evm-quote-warm-round/.test(l));
  assert.ok(start >= 0, lines.join("\n"));
  const next = lines.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  return { lines, start, step: lines.slice(start, next < 0 ? undefined : next).join("\n") };
}
/** The paths the step's pull request branch extracts from the base into $RUNNER_TEMP/base (its one git archive line). */
function archived(step) {
  const all = [...step.matchAll(/git archive "\$PR_BASE" ([^|]+?) \| tar -x -f - -C "\$RUNNER_TEMP\/base"/g)];
  assert.equal(all.length, 1, `one git archive of the base in the step:\n${step}`);
  return all[0][1].trim().split(/\s+/);
}

// A root built as ci.yml's step builds main's copy: `git archive <rev> <paths>` of `repo` into a temp dir, its packages
// linked to repo's own (linkKit); then `check` imported from there with repo as the working directory, as the base's
// quote-speed.mjs imports CHECK. Gives the child's exit, its output and every file it loaded (real paths).
function loadsFromBase(t, repo, paths, check, rev = "HEAD") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "quote-base-root-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "base");
  mkdirSync(root);
  const tar = path.join(dir, "base.tar");
  execFileSync("git", ["archive", "--output", tar, rev, ...paths], { cwd: repo });
  execFileSync("tar", ["-x", "-f", tar, "-C", root]);
  linkKit(root, repo);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", TRACE, pathToFileURL(path.join(root, check)).href], { cwd: repo, encoding: "utf8" });
  const files = r.status === 0 ? JSON.parse(r.stdout).map((u) => realpathSync(fileURLToPath(u))) : [];
  return { root, status: r.status, out: `${r.stdout}\n${r.stderr}`, files };
}
/** Each loaded file that came neither from the base's root nor from the checkout's packages/ (linked) or an install. */
const notFromBase = (files, root, repo) => {
  const kit = realpathSync(path.join(repo, "packages")) + path.sep;
  return files.filter((f) => !f.startsWith(root + path.sep) && !f.startsWith(kit) && !f.includes(`${path.sep}node_modules${path.sep}`));
};

test("main's copy of CHECK loads whole from a root built as ci.yml builds it (its archived paths and linkKit)", (t) => {
  const paths = archived(gateStep(CI_YML()).step);
  const r = loadsFromBase(t, ROOT, paths, CHECK);
  assert.equal(r.status, 0, `CHECK does not load from the base's ${paths.join(" ")}: an import outside them goes in ci.yml's git archive line\n${r.out}`);
  assert.ok(r.files.includes(realpathSync(path.join(r.root, CHECK))), r.files.join("\n"));
  assert.deepEqual(notFromBase(r.files, r.root, ROOT), [], "every file CHECK loads past the kit comes from the base");
});

test("planted: a check whose import leaves the archived paths fails to load from the base; archived, it loads", (t) => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "quote-base-plant-")));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const check = "scripts/live-checks/c.mjs";
  mkdirSync(path.join(repo, "scripts/live-checks"), { recursive: true });
  mkdirSync(path.join(repo, "apps/x"), { recursive: true });
  mkdirSync(path.join(repo, "packages"));
  writeFileSync(path.join(repo, check), 'import { N } from "../../apps/x/n.ts";\nexport const check = () => N;\n');
  writeFileSync(path.join(repo, "apps/x/n.ts"), "export const N: number = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "--", check, "apps/x/n.ts");
  git(repo, "commit", "-qm", "m0", "--", check, "apps/x/n.ts");
  const out = loadsFromBase(t, repo, ["scripts"], check);
  assert.notEqual(out.status, 0, out.out);
  assert.match(out.out, /ERR_MODULE_NOT_FOUND[\s\S]*apps\/x\/n\.ts|Cannot find module .*apps\/x\/n\.ts/, out.out);
  const ok = loadsFromBase(t, repo, ["scripts", "apps/x/n.ts"], check);
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(notFromBase(ok.files, ok.root, repo), []);
  // and a file loaded from the checkout instead of the base is named
  assert.deepEqual(notFromBase([path.join(repo, "apps/x/n.ts")], ok.root, repo), [path.join(repo, "apps/x/n.ts")]);
});

test("ci.yml runs the gate as main has it in the required deep-import job, every event, nothing letting it pass on a failure", () => {
  const yml = CI_YML();
  const header = yml.split(/\n(?!#)/)[0].replace(/\n# ?/g, " ");
  assert.match(header, /required checks of main's ruleset \([^)]*\): [a-z, -]*\bdeep-import\b[a-z, -]*\./);
  const { lines, start, step } = gateStep(yml);
  const text = lines.join("\n");
  assert.doesNotMatch(step, /^\s+(if|continue-on-error):/m, step);
  // GitHub's bash is "bash --noprofile --norc -eo pipefail {0}": a failed git archive stops the step
  assert.match(step, /^ {8}shell: bash$/m, step);
  assert.doesNotMatch(text, /^\s+continue-on-error:/m);
  assert.match(text, /^ {4}if: github\.event_name != 'schedule'$/m);
  assert.match(text, /^ {10}fetch-depth: 0$/m, "the base and the change are in the checkout");
  assert.match(text, /^ {6}- run: pnpm install --frozen-lockfile$/m);
  assert.ok(lines.findIndex((l) => /pnpm install --frozen-lockfile/.test(l)) < start, "the install comes before the step");
  // pull_request: the base's scripts/ tree and the files CHECK imports past it, its gate on the head's change
  assert.equal(archived(step)[0], "scripts", step);
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
