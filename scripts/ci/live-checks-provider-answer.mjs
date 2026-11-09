#!/usr/bin/env node
// Card live-checks-provider-no-answer: a live check reads a chain provider's JSON-RPC answer only through
// scripts/live-checks/provider-answer.mjs, which names a provider's no-answer (an empty body, not JSON, a 429, a rate
// limit, a block or state it does not hold) and leaves it out, never judging it as a wrong answer or a pass. This gate
// refuses a live check that builds a JSON-RPC request itself:
//   node scripts/ci/live-checks-provider-answer.mjs [root]      (exit 1 and one line per refusal)
// It reads every scripts/live-checks/*.mjs git lists (tracked, and untracked but not ignored) but the tests and the
// shared module, and refuses one whose code holds a JSON-RPC request or answer ("jsonrpc": "2.0" in any quoting),
// unless NOT_MOVED names it. NOT_MOVED can only shrink: a check it names that builds none is refused too (moved: take
// it off), and a check that imports the shared module may not also build its own. Risk it holds: a check that parses
// a provider's answer itself dies on one provider's bad answer (evm-buy-gas-depth exit 2 on drpc's code 27 "Unknown
// state", helper live run 42556116812, 9 Nov 03:54Z).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SHARED = new Set(["scripts/live-checks/provider-answer.mjs", "scripts/live-checks/provider-answer.plants.mjs"]);
// a JSON-RPC 2.0 request or answer in code: jsonrpc: "2.0", "jsonrpc": '2.0', `"jsonrpc":"2.0"` inside a string
const RPC = /["'`]?\bjsonrpc\\?["'`]?\s*:\s*\\?["'`]2\.0\\?["'`]/;
const IMPORTS_SHARED = /from\s+["']\.\/provider-answer\.mjs["']/;

// The checks that still build a JSON-RPC request themselves, each to move onto the shared module (card
// live-checks-provider-no-answer's follow-ups); the list only shrinks.
export const NOT_MOVED = Object.freeze([
  "app-footer-bar.mjs",
  "app-in-shell.mjs",
  "base-200ms-blocks.mjs",
  "delete-refund-readback.sweep.mjs",
  "evm-buy-gas-floor.mjs",
  "evm-pool-index.mjs",
  "evm-quote-lag-held.mjs",
  "evm-quote-warm-round.mjs",
  "evm-rpc-spare-list.mjs",
  "evm-scan-second-provider.mjs",
  "evm-sell-hook-intrablock.mjs",
  "held-move-forgotten-tx.mjs",
  "helper-create-u.mjs",
  "helper-evm-abi-tie.mjs",
  "helper-launchpad-origin.mjs",
  "helper-mainnet-vault-env.mjs",
  "helper-pool-senders.mjs",
  "helper-rpc-proxy.mjs",
  "helper-rpc-sell-methods.mjs",
  "helper-tape-4337-trader.mjs",
  "helper-usdc-event-watch.mjs",
  "helper-usdc-pending-pause.mjs",
  "helper-v4-hook-liquidity.mjs",
  "index-evm-swaps.mjs",
  "index-sol-trades.mjs",
  "intents-u-registered-first-run.mjs",
  "near-rpc-operators.mjs",
  "notes-per-pool-evm.mjs",
  "pool-buy-send-fast.mjs",
  "pool-evm-deploy.mjs",
  "pool-sol-deploy.mjs",
  "relayer-cost-guards.mjs",
  "relayer-withdraw-fee.mjs",
  "rh-cold-quote.mjs",
  "robinhood-mainnet-rpcs.mjs",
  "signpage-solana-trade.mjs",
  "solana-quote-under-1s.mjs",
  "vault-mainnet-money.mjs",
  "vault-review-fixes-1.mjs",
  "vault-review-fixes-kit.mjs",
  "vault-testnet-t02.mjs",
  "vault-testnet-usdc.mjs",
  "wallet-mainnet-relayer-pins.mjs",
  "wallet-refund-move.mjs",
  "wallet-restore-id-reader.mjs",
  "wallet-rpc-hex-case.mjs",
].map((f) => `scripts/live-checks/${f}`));

/** True when the code (comments taken out) holds a JSON-RPC request or answer */
export function buildsRpc(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  return RPC.test(code);
}

/** The refusals for a set of files: `read(path)` gives each one's text */
export function refusalsOf(files, read, notMoved = NOT_MOVED) {
  const out = [];
  const listed = new Set(notMoved);
  for (const f of files) {
    if (SHARED.has(f) || !/^scripts\/live-checks\/[^/]+\.mjs$/.test(f) || /\.test\.mjs$/.test(f)) continue;
    const src = read(f);
    const builds = buildsRpc(src);
    if (builds && IMPORTS_SHARED.test(src)) out.push(`${f}: imports provider-answer.mjs and builds a JSON-RPC request itself too: read every provider through rpcAnswer`);
    else if (builds && !listed.has(f)) out.push(`${f}: builds a JSON-RPC request outside provider-answer.mjs: read it through rpcAnswer, which names a provider's no-answer`);
    else if (!builds && listed.has(f)) out.push(`${f}: NOT_MOVED names it but it builds no JSON-RPC request: take it off the list`);
  }
  const seen = new Set(files);
  for (const f of listed) if (!seen.has(f)) out.push(`${f}: NOT_MOVED names a file that is not there: take it off the list`);
  return out;
}

export function liveChecksProviderAnswer(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", "scripts/live-checks/*.mjs"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const all = [...new Set(files)];
  return { refusals: refusalsOf(all, (f) => readFileSync(`${root}/${f}`, "utf8")), read: all.length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = liveChecksProviderAnswer(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`live-checks-provider-answer: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`live-checks-provider-answer: OK (${r.read} live-check files read, ${NOT_MOVED.length} not yet moved)`);
}
