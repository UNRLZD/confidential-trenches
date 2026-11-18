#!/usr/bin/env node
// Live check of card deposit-min-floor-signed on SIGN_HOST (https://confidential.unrealized.trade). What it holds: the
// minimum deposit.assets shows for each USDC asset is one a quote at it then accepts, even when the helper rewrites the
// withdrawFee of every probe answer to 0. 1Click does not sign a dry answer's withdrawFee (packages/kit/src/checks/
// oneclick.ts), so the page's checks pass the rewritten answer; a page that counted it showed Solana's minimum at the
// bound no fee lowers (1.011719, the review of oneclick-partner-fee-live, finding 5), which the quote then refused
// below_min. The fixed page counts the fee the probe's signed amounts leave room for (packages/signpage/src/rules/
// deposit-dry.ts signedWithdrawFee).
// The run: SIGN_HOST as a top-level page frames APP_HOST, which Playwright answers with a probe page (as
// kit-deposit-assets-dry does); the probe posts the kit's hello and asks deposit.assets, and every dry quote the page
// sends the helper for it is answered with the helper's own answer, its quote.withdrawFee set to "0". Then, for each USDC
// asset listed, the probe asks deposit.dry at the minimum shown, through the helper unchanged. deposit.dry's below_min is
// read off the signed minAmountOut under the floors the live deposit.quote is held to (deposit-dry.ts depositDryKind,
// shortOnlyOfMinimum), so it is the live quote's verdict on that amount without making a deposit address.
//   PASS: every probe answer was rewritten from a withdrawFee above 0, the three USDC assets are listed, and deposit.dry at
//     each shown minimum answers ok with a min_amount_out_usd of at least 1 (the vault's MIN_DEPOSIT).
//   FAIL: a deposit.dry at a shown minimum refused (below_min: the sheet showed a minimum the quote refuses), an asset not
//     listed, a probe answer not rewritten, a dry asked at another amount, the shell's ready missing, a pin that does not
//     match.
//   INCONCLUSIVE (exit 3): 1Click answered its no-liquidity 400 to every ask of a quote, or 1Click's own withdrawFee was 0
//     (the rewrite then changes nothing).
// After: sign
// Bundle: out a browser, the helper and 1Click
//   node scripts/live-checks/deposit-min-floor-signed.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/deposit-min-floor-signed.mjs --local [<build dir>] [--record <file>]
//     SIGN_HOST answered from a build dir under its own _headers (the helper and 1Click are still reached); with no dir,
//     packages/signpage's build from this tree (scripts/signpage-built.mjs), as kit-deposit-assets-dry's --local
//   node scripts/live-checks/deposit-min-floor-signed.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3; the last line is "<verdict> deposit-min-floor-signed",
// each failure a "BAD ..." line.
import "../net-window.mjs";
import { cpSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../browsers.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { named } from "./record-names.mjs";
import { signBuilt } from "../signpage-built.mjs";
import { saidOf } from "./vendor-said.mjs";
import { APP_HOST, ASSETS, ASSETS_MS, DRY_MS, EXIT, HELPER_1CLICK, READY_MS, SIGN_URL, dec, headersOf, noLiquidityAsks } from "./kit-deposit-assets-dry.mjs";

const KEY = "deposit-min-floor-signed";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const QUOTE = `${HELPER_1CLICK}/v0/quote`;
const ONE = 10n ** 18n; // dec()'s scale
const MESSAGE_MAX = 120;
const SETTLE_MS = 1_000;
const show = (v) => JSON.stringify(v);
/** A USDC decimal as its base units (6 decimals), or null. */
const usdcUnits = (s) => {
  const d = dec(s);
  return d === null || d % 10n ** 12n !== 0n ? null : (d / 10n ** 12n).toString();
};

// ------------------------------------------------------------------------------------------------ the verdict
/** The verdict on an answer (what collect() returns): { verdict, ok, lines }. */
export function judge(a) {
  const lines = [];
  const vendor = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const later = (m) => vendor.push(`INCONCLUSIVE ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.appJs?.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.ready !== true) bad("the shell's ready did not arrive in the APP_HOST frame");
  let signOrigin = null;
  try {
    signOrigin = new URL(a.signUrl).origin;
  } catch {}
  const answerTo = (id) => (a?.log ?? []).filter((m) => m.fromParent && m.origin === signOrigin && id && m.data?.id === id).map((m) => m.data);
  const one = (kind, id) => {
    const got = answerTo(id);
    if (got.length !== 1) bad(`${kind}: ${got.length} answer(s) to its id, want 1`);
    return got.length === 1 ? got[0] : null;
  };
  const noQuote = (r) => r?.ok === false && r.error?.code === "not_available";

  // ---- the probes: each answered by the helper, its withdrawFee rewritten to 0
  const probes = (a?.helper ?? []).filter((r) => r?.phase === "assets" && r.method === "POST" && r.url === QUOTE && (r.status === 200 || r.status === 201));
  if (probes.length === 0 && Object.keys(ASSETS).every((id) => !noLiquidityAsks(a, "assets", id))) bad("no probe for deposit.assets was answered: the run proves nothing");
  for (const p of probes) {
    const from = p.rewrittenFrom;
    if (typeof from !== "string") bad(`the probe from ${show(p.body?.originAsset)} was answered with no withdrawFee rewritten`);
    else if (!/^[0-9]+$/.test(from)) bad(`the probe from ${show(p.body?.originAsset)} carried withdrawFee ${show(from)}, not a base-unit amount`);
    else if (BigInt(from) === 0n) later(`1Click's own withdrawFee on the probe from ${p.body?.originAsset} was 0: the rewrite changed nothing`);
  }

  // ---- deposit.assets, read under the rewrite
  const assets = one("deposit.assets", a?.ids?.assets);
  const list = assets?.ok === true && Array.isArray(assets.result?.assets) ? assets.result.assets : null;
  if (assets && !list) {
    if (noQuote(assets) && Object.keys(ASSETS).every((id) => noLiquidityAsks(a, "assets", id))) later("deposit.assets answered not_available after 1Click's no-liquidity 400 to every probe: 1Click's liquidity, not the page's");
    else bad(`deposit.assets answered ${show(assets.error ?? assets.result)}, want its assets`);
  }

  // ---- deposit.dry at each shown minimum
  for (const id of list ? Object.keys(ASSETS) : []) {
    const row = list.find((x) => x?.origin_asset === id);
    if (!row) {
      if (noLiquidityAsks(a, "assets", id)) later(`deposit.assets does not list ${id}, whose probe 1Click answered 400 No liquidity available`);
      else bad(`deposit.assets does not list ${id}`);
      continue;
    }
    const units = usdcUnits(row.min);
    if (units === null || dec(row.min) < ONE) {
      bad(`deposit.assets ${id}: min ${show(row.min)} is not a USDC amount of at least 1`);
      continue;
    }
    const ask = a?.ids?.dry?.[id];
    if (!ask || ask.amount !== row.min) {
      bad(`deposit.dry from ${id} was not asked at the shown minimum ${row.min}${ask ? ` (asked ${show(ask.amount)})` : ""}`);
      continue;
    }
    const r = one(`deposit.dry from ${id} at ${row.min}`, ask.id);
    if (!r) continue;
    if (r.ok === true) {
      const floor = dec(r.result?.min_amount_out_usd);
      if (floor === null || floor < ONE) bad(`deposit.dry from ${id} at ${row.min}: min_amount_out_usd ${show(r.result?.min_amount_out_usd)} is under 1 USDC`);
      continue;
    }
    const code = r.error?.code;
    if (noQuote(r) && noLiquidityAsks(a, "dry", id, units)) later(`deposit.dry from ${id} at ${row.min} answered not_available after 1Click's no-liquidity 400: 1Click's liquidity, not the page's`);
    else if (code === "below_min") bad(`deposit.dry from ${id} at the minimum deposit.assets showed, ${row.min}, answered below_min: the sheet showed a minimum the quote refuses`);
    else bad(`deposit.dry from ${id} at ${row.min} answered ${show(code ?? r)}, want ok`);
  }

  const verdict = lines.length > 0 ? "FAIL" : vendor.length > 0 ? "INCONCLUSIVE" : "PASS";
  if (verdict === "INCONCLUSIVE") lines.push(...vendor);
  return { verdict, ok: verdict === "PASS", lines };
}

// ------------------------------------------------------------------------------------------------ the read
/** packages/signpage as deploy.mjs build() makes it, minus the prover's setup files: index.html and public/ copied. */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-dep-min-floor-"));
  copyFileSync(path.join(signBuilt(), "index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
/** Answers every request to SIGN_HOST from the build in `dir`, under its own _headers, as Pages serves it. */
function serveDir(dir) {
  const h = headersOf(readFileSync(path.join(dir, "_headers"), "utf8"));
  return (r) => {
    const p = new URL(r.request().url()).pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || p === "/_headers") return r.fulfill({ status: 404, headers: h, body: "" });
    return r.fulfill({ status: 200, headers: { ...h, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }, body: readFileSync(file) });
  };
}
// The APP_HOST frame: records every message; __ask(type, params) posts the kit's hello once, then the request.
const appProbeHtml = (signOrigin) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
addEventListener("message", (e) => window.__log.push({ origin: e.origin, fromParent: e.source === parent, data: e.data }));
window.__ask = (type, params) => {
  if (!window.__hello) {
    window.__hello = true;
    parent.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, ${JSON.stringify(signOrigin)});
  }
  const m = { v: 1, id: crypto.randomUUID(), type, ...params };
  parent.postMessage(m, ${JSON.stringify(signOrigin)});
  return m.id;
};
</script></body>`;

async function pageRun(browser, { signUrl, dir }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  await ctx.route((u) => u.origin === APP_HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: appProbeHtml(signOrigin) }));
  if (dir) await ctx.route((u) => u.origin === signOrigin, serveDir(dir));
  let phase = "assets";
  const helper = [];
  const asked = new Map();
  const rewrites = new Map();
  const reads = [];
  // the attack: a probe's answer as the helper gave it, its unsigned withdrawFee set to "0"; nothing else touched
  await ctx.route(QUOTE, async (route) => {
    if (phase !== "assets") return route.fallback();
    const res = await route.fetch();
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const headers = { ...res.headers() };
    delete headers["content-length"];
    if (body === null || typeof body.quote !== "object" || body.quote === null) return route.fulfill({ status: res.status(), headers, body: text });
    rewrites.set(route.request(), String(body.quote.withdrawFee));
    body.quote.withdrawFee = "0";
    return route.fulfill({ status: res.status(), headers, body: JSON.stringify(body) });
  });
  ctx.on("request", (req) => {
    if (!req.url().startsWith(`${HELPER_1CLICK}/`)) return;
    let body = null;
    try {
      body = JSON.parse(req.postData() ?? "null");
    } catch {}
    const entry = { phase, url: req.url(), method: req.method(), body };
    helper.push(entry);
    asked.set(req, entry);
  });
  ctx.on("response", (res) => {
    const entry = asked.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    if (res.status() === 400)
      reads.push(res.text().then((t) => {
        const m = saidOf(t);
        if (m !== null) entry.message = [...m].slice(0, MESSAGE_MAX).join("");
      }, () => {}));
  });
  let index = null;
  let appJs = null;
  ctx.on("response", async (res) => {
    try {
      if (res.url() === new URL("/", signUrl).href && res.request().resourceType() === "document") index = await res.text();
      else if (res.url() === new URL("/app.js", signUrl).href && res.request().resourceType() === "script")
        appJs = { status: res.status(), sha384: `sha384-${createHash("sha384").update(await res.body()).digest("base64")}` };
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(signUrl, { waitUntil: "load" });
  const app = () => page.frames().find((f) => f.url().startsWith(`${APP_HOST}/`));
  let log = [];
  const waitFor = async (ms, done) => {
    for (const until = Date.now() + ms; Date.now() < until; await page.waitForTimeout(100)) {
      const f = app();
      log = f ? await f.evaluate(() => window.__log).catch(() => log) : log;
      if (done(log)) return true;
    }
    return false;
  };
  const ready = await waitFor(READY_MS, (l) => l.some((m) => m.fromParent && m.data?.type === "ready"));
  const ids = { assets: null, dry: {} };
  if (ready) {
    ids.assets = await app().evaluate(() => window.__ask("deposit.assets", {}));
    await waitFor(ASSETS_MS, (l) => l.some((m) => m.data?.id === ids.assets));
    const got = log.find((m) => m.data?.id === ids.assets)?.data;
    phase = "dry";
    // one at a time: a newer deposit.dry ends the one before it (src/deposit-wire.ts)
    for (const id of Object.keys(ASSETS)) {
      const row = got?.ok === true && Array.isArray(got.result?.assets) ? got.result.assets.find((x) => x?.origin_asset === id) : undefined;
      if (typeof row?.min !== "string") continue;
      const dryId = await app().evaluate((p) => window.__ask("deposit.dry", p), { origin_asset: id, amount: row.min });
      ids.dry[id] = { id: dryId, amount: row.min };
      await waitFor(DRY_MS, (l) => l.some((m) => m.data?.id === dryId));
    }
    await page.waitForTimeout(SETTLE_MS);
    log = await (app()?.evaluate(() => window.__log).catch(() => log) ?? log);
  }
  await Promise.allSettled(reads);
  for (const [req, from] of rewrites) {
    const entry = asked.get(req);
    if (entry) entry.rewrittenFrom = from;
  }
  await ctx.close();
  return { signUrl, ready, ids, log, helper, index, appJs, errors };
}

export async function collect({ browser, signUrl = SIGN_URL, dir, source }) {
  const run = await pageRun(browser, { signUrl, dir });
  return { source, at: new Date().toISOString(), browser: browser.version(), ...run };
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const record = opt("--record");
  let answer;
  if (opt("--answer")) answer = JSON.parse(readFileSync(opt("--answer"), "utf8"));
  else {
    const local = args.includes("--local");
    const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
    const dir = local ? (given ?? build()) : null;
    const browser = await launchBrowser("chromium");
    try {
      answer = local
        ? await collect({ browser, signUrl: SIGN_URL, dir, source: `local, SIGN_HOST answered from ${given ? named(given) : "packages/signpage's build (index.html and public/ copied)"}` })
        : await collect({ browser, signUrl: opt("--url") ?? SIGN_URL, source: "live" });
    } finally {
      await browser.close();
      if (local && !given) rmSync(dir, { recursive: true, force: true });
    }
  }
  if (record) writeFileSync(record, `${JSON.stringify(answer, null, 1)}\n`);
  const v = judge(answer);
  for (const l of v.lines) console.log(l);
  console.log(`${v.verdict} ${KEY}`);
  process.exit(EXIT[v.verdict]);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERROR ${KEY}: ${e?.stack ?? e}`);
    process.exit(2);
  });
}
