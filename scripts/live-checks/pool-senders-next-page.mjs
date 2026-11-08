#!/usr/bin/env node
// Live check of card pool-senders-next-page on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384), it is a released build from release-92 on
// (a packages/signpage/releases/release-<N>.json, N >= 92, names its sha384 for SIGN_HOST), and in it, as minified, the
// Solana sell (src/pool-sell.ts):
//   - window: a partial sell names each tree's next page (the eight) only when both trees are within
//     SOLANA_POOL_NEXT_PAGE_WINDOW (64) entries of a page's end, `!keeps || near(stateSize) && near(labelSize)`; a
//     sell further from it sends the six, whose deposit a page opened meanwhile fails WrongAccount, and is rebuilt;
//   - fallback: when the eight is refused (its reserve over the cap, or a pool rule), the sell is built again as the six,
//     `built ?? await form(false)`, and any other error still throws.
// What each does is held by the card's tests (packages/signpage/test/pool-sell.test.ts, T1, T2, the window's edge, one
// tree in and one out, the band edges at 2,473,120 and 3,936,160); the recorded answers are facts() over a tree's
// packages/signpage/index.html and public/app.js, or SIGN_HOST's own page. A build of release-91 or earlier carries
// neither shape, and the release ledger tells a release-92-or-later build from any other. This file reaches no package
// code (the import check holds it). The PR's own build runs judge(read, { ledger: false }) in scripts/ci/bundle-checks.mjs,
// since it is cut as a release only after its merge.
//   node scripts/live-checks/pool-senders-next-page.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "pool-senders-next-page";
export const SIGN = "https://confidential.unrealized.trade";
/** The first release whose sell holds the window rule and the six fallback. */
export const FOLDED_FROM = 92;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const N = "[\\w$]+";
// near(size): the entries left on the size's page are within the window (SOLANA_POOL_NEXT_PAGE_WINDOW, 64), and the
// eight only when the message fits and, on a partial sell, both trees are near
const WINDOW = new RegExp(`(${N})=(${N})=>${N}-\\2%${N}<=64,${N}=${N}\\(${N}\\(${N}\\.address,\\[[^\\]]{0,200}\\],${N}\\.blockhash,\\[\\]\\)\\.message\\)\\.length<=1232&&\\(!${N}\\|\\|\\1\\(${N}\\.stateSize\\)&&\\1\\(${N}\\.labelSize\\)\\)`);
// the eight tried, a refusal of it caught (two refusal classes, any other error thrown), then the six
const FALLBACK = new RegExp(`if\\((${N})\\)try\\{(${N})=await (${N})\\(!0\\)\\}catch\\((${N})\\)\\{if\\(!\\(\\4 instanceof ${N}\\|\\|\\4 instanceof ${N}\\)\\)throw \\4\\}let\\{wire:${N},value:${N}\\}=\\2\\?\\?await \\3\\(!1\\)`);

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), window: WINDOW.test(js), fallback: FALLBACK.test(js) };
}

/** SIGN_HOST's /app.js sha384 in every release list from FOLDED_FROM on (packages/signpage/releases/). */
export function foldedReleases(dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases")) {
  const out = new Set();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < FOLDED_FROM) continue;
    const list = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    for (const x of list.hosts?.SIGN_HOST?.files ?? []) if (x.path === "/app.js") out.add(x.sha384);
  }
  return out;
}

/** The verdict on an answer { index, sha384, window, fallback }, against the release lists' bundles `folded` (none with `ledger: false`). */
export function judge(a, { ledger = true, folded = ledger ? foldedReleases() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.window !== true) bad("a partial sell names the next pages with a tree far from its page's end: a deposit landing first opens a page the sell does not name, and the sell fails");
  if (a?.fallback !== true) bad("a sell whose eight is refused is not built again as the six: a sell inside the reserve's band is refused");
  if (folded && !folded.has(a?.sha384)) bad(`SIGN_HOST's /app.js is not a release-${FOLDED_FROM}-or-later build: ${a?.sha384 ?? "not read"}`);
  return { ok: !lines.length, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
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
