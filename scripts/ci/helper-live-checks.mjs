// Every live check that reads HELPER_HOST, run after each helper deploy (card ci-live-runners). The helper deploys from
// its server (apps/helper/deploy/redeploy.sh), which cannot print its own checks' runs, so this file is the list: live.yml
// reads it for host=helper, the way it reads the two Cloudflare deploy scripts' LIVE_CHECKS for host=app and host=sign.
// It lives here, not beside redeploy.sh: apps/helper/deploy is a helper image input (image-inputs.mjs), so a change there
// moves the commit helper-host-health expects the helper to run, and would need a redeploy for a list of checks.
// The commit is the one redeploy.sh was given; the helper reports it in X-Helper-Commit (helper-host-health).

export const LIVE_CHECKS = [
  "helper-host-health",
  "helper-proxy",
  "helper-rpc-proxy",
  "helper-token-watch",
  "helper-usdc-event-watch",
  "helper-pool-senders",
  "helper-abuse-limits",
  "market-data-solana-lists",
  "market-data-solana-token",
  "market-data-evm",
  "relayer-withdraw-send",
  "relayer-withdraw-fee",
];

// `{commit}` is the deployed commit
export const LIVE_ARGS = { "helper-host-health": "--commit {commit}" };

// A check the runner cannot run, with why. live.yml lists each one in the run's summary as skipped-<reason> and runs
// nothing for it; a skip is never a pass. A test holds each reason to what the check reads.
//   needs-secret: reads the vendor keys the host holds (helper-proxy's ENV_KEYS); a public-repo run has no secret.
//   needs-relayer: the release names no relayer account yet (relayer-withdraw-fee's RELEASE_RELAYER), and the check
//     takes it from --relayer-mainnet and --relayer-testnet.
export const SKIPPED = {
  "helper-proxy": { reason: "needs-secret", detail: "JUPITER_API_KEY, RELAY_API_KEY, LIFI_API_KEY and ONECLICK_JWT" },
  "relayer-withdraw-fee": { reason: "needs-relayer", detail: "the release names no relayer account yet (RELEASE_RELAYER), so the check takes --relayer-mainnet and --relayer-testnet" },
};

export const liveRuns = (k, { commit = "{commit}" } = {}) => [`scripts/live-checks/${k}.mjs${LIVE_ARGS[k] ? ` ${LIVE_ARGS[k].replaceAll("{commit}", commit)}` : ""}`];

/** The list live.yml reads (scripts/ci/live-plan.mjs runs `node <this file> --live-runs --commit <sha>`). */
export const liveList = (opts = {}) => ({ checks: LIVE_CHECKS, skipped: SKIPPED, runs: Object.fromEntries(LIVE_CHECKS.map((k) => [k, liveRuns(k, opts)])) });

if (process.argv[2] === "--live-runs" && import.meta.main) {
  const a = process.argv.slice(3);
  console.log(JSON.stringify(liveList({ commit: a.includes("--commit") ? a[a.indexOf("--commit") + 1] : undefined })));
}
