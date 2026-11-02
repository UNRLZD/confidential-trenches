#!/usr/bin/env node
// Live check of card signpage-postmessage: nothing but SIGN_HOST's own shell speaks to SIGN_HOST's page. Since card
// signpage-shell, SIGN_HOST is the top window and frames APP_HOST (packages/signpage/src/shell.ts); its CSP says
// frame-ancestors 'none', so no page frames it, APP_HOST included. Headless Chromium frames SIGN_HOST from a probe page
// that Playwright serves at each parent origin (no request reaches a real parent host), posts the kit's messages to the
// frame and records every message the parent receives:
//   - from APP_HOST, under SIGN_HOST's headers as served: the frame is blocked by frame-ancestors and nothing arrives;
//   - from https://example.com, https://evil.ct.test (same-site with the test hosts) and https://app.other.test
//     (cross-site), each twice: under the headers as served, the frame is blocked (frame-ancestors) and nothing
//     arrives; with frame-ancestors lifted from SIGN_HOST's CSP, the frame loads and runs its script, and still nothing
//     arrives: the page's own origin check and targetOrigin are what refuse.
// The API's shapes and refusals (packages/kit/src/signpage/messages.ts, api 1) are packages/signpage/test/api.test.ts's,
// and the shell's answers to its frame are signpage-shell's.
// One more run, the deposit.quote round trip (card signpage-deposit-quote-wire): SIGN_HOST top-level, as it is opened,
// frames APP_HOST, which Playwright answers with a probe page; once the shell's ready arrives the probe asks `state`
// and then deposit.quote (25 USDC from Solana) and records the answers, and the run records every request the page
// sends to the helper's 1Click proxy. In a fresh browser the page holds no seed, so the answer must be a refusal,
// not_allowed, with no request sent: nothing leaves the device for an account that is not there, and no address is
// shown for a U the store has not recorded. A signed-in answer is judged by the same rule as the device's: an address
// only after exactly one request, which names one id as recipient and refundTo. --local answers the helper with 503
// itself (no network); live, a request goes to the helper as the page sends it. The live quote with an address is the
// mainnet test vault's run (until a vault is named on the page's network, the page asks no quote at all).
// The run records the sha256 of the /app.js SIGN_HOST served, and the deposit run passes only when it is the newest
// release list's pin for SIGN_HOST's /app.js (packages/signpage/releases): so a host still serving an older release,
// whose deposit.quote is refused just the same, fails here.
//   node scripts/live-checks/signpage-postmessage.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/signpage-postmessage.mjs --local [<dir>] [--record <file>]
//     the same probe with no network: Playwright answers SIGN_HOST from a build dir under that build's own _headers
//     (default: packages/signpage built as packages/signpage/scripts/deploy.mjs builds it), as frame.e2e.mjs does
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
import "../net-window.mjs";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readList } from "../../packages/signpage/scripts/check-signpage.mjs";

const KEY = "signpage-postmessage";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const SIGN_URL = "https://sign.confidential.unrealized.trade/";
export const STRANGERS = ["https://example.com", "https://evil.ct.test", "https://app.other.test"];
export const READY_MS = 5_000;
const SETTLE_MS = 1_500;
/** The deposit quote's longest wait: the device's own helper timeout (10 s) and room. */
export const QUOTE_MS = 15_000;
export const HELPER_QUOTE = "https://api.confidential.unrealized.trade/v1/proxy/oneclick/v0/quote";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
/** deposit.quote's answer codes (packages/signpage/src/rules/deposit-quote.ts). */
export const QUOTE_CODES = ["not_allowed", "above_max", "busy", "down", "quote_check_failed", "not_available"];

// ------------------------------------------------------------------------------------------------ the verdict
/** Each parent and the headers it is judged under: APP_HOST as served, every stranger as served and lifted. */
const CASES = [[APP_HOST, ["served"]], ...STRANGERS.map((p) => [p, ["served", "lifted"]])];

/** SIGN_HOST's /app.js pin in the release list `tag` (the newest by default): { release, sha256 }. */
export function releasePin(tag = null) {
  const list = readList(tag);
  const f = list.hosts?.SIGN_HOST?.files?.find((x) => x.path === "/app.js");
  if (!f || !/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) throw new Error(`${list.release}: no /app.js pin for SIGN_HOST`);
  return { release: list.release, sha256: f.sha256 };
}

/** `pin`: the release whose /app.js the deposit run must have been served (the newest list's when not given). */
export function judge(rec, pin = releasePin()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const runs = rec.runs ?? [];
  for (const [parent, kinds] of CASES) {
    for (const headers of kinds) {
      const s = runs.find((r) => r.parent === parent && r.headers === headers);
      const label = `from ${parent === APP_HOST ? "APP_HOST" : parent}${headers === "lifted" ? " with frame-ancestors lifted" : ""}`;
      if (!s) {
        say(false, `${label}: no run`);
        continue;
      }
      if (headers === "served") say(s.loaded === false, `${label}: the frame is ${s.loaded ? "loaded" : "blocked by frame-ancestors"}`);
      else say(s.loaded === true && s.scriptRan === true, `${label}: the frame ${s.loaded ? "loads" : "does not load"} and its script ${s.scriptRan ? "runs" : "does not run"}`);
      const n = (s.messages ?? []).length;
      say(n === 0, `${label}: ${n} message(s) reached the parent${n ? ` (${JSON.stringify(s.messages.map((m) => m.data))})` : ""}, want none`);
    }
  }
  judgeDeposit(rec.deposit, say, pin);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

/** The deposit.quote round trip: one answer; a refusal with a code; an address only after one request to U. */
function judgeDeposit(d, say, pin) {
  if (!d) return say(false, "deposit.quote: no run");
  const got = d.appJs?.sha256 ?? null;
  say(got === pin.sha256, `deposit.quote: SIGN_HOST served /app.js sha256 ${got ?? "(not read)"}, want ${pin.release}'s ${pin.sha256}`);
  say(d.ready === true, `deposit.quote: the shell's ready ${d.ready ? "arrived" : "did not arrive"} in the APP_HOST frame`);
  const answers = (d.log ?? []).filter((m) => m.fromParent && m.origin === new URL(d.signUrl).origin && m.data?.id === d.ids?.quote);
  say(answers.length === 1, `deposit.quote: ${answers.length} answer(s) to its id, want 1`);
  const a = answers[0]?.data;
  if (!a) return;
  const state = (d.log ?? []).find((m) => m.fromParent && m.data?.id === d.ids?.state)?.data;
  const signedIn = state?.ok === true && state.result?.signed_in === true;
  const sent = d.helper ?? [];
  if (a.ok === false) {
    const code = a.error?.code;
    say(QUOTE_CODES.includes(code) && Object.keys(a).sort().join() === "error,id,ok,v", `deposit.quote: refused ${JSON.stringify(code)}, a code and nothing else`);
    if (!signedIn) say(code === "not_allowed", `deposit.quote with no seed stored: ${JSON.stringify(code)}, want not_allowed`);
    if (code === "not_allowed" || code === "above_max") say(sent.length === 0, `deposit.quote refused ${code}: ${sent.length} request(s) to the helper, want none`);
    return;
  }
  say(signedIn, `deposit.quote answered ok ${signedIn ? "signed in" : "with no seed stored: an address for a U the store has not recorded"}`);
  const r = a.result ?? {};
  say(typeof r.deposit_address === "string" && r.deposit_address.length > 0 && r.origin_asset === d.asked?.origin_asset, "deposit.quote: an address, for the asset asked");
  const body = sent.length === 1 ? sent[0].body : null;
  say(sent.length === 1 && /^[0-9a-f]{64}$/.test(body?.recipient ?? "") && body.refundTo === body.recipient, `deposit.quote: ${sent.length} request(s) to the helper, want 1 naming one id as recipient and refundTo`);
}

// ------------------------------------------------------------------------------------------------ the read
// The parent: frames SIGN_HOST and records every message it receives; a second, empty frame of its own origin sends
// the wrong-source probe from its own realm.
const probeHtml = (signUrl) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
const f = document.createElement("iframe");
f.src = ${JSON.stringify(signUrl)};
addEventListener("message", (e) => window.__log.push({ t: performance.now(), origin: e.origin, fromFrame: e.source === f.contentWindow, data: e.data }));
document.body.append(f);
const other = document.createElement("iframe");
document.body.append(other);
window.__sign = f;
window.__other = other;
</script></body>`;

const SEND = (signOrigin) => {
  const id = () => crypto.randomUUID();
  const sent = {
    state: { v: 1, id: id(), type: "state" },
    stateExtra: { v: 1, id: id(), type: "state", extra: true },
    unknown: { v: 1, id: id(), type: "sign.anything" },
    buy: { v: 1, id: id(), type: "buy", chain: "solana", token: "So11111111111111111111111111111111111111112", side: "buy", amount: "1", slippage_bps: 50 },
    badV: { v: 2, id: id(), type: "state" },
    badId: { v: 1, id: "1", type: "state" },
    wrongSource: { v: 1, id: id(), type: "state" },
  };
  const w = window.__sign.contentWindow;
  window.__sentAt = performance.now();
  for (const k of ["state", "stateExtra", "unknown", "buy", "badV", "badId"]) w.postMessage(sent[k], signOrigin);
  w.postMessage(sent.state, signOrigin); // the repeat
  const o = window.__other.contentWindow;
  o.__m = sent.wrongSource;
  o.__w = w;
  o.__o = signOrigin;
  o.eval("__w.postMessage(__m, __o)"); // sent from the other frame's realm, so its source is not the parent
  return sent;
};

const lift = (csp) => csp.split(";").filter((d) => d.trim().split(/\s+/)[0] !== "frame-ancestors").join(";");

/** The headers SIGN_HOST's _headers sets on every path: its one /* rule (the deploy gate refuses any other shape). */
export function headersOf(text) {
  const h = {};
  let all = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      all = line.trim() === "/*";
      continue;
    }
    const kv = /^\s+([^:\s]+):\s*(.*)$/.exec(line);
    if (all && kv) h[kv[1].toLowerCase()] = kv[2];
  }
  return h;
}

/** packages/signpage built as its deploy builds it (deploy.mjs build(): index.html and public/ copied), read as files. */
function build() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-pm-sign-"));
  copyFileSync(path.join(REPO, "packages/signpage/index.html"), path.join(out, "index.html"));
  cpSync(path.join(REPO, "packages/signpage/public"), out, { recursive: true });
  return out;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/** Answers every request to SIGN_HOST from the build in `dir`, under its own _headers, as Pages serves it. */
function serveDir(dir, lifted) {
  const h = headersOf(readFileSync(path.join(dir, "_headers"), "utf8"));
  if (lifted) h["content-security-policy"] = lift(h["content-security-policy"]);
  return (r) => {
    const p = new URL(r.request().url()).pathname;
    const file = path.join(dir, p === "/" ? "index.html" : p);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || p === "/_headers") return r.fulfill({ status: 404, headers: h, body: "" });
    return r.fulfill({ status: 200, headers: { ...h, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }, body: readFileSync(file) });
  };
}

async function run(browser, { parent, headers, signUrl, dir }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  const probe = probeHtml(signUrl);
  await ctx.route((u) => u.origin === parent, (r) => r.fulfill({ status: 200, contentType: "text/html", body: probe }));
  if (dir) await ctx.route((u) => u.origin === signOrigin, serveDir(dir, headers === "lifted"));
  else if (headers === "lifted") {
    await ctx.route(signUrl, async (r) => {
      const res = await r.fetch();
      const h = res.headers();
      if (h["content-security-policy"]) h["content-security-policy"] = lift(h["content-security-policy"]);
      await r.fulfill({ response: res, headers: h });
    });
  }
  const signRequests = [];
  ctx.on("requestfinished", async (req) => {
    if (new URL(req.url()).origin !== signOrigin) return;
    const res = await req.response();
    signRequests.push({ url: req.url(), type: req.resourceType(), status: res?.status() ?? null });
  });
  ctx.on("requestfailed", (req) => {
    if (new URL(req.url()).origin === signOrigin) signRequests.push({ url: req.url(), type: req.resourceType(), failure: req.failure()?.errorText ?? "failed" });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${parent}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__log.some((m) => m.data?.type === "ready"), null, { timeout: READY_MS, polling: 50 }).catch(() => {});
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() === signUrl);
  const loaded = frame !== undefined;
  const frames = page.frames().map((f) => f.url());
  // what the framed page renders: every element in its body (none is right) and the controls among them
  const rendered = loaded
    ? await frame.evaluate(() => ({ elements: document.body ? document.body.querySelectorAll("*").length : -1, controls: [...document.querySelectorAll("button, a, input, select, textarea, form, [data-action], [onclick], [tabindex]")].map((e) => e.outerHTML.slice(0, 120)) })).catch((e) => ({ elements: -1, controls: [`unreadable: ${e.message}`] }))
    : null;
  const sent = await page.evaluate(SEND, signOrigin);
  await page.waitForTimeout(SETTLE_MS);
  const messages = await page.evaluate(() => window.__log);
  const sentAt = await page.evaluate(() => window.__sentAt);
  // the module ran when its script was fetched and the frame logged no CSP or integrity error
  const apiFetched = signRequests.some((r) => r.type === "script" && r.status === 200);
  const scriptRan = loaded && apiFetched && !errors.some((e) => /integrity|Content Security Policy|Trusted Type/i.test(e));
  await ctx.close();
  return { parent, headers, loaded, frames, rendered, sentAt, scriptRan, signRequests, sent, messages, errors };
}

// The APP_HOST frame inside SIGN_HOST's shell: waits for the shell's ready, then asks state and deposit.quote.
const appProbeHtml = (signOrigin) => `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
addEventListener("message", (e) => {
  window.__log.push({ t: performance.now(), origin: e.origin, fromParent: e.source === parent, data: e.data });
  if (e.source !== parent || e.data?.type !== "ready" || window.__ids) return;
  const s = { v: 1, id: crypto.randomUUID(), type: "state" };
  const q = { v: 1, id: crypto.randomUUID(), type: "deposit.quote", origin_asset: ${JSON.stringify(SOL_USDC)}, amount: "25" };
  window.__ids = { state: s.id, quote: q.id };
  window.__asked = { origin_asset: q.origin_asset, amount: q.amount };
  parent.postMessage(s, ${JSON.stringify(signOrigin)});
  parent.postMessage(q, ${JSON.stringify(signOrigin)});
});
</script></body>`;

async function depositRun(browser, { signUrl, dir }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  await ctx.route((u) => u.origin === APP_HOST, (r) => r.fulfill({ status: 200, contentType: "text/html", body: appProbeHtml(signOrigin) }));
  if (dir) {
    await ctx.route((u) => u.origin === signOrigin, serveDir(dir, false));
    // no network: the helper answers "down" here
    await ctx.route((u) => u.origin === new URL(HELPER_QUOTE).origin, (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  }
  const helper = [];
  // the /app.js SIGN_HOST served this page: its sha256 against the release list's pin
  let appJs = null;
  ctx.on("response", async (res) => {
    if (res.url() !== new URL("/app.js", signUrl).href || res.request().resourceType() !== "script") return;
    try {
      appJs = { status: res.status(), sha256: createHash("sha256").update(await res.body()).digest("hex") };
    } catch {}
  });
  ctx.on("request", (req) => {
    if (!req.url().startsWith(HELPER_QUOTE)) return;
    let body = null;
    try {
      body = JSON.parse(req.postData() ?? "null");
    } catch {}
    helper.push({ url: req.url(), method: req.method(), body });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(signUrl, { waitUntil: "load" });
  const app = () => page.frames().find((f) => f.url().startsWith(`${APP_HOST}/`));
  const until = Date.now() + READY_MS + QUOTE_MS;
  let out = { log: [], ids: null, asked: null };
  for (; Date.now() < until; await page.waitForTimeout(100)) {
    const f = app();
    if (!f) continue;
    out = await f.evaluate(() => ({ log: window.__log, ids: window.__ids ?? null, asked: window.__asked ?? null })).catch(() => out);
    if (out.ids && out.log.some((m) => m.data?.id === out.ids.quote)) break;
  }
  await page.waitForTimeout(SETTLE_MS);
  const f = app();
  if (f) out = await f.evaluate(() => ({ log: window.__log, ids: window.__ids ?? null, asked: window.__asked ?? null })).catch(() => out);
  await ctx.close();
  return { signUrl, ready: out.log.some((m) => m.fromParent && m.data?.type === "ready"), ...out, helper, appJs, errors };
}

export async function collect({ browser, signUrl = SIGN_URL, dir, source }) {
  const rec = { url: signUrl, source, at: new Date().toISOString(), browser: browser.version(), runs: [] };
  rec.runs.push(await run(browser, { parent: APP_HOST, headers: "served", signUrl, dir }));
  for (const parent of STRANGERS) for (const headers of ["served", "lifted"]) rec.runs.push(await run(browser, { parent, headers, signUrl, dir }));
  rec.deposit = await depositRun(browser, { signUrl, dir });
  return rec;
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const record = opt("--record");
  const local = args.includes("--local");
  const given = local && opt("--local") && !opt("--local").startsWith("--") ? path.resolve(opt("--local")) : null;
  const dir = local ? (given ?? build()) : null;
  const { chromium } = createRequire(path.join(REPO, "packages/signpage/package.json"))("playwright");
  const browser = await chromium.launch();
  let rec;
  try {
    rec = local
      ? await collect({ browser, dir, source: `local, SIGN_HOST answered from ${given ? given : "packages/signpage's build (deploy.mjs build())"}` })
      : await collect({ browser, signUrl: opt("--url") ?? SIGN_URL, source: "live" });
  } finally {
    await browser.close();
    if (local && !given) rmSync(dir, { recursive: true, force: true });
  }
  const pin = releasePin();
  rec.pin = pin;
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 1)}\n`);
  const r = judge(rec, pin);
  for (const l of r.lines) console.log(l);
  console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chromium ${rec.browser}, ${rec.at})`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  });
}
