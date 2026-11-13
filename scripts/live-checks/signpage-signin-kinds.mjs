#!/usr/bin/env node
// Live check of card signpage-signin-kinds: sign-in, sign-out and backup happen only on SIGN_HOST's top-level pages,
// opened by the app by name (docs/plan1/wallet.md §2.8 W:912-914 and §2.2 W:50 at research ffcba5e). Headless
// Chromium opens SIGN_HOST top-level, the shell that frames APP_HOST (card signpage-shell), and posts the kit's open
// kinds from inside the APP_HOST frame, as the terminal does. A CDP virtual authenticator holds the passkeys.
//   prf run (hasPrf true): signin.open {way: passkey} opens the layer on the passkey page; Create signs in and the layer
//     closes, back to the app with a frame again; that frame takes the signed-in state, pools included (live: the
//     deployed terminal's own kit client reaches ready, <html data-signpage>, never down; both: the state the shell
//     answers is signed in, holds pools and passes the kit's client, scripts/signpage-state.mjs). backup.open draws the 12 words in the layer (counted, never read) and
//     Cancel goes back to the app, still signed in. signout opens the sign-out page in the top window (no Sign out in
//     any frame); Sign out deletes the store and goes back to the app, signed out. A
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
//   After each Sign out (prf and no-prf; card sign-out-checks-read-the-store-after-the-reload): the store as the page's
//     reload leaves it, read raw (storeAfter below): no record in any object store but meta's k_wrap and lane,
//     nothing in localStorage, and the K_wrap before the press not the one after.
//   Every press waits out the page's 500 ms activation guard first, which each layer opening restarts.
//   Every screen above opens as a sheet over the app with the APP_HOST frame kept in the page under it (card
//   signing-views-open-over-the-app); none of them has a field typed into, the one kind of screen that takes it out.
// After: sign
// Bundle: out a browser
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
import { CSP } from "./signpage-skeleton.mjs";

const KEY = "signpage-signin-kinds";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "confidential.unrealized.trade";
export const APP_HOST = "ct-app.unrealized.trade";
const APP_STAND_IN = `<!doctype html><title>APP_HOST</title><a href="/">Trenches</a> <button type="button">Sign in</button>`;
const WAIT_MS = 15_000;
const GUARD_MS = 600; // past the page's 500 ms activation guard

// Before SIGN_HOST's own scripts: a wallet that counts what any page asks of it and never answers.
const WALLET_STUB = () => {
  if (location.hostname !== "confidential.unrealized.trade" || window.top !== window) return;
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
  if (location.hostname !== "confidential.unrealized.trade" || window.top !== window) return;
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

// card sign-out-checks-read-the-store-after-the-reload: a sign out is judged by the store after the page's reload
// (keptAfterSignOut, sealProbe, storeAfter below; wallet-passkey-prf.mjs reads its sign outs with them too)
const keptText = (a) => {
  const k = keptAfterSignOut(a);
  return k.length ? `kept: ${k.join("; ")}` : `nothing kept${a?.store?.reloaded ? ", read after the reload" : ""}`;
};

// ------------------------------------------------------------------------------------------------ the store after a sign out
// (card sign-out-checks-read-the-store-after-the-reload) A sign out deletes the database and reloads the page
// (packages/wallet/src/store/index.ts signOut's deleteDatabase, packages/signpage/src/main.ts reloadSignedOut), and the
// new load opens a fresh store with a new K_wrap. So a sign out is judged by what the store holds after that reload, read
// raw in the new document: every object store's record count, meta's keys (only k_wrap may be there), localStorage; and
// whether the K_wrap before it is gone: a fixed block is sealed with it before the press (sealProbe) and opened with the
// K_wrap after it (storeAfter). A new key refuses it; the same key opens it. The key is never exported (it cannot be:
// non-extractable); the block and its ciphertext stay in the check's process and never reach a record.
const PROBE_AAD = "ct/check/k-wrap-probe";
/** Before a sign out's press: marks this document (so the read after waits for the reload's new one) and seals 32 zero
 *  bytes under the store's K_wrap. null when the page has no store or no K_wrap. */
export async function sealProbe(page) {
  return page.evaluate(async (aad) => {
    globalThis.__ctBeforeSignOut = true;
    const req = (x) => new Promise((ok, no) => ((x.onsuccess = () => ok(x.result)), (x.onerror = () => no(x.error))));
    if (!(await indexedDB.databases()).some((d) => d.name === "ct-wallet")) return null;
    const d = await req(indexedDB.open("ct-wallet"));
    try {
      if (!d.objectStoreNames.contains("meta")) return null;
      const key = await req(d.transaction("meta").objectStore("meta").get("k_wrap"));
      if (!(key instanceof CryptoKey)) return null;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, key, new Uint8Array(32));
      return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
    } finally {
      d.close();
    }
  }, PROBE_AAD);
}
/** After a sign out: the store as the reloaded page holds it. { reloaded, db, stores: { name: records }, metaKeys (each
 *  key's id past its first "/" read as "*"),
 *  localStorage, oldKey }: oldKey "refused" (the K_wrap after is a new key), "opened" (the same key), "no-key" (none
 *  after), "not-sealed" (none before). `reloaded`: the marked document was replaced within RELOAD_MS. */
const RELOAD_MS = 8_000;
export async function storeAfter(page, probe) {
  const reloaded = await page
    .waitForFunction(() => {
      const s = document.getElementById("signin")?.dataset.signin;
      return globalThis.__ctBeforeSignOut !== true && !!s && s !== "loading";
    }, null, { timeout: RELOAD_MS })
    .then(() => true, () => false);
  const r = await page.evaluate(async ({ aad, probe }) => {
    const req = (x) => new Promise((ok, no) => ((x.onsuccess = () => ok(x.result)), (x.onerror = () => no(x.error))));
    const ls = localStorage.length;
    if (!(await indexedDB.databases()).some((d) => d.name === "ct-wallet")) return { db: false, stores: {}, metaKeys: [], localStorage: ls, oldKey: probe ? "no-key" : "not-sealed" };
    const d = await req(indexedDB.open("ct-wallet"));
    try {
      const stores = {};
      let metaKeys = [];
      for (const n of Array.from(d.objectStoreNames)) {
        stores[n] = await req(d.transaction(n).objectStore(n).count());
        // a key's own id (meta/deposit/<scope>, owed/<op id>) is never recorded: its kind and a star
        if (n === "meta") metaKeys = (await req(d.transaction(n).objectStore(n).getAllKeys())).map((k) => String(k).replace(/\/.*$/, "/*"));
      }
      let oldKey = "not-sealed";
      if (probe) {
        const key = d.objectStoreNames.contains("meta") ? await req(d.transaction("meta").objectStore("meta").get("k_wrap")) : undefined;
        oldKey = !(key instanceof CryptoKey)
          ? "no-key"
          : await crypto.subtle
            .decrypt({ name: "AES-GCM", iv: new Uint8Array(probe.iv), additionalData: new TextEncoder().encode(aad) }, key, new Uint8Array(probe.ct))
            .then(() => "opened", () => "refused");
      }
      return { db: true, stores, metaKeys, localStorage: ls, oldKey };
    } finally {
      d.close();
    }
  }, { aad: PROBE_AAD, probe });
  return { reloaded, ...r };
}
/** The meta keys a fresh store writes as it opens, and nothing else may be there after a sign out: K_wrap and the
 *  device's lane, the store's own (packages/wallet/src/store/index.ts: "K_wrap and the lane are the store's own"; the lane
 *  drawn anew on the new database, readLane, wrapped under the new K_wrap). */
export const FRESH_META = Object.freeze(["k_wrap", "lane"]);
/** What a sign out left (the step's after: its state, account and store): [] when it left nothing. */
export function keptAfterSignOut(a) {
  const kept = [];
  if (a?.state !== "signed-out") kept.push(`state ${a?.state ?? "none"}`);
  if (a?.account) kept.push("an account shown");
  const st = a?.store;
  if (!st || typeof st.stores !== "object" || st.stores === null || !Array.isArray(st.metaKeys)) return [...kept, "the store not read"];
  for (const [n, c] of Object.entries(st.stores)) if (n !== "meta" && c !== 0) kept.push(`${c} record(s) in ${n}`);
  const extra = st.metaKeys.filter((k) => !FRESH_META.includes(k));
  if (extra.length) kept.push(`meta ${extra.join(", ")}`);
  if (st.stores.meta !== undefined && st.stores.meta !== st.metaKeys.length) kept.push("meta's count and keys disagree");
  if (st.localStorage !== 0) kept.push(`${st.localStorage ?? "?"} localStorage item(s)`);
  if (st.oldKey !== "refused" && st.oldKey !== "no-key") kept.push(`the K_wrap before ${st.oldKey === "opened" ? "still the store's" : `not tried (${st.oldKey ?? "none"})`}`);
  return kept;
}
/** The sign-out reading a judge applies: the store after the page's reload (this card's, every run now), or, for a
 *  record cut before card sign-out-checks-read-the-store-after-the-reload (no store read in it), the reading then: the
 *  database gone (db false), as a page that deleted it and reloaded nothing left it. */
export const SIGN_OUT_NOW = Object.freeze({ signOut: "store" });
export const SIGN_OUT_BEFORE_RELOAD = Object.freeze({ signOut: "db" });
/** Whether a sign out's after (its state, account and store) left nothing, at `era`. */
export const signedOutClean = (a, era = SIGN_OUT_NOW) =>
  era.signOut === "db" ? a?.state === "signed-out" && !a?.account && a?.db === false : keptAfterSignOut(a).length === 0;

// ------------------------------------------------------------------------------------------------ the verdict
const HEX64 = /^[0-9a-f]{64}$/;
export function judge(rec, era = SIGN_OUT_NOW) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = rec.prf ?? {};
  // an open kind's ok answer, exactly: { pending: true }, or since card signing-layer-says-when-it-closes (kit 1.13, the
  // version this probe's hello names) { pending: true, closes: true }; closes false or any other key is no pending
  // answer (signpage-shell.mjs holds the same rule)
  const pending = (a) => {
    const k = a?.ok === true && a.result !== null && typeof a.result === "object" ? Object.keys(a.result).sort().join() : null;
    return a?.ok === true && a.result.pending === true && (k === "pending" || (k === "closes,pending" && a.result.closes === true));
  };
  const refusedNA = (a) => a?.ok === false && a?.error?.code === "not_allowed";
  const inLayer = (x, state) => x?.state === state && x?.layer === "shown" && x?.top === true;
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
  if (era.signOut === "db")
    say(backToApp(so.after, "signed-out") && signedOutClean(so.after, era), `prf: Sign out deletes the store and goes back to the app signed out (${so.after?.state}, store ${so.after?.db ? "kept" : "gone"})`);
  else
    say(backToApp(so.after, "signed-out") && signedOutClean(so.after),
      `prf: Sign out goes back to the app signed out, the store left with no account, no seed, no record and a new K_wrap, nothing in localStorage (${so.after?.state}, ${keptText(so.after)})`);
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
  if (era.signOut === "db") say(backToApp(n.after, "signed-out") && n.after?.db === false, `no-prf: Sign out then deletes the store (${n.after?.state}, store ${n.after?.db ? "kept" : "gone"})`);
  else say(backToApp(n.after, "signed-out") && signedOutClean(n.after), `no-prf: Sign out then leaves the store with nothing but a new K_wrap (${n.after?.state}, ${keptText(n.after)})`);

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
  // card signing-views-open-over-the-app: every screen above opens as a sheet over the app, its frame kept in the page,
  // but the 12 words shown (backup), before which the frame leaves (src/main.ts TYPED) and stays out for the rest of that
  // sheet (Saved going on to the sign-out page)
  // under it (only a screen with a field typed into takes the frame out, and none of these has one)
  const sheets = [p.signin?.page, so.page, so.early, w.choose, w.existing, ex, bk.open];
  const words = [p.backup?.page, n.signout?.page, t.backup?.page, n.saved];
  const kept = sheets.filter((x) => x?.layer === "shown" && x?.frame === true).length;
  const out = words.filter((x) => x?.layer === "shown" && x?.frame === false).length;
  say(kept === sheets.length && out === words.length, `the sheet keeps the app's frame in the page under every screen it draws but the 12 words, and takes it out under those and after them (${kept} of ${sheets.length} kept, ${out} of ${words.length} out)`);
  // the harness maps every name but its own to not found (launch(): MAP * ~NOTFOUND), so a page's reads of outside hosts
  // (public RPCs, the helper) fail there by design: on a harness run those lines alone are not the page's errors. Any
  // other line, and the same line on the live host, still is.
  const errors = Array.isArray(rec.errors) ? rec.errors.filter((e) => !(rec.mode === "harness" && HARNESS_UNRESOLVED.test(e))) : null;
  const skipped = Array.isArray(rec.errors) ? rec.errors.length - errors.length : 0;
  say(errors !== null && errors.length === 0, `no page error or CSP violation (${errors ? errors.length : "no record"})${errors?.length ? `: ${errors.join("; ")}` : ""}`);
  if (skipped) say(true, `harness: ${skipped} console line(s) for outside names it leaves unresolved, not counted`);
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
  // both as served: a path with no file is the index (Pages with no 404.html), so /favicon.ico answers 200 here too
  const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [SIGN_HOST]: { root, spa: true }, [APP_HOST]: { root: app, spa: true } } });
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
/** A console line on the harness for a name it does not serve: the resource failed to resolve, nothing else. */
const UNRESOLVED = /^console: Failed to load resource: net::ERR_NAME_NOT_RESOLVED \((https:\/\/[^/)]+)\/[^)]*\)$/;
/** SIGN_HOST's own connect-src origins, as pinned by its skeleton check (never read from the repo's _headers). */
export const SIGN_CONNECT = new Set(CSP.find(([k]) => k === "connect-src")[1].split(" ").filter((o) => o.startsWith("https://")));
/** A console line on the harness for an outside name it leaves unresolved: a resource of one of the hosts SIGN_HOST may
 *  reach (its connect-src) failed to resolve, nothing else; any other host, or no address, is the page's error. */
export const HARNESS_UNRESOLVED = { test: (e) => SIGN_CONNECT.has(UNRESOLVED.exec(String(e))?.[1] ?? "") };

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

// The APP_HOST frame the shell holds now (kept under the sheet; a new one comes only after a screen with a typed field).
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
  // no frame: a screen with a typed field is open, so no kind can be sent (under any other sheet one goes unread)
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
  // a screen with a typed field takes the frame out as the layer shows; every other keeps it
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
      const sealed = await sealProbe(page);
      p.signout = { answer: signout, page: soPage, early, after: await press(page, "signout", ["signout"]) };
      p.signout.after.store = await storeAfter(page, sealed);
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
      const sealedB = await sealProbe(page);
      n.after = await press(page, "signout", ["signout"]);
      n.after.store = await storeAfter(page, sealedB);
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
