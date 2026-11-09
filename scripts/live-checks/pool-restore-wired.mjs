#!/usr/bin/env node
// Live check of card pool-restore-wired: SIGN_HOST answers the app's `restore` (packages/signpage/src/pool-restore.ts),
// and a sign-in with the 12 words on an empty store runs it once with no tap. In a fresh Chromium profile, SIGN_HOST
// opened top-level frames APP_HOST, which this check answers with its own probe page (the kit's messages, as
// signpage-shell's APP_PAGE speaks them):
//   1. signed out, the probe asks restore: refused not_allowed (no seed, nothing read);
//   2. signin.open {way: words}; the recorded seed's 12 words are typed into the shell's own field (BIP-39's first
//      published vector, entropy all zero: packages/wallet/test/vectors/a8.json), and Continue signs in;
//   3. the new frame's state holds a restore op of the page's own (the run with no tap) that ends done;
//   4. the probe asks restore: answered {stage: "started"}, then progress for its id: reading, and done at the end;
//      never stalled.
// Since card sol-pools-mainnet-pin the page's network pins the Solana pool on mainnet (SOL_POOLS.mainnet; EVM_POOLS is
// empty), so each run there reads that pool for the vector's seed, which holds no note there, then step 5's deposit ids
// and each id's U_X on Solana (card wallet-restore-reads-ux), and ends done; a pool it cannot read ends stalled, which
// this check fails. Its marks are listed on the helper's solana-marks route (no keyless mainnet RPC answers that list)
// and read by address on the page's pair, so it passes only once the helper admitting the wallet lister's request is
// deployed. The devnet and Base Sepolia notes themselves are the card's run record
// (pool-restore-wired.run.json), read on two RPCs.
// After: sign
//   node scripts/live-checks/pool-restore-wired.mjs [--record <file>]           the deployed SIGN_HOST
//   node scripts/live-checks/pool-restore-wired.mjs --local [--record <file>]   SIGN_HOST from this checkout's
//     committed build under its own _headers, nothing on the network
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
// No money; the account is the published vector's, thrown away with the profile.
import "../net-window.mjs";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";

const KEY = "pool-restore-wired";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIGN_HOST = "confidential.unrealized.trade";
const APP_HOST = "ct-app.unrealized.trade";
const SIGN = `https://${SIGN_HOST}`;
const START = "/portfolio";
const WAIT_MS = 20_000;
const PROTECT_MS = 500; // the page's activation guard (packages/signpage/src/guard.ts)

const A8 = JSON.parse(readFileSync(path.join(REPO, "packages/wallet/test/vectors/a8.json"), "utf8"));
const WORDS = () => {
  if (!/^0+$/.test(A8.inputs.entropy)) throw new Error("the a8 vector's entropy is no longer all zero");
  return `${"abandon ".repeat(11)}about`;
};

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const restoreOps = (s) => (isObj(s) && Array.isArray(s.ops) ? s.ops.filter((o) => o?.kind === "restore") : []);

/** The verdict on one recorded run: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, line) => lines.push(`${ok ? "OK " : "BAD"} ${line}`);
  const s = rec?.steps ?? {};
  const out = s.signedOut?.answer;
  say(isObj(out) && out.ok === false && out.error?.code === "not_allowed", `signed out, restore is refused not_allowed (${JSON.stringify(out ?? null)})`);
  say(s.signedIn?.signed_in === true && s.signedIn?.way === "words", `the recorded seed's 12 words sign SIGN_HOST in (${JSON.stringify(s.signedIn ?? null)})`);
  const auto = restoreOps(s.auto?.state);
  say(auto.length === 1 && auto[0].stage === "done", `the sign-in on an empty store ran one restore with no tap, and it ended done (${JSON.stringify(auto)})`);
  const a = s.asked?.answer;
  say(isObj(a) && a.ok === true && JSON.stringify(a.result) === JSON.stringify({ stage: "started" }), `restore is answered started (${JSON.stringify(a ?? null)})`);
  const stages = Array.isArray(s.asked?.stages) ? s.asked.stages : [];
  say(stages[0] === "reading" && stages.at(-1) === "done" && !stages.includes("stalled"), `its progress reads, then ends done, never stalled (${stages.join(", ") || "none"})`);
  if (rec?.errors?.length) say(false, `the run had no error (${rec.errors.join(" | ")})`);
  return { ok: lines.every((l) => l.startsWith("OK")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
// APP_HOST's stand-in inside the shell: it talks to window.parent, and reports every message from SIGN_HOST
const APP_PAGE = `<!doctype html><meta charset="utf-8"><title>APP_HOST</title><body><script>
const SIGN = ${JSON.stringify(SIGN)};
const report = (e) => { try { window.__harnessReport(JSON.stringify(e)); } catch {} };
window.addEventListener("message", (m) => {
  if (m.source !== window.parent || m.origin !== SIGN) return;
  report({ kind: "message", t: Date.now(), data: m.data });
});
window.__send = (type, params = {}) => {
  const id = crypto.randomUUID();
  // the kit's hello first, as the kit's client sends it (card kit-frame-version): an app that names none is kit-v1.4
  window.parent.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, SIGN);
  window.parent.postMessage({ v: 1, id, type, ...params }, SIGN);
  return id;
};
report({ kind: "loaded", t: Date.now(), topLevel: window.top === window });
</script></body>`;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
/** Pages' reading of a build dir: its files under its own _headers, index.html for any other path. */
async function siteServer(root) {
  const { parseHeadersFile } = await import("../../apps/terminal/scripts/check-deploy.ts");
  const { headersFor } = await import("../../apps/terminal/test/harness/server.mjs");
  const hf = path.join(root, "_headers");
  const parsed = existsSync(hf) ? parseHeadersFile(readFileSync(hf, "utf8")) : { rules: [], problems: [] };
  if (parsed.problems.length) throw new Error(`${hf}: ${parsed.problems.join("; ")}`);
  return (urlPath) => {
    let file = path.join(root, urlPath);
    if (!file.startsWith(root + path.sep) || path.basename(file) === "_headers" || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
    const headers = Object.fromEntries(headersFor(parsed.rules, urlPath));
    headers["content-type"] = TYPES[path.extname(file)] ?? "application/octet-stream";
    return { status: 200, headers, body: readFileSync(file) };
  };
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(f, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

export async function collect({ local }) {
  const rec = { source: local ? "local: this checkout's committed packages/signpage build" : `live ${SIGN}`, at: new Date().toISOString(), browser: null, steps: {}, requests: [], errors: [] };
  let built = null;
  let sign = null;
  if (local) {
    const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
    built = buildSignpage();
    sign = await siteServer(realpathSync(built));
  }
  const browser = await launchBrowser("chromium");
  rec.browser = browserLabel(browser);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reports = [];
    await ctx.exposeBinding("__harnessReport", (src, s) => {
      let host = null;
      try {
        host = new URL(src.frame.url()).host;
      } catch {}
      if (host === APP_HOST) reports.push(JSON.parse(s));
    });
    await ctx.route("**/*", async (r) => {
      const u = new URL(r.request().url());
      rec.requests.push({ host: u.host, path: u.pathname });
      if (u.host === SIGN_HOST) return local ? r.fulfill(sign(decodeURIComponent(u.pathname))) : r.continue();
      if (u.host === APP_HOST) return r.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `frame-ancestors ${SIGN}` }, body: APP_PAGE });
      return r.abort("blockedbyclient");
    });
    const page = await ctx.newPage();
    const app = () => page.frames().find((f) => { try { return new URL(f.url()).host === APP_HOST; } catch { return false; } });
    const msgs = () => reports.filter((m) => m.kind === "message");
    const readyAfter = (t) => until(async () => msgs().some((m) => m.t >= t && m.data?.type === "ready"));
    const send = async (type, params = {}) => app().evaluate(`window.__send(${JSON.stringify(type)}, ${JSON.stringify(params)})`);
    const answerOf = (id) => until(async () => msgs().find((m) => m.data?.id === id && "ok" in m.data)?.data);
    const state = async () => (await answerOf(await send("state")))?.result;

    const t0 = Date.now();
    await page.goto(`${SIGN}${START}`, { waitUntil: "load" });
    if (!(await readyAfter(t0))) throw new Error("the shell's frame posted no ready");
    // 1. signed out
    rec.steps.signedOut = { answer: await answerOf(await send("restore")) };
    // 2. the words typed into the shell's field, then Continue
    await send("signin.open", { return_key: "portfolio", way: "words" });
    if (!(await until(() => page.evaluate(`!!document.querySelector('[data-input="words"]')`)))) throw new Error("no words field");
    await page.click('[data-input="words"]');
    await page.keyboard.type(WORDS(), { delay: 10 });
    await sleep(PROTECT_MS + 300);
    const t1 = Date.now();
    await page.click('[data-action="next"]');
    if (!(await readyAfter(t1))) throw new Error("no new frame after the sign-in");
    const s1 = await until(async () => { const s = await state(); return s?.signed_in ? s : null; });
    rec.steps.signedIn = s1 ? { signed_in: s1.signed_in, way: s1.way ?? null } : null;
    // 3. the run with no tap, to its end
    const ended = await until(async () => {
      const s = await state();
      return restoreOps(s).some((o) => o.stage === "done" || o.stage === "stalled") ? s : null;
    });
    rec.steps.auto = { state: ended ? { ops: restoreOps(ended) } : { ops: restoreOps(await state()) } };
    // 4. asked: the answer, then its progress to the end
    const id = await send("restore");
    const answer = await answerOf(id);
    const stagesOf = () => msgs().filter((m) => m.data?.id === id && m.data?.type === "progress").map((m) => m.data.stage);
    await until(async () => stagesOf().some((x) => x === "done" || x === "stalled"));
    rec.steps.asked = { answer, stages: stagesOf() };
  } catch (e) {
    rec.errors.push(String(e?.message ?? e).slice(0, 300));
  } finally {
    await browser.close();
    if (built) rmSync(built, { recursive: true, force: true });
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ the CLI
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const i = process.argv.indexOf("--record");
    const rec = await collect({ local: process.argv.includes("--local") });
    if (i > 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
