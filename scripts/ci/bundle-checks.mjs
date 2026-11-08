#!/usr/bin/env node
// The bundle checks on a pull request's own build (card signpage-check-shapes-on-build): every SIGN_HOST and APP_HOST
// live check whose verdict reads only what the host serves from the build (index.html and the scripts it names) runs
// its own read and judge on this checkout's build, so a change that breaks one of their facts, or only reshapes the
// code one reads, fails here, before a deploy, and not on the live host after it (host=sign run 42348279478: release-73
// served a correct reader whose minified shape signpage-withdraw-own-spend's old regex did not know).
//   SIGN_HOST's build is packages/signpage's index.html and public/, the files its deploy copies and serves
//   (packages/signpage/scripts/deploy.mjs build()), which packages/signpage/scripts/build-app.test.mjs holds equal to a
//   fresh build-app.mjs build. APP_HOST's is apps/terminal/dist, from `pnpm --filter terminal build` run first (the
//   deploy's own vite build).
// Two ways a check runs:
//   IN_PROCESS: the check's exported read with a fetch that answers from the build folders as the host would (a path
//     on SIGN_HOST from index.html and public/, on APP_HOST from dist/); a request to any other origin throws, so a
//     check that reads more than the build cannot pass here;
//   CHILD_RUNS: the check's own local mode (--local, --root), which reads this checkout's build itself.
// Not run here, and why (OUT): a check that needs a browser, the network past the build (an RPC, the helper, a run
// record's transactions), or the response headers the host adds (the deploys' own gates read the build's _headers).
//   pnpm --filter terminal build && node scripts/ci/bundle-checks.mjs
// PASS exit 0; any check FAIL or ERROR exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN = "https://sign.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const SIGN_DIR = path.join(ROOT, "packages/signpage");
export const APP_DIR = path.join(ROOT, "apps/terminal/dist");

const viaRead = (key, load) => ({ key, host: "sign", load, run: async (m, f) => m.judge(await m.read(f)) });
/** The checks run in this process: each loads scripts/live-checks/<key>.mjs (a static import, which check:imports reads). */
export const IN_PROCESS = [
  viaRead("signpage-withdraw-own-spend", () => import("../live-checks/signpage-withdraw-own-spend.mjs")),
  viaRead("signpage-buy-own-spend", () => import("../live-checks/signpage-buy-own-spend.mjs")),
  viaRead("signpage-sent-read-back", () => import("../live-checks/signpage-sent-read-back.mjs")),
  viaRead("signpage-error-after-timeout", () => import("../live-checks/signpage-error-after-timeout.mjs")),
  viaRead("sol-buy-rent-back", () => import("../live-checks/sol-buy-rent-back.mjs")),
  viaRead("pool-read-down", () => import("../live-checks/pool-read-down.mjs")),
  viaRead("evm-pool-sync-wide-pages", () => import("../live-checks/evm-pool-sync-wide-pages.mjs")),
  viaRead("wallet-near-prepay-taken", () => import("../live-checks/wallet-near-prepay-taken.mjs")),
  viaRead("evm-sell-no-release-in-flight", () => import("../live-checks/evm-sell-no-release-in-flight.mjs")),
  viaRead("kit-deposit-calls", () => import("../live-checks/kit-deposit-calls.mjs")),
  viaRead("kit-frame-version", () => import("../live-checks/kit-frame-version.mjs")),
  viaRead("kit-oneclick-pins-frozen", () => import("../live-checks/kit-oneclick-pins-frozen.mjs")),
  viaRead("pool-answer-unknown", () => import("../live-checks/pool-answer-unknown.mjs")),
  viaRead("oneclick-fee-path-own-key", () => import("../live-checks/oneclick-fee-path-own-key.mjs")),
  viaRead("pool-deposit-sent-end", () => import("../live-checks/pool-deposit-sent-end.mjs")),
  viaRead("pool-deposit-address", () => import("../live-checks/pool-deposit-address.mjs")),
  viaRead("solana-release-reads-paced", () => import("../live-checks/solana-release-reads-paced.mjs")),
  viaRead("solana-legs-checked", () => import("../live-checks/solana-legs-checked.mjs")),
  viaRead("solana-written-accounts-whole", () => import("../live-checks/solana-written-accounts-whole.mjs")),
  { key: "signpage-withdraw-form", host: "sign", load: () => import("../live-checks/signpage-withdraw-form.mjs"), run: async (m, f) => m.judge(await m.probe(SIGN, f)) },
  { key: "wallet-withdraw-move-out", host: "sign", load: () => import("../live-checks/wallet-withdraw-move-out.mjs"), run: async (m, f) => m.judge(await m.probe(SIGN, f)) },
  { key: "signpage-pool-kinds", host: "sign", load: () => import("../live-checks/signpage-pool-kinds.mjs"), run: async (m, _f, dirs) => m.judge(await m.read(dirs.sign)) },
  { key: "app-harness-signin-e2e", host: "sign", load: () => import("../live-checks/app-harness-signin-e2e.mjs"), run: async (m, f) => m.judge(await m.probe(SIGN, APP, ["sign"], f)) },
  { key: "app-harness-signin-e2e", host: "app", load: () => import("../live-checks/app-harness-signin-e2e.mjs"), run: async (m, f) => m.judge(await m.probe(SIGN, APP, ["app"], f)) },
];
/** The checks run in their own local mode, as a child process: the arguments after the check's path. */
export const CHILD_RUNS = [
  { key: "kit-renewal-read-bounded", host: "sign", args: ["--local"] },
  { key: "signpage-buy-route-events", host: "sign", args: ["--local", "--host", "sign"] },
  { key: "signpage-buy-route-events", host: "app", args: ["--local", "--host", "app"] },
  { key: "app-buy-route-strip", host: "app", args: ["--root", "apps/terminal/dist"] },
  { key: "app-quick-buy-one-tap", host: "app", args: ["--root", "apps/terminal/dist"] },
  { key: "app-toast-clears-sheet-head", host: "app", args: ["--root", "apps/terminal/dist"] },
  { key: "app-chart-controls", host: "app", args: ["--root", "apps/terminal/dist"] },
];
/** The deploys' checks left out, with the reason. */
export const OUT = {
  "signpage-skeleton": "response headers (the sign deploy's gate runs it on the build's _headers)",
  "app-host-gate": "response headers (the app deploy's gate reads the build's _headers)",
  "app-release-sri": "response headers (CSP, Integrity-Policy) the host adds",
  "page-evm-rpc-csp": "response headers (each page's served CSP connect-src; app-host-gate and signpage-skeleton pin it in the build's _headers)",
  "signpage-solana-trade": "the page's CSP header, and a run record's transactions on two RPCs",
  "signpage-withdraw-handoff": "the page's CSP header, and the testnet fee read on the release helper and RPCs",
  "signpage-release": "the release list against what the host serves",
  "wallet-deposit-follow": "the helper's deposit status answer",
  "pool-ready-no-flicker": "the devnet run record",
  "signpage-pool-flow": "devnet RPC reads",
  "signpage-pool-notes": "devnet RPC reads of the run",
  "signpage-pool-withdraw-form": "devnet RPC reads of the run",
  "signpage-pool-pins": "devnet RPC reads",
  "pool-deposits": "devnet RPC reads of the run",
  "wallet-passkey-prf": "a browser",
  "signpage-postmessage": "a browser",
  "signpage-shell": "a browser",
  "signpage-signin-kinds": "a browser",
  "signpage-prover-host": "a browser",
  "signpage-prover-threads": "a browser",
  "signpage-pool-price": "a browser",
  "signpage-pool-mainnet": "a browser",
  "pool-restore-wired": "a browser",
  "kit-deposit-assets-dry": "a browser",
  "app-shell": "a browser",
  "app-in-shell": "a browser (its --harness run is in test-browser)",
  "app-discover-live": "a browser and the helper",
  "app-no-test-token": "a browser and the helper",
  "app-launchpad-badges": "a browser and the helper",
  "app-token-route": "a browser and the helper",
  "app-trade-box-mount": "a browser",
  "app-token-chart": "a browser and the helper",
  "app-chart-live": "a browser and the helper",
  "app-verify-mount": "a browser and NEAR RPCs",
  "app-no-blank-pages": "a browser",
  "app-portfolio-mount": "a browser (its --harness run is in test-browser)",
  "trade-box-pool": "a browser",
  "app-console-429": "the helper under load",
  "trade-box-bal-cash": "a browser",
  "app-list-age": "a browser and the helper",
  "app-pool-withdraw": "a browser",
  "app-hop-sync-lock": "a browser",
  "balances-per-chain": "a browser and chain RPCs",
  "app-export-every-wallet": "a browser",
  "evm-quote-warm-round": "EVM RPC quotes",
  "evm-quote-lag-held": "EVM RPC quotes",
  "evm-sell-hook-intrablock": "EVM RPC traces and replays",
  "rh-cold-quote": "EVM RPC quotes",
  "token-page-fills-after": "a browser and the helper",
  "app-deposit-mount": "a browser (its --harness run is in test-browser)",
};

/** A fetch that answers from the build folders: SIGN_HOST's / and index.html, every other path public/<path>; APP_HOST's dist/<path>. */
export function buildFetch({ sign, app }) {
  return async (input) => {
    const u = new URL(String(input));
    const p = decodeURIComponent(u.pathname);
    let file;
    if (u.origin === SIGN) file = p === "/" || p === "/index.html" ? path.join(sign, "index.html") : path.join(sign, "public", p);
    else if (u.origin === APP) file = path.join(app, p === "/" ? "index.html" : p);
    else throw new Error(`${u.origin}: not this build (the check reads past the bundle)`);
    const base = u.origin === SIGN ? sign : app;
    if (!path.resolve(file).startsWith(path.resolve(base) + path.sep) || !existsSync(file)) return new Response("", { status: 404 });
    return new Response(readFileSync(file), { status: 200 });
  };
}

/** Runs the checks on the build folders: [{ key, host, ok, lines }], one per run. */
export async function run({ sign = SIGN_DIR, app = APP_DIR, inProcess = IN_PROCESS, childRuns = CHILD_RUNS, root = ROOT } = {}) {
  const f = buildFetch({ sign, app });
  const out = [];
  for (const c of inProcess) {
    try {
      const m = await c.load();
      const v = await c.run(m, f, { sign, app });
      const ok = (v?.ok ?? v?.pass) === true; // the checks' judges answer { ok, lines } or { pass, lines }
      out.push({ key: c.key, host: c.host, ok, lines: ok ? [] : (v?.lines ?? []) });
    } catch (e) {
      out.push({ key: c.key, host: c.host, ok: false, lines: [`ERROR ${e?.message ?? e}`] });
    }
  }
  for (const c of childRuns) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/live-checks", `${c.key}.mjs`), ...c.args], { cwd: root, encoding: "utf8", timeout: 120_000 });
    const lines = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => l.trim());
    out.push({ key: c.key, host: c.host, ok: r.status === 0, lines: r.status === 0 ? [] : lines.slice(-12) });
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(path.join(APP_DIR, "index.html"))) {
    console.error(`no APP_HOST build at ${path.relative(ROOT, APP_DIR)}: run pnpm --filter terminal build first`);
    process.exit(1);
  }
  const results = await run();
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.key} (${r.host})`);
    for (const l of r.lines) console.log(`  ${l}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `${bad} of ${results.length} bundle check runs FAIL on this build` : `all ${results.length} bundle check runs PASS on this build`);
  process.exit(bad ? 1 : 0);
}
