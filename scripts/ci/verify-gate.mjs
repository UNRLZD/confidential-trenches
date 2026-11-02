#!/usr/bin/env node
// The verify gate. A pull request into main passes only when:
//  1. every non-merge commit's subject starts with `Card <key>:`;
//  2. every card named has its live check at scripts/live-checks/<key>.mjs in the PR head's tree (a regular file:
//     a recorded good answer passes, a recorded bad one fails), or the PR body holds, on a line of its own,
//       Live check: none (<reason>)          when the pull request names one card
//       Live check: <key>: none (<reason>)   for one card of several
//     for a card with nothing live, such as docs;
//  3. no SIGN_HOST release list (packages/signpage/releases/release-<N>.json) or RELEASED ledger entry
//     (packages/signpage/scripts/release-list.mjs) the branch had from main, at its merge base with the base, is changed
//     or removed; a list or entry main wrote after that point and the branch also holds is the same bytes (else a name
//     clash), and one the branch never had is not read as removed, since main merges by merge commit only and a merge
//     keeps it; and every list the pull request adds names the tree it was built from (`tree`), the tree of the base,
//     of the merge base or of one of the pull request's commits, whose SIGN_HOST build inputs (./sign-build-inputs.mjs)
//     are the head's, and a `commit` that is null (cut on the remote test machine) or has that tree.
// A card is proven by its own live check, run after every deploy. A release is never written again.
// No token and no network: it reads the git history checked out by CI (fetch-depth 0) and the body CI passes in.
//   PR_BODY="<pull request body>" node scripts/ci/verify-gate.mjs <base sha> <head sha>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { SIGN_BUILD_INPUTS } from "./sign-build-inputs.mjs";

const SUBJECT = /^Card ([a-z0-9][a-z0-9-]*): \S/;
const EXEMPT = /^\s*Live check: (?:([a-z0-9][a-z0-9-]*): )?none \((.*\S.*)\)\s*$/;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// the cards the body exempts: "*" for a bare line, else each key named
function exemptions(body) {
  const out = new Set();
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = EXEMPT.exec(line);
    if (m && m[2].trim()) out.add(m[1] ?? "*");
  }
  return out;
}

const RELEASES = "packages/signpage/releases";
const LEDGER = "packages/signpage/scripts/release-list.mjs";
const LIST = /^release-[1-9][0-9]*\.json$/;
const ENTRY = /"(release-[1-9][0-9]*)": "([0-9a-f]{64})"/g;

const lists = (cwd, rev) =>
  new Map(
    git(cwd, ["ls-tree", rev, "--", `${RELEASES}/`]).split("\n").filter(Boolean)
      .map((l) => /^\d+ blob ([0-9a-f]+)\t.*\/([^/]+)$/.exec(l)).filter((m) => m && LIST.test(m[2])).map((m) => [m[2], m[1]]),
  );
const show = (cwd, rev, path) => (git(cwd, ["ls-tree", rev, "--", path]) ? git(cwd, ["show", `${rev}:${path}`]) : "");
const treeOf = (cwd, commit) => {
  try {
    return git(cwd, ["rev-parse", "--verify", "-q", `${commit}^{tree}`]);
  } catch {
    return "";
  }
};
const sameInputs = (cwd, tree, head) => {
  try {
    git(cwd, ["diff", "--quiet", tree, head, "--", ...SIGN_BUILD_INPUTS]);
    return true;
  } catch {
    return false;
  }
};
const ledger = (text) => new Map([...text.matchAll(ENTRY)].map((m) => [m[1], m[2]]));

// every merge base of base and head (more than one after criss-cross merges); with no common history, the base itself
const mergeBases = (cwd, base, head) => {
  try {
    return git(cwd, ["merge-base", "--all", base, head]).split("\n").filter(Boolean);
  } catch {
    return [base];
  }
};

/**
 * Refusals for SIGN_HOST's release lists and ledger, judged on the branch's own change: what it had from main never
 * changes, what main wrote since is either absent (the merge keeps main's) or the same bytes, and a new list names its tree.
 */
export function releaseRefusals(cwd, base, head) {
  const r = [];
  const mbs = mergeBases(cwd, base, head);
  const [main, now] = [lists(cwd, base), lists(cwd, head)];
  const [mainLed, nowLed] = [ledger(show(cwd, base, LEDGER)), ledger(show(cwd, head, LEDGER))];
  const had = new Set();
  const hadLed = new Set();
  for (const mb of mbs) {
    for (const [name, blob] of lists(cwd, mb)) {
      had.add(name);
      if (!now.has(name)) r.push(`${RELEASES}/${name} is on main and was removed: a release is never written again`);
      else if (now.get(name) !== blob) r.push(`${RELEASES}/${name} is on main and was changed: a release is never written again`);
    }
    for (const [tag, sha] of ledger(show(cwd, mb, LEDGER))) {
      hadLed.add(tag);
      if (!nowLed.has(tag)) r.push(`RELEASED ${tag} is on main and was removed`);
      else if (nowLed.get(tag) !== sha) r.push(`RELEASED ${tag} is on main and was changed`);
    }
  }
  for (const [name, blob] of main)
    if (!had.has(name) && now.has(name) && now.get(name) !== blob)
      r.push(`${RELEASES}/${name} is on main as another list: a release name is never used twice`);
  for (const [tag, sha] of mainLed)
    if (!hadLed.has(tag) && nowLed.has(tag) && nowLed.get(tag) !== sha) r.push(`RELEASED ${tag} is on main with another hash`);
  const trees = new Set([
    git(cwd, ["rev-parse", `${base}^{tree}`]),
    ...mbs.map((mb) => git(cwd, ["rev-parse", `${mb}^{tree}`])),
    ...git(cwd, ["log", "--format=%T", `${base}..${head}`]).split("\n").filter(Boolean),
  ]);
  for (const name of now.keys()) {
    if (had.has(name) || main.has(name)) continue;
    let list;
    try {
      list = JSON.parse(show(cwd, head, `${RELEASES}/${name}`));
    } catch {
      r.push(`${RELEASES}/${name} is not JSON`);
      continue;
    }
    if (typeof list.tree !== "string" || !trees.has(list.tree)) {
      r.push(`${RELEASES}/${name} names no tree of the base, of the merge base or of this pull request's commits`);
      continue;
    }
    if (list.commit !== null && !(typeof list.commit === "string" && /^[0-9a-f]{40}$/.test(list.commit) && treeOf(cwd, list.commit) === list.tree))
      r.push(`${RELEASES}/${name} names a commit that is not null and has not its tree`);
    if (!sameInputs(cwd, list.tree, head))
      r.push(`${RELEASES}/${name} names a tree whose SIGN_HOST build inputs (${SIGN_BUILD_INPUTS.join(", ")}) are not the pull request's`);
  }
  return [...new Set(r)]; // a list several merge bases hold is named once
}

export function verifyGate(cwd, base, head, body = "") {
  const refusals = [];
  const commits = git(cwd, ["rev-list", "--reverse", `${base}..${head}`]).split("\n").filter(Boolean);
  if (commits.length === 0) return { refusals: ["the pull request has no commits"], cards: [] };
  const cards = new Set();
  for (const sha of commits) {
    const parents = git(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
    if (parents.length > 1) continue;
    const subject = git(cwd, ["log", "-1", "--format=%s", sha]);
    const key = subject.match(SUBJECT)?.[1];
    if (key) cards.add(key);
    else refusals.push(`commit ${sha.slice(0, 12)} names no card (subject must start "Card <key>: "): ${subject}`);
  }
  const exempt = exemptions(body);
  for (const key of cards) {
    const path = `scripts/live-checks/${key}.mjs`;
    const entry = git(cwd, ["ls-tree", head, "--", path]); // "<mode> <type> <sha>\t<path>", or empty
    if (entry) {
      if (!/^100(644|755) blob /.test(entry)) refusals.push(`${path} is not a regular file`);
      continue;
    }
    if (exempt.has(key) || (exempt.has("*") && cards.size === 1)) continue;
    refusals.push(
      `card ${key} has no live check: add ${path} (a recorded good answer passes, a recorded bad one fails), or put "Live check: ${cards.size === 1 ? "" : `${key}: `}none (<reason>)" in the PR body`,
    );
  }
  refusals.push(...releaseRefusals(cwd, base, head));
  return { refusals, cards: [...cards] };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: PR_BODY=<body> verify-gate.mjs <base sha> <head sha>");
    process.exit(2);
  }
  const { refusals, cards } = verifyGate(process.cwd(), base, head, process.env.PR_BODY ?? "");
  if (refusals.length) {
    for (const r of refusals) console.error(`verify-gate: REFUSED: ${r}`);
    process.exit(1);
  }
  console.log(`verify-gate: PASS (cards: ${cards.join(", ")})`);
}
