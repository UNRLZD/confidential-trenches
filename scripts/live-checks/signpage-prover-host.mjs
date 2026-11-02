#!/usr/bin/env node
// Live check of card signpage-prover-host: the prover runs on SIGN_HOST, with its files served from SIGN_HOST's own
// origin (vault.md 2.14 and V2's end state, M304 D-8, wallet.md W:880-882). It reads, against pins written out here and
// not read from the kit, on SIGN_HOST = https://sign.confidential.unrealized.trade (signpage-skeleton's SIGN):
//   - each of the six setup files at https://SIGN_HOST/assets/zk/<sha256>.<ext>: 200, its size and sha256 equal to
//     vault.md 2.6's table (research ffcba5e, V:520-525), and cached for good (Cache-Control immutable, one year);
//   - the worker at https://SIGN_HOST/prover-worker.js: 200, a script, byte for byte the committed
//     packages/signpage/public/prover-worker.js (the kit's build, which build-app.mjs --check holds), under two
//     policies at once: the site's (signpage-skeleton's CSP, every directive) and its own, exactly W:880's;
//   - the licence texts at /licenses/: 200, each equal to the file the deploy copies;
//   - in headless Chromium on https://SIGN_HOST/ (the deployed page, its own script running): a Worker from a plain
//     string is refused (require-trusted-types-for 'script'), a second policy named prover-worker and any other policy
//     are refused, and the worker made through prover-worker loads the withdraw wasm and zkey moved by transfer and
//     proves the fixed input (packages/kit/test/prover/withdraw.input.json); the proof's public signals are
//     withdraw.public.json's and snarkjs 0.7.5's groth16.verify accepts it with the pinned withdraw.vkey;
//   - no CSP or Trusted Types violation on the page or in the worker but the three the probes make.
// The page script here speaks the worker's protocol itself (load, prove) rather than run the kit's client, so the check
// does not trust the code it checks; the kit's own call in Chromium is packages/kit/test/prove-e2e.test.ts's.
//   node scripts/live-checks/signpage-prover-host.mjs [--record <file>]                       the live SIGN_HOST
//   node scripts/live-checks/signpage-prover-host.mjs --harness [--site <dir>] [--record <file>]
//     the harness: SIGN_HOST answered from a build folder under its own _headers, every rule that matches joined as
//     Pages joins them (default: a fresh `node packages/signpage/scripts/deploy.mjs --dry-run` build, which passed the
//     deploy gate); APP_HOST, which the page frames, from a blank page; every other host refused.
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
// packages/signpage/scripts/deploy.mjs refuses a _headers whose worker rule is not WORKER_CSP, exactly.
import "../net-window.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP, CSP as SITE_CSP, SIGN } from "./signpage-skeleton.mjs";

const KEY = "signpage-prover-host";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------- pinned ----------
export const WORKER_PATH = "/prover-worker.js";
// wallet.md W:880: the worker script carries its own policy
export const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
// vault.md 2.6, the table's six rows (V:520-525): name, bytes, sha256
export const PINS = [
  ["withdraw.wasm", 2607967, "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10"],
  ["withdraw.zkey", 17793015, "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677"],
  ["withdraw.vkey", 4208, "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e"],
  ["commitment.wasm", 2380442, "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8"],
  ["commitment.zkey", 901233, "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3"],
  ["commitment.vkey", 3477, "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8"],
];
export const zkPath = ([name, , sha]) => `/assets/zk/${sha}.${name.slice(name.lastIndexOf(".") + 1)}`;
// what SIGN_HOST serves at /licenses/, and the file each must equal (the deploy's copy, build-app.mjs SERVED)
export const LICENSES = [
  ["/licenses/GPL-3.0.txt", "packages/kit/zk/LICENSE-GPL-3.0.txt"], // the worker's header names it
  ["/licenses/LGPL-3.0.txt", "packages/kit/zk/LICENSE-LGPL-3.0.txt"],
  ["/licenses/Apache-2.0.txt", "LICENSE"],
  ["/licenses/zk-NOTICE.txt", "packages/kit/zk/NOTICE"],
];
// the three violations the probes make, in order; any other is a fault
export const PROBE_VIOLATIONS = [
  "page require-trusted-types-for Worker constructor|/prover-worker.js",
  "page trusted-types prover-worker",
  "page trusted-types other",
];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const repoFile = (p) => readFileSync(path.join(REPO, p));
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** A CSP header's policies (comma-separated, CSP3 3.1), each a Map of directive to its value. */
export function policies(header) {
  return String(header ?? "")
    .split(",")
    .map((pol) => {
      const m = new Map();
      for (const part of pol.split(";")) {
        const [k, ...v] = part.trim().split(/\s+/);
        if (k) m.set(k.toLowerCase(), v.join(" "));
      }
      return m;
    })
    .filter((m) => m.size);
}
const sameAs = (m, want) => m.size === want.length && want.every(([k, v]) => m.get(k) === v);
const WORKER_DIRECTIVES = WORKER_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]);

/** What the check expects beyond the pins: read from this checkout (the deployed release's). */
export function expected() {
  const vkey = repoFile("packages/kit/zk/withdraw.vkey");
  const pin = PINS.find(([n]) => n === "withdraw.vkey");
  if (vkey.length !== pin[1] || sha256(vkey) !== pin[2]) throw new Error("packages/kit/zk/withdraw.vkey is not the pinned file");
  return {
    worker: sha256(repoFile(`packages/signpage/public${WORKER_PATH}`)),
    licenses: Object.fromEntries(LICENSES.map(([p, f]) => [p, sha256(repoFile(f))])),
    input: JSON.parse(repoFile("packages/kit/test/prover/withdraw.input.json").toString("utf8")),
    signals: JSON.parse(repoFile("packages/kit/test/prover/withdraw.public.json").toString("utf8")).publicSignals,
    vkey: JSON.parse(vkey.toString("utf8")),
  };
}

function snarkjs() {
  return createRequire(path.join(REPO, "packages/kit/package.json"))("snarkjs");
}

/** The check on one recorded answer. Async: snarkjs verifies the proof. */
export async function judge(rec, want = expected()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const files = rec.files ?? {};

  for (const pin of PINS) {
    const [name, bytes, sha] = pin;
    const f = files[zkPath(pin)];
    if (!f) {
      say(false, `${name}: not read`);
      continue;
    }
    say(f.status === 200, `${name} at ${zkPath(pin)}: ${f.status}`);
    say(f.bytes === bytes && f.sha256 === sha, `${name}: ${f.bytes} B sha256 ${f.sha256}${f.bytes === bytes && f.sha256 === sha ? "" : `, pinned ${bytes} B ${sha}`}`);
    const cc = String(f.headers?.["cache-control"] ?? "");
    const cached = /(^|,)\s*immutable\s*(,|$)/.test(cc) && /(^|,)\s*max-age=31536000\s*(,|$)/.test(cc);
    say(cached, `${name}: cache-control ${show(f.headers?.["cache-control"])}${cached ? "" : ", want max-age=31536000 and immutable"}`);
  }

  const w = files[WORKER_PATH];
  if (!w) say(false, `${WORKER_PATH}: not read`);
  else {
    say(w.status === 200, `${WORKER_PATH}: ${w.status}`);
    say(/javascript/.test(String(w.headers?.["content-type"] ?? "")), `${WORKER_PATH}: content-type ${show(w.headers?.["content-type"])}`);
    say(w.sha256 === want.worker, `${WORKER_PATH}: sha256 ${w.sha256}${w.sha256 === want.worker ? "" : `, the release's ${want.worker}`}`);
    const pols = policies(w.headers?.["content-security-policy"]);
    const site = pols.filter((m) => sameAs(m, SITE_CSP)).length;
    const own = pols.filter((m) => sameAs(m, WORKER_DIRECTIVES)).length;
    say(pols.length === 2 && site === 1 && own === 1, `${WORKER_PATH}: ${pols.length} CSP policies, the site's ${site}, its own (W:880) ${own}; want exactly one of each`);
  }

  for (const [p] of LICENSES) {
    const f = files[p];
    const ok = !!f && f.status === 200 && f.sha256 === want.licenses[p];
    say(ok, `${p}: ${f ? `${f.status} sha256 ${f.sha256}` : "not read"}${ok ? "" : `, want 200 ${want.licenses[p]}`}`);
  }

  const pg = rec.page;
  if (!pg) say(false, "the page: not run");
  else {
    say(/^TypeError: .*TrustedScriptURL/.test(pg.plainStringWorker ?? ""), `a Worker from a plain string: ${show(pg.plainStringWorker)}`);
    say(pg.workerURLIsTrusted === true, `the worker URL is a TrustedScriptURL from prover-worker: ${show(pg.workerURLIsTrusted)}`);
    say(/^TypeError: .*prover-worker/.test(pg.secondPolicySameName ?? ""), `a second prover-worker policy: ${show(pg.secondPolicySameName)}`);
    say(/^TypeError: .*other/.test(pg.otherPolicy ?? ""), `a policy named other: ${show(pg.otherPolicy)}`);
    const load = (pg.posts ?? []).find((p) => p.cmd === "load");
    const moved = !!load && load.transferred === 2 && JSON.stringify(load.bytesLeftHere) === "[0,0]";
    say(moved, `the wasm and zkey moved to the worker by transfer: ${show(load)}`);
    say(!pg.loadError, `the worker loads the withdraw setup files: ${pg.loadError ? show(pg.loadError) : `${pg.loadMs} ms`}`);
    const r = pg.result;
    say(!!r && !pg.proveError, `the worker proves the fixed input: ${r ? `${r.proveMs} ms in the worker` : show(pg.proveError ?? "not asked")}`);
    const sig = !!r && JSON.stringify(r.publicSignals) === JSON.stringify(want.signals);
    say(sig, `its public signals are withdraw.public.json's${sig || !r ? "" : `: ${show(r.publicSignals)}`}`);
    let verified = false;
    if (r) {
      try {
        verified = await snarkjs().groth16.verify(want.vkey, want.signals, r.proof);
      } catch {}
    }
    say(verified, `snarkjs groth16.verify with the pinned withdraw.vkey: ${verified}`);
    const v = (pg.violations ?? []).map((x) => `${x.where} ${x.directive} ${x.sample}`);
    const clean = JSON.stringify(v) === JSON.stringify(PROBE_VIOLATIONS);
    say(clean, `CSP and Trusted Types violations: the probes' three only${clean ? "" : `: ${show(v)}`}`);
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8" };

/** Pages' reading of a build folder: its files under its own _headers (every rule that matches, joined), 404 for none. */
async function siteServer(root) {
  const { parseHeadersFile } = await import("../../apps/terminal/scripts/check-deploy.ts");
  const { headersFor } = await import("../../apps/terminal/test/harness/server.mjs");
  const parsed = parseHeadersFile(readFileSync(path.join(root, "_headers"), "utf8"));
  if (parsed.problems.length) throw new Error(`${root}/_headers: ${parsed.problems.join("; ")}`);
  return (urlPath) => {
    const p = urlPath === "/" ? "/index.html" : urlPath;
    const file = path.join(root, p);
    const headers = Object.fromEntries(headersFor(parsed.rules, urlPath));
    if (!file.startsWith(root + path.sep) || path.basename(file) === "_headers" || !existsSync(file) || statSync(file).isDirectory()) return { status: 404, headers, body: Buffer.alloc(0) };
    headers["content-type"] = TYPES[path.extname(file)] ?? "application/octet-stream";
    return { status: 200, headers, body: readFileSync(file) };
  };
}

const KEEP = ["content-type", "cache-control", "content-security-policy", "x-content-type-options", "cross-origin-resource-policy"];
const summary = (status, headers, body) => ({
  status,
  bytes: body.length,
  sha256: sha256(body),
  headers: Object.fromEntries(KEEP.filter((k) => headers[k] !== undefined).map((k) => [k, headers[k]])),
});

/** The files: from `serve` (the harness) or over the network. */
async function readFiles(serve) {
  const out = {};
  for (const p of [...PINS.map(zkPath), WORKER_PATH, ...LICENSES.map(([l]) => l)]) {
    if (serve) {
      const a = serve(p);
      out[p] = summary(a.status, a.headers, a.body);
      continue;
    }
    const r = await fetch(`${SIGN}${p}`, { redirect: "manual", headers: { "cache-control": "no-cache" } });
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    out[p] = summary(r.status, headers, Buffer.from(await r.arrayBuffer()));
  }
  return out;
}

// installed in SIGN_HOST's top page before its own script runs: every violation, every post to a worker
const INIT = `(() => {
  if (location.origin !== ${JSON.stringify(SIGN)} || window.top !== window) return;
  const ph = (window.__ph = { violations: [], posts: [] });
  document.addEventListener("securitypolicyviolation", (e) => ph.violations.push({ where: "page", directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample }));
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    const transfer = Array.isArray(t) ? t : [];
    post.call(this, m, transfer);
    ph.posts.push({ cmd: m && m.cmd, transferred: transfer.length, bytesLeftHere: transfer.map((b) => b.byteLength) });
  };
})();`;

// the probes, then the worker made through prover-worker, fed and asked by its own protocol (packages/kit/src/prover/worker.js)
const RUN = `async ([input, pins]) => {
  const ph = window.__ph;
  const out = { violations: ph.violations, posts: ph.posts };
  const err = (e) => (e instanceof Error ? e.name + ": " + e.message : String(e));
  const attempt = (f) => { try { f(); return "allowed"; } catch (e) { return err(e); } };
  const tt = window.trustedTypes;
  if (!tt) return { ...out, plainStringWorker: "no Trusted Types in this browser" };
  out.plainStringWorker = attempt(() => new Worker(${JSON.stringify(WORKER_PATH)}));
  const url = new URL(${JSON.stringify(WORKER_PATH)}, location.origin).href;
  const policy = tt.createPolicy("prover-worker", {
    createScriptURL(s) {
      if (new URL(s, location.origin).href !== url) throw new TypeError("prover-worker refuses " + s);
      return url;
    },
  });
  const trusted = policy.createScriptURL(url);
  out.workerURLIsTrusted = tt.isScriptURL(trusted);
  out.secondPolicySameName = attempt(() => tt.createPolicy("prover-worker", { createScriptURL: (s) => s }));
  out.otherPolicy = attempt(() => tt.createPolicy("other", { createScriptURL: (s) => s }));
  const worker = new Worker(trusted, { name: "prover" });
  const waiting = new Map();
  let next = 1;
  worker.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "violation") return void ph.violations.push({ where: "worker", ...m.violation });
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.ok ? w.ok(m.value) : w.fail(new Error(m.error));
  });
  const dead = new Promise((_, fail) => worker.addEventListener("error", (e) => fail(new Error("prover worker: " + (e.message || "failed to load")))));
  dead.catch(() => {});
  const call = (msg, transfer = []) => Promise.race([dead, new Promise((ok, fail) => { const id = next++; waiting.set(id, { ok, fail }); worker.postMessage({ ...msg, id }, transfer); })]);
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
    try {
      out.result = await call({ cmd: "prove", circuit: "withdraw", input });
    } catch (e) {
      out.proveError = err(e);
    }
    return out;
  } finally {
    worker.terminate();
  }
}`;

/** The browser run on SIGN_HOST's page: the live one, or `serve`'s. */
async function readPage(serve) {
  const pw = createRequire(path.join(REPO, "packages/signpage/package.json"))("playwright");
  const browser = await pw.chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(INIT);
    if (serve) {
      const signHost = new URL(SIGN).host;
      const appHost = new URL(APP).host;
      await ctx.route("**/*", async (r) => {
        const u = new URL(r.request().url());
        if (u.host === signHost) {
          const a = serve(decodeURIComponent(u.pathname));
          return r.fulfill({ status: a.status, headers: a.headers, body: a.body });
        }
        if (u.host === appHost) return r.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `frame-ancestors ${SIGN}` }, body: "<!doctype html><title>app</title>" });
        return r.abort("blockedbyclient");
      });
    }
    const page = await ctx.newPage();
    await page.goto(`${SIGN}/`, { waitUntil: "load" });
    if (!(await page.evaluate(() => !!window.__ph))) throw new Error("the init script did not run on SIGN_HOST's page");
    const want = expected();
    const pins = { wasm: zkPath(PINS[0]), zkey: zkPath(PINS[1]) };
    const out = await page.evaluate(`(${RUN})(${JSON.stringify([want.input, pins])})`);
    await new Promise((ok) => setTimeout(ok, 250)); // a violation is reported a task after its cause
    out.violations = await page.evaluate(() => window.__ph.violations);
    return { browser: `chromium ${browser.version()} (Playwright)`, page: out };
  } finally {
    await browser.close();
  }
}

/** A fresh deploy build that passed the deploy gate (deploy.mjs --dry-run keeps it); the caller removes it. */
function gateBuild() {
  const r = spawnSync(process.execPath, [path.join(REPO, "packages/signpage/scripts/deploy.mjs"), "--dry-run"], { encoding: "utf8" });
  const dir = /gate ok on (\S+);/.exec(r.stdout ?? "")?.[1];
  if (r.status !== 0 || !dir) throw new Error(`deploy.mjs --dry-run: exit ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  return dir;
}

export async function collect({ harness = false, site } = {}) {
  let dir = null;
  try {
    let serve = null;
    if (harness) {
      dir = site ? null : gateBuild();
      serve = await siteServer(path.resolve(site ?? dir));
    }
    const files = await readFiles(serve);
    const run = await readPage(serve);
    return { source: harness ? `harness, SIGN_HOST from ${site ?? "a fresh deploy.mjs --dry-run build"}` : `live ${SIGN}`, at: new Date().toISOString(), browser: run.browser, files, page: run.page };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  let code = 2;
  try {
    const known = new Set(["--harness", "--site", "--record"]);
    const bad = a.filter((x, i) => x.startsWith("--") && !known.has(x) && !(i > 0 && ["--site", "--record"].includes(a[i - 1])));
    if (bad.length || (opt("--site") && !a.includes("--harness"))) throw new Error("usage: signpage-prover-host.mjs [--harness [--site <dir>]] [--record <file>]");
    const rec = await collect({ harness: a.includes("--harness"), site: opt("--site") });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = await judge(rec);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser})`);
    code = ok ? 0 : 1;
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
  }
  globalThis.curve_bn128?.terminate?.();
  process.exit(code);
}
