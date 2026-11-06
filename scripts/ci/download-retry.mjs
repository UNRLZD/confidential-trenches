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
//  - an apt-get in a run step that sets no Acquire::Retries (apt's own retry, with its doubling wait), as an -o option
//    (Acquire::Retries=5) or as an apt.conf line the step writes (Acquire::Retries "5");
//  - a rustup toolchain install (or install, target add, component add), a cargo install or a git submodule update not
//    run through scripts/ci/retry.sh: rustup retries a component at once with no wait (src/dist/manifestation.rs
//    l.800 at 1.29.3, FixedInterval 0), git and cargo install not at all.
// And a foundry-rs/foundry-toolchain step that is not a pair: the action has no retry input (src/index.ts at 908c540),
// so the first step carries an id and continue-on-error: true, and the next foundry-toolchain step in the file, the
// same action and version, runs only if: steps.<id>.outcome == 'failure'.
// Card ci-cargo-near-cached: a retry does not outlast a host that answers 504 for over a minute (PR #293's
// vault-sandbox-build, job 127307073012: seven 504s in 63 s from github.com/near/cargo-near/releases) or an apt mirror
// that crawls at kB/s (live run 42044118472: 20 min in `playwright install --with-deps`, no check started). So a
// download that is the same bytes every run comes from actions/cache, and the gate also refuses (cacheRefusals):
//  - a curl that writes a file (-o, --output, -O): a pinned file goes through scripts/ci/fetch.sh, which checks its
//    sha256 after a restore and after a fetch. The one curl to a file left is an apt repository's signing key, checked
//    by its fingerprint in the same step (gpg --show-keys): it must be the current key, so it is never cached;
//  - a fetch.sh with no actions/cache (or actions/cache/restore) step before it in its job whose path holds its file and
//    whose key names its sha256, or a restore with no actions/cache/save of the same path and key after it (a restore
//    alone never fills);
//  - a `playwright install` or `install-deps` (but --dry-run) with no cache before it in its job that holds
//    ~/.cache/ms-playwright; and one that installs system packages (--with-deps, install-deps) must keep apt's .debs
//    (Dir::Cache::Archives in the step) in a second path of that cache, so a hit installs them with no mirror, and
//    runs under `timeout` on the same command line: a miss still meets the mirror, and live run 42059594658's job
//    127357435385 crawled 19.5 min on azure.archive.ubuntu.com until the job's limit cancelled it;
// and scripts/ci/fetch.sh's own curl without curl's retry, as a workflow's.
// Card ci-cargo-fetch-retry: crates.io answered one bad read and main's test-vault went red twice (runs 42146603371 and
// 42148449367: ark-poly, curl [56] "OpenSSL SSL_read: unexpected eof" in "Updating crates.io index"); cargo's own three
// tries come at once. So the gate also refuses (cargoRefusals), per job:
//  - a cargo command that resolves crates (test, build, check, clippy, run, bench, doc, fetch, tree, vendor, update,
//    near build, build-sbf, cargo-build-sbf) with no `scripts/ci/retry.sh cargo [+toolchain] fetch --locked` of its
//    manifest before it in the job (--manifest-path, else the step's working-directory, else ./Cargo.toml), unless
//    the command itself runs through retry.sh;
//  - a cargo fetch not run through retry.sh, or without --locked;
//  - a retried fetch in a job with no cache of cargo's registry before it (Swatinem/rust-cache, or actions/cache
//    holding ~/.cargo/registry), so a blip is read from the cache when the lock has not moved;
//  - a script that builds crates itself (CARGO_SCRIPTS: the sandbox harness's run.sh, the Solana dry run) with the
//    fetch of each manifest it builds not before it in the job;
//  - deploy.mjs --build-only or --verify-records not run through retry.sh: cargo-near builds them in a container,
//    where no fetch from the runner reaches.
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

/** What is wrong with one curl command's retry: [what]. */
function curlProblems(seg) {
  const out = [];
  if (!CURL_FLAGS.every((f) => f.test(seg))) out.push(`a curl without ${CURL_WANT}: ${seg.trim()}`);
  if (CURL_NO_DELAY.test(seg)) out.push(`a curl with --retry-delay, which turns off curl's doubling wait: ${seg.trim()}`);
  return out;
}

/** The refusals in one workflow's text: [line, what]. */
export function refusals(yml) {
  const out = [];
  for (const step of runSteps(yml)) {
    const all = step.cmds.map(([, c]) => c).join("\n");
    for (const [n, cmd] of step.cmds) {
      for (const seg of cmd.split(/&&|\|\||[;|]/)) {
        if (word("curl").test(seg)) for (const w of curlProblems(seg)) out.push([n, w]);
        if (word("wget").test(seg)) out.push([n, `a wget, with no retry here; use curl ${CURL_WANT}: ${seg.trim()}`]);
        if (word("apt-get").test(seg) && !/Acquire::Retries(?:=|\s+")\d/.test(all)) out.push([n, `an apt-get in a step that sets no Acquire::Retries: ${seg.trim()}`]);
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

const FETCH = "scripts/ci/fetch.sh";
const FETCH_CMD = /(?:^|\s)(?:bash\s+)?(?:\.\/)?scripts\/ci\/fetch\.sh(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?/;
const CURL_TO_FILE = /\s(?:-[a-zA-Z]*[oO]|--output|--remote-name(?:-all)?)(?=\s|$)/;
const PLAYWRIGHT = /\bplaywright\s+(install(?:-deps)?)(?=\s|$)/;
const MS_PLAYWRIGHT = "~/.cache/ms-playwright";
const unquote = (x) => x.replace(/^(['"])(.*)\1$/, "$2");
const home = (x) => unquote(x).replace(/^(?:\$HOME|\$\{HOME\})\//, "~/");

/** Each job's steps (workflows' jobs and a composite action's runs): [{ job, steps: [[line, text]][] }], 1-based lines. */
export function jobSteps(yml) {
  const lines = yml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)steps:\s*(?:#.*)?$/.exec(lines[i]);
    if (!m) continue;
    let job = "";
    for (let j = i - 1; j >= 0; j--) {
      const h = /^ {2}([\w-]+):\s*$/.exec(lines[j]);
      if (h) { job = h[1]; break; }
      if (/^\S/.test(lines[j])) break;
    }
    const item = new RegExp(`^ {${m[1].length + 2}}- `);
    const steps = [];
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k];
      if (l.trim() && !/^\s*#/.test(l) && l.match(/^ */)[0].length <= m[1].length) break;
      if (item.test(l)) steps.push([]);
      if (steps.length) steps.at(-1).push([k + 1, l]);
    }
    out.push({ job, steps });
  }
  return out;
}

/** A step field's values: one, or each line of a | or > block. */
function values(step, key) {
  for (let i = 0; i < step.length; i++) {
    const m = new RegExp(`^( *)(?:- )?${key}:\\s*(.*?)\\s*(?:#.*)?$`).exec(step[i][1]);
    if (!m) continue;
    if (!/^[|>][-+]?$/.test(m[2])) return m[2] ? [unquote(m[2])] : [];
    const out = [];
    for (let j = i + 1; j < step.length && (!step[j][1].trim() || step[j][1].match(/^ */)[0].length > m[1].length); j++) if (step[j][1].trim()) out.push(step[j][1].trim());
    return out;
  }
  return [];
}
/** "" for actions/cache, "/restore" or "/save" for its two halves, null for any other step. */
function cacheKind(step) {
  const m = /^actions\/cache(\/restore|\/save)?@/.exec(field(step, "uses") ?? "");
  return m ? (m[1] ?? "") : null;
}

/** The cache rules' refusals in one workflow's text: [line, what]. */
export function cacheRefusals(yml) {
  const out = [];
  const cmds = new Map(runSteps(yml).map((r) => [r.line, r.cmds]));
  for (const { steps } of jobSteps(yml)) {
    steps.forEach((step, at) => {
      const runAt = step.find(([n]) => cmds.has(n));
      if (!runAt) return;
      const all = cmds.get(runAt[0]);
      const text = all.map(([, c]) => c).join("\n");
      // a cache step before this one, in its job, holding every path `want` names and keyed so `keyOk` holds
      const cacheFor = (want, keyOk) => {
        for (let b = at - 1; b >= 0; b--) {
          const kind = cacheKind(steps[b]);
          if (kind !== "" && kind !== "/restore") continue;
          const paths = values(steps[b], "path").map(home);
          const key = field(steps[b], "key") ?? "";
          if (!want(paths) || !keyOk(key)) continue;
          const saved = kind === "" || steps.slice(at + 1).some((s) => cacheKind(s) === "/save" && field(s, "key") === key && JSON.stringify(values(s, "path").map(home)) === JSON.stringify(paths));
          return { paths, saved };
        }
        return null;
      };
      const held = (c, n, what) => {
        if (!c) out.push([n, `${what} with no cache step before it in its job`]);
        else if (!c.saved) out.push([n, `${what}: its cache is an actions/cache/restore with no actions/cache/save of the same path and key after it`]);
      };
      for (const [n, cmd] of all) {
        for (const seg of cmd.split(/&&|\|\||[;|]/)) {
          if (word("curl").test(seg) && CURL_TO_FILE.test(` ${seg}`) && !/\bgpg\s+--show-keys\b/.test(text)) {
            out.push([n, `a curl to a file: a pinned file goes through ${FETCH}, behind a cache: ${seg.trim()}`]);
          }
          const f = FETCH_CMD.exec(seg);
          if (f) {
            const [, file, sum, url] = f;
            if (!file || !url || !/^[0-9a-f]{64}$/.test(sum ?? "")) { out.push([n, `a ${FETCH} without a file, a sha256 and a url: ${seg.trim()}`]); continue; }
            held(cacheFor((p) => p.includes(home(file)), (k) => k.includes(sum)), n, `a ${FETCH} of ${home(file)} (sha256 ${sum.slice(0, 8)})`);
          }
          const pw = PLAYWRIGHT.exec(seg);
          if (pw && !/\s--dry-run(?=\s|$)/.test(seg)) {
            const deps = pw[1] === "install-deps" || /\s--with-deps(?=\s|$)/.test(seg);
            const named = (p) => p !== MS_PLAYWRIGHT && (text.includes(p) || text.includes(p.replace(/^~\//, "$HOME/")));
            const c = cacheFor((p) => p.includes(MS_PLAYWRIGHT) && (!deps || p.some(named)), () => true);
            held(c, n, `a playwright ${pw[1]}${deps ? " of system packages" : ""}`);
            if (c && deps && !/Dir::Cache::Archives/i.test(text)) out.push([n, "a playwright install of system packages that does not keep apt's .debs (Dir::Cache::Archives) for its cache"]);
            if (deps && !/(?:^|[\s;&|({])timeout\s+(?:-\S+\s+(?:\d+[smh]?\s+)?)*\d+[smh]?\s/.test(seg.slice(0, pw.index))) out.push([n, "a playwright install of system packages with no timeout on its command line: a crawling mirror holds it to the job's limit"]);
          }
        }
      }
    });
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** fetch.sh's own curl: the same retry as a workflow's. */
export function fetchScriptRefusals(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*#/.test(l) || !word("curl").test(l)) return;
    for (const w of curlProblems(l)) out.push([i + 1, w]);
  });
  if (!out.length && !text.split(/\r?\n/).some((l) => !/^\s*#/.test(l) && word("curl").test(l))) out.push([1, "no curl in it"]);
  return out;
}

// Cargo's subcommands that read the registry. `metadata` only without --no-deps.
const CARGO_CMD = /(?:^|[\s;&|(`$])cargo((?:\s+\+\S+)?)\s+(test|build|check|clippy|run|bench|doc|rustdoc|fetch|tree|vendor|update|metadata|near\s+build|build-sbf)(?=\s|$)/;
const SBF_CMD = /(?:^|[\s;&|(`$])cargo-build-sbf(?=\s|$)/;
const CONTAINER_BUILD = /\bdeploy\.mjs\b.*\s--(?:build-only|verify-records)(?=\s|$)/;
const VAULT_MANIFESTS = ["contracts/vault/Cargo.toml", "contracts/vault/tests/mock-token/Cargo.toml", "contracts/vault/tests/harness/probe/Cargo.toml"];
/** Scripts that run cargo themselves, with the manifests they build: each must be fetched, with retry, before them. */
export const CARGO_SCRIPTS = [
  ["harness/run.sh", VAULT_MANIFESTS],
  ["pool-solana/scripts/dry-run.sh", ["contracts/pool-solana/Cargo.toml"]],
];
const manifestOf = (p) => p.replace(/^\.\//, "").replace(/\/\.\//g, "/").replace(/\/+/g, "/");
/** True when a step before index `at` in a job caches cargo's registry. */
function registryCached(steps, at) {
  return steps.slice(0, at).some((s) => /^Swatinem\/rust-cache@/.test(field(s, "uses") ?? "") || ((cacheKind(s) === "" || cacheKind(s) === "/restore") && values(s, "path").some((x) => home(x).startsWith("~/.cargo/registry"))));
}

/** The cargo rules' refusals in one workflow's text: [line, what]. */
export function cargoRefusals(yml) {
  const out = [];
  const cmds = new Map(runSteps(yml).map((r) => [r.line, r.cmds]));
  for (const { steps } of jobSteps(yml)) {
    const fetched = new Set();
    steps.forEach((step, at) => {
      const runAt = step.find(([n]) => cmds.has(n));
      if (!runAt) return;
      const dir = field(step, "working-directory");
      const manifestIn = (seg) => manifestOf(unquote(/--manifest-path(?:\s+|=)(\S+)/.exec(seg)?.[1] ?? `${dir ? `${dir}/` : ""}Cargo.toml`));
      for (const [n, cmd] of cmds.get(runAt[0])) {
        for (const seg of cmd.split(/&&|\|\||[;|]/)) {
          const retried = (idx) => seg.slice(0, idx).includes(RETRY);
          const need = (what, idx, m) => {
            if (!retried(idx) && !fetched.has(m)) out.push([n, `${what} of ${m} with no ${RETRY} cargo fetch --locked of it before it in its job: ${seg.trim()}`]);
          };
          const c = CARGO_CMD.exec(seg);
          if (c && !(c[2] === "metadata" && /\s--no-deps(?=\s|$)/.test(seg))) {
            const sub = c[2].replace(/\s+/g, " ");
            if (sub !== "fetch") need(`a cargo ${sub}`, c.index, manifestIn(seg));
            else if (!retried(c.index)) out.push([n, `a cargo fetch not run through ${RETRY}: ${seg.trim()}`]);
            else if (!/\s--locked(?=\s|$)/.test(seg)) out.push([n, `a cargo fetch without --locked: ${seg.trim()}`]);
            else {
              if (!registryCached(steps, at)) out.push([n, `a cargo fetch in a job with no cache of cargo's registry before it (Swatinem/rust-cache, or actions/cache on ~/.cargo/registry): ${seg.trim()}`]);
              fetched.add(manifestIn(seg));
            }
          }
          const sbf = SBF_CMD.exec(seg);
          if (sbf && !/\s(?:--version|-V|--help|-h)(?=\s|$)/.test(seg)) need("a cargo-build-sbf", sbf.index, manifestIn(seg));
          for (const [script, ms] of CARGO_SCRIPTS) {
            const at2 = seg.indexOf(script);
            if (at2 < 0 || retried(at2)) continue;
            const missing = ms.filter((m) => !fetched.has(m));
            if (missing.length) out.push([n, `${script}, which builds crates itself, with no ${RETRY} cargo fetch --locked before it in its job of: ${missing.join(", ")}`]);
          }
          if (CONTAINER_BUILD.test(seg) && !retried(seg.indexOf("deploy.mjs"))) {
            out.push([n, `a deploy.mjs build in cargo-near's container, which no fetch from the runner reaches, not run through ${RETRY}: ${seg.trim()}`]);
          }
        }
      }
    });
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function downloadRetry(root) {
  const files = [];
  const wf = `${root}/.github/workflows`;
  if (existsSync(wf)) for (const f of readdirSync(wf).sort()) /\.ya?ml$/.test(f) && files.push(`.github/workflows/${f}`);
  const ac = `${root}/.github/actions`;
  if (existsSync(ac)) for (const d of readdirSync(ac).sort()) for (const f of ["action.yml", "action.yaml"]) existsSync(`${ac}/${d}/${f}`) && files.push(`.github/actions/${d}/${f}`);
  const out = [];
  for (const f of files) {
    const yml = readFileSync(`${root}/${f}`, "utf8");
    for (const [line, what] of [...refusals(yml), ...cacheRefusals(yml), ...cargoRefusals(yml)].sort((a, b) => a[0] - b[0])) out.push(`${f}:${line}: ${what}`);
  }
  if (existsSync(`${root}/${FETCH}`)) for (const [line, what] of fetchScriptRefusals(readFileSync(`${root}/${FETCH}`, "utf8"))) out.push(`${FETCH}:${line}: ${what}`);
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
