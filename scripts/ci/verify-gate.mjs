#!/usr/bin/env node
// The verify gate. A pull request into main passes only when:
//  1. every non-merge commit's subject starts with `Card <key>:`;
//  2. every card named has its live check at scripts/live-checks/<key>.mjs in the PR head's tree (a regular file:
//     a recorded good answer passes, a recorded bad one fails), or the PR body holds, on a line of its own,
//       Live check: none (<reason>)          when the pull request names one card
//       Live check: <key>: none (<reason>)   for one card of several
//     for a card with nothing live, such as docs.
// A card is proven by its own live check, run after every deploy.
// No token and no network: it reads the git history checked out by CI (fetch-depth 0) and the body CI passes in.
//   PR_BODY="<pull request body>" node scripts/ci/verify-gate.mjs <base sha> <head sha>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

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
