#!/usr/bin/env node
// The signing page and the terminal in Firefox with Strict tracking protection, each RPC host the page reads failed in
// turn (card firefox-runs-before-release). The owner's Firefox (137 build, 14 Nov 11:44Z) read "CORS request did not
// succeed" (status null) from solana-rpc.publicnode.com and base-rpc.publicnode.com and 499/502 from Pocket, and its
// Move sat on Processing; our browser runs were Chrome only. Here a host is failed with route.abort("failed"), which is
// how a connection that never answers looks to the page, whatever dropped it (tracking protection, an extension, the
// host).
//
// The sign-in is restore-speed-browser.mjs's oneRun: the shipped builds served on the shipped names through
// context.route under their own _headers, the wallet way's "I already have one" with the published all-zero vector
// typed (never printed), and every chain read answered by its models (no real host is reached). The first run fails
// nothing and lists the chain hosts the page read; then one run per host with that host failed (or the --hosts named),
// or with --owners-case one run with every publicnode and Pocket host failed at once (the owner's case). Each run passes
// when the restore sheet draws a balance and ends (done, nothing or offline) inside the bound, every walk Worker says
// it hashed on WebAssembly, and nothing the run did not model was asked. The bound is BOUND_S on the bound's machine,
// scaled by how much slower this machine runs the restore's own walk (walkSpeed: the shipped /walk-worker.js on four
// pools at a tenth of the gap; scaledBound; cards firefox-restore-holds-on-every-runner, firefox-bound-times-the-walk-itself).
//
//   node packages/signpage/scripts/firefox-rpc-blocked.mjs [--bound <s> (BOUND_S)] [--hosts <a,b> | --owners-case] [--record <file>]
// Reads only: the models answer reads, and no send has an answer. PASS exit 0, FAIL exit 1, error exit 2.
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSignpage, defaultSites, HOSTS, REAL, TERMINAL } from "../../../apps/terminal/test/harness/harness.mjs";
import { launchHarnessBrowser } from "../../../scripts/harness-sockets.mjs";
import { browserLabel, FIREFOX_STRICT } from "../../../scripts/browsers.mjs";
import { line, oneRun, siteTable, SPEED_GAP, walkSpeed, workerRouted } from "./restore-speed-browser.mjs";

/** The bound on the balance drawn and the restore's end, in seconds, on the bound's machine (--bound overrides it). */
export const BOUND_S = 45;

/** The bound's machine (card firefox-bound-times-the-walk-itself): the heavy box's Playwright Firefox 155.0 taskset to
 *  4 cores (hardwareConcurrency 16, so 8 walk Workers), where walkSpeed took REF_WALK_MS (firefox-rpc-blocked.test.mjs
 *  holds the runs). */
export const REF_WALK_MS = 2440;

/** The bound on this machine: `boundS` times how much slower than the bound's machine walkSpeed found it, never less
 *  than `boundS`. A bound in seconds alone failed or passed by the runner drawn (39 s on AWS, 64 s on Azure, 15 Nov);
 *  a fixed JS loop as the yardstick put an Azure runner at 1.49 times the box while its restore ran 3.4 times slower
 *  (queue run 43681047546), so the yardstick is the restore's own walk. Pre-WebAssembly code fails apart from it: its
 *  walk says no hash path (verdict), and walkSpeed refuses a walk on BigInt. */
export const scaledBound = (boundS, walkMs) => boundS * Math.max(1, walkMs / REF_WALK_MS);

/** The owner's case: every host of the two providers whose answers his Firefox never got. */
export const OWNERS_CASE = (h) => /(^|\.)publicnode\.com$|(^|\.)pocket\.network$/.test(h);

/** A Move's dry run after the restore (reads and a quote, nothing signed or sent): Portfolio, Solana's Move, To Base,
 *  an amount typed; the sheet must answer (data-move-out) or end with a reason (data-move-dry) inside `boundS`. Never
 *  taps Move's go button. */
export const moveDry = (boundS) => async ({ app, vis }) => {
  const t0 = Date.now();
  // the restore sheet closed first (its X, SigninSheet.tsx sgn-x), as a user does once it has drawn
  await vis(".sgn-box .sgn-x").click({ timeout: 10_000 }).catch(() => {});
  await vis('a[href="/portfolio"]').click({ timeout: 15_000 });
  await vis('[data-control="pool-move-solana"]:not([disabled])').click({ timeout: boundS * 1000 });
  await vis('[data-sheet="move"] [data-side="to"] button[data-chain="base"]').click({ timeout: 15_000 });
  await vis('[data-sheet="move"] input[data-field="move-amount"]').fill("0.01", { timeout: 15_000 });
  const typed = Date.now();
  const end = app.locator('[data-sheet="move"] [data-move-out], [data-sheet="move"] [data-move-dry]').first();
  try {
    await end.waitFor({ state: "attached", timeout: boundS * 1000 });
  } catch {
    return { ended: false, ms: Date.now() - typed, opened: typed - t0, shown: await app.locator('[data-sheet="move"]').getAttribute("data-move-state").catch(() => null) };
  }
  const how = (await end.getAttribute("data-move-out")) !== null ? "answered" : `reason ${await end.getAttribute("data-move-dry")}`;
  return { ended: true, how, ms: Date.now() - typed, opened: typed - t0 };
};

/** One run's verdict: the balance drawn and the restore ended inside `boundS`, every walk Worker hashed on WebAssembly,
 *  nothing unanswered, no error. */
export function verdict(o, boundS) {
  const why = [];
  if (o.error) why.push(`error: ${o.error}`);
  // card firefox-restore-holds-on-every-runner: the field each walk Worker hashed on, as the page said it
  if (!o.hashed) why.push("the page never said which field the walk hashed on (no \"restore: the walk Workers hashed on\" line)");
  else {
    if (o.hashed.bigint > 0) why.push(`${o.hashed.bigint} walk Workers hashed on BigInt, not WebAssembly`);
    if (o.hashed.wasm + o.hashed.bigint !== o.workerEvents) why.push(`${o.hashed.wasm + o.hashed.bigint} walk Workers answered a walk of the ${o.workerEvents} started`);
  }
  if (o.shownMs === null) why.push("the balance never drew");
  else if (o.shownMs > boundS * 1000) why.push(`the balance drew at ${(o.shownMs / 1000).toFixed(1)} s, past ${+boundS.toFixed(1)} s`);
  if (o.doneMs === null) why.push("the restore never ended (the sheet still scanning)");
  else if (o.doneMs > boundS * 1000) why.push(`the restore ended at ${(o.doneMs / 1000).toFixed(1)} s, past ${+boundS.toFixed(1)} s`);
  if (o.unanswered.length) why.push(`${o.unanswered.length} reads the run does not model`);
  if (o.after?.error) why.push(`the Move's dry run: ${o.after.error}`);
  else if (o.after && !o.after.ended) why.push(`the Move's dry run still waiting after ${(o.after.ms / 1000).toFixed(1)} s`);
  return { ok: why.length === 0, why };
}

async function main() {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  // 45 s on the bound's machine (card firefox-restore-fast; card firefox-restore-holds-on-every-runner scales it to the
  // machine and reads the hash path: firefox-rpc-blocked.test.mjs replays the runs)
  const refBoundS = Number(opt("--bound", String(BOUND_S)));
  const only = opt("--hosts", null)?.split(",").filter(Boolean) ?? null;
  const ownersCase = process.argv.includes("--owners-case");
  const signRoot = buildSignpage();
  const recs = [];
  let ok = true;
  let browser;
  try {
    const sites = defaultSites(signRoot);
    const table = siteTable({ [REAL.sign]: sites[HOSTS.sign], [REAL.app]: { root: path.join(TERMINAL, "dist") } });
    browser = await launchHarnessBrowser("firefox", { headless: true, firefoxUserPrefs: { ...FIREFOX_STRICT } }, { hosts: [], refuseHttp: true });
    const label = `${browserLabel(browser)}, Strict tracking protection (${Object.entries(FIREFOX_STRICT).map(([k, v]) => `${k}=${v}`).join(" ")})`;
    const probe = await workerRouted(browser);
    if (!probe.seen) throw new Error(`${label}: its Worker script requests do not reach context.route, so a run could reach a real host`);
    const speed = await walkSpeed(browser, table[REAL.sign]);
    const firstBoundS = scaledBound(refBoundS, speed.ms);
    console.log(`bound ${firstBoundS.toFixed(1)} s: ${refBoundS} s on the bound's machine times ${(firstBoundS / refBoundS).toFixed(2)} (the walk of four pools at gap ${SPEED_GAP}, ${speed.workers} Workers at once, on WebAssembly, took ${(speed.ms / 1000).toFixed(2)} s here, runs ${speed.runs.map((x) => (x / 1000).toFixed(2)).join(", ")} s; ${(REF_WALK_MS / 1000).toFixed(2)} s there)`);
    const run = async (name, block) => {
      // the walk timed again right before each run, one round, and the slower of it and the first median kept: a shared
      // machine's load moves within a job (the box's 4-core restores ran 19.6 to 26.3 s in one job as its load rose
      // from 7 to 15), so each run's bound is its own machine's at that time, never below the job's first
      const now = await walkSpeed(browser, table[REAL.sign], 1);
      const boundS = Math.max(firstBoundS, scaledBound(refBoundS, now.ms));
      const o = await oneRun(browser, { engine: "firefox", mode: "workers", cpu: 1, sites: table, evmSpan: 1000, timeoutS: boundS + 30, block, after: moveDry(boundS) });
      const v = verdict(o, boundS);
      ok &&= v.ok;
      recs.push({ name, block, ok: v.ok, why: v.why, boundS, speedMs: speed.ms, speedNowMs: now.ms, hashed: o.hashed, workerEvents: o.workerEvents, move: o.after ?? null, shownMs: o.shownMs, doneMs: o.doneMs, sheetEnd: o.sheetEnd, stage: o.stage, hosts: o.hosts, blocked: o.blocked, lines: o.lines, unanswered: o.unanswered, error: o.error });
      console.log(`${v.ok ? "ok " : "BAD"} ${name}: ${line(o, label).text.replace(/^(ok |BAD) /, "")}; bound ${boundS.toFixed(1)} s (the walk ${(now.ms / 1000).toFixed(2)} s right before)${v.ok ? "" : ` | ${v.why.join("; ")}`}`);
      console.log(`    hosts read: ${Object.entries(o.hosts).map(([h, n]) => `${h} ${n}${o.blocked[h] ? ` (${o.blocked[h]} failed)` : ""}`).join(", ") || "none"}`);
      console.log(`    Move dry (Solana to Base, 0.01): ${o.after ? (o.after.error ? `error ${o.after.error}` : o.after.ended ? `${o.after.how} in ${(o.after.ms / 1000).toFixed(1)} s` : `no answer and no reason in ${(o.after.ms / 1000).toFixed(1)} s`) : "not run (the restore failed)"}`);
      for (const l of o.lines.filter((x) => x.startsWith("pool pass:") || / walked /.test(x)).slice(0, 8)) console.log(`    page: ${l}`);
      return o;
    };
    const base = await run("nothing failed", []);
    const chainHosts = Object.keys(base.hosts).filter((h) => h !== REAL.api).sort();
    if (ownersCase) {
      // the hosts the owner's console named, and every other publicnode and Pocket host the page read
      const named = ["solana-rpc.publicnode.com", "solana.api.pocket.network", "base-rpc.publicnode.com", "base.api.pocket.network"];
      await run("every publicnode and Pocket host failed at once (the owner's case)", [...new Set([...named, ...chainHosts.filter(OWNERS_CASE)])].sort());
    } else {
      // each host in turn, and each spare a failed host's run reached (solana.api.pocket.network is read only when
      // publicnode fails) failed in a run of its own too
      const queue = [...(only ?? chainHosts)];
      for (let i = 0; i < queue.length; i++) {
        const o = await run(`${queue[i]} failed`, [queue[i]]);
        if (!only) for (const h of Object.keys(o.hosts).sort()) if (h !== REAL.api && !queue.includes(h)) queue.push(h);
      }
    }
  } finally {
    await browser?.close();
    rmSync(signRoot, { recursive: true, force: true });
  }
  const file = opt("--record", null);
  if (file) writeFileSync(file, `${JSON.stringify(recs, null, 2)}\n`);
  console.log(`${ok ? "PASS" : "FAIL"} firefox-rpc-blocked`);
  return ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`ERROR firefox-rpc-blocked: ${e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
