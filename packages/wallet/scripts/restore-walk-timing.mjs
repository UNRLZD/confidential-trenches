// A timing record, not a gate (card wallet-restore-wallets): the deposit index walk at RESTORE_GAP on an empty vault (the
// whole walk of a scope never used: 8 lanes x RESTORE_GAP indices), in the installed Google Chrome, as the signing page
// runs it: src/restore/walk.ts's walkInWorkers starting one module Worker per lane (src/restore/walk-worker.ts, bundled
// by Vite as the signing page's build bundles its code), then restorePages checking every walk on the page's thread.
// It runs at Chrome's CPU throttling rates 1 (this machine) and 4 (Lighthouse's mobile preset), each read through the
// DevTools protocol (Emulation.setCPUThrottlingRate), and also one lane on the page's own thread at each rate, which
// shows whether the throttle reached the Workers. Every number it prints is measured on a desktop, not on a phone: rate
// 4 is this desktop slowed down, never a phone's figure (a phone's own run is still to be made).
//   node packages/wallet/scripts/restore-walk-timing.mjs      (starts Chrome through scripts/browsers.mjs; about a minute)
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { browserLabel, launchBrowser } from "../../../scripts/browsers.mjs";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ct-walk-timing-"));
const PAGE = `
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "@blindfill/kit";
import { entropyToWords, wordsToSeed64 } from "../src/derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, restorePages, walkLane } from "../src/notes/restore.ts";
import { walkInWorkers } from "../src/restore/walk.ts";
// the all-zero BIP-39 entropy (test/vectors/a8.json): a published vector, never money
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const SCOPE = vaultScopeOf(keccak_256, "vault.bf-restore.testnet", "usdc.fakes.testnet");
window.run = async () => {
  const spawn = () => new Worker("/walk-worker.js", { type: "module" });
  const walk = walkInWorkers(SEED, spawn);
  const none = new Set();
  const t0 = performance.now();
  const lanes = await Promise.all(Array.from({ length: RESTORE_LANES }, (_, lane) => walk(lane, SCOPE, RESTORE_GAP, none)));
  const t1 = performance.now();
  const r = restorePages(SEED, SCOPE, { deposits: [], spends: [], leaves: [] }, { lanes });
  const t2 = performance.now();
  walkLane(SEED, SCOPE, 0, () => false, RESTORE_GAP);
  const t3 = performance.now();
  return { workersMs: Math.round(t1 - t0), checksMs: Math.round(t2 - t1), restoreMs: Math.round(t2 - t0), oneLaneOnPageMs: Math.round(t3 - t2), notes: r.notes.length, cores: navigator.hardwareConcurrency };
};
`;
writeFileSync(join(PKG, "scripts/.timing-page.ts"), PAGE);
try {
  // Vite as the signing page has it (packages/signpage/scripts/build-app.mjs)
  const { build } = await import(pathToFileURL(createRequire(join(PKG, "../signpage/package.json")).resolve("vite")).href);
  for (const [input, name] of [[join(PKG, "scripts/.timing-page.ts"), "page.js"], [join(PKG, "src/restore/walk-worker.ts"), "walk-worker.js"]]) {
    await build({
      configFile: false, root: PKG, logLevel: "warn", publicDir: false,
      build: { outDir: dir, emptyOutDir: false, target: "es2023", minify: true, modulePreload: false, copyPublicDir: false, rolldownOptions: { input, output: { format: "es", entryFileNames: name, codeSplitting: false } } },
    });
  }
} finally {
  rmSync(join(PKG, "scripts/.timing-page.ts"), { force: true });
}
const files = { "/": ["text/html", '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>'], "/page.js": ["text/javascript", readFileSync(join(dir, "page.js"))], "/walk-worker.js": ["text/javascript", readFileSync(join(dir, "walk-worker.js"))] };
const server = createServer((q, s) => {
  const f = files[q.url];
  if (!f) return s.writeHead(404).end();
  s.writeHead(200, { "content-type": f[0] }).end(f[1]);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await launchBrowser("chromium");
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.run === "function");
  const cdp = await page.context().newCDPSession(page);
  const out = [];
  for (const rate of [1, 4]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    for (let k = 0; k < 2; k++) out.push({ rate, run: k + 1, ...(await page.evaluate(() => window.run())) });
  }
  console.log(JSON.stringify({ browser: browserLabel(browser), cpu: cpus()[0]?.model, threads: cpus().length, node: process.version, at: new Date().toISOString(), runs: out }, null, 1));
} finally {
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
