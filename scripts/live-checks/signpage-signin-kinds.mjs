#!/usr/bin/env node
// Live check of card signpage-signin-kinds: sign-in, sign-out and backup happen only on SIGN_HOST's top-level pages,
// opened by the app by name (docs/plan1/wallet.md §2.8 W:912-914 and §2.2 W:50 at research ffcba5e). Headless
// Chromium opens SIGN_HOST top-level, the shell that frames APP_HOST (card signpage-shell), and posts the kit's open
// kinds from inside the APP_HOST frame, as the terminal does. A CDP virtual authenticator holds the passkeys.
//   prf run (hasPrf true): signin.open {way: passkey} opens the layer on the passkey page; Create signs in and the layer
//     closes, back to the app with a frame again. backup.open draws the 12 words in the layer (counted, never read) and
//     Cancel goes back to the app, still signed in. signout opens the sign-out page in the top window (the frame out of
//     the document, no Sign out in any frame); Sign out deletes the store and goes back to the app, signed out. A
//     signout sent signed out, and a backup.open sent signed out, are refused (not_allowed).
//   no-prf run (hasPrf false): signin.open {way: passkey} then Create stores a random seed and opens the backup in the
//     same visit. After a reload (signed in, the words not saved) signout draws the backup first, with no Sign out;
//     Saved goes on to the sign-out page, whose Sign out deletes the store.
//   wallet run (no passkey): a wallet stub counts every request a page makes of it (window.ethereum, window.solana).
//     signin.open {way: wallet} on an empty store draws the two choices, New account and I already have one, with no
//     wallet request made and no seed stored; I already have one draws Use passkey and Recovery code, still with no
//     wallet request and no seed.
//   Every press waits out the page's 500 ms activation guard first, which each layer opening restarts.
//   node scripts/live-checks/signpage-signin-kinds.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/signpage-signin-kinds.mjs --harness [--site <dir>] ...   the same steps on the app's
//     browser harness (apps/terminal/test/harness) with SIGN_HOST's and APP_HOST's real names mapped to it, serving
//     SIGN_HOST's build (or <dir>) under its own _headers and a stand-in terminal at APP_HOST
//   PASS exit 0, FAIL exit 1, error exit 2
// Records hold public values only: states, counts and the public account ids. Never the words, a key or a PRF output.
import "../net-window.mjs";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  say(pending(p.backup?.answer) && inLayer(p.backup?.page, "backup") && p.backup?.page?.words === 12 && p.backup?.page?.account === A,
    `prf: backup.open draws the 12 words of the account in the top window (${p.backup?.page?.state}, ${p.backup?.page?.words ?? 0} words)`);
  say(inLayer(p.backup?.page, "backup") && backToApp(p.backupCancel, "signed-in") && p.backupCancel?.account === A && p.backupCancel?.words === 0,
    `prf: Cancel on the backup goes back to the app signed in, the words gone (${p.backupCancel?.state}, layer ${p.backupCancel?.layer})`);
  const so = p.signout ?? {};
  say(pending(so.answer) && inLayer(so.page, "signout") && so.page?.signoutButtons === 1 && so.page?.framesWithSignout === 0,
    `prf: signout opens the sign-out page top-level only (${so.page?.state}, top ${so.page?.top}, ${so.page?.signoutButtons ?? 0} Sign out, ${so.page?.framesWithSignout ?? "?"} in a frame)`);
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
  say((rec.errors ?? []).length === 0, `no page error or CSP violation (${(rec.errors ?? []).length})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the probe
const playwright = () => createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");

async function launch({ harness, site }) {
  const { chromium } = playwright();
  if (!harness) return { browser: await chromium.launch(), close: async () => {} };
  const { makeCert } = await import("../../apps/terminal/test/harness/certs.mjs");
  const { startServer } = await import("../../apps/terminal/test/harness/server.mjs");
  const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
  const root = site ?? buildSignpage();
  const app = mkdtempSync(path.join(tmpdir(), "ct-signin-kinds-app-"));
  writeFileSync(path.join(app, "index.html"), APP_STAND_IN);
  const cert = makeCert([SIGN_HOST, APP_HOST]);
  const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [SIGN_HOST]: { root }, [APP_HOST]: { root: app, spa: true } } });
  const map = [SIGN_HOST, APP_HOST].map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(", ");
  const browser = await chromium.launch({ args: [`--host-resolver-rules=${map}, MAP * ~NOTFOUND`, `--ignore-certificate-errors-spki-list=${cert.spki}`] });
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

function watch(page, errors) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
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
  const f = await appFrame(page);
  return f.evaluate(({ type, params, origin }) => new Promise((done) => {
    const id = crypto.randomUUID();
    const t = setTimeout(() => done({ timeout: true }), 5_000);
    addEventListener("message", (e) => {
      if (e.origin !== origin || e.data?.id !== id) return;
      clearTimeout(t);
      done(e.data);
    });
    parent.postMessage({ v: 1, id, type, ...params }, origin);
  }), { type, params, origin: `https://${SIGN_HOST}` });
}

// The top window's page once it settles past `not` (states the step leaves).
async function read(page, not = []) {
  await page.waitForFunction((not) => {
    const s = document.getElementById("signin")?.dataset.signin;
    return s && s !== "loading" && !not.includes(s);
  }, not, { timeout: WAIT_MS }).catch(() => {});
  // the frame leaves FRAME_LEAVE_MS (100 ms) after the layer shows, and a new one comes at close
  await page.waitForTimeout(300);
  return page.evaluate(async () => {
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
    let framesWithSignout = 0;
    for (const f of document.querySelectorAll("iframe")) {
      try {
        framesWithSignout += f.contentDocument?.querySelectorAll('[data-action="signout"]').length ?? 0;
      } catch {}
    }
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
      framesWithSignout,
      walletAsks: globalThis.__ctWalletAsks ?? null,
      db,
      seed,
    };
  });
}

// A press past the activation guard: waits GUARD_MS from now (the layer just opened or the control was just drawn).
async function press(page, action, not) {
  await page.waitForTimeout(GUARD_MS);
  const ok = await page.click(`[data-action="${action}"]`, { timeout: WAIT_MS }).then(() => true, () => false);
  return ok ? read(page, not) : { ...(await read(page)), noButton: action };
}

export async function probe({ url = `https://${SIGN_HOST}/`, harness = false, site } = {}) {
  const errors = [];
  const record = { key: KEY, url, mode: harness ? "harness" : "live", at: new Date().toISOString(), prf: {}, noPrf: {}, wallet: {}, errors };
  const h = await launch({ harness, site });
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
      const backup = await send(page, "backup.open", { return_key: "settings" });
      p.backup = { answer: backup, page: await read(page, ["signed-in"]) };
      p.backupCancel = await press(page, "cancel", ["backup"]);
      const signout = await send(page, "signout", { return_key: "settings" });
      const soPage = await read(page, ["signed-in"]);
      p.signout = { answer: signout, page: soPage, after: await press(page, "signout", ["signout"]) };
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
      await page.goto(url);
      await read(page);
      const w = record.wallet;
      w.answer = await send(page, "signin.open", { way: "wallet", return_key: "settings" });
      w.choose = await read(page, ["signed-out", "unsupported"]);
      w.existing = await press(page, "have-one", ["choose"]);
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
    console.log(`${KEY}: ${pass ? "PASS" : "FAIL"}`);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
