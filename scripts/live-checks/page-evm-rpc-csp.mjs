#!/usr/bin/env node
// Live check of card page-evm-rpc-csp: an EVM read or quote made from either page reaches the kit's Base and Robinhood
// providers. It GETs APP_HOST and SIGN_HOST and reads each one's served Content-Security-Policy: its connect-src must
// name the origin of every provider in the kit's EVM venue lists (evmPoolVenues(): Base, Robinhood, Base Sepolia and
// Robinhood testnet; every URL in a venue, so the quote list, the fee pair, the pool's list and the scan's provider and
// spares), as an exact origin, never a wildcard. The lists are read from the kit as the source, not copied here, so a
// provider swap whose origin a page's policy misses fails this check; a path on a provider (one that may carry a key)
// is never named, only its origin. app-host-gate and signpage-skeleton pin each page's whole connect-src with these
// origins in it, and their CI tests hold each _headers file to its pin.
//   node scripts/live-checks/page-evm-rpc-csp.mjs [--host app|sign] [--app <url>] [--sign <url>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --host reads that host alone (each host's deploy runs its own, so a host that lags does not fail the other's deploy);
// both when not given. --record writes the answers the run read ({ app, sign }: each { url, status, csp }) to <file>, so
// the check's test can replay them.
import "../net-window.mjs";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";

const KEY = "page-evm-rpc-csp";
export const PAGES = Object.freeze({ app: "https://confidential.unrealized.trade/", sign: "https://sign.confidential.unrealized.trade/" });

/** Every https URL anywhere in a value (own fields only, any depth). */
function urlsIn(v, out = []) {
  if (typeof v === "string") {
    if (/^https:\/\//i.test(v)) out.push(v);
  } else if (v && typeof v === "object") for (const k of Reflect.ownKeys(v)) urlsIn(v[k], out);
  return out;
}

/** The origins of every provider in the kit's EVM venues, in the list's order, each once. */
export function evmOrigins(venues = evmPoolVenues()) {
  const seen = [];
  for (const chain of Object.keys(venues)) for (const u of urlsIn(venues[chain])) {
    const o = new URL(u).origin;
    if (!seen.includes(o)) seen.push(o);
  }
  return seen;
}

/** A CSP's connect-src sources, or null when it has none (the first one, as a browser reads it). */
export function connectSrc(csp) {
  for (const part of String(csp ?? "").split(";")) {
    const [k, ...v] = part.trim().split(/\s+/);
    if (k?.toLowerCase() === "connect-src") return v;
  }
  return null;
}

/** The check on one run's answers: { app, sign }, each { url, status, csp }, for the pages in `hosts`. */
export function judge(answers, origins = evmOrigins(), hosts = Object.keys(PAGES)) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(origins.length >= 4, `the kit's EVM venues name ${origins.length} provider origins`);
  for (const page of hosts) {
    const a = answers?.[page];
    if (!a) {
      say(false, `${page}: no answer`);
      continue;
    }
    say(a.status === 200, `${page}: GET ${a.url} answers ${a.status}`);
    if (typeof a.csp !== "string") {
      say(false, `${page}: Content-Security-Policy: none sent`);
      continue;
    }
    say(!a.csp.includes(","), `${page}: CSP is one policy${a.csp.includes(",") ? ": it holds a comma" : ""}`);
    const src = connectSrc(a.csp);
    if (src === null) {
      say(false, `${page}: CSP has no connect-src`);
      continue;
    }
    const wild = src.filter((s) => s.includes("*"));
    say(wild.length === 0, `${page}: connect-src holds no wildcard${wild.length ? `: ${wild.join(" ")}` : ""}`);
    const missing = origins.filter((o) => !src.includes(o));
    say(missing.length === 0, `${page}: connect-src names every kit EVM provider${missing.length ? `: lacks ${missing.join(" ")}` : ` (${origins.length})`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(url, fetchFn = fetch) {
  const r = await fetchFn(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
  return { url, status: r.status, csp: r.headers.get("content-security-policy") ?? null };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const host = opt("--host");
    if (host !== undefined && !Object.hasOwn(PAGES, host)) throw new Error(`--host must be app or sign: ${host}`);
    const hosts = host === undefined ? Object.keys(PAGES) : [host];
    const answers = {};
    for (const h of hosts) answers[h] = await read(opt(`--${h}`, PAGES[h]));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answers, null, 1)}\n`);
    const { ok, lines } = judge(answers, evmOrigins(), hosts);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${hosts.map((h) => answers[h].url).join(" ")})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
