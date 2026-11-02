#!/usr/bin/env node
// Live check of card signpage-skeleton: SIGN_HOST serves the signing page with its full headers. It GETs the page and
// compares the response headers with the policy written out below, which is held here and not read from the repo's
// _headers file, so a change to that file cannot pass this check by changing what it is compared with:
//   - the answer is 200;
//   - the CSP equals the wallet paper's block (2.7) with HELPER_HOST, RPC_A, RPC_B, RPC_C and the Solana trade's hosts put in: every directive
//     equal, none missing, none added, one policy only;
//   - SIGN_HOST is the top window and frames APP_HOST (card signpage-shell): frame-ancestors 'none' blocks every
//     framing page, APP_HOST and https://example.com included, and frame-src names APP_HOST only;
//   - Integrity-Policy, Origin-Agent-Cluster, HSTS, COOP, CORP, Referrer-Policy, X-Content-Type-Options and
//     Permissions-Policy equal the policy's, and no X-Frame-Options, Cross-Origin-Embedder-Policy or report-only CSP is
//     sent.
//   node scripts/live-checks/signpage-skeleton.mjs [--url <url>] [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the answer the run read ({ url, status, headers }) to <file>, so the check's test can replay it.
// packages/signpage/scripts/deploy.mjs runs judge() on the build's _headers before any upload.
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-skeleton";
export const SIGN = "https://sign.confidential.unrealized.trade";
export const URL_ = `${SIGN}/`;
export const APP = "https://confidential.unrealized.trade";
export const STRANGER = "https://example.com";
const HELPER = "api.confidential.unrealized.trade";
const RPCS = "https://rpc.mainnet.fastnear.com https://rpc.mainnet.near.org https://near.drpc.org";
// the Solana trade's own (card signpage-solana-trade): provider A of LD1 and the kit's three device-direct send paths
// (packages/kit/src/trade/solana/send.ts); packages/signpage/test/trade.test.ts reads them from the page's trade deps
const SOLANA = "https://solana-rpc.publicnode.com https://sender.helius-rpc.com https://mainnet.block-engine.jito.wtf https://api.mainnet-beta.solana.com";

// the wallet paper's block (wallet.md 2.7) with HELPER_HOST, RPC_A, RPC_B, RPC_C and APP_HOST put in, plus font-src 'self'
export const CSP = [
  ["default-src", "'none'"],
  ["script-src", "'self' 'wasm-unsafe-eval'"],
  ["worker-src", "'self'"],
  ["connect-src", `'self' https://${HELPER} https://1click.chaindefuser.com ${RPCS} ${SOLANA}`],
  ["style-src", "'self'"],
  ["img-src", "'self' data:"],
  ["font-src", "'self'"], // app.md finding 1 (l.1085): the top-level SIGN_HOST screens draw in the brand fonts
  ["frame-src", APP], // the shell's one frame (card signpage-shell)
  ["frame-ancestors", "'none'"], // nothing frames SIGN_HOST: it is the top window
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["object-src", "'none'"],
  ["require-trusted-types-for", "'script'"],
  ["trusted-types", "prover-worker"],
];
// Integrity-Policy from the wallet paper's block; the rest from the app paper's SIGN_HOST column (app.md 2.3)
export const HEADERS = {
  "integrity-policy": "blocked-destinations=(script)",
  "origin-agent-cluster": "?1", // card signpage-shell: a hint to keep SIGN_HOST's agent cluster apart from APP_HOST's
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy":
    "accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-read=(), clipboard-write=(self), " +
    "display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), " +
    "publickey-credentials-create=(self), publickey-credentials-get=(self), serial=(), usb=(), xr-spatial-tracking=()",
};
// X-Frame-Options would repeat frame-ancestors, so it is not sent; no cross-origin isolation (COEP would make the APP_HOST
// frame need CORP and COEP of its own); no policy left report-only
export const ABSENT = ["x-frame-options", "cross-origin-embedder-policy", "content-security-policy-report-only"];

const ws = (s) => s.trim().replace(/\s+/g, " ");
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const PORTS = { "http:": "80", "https:": "443" };

/**
 * Whether a page at origin `ancestor` may frame a page at origin `self` under a frame-ancestors source list (CSP3
 * 6.7.2: '*', 'self', a scheme, or a host source with an optional scheme, a *. host and a port; http matches https).
 * A path in a source is ignored, which can only widen a match, so "blocked" is never claimed too easily.
 */
export function frameAllowed(sources, ancestor, self = SIGN) {
  const a = new URL(ancestor);
  const aPort = a.port || PORTS[a.protocol];
  const schemeOk = (s) => s === a.protocol || (s === "http:" && a.protocol === "https:");
  for (const raw of sources) {
    const s = raw.toLowerCase();
    if (s === "*") {
      if (a.protocol === "https:" || a.protocol === "http:") return true;
      continue;
    }
    if (s === "'self'") {
      if (new URL(self).origin === a.origin) return true;
      continue;
    }
    if (s.startsWith("'")) continue; // 'none', nonces, hashes and keywords never allow an ancestor
    if (/^[a-z][a-z0-9+.-]*:$/.test(s)) {
      if (schemeOk(s)) return true;
      continue;
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|[^:/*]+)(?::(\d+|\*))?(\/.*)?$/.exec(s);
    if (!m) continue;
    const [, scheme, host, port] = m;
    if (scheme ? !schemeOk(`${scheme}:`) : !schemeOk(new URL(self).protocol)) continue;
    const h = a.hostname.toLowerCase();
    if (host !== "*" && !(host.startsWith("*.") ? h.endsWith(host.slice(1)) : h === host)) continue;
    const want = port ?? (scheme ? PORTS[`${scheme}:`] : PORTS[a.protocol]);
    if (port !== "*" && want !== aPort && !(want === "80" && aPort === "443")) continue;
    return true;
  }
  return false;
}

/** The check on one answer: { status, headers } with lower-case header names. */
export function judge({ status, headers }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET answers ${status}`);
  const csp = headers["content-security-policy"];
  if (csp === undefined) say(false, "Content-Security-Policy: none sent");
  else {
    say(!csp.includes(","), `CSP is one policy${csp.includes(",") ? ": it holds a comma" : ""}`);
    const got = new Map();
    const twice = [];
    for (const part of csp.split(/[;,]/)) {
      const [k, ...v] = part.trim().split(/\s+/);
      if (!k) continue;
      if (got.has(k.toLowerCase())) twice.push(k);
      else got.set(k.toLowerCase(), v.join(" "));
    }
    for (const [k, want] of CSP) say(got.get(k) === want, `CSP ${k}: ${show(got.get(k))}${got.get(k) === want ? "" : `, want ${show(want)}`}`);
    const extra = [...got.keys()].filter((k) => !CSP.some(([n]) => n === k));
    say(extra.length === 0 && twice.length === 0, `CSP has no directive beyond the policy's${extra.length ? `: extra ${extra.join(" ")}` : ""}${twice.length ? `: twice ${twice.join(" ")}` : ""}`);
    const fa = got.get("frame-ancestors");
    const sources = fa === undefined ? undefined : fa.split(" ").filter(Boolean);
    // no frame-ancestors lets every page frame this one
    const app = sources === undefined || frameAllowed(sources, APP);
    const stranger = sources === undefined || frameAllowed(sources, STRANGER);
    say(!app, `framed from ${APP}: ${app ? `allowed${sources === undefined ? " (no frame-ancestors)" : ""}` : "blocked"}`);
    say(!stranger, `framed from ${STRANGER}: ${stranger ? `allowed${sources === undefined ? " (no frame-ancestors)" : ""}` : "blocked"}`);
  }
  for (const [k, want] of Object.entries(HEADERS)) {
    const v = headers[k] === undefined ? undefined : ws(headers[k]);
    say(v === want, `${k}: ${show(v)}${v === want ? "" : `, want ${show(want)}`}`);
  }
  for (const k of ABSENT) say(headers[k] === undefined, `${k}: ${show(headers[k])}, want none`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(url = URL_, fetchFn = fetch) {
  const r = await fetchFn(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  return { url, status: r.status, headers };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--url", URL_));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.url})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
