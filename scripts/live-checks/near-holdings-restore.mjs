#!/usr/bin/env node
// Live check of card near-holdings-restore on SIGN_HOST (https://confidential.unrealized.trade). What it holds, on what
// is deployed:
//   - SIGN_HOST's CSP connect-src names the mainnet NEAR FT list (https://api.fastnear.com) and not testnet's
//     (https://test.api.fastnear.com), so the page may ask the list a token hint and a mainnet build never reads testnet;
//   - SIGN_HOST's /app.js is the one its index.html pins (its sha384) and carries the rebuild of the NEAR buy records
//     (src/near-buy.ts nearHoldingsPass: its kept-empty key "near-holdings-empty:" and the list's path "/v1/account/");
//   - the FT list itself answers the page as the page asks it (GET, no credentials, SIGN_HOST's Origin): 200, CORS
//     allowing SIGN_HOST's origin (or any), and a body of the shape nearTokenHints accepts: the account asked, a tokens
//     array of at most NEAR_FT_HINTS_MAX rows, each contract_id a NEAR account id. The account asked is the mainnet
//     vault (a public account; the list's shape does not depend on whose it is).
// A W's position rebuilt after a sign out is the money run's (the card's record), not this check.
// After: sign
//   node scripts/live-checks/near-holdings-restore.mjs [--record <file>]
//   node scripts/live-checks/near-holdings-restore.mjs --local [--record <file>]
//     the same with this tree's build (index.html, public/app.js, public/_headers) in place of SIGN_HOST's; the FT list
//     is still read live
//   node scripts/live-checks/near-holdings-restore.mjs --answer <file>     judge a recorded answer, no network
// PASS exit 0, FAIL exit 1, error exit 2; the last line is "PASS near-holdings-restore" or "FAIL near-holdings-restore",
// each failure a "BAD ..." line.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "near-holdings-restore";
export const SIGN_URL = "https://confidential.unrealized.trade/";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
export const FT_LIST = "https://api.fastnear.com";
export const FT_LIST_TESTNET = "https://test.api.fastnear.com";
/** The account the list is asked of: the mainnet vault (packages/kit/src/near/networks.ts NEAR_NETWORKS.mainnet.vault). */
export const ASKED = "vault.confidential.unrlzd.near";
/** src/near-buy.ts NEAR_FT_HINTS_MAX and NEAR_HOLDINGS_EMPTY_KEY (the test holds them equal). */
export const HINTS_MAX = 64;
export const EMPTY_KEY = "near-holdings-empty:";
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The verdict on one answer: { ok, lines } with a BAD line per failure. */
export function judge(a) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  const connect = /(?:^|;)\s*connect-src ([^;]*)/.exec(a?.csp ?? "")?.[1]?.trim().split(/\s+/) ?? null;
  if (connect === null) bad("SIGN_HOST's CSP has no connect-src");
  else {
    if (!connect.includes(FT_LIST)) bad(`SIGN_HOST's connect-src lacks the NEAR FT list ${FT_LIST}: the page cannot ask a W's token hint`);
    if (connect.includes(FT_LIST_TESTNET)) bad(`SIGN_HOST's connect-src names the testnet FT list ${FT_LIST_TESTNET}`);
  }
  const pin = /<script type="module" src="\/app\.js" integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(a?.html ?? "")?.[1] ?? null;
  if (pin === null || pin !== a?.appSha384) bad(`SIGN_HOST's /app.js (${a?.appSha384 ?? "none"}) is not the one its index.html pins (${pin ?? "none"})`);
  if (!a?.app?.pass) bad("SIGN_HOST's /app.js carries no rebuild of the NEAR buy records: the build is before this card");
  const l = a?.list;
  if (l === null || typeof l !== "object") bad("the FT list gave no answer");
  else {
    if (l.status !== 200) bad(`the FT list answered HTTP ${l.status}`);
    if (l.acao !== "*" && l.acao !== SIGN_ORIGIN) bad(`the FT list's CORS allows ${JSON.stringify(l.acao)}, not SIGN_HOST's origin: the page's read is refused`);
    const b = l.body;
    const rows = b !== null && typeof b === "object" && Array.isArray(b.tokens) ? b.tokens : null;
    if (b?.account_id !== ASKED || rows === null) bad(`the FT list's body is not the asked account's list (${JSON.stringify(b?.account_id ?? null)})`);
    else if (rows.length > HINTS_MAX) bad(`the FT list names ${rows.length} tokens, above the page's ${HINTS_MAX}`);
    else if (!rows.every((t) => t !== null && typeof t === "object" && typeof t.contract_id === "string" && ACCOUNT_ID.test(t.contract_id))) bad("the FT list has a row the page refuses (no account id)");
  }
  return { ok: lines.length === 0, lines };
}

const PKG = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage");
function localBuild() {
  const headers = readFileSync(path.join(PKG, "public/_headers"), "utf8");
  const csp = /^\/\*\n(?:\s.*\n)*?\s+Content-Security-Policy:\s*(.*)$/m.exec(headers)?.[1] ?? "";
  return { html: readFileSync(path.join(signBuilt(), "index.html"), "utf8"), csp, js: readFileSync(path.join(signBuilt(), "public/app.js")) };
}

/** The live answer: SIGN_HOST's policy and bundle (or this tree's, `local`), and the FT list's answer to the page's ask. */
export async function read(local = false) {
  let html, csp, js;
  if (local) ({ html, csp, js } = localBuild());
  else {
    const res = await fetch(SIGN_URL, { redirect: "error" });
    html = await res.text();
    csp = res.headers.get("content-security-policy") ?? "";
    js = Buffer.from(await (await fetch(new URL("/app.js", SIGN_URL), { redirect: "error" })).arrayBuffer());
  }
  const appSha384 = `sha384-${createHash("sha384").update(js).digest("base64")}`;
  const text = js.toString("utf8");
  const app = { pass: text.includes(EMPTY_KEY) && text.includes("/v1/account/") };
  const r = await fetch(`${FT_LIST}/v1/account/${ASKED}/ft`, { method: "GET", redirect: "error", credentials: "omit", headers: { origin: SIGN_ORIGIN }, signal: AbortSignal.timeout(20_000) });
  const raw = await r.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  const list = { status: r.status, acao: r.headers.get("access-control-allow-origin"), body };
  return { at: new Date().toISOString(), csp, html, appSha384, app, list };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  try {
    const answer = at("--answer") ? JSON.parse(readFileSync(at("--answer"), "utf8")) : await read(argv.includes("--local"));
    if (at("--record")) writeFileSync(at("--record"), `${JSON.stringify(answer, null, 2)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
