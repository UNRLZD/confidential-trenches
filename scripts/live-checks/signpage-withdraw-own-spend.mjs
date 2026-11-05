#!/usr/bin/env node
// Live check of card signpage-withdraw-own-spend on SIGN_HOST (https://sign.confidential.unrealized.trade), which
// serves the mainnet build: a withdraw's owed sends (their attempt and context) live in the wallet store's meta under
// owed/<op id>, which the frame's reader neither reads nor lists, so the ops records the frame decrypts hold none
// (round-3 review LOW 2), and the database stays at version 1, so a rollback of SIGN_HOST never locks a wallet (fold 3).
// It reads SIGN_HOST's index.html and the /app.js it serves, and judges:
//   - the served /app.js is the one index.html pins (its sha384);
//   - the bundle's wallet store list is the paper's seven stores, no more, and it opens its database at version 1;
//   - the bundle's store takes owed/<op id> as a meta key (its rule /^owed\/[^/]{1,200}$/), and its reader leaves
//     owed/ keys out of what it lists for meta.
// The withdraw run's own-spend reads (src/pool-withdraw.ts spendOwner) are in the testnet build only, which no host
// serves; the pool-withdraw and pool-testnet tests and the round-3 probes cover them.
//   node scripts/live-checks/signpage-withdraw-own-spend.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-withdraw-own-spend";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
// the minified store list, quoted with backticks or double quotes: the paper's seven, then any more
const STORES = /\[([`"])notes\1,\1wallets\1,\1quotes\1,\1orders\1,\1ops\1,\1counters\1,\1meta\1((?:,\1[a-z]+\1)*)\]/;
const OPENS_V1 = /\.open\([A-Za-z_$][\w$]*,1\)/;
const OWED_KEY = "/^owed\\/[^/]{1,200}$/";
const READER = /\.startsWith\(([`"])owed\/\1\)/;

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  const m = STORES.exec(js);
  return { index, sha384: sha384(js), stores: m ? m[0] : null, opensV1: OPENS_V1.test(js), owedKey: js.includes(OWED_KEY), readerHidesOwed: READER.test(js) };
}

/** The verdict on an answer { index, sha384, stores, opensV1, owedKey, readerHidesOwed }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  const more = typeof a?.stores === "string" ? (STORES.exec(a.stores)?.[2] ?? "") : null;
  if (more === null) bad("the bundle's wallet store list is not found");
  else if (more !== "") bad("the wallet store names a store past the paper's seven: its database would need a version past 1");
  if (a?.opensV1 !== true) bad("the wallet store does not open its database at version 1: a rollback of SIGN_HOST would lock every wallet");
  if (a?.owedKey !== true) bad("the wallet store takes no owed/<op id> meta key: an owed send's context would sit in the ops the frame reads");
  if (a?.readerHidesOwed !== true) bad("the frame's reader lists owed/ keys of meta");
  return { ok: lines.length === 0, lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
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
