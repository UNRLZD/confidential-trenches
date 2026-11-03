// Card readme-fresh-run: a package's default `test` script runs on a machine with no Chrome, no Rust, no key and no
// route out: a reviewer's, a judge's, an AI screener's. This gate fails when a default test reaches one of them.
//   node scripts/ci/default-tests.mjs [root]      (exit 1 and one line per problem)
//
// Reach is read from the text, the way a reader follows it. Each workspace package's `test` script (and a `pnpm run
// <script>` it calls in the same package) names `node` runs; their files and globs (node --test "test/*.test.mjs")
// are expanded; those are the test files. Every file a test file imports by a relative path (import, export from,
// import(), require(), new URL("./x", import.meta.url)) is read too, down to the last one. In the script and in each
// file, comments left out, a hit is:
// - a browser: a call of launchBrowser or launchDiskProfile, or the name playwright (scripts/browsers.mjs, the one
//   launcher, is not read: importing it launches nothing);
// - a Rust build tool: cargo, cargo-near, cargo-build-sbf, rustc, rustup;
// - a key: process.env.<NAME>, NAME holding KEY, JWT, SECRET, TOKEN or PASSWORD as a whole word (ONECLICK_API_KEY, not
//   PASSKEY_SRC), with no default after it (`?? x`, `|| x`).
// A test file is read whole. A module it imports is read where it runs when imported: at the top level and inside a
// test(, it( or describe( call; its function bodies are definitions (packages/signpage's deploy.mjs imports a
// live check that defines a function opening a browser, and its test never calls it).
//
// A vendor host has no static test here: the tests name vendor hosts as data for stubs (api.jup.ag, 1click...), so a
// text scan fails on a stub. A call into a function that launches, or that fetches, is not seen either. The run is
// the check for both: readme-fresh-run.mjs runs every step but the clone and the install under no-network.mjs
// (a connection to any host but this machine is refused), on a machine whose Chrome and Rust are hidden.
//
// One way past a hit: the test that holds it is switched off unless asked for, as packages/kit's prove-e2e is:
//   test("...", { skip: process.env.KIT_PROVER_E2E === "1" ? false : "KIT_PROVER_E2E=1 runs it" }, async () => { ... })
// (also `skip: process.env.X !== "1"` and `skip: !process.env.X`). A hit counts as guarded only when the nearest
// test(, it( or describe( before it carries that skip.
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePackages } from "./readme-commands.mjs";

export const LAUNCHER = "scripts/browsers.mjs";
const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|mts|cts)$/;
const SECRET_WORDS = "KEY|JWT|SECRET|TOKEN|PASSWORD";
const KEY_NAME = new RegExp(`^(?:[A-Za-z0-9]+_)*(?:${SECRET_WORDS})(?:_[A-Za-z0-9]+)*$`);
const DEFAULTED = /^\s*(?:\?\?|\|\|)\s*\S/;

const OPT_IN = [
  /skip\s*:\s*process\.env\.[A-Za-z0-9_]+\s*={2,3}\s*["'][^"']*["']\s*\?\s*false/,
  /skip\s*:\s*process\.env\.[A-Za-z0-9_]+\s*!==?\s*["'][^"']*["']/,
  /skip\s*:\s*!\s*process\.env\.[A-Za-z0-9_]+/,
];
const TEST_START = /^[ \t]*(?:await\s+)?(?:test|it|describe|suite)(?:\.\w+)?\(/gm;

/** `text` with its comments replaced by spaces (same length, so offsets and lines hold); quotes are respected. */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null; // ' " or ` while inside a string
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = null;
      else if (c === "\n" && quote !== "`") quote = null;
      i++;
    } else if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") (out += " "), i++;
    } else if (c === "/" && d === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) (out += text[i] === "\n" ? "\n" : " "), i++;
      out += "  ";
      i += 2;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i++;
    }
  }
  return out;
}

// `text` (comments already out) with the inside of every string blanked, so its braces and parens count for nothing
function skeleton(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i++;
      } else if (c === quote) {
        quote = null;
        out += c;
      } else out += c === "\n" ? "\n" : " ";
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/** What is executed on import in `text`: a function from an offset to whether code there runs at the top level or in a test call. */
function runsOnImport(text) {
  const sk = skeleton(text);
  const depth = new Int32Array(sk.length + 1);
  let d = 0;
  for (let i = 0; i < sk.length; i++) {
    if (sk[i] === "{") d++;
    else if (sk[i] === "}") d = Math.max(0, d - 1);
    depth[i] = d;
  }
  const regions = [];
  for (const m of sk.matchAll(TEST_START)) {
    let p = 0;
    let end = m.index + m[0].length;
    p = 1;
    while (end < sk.length && p > 0) {
      if (sk[end] === "(") p++;
      else if (sk[end] === ")") p--;
      end++;
    }
    regions.push([m.index, end]);
  }
  return (i) => depth[i] === 0 || regions.some(([a, b]) => i >= a && i < b);
}

/** The relative script paths a text imports: { spec, at } for each, `at` being its offset. */
export function relativeImports(text) {
  const out = [];
  const add = (re) => {
    for (const m of text.matchAll(re)) out.push({ spec: m[1], at: m.index });
  };
  add(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g);
  add(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/g);
  add(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g);
  add(/\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g);
  add(/\bnew\s+URL\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\b/g);
  return out;
}

function resolveImport(root, from, spec) {
  let p = path.resolve(path.dirname(from), spec);
  if (!SCRIPT_EXT.test(spec) && !existsSync(p)) p = [".ts", ".mjs", ".js", ".mts", ".cjs"].map((e) => p + e).find(existsSync) ?? p;
  return existsSync(p) && SCRIPT_EXT.test(p) && p.startsWith(root + path.sep) && !p.includes(`${path.sep}node_modules${path.sep}`) ? p : null;
}

/** Whether the nearest test( / it( / describe( before `end` carries an env opt-in skip. */
export function guarded(text, end) {
  let start = -1;
  for (const m of text.slice(0, end).matchAll(TEST_START)) start = m.index;
  return start >= 0 && OPT_IN.some((re) => re.test(text.slice(start, end)));
}

// words of a shell segment, quotes removed
const words = (seg) => [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** What a package's test script runs: { files: [abs path], texts: [the script's own text, and each `node -e` code] }. */
export function scriptReach(pkgDir, scripts, name = "test", seen = new Set()) {
  const out = { files: [], texts: [] };
  if (seen.has(name) || typeof scripts[name] !== "string") return out;
  seen.add(name);
  out.texts.push(scripts[name]);
  for (const seg of scripts[name].split(/&&|\|\||;/)) {
    const w = words(seg.trim());
    if (w[0] === "pnpm" && (w[1] === "run" || scripts[w[1]])) {
      const inner = scriptReach(pkgDir, scripts, w[1] === "run" ? w[2] : w[1], seen);
      out.files.push(...inner.files);
      out.texts.push(...inner.texts);
    }
    if (w[0] !== "node") continue;
    const test = w.includes("--test");
    for (let i = 1; i < w.length; i++) {
      if (["-e", "--eval", "-p", "--print"].includes(w[i])) out.texts.push(w[++i] ?? "");
      else if (["--import", "--require", "-r"].includes(w[i])) i++;
      else if (!w[i].startsWith("-")) {
        for (const f of /[*?[{]/.test(w[i]) ? globSync(w[i], { cwd: pkgDir }) : [w[i]]) {
          const p = path.resolve(pkgDir, f);
          if (existsSync(p)) out.files.push(p);
        }
        if (!test) break;
      }
    }
  }
  return out;
}

// every hit in a comment-free text: { at, what, text }; a key read with a default is no hit
function hits(text) {
  const out = [];
  for (const m of text.matchAll(/\b(launchBrowser|launchDiskProfile)\s*\(/g)) out.push({ at: m.index, what: "a browser launch", text: m[1] });
  for (const m of text.matchAll(/\bplaywright\b/gi)) out.push({ at: m.index, what: "playwright", text: m[0] });
  for (const m of text.matchAll(/\b(?:cargo(?:-[a-z]+)*|rustc|rustup)\b/g)) out.push({ at: m.index, what: "a Rust build tool", text: m[0] });
  const key = (at, name, after) => {
    if (KEY_NAME.test(name) && !DEFAULTED.test(after)) out.push({ at, what: "a key read with no default", text: `process.env.${name}` });
  };
  for (const m of text.matchAll(/\bprocess\.env\.([A-Za-z0-9_]+)/g)) key(m.index, m[1], text.slice(m.index + m[0].length, m.index + m[0].length + 40));
  for (const m of text.matchAll(/\bprocess\.env\[\s*["'`]([A-Za-z0-9_]+)["'`]\s*\]/g)) key(m.index, m[1], text.slice(m.index + m[0].length, m.index + m[0].length + 40));
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const part of m[1].split(",")) {
      const [name, dflt] = part.split("=").map((s) => s.trim());
      const [prop, bound] = (name ?? "").split(":").map((s) => s.trim());
      if (prop && dflt === undefined && !/^_/.test(bound ?? "")) key(m.index, prop, ""); // `NAME: _` drops the variable
    }
  }
  return out;
}

/** One line per problem in the repository at `root`; an empty list is a pass. */
export const problems = (root) => check(root).problems;

/** { problems, files }: the problems, and every file read (repository paths), so a test can see the scan reached them. */
export function check(root) {
  root = path.resolve(root);
  const found = [];
  const files = new Set();
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  for (const { dir, pkg } of workspacePackages(root)) {
    if (!pkg.scripts?.test) continue;
    const label = `${dir} test`;
    const reach = scriptReach(path.join(root, dir), pkg.scripts);
    for (const t of reach.texts) for (const h of hits(stripComments(t))) found.push(`${label} script: ${h.what}: ${h.text}`);
    const entries = new Set(reach.files);
    const seen = new Set();
    const queue = reach.files.map((file) => ({ file, via: null }));
    while (queue.length) {
      const { file, via } = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      files.add(rel(file));
      if (rel(file) === LAUNCHER) continue; // the one launcher: importing it launches nothing, a call of it is the hit
      const text = stripComments(readFileSync(file, "utf8"));
      const runs = entries.has(file) ? () => true : runsOnImport(text);
      for (const h of hits(text)) {
        if (!runs(h.at) || guarded(text, h.at + h.text.length)) continue;
        const line = text.slice(0, h.at).split("\n").length;
        found.push(`${label}: ${rel(file)}:${line}${via ? ` (imported from ${via})` : ""}: ${h.what}: ${h.text}`);
      }
      for (const { spec } of relativeImports(text)) {
        const to = resolveImport(root, file, spec);
        if (to) queue.push({ file: to, via: rel(file) });
      }
    }
  }
  return { problems: [...new Set(found)], files: [...files].sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const found = problems(root);
  for (const p of found) console.log(p);
  console.log(found.length ? `${found.length} problem(s): a default test needs a browser, Rust or a key` : "every package's default test script reaches no browser, no Rust build and no key");
  process.exit(found.length ? 1 : 0);
}
