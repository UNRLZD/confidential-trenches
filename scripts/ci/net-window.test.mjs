// scripts/net-window.mjs: every Node tool here that opens a network connection sets Node's
// per-address connect window to 2000 ms before its first connection (Node's own 250 ms cancelled a Mac's slow IPv4
// connect to api.hetzner.cloud: "fetch failed", 1 Nov 04:37Z).
//   node --test scripts/ci/net-window.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = path.join(ROOT, "scripts/net-window.mjs");

// Every entry that opens a connection (fetch, a library that fetches, a WebSocket): each one imports the shared module.
export const CHANGED = [
  "apps/helper/deploy/create-server.mjs",
  "contracts/vault/scripts/deploy.mjs",
  "contracts/vault/scripts/mainnet-v1/reads.mjs",
  "contracts/vault/scripts/prepay.mjs",
  "contracts/vault/scripts/testnet-t04.mjs",
  "contracts/vault/scripts/testnet-usdc.mjs",
  "scripts/ci/jup-idle.mjs",
  "scripts/ci/live-plan.mjs",
  "scripts/ci/money-gate.mjs",
  "scripts/pages-readback.mjs",
  "scripts/live-checks/app-buy-route-strip.mjs",
  "scripts/live-checks/app-chart-controls.mjs",
  "scripts/live-checks/app-chart-live.mjs",
  "scripts/live-checks/app-console-429.mjs",
  "scripts/live-checks/app-footer-bar.mjs",
  "scripts/live-checks/app-harness-signin-e2e.mjs",
  "scripts/live-checks/app-host-gate.mjs",
  "scripts/live-checks/app-list-age.mjs",
  "scripts/live-checks/app-quick-buy-one-tap.mjs",
  "scripts/live-checks/app-release-sri.mjs",
  "scripts/live-checks/app-shell.mjs",
  "scripts/live-checks/app-toast-clears-sheet-head.mjs",
  "scripts/live-checks/app-token-chart.mjs",
  "scripts/live-checks/app-token-lower-panel.mjs",
  "scripts/live-checks/app-token-route.mjs",
  "scripts/live-checks/base-200ms-blocks.mjs",
  "scripts/live-checks/delete-refund-readback.mjs",
  "scripts/live-checks/delete-refund-readback.sweep.mjs",
  "scripts/live-checks/evm-buy-gas-depth.mjs",
  "scripts/live-checks/evm-buy-gas-floor.mjs",
  "scripts/live-checks/evm-buy-hookdata-fee.mjs",
  "scripts/live-checks/evm-buy-quote-ends-on-node.mjs",
  "scripts/live-checks/evm-fee-collector.mjs",
  "scripts/live-checks/evm-mainnet-senders.mjs",
  "scripts/live-checks/evm-quote-lag-held.mjs",
  "scripts/live-checks/evm-quote-warm-round.mjs",
  "scripts/live-checks/evm-rpc-spare-list.mjs",
  "scripts/live-checks/evm-scan-second-provider.mjs",
  "scripts/live-checks/evm-sell-hook-converge.mjs",
  "scripts/live-checks/evm-sell-hook-intrablock.mjs",
  "scripts/live-checks/evm-sell-no-release-in-flight.mjs",
  "scripts/live-checks/evm-sell-unfunded-sim-keeps-route.mjs",
  "scripts/live-checks/evm-sell-v4.mjs",
  "scripts/live-checks/evm-testnet-delegate-review3.mjs",
  "scripts/live-checks/evm-venues-pin.mjs",
  "scripts/live-checks/helper-abuse-limits.mjs",
  "scripts/live-checks/helper-bind-relayer-mainnet.mjs",
  "scripts/live-checks/helper-create-u.mjs",
  "scripts/live-checks/helper-evm-abi-tie.mjs",
  "scripts/live-checks/helper-evm-sender.mjs",
  "scripts/live-checks/helper-id-intents.mjs",
  "scripts/live-checks/helper-host-health.mjs",
  "scripts/live-checks/helper-mainnet-vault-env.mjs",
  "scripts/live-checks/hosts-main-on-top.mjs",
  "scripts/live-checks/helper-launchpad-origin.mjs",
  "scripts/live-checks/helper-live-bars-no-503.mjs",
  "scripts/live-checks/helper-page-jup-429.mjs",
  "scripts/live-checks/helper-pool-senders.mjs",
  "scripts/live-checks/helper-proxy.mjs",
  "scripts/live-checks/helper-robinhood-capacity.mjs",
  "scripts/live-checks/helper-robinhood-search-ahead.mjs",
  "scripts/live-checks/helper-sell-fee-recipient.mjs",
  "scripts/live-checks/helper-sender-fee-proof.mjs",
  "scripts/live-checks/helper-v4-hook-liquidity.mjs",
  "scripts/live-checks/helper-tape-4337-trader.mjs",
  "scripts/live-checks/helper-rpc-proxy.mjs",
  "scripts/live-checks/helper-rpc-sell-methods.mjs",
  "scripts/live-checks/helper-solana-failover.mjs",
  "scripts/live-checks/helper-token-page-cold.mjs",
  "scripts/live-checks/helper-token-watch.mjs",
  "scripts/live-checks/helper-usdc-event-watch.mjs",
  "scripts/live-checks/helper-usdc-pending-pause.mjs",
  "scripts/live-checks/index-evm-swaps.mjs",
  "scripts/live-checks/index-sol-trades.mjs",
  "scripts/live-checks/kit-entry-signpage-api.mjs",
  "scripts/live-checks/kit-freeze-helper-api.mjs",
  "scripts/live-checks/kit-freeze-keys.mjs",
  "scripts/live-checks/kit-freeze-vault.mjs",
  "scripts/live-checks/kit-pool-tap-inputs.mjs",
  "scripts/live-checks/kit-deposit-assets-dry.mjs",
  "scripts/live-checks/kit-deposit-calls.mjs",
  "scripts/live-checks/kit-frame-version.mjs",
  "scripts/live-checks/kit-oneclick-pins-frozen.mjs",
  "scripts/live-checks/page-evm-rpc-csp.mjs",
  "scripts/live-checks/wallet-deposit-follow.mjs",
  "scripts/live-checks/wallet-refund-move.mjs",
  "scripts/live-checks/kit-renewal-read-bounded.mjs",
  "scripts/live-checks/market-data-evm.mjs",
  "scripts/live-checks/market-data-solana-lists.mjs",
  "scripts/live-checks/market-data-solana-token.mjs",
  "scripts/live-checks/money-gate-testnet.mjs",
  "scripts/live-checks/near-rpc-operators.mjs",
  "scripts/live-checks/notes-per-pool-evm.mjs",
  "scripts/live-checks/oneclick-fee-path-own-key.mjs",
  "scripts/live-checks/oneclick-partner-fee-live.mjs",
  "scripts/live-checks/pool-answer-unknown.mjs",
  "scripts/live-checks/pool-buy-send-fast.mjs",
  "scripts/live-checks/pool-deposit-address.mjs",
  "scripts/live-checks/pool-deposit-follow.mjs",
  "scripts/live-checks/pool-deposit-sent-end.mjs",
  "scripts/live-checks/pool-deposits.mjs",
  "scripts/live-checks/pool-evm-buy-pays-revert.mjs",
  "scripts/live-checks/pool-evm-deploy-mainnet.mjs",
  "scripts/live-checks/pool-evm-deploy.mjs",
  "scripts/live-checks/pool-evm-deploy-resume-safe.mjs",
  "scripts/live-checks/pool-read-down.mjs",
  "scripts/live-checks/pool-ready-no-flicker.mjs",
  "scripts/live-checks/pool-sol-deploy-after-run.mjs",
  "scripts/live-checks/pool-sol-deploy-mainnet.mjs",
  "scripts/live-checks/pool-sol-deploy-sweep.mjs",
  "scripts/live-checks/pool-sol-deploy.mjs",
  "scripts/live-checks/pool-senders-next-page.mjs",
  "scripts/live-checks/pool-senders-next-page-helper.mjs",
  "scripts/live-checks/precommit-taken-recover.mjs",
  "scripts/live-checks/relayer-cost-guards.mjs",
  "scripts/live-checks/relayer-withdraw-fee.mjs",
  "scripts/live-checks/relayer-withdraw-send.mjs",
  "scripts/live-checks/rh-cold-quote.mjs",
  "scripts/live-checks/robinhood-listed-tape-opens.mjs",
  "scripts/live-checks/robinhood-mainnet-rpcs.mjs",
  "scripts/live-checks/rpc-keyed-lists.mjs",
  "scripts/live-checks/signpage-buy-own-spend.mjs",
  "scripts/live-checks/signpage-error-after-timeout.mjs",
  "scripts/live-checks/evm-pool-sync-wide-pages.mjs",
  "scripts/live-checks/wallet-near-prepay-taken.mjs",
  "scripts/live-checks/held-deposit-way-out.mjs",
  "scripts/live-checks/signpage-buy-route-events.mjs",
  "scripts/live-checks/signpage-pool-flow.mjs",
  "scripts/live-checks/signpage-pool-kinds.mjs",
  "scripts/live-checks/signpage-pool-mainnet.mjs",
  "scripts/live-checks/signpage-pool-notes.mjs",
  "scripts/live-checks/signpage-pool-price.mjs",
  "scripts/live-checks/signpage-pool-pins.mjs",
  "scripts/live-checks/signpage-pool-withdraw-form.mjs",
  "scripts/live-checks/signpage-postmessage.mjs",
  "scripts/live-checks/signpage-prover-host.mjs",
  "scripts/live-checks/signpage-prover-threads.mjs",
  "scripts/live-checks/signpage-sent-read-back.mjs",
  "scripts/live-checks/signpage-skeleton.mjs",
  "scripts/live-checks/signpage-solana-trade.mjs",
  "scripts/live-checks/signpage-withdraw-form.mjs",
  "scripts/live-checks/signpage-withdraw-handoff.mjs",
  "scripts/live-checks/signpage-withdraw-own-spend.mjs",
  "scripts/live-checks/sol-buy-rent-back.mjs",
  "scripts/live-checks/sol-small-note-buys.mjs",
  "scripts/live-checks/solana-jupiter-build.mjs",
  "scripts/live-checks/solana-legs-share-wait.mjs",
  "scripts/live-checks/solana-quote-under-1s.mjs",
  "scripts/live-checks/solana-legs-checked.mjs",
  "scripts/live-checks/solana-written-accounts-whole.mjs",
  "scripts/live-checks/solana-teardown-cashback.mjs",
  "scripts/live-checks/solana-mint-supply-moves.mjs",
  "scripts/live-checks/solana-release-reads-paced.mjs",
  "scripts/live-checks/token-page-fills-after.mjs",
  "scripts/live-checks/trade-box-bal-cash.mjs",
  "scripts/live-checks/trade-box-pool.mjs",
  "scripts/live-checks/vault-review-fixes-1.mjs",
  "scripts/live-checks/vault-setup-files.mjs",
  "scripts/live-checks/vault-testnet-t02.mjs",
  "scripts/live-checks/vault-mainnet-money.mjs",
  "scripts/live-checks/vault-skeleton.mjs",
  "scripts/live-checks/vault-testnet-usdc.mjs",
  "scripts/live-checks/vault-testnet-t01.mjs",
  "scripts/live-checks/vault-testnet-t04.mjs",
  "scripts/live-checks/vault-mainnet.mjs",
  "scripts/live-checks/vault-review-fixes-kit.mjs",
  "scripts/live-checks/vault-kit-settle.mjs",
  "scripts/live-checks/wallet-passkey-prf.mjs",
  "scripts/live-checks/wallet-rpc-hex-case.mjs",
  "scripts/live-checks/wallet-withdraw-move-out.mjs",
  "scripts/live-checks/wallet-mainnet-relayer-pins.mjs",
  "scripts/live-checks/deposit-sheet-oneclick-budget.mjs",
  "scripts/live-checks/terminal-harness-sign-spa.mjs",
];

// Scripts in the searched folders that open no connection from Node, and why.
export const KEEP = {
  "scripts/webkit-harness/index.mjs": "a loopback HTTPS server and CONNECT proxy for the Mac's WKWebView, both on 127.0.0.1; Node opens none to a remote host",
  "scripts/webkit-harness/self-test.mjs": "drives index.mjs's loopback harness; Node opens none to a remote host",
  "scripts/ci/verify-gate.mjs": "reads git history only, no network",
  "scripts/ci/kit-reach.mjs": "reads the tree only, no network",
  "scripts/ci/no-network.mjs": "a preload that refuses every connection but this machine's; it opens none",
  "scripts/perf-table.mjs": "reads files only, no network",
};

const FOLDERS = ["scripts", "apps/helper/deploy", "contracts/vault/scripts"];
const NET = /^[^/*#\n]*(\bfetch\(|= *(globalThis\.)?fetch\b|new WebSocket|node:https?|node:net|node:tls|(net|tls)\.connect)/m;

const files = () =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FOLDERS], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter((f) => /\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) && f !== "scripts/net-window.mjs");

// the window a fresh process has after importing a file, read in a child so no earlier import can have set it
const windowAfter = (file) => {
  const code = `import net from "node:net"; if (process.env.NW_FILE) await import(process.env.NW_FILE); console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, NW_FILE: file ? pathToFileURL(file).href : "" } });
  assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  return Number(r.stdout.trim());
};

test("Node's own window is 250 ms and the shared module makes it 2000 ms", () => {
  assert.equal(windowAfter(null), 250);
  assert.equal(windowAfter(SHARED), 2000);
});

for (const f of CHANGED) {
  test(`${f}: imported, the window is 2000 ms, and the shared module is imported by it`, () => {
    assert.equal(windowAfter(path.join(ROOT, f)), 2000);
    assert.match(readFileSync(path.join(ROOT, f), "utf8"), /net-window\.mjs/);
  });
}

test("every script that opens a connection is in CHANGED, or in KEEP with its reason", () => {
  const known = new Set([...CHANGED, ...Object.keys(KEEP)]);
  const open = files().filter((f) => NET.test(readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(open.filter((f) => !known.has(f)), [], "a script opens a connection without the shared module: add it to CHANGED or give KEEP a reason");
  for (const f of CHANGED) assert.ok(open.includes(f), `${f} is in CHANGED but opens no connection by this test's search: remove it or fix the search`);
});
