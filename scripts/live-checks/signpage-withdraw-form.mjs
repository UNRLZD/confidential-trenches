#!/usr/bin/env node
// Live check of card signpage-withdraw-form: SIGN_HOST serves the withdraw form (packages/signpage/src/withdraw/,
// wired in src/main.ts), the form that refuses a bad address or amount before any proof. The page is one script:
// src/main.ts and everything it imports are bundled into /app.js (packages/signpage/scripts/build-app.mjs), the file
// the release list names at its path with its sha384 (scripts/live-checks/signpage-release.mjs reads that list). So the
// check reads what SIGN_HOST serves at / and at the script it names, as a browser does:
//   - / names exactly one module script, /app.js, with its integrity;
//   - /app.js's sha384 is that integrity (the bytes the browser runs: SIGN_HOST's Integrity-Policy blocks any other);
//   - /app.js holds the form's own strings, which minifying keeps (string literals): the refusal codes not-account and
//     no-account, the RPC answer it reads (UNKNOWN_ACCOUNT), the Withdraw button's pending mark (withdraw-relay), the
//     form's mark (withdraw = "form") and its draft refusal words (Invalid address, Busy · Retry).
//   node scripts/live-checks/signpage-withdraw-form.mjs [--url <origin>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the script's path, integrity, size, sha384 and each
//   marker's count, never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "signpage-withdraw-form";
export const SIGN_ORIGIN = "https://sign.confidential.unrealized.trade";
/** The form's strings in the bundle, each as the minifier writes it (string literals and a dataset property). */
export const MARKERS = ["not-account", "no-account", "UNKNOWN_ACCOUNT", "withdraw-relay", "dataset.withdraw=`form`", "Invalid address", "Busy · Retry"];

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  const m = a.markers ?? {};
  const missing = MARKERS.filter((k) => !(Number.isSafeInteger(m[k]) && m[k] >= 1));
  say(missing.length === 0, `/app.js holds the withdraw form (${missing.length ? `missing ${missing.join(", ")}` : `${MARKERS.length} marks found`})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Reads `origin` as a browser does and returns the record. */
export async function probe(origin, fetchFn = fetch) {
  const get = (p) => fetchFn(new URL(p, origin), { redirect: "error", headers: { accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const page = await get("/");
  const html = await page.text();
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((t) => t[0]);
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const tag = tags[0] ?? "";
  const index = { status: page.status, scripts: tags.length, src: attr(tag, "src"), integrity: attr(tag, "integrity"), module: attr(tag, "type") === "module" };
  const rec = { key: KEY, url: origin, at: new Date().toISOString(), index, app: {} };
  if (index.src !== "/app.js") return rec;
  const res = await get(index.src);
  const body = Buffer.from(await res.arrayBuffer());
  const text = body.toString("utf8");
  rec.app = {
    status: res.status,
    bytes: body.length,
    sha384: `sha384-${createHash("sha384").update(body).digest("base64")}`,
    markers: Object.fromEntries(MARKERS.map((k) => [k, text.split(k).length - 1])),
  };
  return rec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const rec = await probe(opt("--url") ?? SIGN_ORIGIN);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.pass ? "PASS" : "FAIL"} (${rec.url})`);
    process.exit(r.pass ? 0 : 1);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
