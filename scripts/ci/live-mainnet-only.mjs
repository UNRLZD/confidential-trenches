#!/usr/bin/env node
// Every listed live check reads the mainnets only (card live-checks-read-mainnet-only; owner 12 Nov: no test networks at
// all). A check with an `// After:` line runs after every deploy of its host (scripts/ci/live-after.mjs), so a test
// network's provider there (robinhood-testnet's dRPC refusing eth_getBlockByNumber, live run 43908276087) turns a
// deploy red over a chain no user reaches. This gate reads each listed check's own code, its comments left out, and
// refuses every way the checks reached a test network:
//   - the kit's whole EVM venue list (evmPoolVenues(), both halves in Node) or its test half: a listed check reads
//     mainnetVenues() (scripts/live-checks/mainnet-venues.mjs);
//   - the Solana devnet pool, its providers and the helper's devnet route;
//   - a URL whose host names a test network, a test network's deployment record or module;
//   - a test network's name as a chain to read, or a NEAR testnet account;
//   - a test network in an After line's arguments (its run's arguments are header text, not code).
// A check that makes sure a build or a page names no test network takes those names from
// scripts/live-checks/test-network-names.mjs, which no deploy runs, so its own code names none.
//   node scripts/ci/live-mainnet-only.mjs        exit 0 when no listed check reads a test network, 1 otherwise
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterOf, headerLines, readChecks } from "./live-after.mjs";

/** [pattern, why], each a way a check reached a test network. */
export const RULES = Object.freeze([
  [/\bevmPoolVenues\b/, "reads the kit's whole EVM venue list, test networks included: read mainnetVenues() (scripts/live-checks/mainnet-venues.mjs)"],
  [/\bevmTestnetVenues\b/, "reads the kit's test-network EVM venues"],
  [/\b(?:devnetPin|DEVNET_PROVIDERS|DEVNET_HELPER_RPC)\b/, "reads the Solana devnet pool or its providers"],
  [/solana-devnet/, "reads the helper's Solana devnet route"],
  [/https?:\/\/[^\s"'`/]*(?:sepolia|testnet|devnet)/i, "names a test network's provider"],
  [/deployments\/devnet\.json|\.(?:devnet|base-sepolia|robinhood-testnet)\.json/, "reads a test network's record"],
  [/\bfrom\s+["'][^"']*(?:testnet|devnet|sepolia)[^"']*["']/i, "imports a test network's module"],
  [/["'`](?:base-sepolia|robinhood-testnet|robinhood-sepolia|testnet|devnet)["'`]/, "names a test network as a chain to read"],
  [/["'`][\w.-]+\.testnet["'`]/, "names a NEAR testnet account"],
]);

/** A test network named in an After line's arguments. */
const AFTER_TEST = /devnet|testnet|sepolia/i;

/** A check's code with its comments blanked (lines kept, so a problem names its line). Strings and template literals
 *  are kept whole, so a URL's "//" is never read as a comment. */
export function codeOf(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

/** The problems of one check's text: [] when it is not listed (no After line) or reads the mainnets only. */
export function problemsOf(key, text) {
  if (!Object.keys(afterOf(text).runs).length) return [];
  const lines = codeOf(text).split("\n");
  const out = [];
  for (const value of headerLines(text, "After")) {
    const m = AFTER_TEST.exec(value);
    if (m) out.push(`${key}.mjs: "After: ${value}" runs on a test network (${m[0]})`);
  }
  lines.forEach((line, n) => {
    for (const [re, why] of RULES) {
      const m = re.exec(line);
      if (m) out.push(`${key}.mjs:${n + 1}: ${why} (${m[0]})`);
    }
  });
  return out;
}

/** Every listed check's problems under `root`. */
export function problems(root) {
  return Object.entries(readChecks(root)).flatMap(([key, text]) => problemsOf(key, text));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const p = problems(root);
  for (const line of p) console.log(`FAIL ${line}`);
  console.log(p.length ? `live-mainnet-only: ${p.length} reads of a test network in listed checks` : "live-mainnet-only: every listed check reads the mainnets only");
  process.exit(p.length ? 1 : 0);
}
