#!/usr/bin/env node
// Live check of card kit-portfolio-reads: SIGN_HOST's state sends each op with what the device holds of it beside its
// stage (kit 1.9 OpDetail: created_ms, chain, token, units, amount_usd), so the terminal's Activity draws every row's
// time, size, chain and token from the kit alone. A signed-out page sends no ops, so the check reads the deployed build's
// code path. The page is one script: src/main.ts and all it imports are bundled into /app.js
// (packages/signpage/scripts/build-app.mjs), which / names with its sha384, and the bundler keeps only code the page
// reaches. The check reads what SIGN_HOST serves at / and at that script:
//   - / names exactly one module script, /app.js, with its integrity, and /app.js's sha384 is that integrity;
//   - /app.js's op reader (src/state.ts opOf) walks the five detail keys and copies each the record holds onto the op it
//     sends, only when the op still fits the kit's state with it (FILL, whatever names the minifier gives);
//   - a pool sell's record keeps its chain, token and the token amount asked at the token's decimals (SELL,
//     src/pool-sell.ts), and a trade-box trade's its chain, token and a buy's USD size (TRADE, src/trade.ts), from the
//     request, so FILL has them to send.
// That a kit 1.8 app or older is sent each op with no detail (its client drops the op for one) is kit-frame-version's
// (After: sign), which reads the 1.8 level and its strip on the same build.
// After: sign
//   node scripts/live-checks/kit-portfolio-reads.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/kit-portfolio-reads.mjs --local [--record <file>]   this tree's build
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the script's path, integrity, size, sha384 and each mark's
//   count, never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

const KEY = "kit-portfolio-reads";
export const SIGN_ORIGIN = "https://confidential.unrealized.trade";
/** opOf's walk over the detail keys, each copied when the record holds it and the op still fits with it:
 *  `K=[\`created_ms\`,...];...for(let e of K)t[e]===void 0||Object.hasOwn(r,e)||i({...r,[e]:t[e]})&&(r[e]=t[e])`. */
export const FILL = /([\w$]+)=\[`created_ms`,`chain`,`token`,`units`,`amount_usd`\][^]{0,4000}?for\(let ([\w$]+) of \1\)([\w$]+)\[\2\]===void 0\|\|Object\.hasOwn\(([\w$]+),\2\)\|\|[\w$]+\(\{\.\.\.\4,\[\2\]:\3\[\2\]\}\)&&\(\4\[\2\]=\3\[\2\]\)/g;
/** A pool sell's record: `chain:\`solana\`,token:n.token,units:f(n.amount,n.decimals)`. */
export const SELL = /chain:`solana`,token:([\w$]+)\.token,units:[\w$]+\(\1\.amount,\1\.decimals\)/g;
/** A trade-box trade's record: `created_ms:n(),chain:\`solana\`,token:s,...o===\`buy\`?{amount_usd:c}:{}`. */
export const TRADE = /created_ms:[\w$]+\(\),chain:`solana`,token:[\w$]+,\.\.\.[\w$]+===`buy`\?\{amount_usd:[\w$]+\}:\{\}/g;
const countOf = (text, re) => [...text.matchAll(re)].length;

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
  const has = (k) => Number.isSafeInteger(m[k]) && m[k] >= 1;
  say(has("fill"), `/app.js sends each op's time, chain, token, units and USD size its record holds (fill ${m.fill ?? "?"})`);
  say(has("sell"), `/app.js keeps a pool sell's chain, token and units on its record (sell ${m.sell ?? "?"})`);
  say(has("trade"), `/app.js keeps a trade's chain, token and a buy's USD size on its record (trade ${m.trade ?? "?"})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from this tree's build (scripts/signpage-built.mjs), as SIGN_HOST serves them. */
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
    marks: { fill: countOf(text, FILL), sell: countOf(text, SELL), trade: countOf(text, TRADE) },
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
