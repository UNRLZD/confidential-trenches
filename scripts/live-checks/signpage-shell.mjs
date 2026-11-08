#!/usr/bin/env node
// Live check of card signpage-shell: SIGN_HOST is the top window and frames APP_HOST, so on every engine the framed
// terminal reads the state of SIGN_HOST's own first-party store (research docs/drafts/webkit-frame-storage.md §4).
// On one engine at a time (the Mac's own WebKit through scripts/webkit-harness, Playwright's Chromium or Firefox), with
// a fresh profile:
//   - https://SIGN_HOST/<path>?<query> is the top window and holds one frame, APP_HOST with that same path and query,
//     sandboxed exactly to scripts, its own origin and popups, with no allow and no referrer; signed out, the layer is
//     hidden and the terminal shows; the frame setting top.location does not move the top window;
//   - the frame gets one `ready` per frame load before the stranger step, and its first `state` answer is exactly the
//     signed-out state;
//   - Chromium only (its virtual authenticator, no PRF): signin.open {way: passkey} is answered pending, the layer opens
//     and the frame leaves the document; Create passkey lands on the backup screen; Saved signs in, the layer closes and
//     the new frame answers signed in, way passkey, code_saved true; a sign out in another tab (the store's "signout"
//     on its channel, then the database deleted) gives the frame exactly signed out;
//   - signin.open {way: words} the same; then the test words (the a8 vector's entropy, all zero: BIP-39's first
//     published vector) are typed with trusted keys while the APP_HOST page calls focus() on its own input every 20 ms:
//     the field is clicked and typed into as soon as it shows (trusted keys on Chromium and Firefox; on WebKit each
//     character goes to the top document's focus, so a frame holding it keeps it from the field; the frame may still be
//     there, inert, for its last
//     FRAME_LEAVE_MS); the shell's field holds all 12 words and the app none (its count of characters only); Continue signs
//     in, the layer closes, and the new frame answers signed in, way words, code_saved true (typed words are stored
//     saved, words.ts ses.12);
//   - nav {path}: answered ok, the top window's address becomes SIGN_HOST with that path and query, no navigation; nav
//     with "//evil.example/x" refused not_allowed, the address unchanged;
//   - reload {}: answered ok, the top window reloads at the app's path: signed in, layer closed, and the new frame,
//     at APP_HOST with that path, answers signed in, way words, code_saved true;
//   - a database from before the status record (the status deleted raw): the frame answers signed in with no way and
//     code_saved false; the shell loads again, and its backfill (main.ts, syncStatus) brings way words and code_saved
//     true to the new frame, in its first answer or a state event within EVENT_MS of it; a sign out in another tab
//     then gives exactly signed out, and a state asked again answers signed out;
//   - every message the frame gets is ready, an answer or a state event, each state exact;
//   - the frame cannot be sent to another origin: set to https://example.com, no request for it is made (CSP frame-src);
//   - no request goes to any host but SIGN_HOST and APP_HOST.
// Each event must come within EVENT_MS of its step. The APP_HOST page is this check's own (APP_PAGE): it speaks the
// kit's messages to its parent as app-in-shell's parent mode does, and reports what it gets to the check. A build with
// no shell (main's: SIGN_HOST framed by APP_HOST) is read the old way, so its recorded run shows what that frame reads:
// after the same sign-in, an APP_HOST page framing SIGN_HOST asks its state.
//   node scripts/live-checks/signpage-shell.mjs --engine webkit|chromium|firefox [--width phone|desktop] [--site <dir>] [--record <file>]
//     at 390 x 844 (phone, the iPhone case) or 1440 x 900 (desktop, the default); the record names the width and the
//     top window's own width as read
//     the harness: SIGN_HOST from packages/signpage's committed build (or <dir>) under its own _headers, APP_HOST from
//     APP_PAGE, both on their real names with nothing on the network
//   node scripts/live-checks/signpage-shell.mjs --engine chromium|firefox --live [--width phone|desktop] [--record <file>]
//     the deployed SIGN_HOST, with APP_HOST answered by APP_PAGE
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
// No money and no network beyond the two hosts; the account is the published test vector's, thrown away with the profile.
import "../net-window.mjs";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNPAGE_IFRAME_ATTRIBUTES, SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { kitTakesState } from "../signpage-state.mjs";
import { named } from "./record-names.mjs";

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
export const WIDTHS = { phone: { width: 390, height: 844, dpr: 2 }, desktop: { width: 1440, height: 900, dpr: 1 } };
export const EVENT_MS = 3_000;
/** The frame's sandbox, exactly (packages/signpage/src/shell.ts FRAME_SANDBOX). */
const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
/** Where the app says it is (nav), and a nav that names another host. */
export const NAV_PATH = "/token/base/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913?tab=holders";
const EVIL_NAV = "//evil.example/x";
const WAIT_MS = 15_000;
const PROTECT_MS = 500; // the page's activation guard (packages/signpage/src/guard.ts)
const KEYS = ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (v, keys) => isObj(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
// A state is exact when the kit's own client takes it (scripts/signpage-state.mjs: the kit's state schema, never a
// hand copy of its keys) and, signed out, it holds exactly the signed-out keys: no way and no pools (packages/signpage/
// src/pools.ts withPools adds pools to a signed-in state only)
export const exactState = (s) => isObj(s) && kitTakesState(s) && (s.signed_in === true || sameKeys(s, KEYS));
const signedOut = (s) =>
  exactState(s) && sameKeys(s, KEYS) && s.signed_in === false && s.code_saved === false && s.vault_balance === "0" &&
  ["wallets", "positions", "orders", "held", "ops"].every((k) => s[k].length === 0);
const show = (s) =>
  isObj(s)
    ? JSON.stringify({ signed_in: s.signed_in, ...(Object.hasOwn(s, "way") ? { way: s.way } : {}), code_saved: s.code_saved, ...(Object.hasOwn(s, "pools") ? { pools: Array.isArray(s.pools) ? s.pools.length : s.pools } : {}) })
    : "none";
const isEvent = (d) => isObj(d) && d.v === 1 && d.type === "state" && !Object.hasOwn(d, "id") && sameKeys(d, ["v", "type", "state"]);
const isAnswer = (d) => isObj(d) && d.v === 1 && typeof d.id === "string" && d.ok === true && sameKeys(d, ["v", "id", "ok", "result"]);
const isRefusal = (d) => isObj(d) && d.v === 1 && typeof d.id === "string" && d.ok === false && sameKeys(d, ["v", "id", "ok", "error"]);

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
  const answer = (id) => msgs.find((m) => isObj(m.data) && typeof id === "string" && m.data.id === id && Object.hasOwn(m.data, "ok"));
  const result = (id) => {
    const a = answer(id)?.data;
    return a && a.ok === true ? a.result : undefined;
  };
  const refused = (id) => {
    const a = answer(id)?.data;
    return !!a && a.ok === false && sameKeys(a, ["v", "id", "ok", "error"]) && sameKeys(a.error, ["code"]) && a.error.code === "not_allowed";
  };
  const pending = (id) => sameKeys(result(id), ["pending"]) && result(id).pending === true;
  const full = (way) => (s) => exactState(s) && s.signed_in === true && s.way === way && s.code_saved === true;

  const v = rec.view ?? {};
  const size = isObj(v) && WIDTHS[v.name];
  say(!!size && v.width === size.width && v.height === size.height && v.inner === size.width,
    `the view is ${size ? `${v.name} ${size.width} x ${size.height}` : "a known width"} (the top window is ${v.inner ?? "?"} px wide)`);
  const want = `${APP}${START}`;
  say(rec.topology === "shell" && st.open?.frameHref === want,
    `SIGN_HOST is the top window and frames APP_HOST at the same path and query (${rec.topology ?? "none"}${st.open?.frameHref ? `, ${st.open.frameHref}` : ""})`);
  if (rec.topology !== "shell") {
    // a build with no shell: what its APP_HOST-framed SIGN_HOST read after the same sign-in
    const l = st.legacy?.answer;
    say(false, `the framed page reads the signed-in state (no shell: an APP_HOST page framing SIGN_HOST read ${show(l)} after the words signed SIGN_HOST in, ${st.legacy?.top?.state ?? "none"})`);
    return { ok: false, lines };
  }
  const o = st.open ?? {};
  say(o.top?.state === "signed-out" && o.top?.layerHidden === true && o.top?.frames === 1,
    `signed out, the layer is hidden and the terminal shows (${o.top?.state ?? "none"}, layer ${o.top?.layerHidden ? "hidden" : "shown"}, ${o.top?.frames ?? "?"} frame)`);
  const a = o.attrs ?? {};
  say(a.sandbox === SANDBOX && a.allow === null && a.referrerpolicy === "no-referrer",
    `the frame's sandbox is exactly "${SANDBOX}", with no allow and no referrer (${JSON.stringify(a)})`);
  say(typeof st.topNav?.href === "string" && st.topNav.href === `${SIGN}${START}` && st.topNav.tried === true,
    `the frame cannot move the top window (top.location set to ${STRANGER}: the top stays at ${st.topNav?.href ?? "none"})`);

  // one ready per load of the frame: the open, each close of the layer (a new frame), the reload and the backfill.
  // The stranger step comes after: WebKit fires a load on the frame for the navigation its CSP refuses.
  const loads = [-Infinity, ...(rec.engine === "chromium" ? [st.saved?.t] : []), st.words?.t, st.reload?.t, st.backfill?.t, st.stranger?.t ?? Infinity].map((t) => t ?? Infinity);
  const perLoad = loads.slice(0, -1).map((t, i) => msgs.filter((m) => isObj(m.data) && m.data.type === "ready" && m.t >= t && m.t < loads[i + 1]).length);
  say(perLoad.every((n) => n === 1), `the frame gets one ready per frame load before the stranger step (${perLoad.join(", ")})`);
  say(signedOut(result(st.first?.id)), `the first state answer is exactly the signed-out state (${show(result(st.first?.id))})`);

  const opened = (s, label) =>
    say(pending(s?.openId) && s?.layer?.layerHidden === false && s?.layer?.frames === 0,
      `signin.open ${label}: answered pending, the layer opens and the frame leaves the document (${answer(s?.openId) ? JSON.stringify(answer(s.openId).data.ok ? result(s.openId) : answer(s.openId).data.error) : "no answer"}, layer ${s?.layer?.layerHidden === false ? "open" : "closed"}, ${s?.layer?.frames ?? "?"} frames)`);
  const signedOutEvent = (s, label) => {
    const e = eventAfter(rec, s?.t, (x) => x.signed_in === false);
    say(s?.top?.state === "signed-out" && !!e && e.ms <= EVENT_MS && signedOut(e.state),
      `${label}: the frame gets exactly the signed-out state (${s?.top?.state ?? "none"}, ${show(e?.state)}${e ? `, ${e.ms} ms` : ""})`);
  };
  if (rec.engine === "chromium") {
    opened(st.passkeyIn, "passkey");
    say(st.created?.top?.state === "backup", `Create passkey with no PRF lands the shell on the backup screen (${st.created?.top?.state ?? "none"})`);
    const s = st.saved;
    say(s?.top?.state === "signed-in" && s?.top?.layerHidden === true && full("passkey")(result(s?.id)),
      `Saved: the layer closes and the new frame answers signed in, way passkey, code_saved true (${s?.top?.state ?? "none"}, layer ${s?.top?.layerHidden ? "closed" : "open"}, ${show(result(s?.id))})`);
    signedOutEvent(st.passkeyOut, "Sign out in another tab");
  }
  const w = st.words;
  opened(st.wordsIn, "words");
  say(st.wordsIn?.typed?.shellHasWords === true && st.wordsIn?.typed?.appChars === 0,
    `the 12 words typed while the app calls focus() every 20 ms: the shell holds all of them, the app none (shell ${st.wordsIn?.typed?.shellHasWords ? "all 12" : "not all"}, app ${st.wordsIn?.typed?.appChars ?? "?"} characters)`);
  say(w?.top?.state === "signed-in" && w?.top?.layerHidden === true && full("words")(result(w?.id)),
    `the typed words sign the shell in, the layer closes and the new frame answers signed in, way words, code_saved true (${w?.top?.state ?? "none"}, layer ${w?.top?.layerHidden ? "closed" : "open"}, ${show(result(w?.id))})`);

  const n = st.nav ?? {};
  say(sameKeys(result(n.okId), []) && n.after === `${SIGN}${NAV_PATH}` && n.frames === 1,
    `nav ${NAV_PATH}: answered ok, the top window's address follows with no navigation (${n.after ?? "none"}, ${n.frames ?? "?"} frame)`);
  say(refused(n.evilId) && n.afterEvil === `${SIGN}${NAV_PATH}`, `nav ${EVIL_NAV}: refused not_allowed, the address unchanged (${n.afterEvil ?? "none"})`);
  const r = st.reload ?? {};
  say(sameKeys(result(r.reloadId), []) && r.frameHref === `${APP}${NAV_PATH}` && r.top?.state === "signed-in" && r.top?.layerHidden === true && full("words")(result(r.id)),
    `reload: answered ok, the top window reloads at the app's path, signed in with its layer closed, and the new frame answers signed in, way words, code_saved true (${r.frameHref ?? "none"}, ${r.top?.state ?? "none"}, ${show(result(r.id))})`);
  const gone = result(st.statusGone?.id);
  say(exactState(gone) && gone.signed_in === true && !Object.hasOwn(gone, "way") && gone.code_saved === false,
    `with the status deleted raw the frame answers signed in, no way, code_saved false (${show(gone)})`);
  const b = answer(st.backfill?.id);
  const bOk = !!b && b.data.ok === true && full("words")(b.data.result);
  const be = b && !bOk ? eventAfter(rec, b.t, full("words")) : null;
  say(st.backfill?.top?.state === "signed-in" && !!b && (bOk || (!!be && be.ms <= EVENT_MS)),
    `the shell's reload backfills the status: the new frame gets signed in, way words, code_saved true (${st.backfill?.top?.state ?? "none"}, ${b ? (bOk ? `its first answer ${show(b.data.result)}` : `answer ${show(b.data.result)}, then ${be ? `${show(be.state)} ${be.ms} ms later` : "no event"}`) : "no answer"})`);
  signedOutEvent(st.wordsOut, "Sign out in another tab");
  say(signedOut(result(st.last?.id)), `a state asked again answers signed out (${show(result(st.last?.id))})`);

  // a state is an event's, or an answer's whose result says signed_in (nav, reload and signin.open answer others)
  const states = msgs.flatMap((m) => (isEvent(m.data) ? [m.data.state] : isAnswer(m.data) && isObj(m.data.result) && Object.hasOwn(m.data.result, "signed_in") ? [m.data.result] : []));
  const other = msgs.filter((m) => !isEvent(m.data) && !isAnswer(m.data) && !isRefusal(m.data) && m.data?.type !== "ready");
  say(states.length >= 4 && states.every(exactState) && other.length === 0,
    `every message is ready, an answer or a state event, each state exact (${states.length} states, ${other.length} other)`);
  const strayFrame = (rec.requests ?? []).filter((x) => x.host === new URL(STRANGER).host);
  say(st.stranger?.done === true && strayFrame.length === 0,
    `the frame cannot be sent to ${STRANGER} (${st.stranger?.done ? `${strayFrame.length} requests for it` : "not tried"})`);
  const stray = (rec.requests ?? []).filter((x) => x.host !== SIGN_HOST && x.host !== APP_HOST);
  say(stray.length === 0, `no request leaves SIGN_HOST and APP_HOST (${stray.length}${stray.length ? `: ${stray.slice(0, 4).map((x) => x.host).join(", ")}` : ""})`);
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
window.__send = (type, params = {}) => {
  const id = crypto.randomUUID();
  // the kit's hello first, as the kit's client sends it (card kit-frame-version): an app that names none is kit-v1.4
  peer.postMessage(${JSON.stringify({ v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION })}, SIGN);
  peer.postMessage({ v: 1, id, type, ...params }, SIGN);
  return id;
};
window.__ask = () => window.__send("state");
// a broken-in app: it takes the keyboard's focus back every 20 ms, and reports how many characters reached it (the
// count only, never the characters)
window.__steal = () => {
  const steal = document.createElement("input");
  steal.autocomplete = "off";
  document.body.append(steal);
  steal.addEventListener("input", () => report({ kind: "stolen", n: steal.value.length }));
  return setInterval(() => steal.focus(), 20);
};
// and it tries to move the top window
window.__topNav = (url) => {
  try { window.top.location.href = url; } catch {}
  try { window.top.location.assign(url); } catch {}
  return true;
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
async function playwrightDriver(engine, serve, live, size) {
  const browser = await launchBrowser(engine);
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr });
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
    version: browserLabel(browser),
    page,
    goto: (url) => page.goto(url, { waitUntil: "load" }),
    evaluate: (body) => page.evaluate(`(async () => { ${body} })()`),
    click: (sel) => page.click(sel, { timeout: WAIT_MS }),
    type: (text) => page.keyboard.type(text, { delay: 30 }),
    evaluateFrame: async (host, body) => {
      const f = host === APP_HOST ? appFrame() : null;
      if (!f) throw new Error(`no ${host} frame`);
      return f.evaluate(`(async () => { ${body} })()`);
    },
    messages: () => reports,
    close: () => browser.close(),
  };
}

async function driverFor(engine, serve, live, size) {
  if (engine === "webkit") {
    if (live) throw new Error("--live runs on chromium or firefox; WebKit runs on the harness");
    const { launchWebKit } = await import("../webkit-harness/index.mjs");
    const d = await launchWebKit({ serve: (host, pq, method) => serve(host, pq, method), width: size.width, height: size.height });
    // typing: the driver's native keyDown/keyUp per character, 30 ms apart, to whatever holds the page's focus
    return d;
  }
  return playwrightDriver(engine, serve, live, size);
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

export async function collect({ engine, site, live, width = "desktop" }) {
  const size = WIDTHS[width];
  if (!size) throw new Error(`--width must be one of ${Object.keys(WIDTHS).join(", ")}`);
  const requests = [];
  let sign = null;
  let built = null;
  if (!live) {
    const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
    built = site ? null : buildSignpage();
    sign = await siteServer(realpathSync(site ?? built));
  }
  const d = await driverFor(engine, serveWith(sign, requests), live, size);
  const rec = { engine, view: { name: width, width: size.width, height: size.height, inner: null }, source: live ? `live ${SIGN}` : `harness, SIGN_HOST from ${site ? named(site) : "packages/signpage's committed build"}`, at: new Date().toISOString(), browser: d.version, topology: null, steps: {}, messages: [], requests, errors: [] };
  const reports = () => d.messages().filter((m) => m.frame?.host === APP_HOST);
  const msgs = () => reports().filter((m) => m.data?.kind === "message").map((m) => ({ t: m.data.t, data: m.data.data }));
  const top = async (not) => {
    const read = () => d.evaluate(`const m = document.getElementById("signin"); const l = document.getElementById("screen"); return { state: m?.dataset.signin ?? null, codeSaved: m?.dataset.codeSaved ?? null, layerHidden: l ? l.hidden : null, frames: document.querySelectorAll("iframe").length, href: location.href };`);
    return (await until(async () => { const s = await read(); return s.state && s.state !== "loading" && s.state !== not ? s : null; })) ?? (await read().catch(() => ({ state: null })));
  };
  const answered = (id) => until(async () => msgs().some((m) => m.data?.id === id));
  const send = async (type, params = {}) => {
    const id = await d.evaluateFrame(APP_HOST, `return window.__send(${JSON.stringify(type)}, ${JSON.stringify(params)});`);
    await answered(id);
    return id;
  };
  const ask = async () => ({ id: await send("state") });
  const readyAfter = (t) => until(async () => msgs().some((m) => m.t >= t && m.data?.type === "ready"));
  // the layer closed on signed in: a new frame, its ready, then it asks
  const newFrameAsks = async (s) => {
    await readyAfter(s.t);
    s.top = await top("loading");
    s.id = (await ask()).id;
    return s;
  };
  const press = async (action) => {
    await sleep(PROTECT_MS + 300);
    const t = Date.now();
    await d.click(`[data-action="${action}"]`);
    return t;
  };
  const step = async (action, not) => {
    const t = await press(action);
    const s = { t, top: await top(not) };
    await sleep(EVENT_MS);
    return s;
  };
  // the app asks for the sign-in: the answer, then the layer open over no frame
  const signinOpen = async (way) => {
    const openId = await send("signin.open", { return_key: "deposit", way });
    const layer = await until(async () => { const l = await top("loading"); return l.layerHidden === false && l.frames === 0 ? l : null; }, 3_000) ?? (await top("loading"));
    return { openId, layer };
  };
  // another tab signs out (the store's own sign out: "signout" on its channel, then the database deleted)
  const signOutElsewhere = async () => {
    const t = Date.now();
    await d.evaluate(`const c = new BroadcastChannel("ct-wallet"); c.postMessage({ kind: "signout" }); c.close();
      await Promise.race([new Promise((ok, no) => { const r = indexedDB.deleteDatabase("ct-wallet"); r.onsuccess = () => ok(); r.onerror = () => no(r.error); }), new Promise((ok) => setTimeout(ok, 3000))]);`);
    const s = { t, top: await top("signed-in") };
    await sleep(EVENT_MS);
    return s;
  };
  try {
    await d.goto(`${SIGN}${START}`);
    const loaded = await until(async () => reports().find((m) => m.data?.kind === "loaded"), 5_000);
    rec.topology = loaded && loaded.data.topLevel === false ? "shell" : "none";
    rec.steps.open = { frameHref: loaded?.data.href ?? null, top: await top() };
    rec.view.inner = await d.evaluate("return window.innerWidth;");
    if (rec.topology !== "shell") {
      // no shell (main's build): sign in top-level, then read what an APP_HOST page framing SIGN_HOST gets
      await d.click('[data-action="recovery"]');
      await until(() => d.evaluate(`return !!document.querySelector('[data-input="words"]');`));
      await d.evaluate(`document.querySelector('[data-input="words"]').value = ${JSON.stringify(TEST_WORDS())};`);
      await press("next");
      const t = await top("words");
      await d.goto(`${APP}${START}`);
      await until(async () => reports().some((m) => m.data?.kind === "message" && m.data.data?.type === "ready"));
      const id = await d.evaluate("return window.__ask();");
      await until(async () => msgs().some((m) => m.data?.id === id));
      rec.steps.legacy = { top: t, id, answer: msgs().find((m) => m.data?.id === id)?.data?.result ?? null };
      return rec;
    }
    rec.steps.open.attrs = await d.evaluate(`const f = document.getElementById("app"); return f ? { sandbox: f.getAttribute("sandbox"), allow: f.getAttribute("allow"), referrerpolicy: f.getAttribute("referrerpolicy") } : null;`);
    await readyAfter(0);
    rec.steps.first = await ask();
    // the frame tries to move the top window
    await d.evaluateFrame(APP_HOST, `return window.__topNav(${JSON.stringify(STRANGER)});`).catch(() => {});
    await sleep(1_000);
    rec.steps.topNav = { tried: true, href: (await top()).href ?? null };
    if (engine === "chromium" && d.page) {
      const cdp = await d.page.context().newCDPSession(d.page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
      });
      rec.steps.passkeyIn = await signinOpen("passkey");
      rec.steps.created = await step("create", "signed-out");
      rec.steps.saved = await newFrameAsks(await step("saved", "backup"));
      rec.steps.passkeyOut = await signOutElsewhere();
    }
    // the words, typed by trusted keys while the app takes the focus back every 20 ms
    await d.evaluateFrame(APP_HOST, "window.__steal(); return true;");
    // the field clicked and typed into as soon as it shows, inside the frame's last FRAME_LEAVE_MS (it is inert then)
    const wordsOpenId = await send("signin.open", { return_key: "deposit", way: "words" });
    rec.steps.wordsIn = { openId: wordsOpenId };
    if (!(await until(() => d.evaluate(`return !!document.querySelector('[data-input="words"]');`), 3_000))) {
      // a build whose layer shows signed out and refuses signin.open (before the review's fix): its own way to the words
      await d.click('[data-action="recovery"]');
      await until(() => d.evaluate(`return !!document.querySelector('[data-input="words"]');`));
    }
    rec.steps.wordsIn.clickedWithFrames = (await top("loading")).frames;
    await d.click('[data-input="words"]');
    await d.type(TEST_WORDS());
    await sleep(300);
    rec.steps.wordsIn.layer = await top("loading");
    const stolen = reports().filter((m) => m.data?.kind === "stolen").map((m) => m.data.n);
    rec.steps.wordsIn.typed = {
      shellHasWords: await d.evaluate(`return document.querySelector('[data-input="words"]')?.value === ${JSON.stringify(TEST_WORDS())};`),
      appChars: stolen.length ? Math.max(...stolen) : 0,
    };
    rec.steps.words = await newFrameAsks(await step("next", "words"));
    // nav: the address follows the app; another host refused
    const navT = Date.now();
    const okId = await send("nav", { path: NAV_PATH });
    const after = (await top()).href;
    const evilId = await send("nav", { path: EVIL_NAV });
    const afterEvil = (await top()).href;
    rec.steps.nav = { t: navT, okId, evilId, after, afterEvil, frames: (await top()).frames };
    // reload: the top window reloads at the app's path; the new frame there reads the stored sign-in
    const rt = Date.now();
    const reloadId = await d.evaluateFrame(APP_HOST, `return window.__send("reload");`);
    await readyAfter(rt);
    const href = [...reports()].reverse().find((m) => m.data?.kind === "loaded" && m.t >= rt)?.data.href ?? null;
    rec.steps.reload = { t: rt, reloadId, frameHref: href, top: await top("loading"), id: (await ask()).id };
    // a database from before the status record: the status deleted raw, then the shell loads again (its backfill)
    await d.evaluate(`await new Promise((ok, no) => { const r = indexedDB.open("ct-wallet"); r.onsuccess = () => { const tx = r.result.transaction("meta", "readwrite"); tx.objectStore("meta").delete("status"); tx.oncomplete = () => (r.result.close(), ok()); tx.onerror = () => no(tx.error); }; r.onerror = () => no(r.error); });`);
    rec.steps.statusGone = await ask();
    const bt = Date.now();
    await d.goto(`${SIGN}${NAV_PATH}`);
    rec.steps.backfill = await newFrameAsks({ t: bt });
    await sleep(EVENT_MS);
    rec.steps.wordsOut = await signOutElsewhere();
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
    const rec = await collect({ engine, site: site && path.resolve(site), live, width: arg("--width") ?? "desktop" });
    const out = arg("--record");
    if (out) writeFileSync(out, `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    if (rec.errors.length) console.log(`errors: ${rec.errors.join(" | ")}`);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, ${rec.browser}, ${rec.view.name} ${rec.view.width} x ${rec.view.height}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.stack ?? e}`);
    process.exit(2);
  }
}
