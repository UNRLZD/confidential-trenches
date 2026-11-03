// Every command and path README.md names runs or exists: a judge or a coding agent who copies one gets it to run.
//   node scripts/ci/readme-commands.mjs [README.md]      (exit 1 and one line per problem)
//   node scripts/ci/readme-commands.mjs --agent-steps [README.md]
//       prints the commands of the "For AI agents and scripts" section, one per line, exactly as README.md writes them
//       (card readme-fresh-run: scripts/ci/readme-fresh-run.mjs runs these on a clean machine, never a copy of them)
//
// What it reads, decided from what README.md writes:
// - Commands: each inline code span and each line of a fenced block, split at `&&`, `||`, `;` and `|`. A piece that
//   starts with `pnpm` names a script unless its command is a pnpm built-in (install, exec, ...): `pnpm run <x>` and
//   `pnpm <x>` (pnpm runs `pnpm test` and `pnpm start` as scripts) must name a script of the root package.json, of the
//   `--dir`/`-C` folder's package.json, of the `--filter` package, or, with `-r`, of at least one workspace package.
// - Paths: a single-word code span, or a word of a command, that holds a `/` and ends in `/` (a folder, as every Layout
//   row writes it) or in a file extension (`scripts/ci/money-gate.mjs`); a word with `*` must match at least one file.
//   `UNRLZD/confidential-trenches-proofs`, a GitHub repository's name, is neither, and URLs (`://`) are skipped.
// - Links: every relative markdown link target and every `src`/`srcset`, without its `#anchor`.
// - `<...>` placeholders and `$VARIABLES` are skipped: they name nothing yet.
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// pnpm 10's own commands; any other word after `pnpm` is a script name (`pnpm test`, `pnpm start`, `pnpm build:vault`)
const BUILTINS = new Set(("add install i ci install-test it update up upgrade remove rm uninstall un link ln unlink import " +
  "rebuild rb prune fetch patch patch-commit patch-remove dedupe exec dlx create init list ls ll la why outdated audit " +
  "licenses store config c get set bin root env setup self-update server deploy pack publish doctor help " +
  "approve-builds ignored-builds cat-file cat-index find-hash").split(" "));
const ARG_FLAGS = new Set(["--dir", "-C", "--filter", "-F", "--workspace-root", "--reporter", "--loglevel"]);

const unquote = (w) => w.replace(/^(['"])(.*)\1$/, "$2");
const placeholder = (w) => /[<>$]/.test(w);

export function workspacePackages(root) {
  const ws = path.join(root, "pnpm-workspace.yaml");
  if (!existsSync(ws)) return [];
  const globs = [...readFileSync(ws, "utf8").matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((m) => m[1]);
  return globs.flatMap((g) => globSync(`${g}/package.json`, { cwd: root })).map((f) => ({
    dir: path.dirname(f).split(path.sep).join("/"),
    pkg: JSON.parse(readFileSync(path.join(root, f), "utf8")),
  }));
}

// the problem with one `pnpm ...` piece, or null
function pnpmProblem(words, root) {
  let dir = null, filter = null, recursive = false, i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-r" || w === "--recursive") recursive = true;
    if (ARG_FLAGS.has(w)) {
      if (w === "--dir" || w === "-C") dir = words[i + 1];
      if (w === "--filter" || w === "-F") filter = words[i + 1];
      i += 2;
    } else i += 1;
  }
  let script = words[i];
  if (script === undefined || BUILTINS.has(script)) return null;
  if (script === "run" || script === "run-script") {
    i += 1;
    while (i < words.length && words[i].startsWith("-")) i += 1;
    script = words[i];
    if (script === undefined) return null; // `pnpm run` alone lists the scripts
  }
  if ([dir, filter, script].some((w) => w && placeholder(w))) return null;
  const has = (pkg) => Object.hasOwn(pkg.scripts ?? {}, script);
  if (dir) {
    const f = path.join(root, dir, "package.json");
    if (!existsSync(f)) return `no package.json in ${dir}`;
    return has(JSON.parse(readFileSync(f, "utf8"))) ? null : `no script "${script}" in ${dir}/package.json`;
  }
  if (filter || recursive) {
    const pkgs = workspacePackages(root).filter(({ dir: d, pkg }) =>
      !filter || pkg.name === filter || d === filter.replace(/^\.\//, "").replace(/\/$/, ""));
    if (filter && !pkgs.length) return `no workspace package "${filter}"`;
    return pkgs.some(({ pkg }) => has(pkg)) ? null : `no script "${script}" in ${filter ? `package "${filter}"` : "any workspace package"}`;
  }
  return has(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))) ? null : `no script "${script}" in package.json`;
}

// a word that names a repo path: a "/" in it, ending in "/" or in a file extension; never a URL or a placeholder
function pathProblem(word, root) {
  const w = unquote(word);
  if (!w.includes("/") || w.includes("://") || w.startsWith("@") || placeholder(w) || /[{}()=:,]/.test(w)) return null;
  if (!/\/$/.test(w) && !/\/[^/]*\.[A-Za-z0-9]+$/.test(w)) return null;
  if (w.includes("*")) return globSync(w, { cwd: root }).length ? null : `no file matches ${w}`;
  return existsSync(path.join(root, w)) ? null : `no such path ${w}`;
}

function linkProblem(target, root) {
  const t = target.trim().replace(/#.*$/, "");
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || placeholder(t)) return null;
  return existsSync(path.join(root, t)) ? null : `no such path ${t}`;
}

// every problem in the README text, as "README.md:<line>: <what>: <problem>", checked against the tree at root
export function problems(text, root) {
  const out = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, n) => {
    const at = (what, p) => p && out.push(`README.md:${n + 1}: ${what}: ${p}`);
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    const code = fence ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const c of code) {
      for (const piece of c.split(/&&|\|\||[;|]/)) {
        const words = piece.trim().split(/\s+/).filter(Boolean).map(unquote);
        while (words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift(); // FOO=bar pnpm ...
        if (words[0] === "pnpm") at(piece.trim(), pnpmProblem(words, root));
        for (const w of words) at(w, pathProblem(w, root));
      }
    }
    if (fence) return;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) at(m[1], linkProblem(m[1], root));
    for (const m of prose.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) at(m[1], linkProblem(m[1].split(/\s/)[0], root));
  });
  return out;
}

export const AGENT_HEADING = /^#{2,4}\s+For AI agents and scripts\s*$/;

// The commands of the first fenced block under the "For AI agents and scripts" heading, one per line, as written. A
// blank line and a `#` comment line are left out. Throws when the heading, its block or a command in it is missing.
export function agentSteps(text) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => AGENT_HEADING.test(l));
  if (at < 0) throw new Error('README has no "For AI agents and scripts" heading');
  const level = /^#+/.exec(lines[at])[0].length;
  let fence = null;
  for (const line of lines.slice(at + 1)) {
    if (fence === null) {
      const h = /^(#+)\s/.exec(line);
      if (h && h[1].length <= level) break; // the next section: no block under this heading
      if (/^\s*```/.test(line)) fence = [];
      continue;
    }
    if (/^\s*```/.test(line)) {
      if (!fence.length) throw new Error("the AI-agent block in README holds no command");
      return fence;
    }
    if (line.trim() && !line.trim().startsWith("#")) fence.push(line.trim());
  }
  throw new Error("README has no fenced block under its \"For AI agents and scripts\" heading");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const steps = args.includes("--agent-steps");
  const file = args.find((a) => !a.startsWith("--")) ?? path.join(root, "README.md");
  if (steps) {
    try {
      console.log(agentSteps(readFileSync(file, "utf8")).join("\n"));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    process.exit(0);
  }
  const found = problems(readFileSync(file, "utf8"), root);
  for (const p of found) console.log(p);
  console.log(found.length ? `${found.length} problem(s)` : "every command and path README.md names runs or exists");
  process.exit(found.length ? 1 : 0);
}
