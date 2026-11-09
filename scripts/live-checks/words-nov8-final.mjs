#!/usr/bin/env node
// Live check of card words-nov8-final: every word the owner kept on the 8 Nov words page (owner 8 Nov 07:55Z, all kept as
// drafted) and the night's two (8 Nov 19:40Z, kept as drawn) is final in what the hosts serve: drawn with no
// data-draft-copy, its text unchanged. It reads each host's served page and the script it names and checks the deployed
// bundle:
//   - app: APP_HOST's script holds each of the 18 terminal words as a final entry: the word's text, then a source that
//     starts with its pick ("owner 8 Nov 07:55Z, kept; ..." or "8 Nov 19:40Z, kept as drawn; ..."), made by the words
//     table's final helper (draft:!1) or written as a literal entry with draft:!1. The terminal draws data-draft-copy
//     only for an entry whose draft flag is set (apps/terminal/test/words-final.test.ts holds each helper to that line),
//     so a final entry draws no mark;
//   - sign: SIGN_HOST's script holds each of the 18 held and withdraw texts (held.*, pw.*), writes data-draft-copy only
//     through the one helper that reads a key set (never for a fixed word), and the two sets name only the words the page
//     does not hold: the vault form's To, Amount, Min $ and the unmatched notice, the pool form's To and Amount.
// The words' texts against the page, and each element's draw, are proven by the cards' own tests:
// apps/terminal/test/words-final.test.ts and the signing page's test/words-final.test.ts, test/held-move-out.test.ts,
// test/withdraw-form.test.ts and test/pool-withdraw-form.test.ts.
// After: app --host app
// After: sign --host sign
//   node scripts/live-checks/words-nov8-final.mjs [--host sign|app] [--record <file>]
//     the deployed hosts (both unless --host names one): SIGN_HOST https://confidential.unrealized.trade/ and
//     APP_HOST https://ct-app.unrealized.trade/
//   node scripts/live-checks/words-nov8-final.mjs --local [--host sign|app] [--record <file>]
//     the same read on this checkout: packages/signpage (index.html, public/app.js) and apps/terminal/dist (built first)
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (which markers each file holds, not the files), so the check's test can replay it.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "words-nov8-final";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HOSTS = {
  sign: { url: "https://confidential.unrealized.trade/", get local() { return signBuilt(); }, localJs: (ref) => path.join("public", new URL(ref, "http://x/").pathname) },
  app: { url: "https://ct-app.unrealized.trade/", local: path.join(ROOT, "apps/terminal/dist"), localJs: (ref) => new URL(ref, "http://x/").pathname },
};

export const KEPT = "owner 8 Nov 07:55Z, kept";
export const AS_DRAWN = "8 Nov 19:40Z, kept as drawn";
/** The terminal's words kept as drafted, each by its table and key: the text it reads and the pick its source names. */
export const APP_WORDS = [
  ["token.gridLines", "Grid lines", KEPT], ["token.lastLine", "Last price line", KEPT], ["token.indMA", "MA", KEPT],
  ["token.indEMA", "EMA", KEPT], ["token.indBOLL", "BOLL", KEPT], ["token.indRSI", "RSI", KEPT], ["token.indMACD", "MACD", KEPT],
  ["trade.proofReady", "Proof ready", KEPT], ["trade.proofMaking", "Making proof", KEPT], ["trade.poolBare", "Pool", KEPT],
  ["trade.poolSuffix", "pool", KEPT], ["positions.toPool", "Back to Cash", KEPT], ["discover.updated", "Updated {age} ago", KEPT],
  ["deposit.to", "To", KEPT], ["portfolio.exportKey", "Export key", KEPT], ["portfolio.wallets", "Wallets", KEPT],
  ["discover.padMenuTitle", "Launchpads by tokens now", AS_DRAWN], ["search.placeholder", "Name, symbol or address", AS_DRAWN],
];
/** The signing page's words kept as drafted (the 8 Nov page's held.* and pw.*), by key on the page and the text drawn. */
export const SIGN_WORDS = [
  ["held.moveOut", "Move out"], ["held.links", "This links your deposit to this account."], ["held.moved", "Moved"],
  ["held.sending", "Sending"], ["held.nothing", "Nothing to move"], ["held.notMoved", "Not moved · Retry"],
  ["held.gas", "Send NEAR to the deposit account from the account you typed:"], ["pw.withdraw", "Withdraw"],
  ["pw.invalidAddress", "Invalid address"], ["pw.invalidAmount", "Invalid amount"], ["pw.insufficient", "Insufficient"],
  ["pw.busy", "Busy · Retry"], ["pw.maxFee", "Max fee"], ["pw.min", "Min "], ["pw.tryTwo", "Try "], ["pw.tryTwo-or", " or "],
  ["pw.feeRose", "Network fee rose. New max fee: "], ["pw.feeRoseSend", "Send at new fee"],
];
/** Words whose screen is in no build yet: the sell box (apps/terminal/src/screens/positions/SellBox.tsx) is imported by no
 *  mount, so its table is not in APP_HOST's script. Its word is final in the source (words-final.test.ts); the day a mount
 *  imports it, this check reads it in the script and wants it final. */
export const NOT_SHIPPED = ["positions.toPool"];
export const VAULT_DRAFT_KEYS = ["to", "amount", "min", "unmatched"];
export const POOL_DRAFT_KEYS = ["to", "amount"];

const Q = "[\"'`]";
const ID = "[\\w$]+";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The app's marker for one word: a final entry in the bundle (the text, then its pick; the helper's definition says draft:!1).
 *  A word of a screen the app does not mount yet (NOT_SHIPPED) may be in no script at all: nothing draws it, so no mark. */
export function appFinal(text, pick, js, id = "") {
  if (NOT_SHIPPED.includes(id) && !new RegExp(`${Q}${esc(text)}${Q}`).test(js)) return true;
  // a call: helper(`text`,`pick; ...`), the helper defined as (e,t)=>({text:e,source:t,draft:!1})
  for (const m of js.matchAll(new RegExp(`(?<![\\w$.])(${ID})\\(${Q}${esc(text)}${Q},${Q}${esc(pick)}; `, "g"))) {
    if (new RegExp(`(?<![\\w$.])${esc(m[1])}=\\((${ID}),(${ID})\\)=>\\(\\{text:\\1,source:\\2,draft:!1\\}\\)`).test(js)) return true;
  }
  // a literal entry: {text:`text`,source:`pick; ...`,draft:!1}
  return new RegExp(`\\{text:${Q}${esc(text)}${Q},source:${Q}${esc(pick)}; [\\s\\S]{0,600}?${Q},draft:!1\\}`).test(js);
}

/** The signing page's draft keys written by the one helper: every `dataset.draftCopy=` assignment is a bare name (the
 *  helper's `el.dataset.draftCopy = key`), never a fixed word or a choice between words. */
export function signMarks(js) {
  const rhs = [...js.matchAll(/\.dataset\.draftCopy=([^;,)}\]:?]*)/g)].map((m) => m[1].trim());
  return { assigns: rhs.length, bare: rhs.length > 0 && rhs.every((r) => new RegExp(`^${ID}$`).test(r)) };
}
const setOf = (js, keys) => {
  for (const m of js.matchAll(/new Set\(\[([^\]]*)\]\)/g)) {
    const got = [...m[1].matchAll(new RegExp(`${Q}([^"'\`]*)${Q}`, "g"))].map((x) => x[1]);
    if (got.length === keys.length && keys.every((k) => got.includes(k))) return true;
  }
  return false;
};

/** The markers one host's script holds, by name. */
export function found(host, js) {
  if (host === "app") return APP_WORDS.filter(([id, text, pick]) => appFinal(text, pick, js, id)).map(([id]) => `final ${id}`);
  const out = SIGN_WORDS.filter(([, text]) => new RegExp(`${Q}${esc(text)}${Q}`).test(js)).map(([id]) => `text ${id}`);
  if (signMarks(js).bare) out.push("no draft mark for a fixed word");
  if (setOf(js, VAULT_DRAFT_KEYS)) out.push("the vault form's draft keys");
  if (setOf(js, POOL_DRAFT_KEYS)) out.push("the pool form's draft keys");
  return out;
}
/** Every marker a host's script must hold. */
export const MARKERS = {
  app: APP_WORDS.map(([id]) => `final ${id}`),
  sign: [...SIGN_WORDS.map(([id]) => `text ${id}`), "no draft mark for a fixed word", "the vault form's draft keys", "the pool form's draft keys"],
};

/** The page's scripts: the `src` of each script tag. */
export const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);

// ------------------------------------------------------------------------------------------------ the verdict
/** The check on one answer: { hosts: { sign?: { source, pageStatus, js: [{ url, status, found }] }, app?: ... } }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const hosts = Object.keys(rec?.hosts ?? {});
  say(hosts.length > 0 && hosts.every((h) => Object.hasOwn(MARKERS, h)), `hosts read: ${hosts.join(", ") || "none"}`);
  for (const h of hosts.filter((x) => Object.hasOwn(MARKERS, x))) {
    const r = rec.hosts[h];
    say(r.pageStatus === 200, `${h}: the page answers ${r.pageStatus ?? "nothing"} (${r.source})`);
    const js = r.js ?? [];
    say(js.length > 0 && js.every((f) => f.status === 200), `${h}: ${js.length} script(s) named by the page, each answering 200`);
    const held = new Set(js.flatMap((f) => f.found ?? []));
    const miss = MARKERS[h].filter((m) => !held.has(m));
    say(miss.length === 0, miss.length ? `${h}: the scripts lack ${miss.length} of ${MARKERS[h].length}: ${miss.join(", ")}` : `${h}: the scripts hold all ${MARKERS[h].length}: ${h === "app" ? "each kept word a final entry" : "each kept text, no draft mark for a fixed word, only the unpicked keys in the draft sets"}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the read
async function http(url) {
  const r = await fetch(url, { redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

async function readHost(host, local) {
  const h = HOSTS[host];
  const file = (rel) => {
    try {
      return { status: 200, text: readFileSync(path.join(h.local, rel), "utf8") };
    } catch {
      return { status: 404, text: "" };
    }
  };
  const page = local ? file("index.html") : await http(h.url);
  const rec = { source: local ? `this checkout, ${path.relative(ROOT, h.local)}` : h.url, pageStatus: page.status, js: [] };
  for (const ref of scriptsOf(page.text)) {
    const f = local ? file(h.localJs(ref)) : await http(new URL(ref, h.url).href);
    rec.js.push({ url: ref, status: f.status, found: found(host, f.text) });
  }
  return rec;
}

export async function collect({ hosts = ["sign", "app"], local = false } = {}) {
  const rec = { at: new Date().toISOString(), hosts: {} };
  for (const h of hosts) rec.hosts[h] = await readHost(h, local);
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const host = opt("--host", null);
    if (host !== null && !Object.hasOwn(HOSTS, host)) throw new Error("--host: sign or app");
    const rec = await collect({ hosts: host ? [host] : ["sign", "app"], local: a.includes("--local") });
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${Object.values(rec.hosts).map((r) => r.source).join("; ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
