#!/usr/bin/env node
// The NEAR RPC operator map: which company runs each public NEAR RPC this repo names. Two reads only count as two when
// two different operators answer them, so every place that trusts two NEAR RPCs agreeing reads it from here (the money
// gate) or is held to it by the scan below (every other file: the wallet's pair, the helper's pair, the README's loop).
//
// The operator of a URL comes from the provider's own docs, and live `status` reads back it up:
//  - FastNEAR runs its own hosts (docs.fastnear.com/rpc: rpc.mainnet, rpc.testnet, archival-rpc.mainnet and
//    archival-rpc.testnet .fastnear.com; docs.near.org/api/rpc/providers: free.rpc.fastnear.com, test.rpc.fastnear.com)
//    and near.org's: "After August 1, FastNear will continue to maintain these endpoints" (near.org/blog/
//    deprecation-of-near-org-and-pagoda-co-rpc-endpoints, for rpc.*.near.org and archival-rpc.*.near.org; read
//    2026-11-01). Live `status` reads agree (2026-11-01, 08:18 to 08:26Z): rpc.mainnet.fastnear.com answered node keys
//    688aviNn…, E6qPW56a… and Be6YJaMr…, and rpc.mainnet.near.org 688aviNn… and Be6YJaMr…, one pool; both archival
//    mainnet hosts answered 5XUKcz2d…; both archival testnet hosts AhVre2kK…; test.rpc.fastnear.com,
//    rpc.testnet.fastnear.com and rpc.testnet.near.org each rotated over GTdUhFKm…, B87Qq34L… and vknQwA6g….
//  - dRPC runs near.drpc.org and near-testnet.drpc.org (docs.near.org/api/rpc/providers; drpc.org/chainlist/
//    near-mainnet-rpc), not archival. Live reads, same window: node keys 368TikGm… and 3qsP9433… (mainnet),
//    Cz6fGcTA… (testnet), none of FastNEAR's.
// A node key can rotate inside one operator's pool, so a key compare alone never decides an operator; the docs do.
// No other keyless archival NEAR RPC exists (docs.near.org/api/rpc/providers, read 2026-11-01: archival and public is
// near.org's alone, which FastNEAR runs; FastNEAR's own archival is paid; All That Node, Lava, QuickNode and Zeeve need
// a key; a read of 22 mainnet and 11 testnet hosts on 2026-10-31 found no third). So a tx older than dRPC keeps is
// readable on one operator only, and the money gate says so.
//
//   node scripts/ci/near-rpc-operators.mjs   every NEAR RPC URL in the tree is in the map, and no line pairs one operator
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

/** host -> { operator, network } */
export const NEAR_RPC_OPERATORS = Object.freeze({
  "rpc.mainnet.fastnear.com": { operator: "fastnear", network: "mainnet" },
  "free.rpc.fastnear.com": { operator: "fastnear", network: "mainnet" },
  "archival-rpc.mainnet.fastnear.com": { operator: "fastnear", network: "mainnet" },
  "rpc.mainnet.near.org": { operator: "fastnear", network: "mainnet" },
  "archival-rpc.mainnet.near.org": { operator: "fastnear", network: "mainnet" },
  "test.rpc.fastnear.com": { operator: "fastnear", network: "testnet" },
  "rpc.testnet.fastnear.com": { operator: "fastnear", network: "testnet" },
  "archival-rpc.testnet.fastnear.com": { operator: "fastnear", network: "testnet" },
  "rpc.testnet.near.org": { operator: "fastnear", network: "testnet" },
  "archival-rpc.testnet.near.org": { operator: "fastnear", network: "testnet" },
  "near.drpc.org": { operator: "drpc", network: "mainnet" },
  "near-testnet.drpc.org": { operator: "drpc", network: "testnet" },
});

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** The operator of a NEAR RPC URL, or null when the map does not hold it. */
export const operatorOf = (url) => NEAR_RPC_OPERATORS[hostOf(url)]?.operator ?? null;
/** The network of a NEAR RPC URL, or null. */
export const networkOf = (url) => NEAR_RPC_OPERATORS[hostOf(url)]?.network ?? null;

// A URL is a NEAR RPC when the map holds its host, its host and path say both "near" and "rpc" (rpc.ankr.com/near,
// 1rpc.io/near), or a label of its host is "near" or starts or ends with "near-"/"-near" (near.lava.build,
// near-rpc.publicnode.com). near.org's own pages (near.org/<page>, docs.near.org) and nearblocks.io are not.
export function isNearRpc(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.host.toLowerCase();
  if (Object.hasOwn(NEAR_RPC_OPERATORS, host)) return true;
  const s = (host + u.pathname).toLowerCase();
  if (s.includes("near") && s.includes("rpc")) return true;
  if (/(^|\.)near\.org$/.test(u.hostname.toLowerCase())) return false;
  return u.hostname.toLowerCase().split(".").some((l) => l === "near" || l.startsWith("near-") || l.endsWith("-near"));
}

// The scan. Every place in a file that names a NEAR RPC host is found, in any case and with any scheme or none
// (https://, HTTPS://, wss://, a bare host), and a port other than 443 makes it another endpoint, not the map's:
//  - a host the map does not hold is refused: a URL that isNearRpc() says is one, or a bare host of FastNEAR's,
//    near.org's or dRPC's domains whose name says rpc (dRPC's: near);
//  - a NEAR RPC host built from a template (`https://rpc.${net}.near.org`) is refused: the scan cannot read it;
//  - two or more map hosts that are all one operator's, in one unit, are refused. A unit is a line, a bracket group
//    ([...], {...} or (...), across lines), a run of lines joined by a trailing "\" (a shell or README command), a
//    "- " list (YAML, one item per line, with its items' nested lines) and, in a code file, a statement (up to a ";"
//    outside brackets). A unit that lists one operator's alternatives on purpose (the wallet's FastNEAR URLs) passes
//    only when every line in it that names one of its hosts carries the marker ALLOW.
// Out of reach of a text scan: a pair built from separate statements (`const A = "<FastNEAR>"; const B = "<near.org>";
// read([A, B])`), where no one unit holds both hosts. The places that pair reads are few and named above; the money
// gate counts operators from the map itself.
export const ALLOW = "near-rpc-operators: one operator";
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/"'`<>()[\]{},;|\\]+)(\/[^\s"'`<>()[\]{},;|\\]*)?/gi;
const BARE = /(?<![A-Za-z0-9.$}-])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::(\d+))?(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;
const TEMPLATE = /[A-Za-z0-9.-]*\$\{[^}]*\}[A-Za-z0-9.${}-]*\.(?:near\.org|fastnear\.com|drpc\.org)(?![A-Za-z0-9-])/gi;
const OPERATOR_DOMAIN = /(^|\.)(fastnear\.com|near\.org|drpc\.org)$/;
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|rs)$/;

// TEMPLATE's matches, as text.matchAll(TEMPLATE) gives them, in linear time. matchAll tries TEMPLATE at every
// character, and its leading run [A-Za-z0-9.-]* rescans a whole long run from each one: O(n^2), 35 s on a 1.9 MB
// quote fixture and 443 s for the tree, past the gitleaks job's 10 minutes (main a70ea92b, 9 Nov). A match that
// starts inside a run also matches one character earlier, so the leftmost match at or after p starts at p itself or
// where no run character comes before it: one sticky try at p, else the first such run start.
const TEMPLATE_AT = new RegExp(TEMPLATE.source, "iy");
const TEMPLATE_RUN_START = new RegExp(`(?<![A-Za-z0-9.-])(?:${TEMPLATE.source})`, "gi");
function templateMatches(text) {
  const out = [];
  if (!text.includes("${")) return out; // every match holds "${"
  for (let p = 0; p < text.length; ) {
    TEMPLATE_AT.lastIndex = p;
    let m = TEMPLATE_AT.exec(text);
    if (!m) {
      TEMPLATE_RUN_START.lastIndex = p;
      m = TEMPLATE_RUN_START.exec(text);
      if (!m) break;
    }
    out.push(m);
    p = m.index + m[0].length; // never empty: a match holds "${", "}" and a domain
  }
  return out;
}

// [{ at: index, host, op | null, why }] of a text
function hostsIn(text) {
  const found = new Map(); // index -> entry
  for (const m of text.matchAll(BARE)) {
    const host = m[1].toLowerCase();
    const port = m[2] && !["443", "80"].includes(m[2]) ? `:${m[2]}` : "";
    const entry = NEAR_RPC_OPERATORS[host];
    if (entry && !port) found.set(m.index, { at: m.index, host, op: entry.operator });
    else if (entry || (OPERATOR_DOMAIN.test(host) && /rpc/.test(host) && (!host.endsWith("drpc.org") || host.includes("near"))))
      found.set(m.index, { at: m.index, host: host + port, op: null, why: "is a NEAR RPC host the operator map does not hold" });
  }
  for (const m of text.matchAll(SCHEME_URL)) {
    if (m[1].includes("${")) continue; // TEMPLATE reads these
    const url = m[0].replace(/[.:]+$/, "");
    if (!isNearRpc(url)) continue;
    const at = m.index + m[0].indexOf(m[1]);
    if (found.has(at)) continue;
    let host;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      continue;
    }
    if (!Object.hasOwn(NEAR_RPC_OPERATORS, host)) found.set(at, { at, host: url, op: null, why: "is a NEAR RPC the operator map does not hold" });
  }
  for (const m of templateMatches(text)) found.set(m.index, { at: m.index, host: m[0], op: null, why: "is a NEAR RPC host built from a template, which the scan cannot read" });
  return [...found.values()].sort((a, b) => a.at - b.at);
}

// [start, end) spans of the text's bracket groups and, in a code file, its statements
function units(text, code) {
  const spans = [];
  const stack = [];
  const open = { "]": "[", "}": "{", ")": "(" };
  let stmt = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[" || c === "{" || c === "(") stack.push([c, i]);
    else if (open[c]) {
      while (stack.length && stack[stack.length - 1][0] !== open[c]) stack.pop(); // an unmatched opener in prose
      if (stack.length) spans.push([stack.pop()[1], i + 1]);
    } else if (c === ";" && code && stack.length === 0) {
      spans.push([stmt, i + 1]);
      stmt = i + 1;
    }
  }
  if (code) spans.push([stmt, text.length]);
  // line-based units: a run joined by trailing backslashes, and a "- " list at one indent with its nested lines
  const lines = [];
  for (let at = 0, i = 0, parts = text.split("\n"); i < parts.length; at += parts[i].length + 1, i++) lines.push([at, parts[i]]);
  const end = (i) => lines[i][0] + lines[i][1].length;
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && /\\\s*$/.test(lines[j][1])) j++;
    if (j > i) spans.push([lines[i][0], end(j)]);
    i = j;
  }
  const indent = (l) => l.match(/^\s*/)[0].length;
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i][1].match(/^(\s*)- /);
    if (!item || (i > 0 && /^\s*- /.test(lines[i - 1][1]) && indent(lines[i - 1][1]) === item[1].length)) continue; // not a list's first item
    const d = item[1].length;
    let j = i;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k][1];
      if (!l.trim()) continue; // a blank line inside the list
      if (indent(l) > d || (indent(l) === d && /^\s*- /.test(l))) j = k;
      else break;
    }
    if (j > i) spans.push([lines[i][0], end(j)]);
  }
  return spans;
}

/** The problems of one file's text (named lineProblems: each names the line of its first host). */
export function lineProblems(raw, file) {
  // an escaped dot (a host in a regex, "near\\.drpc\\.org") is read as a dot; no newline moves, so line numbers hold
  const text = raw.replace(/\\+\./g, ".");
  const problems = [];
  const lineAt = (i) => text.slice(0, i).split("\n").length;
  const lines = text.split("\n");
  const hosts = hostsIn(text);
  for (const h of hosts) if (!h.op) problems.push(`${file}:${lineAt(h.at)}: ${h.host} ${h.why} (scripts/ci/near-rpc-operators.mjs)`);
  const known = hosts.filter((h) => h.op);
  if (known.length < 2) return problems;
  const lineSpans = [];
  let at = 0;
  for (const l of lines) {
    lineSpans.push([at, at + l.length]);
    at += l.length + 1;
  }
  const seen = new Set();
  for (const [a, b] of [...lineSpans, ...units(text, CODE.test(file))]) {
    // per network: a mainnet host and a testnet host never read the same tx, so they are no pair
    for (const network of ["mainnet", "testnet"]) {
      const inside = known.filter((h) => h.at >= a && h.at < b && NEAR_RPC_OPERATORS[h.host].network === network);
      const names = [...new Set(inside.map((h) => h.host))];
      const ops = new Set(inside.map((h) => h.op));
      if (names.length < 2 || ops.size !== 1) continue;
      if (inside.every((h) => lines[lineAt(h.at) - 1].includes(ALLOW))) continue; // every host's line is marked
      const key = inside.map((h) => h.at).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`${file}:${lineAt(inside[0].at)}: ${names.join(", ")} are one operator (${[...ops][0]}): two reads there are one read`);
    }
  }
  return problems;
}

// Every file git lists (tracked, and untracked but not ignored), but the lockfile, binary files and these, each with
// its reason. A file here is never read, so the list stays short.
export const SKIP = {
  "pnpm-lock.yaml": "the lockfile",
  "scripts/ci/near-rpc-operators.mjs": "the map itself: its notes name one operator's hosts side by side",
  "scripts/ci/near-rpc-operators.test.mjs": "the planted cases",
  "contracts/vault/deployments/testnet-usdc.json": "a run's record: its notes say which host answered 429 and which one was read, no list",
};
// Built files whose pairs the scan judges in the sources they are built from: minifying drops comments, so the allow
// marker a source line carries is gone from the bundle. Every host in them must still be in the map.
export const BUNDLES = {
  "packages/signpage/public/app.js": "the signing page's bundle, made by packages/signpage/scripts/build-app.mjs from sources this scan reads (build output, ignored and never committed, card signpage-generated-merge-free: scanTree reads it itself, after signBuilt()); minifying drops the allow marker",
};
export const fileProblems = (text, f) => {
  const p = lineProblems(text, f);
  return Object.hasOwn(BUNDLES, f) ? p.filter((x) => !/ are one operator \(/.test(x)) : p;
};
/** The files the scan reads: every file git lists (tracked, and untracked but not ignored), and each of BUNDLES, which
 *  is build output git ignores (card signpage-generated-merge-free, review P3-1). */
export function scanFiles(cwd) {
  const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
  return [...new Set([...listed, ...Object.keys(BUNDLES)])];
}
export function scanTree(cwd) {
  const files = scanFiles(cwd);
  const problems = [];
  for (const f of Object.keys(BUNDLES)) {
    if (!existsSync(`${cwd}/${f}`)) problems.push(`${f} is not built: the scan reads the bundle SIGN_HOST serves; run node packages/signpage/scripts/build-app.mjs`);
  }
  for (const f of files) {
    if (Object.hasOwn(SKIP, f)) continue;
    let text;
    try {
      text = readFileSync(`${cwd}/${f}`, "utf8");
    } catch {
      continue; // a listed file deleted in the working tree
    }
    if (text.includes("\0")) continue;
    problems.push(...fileProblems(text, f));
  }
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  signBuilt(); // the served bundle is build output: built from this checkout's sources first
  const problems = scanTree(process.cwd());
  for (const p of problems) console.error(`near-rpc-operators: REFUSED: ${p}`);
  if (problems.length) process.exit(1);
  console.log("near-rpc-operators: PASS (every NEAR RPC host is in the map; no unit pairs one operator)");
}
