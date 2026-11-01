#!/usr/bin/env node
// Live check of card signpage-frame-state: the signing page's frame tells APP_HOST the truth from SIGN_HOST's wallet
// store (packages/signpage/src/state.ts; the shapes are packages/kit/src/signpage/messages.ts, api 1). In headless
// Chromium, one browser profile holds two tabs, as a user's browser does: an APP_HOST page that frames SIGN_HOST and
// records every message the frame posts, and SIGN_HOST top-level, where the user signs in and out. The top-level tab
// signs in with a CDP virtual authenticator that has no PRF (Create passkey makes a random seed and lands on the
// backup screen), taps Saved, then Sign out. The check reads:
//   - the frame's `ready`, then its first `state` answer: signed out, exact keys (a fresh profile holds no seed);
//   - after Create passkey (the top tab on the backup screen): a `state` event with signed_in true, way "passkey",
//     code_saved false (the top tab writes the seed, then its status record; an event between the two, signed in with
//     no way, may come first);
//   - after Saved (the top tab signed in, code_saved true): a `state` event with code_saved true;
//   - a second APP_HOST page opened while signed in: its frame loads with a seed stored and answers signed in, way
//     "passkey", code_saved true;
//   - the status record deleted raw from the top tab (a database from before it): the first frame answers signed in
//     with no way and code_saved false; the top tab reloads, and its load's backfill brings back way "passkey" and
//     code_saved true in a `state` event;
//   - after Sign out (the top tab signed out): a `state` event with signed_in false, exactly the signed-out state;
//   - a `state` asked again: signed out;
//   - every state (answer or event) with exactly the frozen keys (`way` never while signed out), no other message kind;
//   - no SIGN_HOST frame ever reads the seed record: an init script in every SIGN_HOST frame wraps IndexedDB's get,
//     getAll and openCursor and records any get of meta/seed and any getAll or cursor over "meta" (the frame reads
//     the status and the seed's key only). The top-level tab may read it; it is not the frame.
// The parent frames SIGN_HOST with the kit's own SIGNPAGE_IFRAME_ATTRIBUTES, as the terminal's client does.
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
import { SIGNPAGE_IFRAME_ATTRIBUTES } from "../../packages/kit/src/index.ts";

const KEY = "signpage-frame-state";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "sign.confidential.unrealized.trade";
export const APP_HOST = "confidential.unrealized.trade";
const SIGN_URL = `https://${SIGN_HOST}/`;
const APP_URL = `https://${APP_HOST}/`;
export const EVENT_MS = 3_000;
// a reload's own time: the page loads, opens the store and backfills before its event can come
const RELOAD_MS = 5_000;
const WAIT_MS = 15_000;
const PROTECT_MS = 500; // the page's activation guard (packages/signpage/src/guard.ts)
const KEYS = ["release", "api", "signed_in", "code_saved", "vault_balance", "wallets", "positions", "orders", "held", "ops"];

// ------------------------------------------------------------------------------------------------ the verdict
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (v, keys) => isObj(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
/**
 * A state of exactly the frozen keys, the types right: `way` never when signed out, and optional when signed in (a seed
 * whose status record is not written yet reads signed in with no way, packages/signpage/src/state.ts).
 */
export const exactState = (s) =>
  isObj(s) &&
  (sameKeys(s, KEYS) || (s.signed_in === true && sameKeys(s, [...KEYS, "way"]))) &&
  typeof s.release === "string" && s.api === 1 && typeof s.signed_in === "boolean" && typeof s.code_saved === "boolean" &&
  typeof s.vault_balance === "string" && ["wallets", "positions", "orders", "held", "ops"].every((k) => Array.isArray(s[k])) &&
  (!Object.hasOwn(s, "way") || ["passkey", "words", "wallet"].includes(s.way));
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
  const e1 = eventAfter(rec, st.created?.t, (s) => s.signed_in === true && s.way === "passkey");
  say(!!e1 && e1.ms <= EVENT_MS && exactState(e1.state) && e1.state.code_saved === false,
    `then the frame posts signed in, way passkey, code_saved false (${show(e1?.state)}${e1 ? `, ${e1.ms} ms` : ""})`);

  say(st.saved?.top?.state === "signed-in" && st.saved?.top?.codeSaved === "true", `Saved signs the top tab in with the words saved (${st.saved?.top?.state}, code_saved ${st.saved?.top?.codeSaved})`);
  const e2 = eventAfter(rec, st.saved?.t, (s) => s.signed_in === true && s.code_saved === true);
  say(!!e2 && e2.ms <= EVENT_MS && exactState(e2.state) && e2.state.way === "passkey",
    `then the frame posts code_saved true (${show(e2?.state)}${e2 ? `, ${e2.ms} ms` : ""})`);

  say(st.signedOut?.top?.state === "signed-out", `Sign out in the top tab signs it out (${st.signedOut?.top?.state})`);
  const b = st.second?.answer;
  say(exactState(b) && b.signed_in === true && b.way === "passkey" && b.code_saved === true,
    `a frame that loads while signed in answers signed in, way passkey, code_saved true (${show(b)})`);
  const gone = st.statusGone?.answer;
  say(exactState(gone) && gone.signed_in === true && !Object.hasOwn(gone, "way") && gone.code_saved === false,
    `with the status deleted raw the frame answers signed in, no way, code_saved false (${show(gone)})`);
  const e4 = eventAfter(rec, st.reloaded?.t, (s) => s.signed_in === true && s.way === "passkey" && s.code_saved === true);
  say(st.reloaded?.top?.state === "signed-in" && !!e4 && e4.ms <= EVENT_MS + RELOAD_MS,
    `the top tab's reload brings back way passkey and code_saved true (${st.reloaded?.top?.state}, ${show(e4?.state)}${e4 ? `, ${e4.ms} ms` : ""})`);

  const e3 = eventAfter(rec, st.signedOut?.t, (s) => s.signed_in === false);
  say(!!e3 && e3.ms <= EVENT_MS && signedOut(e3.state), `then the frame posts signed out, exactly the signed-out state (${show(e3?.state)}${e3 ? `, ${e3.ms} ms` : ""})`);

  const last = msgs.find((m) => isAnswer(m.data) && m.data.id === st.last?.id)?.data.result;
  say(signedOut(last), `a state asked again answers signed out (${show(last)})`);

  const states = msgs.flatMap((m) => (isEvent(m.data) ? [m.data.state] : isAnswer(m.data) ? [m.data.result] : []));
  const other = msgs.filter((m) => !isEvent(m.data) && !isAnswer(m.data) && m.data?.type !== "ready");
  say(states.length >= 5 && states.every(exactState) && other.length === 0,
    `every message is ready, a state answer or a state event, each state exact (${states.length} states, ${other.length} other)`);
  const frames = rec.frames ?? [];
  const seedReads = frames.flatMap((f) => f.seedReads ?? []);
  say(frames.length >= 2 && frames.every((f) => Array.isArray(f.seedReads) && f.calls > 0) && seedReads.length === 0,
    `no SIGN_HOST frame reads the seed record (${frames.length} frames, ${frames.map((f) => f.calls).join("+")} IndexedDB reads, ${seedReads.length} of the seed${seedReads.length ? `: ${seedReads.join("; ")}` : ""})`);
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
const PARENT = `<!doctype html><meta charset="utf-8"><body><script>
window.__log = [];
const f = document.createElement("iframe");
for (const [k, v] of Object.entries(${JSON.stringify(SIGNPAGE_IFRAME_ATTRIBUTES)})) f.setAttribute(k, v);
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

// Runs in every document of the context before its scripts: in a SIGN_HOST frame, every IndexedDB get, getAll and
// openCursor is counted, and one that reads the seed record (a get of meta/seed, any getAll or cursor over "meta") is
// recorded. The top-level SIGN_HOST tab is not wrapped: it is where the seed is meant to be read.
const SPY = (host) => {
  if (location.hostname !== host || window.top === window) return;
  window.__idb = { calls: 0, seedReads: [] };
  const P = IDBObjectStore.prototype;
  for (const m of ["get", "getAll", "openCursor"]) {
    const orig = P[m];
    P[m] = function (...a) {
      window.__idb.calls++;
      if (this.name === "meta" && (m !== "get" || String(a[0]) === "seed")) window.__idb.seedReads.push(`${m} meta/${a.length ? String(a[0]) : "*"}`);
      return orig.apply(this, a);
    };
  }
};

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
    await ctx.addInitScript(SPY, SIGN_HOST);
    if (!h.harnessApp) await ctx.route(APP_URL, (r) => r.fulfill({ status: 200, contentType: "text/html", body: PARENT }));
    const parentPage = async (label) => {
      const p = await ctx.newPage();
      p.on("pageerror", (e) => rec.errors.push(`${label}: ${e.message}`));
      await p.goto(APP_URL);
      await p.waitForFunction(() => window.__log.some((m) => m.data?.type === "ready"), null, { timeout: WAIT_MS, polling: 50 }).catch(() => {});
      return p;
    };
    const askOn = async (p) => {
      const id = await p.evaluate(() => window.__ask());
      await p.waitForFunction((i) => window.__log.some((m) => m.data?.id === i), id, { timeout: WAIT_MS, polling: 50 }).catch(() => {});
      return { id, answer: await p.evaluate((i) => window.__log.find((m) => m.data?.id === i)?.data?.result ?? null, id) };
    };
    const parent = await parentPage("parent");
    const ask = async () => ({ id: (await askOn(parent)).id });
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
    // a second parent while signed in: its frame loads with a seed stored
    const second = await parentPage("second parent");
    rec.steps.second = await askOn(second);
    // a database from before the status record: the status deleted raw, then the top tab reloads (its backfill)
    await sign.evaluate(() => new Promise((ok, no) => {
      const r = indexedDB.open("ct-wallet");
      r.onsuccess = () => {
        const tx = r.result.transaction("meta", "readwrite");
        tx.objectStore("meta").delete("status");
        tx.oncomplete = () => (r.result.close(), ok());
        tx.onerror = () => no(tx.error);
      };
      r.onerror = () => no(r.error);
    }));
    rec.steps.statusGone = await askOn(parent);
    const t = Date.now();
    await sign.reload();
    rec.steps.reloaded = { t, top: await top(sign) };
    await sign.waitForTimeout(EVENT_MS);
    rec.steps.signedOut = await step("signout", "signed-in");
    rec.steps.last = await ask();
    // the log's times are the parent's wall clock (timeOrigin + now), the steps' Date.now(): one clock on one machine
    rec.messages = await parent.evaluate(() => window.__log);
    // what each SIGN_HOST frame read from IndexedDB (null: the spy did not run there)
    rec.frames = [];
    for (const p of [parent, second])
      for (const f of p.frames().filter((x) => x !== p.mainFrame() && new URL(x.url()).hostname === SIGN_HOST))
        rec.frames.push((await f.evaluate(() => window.__idb ?? null).catch(() => null)) ?? { calls: 0, seedReads: null });
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
