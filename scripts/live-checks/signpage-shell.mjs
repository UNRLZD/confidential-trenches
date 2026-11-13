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
//   - Chromium only (its virtual authenticator, no PRF): signin.open {way: passkey} is answered pending and the layer
//     opens (as a sheet over the app, the frame kept in the page under it since card signing-views-open-over-the-app,
//     whose own checks pin that; before it, the frame left the document); Create passkey lands on the backup screen;
//     Saved signs in, the layer closes and the frame answers signed in, way passkey, code_saved true (the kept frame, or
//     before that card a new one); this tab's own Sign out (the app's signout, answered pending, and the sign-out
//     page's button) reloads the top window, whose new frame posts ready and answers exactly signed out within RELOAD_MS
//     (card sign-out-stops-the-pages-reads; a run recorded before that card signed out in another tab instead, the old
//     frame getting exactly signed out);
//   - signin.open {way: words} the same; then the test words (the a8 vector's entropy, all zero: BIP-39's first
//     published vector) are typed with trusted keys while the APP_HOST page calls focus() on its own input every 20 ms:
//     the field is clicked and typed into as soon as it shows (trusted keys on Chromium and Firefox; on WebKit each
//     character goes to the top document's focus, so a frame holding it keeps it from the field; the frame leaves in
//     the open's own task, before the field exists); the shell's field holds all 12 words and the app none (its count of characters only); Continue signs
//     in, the layer closes, and the new frame answers signed in, way words, code_saved true (typed words are stored
//     saved, words.ts ses.12);
//   - nav {path}: answered ok, the top window's address becomes SIGN_HOST with that path and query, no navigation; nav
//     with "//evil.example/x" refused not_allowed, the address unchanged;
//   - reload {}: answered ok, the top window reloads at the app's path: signed in, layer closed, and the new frame,
//     at APP_HOST with that path, answers signed in, way words, code_saved true;
//   - a database from before the status record (the status deleted raw): the frame answers signed in with no way and
//     code_saved false; the shell loads again, and its backfill (main.ts, syncStatus) brings way words and code_saved
//     true to the new frame, in its first answer or a state event within EVENT_MS of it; a sign out in another tab
//     (the store's "signout" on its channel and the database's delete, in one task) then reloads the top window the
//     same way (a run recorded before that card: the old frame gets exactly signed out); Chromium only, a second
//     passkey account lands after it and signs out by this tab's button, and from the words' sign out's new document on
//     no request names an address or id the words' account's requests to the pinned hosts carried (none that the first
//     account's requests or the page's own code carry; a live run must find at least one); a state asked again
//     answers signed out;
//   - an open kind (signin.open, signout) is answered exactly { pending: true }, or since card
//     signing-layer-says-when-it-closes (kit 1.13, the version this probe's hello names) exactly { pending: true,
//     closes: true }; closes false or any other key is BAD;
//   - every message the frame gets is ready, an answer, a state event or a closed notice ({ v: 1, type: "closed", id },
//     once, for an open answered closes: true), each state exact. That the notice reaches the app is not judged here:
//     every open this run makes ends with the app's document gone (the typed words take the frame out, a passkey
//     Saved loads the frame again, a sign out reloads the top window), the one ending the page tells nothing of;
//   - the frame cannot be sent to another origin: set to https://example.com, no request for it is made (CSP frame-src);
//   - no request goes to any host but SIGN_HOST and APP_HOST, but a pinned pool's host while signed in (below).
// Each event must come within EVENT_MS of its step. The APP_HOST page is this check's own (APP_PAGE): it speaks the
// kit's messages to its parent as app-in-shell's parent mode does, and reports what it gets to the check. A build with
// no shell (main's: SIGN_HOST framed by APP_HOST) is read the old way, so its recorded run shows what that frame reads:
// after the same sign-in, an APP_HOST page framing SIGN_HOST asks its state.
// After: sign --engine chromium --live --width phone
// After: sign --engine chromium --live --width desktop
// After: sign --engine firefox --live --width phone
// After: sign --engine firefox --live --width desktop
// Bundle: out a browser (its harness run is in test-browser: SIGN_HOST from this tree's build, Chromium at phone width; its Firefox and desktop runs are the live host's, Firefox's build is not on that runner)
//   node scripts/live-checks/signpage-shell.mjs --engine webkit|chromium|firefox [--width phone|desktop] [--site <dir>] [--record <file>]
//     at 390 x 844 (phone, the iPhone case) or 1440 x 900 (desktop, the default); the record names the width and the
//     top window's own width as read
//     the harness: SIGN_HOST from packages/signpage's committed build (or <dir>) under its own _headers, APP_HOST from
//     APP_PAGE, both on their real names with nothing on the network
//   node scripts/live-checks/signpage-shell.mjs --engine chromium|firefox --live [--width phone|desktop] [--record <file>]
//     the deployed SIGN_HOST, with APP_HOST answered by APP_PAGE
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the test can replay it.
// No money; the account is the published test vector's, thrown away with the profile. Since card
// sign-live-checks-read-a-pinned-page the page pins the mainnet Solana pool, so live, signed in, it reads that pool, its
// price and the restore's first reads on PINNED_HOSTS (the helper, the Solana pair, the NEAR pair, and since release
// 119 the Base and Robinhood pools' lists): those requests go
// to the network and are recorded with what each asks; signed out none may leave the two hosts, signed in none may go
// to a host that is not pinned or that the page's served connect-src does not name. On the harness they are refused.
import "../net-window.mjs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNPAGE_IFRAME_ATTRIBUTES, SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";
import { browserLabel, launchBrowser } from "../browsers.mjs";
import { launchHarnessBrowser } from "../harness-sockets.mjs";
import { kitTakesState } from "../signpage-state.mjs";
import { named } from "./record-names.mjs";

const KEY = "signpage-shell";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SIGN_HOST = "confidential.unrealized.trade";
export const APP_HOST = "ct-app.unrealized.trade";
const SIGN = `https://${SIGN_HOST}`;
const APP = `https://${APP_HOST}`;
/** The hosts the mainnet page's pinned Solana pool reads on (card sign-live-checks-read-a-pinned-page): the helper
 *  (packages/signpage/src/trade.ts TRADE_HELPER: its keyed Solana seat and the marks route), Solana provider A and the
 *  U_X pair's second operator (trade.ts SOLANA_PROVIDER_A, pool-restore.ts RESTORE_UX_SOLANA), and the NEAR pair step 5
 *  reads deposit ids on (the kit's NEAR_NETWORKS.mainnet: fastnear[0] and drpc); since the Base and Robinhood pools are
 *  pinned on mainnet too (card evm-pools-on-mainnet, release 119), each EVM pool's list the page reads it on
 *  (packages/signpage/src/pool-testnet.ts MAINNET_POOL_RPCS). signpage-shell.test.mjs holds the list to those sources. */
export const PINNED_HOSTS = Object.freeze([
  "ct-api.unrealized.trade", "solana-rpc.publicnode.com", "solana.api.pocket.network", "rpc.mainnet.fastnear.com", "near.drpc.org",
  "base-rpc.publicnode.com", "base.api.pocket.network", "rpc.mainnet.chain.robinhood.com", "robinhood.api.pocket.network",
]);
/** The hosts a CSP's connect-src names (https sources only). */
export const connectHosts = (csp) => {
  const d = String(csp).split(";").map((x) => x.trim().split(/\s+/)).find((x) => x[0] === "connect-src") ?? [];
  return d.slice(1).filter((x) => x.startsWith("https://")).map((x) => new URL(x).host);
};
const STRANGER = "https://example.com/";
/** The path and query the shell is opened on; the frame must carry exactly these. */
export const START = "/token/solana/So11111111111111111111111111111111111111112?tab=trades&from=shell";
export const ENGINES = ["webkit", "chromium", "firefox"];
export const WIDTHS = { phone: { width: 390, height: 844, dpr: 2 }, desktop: { width: 1440, height: 900, dpr: 1 } };
export const EVENT_MS = 3_000;
/** From a sign out's tap or post to the new frame's ready after the top window's reload. */
export const RELOAD_MS = 10_000;
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
const isClosed = (d) => isObj(d) && d.v === 1 && d.type === "closed" && typeof d.id === "string" && sameKeys(d, ["v", "type", "id"]);
const isRefusal = (d) => isObj(d) && d.v === 1 && typeof d.id === "string" && d.ok === false && sameKeys(d, ["v", "id", "ok", "error"]);

/** The addresses and ids a recorded request carries in its path, query or calls: hex of 40 digits or more (an EVM
 *  address, a 32-byte id, a call's data), lowercased, and base58 of 32 to 44 (a Solana address). */
export function namesIn(x) {
  const text = JSON.stringify([x?.path ?? "", x?.query ?? "", x?.rpc ?? null]);
  return (text.match(/0x[0-9a-fA-F]{40,}|[0-9a-fA-F]{64,}|[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []).map((n) => (/^(0x)?[0-9a-fA-F]+$/.test(n) ? n.toLowerCase().replace(/^0x/, "") : n));
}

/** Every name the page's own code holds (the pools' addresses, the mints, the feeds): public, never an account's. */
const CODE_NAMES = (() => {
  const out = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|json)$/.test(e.name)) for (const n of namesIn({ path: readFileSync(p, "utf8") })) out.add(n);
    }
  };
  for (const pkg of ["kit", "wallet", "signpage"]) walk(path.join(REPO, "packages", pkg, "src"));
  return out;
})();

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
  // an open kind's ok answer: { pending: true }, or since card signing-layer-says-when-it-closes (kit 1.13) to an app
  // that said hello as 1.13 or later { pending: true, closes: true } (the kit's schema takes closes only as true);
  // closes false or any other key is no pending answer
  const pending = (id) => {
    const r = result(id);
    return (sameKeys(r, ["pending"]) || (sameKeys(r, ["pending", "closes"]) && r.closes === true)) && r.pending === true;
  };
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

  // one ready per load of the frame: the open, each close of the layer that made a new frame (Saved's close keeps the
  // frame under the sheet since card signing-views-open-over-the-app: no load there), the reload and the backfill.
  // The stranger step comes after: WebKit fires a load on the frame for the navigation its CSP refuses.
  // A run recorded since card sign-out-stops-the-pages-reads names how its words' sign out was made (`by`): there every
  // landed sign out reloads the top window, so each is a frame load too, and a second passkey account follows on
  // Chromium. An older record is read as it was recorded.
  const reloads = isObj(st.wordsOut) && Object.hasOwn(st.wordsOut, "by");
  const chrome = rec.engine === "chromium";
  const loads = (reloads
    ? [-Infinity, ...(chrome ? [...(st.saved?.kept !== true ? [st.saved?.t] : []), st.passkeyOut?.t] : []), st.words?.t, st.reload?.t, st.backfill?.t, st.wordsOut?.t,
      ...(chrome ? [...(st.saved2?.kept !== true ? [st.saved2?.t] : []), st.passkeyOut2?.t] : []), st.stranger?.t ?? Infinity]
    : [-Infinity, ...(chrome && st.saved?.kept !== true ? [st.saved?.t] : []), st.words?.t, st.reload?.t, st.backfill?.t, st.stranger?.t ?? Infinity]).map((t) => t ?? Infinity);
  const perLoad = loads.slice(0, -1).map((t, i) => msgs.filter((m) => isObj(m.data) && m.data.type === "ready" && m.t >= t && m.t < loads[i + 1]).length);
  say(perLoad.every((n) => n === 1), `the frame gets one ready per frame load before the stranger step (${perLoad.join(", ")})`);
  say(signedOut(result(st.first?.id)), `the first state answer is exactly the signed-out state (${show(result(st.first?.id))})`);

  // the words' screen has a field typed into: the frame leaves the document (packages/signpage/src/shell.ts seal); the
  // passkey screen has none: the sheet keeps the frame under it (0 frames on a build before that card). The answer is
  // posted before the frame leaves (src/api.ts `then`), but a frame taken out may go before it reads it ("may reach the
  // app before it leaves; nothing waits on it", src/shell.ts): with the frame out, no answer at all is that race, never a
  // fault; an answer that came must be pending (card ci-stops-costing-reruns)
  const opened = (s, label, frames) =>
    say((pending(s?.openId) || (!frames.includes(1) && s?.layer?.frames === 0 && !answer(s?.openId))) && s?.layer?.layerHidden === false && frames.includes(s?.layer?.frames),
      `signin.open ${label}: answered pending${frames.includes(1) ? "," : ", or not at all once the frame left first;"} the layer opens${frames.includes(1) ? "" : " and the frame leaves the document"} (${answer(s?.openId) ? JSON.stringify(answer(s.openId).data.ok ? result(s.openId) : answer(s.openId).data.error) : "no answer"}, layer ${s?.layer?.layerHidden === false ? "open" : "closed"}, ${s?.layer?.frames ?? "?"} frames)`);
  const signedOutEvent = (s, label, want) => {
    if (reloads) {
      // the top window is a new document begun after the sign out, and its new frame posts ready and answers exactly
      // signed out: the app comes back signed out, with no frame left that does not answer
      const r = typeof s?.doc === "number" ? msgs.find((m) => m.t >= s.doc && isObj(m.data) && m.data.type === "ready") : null;
      const by = s?.by === want && (want === "channel" || pending(s?.openId));
      say(by && s?.top?.state === "signed-out" && !!r && r.t - s.t <= RELOAD_MS && signedOut(result(s?.id)),
        `${label}: the top window reloads and its new frame answers exactly signed out (${s?.by === "button" ? `signout ${pending(s?.openId) ? "answered pending" : "not answered pending"}, ` : ""}${s?.top?.state ?? "none"}, ${typeof s?.doc === "number" ? `a new document ${s.doc - s.t} ms after it` : "no new document"}, ${r ? `the new frame's ready ${r.t - s.t} ms after it` : "no new frame's ready"}, ${show(result(s?.id))})`);
      return;
    }
    const e = eventAfter(rec, s?.t, (x) => x.signed_in === false);
    say(s?.top?.state === "signed-out" && !!e && e.ms <= EVENT_MS && signedOut(e.state),
      `${label}: the frame gets exactly the signed-out state (${s?.top?.state ?? "none"}, ${show(e?.state)}${e ? `, ${e.ms} ms` : ""})`);
  };
  if (rec.engine === "chromium") {
    opened(st.passkeyIn, "passkey", [0, 1]);
    say(st.created?.top?.state === "backup", `Create passkey with no PRF lands the shell on the backup screen (${st.created?.top?.state ?? "none"})`);
    const s = st.saved;
    say(s?.top?.state === "signed-in" && s?.top?.layerHidden === true && full("passkey")(result(s?.id)),
      `Saved: the layer closes and the ${s?.kept === true ? "kept" : "new"} frame answers signed in, way passkey, code_saved true (${s?.top?.state ?? "none"}, layer ${s?.top?.layerHidden ? "closed" : "open"}, ${show(result(s?.id))})`);
    if (reloads) signedOutEvent(st.passkeyOut, "Sign out in this tab, by its own Sign out button", "button");
    else signedOutEvent(st.passkeyOut, "Sign out in another tab");
  }
  const w = st.words;
  opened(st.wordsIn, "words", [0]);
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
  signedOutEvent(st.wordsOut, "Sign out in another tab", "channel");
  if (reloads) {
    if (chrome) {
      opened(st.passkeyIn2, "passkey, a second account", [0, 1]);
      const s2 = st.saved2;
      say(st.created2?.top?.state === "backup" && s2?.top?.state === "signed-in" && full("passkey")(result(s2?.id)),
        `a second passkey account lands after it: Create passkey, then Saved, and the frame answers signed in, way passkey, code_saved true (${st.created2?.top?.state ?? "none"}, ${s2?.top?.state ?? "none"}, ${show(result(s2?.id))})`);
      signedOutEvent(st.passkeyOut2, "the second passkey account's Sign out in this tab", "button");
    }
  }
  say(signedOut(result(st.last?.id)), `a state asked again answers signed out (${show(result(st.last?.id))})`);

  // a state is an event's, or an answer's whose result says signed_in (nav, reload and signin.open answer others)
  const states = msgs.flatMap((m) => (isEvent(m.data) ? [m.data.state] : isAnswer(m.data) && isObj(m.data.result) && Object.hasOwn(m.data.result, "signed_in") ? [m.data.result] : []));
  // a closed notice (card signing-layer-says-when-it-closes) is the type and an id alone, for an open answered
  // closes: true, once per open; any other is another message
  const closing = new Set(msgs.filter((m) => isAnswer(m.data) && sameKeys(m.data.result, ["pending", "closes"])).map((m) => m.data.id));
  const told = new Set();
  const closedOk = (d) => isClosed(d) && closing.has(d.id) && !told.has(d.id) && !!told.add(d.id);
  const other = msgs.filter((m) => !isEvent(m.data) && !isAnswer(m.data) && !isRefusal(m.data) && m.data?.type !== "ready" && !closedOk(m.data));
  say(states.length >= 4 && states.every(exactState) && other.length === 0,
    `every message is ready, an answer, a state event or one closed notice for an open answered closes, each state exact (${states.length} states, ${told.size} closed, ${other.length} other)`);
  const strayFrame = (rec.requests ?? []).filter((x) => x.host === new URL(STRANGER).host);
  say(st.stranger?.done === true && strayFrame.length === 0,
    `the frame cannot be sent to ${STRANGER} (${st.stranger?.done ? `${strayFrame.length} requests for it` : "not tried"})`);
  // the pinned pool's hosts are asked only while a seed is held (card sign-live-checks-read-a-pinned-page: the price, the
  // Rent and the pool's reads, the restore's): from Create passkey to its sign out (Chromium), and from the words'
  // Continue to their sign out; a request at no time of the run counts as signed out
  const reqs = rec.requests ?? [];
  // this tab's own sign out holds the seed until the store's lock is taken (a run holding it finishes first), so its
  // window ends where the top window's new document begins
  const held = reloads
    ? [...(chrome ? [[st.created?.t, st.passkeyOut?.doc ?? st.passkeyOut?.t]] : []), [st.words?.t, st.wordsOut?.t], ...(chrome ? [[st.created2?.t, st.passkeyOut2?.doc ?? st.passkeyOut2?.t]] : [])]
    : [...(chrome ? [[st.created?.t, st.passkeyOut?.t]] : []), [st.words?.t, st.wordsOut?.t]];
  const signedIn = (x) => typeof x.t === "number" && held.some(([a, b]) => typeof a === "number" && typeof b === "number" && x.t >= a && x.t < b);
  const pinned = (x) => PINNED_HOSTS.includes(x.host);
  const stray = reqs.filter((x) => x.host !== SIGN_HOST && x.host !== APP_HOST && !pinned(x));
  say(stray.length === 0, `no request leaves SIGN_HOST and APP_HOST but for the pinned pool's hosts (${stray.length}${stray.length ? `: ${stray.slice(0, 4).map((x) => x.host).join(", ")}` : ""})`);
  const out = reqs.filter((x) => pinned(x) && !signedIn(x));
  const connect = Array.isArray(rec.connect) ? rec.connect : [];
  const unlisted = [...new Set(reqs.filter((x) => pinned(x) && !connect.includes(x.host)).map((x) => x.host))];
  const ins = reqs.filter((x) => pinned(x) && signedIn(x));
  say(out.length === 0 && unlisted.length === 0,
    `signed out, no request goes past SIGN_HOST and APP_HOST; signed in, only to a pinned pool's host the page's own connect-src names (${out.length} signed out${out.length ? `: ${out.slice(0, 4).map((x) => `${x.host}${x.path}`).join(", ")}` : ""}; ${ins.length} signed in${ins.length ? ` to ${[...new Set(ins.map((x) => x.host))].join(", ")}` : ""}${unlisted.length ? `; not in its connect-src: ${unlisted.join(", ")}` : ""})`);
  if (reloads && chrome) {
    // the words' account's names: each address or id its signed-in requests to the pinned hosts carry that no request
    // before it carried (the first passkey account's, the page's constants). From its sign out's new document on, no
    // request of any host may carry one: no read of that account outlives its sign out into the next one's.
    const words0 = st.words?.t;
    const words1 = st.wordsOut?.doc;
    const before = new Set(reqs.filter((x) => pinned(x) && x.t < words0).flatMap(namesIn));
    const own = new Set(reqs.filter((x) => pinned(x) && x.t >= words0 && x.t < words1).flatMap(namesIn).filter((n) => !before.has(n) && !CODE_NAMES.has(n)));
    const later = typeof words1 === "number" ? reqs.filter((x) => typeof x.t === "number" && x.t >= words1) : [];
    const named = later.filter((x) => namesIn(x).some((n) => own.has(n)));
    // a live run must find some (the restore's reads name the account's ids); on the harness those reads are refused
    // before the walk derives any, so a harness run may find none
    const live = String(rec.source ?? "").startsWith("live ");
    say(typeof words1 === "number" && (own.size > 0 || !live) && named.length === 0,
      `after the words' account signs out and a second account lands, no request names the words' account (${own.size} of its addresses and ids; ${later.length} requests after its sign out, ${named.length} naming one${named.length ? `: ${named.slice(0, 3).map((x) => `${x.host} ${x.rpc?.map((c) => c.method).join("+") ?? x.path}`).join(", ")}` : ""})`);
  }
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
  return (host, pathAndQuery, method = "GET", body = null) => {
    requests.push({ t: Date.now(), host, path: pathAndQuery.split("?")[0], method, ...(pathAndQuery.includes("?") ? { query: pathAndQuery.split("?").slice(1).join("?") } : {}), ...(body !== null ? { rpc: rpcOf(body) } : {}) });
    if (host === SIGN_HOST && sign) return sign(decodeURIComponent(pathAndQuery.split("?")[0]));
    if (host === APP_HOST) return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `frame-ancestors ${SIGN}` }, body: APP_PAGE };
    return null;
  };
}

/** What a request body asks: each JSON-RPC call's method and params (the body as text when it is not JSON-RPC). */
export function rpcOf(body) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return { text: String(body).slice(0, 300) };
  }
  const one = (c) => (isObj(c) && typeof c.method === "string" ? { method: c.method, params: c.params ?? null } : { text: JSON.stringify(c).slice(0, 300) });
  return Array.isArray(j) ? j.map(one) : [one(j)];
}

// ------------------------------------------------------------------------------------------------ the engines
/** Playwright's Chromium or Firefox behind one driver shape (WebKit's is scripts/webkit-harness's). */
async function playwrightDriver(engine, serve, live, size, launch) {
  const browser = await launch(engine);
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
    // the pinned pool's hosts, live only: recorded with what each asks (rpcOf), then sent
    if (live && PINNED_HOSTS.includes(u.host)) {
      serve(u.host, u.pathname + u.search, r.request().method(), r.request().postData());
      return r.continue();
    }
    // what each asks is recorded on the harness too, though only SIGN_HOST and APP_HOST are answered there
    const a = serve(u.host, u.pathname + u.search, r.request().method(), r.request().postData());
    if (!a) return r.abort("blockedbyclient");
    return r.fulfill({ status: a.status, headers: a.headers, body: a.body });
  });
  const page = await ctx.newPage();
  // the CSP SIGN_HOST's first top-level answer carries (live: the deployed page's own)
  let csp = null;
  page.on("response", (res) => {
    if (csp === null && res.request().isNavigationRequest() && res.frame() === page.mainFrame()) csp = res.headers()["content-security-policy"] ?? "";
  });
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
    csp: () => csp,
    close: () => browser.close(),
  };
}

async function driverFor(engine, serve, live, size, launch) {
  if (engine === "webkit") {
    if (live) throw new Error("--live runs on chromium or firefox; WebKit runs on the harness");
    const { launchWebKit } = await import("../webkit-harness/index.mjs");
    const d = await launchWebKit({ serve: (host, pq, method) => serve(host, pq, method), width: size.width, height: size.height });
    // typing: the driver's native keyDown/keyUp per character, 30 ms apart, to whatever holds the page's focus
    return d;
  }
  return playwrightDriver(engine, serve, live, size, launch);
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

// `launch`: the browser's start. On the harness it is the harness browser (scripts/harness-sockets.mjs): every socket
// and every request this run's own route lets through is the harness's to judge, so a page that reaches a host the
// run does not answer fails the run; live, the plain launcher, whose pinned hosts are the network's.
export async function collect({ engine, site, live, width = "desktop", launch = live ? launchBrowser : launchHarnessBrowser }) {
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
  const d = await driverFor(engine, serveWith(sign, requests), live, size, launch);
  const rec = { engine, view: { name: width, width: size.width, height: size.height, inner: null }, source: live ? `live ${SIGN}` : `harness, SIGN_HOST from ${site ? named(site) : "packages/signpage's committed build"}`, at: new Date().toISOString(), browser: d.version, topology: null, steps: {}, messages: [], requests, connect: null, errors: [] };
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
  // a sheet with no typed field closed (card signing-views-open-over-the-app): the frame it kept asks, with no new load;
  // a build that still makes a new frame there gives its ready, as newFrameAsks
  const closedFrameAsks = async (s) => {
    s.kept = !(await until(async () => msgs().some((m) => m.t >= s.t && m.data?.type === "ready"), 2_000));
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
    const want = way === "words" ? 0 : 1; // a typed field takes the frame out; the passkey screen keeps it
    const layer = await until(async () => { const l = await top("loading"); return l.layerHidden === false && l.frames === want ? l : null; }, 3_000) ?? (await top("loading"));
    return { openId, layer };
  };
  // another tab signs out (the store's own sign out: "signout" on its channel, then the database deleted)
  // its time is taken once the post is acknowledged (the evaluate that posts it has returned), never before it: a
  // request the page started before it heard the sign out is a signed-in one (card sign-out-stops-the-pages-reads, P3)
  // a landed sign out reloads the top window (card sign-out-stops-the-pages-reads): the new document's start, once the
  // top window holds one begun after `t` (null if none comes), then the new frame's ready and its first answer
  const reloadedAfter = async (s, t0) => {
    s.doc = await until(async () => { const o = await d.evaluate("return performance.timeOrigin;"); return o > t0 ? Math.round(o) : null; }, RELOAD_MS);
    if (s.doc) await readyAfter(s.doc);
    s.top = await top("signed-in");
    s.id = (await ask()).id;
    await sleep(EVENT_MS);
    return s;
  };
  const signOutElsewhere = async () => {
    // the post and the delete in one task, as the store's own sign out has them (packages/wallet/src/store/index.ts),
    // so the delete is asked before the page can hear the post and reload; the page's reload ends the second evaluate
    const t0 = Date.now();
    await d.evaluate(`const c = new BroadcastChannel("ct-wallet"); c.postMessage({ kind: "signout" }); c.close(); window.__deleted = new Promise((ok, no) => { const r = indexedDB.deleteDatabase("ct-wallet"); r.onsuccess = () => ok(); r.onerror = () => no(r.error); });`);
    const t = Date.now();
    await d.evaluate(`await Promise.race([window.__deleted, new Promise((ok) => setTimeout(ok, 3000))]);`).catch((e) => {
      if (!/destroyed|navigat|context|detached/i.test(String(e?.message ?? e))) throw e;
    });
    return reloadedAfter({ t, by: "channel" }, t0);
  };
  // this tab's own Sign out: the app asks for it, the shell draws the sign-out page, and its button is tapped
  const signOutHere = async () => {
    const openId = await send("signout", { return_key: "settings" });
    await until(() => d.evaluate(`return !!document.querySelector('[data-action="signout"]');`), 3_000);
    const t = await press("signout");
    return reloadedAfter({ t, by: "button", openId }, t);
  };
  try {
    await d.goto(`${SIGN}${START}`);
    // the page's own connect-src as served: the live answer's header, or the harness's own _headers for it
    rec.connect = connectHosts(live ? (d.csp?.() ?? "") : (sign(START.split("?")[0]).headers["content-security-policy"] ?? ""));
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
      rec.steps.saved = await closedFrameAsks(await step("saved", "backup"));
      // the passkey account signs out by this tab's own Sign out button (card sign-out-stops-the-pages-reads, P3); the
      // words' account cannot here: its restore's sheet stays open on the harness, whose pinned hosts answer nothing
      rec.steps.passkeyOut = await signOutHere();
    }
    // the words, typed by trusted keys while the app takes the focus back every 20 ms
    await d.evaluateFrame(APP_HOST, "window.__steal(); return true;");
    // the field clicked and typed into as soon as it shows (the frame is out by then: it leaves in the open's own task)
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
    if (engine === "chromium" && d.page) {
      // a second passkey account lands after the words' sign out: none of its requests may name the words' account
      rec.steps.passkeyIn2 = await signinOpen("passkey");
      rec.steps.created2 = await step("create", "signed-out");
      rec.steps.saved2 = await closedFrameAsks(await step("saved", "backup"));
      rec.steps.passkeyOut2 = await signOutHere();
    }
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
