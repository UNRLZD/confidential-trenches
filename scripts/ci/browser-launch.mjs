// A test browser starts in one place, scripts/browsers.mjs, which runs Chromium as the installed Google Chrome with its
// sandbox on. This gate fails on any file that starts or attaches to a browser itself, and on any way to switch the
// sandbox off. Playwright's bundled Chromium is pinned to the Playwright release (1.63.0 bundles Chromium 153), and
// Playwright's chromiumSandbox defaults to false, so a bare launch() runs a stale browser with no sandbox on a machine
// that holds keys.
//   node scripts/ci/browser-launch.mjs      (exit 1 and one line per problem, over every tracked file)
//
// Refused outside scripts/browsers.mjs: .launch(, launchPersistentContext(, launchServer( and connectOverCDP( (a launch,
// a profile of the caller's choosing, a server others attach to, an attach to a browser already running).
// Refused in every tracked file, the launcher included: chromiumSandbox set to false, --no-sandbox,
// --disable-setuid-sandbox and ignoreDefaultArgs (which strips Playwright's own defaults, among them its sandbox
// flags). This gate and its test are the only files that name them, as the patterns and the planted cases.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LAUNCHER = "scripts/browsers.mjs";
export const SELF = ["scripts/ci/browser-launch.mjs", "scripts/ci/browser-launch.test.mjs"];
const MAX_BYTES = 2 * 1024 * 1024;

const OUTSIDE_THE_LAUNCHER = [
  [/\.launch\s*\(/, "a browser launch"],
  [/\[\s*["'`]launch["'`]\s*\]\s*\(/, "a browser launch (bracket form)"],
  [/\blaunchPersistentContext\s*\(/, "launchPersistentContext"],
  [/\blaunchServer\s*\(/, "launchServer"],
  [/\bconnectOverCDP\s*\(/, "connectOverCDP"],
];
const ANYWHERE = [
  [/\bchromiumSandbox\s*:\s*false\b/, "chromiumSandbox: false"],
  [/--no-sandbox\b/, "--no-sandbox"],
  [/--disable-setuid-sandbox\b/, "--disable-setuid-sandbox"],
  [/\bignoreDefaultArgs\b/, "ignoreDefaultArgs"],
];

/** Every tracked file of the repository at `root`, as { path, text } (a binary or a file over 2 MB is skipped). */
export function trackedFiles(root = ROOT) {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
  const out = [];
  for (const name of names) {
    let buf;
    try {
      buf = readFileSync(path.join(root, name));
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;
    out.push({ path: name, text: buf.toString("utf8") });
  }
  return out;
}

/** One line per problem in `files` ([{ path, text }]); an empty list is a pass. */
export function problems(files) {
  const found = [];
  for (const { path: p, text } of files) {
    if (SELF.includes(p)) continue;
    const rules = p === LAUNCHER ? ANYWHERE : [...OUTSIDE_THE_LAUNCHER.map(([re, what]) => [re, `${what}; a browser starts only in ${LAUNCHER}`]), ...ANYWHERE];
    text.split("\n").forEach((line, i) => {
      for (const [re, what] of rules) if (re.test(line)) found.push(`${p}:${i + 1}: ${what}`);
    });
  }
  return found;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = problems(trackedFiles());
  for (const l of found) console.log(l);
  console.log(found.length ? `browser-launch: FAIL ${found.length} problem${found.length === 1 ? "" : "s"}` : `browser-launch: PASS no browser starts outside ${LAUNCHER} and no file turns a sandbox off`);
  process.exit(found.length ? 1 : 0);
}
