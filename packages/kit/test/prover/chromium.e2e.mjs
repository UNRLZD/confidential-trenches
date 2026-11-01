#!/usr/bin/env node
// The prover in headless Chromium, under SIGN_HOST's own policy (wallet.md 2.7, W:873-878, as deployed in
// packages/signpage/public/_headers, read here, every header of its one /* rule on every response, Integrity-Policy
// included). The worker file is answered with that policy and also its own (W:880), as Pages joins two matching rules,
// so it runs under both at once. Run through the heavy-job script:
//   node packages/kit/test/prover/chromium.e2e.mjs          exit 0 when all three cases hold, 1 otherwise
// Cases:
//   good      the fixed withdraw input (withdraw.input.json, proofs/g1-phone-prover/vectors at research ffcba5e) is
//             proved in the worker; snarkjs 0.7.5's groth16.verify here, with the pinned withdraw.vkey, accepts it, and
//             its public signals are withdraw.public.json's; both files moved by transfer; no CSP violation; a plain
//             string Worker URL and every other Trusted Types policy are refused.
//   one-byte  withdraw.zkey is served with one byte changed: the worker refuses it at load, so no prove is ever posted.
//   app-host  the worker without 'wasm-unsafe-eval' (APP_HOST's policy, M304 D-8): no proof is made.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "rolldown";
import * as snarkjs from "snarkjs";
import { buildProverWorker, PROVER_WORKER_FILE } from "../../src/prover/build.mjs";
import { ZK_SETUP_FILES } from "../../src/zk/setup-files.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..", "..");
const HEADERS_FILE = join(KIT, "..", "signpage", "public", "_headers");
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"; // W:880

/** The header lines of _headers' one /* rule. */
function siteHeaders() {
  const out = [];
  let inRule = false;
  for (const line of readFileSync(HEADERS_FILE, "utf8").split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    if (!/^\s/.test(line)) {
      inRule = line.trim() === "/*";
      continue;
    }
    if (!inRule) continue;
    const i = line.indexOf(":");
    out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  const csp = out.find(([k]) => k === "Content-Security-Policy")?.[1] ?? "";
  for (const d of ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "require-trusted-types-for 'script'", "trusted-types prover-worker"])
    assert.ok(csp.includes(d), `_headers' CSP lacks ${d}`);
  assert.ok(out.some(([k, v]) => k === "Integrity-Policy" && v === "blocked-destinations=(script)"), "_headers lacks Integrity-Policy");
  return out;
}

async function site() {
  const dir = mkdtempSync(join(tmpdir(), "kit-prover-e2e-"));
  const worker = buildProverWorker(dir);
  await build({ input: join(HERE, "page.ts"), platform: "browser", logLevel: "silent", output: { file: join(dir, "page.js"), format: "iife" } });
  const pageJs = readFileSync(join(dir, "page.js"));
  const sri = "sha384-" + createHash("sha384").update(pageJs).digest("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8"><script src="/page.js" integrity="${sri}" crossorigin="anonymous"></script></head><body></body></html>`;
  const files = new Map([
    ["/", { type: "text/html", body: Buffer.from(html) }],
    ["/page.js", { type: "text/javascript", body: pageJs }],
    [`/${PROVER_WORKER_FILE}`, { type: "text/javascript", body: readFileSync(worker.file) }],
  ]);
  for (const [name, pin] of Object.entries(ZK_SETUP_FILES)) {
    const ext = name.slice(name.lastIndexOf(".") + 1);
    files.set(`/assets/zk/${pin.sha256}.${ext}`, { type: ext === "wasm" ? "application/wasm" : "application/octet-stream", body: readFileSync(join(KIT, "zk", name)) });
  }
  return { files, worker };
}

function serve(files, headers, { flipZkey = false, workerCsp = [WORKER_CSP] } = {}) {
  const zkeyPath = `/assets/zk/${ZK_SETUP_FILES["withdraw.zkey"].sha256}.zkey`;
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const f = files.get(path);
    for (const [k, v] of headers) res.setHeader(k, v);
    if (!f) return res.writeHead(404).end();
    let body = f.body;
    if (flipZkey && path === zkeyPath) {
      body = Buffer.from(body);
      body[body.length >> 1] ^= 0x01;
    }
    if (path === `/${PROVER_WORKER_FILE}`) {
      const site = headers.find(([k]) => k === "Content-Security-Policy")[1];
      res.setHeader("Content-Security-Policy", [site, ...workerCsp]);
    }
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": body.length, "Cache-Control": "no-store" }).end(body);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function runCase(browser, files, headers, input, opts) {
  const server = await serve(files, headers, opts);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const console_ = [];
  page.on("console", (m) => console_.push(m.text()));
  page.on("pageerror", (e) => console_.push(`pageerror ${e.message}`));
  page.on("requestfailed", (r) => console_.push(`requestfailed ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // page.js is a classic script in <head>, so it has run by load
    if (!(await page.evaluate(() => !!window.__kitProver))) throw new Error(`page.js did not run: ${console_.join(" | ")}`);
    const out = await page.evaluate((i) => window.__kitProver.run(i), input);
    out.console = console_;
    return out;
  } finally {
    await ctx.close();
    server.close();
  }
}

const input = JSON.parse(readFileSync(join(HERE, "withdraw.input.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(HERE, "withdraw.public.json"), "utf8")).publicSignals;
const vkey = JSON.parse(readFileSync(join(KIT, "zk", "withdraw.vkey"), "utf8"));
assert.equal(createHash("sha256").update(readFileSync(join(KIT, "zk", "withdraw.vkey"))).digest("hex"), ZK_SETUP_FILES["withdraw.vkey"].sha256);

const headers = siteHeaders();
const { files, worker } = await site();
const browser = await chromium.launch();
const failures = [];
const check = (name, f) => {
  try {
    f();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`);
  }
};
try {
  console.log(JSON.stringify({ chromium: browser.version(), cpu: cpus()[0]?.model, host: execFileSync("uname", ["-sm"]).toString().trim(), worker: { bytes: worker.bytes, sha256: worker.sha256 } }));

  const good = await runCase(browser, files, headers, input);
  const verified = good.result ? await snarkjs.groth16.verify(vkey, good.result.publicSignals, good.result.proof) : false;
  console.log(JSON.stringify({ case: "good", loadMs: good.loadMs, proveMs: good.result?.proveMs, proveWallMs: good.proveWallMs, verify: verified, posts: good.posts, violations: good.violations, plainStringWorker: good.plainStringWorker, workerURLIsTrusted: good.workerURLIsTrusted, secondPolicySameName: good.secondPolicySameName, otherPolicy: good.otherPolicy, error: good.loadError ?? good.proveError }));
  check("good: snarkjs groth16.verify accepts the worker's withdraw proof", () => assert.equal(verified, true));
  check("good: public signals are the fixed input's", () => assert.deepEqual(good.result.publicSignals, expected));
  check("good: wasm and zkey moved by transfer, nothing left on the page", () => {
    const load = good.posts.find((p) => p.cmd === "load");
    assert.deepEqual(load, { cmd: "load", transferred: 2, bytesLeftHere: [0, 0] });
  });
  // the only violations are the three the page provokes on purpose (the plain string Worker, a second prover-worker
  // policy, another policy); none from the worker and none from the proof
  check("good: no CSP or Trusted Types violation but the three probes", () =>
    assert.deepEqual(
      good.violations.map((v) => `${v.where} ${v.directive} ${v.sample}`),
      ["page require-trusted-types-for Worker constructor|/prover-worker.js", "page trusted-types prover-worker", "page trusted-types other"],
    ));
  check("good: a plain string Worker URL is refused (require-trusted-types-for 'script')", () => assert.match(good.plainStringWorker, /^TypeError: .*TrustedScriptURL/));
  check("good: the worker URL is a TrustedScriptURL from prover-worker", () => assert.equal(good.workerURLIsTrusted, true));
  check("good: no second prover-worker policy and no other policy can be made", () => {
    assert.match(good.secondPolicySameName, /^TypeError: .*prover-worker/);
    assert.match(good.otherPolicy, /^TypeError: .*other/);
  });

  const bad = await runCase(browser, files, headers, input, { flipZkey: true });
  console.log(JSON.stringify({ case: "one-byte", posts: bad.posts, error: bad.loadError ?? bad.proveError ?? null, proved: !!bad.result }));
  check("one-byte: withdraw.zkey with one byte changed is refused at load, before any prove", () => {
    assert.match(bad.loadError ?? "", /withdraw\.zkey: sha256 [0-9a-f]{64}, pinned 2a893b42/);
    assert.equal(bad.posts.some((p) => p.cmd === "prove"), false);
    assert.equal(bad.result, undefined);
  });

  const app = await runCase(browser, files, headers, input, { workerCsp: ["default-src 'none'; script-src 'self'; connect-src 'self'"] });
  console.log(JSON.stringify({ case: "app-host", error: app.loadError ?? app.proveError ?? null, proved: !!app.result, violations: app.violations }));
  check("app-host: without 'wasm-unsafe-eval' no proof is made", () => {
    assert.equal(app.result, undefined);
    assert.match(app.proveError ?? "", /WebAssembly|wasm|Content Security Policy/i);
  });
} finally {
  await browser.close();
  globalThis.curve_bn128?.terminate?.();
}
console.log(failures.length ? `FAILED ${failures.length}: ${failures.join("; ")}` : "ALL PASS");
process.exit(failures.length ? 1 : 0);
