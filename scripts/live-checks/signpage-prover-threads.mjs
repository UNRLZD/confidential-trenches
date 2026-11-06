#!/usr/bin/env node
// Live check of card signpage-prover-threads: SIGN_HOST's prover proves on its own threads, each started from one pinned
// same-origin file, and SIGN_HOST's CSP still refuses every other worker. It reads, on SIGN_HOST =
// https://sign.confidential.unrealized.trade (signpage-skeleton's SIGN), against pins written out here, not read from
// the kit:
//   - the thread file at https://SIGN_HOST/prover-thread.js: 200, a script, its size and sha256 THREAD_PIN's (snarkjs
//     0.7.5's own thread code byte for byte after a licence header; the kit's build.mjs refuses any other), under two
//     policies at once: the site's (signpage-skeleton's CSP, every directive) and its own, exactly THREAD_CSP;
//   - in a headless browser on https://SIGN_HOST/ (WebKit, Safari's engine, or Chromium with --browser chromium; the
//     harness serves Chromium from a local HTTPS server, signpage-prover-host's openBrowser): planted workers from a
//     data: URL and from a blob: URL, each made a TrustedScriptURL by the page's one prover-worker policy so that only
//     the CSP stands in their way, are refused and never run; then the prover worker, made through that policy, loads
//     the pinned withdraw files and proves the fixed input (packages/kit/test/prover/withdraw.input.json) on
//     min(hardwareConcurrency - 1, 4) threads, as it reports; each proof's public signals are withdraw.public.json's
//     and snarkjs 0.7.5's groth16.verify accepts it with the pinned withdraw.vkey;
//   - the browser fetched /prover-thread.js and no other worker script; no CSP or Trusted Types violation but the two
//     the planted workers make.
//   node scripts/live-checks/signpage-prover-threads.mjs [--base <https url>] [--browser webkit|chromium] [--proofs <n>] [--record <file>]
//     --base: a build's own address (a Pages preview) read as SIGN_HOST is, its own origin in place of SIGN_HOST's
//   node scripts/live-checks/signpage-prover-threads.mjs --harness [--site <dir>] [...]
//     the harness: SIGN_HOST answered from a build folder under its own _headers, every matching rule joined as Pages
//     joins them (default: a fresh `deploy.mjs --dry-run` build, which passed the deploy gate); every other host refused.
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it; each
//   proof's time in the worker is in it (page.proofs[].proveMs), the record perf/runs takes.
// packages/signpage/scripts/deploy.mjs refuses a _headers whose thread rule is not THREAD_CSP, exactly.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expected, gateBuild, openBrowser, PINS, policies, siteServer, WORKER_PATH, zkPath } from "./signpage-prover-host.mjs";
import { APP, CSP as SITE_CSP, SIGN } from "./signpage-skeleton.mjs";
import { browserLabel } from "../browsers.mjs";
import { consoleLine } from "./console-errors.mjs";

const KEY = "signpage-prover-threads";
/** The address read live: SIGN_HOST, or with --base a build's own (a Pages preview), read the same way. */
let ORIGIN = SIGN;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------- pinned ----------
export const THREAD_PATH = "/prover-thread.js";
// the thread code runs wasm and nothing else: no script, no fetch, no worker of its own
export const THREAD_CSP = "default-src 'none'; script-src 'wasm-unsafe-eval'";
// packages/kit/src/prover/build.mjs proverThreadSource(): THREAD_HEADER, then snarkjs 0.7.5's thread code (3,673 B,
// sha256 81680ca6dc84c04ad6497107eb6b1faaa17c3114d5d14a26d63942d5d822b295)
export const THREAD_PIN = { bytes: 4285, sha256: "d2d61af55de7f1c92e8d3edc2c5fd68fd37c4294b4a4d4da54b5b963aceb4e46" };
export const MAX_THREADS = 4;
/** The thread count the worker must report for a page whose hardwareConcurrency is `cores`. */
export const threadsFor = (cores) => {
  const n = Math.max(1, Math.min((Number(cores) | 0) - 1, MAX_THREADS));
  return n > 1 ? n : 1;
};
// the two violations the planted workers make, in order; any other is a fault
export const PLANT_VIOLATIONS = ["page worker-src data", "page worker-src blob"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const sameAs = (m, want) => m.size === want.length && want.every(([k, v]) => m.get(k) === v);
const THREAD_DIRECTIVES = THREAD_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]);
const schemeOf = (u) => String(u ?? "").split(":")[0];

function snarkjs() {
  return createRequire(path.join(REPO, "packages/kit/package.json"))("snarkjs");
}

/** The check on one recorded answer. Async: snarkjs verifies each proof. */
/** One console line as the run keeps it for the reader (the judge reads none of it): its type and text, cut at 300
 *  characters, then its address's origin and path through the shared collector (console-errors.mjs). */
export function consoleLineOf(m) {
  return consoleLine(`${m.type()} ${m.text()}`.slice(0, 300), m.location()?.url ?? "");
}

/** What a FAIL prints after its verdict, for the reader of a red run (the judge reads none of it): every console line
 *  the run kept (the page's and each worker's) and every worker script the browser asked for, in order. */
export function failLines(rec) {
  const pg = rec?.page ?? {};
  const c = Array.isArray(pg.console) ? pg.console : [];
  const w = Array.isArray(pg.workerScripts) ? pg.workerScripts : [];
  return [...(c.length ? c.map((l) => `CONSOLE ${l}`) : ["CONSOLE none kept"]), `WORKER SCRIPTS ${JSON.stringify(w)}`];
}

export async function judge(rec, want = expected()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);

  const t = rec.files?.[THREAD_PATH];
  if (!t) say(false, `${THREAD_PATH}: not read`);
  else {
    say(t.status === 200, `${THREAD_PATH}: ${t.status}`);
    say(/javascript/.test(String(t.headers?.["content-type"] ?? "")), `${THREAD_PATH}: content-type ${show(t.headers?.["content-type"])}`);
    const pinned = t.bytes === THREAD_PIN.bytes && t.sha256 === THREAD_PIN.sha256;
    say(pinned, `${THREAD_PATH}: ${t.bytes} B sha256 ${t.sha256}${pinned ? "" : `, pinned ${THREAD_PIN.bytes} B ${THREAD_PIN.sha256}`}`);
    const pols = policies(t.headers?.["content-security-policy"]);
    const site = pols.filter((m) => sameAs(m, SITE_CSP)).length;
    const own = pols.filter((m) => sameAs(m, THREAD_DIRECTIVES)).length;
    say(pols.length === 2 && site === 1 && own === 1, `${THREAD_PATH}: ${pols.length} CSP policies, the site's ${site}, its own ${own}; want exactly one of each`);
  }

  const pg = rec.page;
  if (!pg) say(false, "the page: not run");
  else {
    for (const scheme of ["data", "blob"]) {
      const p = pg.planted?.[scheme];
      const refused = !!p && p.ran === false && p.made !== "no policy";
      say(refused, `a planted ${scheme}: worker is refused and never runs: ${show(p)}`);
    }
    const n = threadsFor(pg.cores);
    say(Number.isInteger(pg.cores) && pg.cores > 0, `the page's hardwareConcurrency: ${show(pg.cores)}`);
    say(!pg.loadError, `the worker loads the withdraw setup files: ${pg.loadError ? show(pg.loadError) : `${pg.loadMs} ms`}`);
    const proofs = pg.proofs ?? [];
    say(proofs.length > 0 && !pg.proveError, `the worker proves the fixed input: ${proofs.length} proofs${pg.proveError ? `, then ${show(pg.proveError)}` : ""}`);
    const threads = proofs.map((p) => p.threads);
    say(proofs.length > 0 && threads.every((x) => x === n) && n > 1, `each proof ran on min(${pg.cores} - 1, ${MAX_THREADS}) = ${n} threads: ${show(threads)}`);
    let verified = 0;
    let signals = 0;
    for (const p of proofs) {
      if (JSON.stringify(p.publicSignals) === JSON.stringify(want.signals)) signals++;
      try {
        if (await snarkjs().groth16.verify(want.vkey, want.signals, p.proof)) verified++;
      } catch {}
    }
    say(proofs.length > 0 && signals === proofs.length, `public signals are withdraw.public.json's: ${signals}/${proofs.length}`);
    say(proofs.length > 0 && verified === proofs.length, `snarkjs groth16.verify with the pinned withdraw.vkey: ${verified}/${proofs.length}`);
    say(proofs.length > 0, `time in the worker: ${show(proofs.map((p) => p.proveMs))} ms`);
    // every worker script the browser fetched: the prover worker and the thread file, nothing else
    const scripts = [...new Set((pg.workerScripts ?? []).map((u) => (/^(data|blob):/.test(u) ? u : new URL(u, SIGN).pathname)))].sort();
    const onlyPinned = JSON.stringify(scripts) === JSON.stringify([THREAD_PATH, WORKER_PATH].sort());
    say(onlyPinned, `worker scripts fetched: ${show(scripts)}${onlyPinned ? "" : `, want ${show([THREAD_PATH, WORKER_PATH].sort())}`}`);
    const v = (pg.violations ?? []).map((x) => `${x.where} ${x.directive} ${schemeOf(x.blocked)}`);
    const clean = JSON.stringify(v) === JSON.stringify(PLANT_VIOLATIONS);
    say(clean, `CSP and Trusted Types violations: the two planted workers' only${clean ? "" : `: ${show(v)}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const KEEP = ["content-type", "cache-control", "content-security-policy", "x-content-type-options", "cross-origin-resource-policy"];

async function readThread(serve) {
  let status, headers, body;
  if (serve) ({ status, headers, body } = serve(THREAD_PATH));
  else {
    const r = await fetch(`${ORIGIN}${THREAD_PATH}`, { redirect: "manual", headers: { "cache-control": "no-cache" } });
    headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    status = r.status;
    body = Buffer.from(await r.arrayBuffer());
  }
  return { status, bytes: body.length, sha256: sha256(body), headers: Object.fromEntries(KEEP.filter((k) => headers[k] !== undefined).map((k) => [k, headers[k]])) };
}

// installed in SIGN_HOST's top page before its own script runs: every violation
const INIT = (origin) => `(() => {
  if (location.origin !== ${JSON.stringify(origin)} || window.top !== window) return;
  const pt = (window.__pt = { violations: [] });
  document.addEventListener("securitypolicyviolation", (e) => pt.violations.push({ where: "page", directive: e.effectiveDirective, blocked: e.blockedURI }));
})();`;

// the planted workers, then the prover worker by its own protocol (packages/kit/src/prover/worker.js)
const RUN = `async ([input, pins, proofs]) => {
  const pt = window.__pt;
  const out = { violations: pt.violations, cores: navigator.hardwareConcurrency, planted: {}, proofs: [] };
  const err = (e) => (e instanceof Error ? e.name + ": " + e.message : String(e));
  const tt = window.trustedTypes;
  const url = new URL(${JSON.stringify(WORKER_PATH)}, location.origin).href;
  // the page's one policy name; here it passes the planted URLs too, so only the CSP can refuse them
  const policy = tt ? tt.createPolicy("prover-worker", { createScriptURL: (s) => s }) : { createScriptURL: (s) => s };
  const plant = async (src) => {
    const r = { made: "no", ran: false };
    try {
      const w = new Worker(policy.createScriptURL(src));
      r.made = "yes";
      await new Promise((done) => {
        w.addEventListener("message", () => ((r.ran = true), done()));
        w.addEventListener("error", (e) => ((r.error = "error event"), done()));
        setTimeout(done, 1500);
      });
      w.terminate();
    } catch (e) {
      r.threw = err(e);
    }
    return r;
  };
  const body = "postMessage('ran')";
  out.planted.data = await plant("data:text/javascript," + encodeURIComponent(body));
  out.planted.blob = await plant(URL.createObjectURL(new Blob([body], { type: "text/javascript" })));

  const worker = new Worker(policy.createScriptURL(url), { name: "prover" });
  const waiting = new Map();
  let next = 1;
  worker.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "violation") return void pt.violations.push({ where: "worker", directive: m.violation.directive, blocked: m.violation.blocked });
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.ok ? w.ok(m.value) : w.fail(new Error(m.error));
  });
  const dead = new Promise((_, fail) => worker.addEventListener("error", (e) => fail(new Error("prover worker: " + (e.message || "failed to load")))));
  dead.catch(() => {});
  // a desktop proof takes seconds; one that has not answered in 120 s is a hang (a thread that never started), not slow
  const late = () => new Promise((_, fail) => setTimeout(() => fail(new Error("no answer in 120 s")), 120000));
  const call = (msg, transfer = []) => Promise.race([dead, late(), new Promise((ok, fail) => { const id = next++; waiting.set(id, { ok, fail }); worker.postMessage({ ...msg, id }, transfer); })]);
  const file = async (p) => {
    const r = await fetch(p, { credentials: "omit" });
    if (!r.ok) throw new Error(p + ": HTTP " + r.status);
    return r.arrayBuffer();
  };
  try {
    const t0 = performance.now();
    try {
      const [wasm, zkey] = await Promise.all([file(pins.wasm), file(pins.zkey)]);
      await call({ cmd: "load", circuit: "withdraw", wasm, zkey }, [wasm, zkey]);
      out.loadMs = Math.round(performance.now() - t0);
    } catch (e) {
      out.loadError = err(e);
      return out;
    }
    for (let i = 0; i < proofs; i++) {
      try {
        out.proofs.push(await call({ cmd: "prove", circuit: "withdraw", input }));
      } catch (e) {
        out.proveError = err(e);
        break;
      }
    }
    return out;
  } finally {
    worker.terminate();
  }
}`;

/** The browser run on SIGN_HOST's page: the live one, or `serve`'s. */
async function readPage(serve, engine, proofs) {
  const { browser, ctx, close } = await openBrowser(engine, serve);
  try {
    const origin = serve ? SIGN : ORIGIN;
    await ctx.addInitScript(INIT(origin));
    const workerScripts = [];
    ctx.on("request", (r) => {
      const u = r.url();
      if (/^(data|blob):/.test(u) || (new URL(u).origin === origin && /\.js$/.test(new URL(u).pathname) && new URL(u).pathname !== "/app.js")) workerScripts.push(u);
    });
    const page = await ctx.newPage();
    const consoleLines = [];
    page.on("console", (m) => consoleLines.length < 50 && consoleLines.push(consoleLineOf(m)));
    page.on("pageerror", (e) => consoleLines.length < 50 && consoleLines.push(`pageerror ${e.message}`.slice(0, 300)));
    page.on("worker", (w) => {
      if (consoleLines.length < 50) consoleLines.push(`worker ${w.url().slice(0, 120)}`);
      // a worker's own console (the prover worker's, a thread's), named by its worker's path
      w.on("console", (m) => consoleLines.length < 50 && consoleLines.push(`in ${new URL(w.url(), origin).pathname}: ${consoleLineOf(m)}`));
    });
    await page.goto(`${origin}/`, { waitUntil: "load" });
    if (!(await page.evaluate(() => !!window.__pt))) throw new Error("the init script did not run on SIGN_HOST's page");
    const want = expected();
    const pins = { wasm: zkPath(PINS[0]), zkey: zkPath(PINS[1]) };
    const out = await page.evaluate(`(${RUN})(${JSON.stringify([want.input, pins, proofs])})`);
    await new Promise((ok) => setTimeout(ok, 250)); // a violation is reported a task after its cause
    out.violations = await page.evaluate(() => window.__pt.violations);
    out.console = consoleLines; // for the reader; the judge reads none of it
    out.workerScripts = workerScripts; // every script on SIGN_HOST but the page's app.js, and every data: or blob: one
    return { browser: browserLabel(browser), page: out };
  } finally {
    await close();
  }
}

export async function collect({ harness = false, site, engine = "webkit", proofs = 3 } = {}) {
  let dir = null;
  try {
    let serve = null;
    if (harness) {
      dir = site ? null : gateBuild();
      serve = await siteServer(path.resolve(site ?? dir));
    }
    const thread = await readThread(serve);
    const run = await readPage(serve, engine, proofs);
    return { source: harness ? `harness, SIGN_HOST from ${site ?? "a fresh deploy.mjs --dry-run build"}` : `live ${ORIGIN}`, at: new Date().toISOString(), browser: run.browser, files: { [THREAD_PATH]: thread }, page: run.page };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  let code = 2;
  try {
    const valued = ["--site", "--record", "--browser", "--proofs", "--base"];
    const known = new Set(["--harness", ...valued]);
    const bad = a.filter((x, i) => x.startsWith("--") && !known.has(x) && !(i > 0 && valued.includes(a[i - 1])));
    const engine = opt("--browser") ?? "webkit";
    const proofs = Number(opt("--proofs") ?? 3);
    if (opt("--base")) ORIGIN = new URL(opt("--base")).origin;
    if (bad.length || (opt("--site") && !a.includes("--harness")) || (opt("--base") && (a.includes("--harness") || !ORIGIN.startsWith("https://"))) || !["chromium", "webkit"].includes(engine) || !(Number.isInteger(proofs) && proofs > 0 && proofs <= 20))
      throw new Error("usage: signpage-prover-threads.mjs [--harness [--site <dir>] | --base <https url>] [--browser webkit|chromium] [--proofs <1-20>] [--record <file>]");
    const rec = await collect({ harness: a.includes("--harness"), site: opt("--site"), engine, proofs });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = await judge(rec);
    for (const l of lines) console.log(l);
    if (!ok) for (const l of failLines(rec)) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser})`);
    code = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
  }
  globalThis.curve_bn128?.terminate?.();
  process.exit(code);
}
