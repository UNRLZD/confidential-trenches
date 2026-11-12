#!/usr/bin/env node
// Live check of card near-holdings-restore on SIGN_HOST (https://confidential.unrealized.trade) and the helper
// (https://ct-api.unrealized.trade). What it holds, on what is deployed:
//   - SIGN_HOST's /app.js is the one its index.html pins (its sha384) and carries the rebuild of the NEAR buy records
//     from W's own signed calls (src/near-buy.ts nearHoldingsPass: the helper's record path "/v1/bind/record" and the
//     kept W key "near-holdings-w:");
//   - SIGN_HOST's CSP connect-src names no FastNEAR API host (https://api.fastnear.com, https://test.api.fastnear.com):
//     a restore names W to no public provider;
//   - the helper's POST /v1/bind/record answers the page as the page asks it (SIGN_HOST's Origin, no credentials) for
//     a W the vault never paid (the all-zero implicit id: no key derives it): 200, CORS allowing SIGN_HOST's origin, one
//     record of the asked wallet in the empty shape (token null, no call, no creation), so it is no oracle of which W
//     exist.
// A W's position rebuilt after a sign out is the money run's (card near-buy-and-sell-run-for-real's record), not this.
// After: sign
//   node scripts/live-checks/near-holdings-restore.mjs [--record <file>]
//   node scripts/live-checks/near-holdings-restore.mjs --local [--helper <origin>] [--record <file>]
//     this tree's build (index.html, public/app.js, public/_headers) in place of SIGN_HOST's, and the helper at <origin>
//     (a local helper) in place of the release's
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
export const HELPER = "https://ct-api.unrealized.trade";
export const RECORD_PATH = "/v1/bind/record";
/** src/near-buy.ts NEAR_HOLDINGS_W_KEY (the test holds it equal). */
export const W_KEY = "near-holdings-w:";
export const FT_HOSTS = ["https://api.fastnear.com", "https://test.api.fastnear.com"];
/** A W the vault never paid: no key derives the all-zero id. */
export const ASKED = "0".repeat(64);

/** The verdict on one answer: { ok, lines } with a BAD line per failure. */
export function judge(a) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  const connect = /(?:^|;)\s*connect-src ([^;]*)/.exec(a?.csp ?? "")?.[1]?.trim().split(/\s+/) ?? null;
  if (connect === null) bad("SIGN_HOST's CSP has no connect-src");
  else for (const h of FT_HOSTS) if (connect.includes(h)) bad(`SIGN_HOST's connect-src names ${h}: a restore may name W to a public provider`);
  const pin = /<script type="module" src="\/app\.js" integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(a?.html ?? "")?.[1] ?? null;
  if (pin === null || pin !== a?.appSha384) bad(`SIGN_HOST's /app.js (${a?.appSha384 ?? "none"}) is not the one its index.html pins (${pin ?? "none"})`);
  if (!a?.app?.pass) bad("SIGN_HOST's /app.js carries no rebuild from W's own calls: the build is before this card");
  const r = a?.record;
  if (r === null || typeof r !== "object") bad("the helper's record route gave no answer");
  else {
    if (r.status !== 200) bad(`the helper's record route answered HTTP ${r.status}`);
    if (r.acao !== "*" && r.acao !== SIGN_ORIGIN) bad(`the helper's record route allows ${JSON.stringify(r.acao)}, not SIGN_HOST's origin: the page's read is refused`);
    const recs = r.body !== null && typeof r.body === "object" && Array.isArray(r.body.records) ? r.body.records : null;
    const one = recs?.length === 1 ? recs[0] : null;
    if (one === null || one?.wallet !== ASKED) bad("the helper's record route did not answer one record of the asked wallet");
    else if (one.token !== null || !Array.isArray(one.calls) || one.calls.length !== 0 || one.created !== null) bad("the helper's record of a W the vault never paid is not the empty shape");
  }
  return { ok: lines.length === 0, lines };
}

const PKG = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage");
function localBuild() {
  const headers = readFileSync(path.join(PKG, "public/_headers"), "utf8");
  const csp = /^\/\*\n(?:\s.*\n)*?\s+Content-Security-Policy:\s*(.*)$/m.exec(headers)?.[1] ?? "";
  return { html: readFileSync(path.join(signBuilt(), "index.html"), "utf8"), csp, js: readFileSync(path.join(signBuilt(), "public/app.js")) };
}

/** The live answer: SIGN_HOST's policy and bundle (or this tree's), and the helper's record of the never-paid W. */
export async function read(local = false, helper = HELPER) {
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
  const app = { pass: text.includes(RECORD_PATH) && text.includes(W_KEY) };
  const res = await fetch(`${helper}${RECORD_PATH}`, { method: "POST", redirect: "error", credentials: "omit", headers: { origin: SIGN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ network: "mainnet", wallets: [ASKED] }), signal: AbortSignal.timeout(20_000) });
  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  return { at: new Date().toISOString(), csp, html, appSha384, app, record: { status: res.status, acao: res.headers.get("access-control-allow-origin"), body } };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  try {
    const answer = at("--answer") ? JSON.parse(readFileSync(at("--answer"), "utf8")) : await read(argv.includes("--local"), at("--helper") ?? HELPER);
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
