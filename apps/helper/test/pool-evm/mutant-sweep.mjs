// The helper's EVM mutant sweeps' runner (card helper-release-sweep-in-ci), one for both: sell-mutants.mjs (the sell
// sender's checks) and release-mutants.mjs (the withdraw's and the buy's) each hold a list of [file, text, replacement,
// test file, the test whose name starts so, which must fail] and run it here. Every entry's text must be in its file
// exactly once, read first, before any test runs; each named test must pass on the code as it is; each mutant must fail
// its named test. The mutants are made in a copy of the helper's src and test in a fresh temporary folder beside the
// helper, with its node_modules linked (so the copy resolves the same installed modules, @blindfill/kit included),
// removed at the end; the tree's own files are never changed. A sweep runs whole or as part <k>/<n> (every n-th entry
// from the k-th), so ci.yml's test-mutants split can share its parts out. mutant-sweep.test.mjs holds the refusals.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

const HELPER = fileURLToPath(new URL("../..", import.meta.url));

// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`; a
// run past 120 s is killed, its process group with it (scripts/group-run.mjs), and counts as a fail; each run without
// the node --test runner's NODE_TEST_CONTEXT, which turns a child's report from TAP on stdout into the runner's own
// (so a sweep started from a test, as mutant-sweep.test.mjs does, reads its runs right)
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
let lastFail = "";
function run(dir, file, name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, file];
  const r = runSync("node", args, { cwd: dir, env: CHILD_ENV, stdio: "pipe", encoding: "utf8", timeoutMs: 120_000 });
  if (r.status !== 0) {
    lastFail = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 4).join("\n");
    return "fail";
  }
  return /^# pass ([1-9]\d*)$/m.test(r.stdout) ? "pass" : "none";
}

/** Every entry of `list` whose text is not in its file exactly once, one line each: an entry left behind by a change to
 *  the code (card helper-sell-sweep-in-ci: twelve of the sell sweep's stood stale, unseen, while no CI job ran it) or one
 *  that names two places. `read` gives a file's text. */
export function stale(list, read = (f) => readFileSync(join(HELPER, f), "utf8")) {
  const text = new Map();
  return list.flatMap(([file, find], i) => {
    if (!text.has(file)) text.set(file, read(file));
    const n = text.get(file).split(find).length - 1;
    return n === 1 ? [] : [`mutant ${i + 1}: its text is in ${file} ${n} times, not once: ${JSON.stringify(find.split("\n")[0].trim().slice(0, 70))}`];
  });
}

/** Runs `list` and returns its problems' count: every stale entry first, the whole list's (then no test runs), else
 *  each named test of the entries `pick` takes on the code as it is (each must pass), else each of those mutants (its
 *  named test must fail; one that passes is a survivor). `pick` takes an entry's index in `list`. */
export function sweep(list, log = console.log, pick = () => true) {
  const old = stale(list);
  for (const s of old) log(`FAIL ${s}`);
  if (old.length) return old.length;
  // the copy sits beside the helper (in apps/), with test/ in it and the helper's node_modules linked: the tests import
  // ../../test/pool-evm/release-sign.ts, and their ../../../../ paths reach the repository root (a copy inside the
  // helper with src alone failed every one of the sell sweep's named tests on the code as it is)
  const dir = mkdtempSync(join(HELPER, "..", ".helper-mutants-"));
  let bad = 0;
  try {
    for (const p of ["src", "test", "package.json"]) cpSync(join(HELPER, p), join(dir, p), { recursive: true });
    symlinkSync(join(HELPER, "node_modules"), join(dir, "node_modules"), "dir");
    const src = new Map([...new Set(list.map((m) => m[0]))].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const mine = list.filter((_, i) => pick(i));
    for (const [file, t] of [...new Set(mine.map((m) => `${m[3]}\u0000${m[4]}`))].map((k) => k.split("\u0000"))) {
      const r = run(dir, file, t);
      if (r !== "pass") {
        log(`FAIL "${t}" in ${file} ${r === "none" ? "names no test" : `fails on the code as it is:\n${lastFail}`}`);
        bad++;
      }
    }
    if (bad === 0) {
      list.forEach(([file, find, repl, tf, t], i) => {
        if (!pick(i)) return;
        const s = src.get(file);
        writeFileSync(join(dir, file), s.replace(find, repl));
        const r = run(dir, tf, t);
        writeFileSync(join(dir, file), s);
        log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].trim().slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
        if (r !== "fail") bad++;
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return bad;
}

/** `<k>/<n>`: part k of n, every n-th entry from the k-th (so each part gets some of every check's mutants); none: the
 *  whole list. Anything else is refused. */
export function partOf(arg, size) {
  if (arg === undefined) return { what: `${size} mutants`, pick: () => true };
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(arg);
  if (!m || Number(m[1]) > Number(m[2])) throw new Error(`the part is <k>/<n> with 1 <= k <= n, not ${JSON.stringify(arg)}`);
  const [k, n] = [Number(m[1]), Number(m[2])];
  const count = Array.from({ length: size }, (_, i) => i).filter((i) => i % n === k - 1).length;
  return { what: `${count} mutants (part ${k} of ${n})`, pick: (i) => i % n === k - 1 };
}

/** A sweep's command line: `node <name> [<k>/<n>]` runs `list` whole or that part, prints each mutant and the count, and
 *  exits 0 only when every one it ran failed its named test; a part that is not k/n exits 1 with nothing run. */
export function sweepMain(list, name, args = process.argv.slice(2)) {
  let part;
  try {
    if (args.length > 1) throw new Error(`one part at most: node ${name} [<k>/<n>]`);
    part = partOf(args[0], list.length);
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    process.exit(1);
  }
  const bad = sweep(list, console.log, part.pick);
  console.log(bad === 0 ? `every one of ${part.what} fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
