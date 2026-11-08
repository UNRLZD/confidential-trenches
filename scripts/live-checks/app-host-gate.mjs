#!/usr/bin/env node
// Live check of card app-host-gate: APP_HOST serves with the app paper's header policy (2.3, AX-02). It GETs the page
// and compares the response headers with the policy written out below, which is held here and not read from the
// repo's _headers file, so a change to that file cannot pass this check by changing what it is compared with:
//   - every CSP directive equals the policy's, with no directive missing and none added;
//   - frame-ancestors is exactly SIGN_HOST (the terminal runs only inside SIGN_HOST's shell), frame-src is 'none', and
//     no header holds 'wasm-unsafe-eval';
//   - Integrity-Policy, HSTS, COOP, CORP, Referrer-Policy, X-Content-Type-Options and Permissions-Policy equal the
//     policy's, and no Cross-Origin-Embedder-Policy and no X-Frame-Options is sent (any X-Frame-Options value would
//     refuse the shell's frame).
// After: app
//   node scripts/live-checks/app-host-gate.mjs [--url <url>] [--record <file>]     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the answer the run read ({ url, status, headers }) to <file>, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evmOrigins } from "./page-evm-rpc-csp.mjs";

const KEY = "app-host-gate";
export const URL_ = "https://ct-app.unrealized.trade/";
const SIGN = "https://confidential.unrealized.trade";
const HELPER = "ct-api.unrealized.trade";
const RPCS = "https://rpc.mainnet.fastnear.com https://rpc.mainnet.near.org https://near.drpc.org";
// the kit's EVM providers' origins (card page-evm-rpc-csp), read from the kit's venue lists, before the NEAR RPCs, which
// a testnet build swaps as the connect-src's last sources (apps/terminal/build/network.mjs)
const EVM = evmOrigins().join(" ");

// the app paper's block (app.md 2.3) with HELPER_HOST, SIGN_HOST, the kit's EVM providers and RPC_A, RPC_B, RPC_C put in
export const CSP = [
  ["default-src", "'none'"],
  ["script-src", "'self'"],
  ["style-src", "'self'"],
  ["img-src", `'self' data: https://${HELPER}`],
  ["font-src", "'self'"],
  ["connect-src", `'self' https://${HELPER} wss://${HELPER} ${SIGN} ${EVM} ${RPCS}`],
  ["manifest-src", "'self'"],
  ["worker-src", "'none'"],
  ["frame-src", "'none'"],
  ["frame-ancestors", SIGN],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["require-trusted-types-for", "'script'"],
  ["trusted-types", "'none'"],
  ["upgrade-insecure-requests", ""],
];
export const HEADERS = {
  "integrity-policy": "blocked-destinations=(script)",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "permissions-policy":
    "accelerometer=(), autoplay=(), bluetooth=(), camera=(), clipboard-read=(), clipboard-write=(self), " +
    "display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), " +
    "publickey-credentials-create=(), publickey-credentials-get=(), serial=(), usb=(), xr-spatial-tracking=()",
};

const ws = (s) => s.trim().replace(/\s+/g, " ");
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** The check on one answer: { status, headers } with lower-case header names. */
export function judge({ status, headers }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET answers ${status}`);
  const csp = headers["content-security-policy"];
  if (csp === undefined) say(false, "Content-Security-Policy: none sent");
  else {
    const got = new Map();
    const twice = [];
    for (const part of csp.split(";")) {
      const [k, ...v] = part.trim().split(/\s+/);
      if (!k) continue;
      if (got.has(k.toLowerCase())) twice.push(k);
      else got.set(k.toLowerCase(), v.join(" "));
    }
    for (const [k, want] of CSP) say(got.get(k) === want, `CSP ${k}: ${show(got.get(k))}${got.get(k) === want ? "" : `, want ${show(want)}`}`);
    const extra = [...got.keys()].filter((k) => !CSP.some(([n]) => n === k));
    say(extra.length === 0 && twice.length === 0, `CSP has no directive beyond the policy's${extra.length ? `: extra ${extra.join(" ")}` : ""}${twice.length ? `: twice ${twice.join(" ")}` : ""}`);
    say(got.get("frame-ancestors") === SIGN, `CSP frame-ancestors is exactly ${SIGN}`);
  }
  const wasm = Object.entries(headers).filter(([, v]) => v.includes("'wasm-unsafe-eval'")).map(([k]) => k);
  say(wasm.length === 0, `no header holds 'wasm-unsafe-eval'${wasm.length ? `: ${wasm.join(", ")}` : ""}`);
  for (const [k, want] of Object.entries(HEADERS)) {
    const v = headers[k] === undefined ? undefined : ws(headers[k]);
    say(v === want, `${k}: ${show(v)}${v === want ? "" : `, want ${show(want)}`}`);
  }
  for (const k of ["cross-origin-embedder-policy", "x-frame-options"]) say(headers[k] === undefined, `${k}: ${show(headers[k])}, want none`);
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
