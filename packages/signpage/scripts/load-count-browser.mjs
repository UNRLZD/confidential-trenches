#!/usr/bin/env node
// What one signed-in load of SIGN_HOST asks, by route and by second (card a-load-proves-first-and-walks-the-restore-once).
// The signing page's mainnet build and the terminal's build on the terminal's harness under the shipped names, every chain
// read answered by restore-speed-browser.mjs's models (the pinned Solana pool with the published all-zero test vector's 8
// notes, the EVM pools and the NEAR vault empty, each answer RTT_MS late); no real host is reached. The run signs in with
// the vector's words (typed, never printed), waits until the restore's walk has written its notes and `--settle` seconds
// more, then reloads the page `--loads` times, `--window` seconds each, and records every request each load makes: its
// second after the reload, its host and path, and on a JSON-RPC body its methods. `--refuse <host>` answers every request
// to that host 403 (a provider that refuses the page's origin, as base-rpc.publicnode.com did on 13 Nov 06:13Z).
//
// Per load it prints: each route's count and its busiest 10 s against the helper's window for one device (the helper's
// own numbers: apps/helper/src/server.ts UPSTREAM_ROUTE_MAX, POOL_RATE_MAX, API_RATE_MAX; rpc/rpc.ts RPC_PAGE_NEED per
// chain), the page's "restore: <chain> walked" and "pool pass:" lines with their second, and the second the first
// prover Worker started.
//
//   node packages/signpage/scripts/load-count-browser.mjs [--loads 3] [--window 30] [--settle 15] [--refuse <host>]
//     [--record <file>] [--timeout <s>]
// Records hold counts, routes, methods and seconds only: never the words, a key, an id or a one-time wallet.
// PASS exit 0 (no helper route over its window in any load, and no load walked a pool more than once: each load walks
// each pool once by design), FAIL exit 1, error exit 2.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REAL, startHarness } from "../../../apps/terminal/test/harness/harness.mjs";
import { entropyToWords } from "../../wallet/src/derive/index.ts";
import { CONTINUE, STEP_MS, evmChain, nearVault, route } from "./restore-speed-browser.mjs";

/** The helper's window for one device, 10 s, by route (the helper's own constants, read from its source). */
export const HELPER_WINDOW = Object.freeze({
  "/v1/rpc": 120, // UPSTREAM_ROUTE_MAX, the whole RPC route
  "/v1/rpc/solana": 42, // RPC_PAGE_NEED.solana: each chain's share
  "/v1/rpc/solana-marks": 30,
  "/v1/rpc/base": 30,
  "/v1/rpc/robinhood": 30,
  "/v1/rpc/near": 30,
  "/v1/proxy": 120, // UPSTREAM_ROUTE_MAX, the proxy route apart
  "/v1/pool": 30, // POOL_RATE_MAX
  other: 120, // API_RATE_MAX
});

/** A helper path's windows: the RPC route and its chain's share, the proxy, the pool routes, or the rest. */
export function helperWindowsOf(path) {
  if (path.startsWith("/v1/rpc/")) return ["/v1/rpc", path.split("?")[0]];
  if (path.startsWith("/v1/proxy/")) return ["/v1/proxy"];
  if (path.startsWith("/v1/pool")) return ["/v1/pool"];
  return ["other"];
}

/** The most requests inside any 10 s of `ts` (seconds, any order). */
export function busiest10(ts) {
  const s = [...ts].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < s.length; i++) {
    while (s[i] - s[j] >= 10) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** One load's requests summed: by route, each helper window's busiest 10 s against its limit, the restore lines. */
export function summarize(load) {
  const routes = {};
  const helper = {};
  for (const r of load.requests) {
    const key = r.host === REAL.api ? `helper ${r.path.split("?")[0]}` : r.host;
    (routes[key] ??= { n: 0, first: r.s, methods: {} }).n += 1;
    for (const m of r.methods ?? []) routes[key].methods[m] = (routes[key].methods[m] ?? 0) + 1;
    if (r.host === REAL.api) for (const w of helperWindowsOf(r.path)) (helper[w] ??= []).push(r.s);
  }
  const windows = Object.fromEntries(Object.entries(helper).map(([w, ts]) => [w, { busiest10: busiest10(ts), limit: HELPER_WINDOW[w] ?? HELPER_WINDOW.other }]));
  const walked = load.lines.filter((l) => /^restore: \S+ walked$/.test(l.text));
  return { routes, windows, over: Object.entries(windows).filter(([, x]) => x.busiest10 > x.limit).map(([w]) => w), walked: walked.map((l) => `${l.text} @${l.s}s`), twice: [...new Set(walked.map((l) => l.text).filter((t, k, all) => all.indexOf(t) !== k))], passes: load.lines.filter((l) => l.text.startsWith("pool pass:")).map((l) => `${l.text} @${l.s}s`), prover: load.prover };
}

async function main() {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const loads = Number(opt("--loads", "3"));
  const windowS = Number(opt("--window", "30"));
  const settleS = Number(opt("--settle", "15"));
  const refuse = opt("--refuse", null);
  const timeoutS = Number(opt("--timeout", "600"));
  const start = Date.now();
  const h = await startHarness({ realNames: true });
  const rec = { refuse, loads: [], signIn: null, unanswered: [] };
  try {
    const out = { answers: {}, app: {}, unanswered: [] };
    const context = await h.browser.newContext({ viewport: { width: 1440, height: 900 } });
    await route(context, { mode: "workers", sites: null, evm: { base: evmChain("base", 1000, start), robinhood: evmChain("robinhood", 1000, start) }, near: nearVault(), out });
    // every request, recorded before restore-speed's answers (a route added later is asked first); a refused host 403
    let cur = null;
    await context.route(
      () => true,
      async (r) => {
        const req = r.request();
        let u;
        try {
          u = new URL(req.url());
        } catch {
          return r.fallback();
        }
        if (cur !== null && req.method() !== "OPTIONS" && u.hostname !== REAL.sign && u.hostname !== REAL.app) {
          let methods;
          try {
            const b = JSON.parse(req.postData() ?? "");
            methods = (Array.isArray(b) ? b : [b]).map((x) => (x.method === "query" ? `query ${x.params?.request_type ?? ""} ${x.params?.method_name ?? ""}`.trim() : String(x.method)));
          } catch {}
          cur.requests.push({ s: Number(((Date.now() - cur.t0) / 1000).toFixed(2)), host: u.hostname, path: u.pathname + (u.search.includes("keyed=only") ? "?keyed=only" : ""), ...(methods ? { methods } : {}) });
        }
        if (refuse !== null && u.hostname === refuse) {
          const origin = req.headers().origin ?? "*";
          return r.fulfill({ status: 403, headers: { "access-control-allow-origin": origin, "content-type": "text/plain" }, body: "forbidden\n" });
        }
        return r.fallback();
      },
    );
    const page = await context.newPage();
    page.on("console", (m) => cur?.lines.push({ s: Number(((Date.now() - cur.t0) / 1000).toFixed(2)), text: m.text() }));
    page.on("worker", (w) => {
      if (cur !== null && cur.prover === null && /prover/.test(w.url())) cur.prover = Number(((Date.now() - cur.t0) / 1000).toFixed(2));
    });
    const top = (sel) => page.locator(sel).first();
    const app = page.frameLocator("iframe#app");
    const vis = (sel) => app.locator(`${sel} >> visible=true`).first();
    // the sign-in: its requests recorded as load 0
    cur = { t0: Date.now(), requests: [], lines: [], prover: null };
    rec.signIn = cur;
    await page.goto(`https://${REAL.app}/discover`, { waitUntil: "commit" });
    await page.waitForURL((x) => x.hostname === REAL.sign, { timeout: STEP_MS });
    await app.locator(':root[data-signpage="ready"]').waitFor({ state: "attached", timeout: STEP_MS });
    await vis('[data-header="S1.1"] button, button[data-header="S1.1"]').click({ timeout: STEP_MS });
    await vis('.sgn-opt[data-way="wallet"]').click({ timeout: STEP_MS });
    await top('#screen:not([hidden]) #signin[data-signin="choose"] button[data-action="have-one"]').click({ timeout: STEP_MS });
    await top('#signin[data-signin="existing"] button[data-action="recovery"]').click({ timeout: STEP_MS });
    await top('#signin[data-signin="words"] textarea[data-input="words"]').fill(entropyToWords(new Uint8Array(16)), { timeout: STEP_MS });
    await top(CONTINUE).click({ timeout: STEP_MS });
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline && !cur.lines.some((l) => l.text === "restore: solana walked")) await page.waitForTimeout(250);
    if (!cur.lines.some((l) => l.text === "restore: solana walked")) throw new Error("the sign-in's restore never wrote the Solana notes");
    await page.waitForTimeout(settleS * 1000);
    for (let k = 1; k <= loads; k++) {
      cur = { t0: Date.now(), requests: [], lines: [], prover: null };
      rec.loads.push(cur);
      await page.reload({ waitUntil: "commit" });
      await page.waitForTimeout(windowS * 1000);
    }
    cur = null;
    rec.unanswered = out.unanswered.map(({ t, ...x }) => ({ ...x, s: Number(((t - start) / 1000).toFixed(2)) }));
    await context.close().catch(() => {});
  } finally {
    await h.close();
  }
  let ok = true;
  const sums = [rec.signIn, ...rec.loads].map(summarize);
  sums.forEach((s, k) => {
    const label = k === 0 ? "sign-in" : `load ${k}`;
    console.log(`${label}${refuse ? ` (${refuse} 403)` : ""}:`);
    for (const [r, x] of Object.entries(s.routes).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${r}: ${x.n} (first @${x.first}s) ${Object.entries(x.methods).map(([m, n]) => `${m} ${n}`).join(", ")}`);
    for (const [w, x] of Object.entries(s.windows)) console.log(`  window ${w}: busiest 10 s ${x.busiest10} of ${x.limit}${x.busiest10 > x.limit ? " OVER" : ""}`);
    console.log(`  restore lines: ${s.walked.join("; ") || "none"}`);
    console.log(`  pass lines: ${s.passes.join("; ") || "none"}; first prover Worker @${s.prover ?? "-"}s`);
    if (k > 0) ok &&= s.over.length === 0 && s.twice.length === 0;
  });
  const file = opt("--record", null);
  if (file) writeFileSync(file, `${JSON.stringify({ refuse, unanswered: rec.unanswered, sums, loads: rec.loads.map((l) => ({ requests: l.requests, lines: l.lines.filter((x) => /^(restore|pool pass)/.test(x.text)), prover: l.prover })) }, null, 1)}\n`);
  for (const x of rec.unanswered.slice(0, 10)) console.log(`unanswered: ${x.method} ${x.host}${x.path} @${x.s}s from the start`);
  console.log(`${ok ? "PASS" : "FAIL"} load-count-browser`);
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`ERROR load-count-browser: ${e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
