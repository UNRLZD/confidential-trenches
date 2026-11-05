#!/usr/bin/env node
// Card ci-downloads-retry: one bad answer from a download host never turns a CI job red. PR #278's pool-solana died on
// one 504 from GitHub's release host fetching agave (job 127147701710), PR #279's test-scripts on a 504 that outlasted
// foundryup's own five tries over 31 s (job 127152961657, 5 Nov 09:13Z); each cost a 15-minute rerun.
//   node scripts/ci/download-retry.mjs [root]      (exit 1 and one line per refusal)
// It reads every workflow (.github/workflows/*.yml) and local action (.github/actions/*/action.yml) and refuses, in a
// run step (comment lines left out, a line ending in \ joined to the next):
//  - a curl without curl's own retry, --retry 6 --retry-all-errors, or with a --retry-delay, which turns off curl's
//    doubling wait: six tries wait 1+2+4+8+16+32 = 63 s, past the 504 that lasted at least 31 s (the sha256 check after
//    it stays);
//  - a wget, which carries none of those flags here;
//  - an apt-get in a run step that sets no Acquire::Retries (apt's own retry, with its doubling wait);
//  - a rustup toolchain install (or install, target add, component add), a cargo install or a git submodule update not
//    run through scripts/ci/retry.sh: rustup retries a component at once with no wait (src/dist/manifestation.rs
//    l.800 at 1.29.3, FixedInterval 0), git and cargo install not at all.
// And a foundry-rs/foundry-toolchain step that is not a pair: the action has no retry input (src/index.ts at 908c540),
// so the first step carries an id and continue-on-error: true, and the next foundry-toolchain step in the file, the
// same action and version, runs only if: steps.<id>.outcome == 'failure'.
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CURL_FLAGS = [/\s--retry\s+6(?=\s|$)/, /\s--retry-all-errors(?=\s|$)/];
const CURL_WANT = "--retry 6 --retry-all-errors";
const CURL_NO_DELAY = /\s--retry-delay(?=\s|$)/;
const NET_TOOL = /\b(rustup\s+(?:toolchain\s+install|install|target\s+add|component\s+add)|cargo\s+(?:\+\S+\s+)?install|git\s+submodule\s+update)\b/;
const RETRY = "scripts/ci/retry.sh";
const word = (w) => new RegExp(`(?:^|[\\s;&|(\`$])${w}(?=\\s|$)`);

/** The run steps of a workflow's text: [{ line, cmds: [[line, command]] }], comment lines dropped, \ lines joined. */
export function runSteps(yml) {
  const lines = yml.split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    if (/^[|>][-+]?\s*$/.test(m[2])) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && lines[j].match(/^ */)[0].length <= m[1].length) break;
        body.push([j + 1, lines[j]]);
      }
    } else body.push([i + 1, m[2].replace(/^(['"])(.*)\1$/, "$2")]);
    const cmds = [];
    let at = null;
    let text = "";
    for (const [n, l] of body) {
      if (at === null && /^\s*#/.test(l)) continue;
      if (at === null) at = n;
      text += `${l.trim()} `;
      if (/\\$/.test(l.trimEnd())) text = text.replace(/\\\s*$/, " ");
      else {
        if (text.trim()) cmds.push([at, text.trim()]);
        at = null;
        text = "";
      }
    }
    if (text.trim()) cmds.push([at, text.trim()]);
    steps.push({ line: i + 1, cmds });
  }
  return steps;
}

/** The step (its lines' [number, text]) that holds line index i: from its "- " item to the next item or dedent. */
function stepAt(lines, i) {
  let s = i;
  while (s >= 0 && !/^\s*- /.test(lines[s])) s--;
  const indent = lines[s].match(/^ */)[0].length;
  const out = [];
  for (let j = s; j < lines.length; j++) {
    if (j > s && lines[j].trim() && lines[j].match(/^ */)[0].length <= indent) break;
    out.push([j + 1, lines[j]]);
  }
  return out;
}
const field = (step, key) => {
  for (const [, l] of step) {
    const m = new RegExp(`^\\s*(?:- )?${key}:\\s*(.*?)\\s*(?:#.*)?$`).exec(l);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2");
  }
  return null;
};

/** The refusals in one workflow's text: [line, what]. */
export function refusals(yml) {
  const out = [];
  for (const step of runSteps(yml)) {
    const all = step.cmds.map(([, c]) => c).join("\n");
    for (const [n, cmd] of step.cmds) {
      for (const seg of cmd.split(/&&|\|\||[;|]/)) {
        if (word("curl").test(seg) && !CURL_FLAGS.every((f) => f.test(seg))) out.push([n, `a curl without ${CURL_WANT}: ${seg.trim()}`]);
        if (word("curl").test(seg) && CURL_NO_DELAY.test(seg)) out.push([n, `a curl with --retry-delay, which turns off curl's doubling wait: ${seg.trim()}`]);
        if (word("wget").test(seg)) out.push([n, `a wget, with no retry here; use curl ${CURL_WANT}: ${seg.trim()}`]);
        if (word("apt-get").test(seg) && !/Acquire::Retries=\d/.test(all)) out.push([n, `an apt-get in a step that sets no Acquire::Retries: ${seg.trim()}`]);
        const tool = NET_TOOL.exec(seg);
        if (tool && !seg.slice(0, tool.index).includes(RETRY)) out.push([n, `${tool[1].replace(/\s+/g, " ")} not run through ${RETRY}: ${seg.trim()}`]);
      }
    }
  }
  out.push(...foundryPairs(yml).problems);
  return out.sort((a, b) => a[0] - b[0]);
}

/** The foundry-toolchain steps' pairs: problems as [line, what], and the line index of each held pair's
 * continue-on-error: true (its second run, in the same job, fails the job when the install fails twice). */
export function foundryPairs(yml) {
  const out = [];
  const held = [];
  const lines = yml.split(/\r?\n/);
  const foundry = [];
  lines.forEach((l, i) => /^\s*(?:- )?uses:\s*foundry-rs\/foundry-toolchain@/.test(l) && foundry.push(i));
  for (let k = 0; k < foundry.length; k++) {
    const first = stepAt(lines, foundry[k]);
    const at = foundry[k] + 1;
    const id = field(first, "id");
    if (field(first, "if") !== null && /\.outcome\s*==\s*'failure'/.test(field(first, "if"))) {
      out.push([at, "a foundry-toolchain retry with no first step before it"]);
      continue;
    }
    if (!id || field(first, "continue-on-error") !== "true") {
      out.push([at, "a foundry-toolchain step without an id and continue-on-error: true, so it has no second run"]);
      continue;
    }
    const next = foundry[k + 1];
    const second = next === undefined ? null : stepAt(lines, next);
    const cond = second && field(second, "if");
    const sameJob = next !== undefined && !lines.slice(foundry[k], next).some((l) => /^ {2}[\w-]+:\s*$/.test(l));
    if (!second || !sameJob || !cond || !new RegExp(`^steps\\.${id}\\.outcome\\s*==\\s*'failure'$`).test(cond.replace(/^\$\{\{\s*|\s*\}\}$/g, ""))) {
      out.push([at, `a foundry-toolchain step with no second run after it (if: steps.${id}.outcome == 'failure')`]);
      continue;
    }
    if (lines[next].trim().replace(/^- /, "") !== lines[foundry[k]].trim().replace(/^- /, "") || field(second, "version") !== field(first, "version") || field(second, "continue-on-error") === "true") {
      out.push([next + 1, "a foundry-toolchain second run that is not the same action and version, or does not fail the job"]);
    } else held.push(first.find(([, l]) => /^\s*(?:- )?continue-on-error:\s*true\s*(?:#.*)?$/.test(l))[0] - 1);
    k++;
  }
  return { problems: out, held };
}

/** The workflow's text with each held foundry-toolchain pair's continue-on-error: true turned into a comment, line
 * for line: for a gate that refuses any step that may fail (scripts/ci/test-shards.test.mjs), since a held pair's
 * second run fails the job when the install fails twice. */
export function withoutHeldRetries(yml) {
  const held = new Set(foundryPairs(yml).held);
  return yml.split("\n").map((l, i) => (held.has(i) ? l.replace(/continue-on-error:\s*true/, "# a held retry") : l)).join("\n");
}

export function downloadRetry(root) {
  const files = [];
  const wf = `${root}/.github/workflows`;
  if (existsSync(wf)) for (const f of readdirSync(wf).sort()) /\.ya?ml$/.test(f) && files.push(`.github/workflows/${f}`);
  const ac = `${root}/.github/actions`;
  if (existsSync(ac)) for (const d of readdirSync(ac).sort()) for (const f of ["action.yml", "action.yaml"]) existsSync(`${ac}/${d}/${f}`) && files.push(`.github/actions/${d}/${f}`);
  const out = [];
  for (const f of files) for (const [line, what] of refusals(readFileSync(`${root}/${f}`, "utf8"))) out.push(`${f}:${line}: ${what}`);
  return { refusals: out, read: files.length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = downloadRetry(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`download-retry: REFUSED: ${x}`);
  if (r.refusals.length || !r.read) {
    if (!r.read) console.error("download-retry: no workflow read");
    process.exit(1);
  }
  console.log(`download-retry: OK (${r.read} workflow file(s) read)`);
}
