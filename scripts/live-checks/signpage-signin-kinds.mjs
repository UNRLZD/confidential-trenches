#!/usr/bin/env node
// Live check of card signpage-signin-kinds: sign-in, sign-out and backup happen only on SIGN_HOST's top-level pages,
// opened by the app by name (docs/plan1/wallet.md §2.8 W:912-914 and §2.2 W:50 at research ffcba5e). Headless
// Chromium opens SIGN_HOST top-level, the shell that frames APP_HOST (card signpage-shell), and posts the kit's open
// kinds from inside the APP_HOST frame, as the terminal does. A CDP virtual authenticator holds the passkeys.
//   prf run (hasPrf true): signin.open {way: passkey} opens the layer on the passkey page; Create signs in and the layer
//     closes, back to the app with a frame again; that frame takes the signed-in state, pools included (live: the
//     deployed terminal's own kit client reaches ready, <html data-signpage>, never down; both: the state the shell
//     answers is signed in, holds pools and passes the kit's client, scripts/signpage-state.mjs). backup.open draws the 12 words in the layer (counted, never read) and
//     Cancel goes back to the app, still signed in. signout opens the sign-out page in the top window (the frame out of
//     the document, no Sign out in any frame); Sign out deletes the store and goes back to the app, signed out. A
//     signout sent signed out, and a backup.open sent signed out, are refused (not_allowed). Signed in, a signin.open is
//     refused (a seed is never replaced), and a press on Sign out within 500 ms of the sign-out page opening does
//     nothing. Signed in, a blank page of the check's own (APP_HOST frames nothing: its frame-src 'none') puts SIGN_HOST
//     in a frame and sends it signout: the browser refuses the frame (SIGN_HOST's frame-ancestors 'none', its report
//     read), so no answer comes and no frame of either page holds a Sign out. That report is kept apart from the page
//     errors.
//   no-prf run (hasPrf false): signin.open {way: passkey} then Create stores a random seed and opens the backup in the
//     same visit. After a reload (signed in, the words not saved) signout draws the backup first, with no Sign out;
//     Saved goes on to the sign-out page, whose Sign out deletes the store.
//   wallet run (no passkey): a wallet stub counts every request a page makes of it (window.ethereum, window.solana).
//     signin.open {way: wallet} on an empty store draws the two choices, New account and I already have one, with no
//     wallet request made and no seed stored; I already have one draws Use passkey and Recovery code, still with no
//     wallet request and no seed; Use passkey with a passkey that has no PRF there makes nothing and offers the 12 words
//     and the passkey again, never Create passkey (W:932: before any seed is made).
//   two tabs: tab A loaded signed out, tab B signs in; A's read of the new seed is held 2.5 s (a hook on the seed's
//     decrypt), and a backup.open A's app sends while that read runs waits for it, then is taken and draws the 12
//     words, never refused for coming at that moment.
//   broken store: signin.open opens the passkey page; a seed record that decrypts but fails checkSeed is put in the
//     store; Cancel still goes back to the app.
//   Every press waits out the page's 500 ms activation guard first, which each layer opening restarts.
//   node scripts/live-checks/signpage-signin-kinds.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/signpage-signin-kinds.mjs --harness [--site <dir>] ...   the same steps on the app's
//     browser harness (apps/terminal/test/harness) with SIGN_HOST's and APP_HOST's real names mapped to it, serving
//     SIGN_HOST's build (or <dir>) under its own _headers and a stand-in terminal at APP_HOST under the terminal's own
//     _headers (apps/terminal/public/_headers), as the live APP_HOST serves it
//   PASS exit 0, FAIL exit 1, error exit 2
// Records hold public values only: states, counts and the public account ids. Never the words, a key or a PRF output.
import "../net-window.mjs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { kitTakesState } from "../signpage-state.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { consoleError } from "./console-errors.mjs";

const KEY = "signpage-signin-kinds";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "sign.confidential.unrealized.trade";
export const APP_HOST = "confidential.unrealized.trade";
const APP_STAND_IN = `<!doctype html><title>APP_HOST</title><a href="/">Trenches</a> <button type="button">Sign in</button>`;
const WAIT_MS = 15_000;
const GUARD_MS = 600; // past the page's 500 ms activation guard

// Before SIGN_HOST's own scripts: a wallet that counts what any page asks of it and never answers.
const WALLET_STUB = () => {
  if (location.hostname !== "sign.confidential.unrealized.trade" || window.top !== window) return;
  globalThis.__ctWalletAsks = 0;
  const ask = () => ((globalThis.__ctWalletAsks += 1), new Promise(() => {}));
  const evm = { isMetaMask: true, request: ask, send: ask, sendAsync: ask, enable: ask, on() {}, removeListener() {} };
  const sol = { isPhantom: true, connect: ask, signMessage: ask, signIn: ask, request: ask, on() {}, off() {} };
  Object.defineProperty(window, "ethereum", { value: evm, configurable: true });
  Object.defineProperty(window, "solana", { value: sol, configurable: true });
  Object.defineProperty(window, "phantom", { value: { solana: sol, ethereum: evm }, configurable: true });
};

// Before SIGN_HOST's own scripts: once a test sets __ctHoldSeed, the page's next decrypt of the seed record waits that
// long (__ctHolding true meanwhile), so a step can be sent while the page reads its store.
const HOLD_SEED_READ = () => {
  if (location.hostname !== "sign.confidential.unrealized.trade" || window.top !== window) return;
  const decrypt = SubtleCrypto.prototype.decrypt;
  SubtleCrypto.prototype.decrypt = async function (alg, key, data) {
    const aad = alg?.additionalData ? new TextDecoder().decode(alg.additionalData) : "";
    const ms = globalThis.__ctHoldSeed ?? 0;
    if (ms > 0 && aad === "ct/v1/seed") {
      globalThis.__ctHoldSeed = 0;
      globalThis.__ctHolding = true;
      await new Promise((r) => setTimeout(r, ms));
      globalThis.__ctHolding = false;
    }
    return decrypt.call(this, alg, key, data);
  };
};

// In SIGN_HOST's page: a seed record the store decrypts but checkSeed refuses (no entropy), under the store's own key.
const PLANT_BROKEN_SEED = async () => {
  const req = (r) => new Promise((ok, no) => ((r.onsuccess = () => ok(r.result)), (r.onerror = () => no(r.error))));
  const db = await req(indexedDB.open("ct-wallet"));
  try {
    const key = await req(db.transaction("meta").objectStore("meta").get("k_wrap"));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode("ct/v1/seed");
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(JSON.stringify({ v: 1, source: "broken" })));
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ iv, ct }, "seed");
    await new Promise((ok, no) => ((tx.oncomplete = ok), (tx.onerror = () => no(tx.error))));
    return true;
  } finally {
    db.close();
  }
};

// ------------------------------------------------------------------------------------------------ the verdict
const HEX64 = /^[0-9a-f]{64}$/;
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = rec.prf ?? {};
  const pending = (a) => a?.ok === true && a?.result?.pending === true;
  const refusedNA = (a) => a?.ok === false && a?.error?.code === "not_allowed";
  const inLayer = (x, state) => x?.state === state && x?.layer === "shown" && x?.frame === false && x?.top === true;
  const backToApp = (x, state) => x?.state === state && x?.layer === "hidden" && x?.frame === true;

  say(pending(p.signin?.answer) && inLayer(p.signin?.page, "signed-out") && p.signin?.page?.create === 1,
    `prf: signin.open {way: passkey} opens the passkey page in the layer, the frame out (${p.signin?.page?.state}, layer ${p.signin?.page?.layer})`);
  const A = p.create?.account;
  say(backToApp(p.create, "signed-in") && HEX64.test(A ?? "") && p.create?.seed === true,
    `prf: Create signs in and goes back to the app (${p.create?.state}, layer ${p.create?.layer}, frame ${p.create?.frame ? "back" : "gone"})`);
  // live, the frame is the deployed terminal: its own kit client is READY only once its handshake's state passed the
  // kit's schema (signpage-frame.tsx, <html data-signpage>), and a refused one is down; on the harness the frame is a
  // stand-in with no client, so the state the shell answers is judged by the kit's client here alone
  const ap = p.app ?? {};
  const st = ap.state;
  const takes = kitTakesState(st);
  const term = rec.mode === "live" ? ap.signpage === "ready" : rec.mode === "harness";
  say(backToApp(p.create, "signed-in") && st?.signed_in === true && Array.isArray(st?.pools) && takes && term,
    `prf: the terminal in the frame takes the signed-in state with pools (${rec.mode === "live" ? `APP_HOST's client ${ap.signpage ?? "none"}` : "harness stand-in, the kit's client here"}, ${st ? `signed_in ${st.signed_in}, pools ${Array.isArray(st.pools) ? st.pools.length : "none"}, the kit ${takes ? "takes it" : "refuses it"}` : "no state"})`);
  say(pending(p.backup?.answer) && inLayer(p.backup?.page, "backup") && p.backup?.page?.words === 12 && p.backup?.page?.account === A,
    `prf: backup.open draws the 12 words of the account in the top window (${p.backup?.page?.state}, ${p.backup?.page?.words ?? 0} words)`);
  say(inLayer(p.backup?.page, "backup") && backToApp(p.backupCancel, "signed-in") && p.backupCancel?.account === A && p.backupCancel?.words === 0,
    `prf: Cancel on the backup goes back to the app signed in, the words gone (${p.backupCancel?.state}, layer ${p.backupCancel?.layer})`);
  say(refusedNA(p.again?.answer) && p.again?.page?.layer === "hidden" && p.again?.page?.account === A && p.again?.page?.seed === true,
    `prf: signin.open sent signed in is refused, the seed kept (${p.again?.answer?.error?.code ?? (p.again?.answer ? "answered" : "no step")})`);
  const so = p.signout ?? {};
  say(pending(so.answer) && inLayer(so.page, "signout") && so.page?.signoutButtons === 1 && so.page?.framesWithSignout === 0,
    `prf: signout opens the sign-out page top-level only (${so.page?.state}, top ${so.page?.top}, ${so.page?.signoutButtons ?? 0} Sign out, ${so.page?.framesWithSignout ?? "?"} in a frame)`);
  const fr = p.framed;
  say(!!fr && !pending(fr.answer) && fr.loaded === false && fr.signoutButtons === 0 && fr.refusals >= 1,
    `prf: a signout sent to SIGN_HOST in a frame is refused, the frame never loads a sign-out (${fr ? (fr.loaded ? "loaded" : "not loaded") : "no step"}, ${fr?.answer?.ok === true ? "answered ok" : fr?.answer?.timeout ? "no answer" : fr?.answer?.error?.code ?? "?"}, ${fr?.signoutButtons ?? "?"} Sign out, ${fr?.refusals ?? "?"} frame-ancestors refusal(s))`);
  const fast = so.early?.pressLanded === true && Number.isFinite(so.early?.pressMs) && so.early.pressMs >= 0 && so.early.pressMs < 500;
  say(fast && inLayer(so.early, "signout") && so.early?.db === true && so.early?.account === A,
    `prf: a press on Sign out within 500 ms of the page opening does nothing (${so.early?.state ?? "no step"}, store ${so.early?.db ? "kept" : "gone"}, press ${so.early?.pressLanded ? `landed at ${so.early.pressMs} ms` : "never landed"})`);
  say(backToApp(so.after, "signed-out") && so.after?.db === false && !so.after?.account,
    `prf: Sign out deletes the store and goes back to the app signed out (${so.after?.state}, store ${so.after?.db ? "kept" : "gone"})`);
  say(refusedNA(p.refused?.signout) && refusedNA(p.refused?.backup) && p.refused?.layer === "hidden",
    `prf: signout and backup.open sent signed out are refused (${p.refused?.signout?.error?.code ?? "answered"}, ${p.refused?.backup?.error?.code ?? "answered"})`);

  const n = rec.noPrf ?? {};
  const B = n.create?.account;
  say(n.create?.state === "backup" && n.create?.words === 12 && HEX64.test(B ?? "") && n.create?.codeSaved === "false",
    `no-prf: Create stores a random seed and opens the backup in the same visit (${n.create?.state}, ${n.create?.words ?? 0} words)`);
  say(pending(n.signout?.answer) && inLayer(n.signout?.page, "backup") && n.signout?.page?.words === 12 && n.signout?.page?.signoutButtons === 0 && n.signout?.page?.account === B,
    `no-prf: signout with the words not saved draws the backup first, no Sign out (${n.signout?.page?.state}, ${n.signout?.page?.signoutButtons ?? "?"} Sign out)`);
  say(inLayer(n.saved, "signout") && n.saved?.signoutButtons === 1 && n.saved?.codeSaved === "true" && n.saved?.account === B,
    `no-prf: Saved goes on to the sign-out page (${n.saved?.state}, code_saved ${n.saved?.codeSaved})`);
  say(backToApp(n.after, "signed-out") && n.after?.db === false,
    `no-prf: Sign out then deletes the store (${n.after?.state}, store ${n.after?.db ? "kept" : "gone"})`);

  const w = rec.wallet ?? {};
  say(pending(w.answer) && inLayer(w.choose, "choose") && w.choose?.newAccount === 1 && w.choose?.haveOne === 1,
    `wallet: signin.open {way: wallet} on an empty store draws the two choices (${w.choose?.state}, ${w.choose?.newAccount ?? 0} New account, ${w.choose?.haveOne ?? 0} I already have one)`);
  say(inLayer(w.choose, "choose") && w.choose?.walletAsks === 0 && w.choose?.seed === false,
    `wallet: no wallet request and no seed before the choice (${w.choose?.walletAsks ?? "?"} request(s), seed ${w.choose?.seed ? "made" : "none"})`);
  say(inLayer(w.existing, "existing") && w.existing?.use === 1 && w.existing?.recovery === 1 && w.existing?.walletAsks === 0 && w.existing?.seed === false,
    `wallet: I already have one draws Use passkey and Recovery code, no wallet request, no seed (${w.existing?.state}, ${w.existing?.walletAsks ?? "?"} request(s))`);
  const ex = w.existingUse;
  say(inLayer(ex, "no-prf") && ex?.create === 0 && ex?.use === 1 && ex?.recovery === 1 && ex?.seed === false,
    `wallet: Use passkey there with no PRF makes nothing and offers the passkey and the 12 words, never Create passkey (${ex?.state ?? "no step"}, ${ex?.create ?? "?"} Create passkey)`);
  const t = rec.twoTabs ?? {};
  say(t.aLoaded?.state === "signed-out" && HEX64.test(t.bCreate?.account ?? "") && t.heldAtSend === true && pending(t.backup?.answer)
    && inLayer(t.backup?.page, "backup") && t.backup?.page?.words === 12 && t.backup?.page?.account === t.bCreate?.account,
    `two tabs: a backup.open sent while tab A reads tab B's new seed waits for the read and is taken (${t.heldAtSend ? "sent during the read" : "not during a read"}, ${t.backup?.answer?.ok === true ? "pending" : t.backup?.answer?.error?.code ?? "no step"}, ${t.backup?.page?.state ?? "?"})`);
  const bk = rec.broken ?? {};
  say(inLayer(bk.open, "signed-out") && bk.planted === true && bk.cancel?.layer === "hidden" && bk.cancel?.frame === true,
    `broken store: Cancel goes back to the app when the stored seed cannot be read (${bk.cancel?.state ?? "no step"}, layer ${bk.cancel?.layer ?? "?"})`);
  say(Array.isArray(rec.errors) && rec.errors.length === 0, `no page error or CSP violation (${Array.isArray(rec.errors) ? rec.errors.length : "no record"})${Array.isArray(rec.errors) && rec.errors.length ? `: ${rec.errors.join("; ")}` : ""}`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the probe
async function launch({ harness, site }) {
  if (!harness) return { browser: await launchBrowser("chromium"), close: async () => {} };
  const { makeCert } = await import("../../apps/terminal/test/harness/certs.mjs");
  const { startServer } = await import("../../apps/terminal/test/harness/server.mjs");
  const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
  const root = site ?? buildSignpage();
  const app = mkdtempSync(path.join(tmpdir(), "ct-signin-kinds-app-"));
  writeFileSync(path.join(app, "index.html"), APP_STAND_IN);
  writeFileSync(path.join(app, "_headers"), readFileSync(path.join(REPO, "apps/terminal/public/_headers"), "utf8"));
  const cert = makeCert([SIGN_HOST, APP_HOST]);
  const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [SIGN_HOST]: { root }, [APP_HOST]: { root: app, spa: true } } });
  const map = [SIGN_HOST, APP_HOST].map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(", ");
  const browser = await launchBrowser("chromium", { args: [`--host-resolver-rules=${map}, MAP * ~NOTFOUND`, `--ignore-certificate-errors-spki-list=${cert.spki}`] });
  return {
    browser,
    close: async () => {
      await browser.close();
      await server.close();
      cert.remove();
      rmSync(app, { recursive: true, force: true });
      if (!site) rmSync(root, { recursive: true, force: true });
    },
  };
}

async function authenticator(page, hasPrf) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true },
  });
}

// A virtual authenticator without PRF holding one passkey for SIGN_HOST (a fresh P-256 key, made here, never stored):
// Use passkey then gets an assertion with no PRF output.
async function passkeyNoPrf(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false, automaticPresenceSimulation: true },
  });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: randomBytes(16).toString("base64"),
      isResidentCredential: true,
      rpId: SIGN_HOST,
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      userHandle: randomBytes(16).toString("base64"),
      signCount: 0,
    },
  });
}

/** The check's page and console hooks: a page error, and a console error kept through the shared collector
 *  (console-errors.mjs) as its text and its address's origin and path. */
export function watch(page, errors) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${consoleError(m)}`));
}

// Sign out buttons in every frame of the page, each read in its own frame (cross-origin ones too).
async function framedSignouts(page) {
  let n = 0;
  for (const f of page.frames())
    if (f !== page.mainFrame()) n += await f.evaluate(() => document.querySelectorAll('[data-action="signout"]').length).catch(() => 0);
  return n;
}

// A blank page of the check's own in the same browser context (the signed-in store), with SIGN_HOST in a frame, sent
// signout as the terminal sends it. The browser's frame-ancestors report on that page is counted, never a page error.
async function framedTry(page) {
  const ctx = page.context();
  const host = await ctx.newPage();
  const refusals = [];
  const errors = [];
  host.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  host.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/frame-ancestors/.test(m.text()) && m.text().includes(SIGN_HOST)) refusals.push(m.text().slice(0, 200));
    else errors.push(`console: ${consoleError(m)}`);
  });
  await host.setContent(`<!doctype html><iframe src="https://${SIGN_HOST}/"></iframe>`);
  const answer = await host.evaluate((origin) => new Promise((done) => {
    const fr = document.querySelector("iframe");
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join(""); // about:blank has no randomUUID
    const t = setTimeout(() => done({ timeout: true }), 4_000);
    addEventListener("message", (e) => {
      if (e.origin !== origin || e.data?.id !== id) return;
      clearTimeout(t);
      done(e.data);
    });
    const post = () => fr.contentWindow?.postMessage({ v: 1, id, type: "signout", return_key: "settings" }, origin);
    setTimeout(post, 1_000);
    fr.addEventListener("load", () => setTimeout(post, 500));
  }), `https://${SIGN_HOST}`);
  const loaded = host.frames().some((x) => x !== host.mainFrame() && x.url().startsWith(`https://${SIGN_HOST}/`));
  const signoutButtons = (await framedSignouts(host)) + (await framedSignouts(page));
  await host.close();
  return { answer, loaded, signoutButtons, refusals: refusals.length, errors };
}

// The APP_HOST frame the shell holds now (a new one comes each time the layer closes).
async function appFrame(page) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith(`https://${APP_HOST}/`));
    if (f && (await f.evaluate(() => document.readyState === "complete").catch(() => false))) return f;
    if (Date.now() > until) throw new Error("no APP_HOST frame");
    await page.waitForTimeout(100);
  }
}

// Posts one kind from inside the APP_HOST frame to the shell, as the terminal does, and returns the shell's answer.
async function send(page, type, params = {}) {
  // no frame: the layer is open (an open kind a page should have refused took it), so no kind can be sent
  const f = await appFrame(page).catch(() => null);
  if (!f) return { noFrame: true };
  return f.evaluate(({ type, params, origin, hello }) => new Promise((done) => {
    const id = crypto.randomUUID();
    const t = setTimeout(() => done({ timeout: true }), 5_000);
    addEventListener("message", (e) => {
      if (e.origin !== origin || e.data?.id !== id) return;
      clearTimeout(t);
      done(e.data);
    });
    // the kit's hello first, as the kit's client sends it (card kit-frame-version): an app that names none is kit-v1.4
    parent.postMessage(hello, origin);
    parent.postMessage({ v: 1, id, type, ...params }, origin);
  }), { type, params, origin: `https://${SIGN_HOST}`, hello: { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION } });
}

// The APP_HOST frame after a sign-in: its <html data-signpage> once the terminal's client settles (ready, down or
// update; the harness's stand-in has none), and the state the shell answers it.
async function appTakes(page) {
  const f = await appFrame(page).catch(() => null);
  if (!f) return { noFrame: true };
  const settledAs = () => {
    const s = document.documentElement.dataset.signpage;
    return s === "ready" || s === "down" || s === "update" ? s : false;
  };
  // the client's handshake ends within SIGNPAGE_HANDSHAKE_MS (5 s) of its start
  const signpage = await f.waitForFunction(settledAs, null, { timeout: 8_000 }).then((h) => h.jsonValue(), () => null);
  const answer = await send(page, "state");
  return { signpage, state: answer?.ok === true ? answer.result : null };
}

// The top window's page once it settles past `not` (states the step leaves).
async function read(page, not = []) {
  await page.waitForFunction((not) => {
    const s = document.getElementById("signin")?.dataset.signin;
    return s && s !== "loading" && !not.includes(s);
  }, not, { timeout: WAIT_MS }).catch(() => {});
  // the frame leaves FRAME_LEAVE_MS (100 ms) after the layer shows, and a new one comes at close
  await page.waitForTimeout(300);
  const r = await page.evaluate(async () => {
    const m = document.getElementById("signin");
    const layer = document.getElementById("screen");
    const db = (await indexedDB.databases()).some((d) => d.name === "ct-wallet");
    let seed = false;
    if (db)
      seed = await new Promise((ok) => {
        const r = indexedDB.open("ct-wallet");
        r.onsuccess = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("meta")) return (d.close(), ok(false));
          const g = d.transaction("meta").objectStore("meta").get("seed");
          g.onsuccess = () => (d.close(), ok(g.result !== undefined));
          g.onerror = () => (d.close(), ok(false));
        };
        r.onerror = () => ok(false);
      });
    const count = (a) => document.querySelectorAll(`[data-action="${a}"]`).length;
    return {
      state: m?.dataset.signin ?? null,
      account: m?.dataset.account ?? null,
      codeSaved: m?.dataset.codeSaved ?? null,
      layer: layer ? (layer.hidden ? "hidden" : "shown") : "none",
      frame: !!document.getElementById("app"),
      top: window.top === window && !!layer?.contains(m),
      words: document.querySelectorAll("[data-words] li").length,
      create: count("create"),
      use: count("use"),
      recovery: count("recovery"),
      newAccount: count("new-account"),
      haveOne: count("have-one"),
      signoutButtons: count("signout"),
      walletAsks: globalThis.__ctWalletAsks ?? null,
      db,
      seed,
    };
  });
  r.framesWithSignout = await framedSignouts(page);
  return r;
}

// A press past the activation guard: waits GUARD_MS from now (the layer just opened or the control was just drawn).
async function press(page, action, not) {
  await page.waitForTimeout(GUARD_MS);
  const ok = await page.click(`[data-action="${action}"]`, { timeout: WAIT_MS }).then(() => true, () => false);
  return ok ? read(page, not) : { ...(await read(page)), noButton: action };
}

export async function probe({ url = `https://${SIGN_HOST}/`, harness = false, site } = {}) {
  const errors = [];
  const record = { key: KEY, url, mode: harness ? "harness" : "live", at: new Date().toISOString(), prf: {}, noPrf: {}, wallet: {}, twoTabs: {}, broken: {}, errors };
  const h = await launch({ harness, site });
  record.browser = browserLabel(h.browser);
  try {
    // prf run
    {
      const ctx = await h.browser.newContext();
      const page = await ctx.newPage();
      watch(page, errors);
      await authenticator(page, true);
      await page.goto(url);
      await read(page);
      const p = record.prf;
      const answer = await send(page, "signin.open", { way: "passkey", return_key: "settings" });
      p.signin = { answer, page: await read(page) };
      p.create = await press(page, "create", ["signed-out"]);
      p.app = await appTakes(page);
      p.framed = await framedTry(page);
      errors.push(...p.framed.errors);
      delete p.framed.errors;
      p.again = { answer: await send(page, "signin.open", { way: "passkey", return_key: "settings" }), page: await read(page) };
      const backup = await send(page, "backup.open", { return_key: "settings" });
      p.backup = { answer: backup, page: await read(page, ["signed-in"]) };
      p.backupCancel = await press(page, "cancel", ["backup"]);
      // past 500 ms from the last press, so only the opening's own restart of the guard can stop the early press below
      await page.waitForTimeout(GUARD_MS);
      // the page's own clock: when the sign-out page is drawn, and when a pointerdown lands on its Sign out
      await page.evaluate(() => {
        const g = globalThis;
        g.__ctDrawnAt = null;
        g.__ctPressAt = null;
        const m = document.getElementById("signin");
        new MutationObserver(() => m?.dataset.signin === "signout" && g.__ctDrawnAt === null && (g.__ctDrawnAt = performance.now()))
          .observe(m, { attributes: true, attributeFilter: ["data-signin"] });
        addEventListener("pointerdown", (e) => e.target?.closest?.('[data-action="signout"]') && (g.__ctPressAt ??= e.timeStamp), true);
      });
      const signout = await send(page, "signout", { return_key: "settings" });
      // a press as soon as the page is drawn, inside the 500 ms the opening restarts
      await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signout", null, { timeout: WAIT_MS }).catch(() => {});
      await page.click('[data-action="signout"]', { timeout: 1_000 }).catch(() => {});
      const early = await read(page);
      const at = await page.evaluate(() => ({ d: globalThis.__ctDrawnAt, p: globalThis.__ctPressAt }));
      early.pressLanded = typeof at.d === "number" && typeof at.p === "number";
      early.pressMs = early.pressLanded ? Math.round(at.p - at.d) : null;
      const soPage = await read(page, ["signed-in"]);
      p.signout = { answer: signout, page: soPage, early, after: await press(page, "signout", ["signout"]) };
      p.refused = { signout: await send(page, "signout", { return_key: "settings" }), backup: await send(page, "backup.open", { return_key: "settings" }) };
      p.refused.layer = (await read(page)).layer;
      await ctx.close();
    }
    // no-prf run
    {
      const ctx = await h.browser.newContext();
      const page = await ctx.newPage();
      watch(page, errors);
      await authenticator(page, false);
      await page.goto(url);
      await read(page);
      const n = record.noPrf;
      await send(page, "signin.open", { way: "passkey", return_key: "settings" });
      await read(page);
      n.create = await press(page, "create", ["signed-out"]);
      await page.reload();
      await read(page);
      const answer = await send(page, "signout", { return_key: "settings" });
      n.signout = { answer, page: await read(page, ["signed-in"]) };
      n.saved = await press(page, "saved", ["backup"]);
      n.after = await press(page, "signout", ["signout"]);
      await ctx.close();
    }
    // wallet run
    {
      const ctx = await h.browser.newContext();
      await ctx.addInitScript(WALLET_STUB);
      const page = await ctx.newPage();
      watch(page, errors);
      await passkeyNoPrf(page);
      await page.goto(url);
      await read(page);
      const w = record.wallet;
      w.answer = await send(page, "signin.open", { way: "wallet", return_key: "settings" });
      w.choose = await read(page, ["signed-out", "unsupported"]);
      w.existing = await press(page, "have-one", ["choose"]);
      w.existingUse = await press(page, "use", ["existing"]);
      await ctx.close();
    }
    // two tabs
    {
      const ctx = await h.browser.newContext();
      await ctx.addInitScript(HOLD_SEED_READ);
      const a = await ctx.newPage();
      const b = await ctx.newPage();
      watch(a, errors);
      watch(b, errors);
      await authenticator(b, true);
      await a.goto(url);
      const t = record.twoTabs;
      t.aLoaded = await read(a);
      await b.goto(url);
      await read(b);
      await send(b, "signin.open", { way: "passkey", return_key: "settings" });
      await read(b);
      // A's next read of the seed (its resync on B's sign-in) is held 2.5 s
      await a.evaluate(() => (globalThis.__ctHoldSeed = 2_500));
      t.bCreate = await press(b, "create", ["signed-out"]);
      t.heldAtSend = await a.evaluate(() => globalThis.__ctHolding === true);
      t.backup = { answer: await send(a, "backup.open", { return_key: "settings" }) };
      t.backup.page = await read(a, ["signed-out", "signed-in"]);
      await ctx.close();
    }
    // broken store
    {
      const ctx = await h.browser.newContext();
      const page = await ctx.newPage();
      watch(page, errors);
      await page.goto(url);
      await read(page);
      const bk = record.broken;
      await send(page, "signin.open", { way: "passkey", return_key: "settings" });
      bk.open = await read(page);
      bk.planted = await page.evaluate(PLANT_BROKEN_SEED).catch(() => false);
      bk.cancel = await press(page, "cancel", ["signed-out"]);
      await ctx.close();
    }
  } finally {
    await h.close();
  }
  return { record };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const origin = opt("--url");
    const { record } = await probe({ harness: args.includes("--harness"), site: opt("--site"), url: origin ? `${origin.replace(/\/$/, "")}/` : undefined });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(record, null, 1) + "\n");
    const { pass, lines } = judge(record);
    for (const l of lines) console.log(l);
    for (const e of record.errors) console.log(`    ${e}`);
    console.log(`${KEY}: ${pass ? "PASS" : "FAIL"} (${record.browser})`);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
