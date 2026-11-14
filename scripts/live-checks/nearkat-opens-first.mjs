#!/usr/bin/env node
// Live check of card nearkat-opens-first on APP_HOST (https://ct-app.unrealized.trade). What it holds, and only that:
// APP_HOST serves the script its index.html pins (its sha384), and that script opens / on All (a fresh open, no token in
// the address) on NEARKAT, Solana mint 6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr (owner 14 Nov 17:20Z), read as
// minified:
//   - the token / opens (apps/terminal/src/routes/routes.ts OPEN_TOKEN): `{chain:`solana`,id:`6UtY…`}`;
//   - / on All reads that token, a chain pick its own top Trending token (source.ts loadHome): `e===`all`?x(T.chain,T.id`.
// That a token named in the address still wins, and the page drawn, are held by the tests that build them
// (apps/terminal/test/no-test-token.test.ts, test/chains-evm/run.mjs at 1440 in a browser). The recorded answers are
// facts() over APP_HOST's build (apps/terminal/dist).
// After: app
// Bundle: read app
//   node scripts/live-checks/nearkat-opens-first.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "nearkat-opens-first";
export const APP = "https://ct-app.unrealized.trade";
export const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const N = "[\\w$]+";
const Q = "[`\"']";
/** The token / opens, as one object, its name kept (the group). */
const OPEN = new RegExp(`(${N})=\\{chain:${Q}solana${Q},id:${Q}${NEARKAT}${Q}\\}`);
/** / on All reads that token by its chain and id. */
const HOME = (name) => new RegExp(`${N}===${Q}all${Q}\\?${N}\\(${name.replace(/\$/g, "\\$")}\\.chain,${name.replace(/\$/g, "\\$")}\\.id[,)]`);

/** The script an index.html pins, and its integrity. */
const pinned = (index) => {
  const m = /<script[^>]*\bsrc="([^"]+\.js)"[^>]*\bintegrity="([^"]+)"/.exec(index ?? "") ?? /<script[^>]*\bintegrity="([^"]+)"[^>]*\bsrc="([^"]+\.js)"/.exec(index ?? "");
  if (!m) return null;
  return m[1].endsWith(".js") ? { src: m[1], integrity: m[2] } : { src: m[2], integrity: m[1] };
};

/** What the check keeps of the read: the index, its served script's sha384, and the two marks read from it. */
export function facts(app) {
  const open = OPEN.exec(app.js);
  return { app: { index: app.index, sha384: sha384(app.js), open: !!open, home: !!open && HOME(open[1]).test(app.js) } };
}

/** The verdict on an answer { app: { index, sha384, open, home } }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = pinned(a?.app?.index);
  if (!pin) bad("APP_HOST's index.html pins no script");
  else if (pin.integrity !== a.app.sha384) bad("APP_HOST's served script is not the one index.html pins");
  if (a?.app?.open !== true) bad(`the app names no token for / to open: NEARKAT (${NEARKAT}) is not in it`);
  else if (a?.app?.home !== true) bad("/ on All does not open NEARKAT: it opens the top Trending token");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${APP}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${APP}${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  const pin = pinned(index);
  return facts({ index, js: pin ? await get(pin.src.startsWith("/") ? pin.src : `/${pin.src}`) : "" });
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
