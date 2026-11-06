#!/usr/bin/env node
// Card hosts-main-on-top: nothing but the signing page and its shell may be served under SIGN_HOST,
// confidential.unrealized.trade. It is the passkey's rp.id, and WebAuthn takes an rp.id that is a registrable domain
// suffix of, or equal to, the calling page's domain, so a page on any child host could run the PRF ceremony on it and
// get the seed (packages/wallet/src/signin/passkey.ts). This gate
// fails when the tree names a child of it in anything that can set where code is served or reached:
//   node scripts/ci/host-children.mjs [root]      (exit 1 and one line per refusal)
// It reads every file git lists (tracked, and untracked but not ignored) and refuses a host name ending in
// ".confidential.unrealized.trade", in any case, written plainly or regex-escaped, a wildcard label included. Skipped:
// prose (*.md), the written release lists (packages/signpage/releases/release-<N>.json, which name the hosts each
// release had and are never written again), recorded live-check answers (*.answers.json, runs as they were read) and
// test files (*.test.*, which plant children to prove a refusal). ALLOWED names the one remaining place a child may
// appear, with its reason. DNS is the live check's (scripts/live-checks/hosts-main-on-top.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIGN_HOST = "confidential.unrealized.trade";
// SIGN_HOST, plain or regex-escaped; a match is a child when a label (or a wildcard) and a dot stand before it. The scan
// is linear: the fixed name first, then the labels read backward from it.
const NAME = /confidential\\?\.unrealized\\?\.trade(?![a-z0-9-])/gi;
const LABELS = /(?:[a-z0-9*-]+\\?\.)+$/i;
export const ALLOWED = {
  // the origins the kit tags kit-v1 to kit-v1.4 froze, before this card moved the hosts: those tags are held to them
  "scripts/live-checks/kit-freeze-helper-api.mjs": [`sign.${SIGN_HOST}`],
};

/** True for a file this gate does not read: prose, written release lists, recorded answers and tests. */
export function skipped(f) {
  return /\.md$/i.test(f) || /^packages\/signpage\/releases\/release-\d+\.json$/.test(f) || /\.answers\.json$/.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f);
}

/** The refusals in one file's text: [line, name]. */
export function refusals(file, text) {
  const out = [];
  const allowed = ALLOWED[file] ?? [];
  for (const m of text.matchAll(NAME)) {
    const labels = text.slice(Math.max(0, m.index - 253), m.index).match(LABELS);
    if (!labels || !/[a-z0-9*]/i.test(labels[0])) continue;
    const name = `${labels[0]}${m[0]}`.replaceAll("\\.", ".").toLowerCase().replace(/^[.-]+/, "");
    if (allowed.includes(name)) continue;
    out.push([text.slice(0, m.index).split("\n").length, name]);
  }
  return out;
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
    for (const [line, name] of refusals(f, text)) out.push(`${f}:${line}: ${name} is a child of SIGN_HOST ${SIGN_HOST}, which only the signing page may hold`);
  }
  return { refusals: out, read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = hostChildren(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`host-children: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`host-children: OK (${r.read} file(s) read, no child of ${SIGN_HOST})`);
}
