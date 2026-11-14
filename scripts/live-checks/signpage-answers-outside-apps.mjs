#!/usr/bin/env node
// Live check of card signpage-answers-outside-apps: an outside app built on @blindfill/kit opens SIGN_HOST at /connect in
// a popup (window.open) and the page answers it through window.opener, which the site's COOP same-origin would cut for a
// cross-origin opener. public/_headers' /connect rule, after /*, detaches /*'s Cross-Origin-Opener-Policy and sets
// CONNECT_COOP (Pages joins a header two rules set with a comma, so without the detach /connect would be served
// "same-origin, unsafe-none"); it touches nothing else, so the site's CSP, frame-ancestors 'none' with it, holds there too.
// It GETs / and /connect on SIGN_HOST = https://confidential.unrealized.trade (signpage-skeleton's SIGN) and passes when:
//   - / sends COOP exactly same-origin and one CSP whose frame-src is APP_HOST alone and frame-ancestors 'none';
//   - /connect sends COOP exactly CONNECT_COOP, one value, not two joined by a comma, and the same one CSP as /
//     (frame-ancestors 'none');
//   - both answer 200 text/html with the same body, the shell's index.html.
// The site's CSP itself, directive by directive, is signpage-skeleton's to judge; packages/signpage/scripts/deploy.mjs
// imports CONNECT_PATH and CONNECT_COOP from here and holds the build's _headers to them before any upload.
// After: sign
// Bundle: out response headers (the sign deploy's gate holds the build's _headers /connect rule to CONNECT_COOP)
//   node scripts/live-checks/signpage-answers-outside-apps.mjs [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes what the run read (each answer's status, type, size, sha256, CSP and COOP), so the check's test can
// replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP, SIGN } from "./signpage-skeleton.mjs";

const KEY = "signpage-answers-outside-apps";
/** The path an outside app opens SIGN_HOST at, and the COOP it is served with there (the site's is SITE_COOP). */
export const CONNECT_PATH = "/connect";
export const CONNECT_COOP = "unsafe-none";
export const SITE_COOP = "same-origin";

/** A CSP's directives: { name: [value, ...] } over every policy in it (a name twice keeps both, so a check refuses it). */
const directives = (csp) => {
  const out = {};
  for (const part of csp.split(/[;,]/)) {
    const [k, ...v] = part.trim().split(/\s+/);
    if (k) (out[k.toLowerCase()] ??= []).push(v.join(" "));
  }
  return out;
};
const show = (v) => (v === undefined || v === null ? "none" : JSON.stringify(v));

/** One answer as the record keeps it: status, content type, size, the body's sha256, and the CSP and COOP as fetch reads
 *  them (two headers of one name joined by ", "). */
async function answer(f, url) {
  const r = await f(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
  const body = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    type: r.headers.get("content-type"),
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    csp: r.headers.get("content-security-policy"),
    coop: r.headers.get("cross-origin-opener-policy"),
  };
}

/** The read: SIGN_HOST's / and CONNECT_PATH. */
export async function read(f = fetch, origin = SIGN) {
  return { origin, answers: { "/": await answer(f, `${origin}/`), [CONNECT_PATH]: await answer(f, `${origin}${CONNECT_PATH}`) } };
}

/** The verdict on one read: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const site = rec?.answers?.["/"];
  const conn = rec?.answers?.[CONNECT_PATH];
  const C = CONNECT_PATH;
  const html = (a) => /^text\/html\b/.test(a?.type ?? "");
  say(site?.status === 200 && html(site) && site.bytes > 0, `/: ${site?.status ?? "no answer"} ${site?.type ?? ""}, ${site?.bytes ?? 0} bytes`);
  say(conn?.status === 200 && html(conn) && conn.sha256 === site?.sha256, `${C}: ${conn?.status ?? "no answer"} ${conn?.type ?? ""}, ${conn?.bytes ?? 0} bytes, ${conn?.sha256 === site?.sha256 ? "the shell's index" : "not /'s body"}`);
  // COOP: / the site's, /connect its own, each one value
  say(site?.coop === SITE_COOP, `/ COOP: ${show(site?.coop)}${site?.coop === SITE_COOP ? "" : `, want ${show(SITE_COOP)}`}`);
  const joined = typeof conn?.coop === "string" && conn.coop.includes(",");
  say(conn?.coop === CONNECT_COOP, `${C} COOP: ${show(conn?.coop)}${conn?.coop === CONNECT_COOP ? "" : `, want ${show(CONNECT_COOP)}${joined ? " (two joined by a comma: the rule sets it without detaching the site's)" : ""}`}`);
  // CSP: / one policy framing APP_HOST alone, framed by none; /connect the very same
  const policy = (name, csp) => {
    if (typeof csp !== "string") return void say(false, `${name} CSP: none sent`);
    say(!csp.includes(","), `${name} CSP is one policy${csp.includes(",") ? ": two joined by a comma" : ""}`);
    const fa = directives(csp)["frame-ancestors"];
    say(fa?.length === 1 && fa[0] === "'none'", `${name} frame-ancestors: ${show(fa?.join(" | "))}${fa?.length === 1 && fa[0] === "'none'" ? "" : `, want "'none'"`}`);
  };
  policy("/", site?.csp);
  const fs = typeof site?.csp === "string" ? directives(site.csp)["frame-src"] : undefined;
  say(fs?.length === 1 && fs[0] === APP, `/ frame-src: ${show(fs?.join(" | "))}${fs?.length === 1 && fs[0] === APP ? "" : `, want ${show(APP)}`}`);
  policy(C, conn?.csp);
  const same = typeof site?.csp === "string" && conn?.csp === site.csp;
  say(same, `${C} CSP ${same ? "is" : "is not"} /'s`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    const rec = await read();
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify({ at: new Date().toISOString(), ...rec }, null, 1)}\n`);
    const { pass, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${pass ? "PASS" : "FAIL"} (${rec.origin})`);
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
