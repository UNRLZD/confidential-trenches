#!/usr/bin/env node
// Live check of card wallet-withdraw-move-out: SIGN_HOST's withdraw path pays the NEAR account the user typed straight
// from the vault (the proof's recipient is that account, fund_recipient false, its own register_deposit), follows the
// landing to the arrival on the vault's spend row, and shows a settle pass's unmatched withdrawal. The page is one
// script: src/main.ts and all it imports are bundled into /app.js (packages/signpage/scripts/build-app.mjs), which
// / names with its sha384. So the check reads what SIGN_HOST serves at / and at that script, as a browser does:
//   - / names exactly one module script, /app.js, with its integrity, and /app.js's sha384 is that integrity;
//   - /app.js holds this card's strings, which minifying keeps (string literals): the typed account's registration
//     read (readTypedRegistration's refusal), withdrawRequest's refusal of the vault, intents.near or the token as the
//     typed recipient, the arrival read's input refusal (wallet/src/withdraw/arrival.ts), and the form's unmatched
//     notice (its mark and its draft words).
// The mainnet build offers no hand-off until the release names mainnet's relayer (handoff.ts withdrawHandoff: null);
// the code that pays the typed account is in the bundle either way, which is what this reads.
//   node scripts/live-checks/wallet-withdraw-move-out.mjs [--url <origin>] [--record <file>]
//   node scripts/live-checks/wallet-withdraw-move-out.mjs --local [--record <file>]   this tree's committed build
//   PASS exit 0, FAIL exit 1, error exit 2. The record holds the script's path, integrity, size, sha384 and each
//   marker's count, never the bytes.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-withdraw-move-out";
export const SIGN_ORIGIN = "https://sign.confidential.unrealized.trade";
const SIGNPAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage");
/** This card's strings in the bundle, each as the minifier writes it. */
export const MARKERS = [
  "the typed account is not a NEAR account id",
  "to: the vault, intents.near or the token",
  "nullifierHash or recipient: not given",
  "dataset.notice=`unmatched`",
  "Withdrawal unmatched",
];

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
  const m = a.markers ?? {};
  const missing = MARKERS.filter((k) => !(Number.isSafeInteger(m[k]) && m[k] >= 1));
  say(missing.length === 0, `/app.js pays the typed account and shows an unmatched withdrawal (${missing.length ? `missing ${missing.join(", ")}` : `${MARKERS.length} marks found`})`);
  return { pass: lines.every((l) => l.startsWith("ok ")), lines };
}

/** Answers / and /app.js from this tree's committed build, as SIGN_HOST serves them. */
export const localFetch = async (url) => {
  const p = new URL(url).pathname;
  const file = p === "/" ? path.join(SIGNPAGE, "index.html") : p === "/app.js" ? path.join(SIGNPAGE, "public/app.js") : null;
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
    markers: Object.fromEntries(MARKERS.map((k) => [k, text.split(k).length - 1])),
  };
  return rec;
}

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
