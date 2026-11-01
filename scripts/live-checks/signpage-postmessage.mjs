#!/usr/bin/env node
// Live check of card signpage-postmessage: SIGN_HOST answers postMessage only from APP_HOST, in the frozen shapes
// (packages/kit/src/signpage/messages.ts, api 1; wallet.md §7 item 4, S-C1 W:1589-1590). Headless Chromium frames
// SIGN_HOST from a probe page that Playwright serves at each parent origin (no request reaches a real parent host), and
// records every message the parent receives:
//   - from APP_HOST, under SIGN_HOST's headers as served: the frame loads; exactly one `ready` {v: 1, type, release,
//     api: 1} comes from the frame with origin SIGN_HOST; `state` is answered ok with a state of exactly the frozen
//     keys within STATE_MS of being sent (the client counts SIGN_HOST ready only on that answer, BAR-09 A:1107);
//     `state` with an extra field, `state` with v 2, an unknown kind and `buy` are answered {ok: false, error: {code:
//     "not_allowed"}}; a message whose id is no UUID gets no answer; a repeated id gets its first answer again; the same
//     `state` sent from another APP_HOST window (not the frame's parent) gets no answer; nothing else arrives;
//   - from https://example.com, https://evil.ct.test (same-site with the test hosts) and https://app.other.test
//     (cross-site), each twice: under the headers as served, the frame is blocked (frame-ancestors) and nothing
//     arrives; with frame-ancestors lifted from SIGN_HOST's CSP, the frame loads and runs its script, and still nothing
//     arrives: the page's own origin check and targetOrigin are what refuse.
//   node scripts/live-checks/signpage-postmessage.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/signpage-postmessage.mjs --local [<dir>] [--record <file>]
//     the same probe with no network: Playwright answers SIGN_HOST from a build dir under that build's own _headers
//     (default: packages/signpage built as packages/signpage/scripts/deploy.mjs builds it), as frame.e2e.mjs does
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-postmessage";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const APP_HOST = "https://confidential.unrealized.trade";
export const SIGN_URL = "https://sign.confidential.unrealized.trade/";
export const STRANGERS = ["https://example.com", "https://evil.ct.test", "https://app.other.test"];
export const READY_MS = 5_000;
export const STATE_MS = 1_000;
const SETTLE_MS = 1_500;
const STATE_KEYS = ["api", "code_saved", "held", "ops", "orders", "positions", "release", "signed_in", "vault_balance", "wallets"];
const STATE_OPTIONAL = ["signin_failed", "way"];

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (v, keys) => isObj(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const isState = (s) =>
  isObj(s) &&
  STATE_KEYS.every((k) => Object.hasOwn(s, k)) &&
  Object.keys(s).every((k) => STATE_KEYS.includes(k) || STATE_OPTIONAL.includes(k)) &&
  typeof s.release === "string" && s.release.length > 0 && s.api === 1 &&
  typeof s.signed_in === "boolean" && typeof s.code_saved === "boolean" && typeof s.vault_balance === "string" &&
  ["wallets", "positions", "orders", "held", "ops"].every((k) => Array.isArray(s[k]));
const answersTo = (messages, id) => messages.filter((m) => isObj(m.data) && m.data.id === id && Object.hasOwn(m.data, "ok"));
const isNotAllowed = (d, id) => keysAre(d, ["v", "id", "ok", "error"]) && d.v === 1 && d.id === id && d.ok === false && keysAre(d.error, ["code"]) && d.error.code === "not_allowed";

export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const runs = rec.runs ?? [];
  const signOrigin = new URL(SIGN_URL).origin;

  const app = runs.find((r) => r.parent === APP_HOST && r.headers === "served");
  if (!app) say(false, "from APP_HOST: no run");
  else {
    const msgs = app.messages ?? [];
    say(app.loaded === true, `from APP_HOST: the frame ${app.loaded ? "loads" : "does not load"}`);
    const foreign = msgs.filter((m) => m.origin !== signOrigin || !m.fromFrame);
    say(foreign.length === 0, `from APP_HOST: every message comes from the frame at ${signOrigin}${foreign.length ? ` (but ${foreign.length} from ${foreign.map((m) => m.origin).join(", ")})` : ""}`);
    const ready = msgs.filter((m) => isObj(m.data) && m.data.type === "ready");
    const r = ready[0]?.data;
    const readyOk = ready.length === 1 && keysAre(r, ["v", "type", "release", "api"]) && r.v === 1 && r.api === 1 && typeof r.release === "string" && r.release.length > 0;
    say(readyOk && ready[0].t <= READY_MS, `from APP_HOST: ${ready.length === 0 ? "no ready" : `${ready.length} ready ${JSON.stringify(r)}${ready.length === 1 ? ` at ${Math.round(ready[0].t)} ms` : ""}`}, want one {v: 1, type: "ready", release, api: 1} within ${READY_MS} ms`);
    const sent = app.sent ?? {};
    const one = (name) => {
      const a = sent[name] ? answersTo(msgs, sent[name].id) : [];
      return { a, d: a[0]?.data };
    };
    {
      const { a, d } = one("state");
      const ok = sent.state && a.length === 2 && keysAre(d, ["v", "id", "ok", "result"]) && d.v === 1 && d.ok === true && isState(d.result);
      const lag = a[0] && Number.isFinite(app.sentAt) ? a[0].t - app.sentAt : null;
      say(lag !== null && lag <= STATE_MS, `from APP_HOST: the first state answer ${lag === null ? "never came" : `came ${Math.round(lag)} ms after it was sent`}, limit ${STATE_MS} ms`);
      say(ok, `from APP_HOST: state answered ok with the frozen state${a.length !== 2 ? ` (${a.length} answers to its id, want 2: it and its repeat)` : ""}${d && !isState(d.result) ? `, but result ${JSON.stringify(d.result)}` : ""}`);
      say(a.length === 2 && JSON.stringify(a[0].data) === JSON.stringify(a[1].data), "from APP_HOST: a repeated id gets its first answer again");
    }
    for (const name of ["stateExtra", "badV", "unknown", "buy"]) {
      const { a, d } = one(name);
      say(sent[name] && a.length === 1 && isNotAllowed(d, sent[name].id), `from APP_HOST: ${name} (${JSON.stringify(sent[name]?.type)}) ${a.length ? `answered ${JSON.stringify(d)}` : "not answered"}, want not_allowed`);
    }
    for (const name of ["badId", "wrongSource"]) {
      const { a } = one(name);
      say(sent[name] && a.length === 0, `from APP_HOST: ${name} ${a.length ? `answered ${JSON.stringify(a[0].data)}` : "not answered"}, want no answer`);
    }
    const expected = 1 + 2 + 4;
    say(msgs.length === expected, `from APP_HOST: ${msgs.length} messages in all, want ${expected} (ready, two state answers, four refusals)`);
  }

  for (const parent of STRANGERS) {
    for (const headers of ["served", "lifted"]) {
      const s = runs.find((r) => r.parent === parent && r.headers === headers);
      const label = `from ${parent}${headers === "lifted" ? " with frame-ancestors lifted" : ""}`;
      if (!s) {
        say(false, `${label}: no run`);
        continue;
      }
      if (headers === "served") say(s.loaded === false, `${label}: the frame is ${s.loaded ? "loaded" : "blocked"}`);
      else say(s.loaded === true && s.scriptRan === true, `${label}: the frame ${s.loaded ? "loads" : "does not load"} and its script ${s.scriptRan ? "runs" : "does not run"}`);
      const n = (s.messages ?? []).length;
      say(n === 0, `${label}: ${n} message(s) reached the parent${n ? ` (${JSON.stringify(s.messages.map((m) => m.data))})` : ""}, want none`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
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
  const sent = await page.evaluate(SEND, signOrigin);
  await page.waitForTimeout(SETTLE_MS);
  const messages = await page.evaluate(() => window.__log);
  const sentAt = await page.evaluate(() => window.__sentAt);
  // the module ran when its script was fetched and the frame logged no CSP or integrity error
  const apiFetched = signRequests.some((r) => r.type === "script" && r.status === 200);
  const scriptRan = loaded && apiFetched && !errors.some((e) => /integrity|Content Security Policy|Trusted Type/i.test(e));
  await ctx.close();
  return { parent, headers, loaded, frames, sentAt, scriptRan, signRequests, sent, messages, errors };
}

export async function collect({ browser, signUrl = SIGN_URL, dir, source }) {
  const rec = { url: signUrl, source, at: new Date().toISOString(), browser: browser.version(), runs: [] };
  rec.runs.push(await run(browser, { parent: APP_HOST, headers: "served", signUrl, dir }));
  for (const parent of STRANGERS) for (const headers of ["served", "lifted"]) rec.runs.push(await run(browser, { parent, headers, signUrl, dir }));
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
  if (record) writeFileSync(record, `${JSON.stringify(rec, null, 1)}\n`);
  const r = judge(rec);
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
