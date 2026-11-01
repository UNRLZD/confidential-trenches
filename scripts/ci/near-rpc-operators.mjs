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
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// A URL is a NEAR RPC when its host and path say both "near" and "rpc" (near.drpc.org, rpc.mainnet.near.org,
// 1rpc.io/near), or the map holds it. nearblocks.io, near.org/<page> and base.drpc.org are not.
export function isNearRpc(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (Object.hasOwn(NEAR_RPC_OPERATORS, host)) return true;
  const s = (host + new URL(url).pathname).toLowerCase();
  return s.includes("near") && s.includes("rpc");
}

const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>()[\]{},;|\\]*)?/g;
const clean = (u) => u.replace(/[.:]+$/, "").replace(/\/$/, "");

// The problems of one file's text: a NEAR RPC URL the map does not hold, and a line naming two or more NEAR RPC URLs
// that are all one operator's. A line that keys its list by that operator's name (`fastnear: [a, b]`) lists one
// operator's alternatives on purpose, not a pair, and passes.
export function lineProblems(text, file) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const urls = [...new Set((line.match(URL_RE) ?? []).map(clean).filter(isNearRpc))];
    const at = `${file}:${i + 1}`;
    for (const u of urls) if (!operatorOf(u)) problems.push(`${at}: ${u} is a NEAR RPC the operator map does not hold (scripts/ci/near-rpc-operators.mjs)`);
    const ops = new Set(urls.map(operatorOf).filter(Boolean));
    if (urls.length < 2 || ops.size !== 1 || urls.some((u) => !operatorOf(u))) return;
    const [op] = ops;
    if (new RegExp(`(^|[\\s{,(])["']?${op}["']?\\s*:`, "i").test(line)) return;
    problems.push(`${at}: ${urls.join(", ")} are one operator (${op}): two reads there are one read`);
  });
  return problems;
}

// Every file git lists (tracked, and untracked but not ignored), but the lockfile, binary files and this scan's own
// test, which holds the planted cases.
const PLANTED = "scripts/ci/near-rpc-operators.test.mjs";
export function scanTree(cwd) {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
  const problems = [];
  for (const f of files) {
    if (f === "pnpm-lock.yaml" || f === PLANTED) continue;
    let text;
    try {
      text = readFileSync(`${cwd}/${f}`, "utf8");
    } catch {
      continue; // a listed file deleted in the working tree
    }
    if (text.includes("\0")) continue;
    problems.push(...lineProblems(text, f));
  }
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = scanTree(process.cwd());
  for (const p of problems) console.error(`near-rpc-operators: REFUSED: ${p}`);
  if (problems.length) process.exit(1);
  console.log("near-rpc-operators: PASS (every NEAR RPC URL is in the map; no line pairs one operator)");
}
