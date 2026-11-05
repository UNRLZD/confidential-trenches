#!/usr/bin/env node
// Live check of card signpage-buy-own-spend on SIGN_HOST (https://sign.confidential.unrealized.trade): a pool buy shows
// filled only when both RPCs read that the note's spend is this attempt's own (src/pool-buy.ts sendAndSettle through
// src/pool-withdraw.ts spendOwner), and spendOwner reads a release and buy (tag 3) by the keys its lookups load
// (getTransaction's meta loadedAddresses), so another device on the same 12 words that spent the note first is
// not_landed, never filled.
// It reads SIGN_HOST's index.html and the /app.js it serves, and judges:
//   - the served /app.js is the one index.html pins (its sha384);
//   - a bundle that sends pool transactions (it names the helper's /v1/pool/solana/send) reads W's history
//     (getSignaturesForAddress) and the loaded keys of a landed transaction (loadedAddresses): a bundle with the pool
//     send and without them answers filled on the spent mark alone. SIGN_HOST's mainnet build sends no pool
//     transaction until pinned pools land there, so today the check holds the pin and the rule for that day.
// The run itself is proven by packages/signpage/test/pool-buy.test.ts (each path with another device's spend answers
// not_landed) and test/pool-withdraw.test.ts (spendOwner on the kit's real tag 3).
//   node scripts/live-checks/signpage-buy-own-spend.mjs [--record <file>] [--answer <file>]
//   node scripts/live-checks/signpage-buy-own-spend.mjs --local [--network mainnet|testnet] [--record <file>]
//     the same judgement on this checkout's fresh build (packages/signpage/scripts/build-app.mjs bundle)
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-buy-own-spend";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const count = (js, s) => js.split(s).length - 1;

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), poolSend: count(js, "/v1/pool/solana/send") > 0, history: count(js, "getSignaturesForAddress") > 0, loadedKeys: count(js, "loadedAddresses") > 0 };
}

/** The verdict on an answer { index, sha384, poolSend, history, loadedKeys }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean" || typeof a?.history !== "boolean" || typeof a?.loadedKeys !== "boolean") bad("the bundle's facts are not read");
  else if (a.poolSend) {
    if (!a.history) bad("the bundle sends pool transactions and never reads W's history: a buy is filled on the spent mark alone");
    if (!a.loadedKeys) bad("the bundle sends pool transactions and never reads a landed tag 3's loaded keys: its own buy reads as another's spend, another device's never as one");
  } else lines.push("NOTE the bundle sends no pool transaction (no pinned pool on this build)");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  return facts(await get("/"), await get("/app.js"));
}

/** This checkout's fresh build for `network`, read the way SIGN_HOST's is. */
export async function readLocal(network = "mainnet") {
  const { bundle } = await import("../../packages/signpage/scripts/build-app.mjs");
  const b = await bundle(undefined, { network });
  const js = typeof b.js === "string" ? b.js : new TextDecoder().decode(b.js);
  return facts(b.html, js);
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : process.argv.includes("--local") ? await readLocal(arg("--network") ?? "mainnet") : await read();
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
