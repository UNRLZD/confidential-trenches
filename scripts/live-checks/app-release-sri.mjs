#!/usr/bin/env node
// Live check of card app-release-sri: APP_HOST may be framed only by SIGN_HOST's shell (card app-in-shell), refuses
// 'wasm-unsafe-eval' and serves every script
// with matching integrity (A1.1, app.md:1439; AX-02 and AX-11, app.md:1387 and :1396). It GETs the page, then every
// script and stylesheet the page names (and any modulepreload or script/style preload), and checks:
//   - the page answers 200 with one Content-Security-Policy whose frame-ancestors is exactly SIGN_HOST;
//   - no response header holds 'wasm-unsafe-eval';
//   - Integrity-Policy is blocked-destinations=(script);
//   - the page loads at least one script, has no inline script, and every script and stylesheet tag is on APP_HOST's
//     own origin and carries exactly one sha384 equal to the sha384 of the bytes APP_HOST serves for it (200).
// The rules are written here, not read from the repo's gate, so a change to the gate cannot pass this check.
// After: app
//   node scripts/live-checks/app-release-sri.mjs [--url <url>] [--record <file>]
//   node scripts/live-checks/app-release-sri.mjs --harness [--root <dir>] [--record <file>]   the same read on a local
//     build served as APP_HOST: the app harness's https server (apps/terminal/test/harness/server.mjs) serves <dir>
//     (apps/terminal/dist by default; build it first) under that dir's own _headers, on APP_HOST's real name
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes the answer the run read ({ url, status, headers, html, files }) to <file>, so the test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { named } from "./record-names.mjs";

const KEY = "app-release-sri";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const URL_ = "https://ct-app.unrealized.trade/";
export const SIGN = "https://confidential.unrealized.trade";
export const INTEGRITY_POLICY = "blocked-destinations=(script)";

const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** Every `<name ...>` start tag of `html` (any case), as its attributes: names lower case, values as written. */
export function tagsOf(html, name) {
  const out = [];
  for (const m of html.matchAll(new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi"))) {
    const attrs = new Map();
    for (const a of m[1].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
      if (!attrs.has(a[1].toLowerCase())) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    out.push(attrs);
  }
  return out;
}

/** What the page loads that the browser checks an integrity on: { what, src, integrity }; src null for an inline script. */
export function loadsOf(html) {
  const out = [];
  for (const s of tagsOf(html, "script")) out.push({ what: "script", src: s.get("src") ?? null, integrity: s.get("integrity") });
  for (const l of tagsOf(html, "link")) {
    const rel = (l.get("rel") ?? "").toLowerCase().split(/\s+/);
    const as = (l.get("as") ?? "").toLowerCase();
    const what = rel.includes("stylesheet") ? "stylesheet" : rel.includes("modulepreload") ? "modulepreload" : rel.includes("preload") && (as === "script" || as === "style") ? `${as} preload` : null;
    if (what) out.push({ what, src: l.get("href") ?? "", integrity: l.get("integrity") });
  }
  return out;
}

/** The check on one answer: { url, status, headers (lower-case names), html, files: { [absolute url]: { status, sha384 } } }. */
export function judge({ url, status, headers, html = "", files = {} }) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET ${url} answers ${status}`);
  const csp = headers["content-security-policy"];
  if (csp === undefined) say(false, "Content-Security-Policy: none sent");
  else {
    const frame = csp.split(/[;,]/).map((d) => d.trim().split(/\s+/)).filter(([k]) => k?.toLowerCase() === "frame-ancestors");
    say(!csp.includes(",") && frame.length === 1 && frame[0].slice(1).join(" ") === SIGN, `CSP frame-ancestors is exactly ${SIGN}${frame.length === 1 ? ` (got ${JSON.stringify(frame[0].slice(1).join(" "))})` : ` (${frame.length} frame-ancestors directives${csp.includes(",") ? ", more than one policy" : ""})`}`);
  }
  const wasm = Object.entries(headers).filter(([, v]) => String(v).toLowerCase().includes("'wasm-unsafe-eval'")).map(([k]) => k);
  say(wasm.length === 0, `no header holds 'wasm-unsafe-eval'${wasm.length ? `: ${wasm.join(", ")}` : ""}`);
  const ip = headers["integrity-policy"];
  say(ip !== undefined && ip.trim() === INTEGRITY_POLICY, `Integrity-Policy: ${ip === undefined ? "none sent" : JSON.stringify(ip)}${ip?.trim() === INTEGRITY_POLICY ? "" : `, want ${JSON.stringify(INTEGRITY_POLICY)}`}`);
  const loads = loadsOf(html);
  const scripts = loads.filter((l) => l.what === "script");
  say(scripts.length > 0, `the page loads ${scripts.length} script(s)`);
  const origin = new URL(url).origin;
  for (const l of loads) {
    if (l.src === null) {
      say(false, "an inline script");
      continue;
    }
    let abs;
    try {
      abs = new URL(l.src, url);
    } catch {
      say(false, `${l.what} ${l.src}: not a URL`);
      continue;
    }
    const want = (l.integrity ?? "").trim().split(/\s+/).filter(Boolean);
    const f = files[abs.href];
    if (abs.origin !== origin) say(false, `${l.what} ${l.src}: not on ${origin}`);
    else if (l.integrity === undefined) say(false, `${l.what} ${l.src}: no integrity`);
    else if (want.length !== 1 || !/^sha384-[A-Za-z0-9+/]{64}$/.test(want[0])) say(false, `${l.what} ${l.src}: integrity must be exactly one sha384 (got ${JSON.stringify(l.integrity)})`);
    else if (!f) say(false, `${l.what} ${l.src}: not read`);
    else if (f.status !== 200) say(false, `${l.what} ${l.src}: answers ${f.status}`);
    else say(f.sha384 === want[0], `${l.what} ${l.src}: integrity ${want[0]}${f.sha384 === want[0] ? " equals the sha384 of the bytes served" : ` but the bytes served are ${f.sha384}`}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Reads the page and every file it loads with an integrity. fetchFn is fetch, or a replay or harness fetch in tests. */
export async function read(url = URL_, fetchFn = fetch) {
  const get = (u) => fetchFn(u, { redirect: "manual", headers: { "cache-control": "no-cache" } });
  const r = await get(url);
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const html = await r.text();
  const files = {};
  for (const l of loadsOf(html)) {
    if (l.src === null || !URL.canParse(l.src, url)) continue;
    const abs = new URL(l.src, url);
    if (abs.origin !== new URL(url).origin || files[abs.href]) continue;
    const a = await get(abs.href);
    const bytes = Buffer.from(await a.arrayBuffer());
    files[abs.href] = { status: a.status, bytes: bytes.length, sha384: sha384(bytes) };
  }
  return { url, status: r.status, headers, html, files };
}

/** A fetch that reaches `port` on 127.0.0.1 for any name, trusting only `ca` (the harness's throwaway certificate). */
export function harnessFetch(port, ca) {
  return (url, opts = {}) =>
    new Promise((ok, fail) => {
      const u = new URL(url);
      const req = request(
        { host: "127.0.0.1", port, servername: u.hostname, path: u.pathname + u.search, method: "GET", headers: { ...opts.headers, host: u.hostname }, ca },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) for (const x of [v].flat()) h.append(k, String(x));
            ok(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      req.end();
    });
}

async function readHarness(root) {
  const { makeCert } = await import("../../apps/terminal/test/harness/certs.mjs");
  const { startServer } = await import("../../apps/terminal/test/harness/server.mjs");
  const host = new URL(URL_).hostname;
  const cert = makeCert([host]);
  try {
    const server = await startServer({ cert: cert.cert, key: cert.key, sites: { [host]: { root, spa: true } } });
    try {
      return await read(URL_, harnessFetch(server.port, cert.cert));
    } finally {
      await server.close();
    }
  } finally {
    cert.remove();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const harness = a.includes("--harness");
    const root = path.resolve(opt("--root", path.join(REPO, "apps/terminal/dist")));
    const answer = harness ? { ...(await readHarness(root)), source: `harness, ${named(root)}` } : await read(opt("--url", URL_));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.url}${harness ? `, ${answer.source}` : ""})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
