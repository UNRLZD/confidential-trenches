// Every live check that reads HELPER_HOST, run after each helper deploy (card ci-live-runners). The helper deploys from
// its server (apps/helper/deploy/redeploy.sh), which cannot print its own checks' runs, so this file is the list: live.yml
// reads it for host=helper, the way it reads the two Cloudflare deploy scripts' LIVE_CHECKS for host=app and host=sign.
// It lives here, not beside redeploy.sh: apps/helper/deploy is a helper image input (image-inputs.mjs), so a change there
// moves the commit helper-host-health expects the helper to run, and would need a redeploy for a list of checks.
// The commit is the one redeploy.sh was given; the helper reports it in X-Helper-Commit (helper-host-health).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poolRecordName } from "../live-checks/pool-redeploys.mjs";

export const LIVE_CHECKS = [
  "helper-host-health",
  "helper-proxy",
  "helper-rpc-proxy",
  "helper-token-watch",
  "helper-usdc-event-watch",
  "helper-pool-senders",
  "helper-evm-sender",
  "helper-evm-sender-2",
  "evm-sell-hook-converge",
  "helper-sell-fee-recipient",
  "helper-sender-fee-proof",
  "helper-abuse-limits",
  "market-data-solana-lists",
  "market-data-solana-token",
  "market-data-evm",
  "helper-launchpad-origin",
  "index-evm-swaps",
  "index-sol-trades",
  "relayer-withdraw-send",
  "relayer-withdraw-fee",
  "helper-solana-failover",
  "app-console-429",
  "helper-token-page-cold",
  "solana-jupiter-build",
  "solana-legs-share-wait",
  "solana-mint-supply-moves",
  "wallet-per-buy",
  "helper-v4-hook-liquidity",
  "helper-robinhood-capacity",
  "helper-robinhood-search-ahead",
  "evm-buy-hookdata-fee",
  "helper-evm-abi-tie",
  "helper-tape-4337-trader",
  "helper-live-bars-no-503",
  "sol-small-note-buys",
  "evm-rpc-spare-list",
  "base-200ms-blocks",
  "wallet-restore-transfer-rpcs",
  "pool-buy-send-fast",
  "helper-page-jup-429",
  "vault-review-fixes-1",
  "oneclick-partner-fee-live",
  "evm-testnet-delegate-review3",
  "robinhood-mainnet-rpcs",
  "helper-usdc-pending-pause",
  "helper-rpc-sell-methods",
  "robinhood-listed-tape-opens",
];

// `{commit}` is the deployed commit
export const LIVE_ARGS = { "helper-host-health": "--commit {commit}" };

// helper-pool-senders takes one --pool: it runs once for each Solana cluster the helper may serve (the keys of
// POOL_SOLANA_ENV in apps/helper/src/pool/solana.ts, a test holds them), with the pool its deploy record names, read from
// the record's file in the checked-out commit, never typed here. A cluster with no record has no pool to check: it is
// listed not-applicable with that reason, and the check runs on the clusters that have one.
export const POOL_SOLANA_CLUSTERS = ["mainnet", "devnet"];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const poolRecord = (cluster) => `scripts/live-checks/pool-sol-deploy.${cluster}.json`;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The pool each cluster's deploy record names under `root`, or null where there is no record. Throws on a bad record. */
export function solanaPools(root = ROOT) {
  return Object.fromEntries(
    POOL_SOLANA_CLUSTERS.map((cluster) => {
      const file = path.join(root, poolRecord(cluster));
      if (!existsSync(file)) return [cluster, null];
      let rec;
      try {
        rec = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(`${poolRecord(cluster)} is not JSON`);
      }
      if (rec?.cluster !== cluster) throw new Error(`${poolRecord(cluster)} names cluster ${rec?.cluster}, not ${cluster}`);
      if (typeof rec.pool !== "string" || !B58.test(rec.pool)) throw new Error(`${poolRecord(cluster)} names no pool address`);
      return [cluster, rec.pool];
    }),
  );
}

// helper-evm-sender-2.mjs runs helper-pool-senders' EVM branch once for each EVM network a pool may be deployed on
// (card helper-evm-sender-2; the testnets and mainnets of scripts/live-checks/pool-evm-deploy.mjs, CHAINS and MAINNETS,
// a test holds them), with the PrivacyPoolSimple its deploy record names: a testnet's record is its newest pool set's,
// scripts/live-checks/<card>.<network>.json for a card of POOL_REDEPLOYS (pool-redeploys.mjs poolRecordName, the one
// list), else pool-evm-deploy.<network>.json; a mainnet's contracts/pool-evm/deployments/<network>.json
// (pool-evm-deploy.mjs poolFile, a test holds them equal). A network with no record has no run.
export const POOL_EVM_NETWORKS = ["base", "robinhood", "base-sepolia", "robinhood-testnet"];
const EVM_MAINNETS = new Set(["base", "robinhood"]);
export const evmPoolRecord = (network, root = ROOT) =>
  EVM_MAINNETS.has(network) ? `contracts/pool-evm/deployments/${network}.json` : `scripts/live-checks/${poolRecordName(network, path.join(root, "scripts/live-checks"))}`;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** The PrivacyPoolSimple each EVM network's deploy record names under `root`, lower case, or null where there is no
 *  record. Throws on a bad record. */
export function evmPools(root = ROOT) {
  return Object.fromEntries(
    POOL_EVM_NETWORKS.map((network) => {
      const file = path.join(root, evmPoolRecord(network, root));
      if (!existsSync(file)) return [network, null];
      let rec;
      try {
        rec = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(`${evmPoolRecord(network, root)} is not JSON`);
      }
      if (rec?.chain !== network) throw new Error(`${evmPoolRecord(network, root)} names chain ${rec?.chain}, not ${network}`);
      const pool = rec.contracts?.PrivacyPoolSimple?.address;
      if (typeof pool !== "string" || !EVM_ADDRESS.test(pool.toLowerCase())) throw new Error(`${evmPoolRecord(network, root)} names no PrivacyPoolSimple address`);
      return [network, pool.toLowerCase()];
    }),
  );
}

/** helper-pool-senders' runs, one per cluster with a record, and why the clusters with none are not applicable (or null).
 *  The EVM pools run through helper-evm-sender-2.mjs (evmPools), their one owner. */
export function poolSenderPlan(root = ROOT) {
  const pools = solanaPools(root);
  const none = POOL_SOLANA_CLUSTERS.filter((c) => !pools[c]);
  return {
    runs: POOL_SOLANA_CLUSTERS.filter((c) => pools[c]).map((c) => `scripts/live-checks/helper-pool-senders.mjs --pool ${pools[c]}`),
    notApplicable: none.length ? none.map((c) => `no Solana ${c} pool is deployed: ${poolRecord(c)} does not exist`).join("; ") : null,
  };
}

// A check the runner cannot run, with why. live.yml lists each one in the run's summary as skipped-<reason> and runs
// nothing for it; a skip is never a pass. A test holds each reason to what the check reads.
//   needs-secret: reads the vendor keys the host holds (helper-proxy's ENV_KEYS); a public-repo run has no secret.
//   needs-relayer: the release names no relayer account yet (relayer-withdraw-fee's RELEASE_RELAYER), and the check
//     takes it from --relayer-mainnet and --relayer-testnet.
export const SKIPPED = {
  "helper-proxy": { reason: "needs-secret", detail: "JUPITER_API_KEY, RELAY_API_KEY, LIFI_API_KEY and ONECLICK_JWT" },
  "relayer-withdraw-fee": { reason: "needs-relayer", detail: "the release names no relayer account yet (RELEASE_RELAYER), so the check takes --relayer-mainnet and --relayer-testnet" },
};

// Card helper-live-jup-serial: the checks that spend the helper's Jupiter budget run one after another in ONE job, never in
// parallel jobs. The helper counts every send to Jupiter in one window for all its callers (apps/helper/src/proxy/proxy.ts:
// Free's 10 in any 10 s and 60 in a minute; the page's search 16 in the counted minute, token.ts SEARCH_PER_SPAN) and serves
// a device's build before a page's search, so checks started together spend it between them and a page falls back to chain
// reads: run 42332950254 attempt 1 (7 Nov 03:13Z, right after the 0a5f4f68 swap) read helper-token-page-cold "24 of 32 read
// cold" and market-data-solana-token X-Helper-Source "chain", and 42328556922 attempt 1 read 27 of 32, each green again when
// run alone. A group is one matrix entry of the plan (live-plan.mjs); scripts/ci/live-serial.mjs runs its members in this
// order, each one only once the helper's own answer says a search goes at once (scripts/ci/jup-idle.mjs), no retry. The order:
// the page checks first, the build checks last. A page's search is the helper's strictest lane (it goes at once only with
// fewer than 6 of the window's 10 sends spent, or no page in it), so an idle read for it holds for a device's build, which
// needs fewer than 9, and a build check leaves no sends in a minute that a page check after it would read (proxy.ts freeAt).
// Every member is one run with no arguments.
export const SERIAL_GROUPS = {
  "jupiter-budget": [
    "helper-token-page-cold",
    "market-data-solana-token",
    "helper-page-jup-429",
    "solana-legs-share-wait",
    "solana-mint-supply-moves",
    "solana-jupiter-build",
  ],
};

// A check live-workflow.mjs finds reading the helper's Jupiter budget (BUDGET_READS) that is in no group, with why it needs
// none. A check is never exempt for being slow or for passing alone.
export const BUDGET_EXEMPT = {
  "app-console-429": "opens the top Trending token's page: a listed token takes its row from Discover's lists with no Jupiter call (apps/helper/src/data/solana/token.ts listedRow)",
};

export const liveRuns = (k, { commit = "{commit}", root = ROOT } = {}) =>
  k === "helper-pool-senders" ? poolSenderPlan(root).runs : [`scripts/live-checks/${k}.mjs${LIVE_ARGS[k] ? ` ${LIVE_ARGS[k].replaceAll("{commit}", commit)}` : ""}`];

/** The list live.yml reads (scripts/ci/live-plan.mjs runs `node <this file> --live-runs --commit <sha>`). */
export const liveList = (opts = {}) => {
  const pool = poolSenderPlan(opts.root);
  const notApplicable = pool.notApplicable ? { "helper-pool-senders": pool.notApplicable } : {};
  return { checks: LIVE_CHECKS, skipped: SKIPPED, notApplicable, serial: SERIAL_GROUPS, budgetExempt: BUDGET_EXEMPT, runs: Object.fromEntries(LIVE_CHECKS.map((k) => [k, liveRuns(k, opts)])) };
};

if (process.argv[2] === "--live-runs" && import.meta.main) {
  const a = process.argv.slice(3);
  console.log(JSON.stringify(liveList({ commit: a.includes("--commit") ? a[a.indexOf("--commit") + 1] : undefined })));
}
