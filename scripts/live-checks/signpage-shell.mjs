#!/usr/bin/env node
// Live check of card signpage-shell: SIGN_HOST is the top window and frames APP_HOST, so on every engine the framed
// terminal reads the state of SIGN_HOST's own first-party store (research docs/drafts/webkit-frame-storage.md §4).
// On one engine at a time (the Mac's own WebKit through scripts/webkit-harness, Playwright's Chromium or Firefox), with
// a fresh profile:
//   - https://SIGN_HOST/<path>?<query> is the top window and holds one frame, APP_HOST with that same path and query;
//   - the frame gets one `ready` (it loads once) before the stranger step, and its first `state` answer is exactly the
//     signed-out state;
//   - Chromium only (its virtual authenticator, no PRF): Create passkey lands on the backup screen and the frame gets
//     signed in, way passkey, code_saved false; Saved gives code_saved true; Sign out gives signed out;
//   - Recovery code with typed test words (the a8 vector's entropy, all zero: BIP-39's first published vector) signs the
//     shell in, the layer over the frame closes, and the frame gets signed in, way words, code_saved true (typed words are
//     stored saved, words.ts ses.12); Sign out gives signed out. Sign out is pressed in the shell's layer, opened here
//     by the check as the signout kind will open it (card signpage-signin-kinds);
//   - every message the frame gets is ready, a state answer or a state event, each state exact;
//   - the frame cannot be sent to another origin: set to https://example.com, no request for it is made (CSP frame-src);
//   - no request goes to any host but SIGN_HOST and APP_HOST.
// Each event must come within EVENT_MS of its step. The APP_HOST page is this check's own (APP_PAGE): it speaks the
// kit's messages to its parent as app-in-shell's parent mode does, and reports what it gets to the check. A build with
// no shell (main's: SIGN_HOST framed by APP_HOST) is read the old way, so its recorded run shows what that frame reads:
// after the same sign-in, an APP_HOST page framing SIGN_HOST asks its state.
//   node scripts/live-checks/signpage-shell.mjs --engine webkit|chromium|firefox [--site <dir>] [--record <file>]
//     the harness: SIGN_HOST from packages/signpage's committed build (or <dir>) under its own _headers, APP_HOST from
//     APP_PAGE, both on their real names with nothing on the network
//   node scripts/live-checks/signpage-shell.mjs --engine chromium|firefox --live [--record <file>]
//     the deployed SIGN_HOST, with APP_HOST answered by APP_PAGE
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
// No money and no network beyond the two hosts; the account is the published test vector's, thrown away with the profile.
import "../net-window.mjs";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNPAGE_IFRAME_ATTRIBUTES } from "../../packages/kit/src/index.ts";

const KEY = "signpage-shell";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "sign.confidential.unrealized.trade";
export const APP_HOST = "confidential.unrealized.trade";
const SIGN = `https://${SIGN_HOST}`;
const APP = `https://${APP_HOST}`;
const STRANGER = "https://example.com/";
/** The path and query the shell is opened on; the frame must carry exactly these. */
export const START = "/token/solana/So11111111111111111111111111111111111111112?tab=trades&from=shell";
export const ENGINES = ["webkit", "chromium", "firefox"];
export const EVENT_MS = 3_000;
const WAIT_MS = 15_000;
const PROTECT_MS = 500; // the page's activation guard (packages/signpage/src/guard.ts)
const KEYS = ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (v, keys) => isObj(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
export const exactState = (s) =>
  isObj(s) &&
  (sameKeys(s, KEYS) || (s.signed_in === true && sameKeys(s, [...KEYS, "way"]))) &&
  typeof s.release === "string" && s.api === 1 && typeof s.signed_in === "boolean" && typeof s.code_saved === "boolean" &&
  typeof s.vault_balance === "string" && ["wallets", "positions", "orders", "held", "ops"].every((k) => Array.isArray(s[k])) &&
  (!Object.hasOwn(s, "way") || ["passkey", "words", "wallet"].includes(s.way));
const signedOut = (s) =>
  exactState(s) && !Object.hasOwn(s, "way") && s.signed_in === false && s.code_saved === false && s.vault_balance === "0" &&
  ["wallets", "positions", "orders", "held", "ops"].every((k) => s[k].length === 0);
const show = (s) => (isObj(s) ? JSON.stringify({ signed_in: s.signed_in, ...(Object.hasOwn(s, "way") ? { way: s.way } : {}), code_saved: s.code_saved }) : "none");
const isEvent = (d) => isObj(d) && d.v === 1 && d.type === "state" && !Object.hasOwn(d, "id") && sameKeys(d, ["v", "type", "state"]);
const isAnswer = (d) => isObj(d) && d.v === 1 && typeof d.id === "string" && d.ok === true && sameKeys(d, ["v", "id", "ok", "result"]);

/** The first state event the frame got at or after `t` (within the run's clock) that `want` accepts, with its delay. */
function eventAfter(rec, t, want) {
  if (typeof t !== "number") return null;
  const m = rec.messages.find((x) => x.t >= t && isEvent(x.data) && want(x.data.state));
  return m ? { state: m.data.state, ms: m.t - t } : null;
}

/** The verdict on one recorded run: { ok, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const st = rec.steps ?? {};
  const msgs = (rec.messages ?? []).filter((m) => isObj(m));
  rec = { ...rec, messages: msgs };

  const want = `${APP}${START}`;
  say(rec.topology === "shell" && st.open?.frameHref === want,
    `SIGN_HOST is the top window and frames APP_HOST at the same path and query (${rec.topology ?? "none"}${st.open?.frameHref ? `, ${st.open.frameHref}` : ""})`);
  if (rec.topology !== "shell") {
    // a build with no shell: what its APP_HOST-framed SIGN_HOST read after the same sign-in
    const l = st.legacy?.answer;
    say(false, `the framed page reads the signed-in state (no shell: an APP_HOST page framing SIGN_HOST read ${show(l)} after the words signed SIGN_HOST in, ${st.legacy?.top?.state ?? "none"})`);
    return { ok: false, lines };
  }
  // one ready while the frame shows APP_HOST: it loads once in this run. The stranger step comes after: WebKit fires
  // a load on the frame for the navigation its CSP refuses, and the shell then posts ready again to the same page.
  const readies = msgs.filter((m) => isObj(m.data) && m.data.type === "ready" && m.t < (st.stranger?.t ?? Infinity));
  say(readies.length === 1, `the frame gets one ready before the stranger step (${readies.length})`);
  const first = msgs.find((m) => isAnswer(m.data) && m.data.id === st.first?.id)?.data.result;
  say(signedOut(first), `the first state answer is exactly the signed-out state (${show(first)})`);

  if (rec.engine === "chromium") {
    const c = st.created;
    say(c?.top?.state === "backup", `Create passkey with no PRF lands the shell on the backup screen (${c?.top?.state ?? "none"})`);
    const e1 = eventAfter(rec, c?.t, (s) => s.signed_in === true);
    say(!!e1 && e1.ms <= EVENT_MS && e1.state.way === "passkey" && e1.state.code_saved === false,
      `then the frame gets signed in, way passkey, code_saved false (${show(e1?.state)}${e1 ? `, ${e1.ms} ms` : ""})`);
    const e2 = eventAfter(rec, st.saved?.t, (s) => s.signed_in === true && s.code_saved === true);
    say(st.saved?.top?.state === "signed-in" && !!e2 && e2.ms <= EVENT_MS && e2.state.way === "passkey",
      `Saved: the frame gets code_saved true (${st.saved?.top?.state ?? "none"}, ${show(e2?.state)}${e2 ? `, ${e2.ms} ms` : ""})`);
    const e3 = eventAfter(rec, st.passkeyOut?.t, (s) => s.signed_in === false);
    say(st.passkeyOut?.top?.state === "signed-out" && !!e3 && e3.ms <= EVENT_MS && signedOut(e3.state),
      `Sign out: the frame gets exactly the signed-out state (${st.passkeyOut?.top?.state ?? "none"}, ${show(e3?.state)}${e3 ? `, ${e3.ms} ms` : ""})`);
  }
  const w = st.words;
  say(w?.top?.state === "signed-in" && w?.layerHidden === true, `the typed words sign the shell in and its layer closes over the frame (${w?.top?.state ?? "none"}, layer ${w?.layerHidden ? "closed" : "open"})`);
  const e4 = eventAfter(rec, w?.t, (s) => s.signed_in === true);
  say(!!e4 && e4.ms <= EVENT_MS && e4.state.way === "words" && e4.state.code_saved === true,
    `then the frame gets signed in, way words, code_saved true (${show(e4?.state)}${e4 ? `, ${e4.ms} ms` : ""})`);
  const e5 = eventAfter(rec, st.wordsOut?.t, (s) => s.signed_in === false);
  say(st.wordsOut?.top?.state === "signed-out" && !!e5 && e5.ms <= EVENT_MS && signedOut(e5.state),
    `Sign out: the frame gets exactly the signed-out state (${st.wordsOut?.top?.state ?? "none"}, ${show(e5?.state)}${e5 ? `, ${e5.ms} ms` : ""})`);
  const last = msgs.find((m) => isAnswer(m.data) && m.data.id === st.last?.id)?.data.result;
  say(signedOut(last), `a state asked again answers signed out (${show(last)})`);

  const states = msgs.flatMap((m) => (isEvent(m.data) ? [m.data.state] : isAnswer(m.data) ? [m.data.result] : []));
  const other = msgs.filter((m) => !isEvent(m.data) && !isAnswer(m.data) && m.data?.type !== "ready");
  say(states.length >= 4 && states.every(exactState) && other.length === 0,
    `every message is ready, a state answer or a state event, each state exact (${states.length} states, ${other.length} other)`);
  const strayFrame = (rec.requests ?? []).filter((r) => r.host === new URL(STRANGER).host);
  say(st.stranger?.done === true && strayFrame.length === 0,
    `the frame cannot be sent to ${STRANGER} (${st.stranger?.done ? `${strayFrame.length} requests for it` : "not tried"})`);
  const stray = (rec.requests ?? []).filter((r) => r.host !== SIGN_HOST && r.host !== APP_HOST);
  say(stray.length === 0, `no request leaves SIGN_HOST and APP_HOST (${stray.length}${stray.length ? `: ${stray.slice(0, 4).map((r) => r.host).join(", ")}` : ""})`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the pages
// APP_HOST's stand-in: inside the shell it talks to window.parent (app-in-shell's parent mode); top-level, as main's
// terminal does, it frames SIGN_HOST with the kit's attributes and talks to that frame. A message counts only from its
// peer window with SIGN_HOST's origin. Everything it gets, and its own address, go to the check through the harness's
// report channel (WebKit's message handler, Playwright's binding).
const APP_PAGE = `<!doctype html><meta charset="utf-8"><title>APP_HOST</title><body><script>
window.__log = [];
const SIGN = ${JSON.stringify(SIGN)};
const report = (e) => {
  const s = JSON.stringify(e);
  try { window.webkit && window.webkit.messageHandlers.harness.postMessage(s); } catch {}
  try { window.__harnessReport && window.__harnessReport(s); } catch {}
};
const topLevel = window.top === window;
let peer = window.parent;
if (topLevel) {
  const f = document.createElement("iframe");
  for (const [k, v] of Object.entries(${JSON.stringify(SIGNPAGE_IFRAME_ATTRIBUTES)})) f.setAttribute(k, v);
  f.src = SIGN + "/";
  document.body.append(f);
  peer = f.contentWindow;
}
window.addEventListener("message", (m) => {
  if (m.source !== peer || m.origin !== SIGN) return;
  const e = { t: Date.now(), data: m.data };
  window.__log.push(e);
  report({ kind: "message", ...e });
});
window.__ask = () => {
  const id = crypto.randomUUID();
  peer.postMessage({ v: 1, id, type: "state" }, SIGN);
  return id;
};
report({ kind: "loaded", href: location.href, topLevel });
</script></body>`;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };

/** Pages' reading of a build dir: its files under its own _headers (every rule that matches), index.html for any other path. */
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

/** The harness's answer for every request: SIGN_HOST from `site` (null: the network's), APP_HOST from APP_PAGE, else none. */
function serveWith(sign, requests) {
  return (host, pathAndQuery, method = "GET") => {
    requests.push({ host, path: pathAndQuery.split("?")[0], method });
    if (host === SIGN_HOST && sign) return sign(decodeURIComponent(pathAndQuery.split("?")[0]));
    if (host === APP_HOST) return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `frame-ancestors ${SIGN}` }, body: APP_PAGE };
    return null;
  };
}

// ------------------------------------------------------------------------------------------------ the engines
/** Playwright's Chromium or Firefox behind one driver shape (WebKit's is scripts/webkit-harness's). */
async function playwrightDriver(engine, serve, live) {
  const pw = createRequire(path.join(REPO, "packages/signpage/package.json"))("playwright");
  const browser = await pw[engine].launch();
  const ctx = await browser.newContext();
  const reports = [];
  await ctx.exposeBinding("__harnessReport", (src, s) => {
    let host = null;
    try {
      host = new URL(src.frame.url()).host;
    } catch {}
    reports.push({ frame: { host, main: src.frame === src.page.mainFrame() }, data: JSON.parse(s), t: Date.now() });
  });
  await ctx.route("**/*", async (r) => {
    const u = new URL(r.request().url());
    if (live && u.host === SIGN_HOST) return r.continue();
    const a = serve(u.host, u.pathname + u.search, r.request().method());
    if (!a) return r.abort("blockedbyclient");
    return r.fulfill({ status: a.status, headers: a.headers, body: a.body });
  });
  const page = await ctx.newPage();
  const appFrame = () => page.frames().find((f) => f !== page.mainFrame() && (() => { try { return new URL(f.url()).host === APP_HOST; } catch { return false; } })());
  return {
    version: `${engine} ${browser.version()} (Playwright)`,
    page,
    goto: (url) => page.goto(url, { waitUntil: "load" }),
    evaluate: (body) => page.evaluate(`(async () => { ${body} })()`),
    click: (sel) => page.click(sel, { timeout: WAIT_MS }),
    evaluateFrame: async (host, body) => {
      const f = host === APP_HOST ? appFrame() : null;
      if (!f) throw new Error(`no ${host} frame`);
      return f.evaluate(`(async () => { ${body} })()`);
    },
    messages: () => reports,
    close: () => browser.close(),
  };
}

async function driverFor(engine, serve, live) {
  if (engine === "webkit") {
    if (live) throw new Error("--live runs on chromium or firefox; WebKit runs on the harness");
    const { launchWebKit } = await import("../webkit-harness/index.mjs");
    return launchWebKit({ serve: (host, pq, method) => serve(host, pq, method) });
  }
  return playwrightDriver(engine, serve, live);
}

// ------------------------------------------------------------------------------------------------ the read
// BIP-39's first published vector (entropy all zero), the a8 vector's own entropy: typed into the shell only
const A8 = JSON.parse(readFileSync(path.join(REPO, "packages/wallet/test/vectors/a8.json"), "utf8"));
const TEST_WORDS = () => {
  if (!/^0+$/.test(A8.inputs.entropy)) throw new Error("the a8 vector's entropy is no longer all zero");
  return `${"abandon ".repeat(11)}about`;
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(f, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

export async function collect({ engine, site, live }) {
  const requests = [];
  let sign = null;
  let built = null;
  if (!live) {
    const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
    built = site ? null : buildSignpage();
    sign = await siteServer(realpathSync(site ?? built));
  }
  const d = await driverFor(engine, serveWith(sign, requests), live);
  const rec = { engine, source: live ? `live ${SIGN}` : `harness, SIGN_HOST from ${site ?? "packages/signpage's committed build"}`, at: new Date().toISOString(), browser: d.version, topology: null, steps: {}, messages: [], requests, errors: [] };
  const reports = () => d.messages().filter((m) => m.frame?.host === APP_HOST);
  const msgs = () => reports().filter((m) => m.data?.kind === "message").map((m) => ({ t: m.data.t, data: m.data.data }));
  const top = async (not) => {
    const read = () => d.evaluate(`const m = document.getElementById("signin"); const l = document.getElementById("screen"); return { state: m?.dataset.signin ?? null, codeSaved: m?.dataset.codeSaved ?? null, layerHidden: l ? l.hidden : null };`);
    return (await until(async () => { const s = await read(); return s.state && s.state !== "loading" && s.state !== not ? s : null; })) ?? (await read().catch(() => ({ state: null })));
  };
  const ask = async () => {
    const id = await d.evaluateFrame(APP_HOST, "return window.__ask();");
    await until(async () => msgs().some((m) => m.data?.id === id));
    return { id };
  };
  const press = async (action) => {
    await sleep(PROTECT_MS + 300);
    const t = Date.now();
    await d.click(`[data-action="${action}"]`);
    return t;
  };
  const step = async (action, not, before) => {
    if (before) await before();
    const t = await press(action);
    const s = { t, top: await top(not) };
    s.layerHidden = s.top.layerHidden;
    await sleep(EVENT_MS);
    return s;
  };
  const typeWords = async () => {
    await d.click('[data-action="recovery"]');
    await until(() => d.evaluate(`return !!document.querySelector('[data-input="words"]');`));
    await d.evaluate(`document.querySelector('[data-input="words"]').value = ${JSON.stringify(TEST_WORDS())};`);
  };
  // the shell's layer opened as the signout kind will open it (card signpage-signin-kinds)
  const openLayer = () => d.evaluate(`const l = document.getElementById("screen"); if (l) l.hidden = false;`);
  try {
    await d.goto(`${SIGN}${START}`);
    const loaded = await until(async () => reports().find((m) => m.data?.kind === "loaded"), 5_000);
    rec.topology = loaded && loaded.data.topLevel === false ? "shell" : "none";
    rec.steps.open = { frameHref: loaded?.data.href ?? null, top: await top() };
    if (rec.topology !== "shell") {
      // no shell (main's build): sign in top-level, then read what an APP_HOST page framing SIGN_HOST gets
      await typeWords();
      await press("next");
      const t = await top("words");
      await d.goto(`${APP}${START}`);
      await until(async () => reports().some((m) => m.data?.kind === "message" && m.data.data?.type === "ready"));
      const id = await d.evaluate("return window.__ask();");
      await until(async () => msgs().some((m) => m.data?.id === id));
      rec.steps.legacy = { top: t, id, answer: msgs().find((m) => m.data?.id === id)?.data?.result ?? null };
      return rec;
    }
    await until(async () => msgs().some((m) => m.data?.type === "ready"));
    rec.steps.first = await ask();
    if (engine === "chromium" && d.page) {
      const cdp = await d.page.context().newCDPSession(d.page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
      });
      rec.steps.created = await step("create", rec.steps.open.top.state);
      rec.steps.saved = await step("saved", "backup");
      rec.steps.passkeyOut = await step("signout", "signed-in", openLayer);
    }
    await typeWords();
    rec.steps.words = await step("next", "words");
    rec.steps.wordsOut = await step("signout", "signed-in", openLayer);
    rec.steps.last = await ask();
    // the frame sent elsewhere: frame-src must refuse it before any request
    const t = Date.now();
    await d.evaluate(`document.getElementById("app").src = ${JSON.stringify(STRANGER)};`);
    await sleep(2_000);
    rec.steps.stranger = { t, done: true };
  } catch (e) {
    rec.errors.push(String(e?.message ?? e).slice(0, 300));
  } finally {
    rec.messages = msgs();
    // WebKit's proxy refuses any other host before serve() sees it: those count as requests too
    for (const r of d.refused?.() ?? []) requests.push({ host: String(r.target).replace(/:\d+$/, ""), path: null, method: r.kind, refused: true });
    await d.close();
    if (built) rmSync(built, { recursive: true, force: true });
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ the CLI
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const engine = arg("--engine");
    if (!ENGINES.includes(engine)) throw new Error(`--engine must be one of ${ENGINES.join(", ")}`);
    const site = arg("--site");
    const live = process.argv.includes("--live");
    const rec = await collect({ engine, site: site && path.resolve(site), live });
    const out = arg("--record");
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    if (rec.errors.length) console.log(`errors: ${rec.errors.join(" | ")}`);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
