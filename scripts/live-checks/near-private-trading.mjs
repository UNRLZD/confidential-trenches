#!/usr/bin/env node
// Live check of card near-private-trading on SIGN_HOST (https://confidential.unrealized.trade). What it holds, and only
// that: the served /app.js is the one index.html pins (its sha384), it is the /app.js of a written release list from this
// card's release on (packages/signpage/releases/release-<N>.json, N >= FIRST_RELEASE), so its bytes are a build of source
// whose tests ran; and in it, as minified, the NEAR trade's binding on the page (packages/signpage/src/near-buy.ts):
//   - record: the buy's record key in the wallet store (`near-buy:`) and its write before the payout (`near buy recorded`);
//   - lock: one trade of a token at a time, the Web Lock's name (`ct-near-buy/`);
//   - sell: the sell bound to a buy record's W (`near sell recorded`);
//   - pools: the quote's candidate pools read from Rhea's own list (`get_number_of_pools`, src/near-pools.ts).
// That the record is written before the payout, the payout is pinned to the record's note, a stopped buy or sell goes on
// from its record and never pays twice, and every answer after the payout is sent or filled, is held by the card's tests
// (packages/signpage/test/near-trade.test.ts, near-buy.test.ts, near-sell.test.ts). The money run itself is the owner's.
// The recorded answers are facts() over a tree's packages/signpage/index.html and public/app.js, or SIGN_HOST's own
// page. This file reaches no package code (the import check holds it). The PR's own build runs judge(read, { ledger:
// false }) in scripts/ci/bundle-checks.mjs, since it is cut as a release only after its merge.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/near-private-trading.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "near-private-trading";
export const SIGN = "https://confidential.unrealized.trade";
/** This card's release: the first list cut after release-118 (main's newest when this card was built, without it). */
export const FIRST_RELEASE = 119;
const RELEASES = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "packages/signpage/releases");
/** The SIGN_HOST /app.js of every written release list from FIRST_RELEASE on: its sha384 to its release. */
export function releasedAppJs(dir = RELEASES, from = FIRST_RELEASE) {
  const out = new Map();
  for (const f of readdirSync(dir)) {
    const n = /^release-(\d+)\.json$/.exec(f)?.[1];
    if (n === undefined || Number(n) < from) continue;
    const app = JSON.parse(readFileSync(path.join(dir, f), "utf8")).hosts?.SIGN_HOST?.files?.find((x) => x.path === "/app.js");
    if (typeof app?.sha384 === "string") out.set(app.sha384, `release-${n}`);
  }
  return out;
}
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const has = (js, ...marks) => marks.every((m) => js.includes(m));

/** What the check keeps of the reads: the index, the served bundle's sha384, and whether the bundle holds each mark. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    record: has(js, "near-buy:", "near buy recorded"),
    lock: has(js, "ct-near-buy/"),
    sell: has(js, "near sell recorded"),
    pools: has(js, "get_number_of_pools"),
  };
}

export const MARKS = {
  record: "the page keeps no NEAR buy record before the payout",
  lock: "the page holds no lock per token: two trades of one token could run at once",
  sell: "the page binds no NEAR sell to a buy's wallet",
  pools: "the page reads no Rhea pool list for the NEAR quote",
};

/** The verdict on an answer, against the release lists' /app.js files (none with `ledger: false`). */
export function judge(a, { ledger = true, released = ledger ? releasedAppJs() : null } = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (released && !released.has(a?.sha384)) bad("SIGN_HOST's served /app.js is the /app.js of no release list of this card's on: bytes no tested source built");
  for (const [k, m] of Object.entries(MARKS)) if (a?.[k] !== true) bad(m);
  return { ok: lines.length === 0, lines };
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

/** How scripts/ci/bundle-checks.mjs runs this check on a build (its `// Bundle: read` line): `f` answers from the build
 *  folders as the host would; `dirs` names them (card ci-stops-costing-reruns, moved from bundle-checks.mjs). */
export async function bundle(f) {
  const m = await import(import.meta.url);
  return m.judge(await m.read(f), { ledger: false });
}
