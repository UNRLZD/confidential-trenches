#!/usr/bin/env node
// Live check of card signpage-state-holdings: SIGN_HOST's state carries the vault's USDC from the device's own notes,
// never a fixed "0". A signed-out page shows no balance, so the check reads the deployed build's code path. The page is
// one script: src/main.ts and all it imports are bundled into /app.js (packages/signpage/scripts/build-app.mjs), which
// / names with its sha384, and the bundler keeps only code the page reaches, so the sum in /app.js is the state step's
// (src/main.ts withVaultBalance, src/vault-balance.ts). The check reads what SIGN_HOST serves at / and at that script:
//   - / names exactly one module script, /app.js, with its integrity, and /app.js's sha384 is that integrity;
//   - /app.js holds the sum's refusal of a counted note with no leaf value (a string literal, which minifying keeps);
//   - /app.js sets vault_balance from that sum at USDC's 6 decimals over an awaited notes read (FILL, whatever names
//     the minifier gives), where the build before it only ever wrote vault_balance:`0`.
// After: sign
//   node scripts/live-checks/signpage-state-holdings.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/signpage-state-holdings.mjs --local [--record <file>]   this tree's committed build
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the script's path, integrity, size, sha384 and each
//   mark's count, never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "signpage-state-holdings";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** The sum's refusal, as src/vault-balance.ts writes it. */
export const SUM = "vault balance: a counted note has no leaf value";
/** vault_balance set from the sum of an awaited notes read, at 6 decimals: `vault_balance:f(g(await r(),s),6)`. */
export const FILL = /vault_balance:[\w$]+\([\w$]+\(await [\w$]+\(\),[\w$]+\),6\)/g;
const countOf = (text, k) => (k instanceof RegExp ? [...text.matchAll(k)].length : text.split(k).length - 1);

/** The verdict on a record: { pass, lines }. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const s = rec?.index ?? {};
  say(s.scripts === 1 && s.src === "/app.js" && s.module === true && /^sha384-[A-Za-z0-9+/]{64}$/.test(s.integrity ?? ""),
    `/ names one module script, /app.js, with its integrity (${s.scripts ?? "?"} script(s), ${s.src ?? "none"})`);
  const a = rec?.app ?? {};
  say(a.status === 200 && Number.isSafeInteger(a.bytes) && a.bytes > 0 && a.sha384 === s.integrity,
    `/app.js is the script / names: its sha384 is the integrity (HTTP ${a.status ?? "?"}, ${a.bytes ?? "?"} bytes)`);
  const m = a.marks ?? {};
  const sum = Number.isSafeInteger(m.sum) && m.sum >= 1;
  const fill = Number.isSafeInteger(m.fill) && m.fill >= 1;
  say(sum && fill, `/app.js fills vault_balance from the device's own notes (sum ${m.sum ?? "?"}, fill ${m.fill ?? "?"})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from this tree's build, made from its sources (signBuilt), as SIGN_HOST serves them. */
export const localFetch = async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(signBuilt(), "index.html") : p === "/app.js" ? path.join(signBuilt(), "public/app.js") : null;
  if (file === null) return new Response("", { status: 404 });
  return new Response(readFileSync(file), { status: 200 });
};

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
    marks: { sum: countOf(text, SUM), fill: countOf(text, FILL) },
  };
  return rec;
}

/** SIGN_HOST's record, read with `fetchFn` (scripts/ci/bundle-checks.mjs runs read and judge on a pull request's build). */
export const read = (fetchFn = fetch) => probe(SIGN_ORIGIN, fetchFn);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  try {
    const local = args.includes("--local");
    const rec = await probe(local ? SIGN_ORIGIN : (opt("--url") ?? SIGN_ORIGIN), local ? localFetch : fetch);
    if (local) rec.url = "local build";
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
