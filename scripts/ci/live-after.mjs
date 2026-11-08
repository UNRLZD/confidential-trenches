// Which host deploys run each live check, read from the check's own header (card live-lists-merge-clean): one line per
// run, in the check's leading comment block, beside where a `// Runs:` line would be:
//   // After: <host> [<host> ...] [<args>]
// <host> is app, sign or helper (scripts/ci/live-plan.mjs HOSTS); <args> are the run's arguments, from the first word
// that starts with "--" to the end of the line, and run once on each host the line names. `{commit}` in them is the
// deployed commit (helper) and `{network}` the network the build names (app). A check with two runs on one host has two
// lines. The hosts' lists (packages/signpage/scripts/deploy.mjs, apps/terminal/scripts/deploy.mjs,
// scripts/ci/helper-live-checks.mjs) are made from these lines and hold no list of their own, so a card that adds a
// check touches only that check's own files, where one shared list made every ready card conflict with each merge.
// scripts/ci/live-listed.mjs refuses a check with an After line and a Runs line, or with neither.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const AFTER_HOSTS = ["app", "sign", "helper"];
export const CHECKS_DIR = "scripts/live-checks";
const HOST_WORD = /^[a-z]+$/;

/** The values of the `// <word>:` lines of a check's leading comment block (its shebang and the `//` lines before the
 *  first line of code), in order. */
export function headerLines(text, word) {
  const out = [];
  const re = new RegExp(`^//\\s*${word}:(.*)$`);
  for (const line of text.split("\n")) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    const m = re.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** One After line's value as { hosts, args }, or { problem }. */
export function parseAfter(value) {
  const words = value.split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => w.startsWith("--"));
  const hosts = at < 0 ? words : words.slice(0, at);
  const args = at < 0 ? "" : words.slice(at).join(" ");
  if (!hosts.length) return { problem: `"After:" names no host (${AFTER_HOSTS.join(", ")}): ${value}` };
  const bad = hosts.filter((h) => !HOST_WORD.test(h) || !AFTER_HOSTS.includes(h));
  if (bad.length) return { problem: `"After:" names ${bad.join(" ")}, which is no host (${AFTER_HOSTS.join(", ")}): ${value}` };
  if (new Set(hosts).size !== hosts.length) return { problem: `"After:" names a host twice: ${value}` };
  return { hosts, args };
}

/** A check's runs by host ({ host: [args, ...] }) and the problems of its After lines. */
export function afterOf(text) {
  const runs = {};
  const problems = [];
  for (const value of headerLines(text, "After")) {
    const a = parseAfter(value);
    if (a.problem) {
      problems.push(a.problem);
      continue;
    }
    for (const h of a.hosts) {
      if ((runs[h] ?? []).includes(a.args)) problems.push(`"After:" runs ${h}${a.args ? ` with ${a.args}` : ""} twice`);
      else (runs[h] ??= []).push(a.args);
    }
  }
  return { runs, problems };
}

/** The checks under `root` ({ key: text }): every scripts/live-checks/<key>.mjs but its .test.mjs. */
export function readChecks(root) {
  const dir = path.join(root, CHECKS_DIR);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
      .sort()
      .map((f) => [f.slice(0, -4), readFileSync(path.join(dir, f), "utf8")]),
  );
}

/**
 * One host's list under `root`, from the checks' After lines: { checks: [key, ...] sorted, args: { key: [args, ...] } }.
 * Throws on any check whose After lines are wrong, so no host's list is read past a bad header.
 */
export function hostList(host, root) {
  if (!AFTER_HOSTS.includes(host)) throw new Error(`host must be one of ${AFTER_HOSTS.join(", ")}, not ${host}`);
  const checks = [];
  const args = {};
  for (const [key, text] of Object.entries(readChecks(root))) {
    const { runs, problems } = afterOf(text);
    if (problems.length) throw new Error(`${CHECKS_DIR}/${key}.mjs: ${problems.join("; ")}`);
    if (!runs[host]) continue;
    checks.push(key);
    args[key] = runs[host];
  }
  return { checks, args };
}
