#!/usr/bin/env node
// Live check of card signpage-postmessage: SIGN_HOST answers postMessage only from APP_HOST, in the frozen shapes
// (packages/kit/src/signpage/messages.ts, api 1; wallet.md §7 item 4, S-C1 W:1589-1590). Headless Chromium frames
// SIGN_HOST from a probe page that Playwright serves at each parent origin (no request reaches a real parent host), and
// records every message the parent receives:
//   - from APP_HOST, under SIGN_HOST's headers as served: the frame loads; exactly one `ready` {v: 1, type, release,
//     api: 1} comes from the frame with origin SIGN_HOST; `state` is answered ok with a state of exactly the frozen
//     keys; `state` with an extra field, an unknown kind and `buy` are answered {ok: false, error: {code:
//     "not_allowed"}}; v 2 and a message with no id get no answer; a repeated id gets its first answer again; the same
//     `state` sent from another APP_HOST window (not the frame's parent) gets no answer; nothing else arrives;
//   - from https://example.com, https://evil.ct.test (same-site with the test hosts) and https://app.other.test
//     (cross-site), each twice: under the headers as served, the frame is blocked (frame-ancestors) and nothing
//     arrives; with frame-ancestors lifted from SIGN_HOST's CSP, the frame loads and runs its script, and still nothing
//     arrives: the page's own origin check and targetOrigin are what refuse.
//   node scripts/live-checks/signpage-postmessage.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/signpage-postmessage.mjs --harness [--sign-root <dir>] [--record <file>]
//     the same probe on the app's browser harness (apps/terminal/test/harness) with the real names mapped to it:
//     SIGN_HOST serves packages/signpage's build as its deploy makes it, under its own _headers (or <dir>, a build)
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
      say(ok, `from APP_HOST: state answered ok with the frozen state${a.length !== 2 ? ` (${a.length} answers to its id, want 2: it and its repeat)` : ""}${d && !isState(d.result) ? `, but result ${JSON.stringify(d.result)}` : ""}`);
      say(a.length === 2 && JSON.stringify(a[0].data) === JSON.stringify(a[1].data), "from APP_HOST: a repeated id gets its first answer again");
    }
    for (const name of ["stateExtra", "unknown", "buy"]) {
      const { a, d } = one(name);
      say(sent[name] && a.length === 1 && isNotAllowed(d, sent[name].id), `from APP_HOST: ${name} (${JSON.stringify(sent[name]?.type)}) ${a.length ? `answered ${JSON.stringify(d)}` : "not answered"}, want not_allowed`);
    }
    for (const name of ["badV", "badId", "wrongSource"]) {
      const { a } = one(name);
      say(sent[name] && a.length === 0, `from APP_HOST: ${name} ${a.length ? `answered ${JSON.stringify(a[0].data)}` : "not answered"}, want no answer`);
    }
    const expected = 1 + 2 + 3;
    say(msgs.length === expected, `from APP_HOST: ${msgs.length} messages in all, want ${expected} (ready, two state answers, three refusals)`);
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

async function run(browser, { parent, headers, signUrl }) {
  const signOrigin = new URL(signUrl).origin;
  const ctx = await browser.newContext();
  const probe = probeHtml(signUrl);
  await ctx.route((u) => u.origin === parent, (r) => r.fulfill({ status: 200, contentType: "text/html", body: probe }));
  if (headers === "lifted") {
    await ctx.route(signUrl, async (r) => {
      const res = await r.fetch();
      const h = res.headers();
      if (h["content-security-policy"]) h["content-security-policy"] = lift(h["content-security-policy"]);
      await r.fulfill({ response: res, headers: h });
    });
  }
  let apiFetched = false;
  ctx.on("requestfinished", async (req) => {
    const res = await req.response();
    if (new URL(req.url()).origin === signOrigin && req.resourceType() === "script" && res?.ok()) apiFetched = true;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${parent}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__log.some((m) => m.data?.type === "ready"), null, { timeout: READY_MS, polling: 50 }).catch(() => {});
  const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() === signUrl);
  const loaded = frame !== undefined;
  const sent = await page.evaluate(SEND, signOrigin);
  await page.waitForTimeout(SETTLE_MS);
  const messages = await page.evaluate(() => window.__log);
  // the module ran when its script was fetched and the frame logged no CSP or integrity error
  const scriptRan = loaded && apiFetched && !errors.some((e) => /integrity|Content Security Policy|Trusted Type/i.test(e));
  await ctx.close();
  return { parent, headers, loaded, scriptRan, sent, messages, errors };
}

export async function collect({ browser, signUrl = SIGN_URL, source }) {
  const rec = { url: signUrl, source, at: new Date().toISOString(), browser: browser.version(), runs: [] };
  rec.runs.push(await run(browser, { parent: APP_HOST, headers: "served", signUrl }));
  for (const parent of STRANGERS) for (const headers of ["served", "lifted"]) rec.runs.push(await run(browser, { parent, headers, signUrl }));
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
  let rec;
  if (args.includes("--harness")) {
    const { startHarness, HOSTS } = await import("../../apps/terminal/test/harness/harness.mjs");
    const stub = mkdtempSync(path.join(tmpdir(), "ct-pm-app-"));
    writeFileSync(path.join(stub, "index.html"), "<!doctype html>\n");
    const signRoot = opt("--sign-root");
    const h = await startHarness({
      realNames: true,
      edit: (sites) => {
        sites[HOSTS.app] = { root: stub }; // every parent is the probe, served by Playwright's route
        if (signRoot) sites[HOSTS.sign] = { root: path.resolve(signRoot) };
      },
    });
    try {
      rec = await collect({ browser: h.browser, source: `harness, SIGN_HOST ${signRoot ? `from ${signRoot}` : "from packages/signpage's build"}` });
    } finally {
      await h.close();
      rmSync(stub, { recursive: true, force: true });
    }
  } else {
    const { chromium } = createRequire(path.join(REPO, "packages/signpage/package.json"))("playwright");
    const browser = await chromium.launch();
    try {
      rec = await collect({ browser, signUrl: opt("--url") ?? SIGN_URL, source: "live" });
    } finally {
      await browser.close();
    }
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
