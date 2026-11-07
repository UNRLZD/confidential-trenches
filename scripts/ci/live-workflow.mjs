// The shape of the live runs (card ci-live-runners): a workflow or action that breaks one of these fails here, with one
// line per problem.
//   node scripts/ci/live-workflow.mjs      (exit 1 and the problems; PASS otherwise)
//
//   - every `uses:` of every workflow and action is a local action (./) or a full 40-hex commit sha;
//   - none reads a secret (the word `secrets` in no line that is not a comment);
//   - every `permissions:` block is `contents: read` and no workflow lacks the top-level one;
//   - live.yml: dispatches on inputs host (exactly app, sign, helper: the keys of live-plan's HOSTS) and commit; has the
//     plan, check, live and browser-e2e jobs; the check job's run is the check its matrix names (a file in
//     scripts/live-checks), its artifact step runs `if: always()`, and the verdict job runs `if: always()`; no run line
//     names a check that does not exist; the plan job runs on a dispatch alone; no step installs Playwright's own
//     Chromium (a browser starts only as the installed Chrome, scripts/browsers.mjs); the check job's summary grep keeps
//     every verdict line a check prints (SUMMARY_LINES: card jupiter-build-budget-503, an INCONCLUSIVE line it dropped);
//   - the check job runs a serial group's checks in one step (scripts/ci/live-serial.mjs, GROUP the matrix's) and a single
//     check in the other, each `if` on matrix.group so no check runs twice or not at all (card helper-live-jup-serial);
//   - the helper's plan puts every check that reads the helper's Jupiter budget (BUDGET_READS: a Jupiter proxy path, a
//     build, a Solana token page) in a serial group, one matrix entry, or lists it exempt with the reason: two such checks
//     in separate jobs spend one shared window between them and a page reads chain (run 42332950254 attempt 1);
//   - every check each host's plan runs exists, with its test and its recorded answers, and none reads the
//     environment (a check that needs a secret is listed SKIPPED, never run); each run gives every flag its check's
//     usage line needs (live-plan's planFor refuses a run that lacks one).
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, ROOT, keysOf, listOf, planFor } from "./live-plan.mjs";

const SHA_FULL = "0123456789012345678901234567890123456789";
const uncommented = (text) => text.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*#/.test(l));

/** The lines of `text` that start `key:` at any indent, with the lines of the block under each, as [{ at, indent, lines }]. */
function blocks(text, key) {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((l, i) => {
    const m = new RegExp(`^( *)${key}:\\s*(.*)$`).exec(l);
    if (!m) return;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].match(/^ */)[0].length;
      if (lines[j].trim() && ind <= m[1].length) break;
      if (lines[j].trim() && !/^\s*#/.test(lines[j])) body.push(lines[j].trim());
    }
    out.push({ at: i + 1, indent: m[1].length, rest: m[2], lines: body });
  });
  return out;
}

/** The problems with one workflow or action file (`file` is its repo path, `text` its text). */
export function fileProblems(file, text) {
  const p = [];
  for (const [n, l] of uncommented(text)) {
    const u = /\buses:\s*(\S+)/.exec(l);
    if (u && !u[1].startsWith("./") && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(u[1])) p.push(`${file}:${n}: uses ${u[1]} is not pinned by a full commit sha`);
    if (/\bsecrets\b/.test(l)) p.push(`${file}:${n}: reads a secret`);
  }
  if (file.startsWith(".github/workflows/")) {
    const perms = blocks(text, "permissions");
    if (!perms.some((b) => b.indent === 0)) p.push(`${file}: no top-level permissions block`);
    for (const b of perms) if (b.rest || b.lines.length !== 1 || b.lines[0] !== "contents: read") p.push(`${file}:${b.at}: permissions is not exactly contents: read`);
  }
  return p;
}

/** Lines a check prints that the run's summary must keep (live.yml's "the lines that matter" grep): a BAD or WARN
 *  line, each verdict a check ends on (PASS, FAIL, INCONCLUSIVE, ERROR) and the INCONCLUSIVE line that says why
 *  (solana-jupiter-build, solana-mint-supply-moves). */
export const SUMMARY_LINES = [
  "BAD S-1 buy, a token with no route at 40: upstream",
  "WARN a warning",
  "live-check k: PASS (x)",
  "live-check k: FAIL (x)",
  "live-check k: INCONCLUSIVE (x)",
  "INCONCLUSIVE no token with no route at 40 and a fitting one within the search's reach, buy and sell, among 48 candidates",
  "live-check k: ERROR: x",
];

/** The problems with live.yml's own shape. */
export function liveProblems(text, hosts = Object.keys(HOSTS), exists = (k) => existsSync(path.join(ROOT, "scripts/live-checks", `${k}.mjs`))) {
  const file = ".github/workflows/live.yml";
  const p = [];
  const want = (s, what) => {
    if (!s) p.push(`${file}: ${what}`);
  };
  want(/^on:\s*\n(?:.*\n)*?\s+workflow_dispatch:/m.test(text), "no workflow_dispatch trigger");
  const host = /^ {6}host:\n(?: {8}.*\n)*/m.exec(text)?.[0] ?? "";
  const options = /options:\s*\[([^\]]*)\]/.exec(host)?.[1].split(",").map((s) => s.trim()).sort().join(",");
  want(options === [...hosts].sort().join(","), `the host input's options are ${options ?? "missing"}, want ${[...hosts].sort().join(",")}`);
  want(/^ {6}commit:\n(?: {8}.*\n)*? {8}required: true/m.test(text), "no required commit input");
  for (const job of ["plan", "check", "live", "browser-e2e"]) want(new RegExp(`^  ${job}:`, "m").test(text), `no ${job} job`);
  want(/^  plan:\n    if: github\.event_name == 'workflow_dispatch'\n/m.test(text), "the plan job runs on something other than a dispatch (a deploy's commit and host come only from its inputs)");
  const jobText = (name) => new RegExp(`^  ${name}:\\n((?:   .*\\n|\\s*\\n|  #.*\\n)*)`, "m").exec(text)?.[0] ?? "";
  want(/uses: actions\/upload-artifact@[0-9a-f]{40}.*\n\s+if: always\(\)/.test(jobText("check")), "the check job's artifact step does not run `if: always()`");
  want(/^  live:\n(?:.*\n)*?    if: always\(\)/m.test(jobText("live") || ""), "the live job does not run `if: always()`");
  want(/node "scripts\/live-checks\/\$KEY\.mjs"/.test(jobText("check")), "the check job does not run the check its matrix names");
  // card helper-live-jup-serial: a serial group is one step, a single check the other, and each runs on its own `if`
  want(/- name: [^\n]*\n {8}if: matrix\.group == ''\n {8}env:\n(?: {10}.*\n)*? {10}KEY: \$\{\{ matrix\.key \}\}\n(?: {10}.*\n)*? {8}run: \|\n(?: {10}.*\n)*? {10}node "scripts\/live-checks\/\$KEY\.mjs"/.test(jobText("check")), "the check job's single-check step does not run `if: matrix.group == ''`");
  want(/- name: [^\n]*\n {8}if: matrix\.group != ''\n {8}env:\n {10}GROUP: \$\{\{ matrix\.group \}\}\n(?: {10}.*\n)*? {8}run: \|\n(?: {10}.*\n)*? {10}node scripts\/ci\/live-serial\.mjs \$GROUP/.test(jobText("check")), "the check job does not run a serial group's checks with scripts/ci/live-serial.mjs on `if: matrix.group != ''`");
  want(/timeout-minutes: \$\{\{ matrix\.group != '' && (\d+) \|\| (\d+) \}\}/.test(jobText("check")) && (([, g, o]) => Number(g) > Number(o))(/timeout-minutes: \$\{\{ matrix\.group != '' && (\d+) \|\| (\d+) \}\}/.exec(jobText("check"))), "a serial group's job has no longer limit than a single check's (timeout-minutes: ${{ matrix.group != '' && <longer> || <shorter> }})");
  want(/KEY: \$\{\{ matrix\.key \}\}/.test(jobText("check")), "the check job's key is not the matrix's");
  const grep = /grep -E '([^']+)' "\$log"/.exec(jobText("check"))?.[1];
  let keeps = null;
  try {
    keeps = grep === undefined ? null : new RegExp(grep);
  } catch {
    keeps = null;
  }
  if (keeps === null) p.push(`${file}: the check job's summary has no grep -E of the check's log`);
  else for (const l of SUMMARY_LINES) if (!keeps.test(l)) p.push(`${file}: the check job's summary grep drops the line "${l}"`);
  for (const [n, l] of uncommented(text)) {
    for (const m of l.matchAll(/scripts\/live-checks\/([\w.-]+?)\.mjs/g)) if (!exists(m[1])) p.push(`${file}:${n}: runs ${m[1]}, which is no file in scripts/live-checks`);
    if (/playwright\s+install\b.*\bchromium\b/.test(l)) p.push(`${file}:${n}: installs Playwright's own Chromium; a browser starts only as the installed Chrome (scripts/browsers.mjs)`);
  }
  return p;
}

/** What marks a live check as one that spends the helper's Jupiter budget: a call through its Jupiter proxy, a swap build the
 *  kit makes through it, or a Solana token page (its search). A check that names none of these, as helper-launchpad-origin
 *  (Jupiter's own keyless search, outside the helper), spends none of the helper's. */
export const BUDGET_READS = /\/v1\/proxy\/jupiter|swap\/v2\/build|fetchSolanaJupiter|SolanaBuildRoom|runSolanaTrade|\/v1\/market\/token\?chain=solana/;

const filesUnder = (dir, test) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && test(e.name)).map((e) => path.join(e.parentPath ?? e.path, e.name)) : []);

/** The problems with the checks one host's plan runs. */
export async function planProblems(host, root = ROOT) {
  const p = [];
  let plan;
  try {
    plan = await planFor(host, { commit: SHA_FULL, root });
  } catch (e) {
    return [`${host}: ${e.message}`];
  }
  const keys = [...new Set(plan.include.flatMap(keysOf))];
  for (const k of keys) {
    for (const f of [`${k}.mjs`, `${k}.test.mjs`, `${k}.answers.json`]) if (!existsSync(path.join(root, "scripts/live-checks", f))) p.push(`${host}: ${k} has no scripts/live-checks/${f}`);
    const file = path.join("scripts/live-checks", `${k}.mjs`);
    const seen = new Set();
    const walk = (f) => {
      const abs = path.resolve(root, f);
      if (seen.has(abs) || !existsSync(abs)) return;
      seen.add(abs);
      const text = readFileSync(abs, "utf8");
      if (/\bprocess\.env\b/.test(text)) p.push(`${host}: ${k} reads the environment (${path.relative(root, abs)}): list it SKIPPED, a run holds no secret`);
      for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+\.mjs)["']/g)) {
        const next = path.join(path.dirname(f), m[1]);
        if (next.startsWith("scripts/")) walk(next);
      }
    };
    walk(file);
  }
  p.push(...budgetProblems(host, plan, root));
  return p;
}

/**
 * Card helper-live-jup-serial: on the helper's plan, every check whose source (and the scripts it imports) matches
 * BUDGET_READS is a member of a serial group, so it runs one after another with the others in one job, or is in the
 * list's budgetExempt with a reason. A check outside both runs in a job of its own, in parallel with the group, and
 * spends the helper's one Jupiter window beside it.
 */
export function budgetProblems(host, plan, root = ROOT) {
  if (host !== "helper") return [];
  const p = [];
  let list;
  try {
    list = listOf(host, root, { commit: SHA_FULL, network: "mainnet" });
  } catch (e) {
    return [`${host}: ${e.message}`];
  }
  const grouped = new Set(plan.include.filter((e) => e.group).flatMap(keysOf));
  for (const [k, why] of Object.entries(list.budgetExempt)) {
    if (!list.checks.includes(k)) p.push(`${host}: ${k} is exempt from the Jupiter budget group but is no listed check`);
    else if (typeof why !== "string" || why.trim().length < 20) p.push(`${host}: ${k} is exempt from the Jupiter budget group with no reason (at least 20 characters)`);
    else if (grouped.has(k)) p.push(`${host}: ${k} is both in a serial group and exempt from it`);
  }
  for (const e of plan.include) {
    for (const k of keysOf(e)) {
      if (grouped.has(k) || Object.hasOwn(list.budgetExempt, k)) continue;
      const seen = new Set();
      const reads = (f) => {
        const abs = path.resolve(root, f);
        if (seen.has(abs) || !existsSync(abs)) return false;
        seen.add(abs);
        const text = readFileSync(abs, "utf8");
        if (BUDGET_READS.test(text)) return true;
        return [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+\.mjs)["']/g)].some((m) => {
          const next = path.join(path.dirname(f), m[1]);
          return next.startsWith("scripts/") && reads(next);
        });
      };
      if (reads(path.join("scripts/live-checks", `${k}.mjs`))) p.push(`${host}: ${k} reads the helper's Jupiter budget (${BUDGET_READS.source.replace(/\\\//g, "/")}) in a job of its own: put it in a serial group (SERIAL_GROUPS in scripts/ci/helper-live-checks.mjs) so it runs one after another with the others, or list it in BUDGET_EXEMPT with the reason it spends none`);
    }
  }
  return p;
}

/** Every problem in the repository at `root`. */
export async function problems(root = ROOT) {
  const out = [];
  const files = [...filesUnder(path.join(root, ".github/workflows"), (n) => /\.ya?ml$/.test(n)), ...filesUnder(path.join(root, ".github/actions"), (n) => n === "action.yml")];
  for (const f of files) out.push(...fileProblems(path.relative(root, f).split(path.sep).join("/"), readFileSync(f, "utf8")));
  const live = path.join(root, ".github/workflows/live.yml");
  if (existsSync(live)) out.push(...liveProblems(readFileSync(live, "utf8"), Object.keys(HOSTS), (k) => existsSync(path.join(root, "scripts/live-checks", `${k}.mjs`))));
  else out.push(".github/workflows/live.yml: missing");
  for (const h of Object.keys(HOSTS)) out.push(...(await planProblems(h, root)));
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = await problems();
  for (const l of found) console.log(l);
  console.log(found.length ? `live-workflow: FAIL ${found.length} problem${found.length === 1 ? "" : "s"}` : "live-workflow: PASS every action is pinned, no workflow reads a secret, and every live run is a check that exists");
  process.exit(found.length ? 1 : 0);
}
