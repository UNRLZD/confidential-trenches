#!/usr/bin/env node
// Card hosts-main-on-top: nothing but the signing page and its shell may be served under SIGN_HOST,
// confidential.unrealized.trade. It is the passkey's rp.id, and WebAuthn takes an rp.id that is a registrable domain
// suffix of, or equal to, the calling page's domain, so a page on any child host could run the PRF ceremony on it and
// get the seed (packages/wallet/src/signin/passkey.ts). This gate
// fails when the tree names a child of it in anything that can set where code is served or reached:
//   node scripts/ci/host-children.mjs [root]      (exit 1 and one line per refusal)
// It reads every file git lists (tracked, and untracked but not ignored) and refuses a host name ending in
// ".confidential.unrealized.trade", in any case, written plainly or regex-escaped, a wildcard label included, and a child
// built in code from the constant SIGN_HOST (or a member of that name): a label and a dot right before it interpolated
// in a template literal, a string ending in a dot added to it or concat()ing it, a join on "." whose last item it is, an alias of it, a
// Python f-string or a shell $SIGN_HOST; and a suffix led by a dot, written or built (an endsWith, a regex after any
// label), since it matches every child. Skipped, outside a public/ folder only (Pages serves every file under one, so each is read): prose (*.md),
// the written release lists (packages/signpage/releases/release-<N>.json, which name the hosts each release had and
// are never written again), recorded runs and test data (*.answers.json, *.run.json and JSON under a test/ or fixtures/
// folder, each as it was read) and test files (*.test.*, which plant children to prove a refusal). ALLOWED names the
// remaining places a child may appear, each with its reason. DNS is the live check's
// (scripts/live-checks/hosts-main-on-top.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIGN_HOST = "confidential.unrealized.trade";
// SIGN_HOST, plain or regex-escaped; a match is a child when a label (or a wildcard) and a dot stand before it. The scan
// is linear: the fixed name first, then the labels read backward from it.
const NAME = /confidential\\?\.unrealized\\?\.trade(?![a-z0-9-])/gi;
const LABELS = /(?:[a-z0-9*-]+\\?\.)+$/i;
// A child built from the constant (or an alias of it, `const S = SIGN_HOST`, `S=$SIGN_HOST`): the dot and an
// interpolated SIGN_HOST (`${}`, a Python f-string's `{}`, a shell `$` without braces); an added SIGN_HOST (the string
// before it is read backward); a join on "." whose last item is SIGN_HOST; a string ending in a dot that concat()s it.
// Each starts at a fixed character, so the scan stays linear.
const idOf = (names) => String.raw`(?:[\w$]+\??\.)*(?:${names.join("|")})\b`;
const ALIAS = /(?:^|[;{(\s])(?:(?:export\s+)?(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*["']?\$?\{?((?:[\w$]+\??\.)*[A-Za-z_$][\w$]*)\}?["']?\s*(?=;|$)/gm;
function built(text) {
  const names = ["SIGN_HOST"];
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of text.matchAll(ALIAS)) {
      const right = m[2].split(".").at(-1);
      if (names.includes(right) && !names.includes(m[1])) (names.push(m[1]), (grew = true));
    }
  }
  const ID = idOf(names);
  return {
    template: new RegExp(String.raw`\.(?:\$?\{\s*${ID}\s*\}|\$${ID})`, "g"),
    added: new RegExp(String.raw`\+\s*${ID}`, "g"),
    join: new RegExp(String.raw`,\s*${ID}\s*\]\s*\.join\(\s*(["'\x60])\.\1\s*\)`, "g"),
    concat: new RegExp(String.raw`(["'\x60])[^"'\x60\n]*\.\1\s*\.concat\(\s*${ID}|\.concat\(\s*(["'\x60])[^"'\x60\n]*\.\2\s*,\s*${ID}`, "g"),
  };
}
const SUFFIX = ", a suffix that lets any child in,";
export const ALLOWED = {
  // the origins the kit tags kit-v1 to kit-v1.4 froze, before this card moved the hosts: those tags are held to them
  "scripts/live-checks/kit-freeze-helper-api.mjs": [`sign.${SIGN_HOST}`],
  // this gate names the allowed children above and the suffix it refuses
  "scripts/ci/host-children.mjs": ["sign.${SIGN_HOST}", "${l}.${SIGN_HOST}", ".confidential.unrealized.trade", ".${SIGN_HOST}"],
  // the live check asks DNS for children of SIGN_HOST to prove each has no record, and reads the old sign.'s logged
  // certificate as proof that a CT log source's list is whole; it lists the CT logs' children by the suffix, each to
  // be refused
  "scripts/live-checks/hosts-main-on-top.mjs": ["${l}.${SIGN_HOST}", "sign.${SIGN_HOST}", ".${SIGN_HOST}"],
};

/** True for a file this gate does not read: prose, written release lists, recorded runs, test data and tests. */
export function skipped(f) {
  if (/(^|\/)public\//.test(f)) return false;
  return (
    /\.md$/i.test(f) ||
    /^packages\/signpage\/releases\/release-\d+\.json$/.test(f) ||
    /\.answers\.json$/.test(f) ||
    /\.run\.json$/.test(f) ||
    /(^|\/)(test|fixtures)\/.*\.json$/.test(f) ||
    /\.test\.[cm]?[jt]sx?$/.test(f)
  );
}

/** The refusals in one file's text: [line, name]. */
export function refusals(file, text) {
  const out = [];
  const allowed = ALLOWED[file] ?? [];
  for (const m of text.matchAll(NAME)) {
    const back = text.slice(Math.max(0, m.index - 253), m.index);
    const labels = back.match(LABELS);
    if (!labels || !/[a-z0-9*]/i.test(labels[0])) {
      const line = text.slice(0, m.index).split("\n").length;
      const plain = m[0].replaceAll("\\.", ".").toLowerCase();
      // a suffix led by a dot (an endsWith, a regex after any label): it matches every child
      if (/\\?\.$/.test(back) && !allowed.includes(`.${plain}`)) out.push([line, `.${plain}${SUFFIX}`]);
      // the name split across an added string: a string ending in a dot, a plus, then the name in quotes
      const split = back.match(/(["'\x60])([^"'\x60\n]*\.)\1\s*\+\s*(["'\x60])$/);
      if (split && !allowed.includes(`${split[2]}${plain}`)) out.push([line, `${split[0].replace(/\s+/g, " ")}${plain}${split[3]}`]);
      continue;
    }
    const name = `${labels[0]}${m[0]}`.replaceAll("\\.", ".").toLowerCase().replace(/^[.-]+/, "");
    if (allowed.includes(name)) continue;
    out.push([text.slice(0, m.index).split("\n").length, name]);
  }
  const at = (i, name) => {
    if (!allowed.includes(name)) out.push([text.slice(0, i).split("\n").length, name]);
  };
  const B = built(text);
  for (const m of text.matchAll(B.template)) {
    // the label before the dot, read backward: letters, digits, hyphens, wildcards and interpolations
    const label = text.slice(Math.max(0, m.index - 253), m.index).match(/(?:[a-z0-9*-]|\$?\{[^{}\n]*\})*$/i)[0];
    const name = m[0].replace(/\s+/g, "");
    if (!label) {
      // the suffix alone, led by a dot: it matches every child
      if (!allowed.includes(name)) out.push([text.slice(0, m.index).split("\n").length, `${name}${SUFFIX}`]);
      continue;
    }
    at(m.index - label.length, `${label}${name}`);
  }
  for (const m of text.matchAll(B.concat)) at(m.index, m[0].replace(/\s+/g, " "));
  for (const m of text.matchAll(B.added)) {
    // what is added to: a string ending in a dot, alone ("sign." +) or after more (label + "." +)
    const before = text.slice(Math.max(0, m.index - 253), m.index).match(/(["'\x60])([^"'\x60\n]*\.)\1\s*$/);
    if (before) at(m.index - before[0].length, `${before[0].trimEnd()} ${m[0].replace(/\s+/g, " ")}`);
  }
  for (const m of text.matchAll(B.join)) {
    const open = text.lastIndexOf("[", m.index);
    const start = open >= 0 && m.index - open <= 253 && !text.slice(open, m.index).includes("\n") ? open : m.index;
    at(start, text.slice(start, m.index + m[0].length).replace(/\s+/g, " "));
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function hostChildren(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  let read = 0;
  for (const f of [...new Set(files)]) {
    if (skipped(f)) continue;
    let text;
    try {
      text = readFileSync(`${root}/${f}`, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") continue; // listed by git, deleted in the tree
      if (e?.code === "EISDIR") continue; // a submodule or a nested checkout
      out.push(`${f}: could not be read (${String(e?.message ?? e).split("\n")[0]}), so it is refused`);
      continue;
    }
    read++;
    for (const [line, name] of refusals(f, text)) {
      if (name.endsWith(SUFFIX)) out.push(`${f}:${line}: ${name.slice(0, -SUFFIX.length)} is a suffix of SIGN_HOST ${SIGN_HOST} that lets any child in, and only the signing page may be served under it`);
      else out.push(`${f}:${line}: ${name} is a child of SIGN_HOST ${SIGN_HOST}, which only the signing page may hold`);
    }
  }
  return { refusals: out, read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = hostChildren(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`host-children: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`host-children: OK (${r.read} file(s) read, no child of ${SIGN_HOST})`);
}
