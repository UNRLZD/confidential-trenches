#!/usr/bin/env node
// Live check of card app-verify-mount: Verify opens in the app and reads the vault live. Headless Chromium opens
// APP_HOST/verify at 390 x 844 (phone, dpr 2, touch) and 1440 x 900 (desktop, dpr 1), finds the terminal's frame inside
// SIGN_HOST's shell, waits for the Verify panel to leave loading, opens both rows and reads:
//   - the release's pins (apps/terminal/src/screens/verify/release.ts) are the network's vault deploy record
//     (contracts/vault/deployments/<network>-v1.json: vault = account_id, asset = asset, release = code_hash), and
//     null exactly while no record exists; a vault is named on the network exactly when its record exists;
//   - with a vault named: the panel drew a read (not Unverified, not RPCs disagree), the Code and Funds rows ok, and
//     every check ok: Vault keys, Code hash, Asset, Registration, Token code, Balance (09-design-brief S18.2); the RPCs
//     it names are two, of two operators (scripts/ci/near-rpc-operators.mjs), on the run's network; this page asked
//     both of them itself, each answered 200, and asked no other NEAR RPC: the rows are reads of this session;
//   - with no vault named (mainnet until its vault is deployed): every check Unverified, no RPC named and no request
//     to any NEAR RPC at all, so nothing is drawn as read;
//   - no CSP violation and no console error in the terminal's frame;
//   - every open of the panel starts from loading and leaves it only after every NEAR read that open began has been
//     answered, both RPCs among them (the frame's data-state changes and its resource timing, on one clock), so no
//     earlier read is drawn while this open reads;
//   - every NEAR request of the run reads an account of the release (its vault or its asset), goes to the named pair,
//     and Verify's own reads (JSON-RPC id "verify") are made only while a panel is open; with no vault named the run
//     makes no NEAR request at all;
//   - on desktop, after the panel is closed, the footer's Verify pill opens it again, once: it starts from loading,
//     reads both RPCs afresh (none with no vault named) and draws the same end state, and its close returns home.
// A screenshot of each width is kept.
//   node scripts/live-checks/app-verify-mount.mjs [--network mainnet|testnet] [--shots <dir>] [--record <file>]
//     the deployed hosts: APP_HOST/verify as it is served; --network is the network its build names (the deploy passes
//     it, read from the build's _headers; mainnet when not given)
//   node scripts/live-checks/app-verify-mount.mjs --harness [--build <dir>] [--network testnet|mainnet] ...
//     a local build (VITE_NEAR_NETWORK=testnet pnpm --filter terminal build) on the hosts' real names, answered by
//     Playwright's route from local files with the stand-in shell of app-in-shell.mjs; the release's two NEAR RPCs are
//     the real ones, reached over the network (route.continue), so the reads are live (testnet when not given)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read, so the check's test can replay it through judge().
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkOf, operatorOf } from "../ci/near-rpc-operators.mjs";
import { launchBrowser } from "../browsers.mjs";
import { consoleError } from "./console-errors.mjs";

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

// ------------------------------------------------------------------------------------------------ the release
/** The network's vault deploy record, as the vault's own live checks read it (vault-testnet-t01.mjs), or null. */
export const recordPath = (network) => path.join(REPO, "contracts/vault/deployments", `${network}-v1.json`);
export function releaseRecord(network, file = recordPath(network)) {
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, "utf8"));
  return { network: r.network, account_id: r.account_id, asset: r.asset, code_hash: r.code_hash };
}
/** The pins Verify judges against, as they bear on the record: the vault, its asset and the vault's code hash. */
export const pinsOf = (pins) => (pins === null ? null : { vault: pins.vault, asset: pins.asset, release: pins.release });
/** Problems between the release's pins and the deploy record of `network`; none when they agree. */
export function pinsProblems(network, pins, record) {
  if (record === null) return pins === null ? [] : [`release.ts names vault ${pins.vault} on ${network}, but no deploy record exists`];
  if (pins === null) return [`a deploy record names vault ${record.account_id} on ${network}, but release.ts names none`];
  const want = { vault: record.account_id, asset: record.asset, release: record.code_hash };
  const out = Object.keys(want).filter((k) => pins[k] !== want[k]).map((k) => `release.ts ${k} ${pins[k]}, the deploy record ${want[k]}`);
  if (record.network !== network) out.push(`the deploy record is for ${record.network}, not ${network}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ the verdict
const nearPosts = (reqs) => (reqs ?? []).filter((x) => x.method === "POST" && operatorOf(x.url) !== null);

/** One drawn panel and the requests of that open, judged for a network with or without a vault named. */
function judgePanel(say, n, p, reqs, rec, named) {
  const posts = nearPosts(reqs);
  if (!named) {
    const allWarn = CHECKS.every((c) => p.checks[c] === "warn") && Object.keys(p.checks).length === CHECKS.length;
    say(p.state === "unverified" && p.code === "warn" && p.funds === "warn" && allWarn && p.block === "—", `${n}: no vault named on ${rec.network}: panel ${p.state}, code ${p.code}, funds ${p.funds}, ${CHECKS.filter((c) => p.checks[c] === "warn").length} of ${CHECKS.length} checks Unverified, block ${p.block || "none"}`);
    say(p.rpcs.length === 0 && posts.length === 0, `${n}: no vault named: the panel names ${p.rpcs.join(" and ") || "no RPC"}; ${posts.length} request(s) to a NEAR RPC${posts.length ? ` (${[...new Set(posts.map((x) => host(x.url)))].join(", ")})` : ""}`);
    return;
  }
  const allOk = CHECKS.every((c) => p.checks[c] === "ok") && Object.keys(p.checks).length === CHECKS.length;
  say(p.state === "read" && p.code === "ok" && p.funds === "ok" && allOk, `${n}: panel ${p.state}, code ${p.code}, funds ${p.funds}; checks ${CHECKS.map((c) => `${c} ${p.checks[c] ?? "none"}`).join(", ")}`);
  const ops = p.rpcs.map(operatorOf);
  const nets = p.rpcs.map(networkOf);
  const two = p.rpcs.length === 2 && ops.every(Boolean) && ops[0] !== ops[1] && nets.every((x) => x === rec.network);
  say(two, `${n}: the panel names ${p.rpcs.join(" and ") || "no RPC"} (${ops.map((o) => o ?? "unknown").join(", ")}; ${nets.map((x) => x ?? "unknown").join(", ")}), want two operators on ${rec.network}`);
  const asked = p.rpcs.map((u) => {
    const q = posts.filter((x) => sameHost(x.url, u));
    return { u, n: q.length, ok: q.length > 0 && q.every((x) => x.status === 200) };
  });
  const other = posts.filter((x) => !p.rpcs.some((u) => sameHost(x.url, u)) || networkOf(x.url) !== rec.network);
  say(asked.length === 2 && asked.every((a) => a.ok) && other.length === 0, `${n}: this page read ${asked.map((a) => `${host(a.u)} ${a.n} time(s)${a.ok ? ", all 200" : ", not all 200"}`).join(" and ") || "no RPC"}${other.length ? `; and ${[...new Set(other.map((x) => host(x.url)))].join(", ")}, which the panel does not name or is not on ${rec.network}` : ""}`);
  say(/^\d{1,3}(,\d{3})*$/.test(p.block), `${n}: block ${p.block || "none"}`);
}

/** One open of the panel against the timing read in the frame: from loading, left only after every NEAR read it began answered. */
function judgeTiming(say, n, r, k, since, rec, named) {
  const tl = (r.timeline ?? []).filter((e) => e.open === k);
  const leave = tl.find((e) => e.state !== "loading");
  if (!tl.length || tl[0].state !== "loading" || !leave) {
    say(false, `${n}: the panel's states ${tl.map((e) => e.state).join(" > ") || "none"}: it must start from loading and leave it`);
    return;
  }
  if (!named) return say(true, `${n}: from loading to ${leave.state}`);
  const began = (r.rpcTiming ?? []).filter((e) => operatorOf(e.name) !== null && e.start >= since && e.start < leave.t);
  const pending = began.filter((e) => !(e.end > 0 && e.end <= leave.t));
  const rpcs = rec.rpcs ?? [];
  const answered = rpcs.filter((u) => began.some((e) => sameHost(e.name, u) && e.end > 0 && e.end <= leave.t));
  say(pending.length === 0 && answered.length === 2, `${n}: left loading for ${leave.state} at ${Math.round(leave.t - since)} ms, ${answered.length} of 2 RPCs answered by then, ${pending.length} NEAR read(s) of this open still unanswered`);
}

/** Every NEAR request of the run, whatever its phase: the named pair only, the release's accounts only, Verify's own only while open. */
function judgeAllRequests(say, n, r, rec, named) {
  const posts = nearPosts(r.requests);
  if (!named) return say(posts.length === 0, `${n}: no vault named: ${posts.length} NEAR request(s) over the whole run${posts.length ? ` (${posts.map((x) => `${host(x.url)} in ${x.phase}`).join(", ")})` : ""}`);
  const accounts = new Set([rec.pins?.vault, rec.pins?.asset].filter(Boolean));
  const offPair = posts.filter((x) => !(rec.rpcs ?? []).some((u) => sameHost(x.url, u)));
  const offAccount = posts.filter((x) => !accounts.has(x.account));
  const outside = posts.filter((x) => x.rpcId === "verify" && x.phase !== "open" && x.phase !== "reopen");
  const bad = [...offPair.map((x) => `${host(x.url)} (not the pair) in ${x.phase}`), ...offAccount.map((x) => `account ${x.account ?? "none"} in ${x.phase}`), ...outside.map((x) => `a Verify read in ${x.phase}`)];
  say(bad.length === 0, `${n}: ${posts.length} NEAR request(s) over the run, each to the pair, each of ${[...accounts].join(" or ")}, Verify's only while open${bad.length ? `; not so: ${bad.join("; ")}` : ""}`);
}

/** The check's console hook: every error the terminal's frame (an APP_HOST address) logs, kept through the shared
 *  collector (console-errors.mjs) as its text and its address's origin and path. */
export function onConsole(errors) {
  return (m) => m.type() === "error" && (m.location()?.url ?? "").startsWith(APP_HOST) && errors.push(consoleError(m));
}

export function judge(rec) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok " : "BAD"} ${s}`);
  const record = rec.record === undefined ? undefined : rec.record;
  const pinErr = record === undefined || rec.pins === undefined ? ["the run recorded no release pins or deploy record"] : pinsProblems(rec.network, rec.pins, record);
  say(pinErr.length === 0, `release pins on ${rec.network}: ${pinErr.length ? pinErr.join("; ") : record ? `vault ${record.account_id}, asset ${record.asset}, code ${record.code_hash}, as the deploy record` : "none, and no deploy record"}`);
  const named = record !== null && record !== undefined;
  const runs = rec.runs ?? [];
  say(WIDTHS.every((w) => runs.some((r) => r.width === w.name)), `${runs.length} run(s) of ${WIDTHS.length} (every width)`);
  for (const r of runs) {
    const n = `${r.width} ${PATH}`;
    if (!r.panel) {
      say(false, `${n}: no Verify panel in the terminal's frame (${r.frame ?? "no frame"})`);
      continue;
    }
    judgePanel(say, n, r.panel, (r.requests ?? []).filter((x) => x.phase === "open"), rec, named);
    judgeTiming(say, n, r, 0, 0, rec, named);
    judgeAllRequests(say, n, r, rec, named);
    const errs = [...(r.violations ?? []).map((v) => `CSP ${v.directive} ${v.blocked}`), ...(r.errors ?? []).map((e) => `console ${e}`)];
    say(errs.length === 0, `${n}: ${errs.length ? errs.join("; ") : "no CSP violation, no console error"}`);
    if (r.width !== "desktop") continue;
    const f = r.footer ?? {};
    say(f.opened === true && f.firstState === "loading" && f.newOpens === 1, `${n}: closed, then the footer's Verify pill ${f.opened ? `opens it again ${f.newOpens ?? 0} time(s), starting ${f.firstState ?? "nowhere"}` : "does not open it"}`);
    if (f.panel) judgePanel(say, `${n} again`, f.panel, (r.requests ?? []).filter((x) => x.phase === "reopen"), rec, named);
    if (f.panel) judgeTiming(say, `${n} again`, r, f.openIndex, f.clickAt ?? Infinity, rec, named);
    else say(false, `${n} again: no panel read after the pill`);
    say(f.closedTo === "/", `${n}: close ${f.closedTo ? `returns to ${f.closedTo}` : "returns nowhere"}`);
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
// in the terminal's frame, before its scripts: keep CSP violations, and the first state of every Verify panel drawn
const INIT = ({ app }) => {
  if (location.origin !== app || window.top === window) return;
  window.__ctViolations = [];
  window.__ctVerifyOpens = [];
  window.__ctVerifyTimeline = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__ctViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  // every panel drawn (one open each) and every change of its data-state, on the frame's performance clock
  const seen = new Map();
  new MutationObserver(() => {
    const t = performance.now();
    for (const v of document.querySelectorAll(".vfy")) {
      const state = v.dataset.state ?? null;
      let e = seen.get(v);
      if (!e) {
        e = { open: window.__ctVerifyOpens.length, last: undefined };
        seen.set(v, e);
        window.__ctVerifyOpens.push(state);
      }
      if (e.last !== state) window.__ctVerifyTimeline.push({ open: e.open, t, state });
      e.last = state;
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
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

/** Waits for the panel to leave loading, opens both rows and reads it. */
async function readPanel(f) {
  await f.waitForSelector(".vfy[data-state]:not([data-state='loading'])", { timeout: READ_MS }).catch(() => {});
  for (const id of ["code", "funds"]) await f.click(`[data-control="verify-${id}"]`, { timeout: 2_000 }).catch(() => {});
  return f.evaluate(READ_PANEL);
}

async function runOne({ browser, w, shots, route, beforeReopen, duringReopen }) {
  const ctx = await browser.newContext({ viewport: w.viewport, deviceScaleFactor: w.deviceScaleFactor, isMobile: w.isMobile, hasTouch: w.hasTouch });
  const run = { width: w.name, frame: null, panel: null, requests: [], violations: [], errors: [] };
  try {
    if (route) await ctx.route("**/*", route);
    await ctx.addInitScript(INIT, { app: APP_HOST });
    const page = await ctx.newPage();
    // the terminal frame's requests, each tagged with the open it belongs to: the first ("open"), the pill's ("reopen")
    let phase = "open";
    const byReq = new Map();
    page.on("request", (q) => {
      if (q.frame().url().startsWith(APP_HOST) && q.frame() !== page.mainFrame()) {
        const e = { url: q.url(), method: q.method(), type: q.resourceType(), status: null, phase };
        if (q.method() === "POST" && operatorOf(q.url()) !== null) {
          let body = null;
          try {
            body = JSON.parse(q.postData() ?? "null");
          } catch {
            // not JSON: no account and no id recorded, which judge() refuses
          }
          e.account = body?.params?.account_id ?? null;
          e.rpcId = body?.id ?? null;
        }
        byReq.set(q, e);
        run.requests.push(e);
      }
    });
    page.on("response", (res) => {
      const e = byReq.get(res.request());
      if (e) e.status = res.status();
    });
    page.on("console", onConsole(run.errors));
    await page.goto(APP_HOST + PATH, { waitUntil: "commit" });
    const f = await appFrame(page);
    if (!f) return run;
    run.frame = f.url();
    run.panel = await readPanel(f);
    phase = "between";
    if (shots) await page.screenshot({ path: path.join(shots, `${KEY}-${w.name}.png`) });
    if (w.name === "desktop") {
      // the pill: closed to the home page, then opened again; that open must start over and read afresh
      run.footer = { opened: false, firstState: null, panel: null, closedTo: null };
      await f.click(".vfy-x", { timeout: 2_000 }).catch(() => {});
      await f.waitForFunction(() => location.pathname === "/" && !document.querySelector(".vfy"), null, { timeout: 5_000 }).catch(() => {});
      if (shots) await page.screenshot({ path: path.join(shots, `${KEY}-desktop-home.png`) });
      await beforeReopen?.();
      phase = "reopen";
      run.footer.openIndex = await f.evaluate(() => (window.__ctVerifyOpens ?? []).length);
      run.footer.clickAt = await f.evaluate(() => performance.now());
      await f.click('.ft [data-control="verify"]', { timeout: 5_000 }).catch(() => {});
      run.footer.opened = await f.waitForSelector(".vfy", { timeout: 5_000 }).then(() => true, () => false);
      if (run.footer.opened && duringReopen) run.footer.samples = await duringReopen(f);
      if (run.footer.opened) {
        run.footer.panel = await readPanel(f);
        const opens = await f.evaluate(() => window.__ctVerifyOpens ?? []);
        run.footer.newOpens = opens.length - run.footer.openIndex;
        run.footer.firstState = opens[run.footer.openIndex] ?? null;
        if (shots) await page.screenshot({ path: path.join(shots, `${KEY}-desktop-again.png`) });
      }
      phase = "after";
      await f.click(".vfy-x", { timeout: 2_000 }).catch(() => {});
      await f.waitForFunction(() => !document.querySelector(".vfy"), null, { timeout: 5_000 }).catch(() => {});
      run.footer.closedTo = await f.evaluate(() => (document.querySelector(".vfy") ? null : location.pathname));
    }
    // the frame's own record: CSP violations, the panels' states, and when each NEAR read began and was answered
    Object.assign(run, await f.evaluate(() => ({
      violations: window.__ctViolations ?? [],
      timeline: window.__ctVerifyTimeline ?? [],
      rpcTiming: performance.getEntriesByType("resource").filter((e) => e.initiatorType === "fetch").map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd })),
    })));
    return run;
  } finally {
    await ctx.close();
  }
}

/**
 * Every width, in Chromium, with the release's pair, pins and the network's deploy record as they are now. `route`: a
 * Playwright route handler for the harness, or null (the deployed hosts); `beforeReopen`: run before the pill's open;
 * `duringReopen(frame)`: run once the pill's panel is drawn, its result kept as the open's `samples`.
 */
export async function collect({ shots, route = null, network, source, beforeReopen, duringReopen }) {
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  if (!release) throw new Error(`network takes ${Object.keys(VERIFY_RELEASES).join(", ")}`);
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await launchBrowser("chromium");
  try {
    const runs = [];
    for (const w of WIDTHS) runs.push(await runOne({ browser, w, shots, route, beforeReopen, duringReopen }));
    return { check: KEY, at: new Date().toISOString(), source, network, rpcs: [...release.rpcs], pins: pinsOf(release.pins), record: releaseRecord(network), browser: browser.version(), runs };
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
  const network = opt("--network") ?? (harness ? "testnet" : "mainnet");
  const { VERIFY_RELEASES } = await import("../../apps/terminal/src/screens/verify/release.ts");
  const release = VERIFY_RELEASES[network];
  if (!release) throw new Error(`--network takes ${Object.keys(VERIFY_RELEASES).join(", ")}`);
  const build = path.resolve(opt("--build") ?? path.join(REPO, "apps/terminal/dist"));
  const route = harness ? await harnessRoute(build, release.rpcs) : null;
  const source = harness ? `harness, terminal build ${path.relative(REPO, build) || build}, the release's ${network} RPCs live` : `live ${APP_HOST}`;
  const rec = await collect({ shots, route, network, source });
  const record = opt("--record");
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 2)}\n`);
  const r = judge(rec);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chrome ${rec.browser}, shots ${shots})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
