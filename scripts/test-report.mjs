// Card test-count-never-short: the reporter every package's `node --test` runs (--test-reporter=../../scripts/test-report.mjs,
// held by scripts/ci/tests-run.test.mjs). It prints node's spec report, and fails the run (exit 1) when a test file named
// on the command line reported no result, or reported fewer tests than its own count says it ran. Why: node's runner
// counts what reaches it, and a file process that exits with its report half written passes as one test named after
// the file (node v24.22.3 lib/internal/test_runner/runner.js: a file process that exits 0 is a pass, whatever it sent).
// --test-force-exit is one such exit (test.js:1468-1492: the root test, its tests ended, waits for the reporter to
// unpipe, then process.exit(), with stdout's last writes still queued on a pipe, which is asynchronous on macOS), and a
// test that calls process.exit() is another. 21 Nov: the kit's suite reported 2237 and 2293 tests on a loaded macOS runner
// against 2316 on Linux, both runs exit 0. scripts/test-bound-watch.cjs makes the pipes blocking, so the report is
// whole; this check refuses any run where it is not.
//
// A file's process sends, after its tests, one test:summary event naming the file and its counts; it is the last thing
// the file sends, so a report cut short has none. Each file named (the runner's own arguments, globs expanded as the
// runner expands them) must send it, and its counts.tests must equal the tests (not suites) the run saw end for it.
// Each event is the file's the runner ran (data.entryFile, runner.js #handleReportItem), never the file a test is written
// in (data.file): a file that imports another test file runs that file's tests as its own.
import { globSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { spec } from "node:test/reporters";

/** A path with its links resolved (macOS's /var is /private/var), so a file named one way matches the runner's name for
 *  it; as given when it cannot be read. */
export function real(f) {
  try {
    return realpathSync(f);
  } catch {
    return f;
  }
}

/** The test files the runner was named: its own arguments (node --test puts its flags in execArgv), each a glob or a
 *  path, expanded from `cwd` as node --test expands them (no node_modules), links resolved. */
export function namedFiles(args, cwd) {
  const out = new Set();
  for (const a of args) {
    if (a.startsWith("-")) continue;
    for (const f of globSync(a, { cwd, exclude: (p) => p.split(path.sep).includes("node_modules") })) out.add(real(path.resolve(cwd, f)));
  }
  return [...out].sort();
}

/** Each named file whose report is missing or short, with why; `events` are the runner's { type, data }, `data.entry`
 *  whether the event named the file the runner ran (entryFile).
 *  A Node with no entryFile on its test events (v24.12.0 has none, v24.22.3 has it; the README asks Node 24 or later)
 *  names the file a test is written in, so a file that runs another's tests reads as 0 of its own beside the other at
 *  twice its own (signpage's pool-deposit-evm-base-mainnet.test.ts, a run whose every test passed refused on 24.12.0, card
 *  readme-run-fits-an-agent-timeout). There each file must still send its summary, and the tests that ended must be
 *  the files' summaries added up: a report cut short is refused either way, only its file is not named. */
export function shortFiles(named, events) {
  const summary = new Map();
  const ended = new Map();
  let total = false;
  let entry = false;
  let endedAll = 0;
  for (const { type, data } of events) {
    if (type === "test:summary") {
      if (data.file === undefined) total = true;
      else summary.set(data.file, data.counts);
    } else if ((type === "test:pass" || type === "test:fail") && data.file !== undefined && data.details?.type !== "suite") {
      ended.set(data.file, (ended.get(data.file) ?? 0) + 1);
      endedAll++;
      if (data.entry === true) entry = true;
    }
  }
  const out = [];
  for (const f of named) {
    const c = summary.get(f);
    if (c === undefined) out.push(`${f}: reported no result (its process sent no summary)`);
    else if (entry && (ended.get(f) ?? 0) !== c.tests) out.push(`${f}: ${ended.get(f) ?? 0} of its ${c.tests} tests reported`);
  }
  if (!entry) {
    const counted = named.reduce((s, f) => s + (summary.get(f)?.tests ?? 0), 0);
    if (endedAll !== counted) out.push(`${endedAll} of the files' ${counted} tests reported (this Node names no entryFile, so the files are counted together)`);
  }
  if (!total) out.push("the run sent no summary");
  return out;
}

const inner = spec();
const seen = [];
const reals = new Map();
export default new Transform({
  writableObjectMode: true,
  transform(event, encoding, done) {
    // the overall summary names no file: entryFile and file both undefined
    const file = event.data?.entryFile ?? event.data?.file;
    seen.push({ type: event.type, data: { file: file === undefined ? undefined : (reals.get(file) ?? reals.set(file, real(file)).get(file)), entry: event.data?.entryFile !== undefined, counts: event.data?.counts, details: event.data?.details && { type: event.data.details.type } } });
    inner._transform(event, encoding, done);
  },
  flush(done) {
    inner._flush((error, rest) => {
      const bad = shortFiles(namedFiles(process.argv.slice(1), process.cwd()), seen);
      if (bad.length === 0) return done(error, rest);
      const text = `\ntest-report: FAIL, a test file's results did not all arrive:\n${bad.map((b) => `  ${b}`).join("\n")}\n`;
      // written now as well, so the verdict is read even if the runner's exit cuts its own output
      try {
        writeSync(2, text);
      } catch {}
      process.exitCode = 1;
      done(error, (rest ?? "") + text);
    });
  },
});
