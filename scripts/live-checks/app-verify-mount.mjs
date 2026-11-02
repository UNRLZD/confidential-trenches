#!/usr/bin/env node
// Live check of card app-verify-mount: Verify opens in the app and reads the vault live. Headless Chromium opens
// APP_HOST/verify at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1), finds the terminal's frame inside
// SIGN_HOST's shell, waits for the Verify panel to leave loading, opens both rows and reads:
//   - the panel drew a read (not Unverified, not RPCs disagree), the Code and Funds rows ok, and every check ok:
//     Vault keys, Code hash, Asset, Registration, Token code, Balance (09-design-brief S18.2);
//   - the RPCs it names are two, of two operators (scripts/ci/near-rpc-operators.mjs), on the network the run expects;
//   - this page asked both of them itself, each answered 200: the rows are reads of this session, not a recording;
//   - no CSP violation and no console error in the terminal's frame;
//   - on desktop, the footer's Verify pill opens the panel over the page and its close returns there.
// A screenshot of each width is kept.
//   node scripts/live-checks/app-verify-mount.mjs [--network testnet|mainnet] [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST/verify as it is served; --network is the network its build names (testnet default)
//   node scripts/live-checks/app-verify-mount.mjs --harness [--build <dir>] ...
//     a local build (VITE_NEAR_NETWORK=testnet pnpm --filter terminal build) on the hosts' real names, answered by
//     Playwright's route from local files with the stand-in shell of app-in-shell.mjs; the two NEAR RPCs are the real
//     ones, reached over the network (route.continue), so the reads are live
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkOf, operatorOf } from "../ci/near-rpc-operators.mjs";

const KEY = "app-verify-mount";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const PATH = "/verify";
export const CHECKS = ["keys", "code", "asset", "registration", "tokenCode", "balance"];
export const WIDTHS = [
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
];
const READY_MS = 20_000;
const READ_MS = 30_000;

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = `${r.width} ${PATH}`;
    if (!r.panel) {
      say(false, `${n}: no Verify panel in the terminal's frame (${r.frame ?? "no frame"})`);
      continue;
    }
    const p = r.panel;
    const allOk = CHECKS.every((c) => p.checks[c] === "ok") && Object.keys(p.checks).length === CHECKS.length;
    say(p.state === "read" && p.code === "ok" && p.funds === "ok" && allOk, `${n}: panel ${p.state}, code ${p.code}, funds ${p.funds}; checks ${CHECKS.map((c) => `${c} ${p.checks[c] ?? "none"}`).join(", ")}`);
    const ops = p.rpcs.map(operatorOf);
    const nets = p.rpcs.map(networkOf);
    const two = p.rpcs.length === 2 && ops.every(Boolean) && ops[0] !== ops[1] && nets.every((x) => x === rec.network);
    say(two, `${n}: the panel names ${p.rpcs.join(" and ") || "no RPC"} (${ops.map((o) => o ?? "unknown").join(", ")}; ${nets.map((x) => x ?? "unknown").join(", ")}), want two operators on ${rec.network}`);
    const asked = p.rpcs.map((u) => {
      const q = (r.requests ?? []).filter((x) => x.method === "POST" && sameHost(x.url, u));
      return { u, n: q.length, ok: q.length > 0 && q.every((x) => x.status === 200) };
    });
    say(asked.length === 2 && asked.every((a) => a.ok), `${n}: this page read ${asked.map((a) => `${host(a.u)} ${a.n} time(s)${a.ok ? ", all 200" : ", not all 200"}`).join(" and ") || "no RPC"}`);
    say(p.block !== "" && p.block !== "—" && /^\d{1,3}(,\d{3})*/.test(p.block), `${n}: block ${p.block || "none"}`);
    const errs = [...(r.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...(r.errors ?? []).map((e) => `console ${e}`)];
    say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : "no CSP violation, no console error"}`);
    if (r.width === "desktop") say(r.footer?.opened === true && r.footer?.closedTo === "/", `${n}: the footer's Verify pill ${r.footer?.opened ? "opens the panel" : "does not open the panel"}, close ${r.footer?.closedTo ? `returns to ${r.footer.closedTo}` : "returns nowhere"}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok")), lines };
}

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return String(u);
  }
};
const sameHost = (a, b) => host(a) === host(b);

// ------------------------------------------------------------------------------------------------ the read
// in the terminal's frame, before its scripts: keep CSP violations
const INIT = ({ app }) => {
  if (location.origin !== app || window.top === window) return;
  window.__ctViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
};

const READ_PANEL = () => {
  const v = document.querySelector(".vfy");
  if (!v) return null;
  return {
    state: v.dataset.state,
    code: v.dataset.code,
    funds: v.dataset.funds,
    checks: Object.fromEntries([...v.querySelectorAll("[data-check]")].map((e) => [e.dataset.check, e.dataset.status])),
    rpcs: [...v.querySelectorAll(".rpcline")].map((e) => `https://${e.textContent}`),
    block: v.querySelector(".vmeta dd")?.firstChild?.textContent?.trim() ?? "",
    words: [...v.querySelectorAll(".vchecks .st, .vhd h2, .vrow .nm, .vchecks .nm, .vmeta dt, .vstat")].map((e) => e.textContent),
  };
};

/** The terminal's frame in SIGN_HOST's shell: a top-level visit to APP_HOST moves there first (in-shell.ts). */
async function appFrame(page) {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(APP_HOST));
    if (f) return f;
    await page.waitForTimeout(100);
  }
  return null;
}

async function runOne({ browser, w, shots, route }) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, frame: null, panel: null, requests: [], violations: [], errors: [] };
  try {
    if (route) await ctx.route("**/*", route);
    await ctx.addInitScript(INIT, { app: APP_HOST });
    const page = await ctx.newPage();
    const byReq = new Map();
    // the terminal frame's requests until the panel is read (the pill's own open below reads again, and is not judged)
    let reading = true;
    page.on("request", (q) => {
      if (reading && q.frame().url().startsWith(APP_HOST) && q.frame() !== page.mainFrame()) {
        const e = { url: q.url(), method: q.method(), type: q.resourceType(), status: null };
        byReq.set(q, e);
        run.requests.push(e);
      }
    });
    page.on("response", (res) => {
      const e = byReq.get(res.request());
      if (e) e.status = res.status();
    });
    page.on("console", (m) => m.type() === "error" && (m.location()?.url ?? "").startsWith(APP_HOST) && run.errors.push(m.text()));
    await page.goto(APP_HOST + PATH, { waitUntil: "commit" });
    const f = await appFrame(page);
    if (!f) return run;
    run.frame = f.url();
    await f.waitForSelector(".vfy[data-state]:not([data-state='loading'])", { timeout: READ_MS }).catch(() => {});
    for (const id of ["code", "funds"]) await f.click(`[data-control="verify-${id}"]`, { timeout: 2_000 }).catch(() => {});
    run.panel = await f.evaluate(READ_PANEL);
    reading = false;
    run.violations = await f.evaluate(() => window.__ctViolations ?? []);
    if (shots) await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}.png`) });
    if (w.name === "desktop") {
      // the pill: from the home page, open the panel and close it again
      run.footer = { opened: false, closedTo: null };
      await f.click(".vfy-x", { timeout: 2_000 }).catch(() => {});
      await f.waitForFunction(() => location.pathname === "/" && !document.querySelector(".vfy"), null, { timeout: 5_000 }).catch(() => {});
      if (shots) await page.screenshot({ path: path.join(shots, `${KEY}-desktop-home.png`) });
      await f.click('.ft [data-control="verify"]', { timeout: 5_000 }).catch(() => {});
      run.footer.opened = await f.waitForSelector(".vfy", { timeout: 5_000 }).then(() => true, () => false);
      if (shots && run.footer.opened) await page.screenshot({ path: path.join(shots, `${KEY}-desktop-footer.png`) });
      await f.click(".vfy-x", { timeout: 2_000 }).catch(() => {});
      await f.waitForFunction(() => !document.querySelector(".vfy"), null, { timeout: 5_000 }).catch(() => {});
      run.footer.closedTo = await f.evaluate(() => (document.querySelector(".vfy") ? null : location.pathname));
    }
    return run;
  } finally {
    await ctx.close();
  }
}

/** Every width, in Chromium. `route`: a Playwright route handler for the harness, or null (the deployed hosts). */
export async function collect({ shots, route = null, network, source }) {
  const pw = createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await pw.chromium.launch();
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne({ browser, w, shots, route }));
    return { check: KEY, at: new Date().toISOString(), source, network, browser: browser.version(), runs };
  } finally {
    await browser.close();
  }
}

/** The harness: app-in-shell's route (APP_HOST from `build`, the stand-in shell), with the release's RPCs passed to `rpc`. */
export async function harnessRoute(build, rpcs, rpc = (route) => route.continue()) {
  const { harnessRoute: shell } = await import("./app-in-shell.mjs");
  const inner = await shell(build, "signed");
  return (route) => (rpcs.some((u) => sameHost(route.request().url(), u)) ? rpc(route) : inner(route));
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const shots = opt("--shots") ?? path.join(tmpdir(), `${KEY}-${Date.now()}`);
  const harness = args.includes("--harness");
  const network = opt("--network") ?? "testnet";
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  if (!release) throw new Error(`--network takes ${Object.keys(VERIFY_RELEASES).join(", ")}`);
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const route = harness ? await harnessRoute(build, release.rpcs) : null;
  const source = harness ? `harness, terminal build ${path.relative(REPO, build) || build}, live ${network} RPCs` : `live ${APP_HOST}`;
  const rec = await collect({ shots, route, network, source });
  const record = opt("--record");
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chromium ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
