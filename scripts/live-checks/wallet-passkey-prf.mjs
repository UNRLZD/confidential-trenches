#!/usr/bin/env node
// Live check of card wallet-passkey-prf: a user signs in with a passkey whose PRF output unlocks the seed on SIGN_HOST
// (docs/plan1/wallet.md §2.2 :47-56 at research ffcba5e). Headless Chromium with a CDP virtual authenticator (app.md
// 5.0, A:1312) opens SIGN_HOST top-level, twice, each in its own browser (one internal authenticator at a time, P-B):
//   prf run (hasPrf true): the page opens signed out; Create passkey signs in as account A (the profile key T_0 the page
//     shows in data-account); a reload is still A with no sheet (wallet.md:155); Sign out deletes the store
//     (wallet.md:156) and the page is signed out; Use passkey signs in as A again. The one credential's rp.id is
//     SIGN_HOST. Then the check asks the same authenticator for the PRF output itself and derives T_0 with code of its
//     own that shares none with the kit (node:crypto; the BIP-39 list read from bitcoin/bips and pinned by sha256):
//     HKDF-SHA256 to the entropy (wallet.md:47), the 12 words, PBKDF2 to seed64 (:54), HKDF-SHA512 info "profile" ‖ 0
//     to the ed25519 key (:68, :70-88). It must equal A.
//   Also in the prf run: a second tab open before the first passkey is made then presses Create and runs no ceremony
//     (its authenticator makes no passkey), and the stored seed is unchanged; the first tab's Sign out shows signed out
//     in the second; the page framed by APP_HOST (a parent served at APP_HOST's address by this check) shows no sign-in
//     or sign-out control; each signed-in step says code_saved false (data-code-saved, the Backup dot).
//   race run: two tabs, each with its own passkey, press Create at once; both end on one account, the one stored.
//   Sign out's activation guard (Chromium's InputEventActivationProtector, 500 ms): after a reload, a mouse press (the
//     pointer moved onto Sign out and pressed) and Tab then Enter, each within 500 ms of Sign out being drawn on the
//     shown page, do nothing; a press after that signs out.
//   The guard's other triggers, each with Sign out drawn more than 500 ms before: a press (mouse) within 500 ms after a
//     visibilitychange to visible, after a pageshow and after the window gains focus does nothing. visibilitychange and
//     pageshow are dispatched on the page (the listeners read document.visibilityState, which is "visible"); focus is
//     the real one when a second tab brought to the front and back gives it, else dispatched (the record says which).
//     A press after the window then signs out (the Sign out step).
//   phone run (hasTouch, isMobile): a tap within 500 ms of the page shown does nothing; a still tap (touchstart,
//     touchend, no move) after it signs out.
//   Backup gate: a seed record source "random", code_saved false, written under the page's own K_wrap, shows no Sign
//     out (wallet.md:922).
//   In each signed-in step the store is read raw (card wallet-store): K_wrap a non-extractable AES-GCM CryptoKey, the
//     seed record only { iv, ct }, localStorage empty.
//   no-prf run (hasPrf false): Create passkey opens the no-PRF state (data-signin="no-prf"), shows no account and
//     stores no seed: never a silent fallback to another seed.
//   node scripts/live-checks/wallet-passkey-prf.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/wallet-passkey-prf.mjs --harness [--site <dir>] ...   the same steps on the app's browser
//     harness (apps/terminal/test/harness) with SIGN_HOST's real name mapped to it, serving SIGN_HOST's build
//     (index.html and public/, as the deploy copies them) or <dir>, under that build's own _headers
//   PASS exit 0, FAIL exit 1, error exit 2
// Records hold public values only (states, the public account ids, rp ids): never the PRF output, the entropy, the
// words or a key. Every seed is a throwaway virtual authenticator's, never funded and never printed.
import { createHash, createPrivateKey, createPublicKey, hkdfSync, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-passkey-prf";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "sign.confidential.unrealized.trade";
export const APP_HOST = "confidential.unrealized.trade"; // the one parent SIGN_HOST's frame-ancestors allows
const FRAME_PARENT = `<!doctype html><iframe src="https://${SIGN_HOST}/"></iframe>`;
export const PRF_INPUT = "confidential-trenches/v1/seed";
export const WORDLIST_URL = "https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt";
export const WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"; // BIP-39's own pin
const WAIT_MS = 15_000;
export const PROTECT_MS = 500; // Chromium's InputEventActivationProtector default, the page's guard
// Sign out's draw time on the page's own clock: performance.now() when a Sign out button is inserted. Run before the
// page's scripts; a press's distance from it bounds the press's distance from the page's own guard time from above.
// Also the data-action of the last press's target (pointerdown, keydown), so a step shows its press reached Sign out.
const DRAWN = () => {
  for (const t of ["pointerdown", "keydown"])
    addEventListener(t, (e) => (globalThis.__ctPressOn = e.target?.dataset?.action ?? e.target?.nodeName ?? null), true);
  addEventListener("focus", (e) => e.target === window && (globalThis.__ctFocusAt = performance.now()));
  new MutationObserver(() => {
    const b = document.querySelector('[data-action="signout"]');
    if (b && b !== globalThis.__ctSignout) {
      globalThis.__ctSignout = b;
      globalThis.__ctDrawn = performance.now();
    }
  }).observe(document, { childList: true, subtree: true });
};

// ------------------------------------------------------------------------------------------------ the verdict
const HEX64 = /^[0-9a-f]{64}$/;
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = rec.prf ?? {};
  const s = p.steps ?? {};
  const A = s.create?.account;
  say(s.open?.state === "signed-out" && !s.open?.account, `prf: opens signed out (${s.open?.state})`);
  say(s.create?.state === "signed-in" && HEX64.test(A ?? ""), `prf: Create passkey signs in (${s.create?.state}, account ${A ? "shown" : "none"})`);
  say(s.reload?.state === "signed-in" && s.reload?.account === A, `prf: a reload is the same account with no sheet (${s.reload?.state})`);
  say(s.signout?.state === "signed-out" && !s.signout?.account && s.signout?.db === false, `prf: Sign out deletes the store (${s.signout?.state}, store ${s.signout?.db ? "kept" : "gone"})`);
  say(s.signin?.state === "signed-in" && s.signin?.account === A && HEX64.test(A ?? ""), `prf: Use passkey signs in as the same account (${s.signin?.state}, ${s.signin?.account === A ? "same" : "other"})`);
  for (const k of ["create", "reload", "signin"]) {
    const t = s[k] ?? {};
    say(t.seed === true && t.seedWrapped === true && t.kWrap?.cryptoKey === true && t.kWrap?.extractable === false && t.kWrap?.alg === "AES-GCM" && t.localStorage === 0,
      `prf ${k}: the seed record is wrapped ({ iv, ct }) under a non-extractable AES-GCM K_wrap, nothing in localStorage`);
  }
  for (const k of ["create", "reload", "signin"])
    say(s[k]?.codeSaved === "false", `prf ${k}: the seed record says code_saved false, the Backup dot shows (${s[k]?.codeSaved})`);
  const g = p.guard ?? {};
  say(g.open?.state === "signed-out" && g.after?.state === "signed-in" && g.after?.account === A && g.credentials === 0 && !!g.ivBefore && g.ivBefore === g.ivAfter,
    `prf: Create in a second tab with a seed already stored runs no ceremony and keeps the seed (${g.after?.state}, ${g.credentials} new passkey(s), seed ${g.ivBefore && g.ivBefore === g.ivAfter ? "unchanged" : "changed"})`);
  say(p.crossTab?.state === "signed-out" && !p.crossTab?.account, `prf: Sign out in one tab shows signed out in the other (${p.crossTab?.state})`);
  const f = p.framed ?? {};
  say(f.framed === "true" && f.buttons === 0 && f.actions === 0 && typeof f.state === "string",
    `prf: framed by APP_HOST the page shows no sign-in or sign-out control (framed ${f.framed}, ${f.buttons} button(s))`);
  const r = p.race ?? {};
  say(r.a?.state === "signed-in" && r.b?.state === "signed-in" && HEX64.test(r.a?.account ?? "") && r.a?.account === r.b?.account && r.reload?.account === r.a?.account,
    `prf: two tabs that create at once end on one account, the one stored (${r.a?.account && r.a?.account === r.b?.account ? "one" : "two"})`);
  const rps = p.credentials ?? [];
  say(rps.length === 1 && rps[0].rpId === SIGN_HOST, `prf: one passkey, rp.id ${rps.map((c) => c.rpId).join(", ") || "none"}`);
  say(p.prfOk === true && HEX64.test(p.expected ?? "") && p.expected === A, `prf: the account is T_0 of the passkey's PRF output, derived apart from the kit (${p.expected === A ? "equal" : "differs"})`);
  const ignored = (t, who) => t?.pressed === true && t?.pressOn === "signout" && t?.withinMs < PROTECT_MS && t?.after?.state === "signed-in" && t?.after?.account === who && HEX64.test(who ?? "");
  const ms = (t) => (typeof t?.withinMs === "number" ? `${Math.round(t.withinMs)} ms` : "no press");
  const pr = p.protect ?? {};
  say(ignored(pr.mouse, A), `prf: a mouse press within 500 ms of Sign out shown does nothing (${ms(pr.mouse)}, ${pr.mouse?.after?.state})`);
  say(ignored(pr.enter, A), `prf: Tab then Enter within 500 ms of Sign out shown does nothing (${ms(pr.enter)}, ${pr.enter?.after?.state})`);
  const tg = p.triggers ?? {};
  for (const k of ["visibilitychange", "pageshow", "focus"]) {
    const t = tg[k];
    say(ignored(t, A) && t?.sinceDrawMs >= PROTECT_MS,
      `prf: a press within 500 ms after ${k} does nothing (${ms(t)}${t?.kind ? `, ${t.kind}` : ""}, drawn ${typeof t?.sinceDrawMs === "number" ? Math.round(t.sinceDrawMs) : "?"} ms before, ${t?.after?.state})`);
  }
  const ph = rec.phone ?? {};
  const P = ph.create?.account;
  say(ph.create?.state === "signed-in" && HEX64.test(P ?? "") && ph.reload?.account === P, `phone: Create passkey signs in by a tap (${ph.create?.state})`);
  say(ignored(ph.tap, P), `phone: a tap within 500 ms of Sign out shown does nothing (${ms(ph.tap)}, ${ph.tap?.after?.state})`);
  const st = ph.still ?? {};
  say(st.pressed === true && st.pressOn === "signout" && st.withinMs >= PROTECT_MS && st.after?.state === "signed-out" && !st.after?.account && st.after?.db === false,
    `phone: a still tap after 500 ms signs out (${ms(st)}, ${st.after?.state}, store ${st.after?.db ? "kept" : "gone"})`);
  const n = rec.noPrf ?? {};
  const bg = n.backupGate ?? {};
  say(bg.state === "signed-in" && HEX64.test(bg.account ?? "") && bg.signoutButtons === 0 && bg.codeSaved === "false",
    `no-prf: a seed whose 12 words are the only copy and not saved shows no Sign out (${bg.state}, ${bg.signoutButtons} Sign out)`);
  say(n.create?.state === "no-prf" && !n.create?.account && n.create?.seed === false,
    `no-prf: Create passkey opens the no-PRF path (${n.create?.state}, account ${n.create?.account ? "shown" : "none"}, seed ${n.create?.seed ? "stored" : "none"})`);
  say((rec.errors ?? []).length === 0, `no page error or CSP violation (${(rec.errors ?? []).length})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the derivation
let words = null;
export async function wordlist(fetchFn = fetch) {
  if (words) return words;
  const res = await fetchFn(WORDLIST_URL);
  if (!res.ok) throw new Error(`${WORDLIST_URL} answered ${res.status}`);
  const text = await res.text();
  if (createHash("sha256").update(text).digest("hex") !== WORDLIST_SHA256) throw new Error("the BIP-39 list's sha256 is not BIP-39's");
  words = text.trim().split("\n");
  return words;
}
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const edPub = (seed32) =>
  createPublicKey(createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed32]), format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" })
    .subarray(-32);
/** The 16 bytes of entropy from a 32-byte PRF output (wallet.md:47). */
export const entropyOfPrf = (prf) => Buffer.from(hkdfSync("sha256", prf, "confidential-trenches/v1", "wallet/entropy", 16));
/** T_0's id from 16 bytes of entropy (wallet.md:54, :68, :70-88), with node:crypto only. */
export function accountOfEntropy(entropy, list) {
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, "0")).join("") + createHash("sha256").update(entropy).digest()[0].toString(2).padStart(8, "0").slice(0, 4);
  const mnemonic = Array.from({ length: 12 }, (_, i) => list[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]).join(" ");
  const seed64 = pbkdf2Sync(mnemonic.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
  const t0 = Buffer.from(hkdfSync("sha512", seed64, "blindfill/v1", Buffer.concat([Buffer.from("profile"), Buffer.alloc(4)]), 32));
  return edPub(t0).toString("hex");
}
export const accountOfPrf = (prf, list) => accountOfEntropy(entropyOfPrf(prf), list);

// ------------------------------------------------------------------------------------------------ the probe
const playwright = () => createRequire(path.join(REPO, "apps/terminal/package.json"))("playwright");

async function launch({ harness, site }) {
  const { chromium } = playwright();
  if (!harness) return { browser: await chromium.launch(), harnessApp: false, close: async () => {} };
  const { makeCert } = await import("../../apps/terminal/test/harness/certs.mjs");
  const { startServer } = await import("../../apps/terminal/test/harness/server.mjs");
  const { buildSignpage } = await import("../../apps/terminal/test/harness/harness.mjs");
  const root = site ?? buildSignpage();
  // APP_HOST's address serves the framing parent here too: Chromium's local network access checks refuse a public
  // parent framing a host that resolves to this machine, so on the harness both are local.
  const app = mkdtempSync(path.join(tmpdir(), "ct-passkey-app-"));
  writeFileSync(path.join(app, "index.html"), FRAME_PARENT);
  const cert = makeCert([SIGN_HOST, APP_HOST]);
  const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [SIGN_HOST]: { root }, [APP_HOST]: { root: app, spa: true } } });
  const map = [SIGN_HOST, APP_HOST].map((h) => `MAP ${h} 127.0.0.1:${server.port}`).join(", ");
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=${map}, MAP * ~NOTFOUND`, `--ignore-certificate-errors-spki-list=${cert.spki}`],
  });
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

async function authenticator(page, hasPrf) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf, automaticPresenceSimulation: true },
  });
  const creds = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.map((c) => ({ rpId: c.rpId }));
  creds.cdp = cdp;
  return creds;
}

// the page's state once it settles: data-signin and data-account, and whether the store and its seed record exist
async function settled(page) {
  await page.waitForFunction(() => {
    const s = document.getElementById("signin")?.dataset.signin;
    return s && s !== "loading";
  }, null, { timeout: WAIT_MS });
  return page.evaluate(async () => {
    const m = document.getElementById("signin");
    const db = (await indexedDB.databases()).some((d) => d.name === "ct-wallet");
    // the store as stored (card wallet-store, wallet.md:152-154): K_wrap a non-extractable AES-GCM CryptoKey, the seed
    // record only { iv, ct }, nothing in localStorage. Read raw, never decrypted.
    let seed = false;
    let kWrap = null;
    let seedWrapped = null;
    let seedIv = null;
    if (db) {
      const raw = await new Promise((ok) => {
        const r = indexedDB.open("ct-wallet");
        r.onsuccess = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("meta")) return (d.close(), ok({}));
          const os = d.transaction("meta").objectStore("meta");
          const k = os.get("k_wrap");
          const sd = os.get("seed");
          sd.onsuccess = () => (d.close(), ok({ k: k.result, s: sd.result }));
          sd.onerror = () => (d.close(), ok({}));
        };
        r.onerror = () => ok({});
      });
      seed = raw.s !== undefined;
      if (raw.k !== undefined)
        kWrap = { cryptoKey: raw.k instanceof CryptoKey, extractable: raw.k?.extractable ?? null, alg: raw.k?.algorithm?.name ?? null };
      if (seed)
        seedWrapped = !!raw.s && typeof raw.s === "object" && Object.keys(raw.s).sort().join() === "ct,iv" &&
          raw.s.iv instanceof Uint8Array && raw.s.iv.length === 12 && raw.s.ct instanceof ArrayBuffer && raw.s.ct.byteLength > 16;
      if (seedWrapped) seedIv = Array.from(raw.s.iv, (x) => x.toString(16).padStart(2, "0")).join("");
    }
    return { state: m.dataset.signin, account: m.dataset.account ?? null, codeSaved: m.dataset.codeSaved ?? null, db, seed, kWrap, seedWrapped, seedIv, localStorage: localStorage.length };
  });
}
async function click(page, action) {
  const before = await page.evaluate(() => document.getElementById("signin").dataset.signin);
  // a missing or disabled button is a finding, not an error: the step records the state it left
  const clicked = await page.click(`[data-action="${action}"]`, { timeout: WAIT_MS }).then(() => true, () => false);
  if (!clicked) return { ...(await settled(page)), noButton: action };
  await page.waitForFunction((b) => {
    const s = document.getElementById("signin")?.dataset.signin;
    return s && s !== b && s !== "loading";
  }, before, { timeout: WAIT_MS }).catch(() => {});
  return settled(page);
}
function watch(page, errors) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
}

// Reloads until Sign out is drawn, runs press(at) at once and reads how long after the draw it ended (an upper bound of
// the press's distance from the page's guard time); a run that ended past 400 ms is tried again, three times at most.
// A page that signed out is signed in again with the same passkey, so the next step starts signed in.
async function early(page, press) {
  let t = {};
  for (let i = 0; i < 3; i++) {
    await page.reload();
    const b = await page.waitForSelector('[data-action="signout"]', { state: "attached", timeout: WAIT_MS }).catch(() => null);
    if (!b) return { pressed: false, after: await settled(page) };
    const box = await b.boundingBox();
    await press({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const { withinMs, pressOn } = await page.evaluate(() => ({ withinMs: performance.now() - globalThis.__ctDrawn, pressOn: globalThis.__ctPressOn ?? null }));
    await page.waitForTimeout(1_000);
    t = { pressed: true, withinMs, pressOn, after: await settled(page) };
    if (t.after.state === "signed-out") await click(page, "use");
    if (withinMs < 400) break;
  }
  return t;
}

// With Sign out drawn more than 600 ms ago, fires trigger() (which sets __ctTrig, the trigger's time on the page's
// clock), then a mouse click on Sign out at once; reads the press's distance from the trigger (an upper bound) and from
// the draw. A page that signed out is signed in again with the same passkey.
async function afterTrigger(page, trigger) {
  const b = await page.waitForSelector('[data-action="signout"]', { state: "attached", timeout: WAIT_MS }).catch(() => null);
  if (!b) return { pressed: false, after: await settled(page) };
  await page.waitForFunction(() => performance.now() - globalThis.__ctDrawn > 600, null, { timeout: WAIT_MS });
  const kind = await trigger();
  const box = await b.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const m = await page.evaluate(() => ({ withinMs: performance.now() - globalThis.__ctTrig, sinceDrawMs: globalThis.__ctTrig - globalThis.__ctDrawn, pressOn: globalThis.__ctPressOn ?? null }));
  await page.waitForTimeout(1_000);
  const t = { pressed: true, kind, ...m, after: await settled(page) };
  if (t.after.state === "signed-out") await click(page, "use");
  return t;
}

/** One full probe. Returns { record, prf } where prf (hex, in memory only) is for the caller's own parity check. */
export async function probe({ url = `https://${SIGN_HOST}/`, harness = false, site, fetchFn = fetch } = {}) {
  const errors = [];
  const record = { key: KEY, url, mode: harness ? "harness" : "live", at: new Date().toISOString(), prf: {}, phone: {}, noPrf: {}, errors };
  let prfHex = null;
  // prf run
  {
    const h = await launch({ harness, site });
    try {
      const ctx = await h.browser.newContext();
      await ctx.addInitScript(DRAWN);
      const page = await ctx.newPage();
      watch(page, errors);
      const creds = await authenticator(page, true);
      // a second tab, open before the first one makes a passkey: its button must then run no ceremony
      const tab2 = await ctx.newPage();
      watch(tab2, errors);
      const creds2 = await authenticator(tab2, true);
      await page.goto(url);
      await tab2.goto(url);
      const steps = {};
      const guard = {};
      steps.open = await settled(page);
      guard.open = await settled(tab2);
      steps.create = await click(page, "create");
      guard.ivBefore = steps.create.seedIv;
      guard.after = await click(tab2, "create");
      guard.ivAfter = guard.after.seedIv;
      guard.credentials = (await creds2()).length;
      record.prf.guard = guard;
      await page.reload();
      steps.reload = await settled(page);
      // within 500 ms of Sign out drawn on the shown page (a reload), a press does nothing: the pointer moved onto it and
      // pressed (a hand already moving as a lined-up double click lands), and Tab then Enter
      record.prf.protect = {
        mouse: await early(page, async (at) => {
          await page.mouse.move(at.x - 30, at.y - 20);
          await page.mouse.move(at.x, at.y, { steps: 4 });
          await page.mouse.down();
          await page.mouse.up();
        }),
        enter: await early(page, async () => {
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
        }),
      };
      // the guard's other triggers, with Sign out drawn well before each
      record.prf.triggers = {
        visibilitychange: await afterTrigger(page, () =>
          page.evaluate(() => {
            globalThis.__ctTrig = performance.now();
            document.dispatchEvent(new Event("visibilitychange"));
            return `dispatched, visibilityState ${document.visibilityState}`;
          }),
        ),
        pageshow: await afterTrigger(page, () =>
          page.evaluate(() => {
            globalThis.__ctTrig = performance.now();
            dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            return "dispatched";
          }),
        ),
        focus: await afterTrigger(page, async () => {
          const before = await page.evaluate(() => globalThis.__ctFocusAt ?? null);
          const other = await ctx.newPage();
          await other.bringToFront();
          await page.bringToFront();
          await other.close();
          return page.evaluate((b) => {
            const at = globalThis.__ctFocusAt ?? null;
            if (at !== null && at !== b) {
              globalThis.__ctTrig = at;
              return "real (another tab to the front and back)";
            }
            globalThis.__ctTrig = performance.now();
            dispatchEvent(new FocusEvent("focus"));
            return "dispatched";
          }, before);
        }),
      };
      await page.waitForTimeout(PROTECT_MS + 200);
      steps.signout = await click(page, "signout");
      // the other tab hears the sign out
      await tab2.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-out", null, { timeout: WAIT_MS }).catch(() => {});
      record.prf.crossTab = await tab2.evaluate(() => ({ state: document.getElementById("signin").dataset.signin, account: document.getElementById("signin").dataset.account ?? null }));
      steps.signin = await click(page, "use");
      record.prf.steps = steps;
      // framed by APP_HOST: the parent is a page this check serves at APP_HOST's address; the frame is SIGN_HOST itself
      const APP = `https://${APP_HOST}/__wallet-passkey-prf-frame`;
      if (!h.harnessApp) await ctx.route(APP, (rt) => rt.fulfill({ status: 200, contentType: "text/html", body: FRAME_PARENT }));
      const parent = await ctx.newPage();
      watch(parent, errors);
      await parent.goto(APP);
      const frame = await (await parent.waitForSelector("iframe", { timeout: WAIT_MS })).contentFrame();
      await frame.waitForFunction(() => {
        const st = document.getElementById("signin")?.dataset.signin;
        return st && st !== "loading";
      }, null, { timeout: WAIT_MS }).catch(() => {});
      record.prf.framed = await frame.evaluate(() => {
        const m = document.getElementById("signin");
        return { framed: m?.dataset.framed ?? null, state: m?.dataset.signin ?? null, buttons: document.querySelectorAll("button").length, actions: document.querySelectorAll("[data-action]").length };
      }).catch(() => ({}));
      await parent.close();
      record.prf.credentials = await creds();
      const out = await page.evaluate(async (input) => {
        const c = await navigator.credentials.get({
          publicKey: { rpId: location.hostname, challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [], userVerification: "required", extensions: { prf: { eval: { first: new TextEncoder().encode(input) } } } },
        });
        const f = c.getClientExtensionResults().prf?.results?.first;
        return f ? Array.from(new Uint8Array(f), (x) => x.toString(16).padStart(2, "0")).join("") : null;
      }, PRF_INPUT).catch(() => null);
      record.prf.prfOk = typeof out === "string" && out.length === 64;
      if (record.prf.prfOk) {
        prfHex = out;
        record.prf.expected = accountOfPrf(Buffer.from(out, "hex"), await wordlist(fetchFn));
      }
    } finally {
      await h.close();
    }
  }
  // race: two tabs, each with its own passkey, press the button at once; one seed is stored and both show it
  {
    const h = await launch({ harness, site });
    try {
      const ctx = await h.browser.newContext();
      const [a, b] = [await ctx.newPage(), await ctx.newPage()];
      for (const t of [a, b]) {
        watch(t, errors);
        await authenticator(t, true);
        await t.goto(url);
        await settled(t);
      }
      const [ra, rb] = await Promise.all([click(a, "create"), click(b, "create")]);
      await a.reload();
      record.prf.race = { a: ra, b: rb, reload: await settled(a) };
    } finally {
      await h.close();
    }
  }
  // phone run: a touch screen (hasTouch, isMobile). A tap within 500 ms of Sign out shown does nothing; a still tap
  // (touchstart, touchend, no move) after it signs out.
  {
    const h = await launch({ harness, site });
    try {
      const ctx = await h.browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
      await ctx.addInitScript(DRAWN);
      const page = await ctx.newPage();
      watch(page, errors);
      const creds = await authenticator(page, true);
      const touch = (type, points) => creds.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      await page.goto(url);
      await settled(page);
      const phone = {};
      const tap = async () => {
        const before = await page.evaluate(() => document.getElementById("signin").dataset.signin);
        await page.tap('[data-action="create"]', { timeout: WAIT_MS }).catch(() => {});
        await page.waitForFunction((b) => document.getElementById("signin")?.dataset.signin !== b, before, { timeout: WAIT_MS }).catch(() => {});
        return settled(page);
      };
      phone.create = await tap();
      await page.reload();
      phone.reload = await settled(page);
      // a finger's tap, 2 px of drift, within 500 ms of Sign out drawn on the shown page
      phone.tap = await early(page, async (at) => {
        await touch("touchStart", [at]);
        await touch("touchMove", [{ x: at.x + 2, y: at.y + 1 }]);
        await touch("touchEnd", []);
      });
      // a still tap once 500 ms have passed
      await page.reload();
      const b = await page.waitForSelector('[data-action="signout"]', { state: "attached", timeout: WAIT_MS }).catch(() => null);
      if (b) {
        const box = await b.boundingBox();
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.waitForTimeout(PROTECT_MS + 300);
        const withinMs = await page.evaluate(() => performance.now() - globalThis.__ctDrawn);
        await touch("touchStart", [at]);
        await touch("touchEnd", []);
        const pressOn = await page.evaluate(() => globalThis.__ctPressOn ?? null);
        await page.waitForFunction(() => document.getElementById("signin")?.dataset.signin === "signed-out", null, { timeout: 3_000 }).catch(() => {});
        phone.still = { pressed: true, withinMs, pressOn, after: await settled(page) };
      } else phone.still = { pressed: false, after: await settled(page) };
      record.phone = phone;
    } finally {
      await h.close();
    }
  }
  // no-prf run
  {
    const h = await launch({ harness, site });
    try {
      const page = await (await h.browser.newContext()).newPage();
      watch(page, errors);
      await authenticator(page, false);
      await page.goto(url);
      record.noPrf.open = await settled(page);
      record.noPrf.create = await click(page, "create");
      // a seed whose 12 words are the only copy and not saved (source "random", code_saved false), as a no-PRF card
      // will store it, written under the page's own K_wrap with the store's record form: no Sign out is drawn
      await page.evaluate(async () => {
        const db = await new Promise((ok, no) => {
          const r = indexedDB.open("ct-wallet");
          r.onsuccess = () => ok(r.result);
          r.onerror = () => no(r.error);
        });
        const get = (k) => new Promise((ok) => { const g = db.transaction("meta").objectStore("meta").get(k); g.onsuccess = () => ok(g.result); });
        const kWrap = await get("k_wrap");
        const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
        const plain = new TextEncoder().encode(JSON.stringify({ v: 1, entropy: { $bytes: hex }, source: "random", code_saved: false, created_ms: Date.now() }));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("ct/v1/seed") }, kWrap, plain);
        await new Promise((ok) => { const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put({ iv, ct }, "seed"); tx.oncomplete = ok; });
        db.close();
      });
      await page.reload();
      const gate = await settled(page);
      gate.signoutButtons = await page.locator('[data-action="signout"]').count();
      record.noPrf.backupGate = gate;
    } finally {
      await h.close();
    }
  }
  return { record, prf: prfHex };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const harness = args.includes("--harness");
    const origin = opt("--url");
    const { record } = await probe({ harness, site: opt("--site"), url: origin ? `${origin.replace(/\/$/, "")}/` : undefined });
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
