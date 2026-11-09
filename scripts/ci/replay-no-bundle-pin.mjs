#!/usr/bin/env node
// Card held-move-replay-any-build: a live check's replay judges the tree's build with the live rule, never by its bytes.
// A replay that asserts the hash of a bundle it read equal to a recorded hash makes every signing page card re-record
// that check's good answer (PR #501 failed CI test-packages on wallet-restore-id-reader's "the bundle as recorded",
// 8 Nov 23:17Z). This gate refuses one:
//   node scripts/ci/replay-no-bundle-pin.mjs [root]      (exit 1 and one line per refusal)
// It reads every scripts/live-checks/*.test.mjs git lists (tracked, and untracked but not ignored) and refuses an
// equality that pins a hash: an assert.equal, strictEqual, deepEqual or deepStrictEqual call, or an === or ==, whose
// one side is a recorded hash (a path from `answers` or `ANSWERS` ending in .sha384, or a "sha384-…" literal) and whose
// other side is a hash read from elsewhere (an expression naming sha384 that is neither). Two recorded hashes compared
// (a record against its own literal, or two records apart) and a hash used as a lookup key pass: neither reads the tree.
// Risk it holds: a replay that pins the tree's bytes fails every build but the one recorded, so a card that changes
// nothing the check reads still has to re-record it.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GLOB = "scripts/live-checks/*.test.mjs";
const RECORDED = [/^(?:answers|ANSWERS)(?:\.[\w$]+|\[[^\]]+\])*\.sha384$/, /^(["'`])sha384-[A-Za-z0-9+/=]*\1$/];
const isRecorded = (e) => RECORDED.some((re) => re.test(e));
const pins = (a, b) => (isRecorded(a) && !isRecorded(b) && /sha384/.test(b)) || (isRecorded(b) && !isRecorded(a) && /sha384/.test(a));

/** The top-level arguments of the call whose "(" is at `open` in `text` (strings, templates and nesting skipped). */
function argsAt(text, open) {
  const out = [];
  let depth = 0, start = open + 1, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth === 0) {
        out.push(text.slice(start, i));
        return out.map((s) => s.trim());
      }
    } else if (c === "," && depth === 1) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return out.map((s) => s.trim());
}

/** The pinning equalities in one test file's text: [line number, the statement's text]. */
export function bundlePins(text) {
  const out = [];
  const lineOf = (at) => text.slice(0, at).split("\n").length;
  for (const m of text.matchAll(/\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g)) {
    const [a = "", b = ""] = argsAt(text, m.index + m[0].length - 1);
    if (pins(a, b)) out.push([lineOf(m.index), `${m[0]}${a}, ${b})`]);
  }
  // a bare === or == between two operands of names, dots, brackets and strings
  const operand = String.raw`(?:[\w$.]+(?:\[[^\]\n]*\])*|"[^"\n]*"|'[^'\n]*')`;
  for (const m of text.matchAll(new RegExp(String.raw`(${operand})\s*===?\s*(${operand})`, "g")))
    if (pins(m[1], m[2])) out.push([lineOf(m.index), m[0]]);
  return out;
}

export function replayNoBundlePin(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", GLOB], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const refusals = [];
  for (const f of [...new Set(files)])
    for (const [line, at] of bundlePins(readFileSync(`${root}/${f}`, "utf8")))
      refusals.push(`${f}:${line}: ${at} pins a bundle's hash to a recorded one: judge the tree's build with the live rule instead`);
  return { refusals, read: new Set(files).size };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = replayNoBundlePin(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`replay-no-bundle-pin: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`replay-no-bundle-pin: OK (${r.read} live-check test file(s) read)`);
}
