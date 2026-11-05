// Every live check that reads HELPER_HOST, run after each helper deploy (card ci-live-runners). The helper deploys from
// its server (apps/helper/deploy/redeploy.sh), which cannot print its own checks' runs, so this file is the list: live.yml
// reads it for host=helper, the way it reads the two Cloudflare deploy scripts' LIVE_CHECKS for host=app and host=sign.
// It lives here, not beside redeploy.sh: apps/helper/deploy is a helper image input (image-inputs.mjs), so a change there
// moves the commit helper-host-health expects the helper to run, and would need a redeploy for a list of checks.
// The commit is the one redeploy.sh was given; the helper reports it in X-Helper-Commit (helper-host-health).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_CHECKS = [
  "helper-host-health",
  "helper-proxy",
  "helper-rpc-proxy",
  "helper-token-watch",
  "helper-usdc-event-watch",
  "helper-pool-senders",
  "helper-evm-sender",
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
  "wallet-per-buy",
  "helper-v4-hook-liquidity",
  "helper-robinhood-capacity",
  "helper-robinhood-search-ahead",
  "evm-buy-hookdata-fee",
  "helper-tape-4337-trader",
  "helper-live-bars-no-503",
  "sol-small-note-buys",
  "evm-rpc-spare-list",
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

/** helper-pool-senders' runs, one per cluster with a record, and why the clusters with none are not applicable (or null). */
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

export const liveRuns = (k, { commit = "{commit}", root = ROOT } = {}) =>
  k === "helper-pool-senders" ? poolSenderPlan(root).runs : [`scripts/live-checks/${k}.mjs${LIVE_ARGS[k] ? ` ${LIVE_ARGS[k].replaceAll("{commit}", commit)}` : ""}`];

/** The list live.yml reads (scripts/ci/live-plan.mjs runs `node <this file> --live-runs --commit <sha>`). */
export const liveList = (opts = {}) => {
  const pool = poolSenderPlan(opts.root);
  const notApplicable = pool.notApplicable ? { "helper-pool-senders": pool.notApplicable } : {};
  return { checks: LIVE_CHECKS, skipped: SKIPPED, notApplicable, runs: Object.fromEntries(LIVE_CHECKS.map((k) => [k, liveRuns(k, opts)])) };
};

if (process.argv[2] === "--live-runs" && import.meta.main) {
  const a = process.argv.slice(3);
  console.log(JSON.stringify(liveList({ commit: a.includes("--commit") ? a[a.indexOf("--commit") + 1] : undefined })));
}
