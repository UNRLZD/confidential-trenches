#!/usr/bin/env node
// Live check of card signpage-frame-state: the signing page's frame tells APP_HOST the truth from SIGN_HOST's wallet
// store (packages/signpage/src/state.ts; the shapes are packages/kit/src/signpage/messages.ts, api 1). In headless
// Chromium, one browser profile holds two tabs, as a user's browser does: an APP_HOST page that frames SIGN_HOST and
// records every message the frame posts, and SIGN_HOST top-level, where the user signs in and out. The top-level tab
// signs in with a CDP virtual authenticator that has no PRF (Create passkey makes a random seed and lands on the
// backup screen), taps Saved, then Sign out. The check reads:
//   - the frame's `ready`, then its first `state` answer: signed out, exact keys (a fresh profile holds no seed);
//   - after Create passkey (the top tab on the backup screen): a `state` event with signed_in true, way "passkey",
//     code_saved false;
//   - after Saved (the top tab signed in, code_saved true): a `state` event with code_saved true;
//   - after Sign out (the top tab signed out): a `state` event with signed_in false, exactly the signed-out state;
//   - a `state` asked again: signed out;
//   - every state (answer or event) with exactly the frozen keys (`way` only while signed in), no other message kind.
// Each event must come within EVENT_MS of the top tab's step. The ops a signing kind writes have no writer on SIGN_HOST
// yet, so they are checked by packages/signpage/test/state.test.ts, not here. No money, no network beyond SIGN_HOST:
// the passkey is the virtual authenticator's and the account is thrown away with the profile.
//   node scripts/live-checks/signpage-frame-state.mjs [--url <SIGN_HOST url>] [--record <file>]
//   node scripts/live-checks/signpage-frame-state.mjs --harness [--site <dir>] [--record <file>]
//     the same steps on the app's browser harness (apps/terminal/test/harness) with SIGN_HOST's and APP_HOST's real
//     names mapped to it, serving packages/signpage's committed build (or <dir>) under its own _headers
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
import "../net-window.mjs";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-frame-state";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "sign.confidential.unrealized.trade";
export const APP_HOST = "confidential.unrealized.trade";
const SIGN_URL = `https://${SIGN_HOST}/`;
const APP_URL = `https://${APP_HOST}/`;
export const EVENT_MS = 3_000;
const WAIT_MS = 15_000;
const PROTECT_MS = 500; // the page's activation guard (packages/signpage/src/guard.ts)
const KEYS = ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (v, keys) => isObj(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
/** A state of exactly the frozen keys: `way` present exactly when signed in, nothing else, the types right. */
export const exactState = (s) =>
  isObj(s) &&
  sameKeys(s, s.signed_in === true ? [...KEYS, "way"] : KEYS) &&
  typeof s.release === "string" && s.api === 1 && typeof s.signed_in === "boolean" && typeof s.code_saved === "boolean" &&
  typeof s.vault_balance === "string" && ["wallets", "positions", "orders", "held", "ops"].every((k) => Array.isArray(s[k])) &&
  (s.signed_in !== true || ["passkey", "words", "wallet"].includes(s.way));
const signedOut = (s) =>
  exactState(s) && s.signed_in === false && s.code_saved === false && s.vault_balance === "0" &&
  ["wallets", "positions", "orders", "held", "ops"].every((k) => s[k].length === 0);

const fromFrame = (rec) => (rec.messages ?? []).filter((m) => m.fromFrame && m.origin === `https://${SIGN_HOST}`);
const isEvent = (d) => sameKeys(d, ["v", "type", "state"]) && d.v === 1 && d.type === "state";
const isAnswer = (d) => sameKeys(d, ["v", "id", "ok", "result"]) && d.v === 1 && d.ok === true;
/** The first state event after time `t` that meets `want`, and how long after `t` it came. */
function eventAfter(rec, t, want) {
  const m = fromFrame(rec).find((x) => typeof t === "number" && x.t >= t && isEvent(x.data) && want(x.data.state));
  return m ? { state: m.data.state, ms: Math.round(m.t - t) } : null;
}
const show = (s) => (s ? JSON.stringify({ signed_in: s.signed_in, way: s.way, code_saved: s.code_saved }) : "none");

export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const st = rec.steps ?? {};
  const msgs = fromFrame(rec);

  const ready = msgs.filter((m) => sameKeys(m.data, ["v", "type", "release", "api"]) && m.data.type === "ready" && m.data.api === 1);
  say(ready.length === 1, `the frame posts one ready (${ready.length})`);
  const first = msgs.find((m) => isAnswer(m.data) && m.data.id === st.first?.id)?.data.result;
  say(signedOut(first), `the first state answer is signed out with exactly the frozen keys (${show(first)})`);

  say(st.created?.top?.state === "backup", `Create passkey with no PRF lands the top tab on the backup screen (${st.created?.top?.state})`);
  const e1 = eventAfter(rec, st.created?.t, (s) => s.signed_in === true);
  say(!!e1 && e1.ms <= EVENT_MS && exactState(e1.state) && e1.state.way === "passkey" && e1.state.code_saved === false,
    `then the frame posts signed in, way passkey, code_saved false (${show(e1?.state)}${e1 ? `, ${e1.ms} ms` : ""})`);

  say(st.saved?.top?.state === "signed-in" && st.saved?.top?.codeSaved === "true", `Saved signs the top tab in with the words saved (${st.saved?.top?.state}, code_saved ${st.saved?.top?.codeSaved})`);
  const e2 = eventAfter(rec, st.saved?.t, (s) => s.signed_in === true && s.code_saved === true);
  say(!!e2 && e2.ms <= EVENT_MS && exactState(e2.state) && e2.state.way === "passkey",
    `then the frame posts code_saved true (${show(e2?.state)}${e2 ? `, ${e2.ms} ms` : ""})`);

  say(st.signedOut?.top?.state === "signed-out", `Sign out in the top tab signs it out (${st.signedOut?.top?.state})`);
  const e3 = eventAfter(rec, st.signedOut?.t, (s) => s.signed_in === false);
  say(!!e3 && e3.ms <= EVENT_MS && signedOut(e3.state), `then the frame posts signed out, exactly the signed-out state (${show(e3?.state)}${e3 ? `, ${e3.ms} ms` : ""})`);

  const last = msgs.find((m) => isAnswer(m.data) && m.data.id === st.last?.id)?.data.result;
  say(signedOut(last), `a state asked again answers signed out (${show(last)})`);

  const states = msgs.flatMap((m) => (isEvent(m.data) ? [m.data.state] : isAnswer(m.data) ? [m.data.result] : []));
  const other = msgs.filter((m) => !isEvent(m.data) && !isAnswer(m.data) && m.data?.type !== "ready");
  say(states.length >= 5 && states.every(exactState) && other.length === 0,
    `every message is ready, a state answer or a state event, each state exact (${states.length} states, ${other.length} other)`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const PARENT = `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
const f = document.createElement("iframe");
f.src = ${JSON.stringify(SIGN_URL)};
addEventListener("message", (e) => window.__log.push({ t: performance.timeOrigin + performance.now(), origin: e.origin, fromFrame: e.source === f.contentWindow, data: e.data }));
document.body.append(f);
window.__ask = () => {
  const id = crypto.randomUUID();
  f.contentWindow.postMessage({ v: 1, id, type: "state" }, ${JSON.stringify(SIGN_URL.slice(0, -1))});
  return id;
};
</script></body>`;

async function launch({ harness, site }) {
  const { chromium } = createRequire(path.join(REPO, "packages/signpage/package.json"))("playwright");
  if (!harness) return { browser: await chromium.launch(), harnessApp: false, close: async () => {} };
  const { makeCert } = await import("../../apps/terminal/test/harness/certs.mjs");
  const { startServer } = await import("../../apps/terminal/test/harness/server.mjs");
  const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
  const root = site ?? buildSignpage();
  // APP_HOST's address serves the parent too: Chromium's local network access checks refuse a public parent framing a
  // host that resolves to this machine, so on the harness both are local
  const app = mkdtempSync(path.join(tmpdir(), "ct-frame-state-app-"));
  writeFileSync(path.join(app, "index.html"), PARENT);
  const cert = makeCert([SIGN_HOST, APP_HOST]);
  const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [SIGN_HOST]: { root }, [APP_HOST]: { root: app, spa: true } } });
  const map = [SIGN_HOST, APP_HOST].map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(", ");
  const browser = await chromium.launch({ args: [`--host-resolver-rules=${map}, MAP * ~NOTFOUND`, `--ignore-certificate-errors-spki-list=${cert.spki}`] });
  return {
    browser,
    harnessApp: true,
    close: async () => {
      await browser.close();
      await server.close();
      cert.remove();
      rmSync(app, { recursive: true, force: true });
      if (!site) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The top tab's screen once it settles: data-signin and data-code-saved, never the account or the words. */
async function top(page, not) {
  await page
    .waitForFunction((b) => {
      const s = document.getElementById("signin")?.dataset.signin;
      return s && s !== "loading" && s !== b;
    }, not ?? null, { timeout: WAIT_MS })
    .catch(() => {});
  return page.evaluate(() => {
    const m = document.getElementById("signin");
    return { state: m?.dataset.signin ?? null, codeSaved: m?.dataset.codeSaved ?? null };
  });
}

/** Clicks a control once the page's guard window has passed; resolves to the time of the click on the page clock. */
async function press(page, action) {
  await page.waitForTimeout(PROTECT_MS + 300);
  const t = Date.now();
  const ok = await page.click(`[data-action="${action}"]`, { timeout: WAIT_MS }).then(() => true, () => false);
  return ok ? t : null;
}

export async function collect({ harness, site, url }) {
  const h = await launch({ harness, site });
  const rec = { source: harness ? `harness, SIGN_HOST from ${site ?? "packages/signpage's committed build"}` : `live ${url ?? SIGN_URL}`, at: new Date().toISOString(), browser: h.browser.version(), steps: {}, messages: [], errors: [] };
  try {
    const ctx = await h.browser.newContext();
    if (!h.harnessApp) await ctx.route(APP_URL, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PARENT }));
    const parent = await ctx.newPage();
    parent.on("pageerror", (e) => rec.errors.push(`parent: ${e.message}`));
    await parent.goto(APP_URL);
    await parent.waitForFunction(() => window.__log.some((m) => m.data?.type === "ready"), null, { timeout: WAIT_MS, polling: 50 }).catch(() => {});
    const ask = async () => {
      const id = await parent.evaluate(() => window.__ask());
      await parent.waitForFunction((i) => window.__log.some((m) => m.data?.id === i), id, { timeout: WAIT_MS, polling: 50 }).catch(() => {});
      return { id };
    };
    rec.steps.first = await ask();

    const sign = await ctx.newPage();
    sign.on("pageerror", (e) => rec.errors.push(`sign: ${e.message}`));
    const cdp = await ctx.newCDPSession(sign);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
    });
    await sign.goto(url ?? SIGN_URL);
    rec.steps.open = { top: await top(sign) };
    const step = async (action, not) => {
      const t = await press(sign, action);
      const s = { t, top: await top(sign, not) };
      await sign.waitForTimeout(EVENT_MS);
      return s;
    };
    rec.steps.created = await step("create", rec.steps.open.top.state);
    rec.steps.saved = await step("saved", "backup");
    rec.steps.signedOut = await step("signout", "signed-in");
    rec.steps.last = await ask();
    // the log's times are the parent's wall clock (timeOrigin + now), the steps' Date.now(): one clock on one machine
    rec.messages = await parent.evaluate(() => window.__log);
    await ctx.close();
  } finally {
    await h.close();
  }
  return rec;
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const rec = await collect({ harness: args.includes("--harness"), site: opt("--site") ? path.resolve(opt("--site")) : undefined, url: opt("--url") });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    for (const e of rec.errors) console.log(`    ${e}`);
    console.log(`${KEY}: ${r.ok ? "PASS" : "FAIL"} (${rec.source}, Chromium ${rec.browser}, ${rec.at})`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
