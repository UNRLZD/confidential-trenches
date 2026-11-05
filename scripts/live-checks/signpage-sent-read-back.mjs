#!/usr/bin/env node
// Live check of card signpage-sent-read-back on SIGN_HOST (https://sign.confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction
// (it never names the helper's /v1/pool/solana/send), or the hook it calls right after it takes the helper's signature
// is `named` (src/pool-buy.ts sendAndSettle: a name to read back, never told), not `sent` (the app's answer, which waits
// until both RPCs read this very transaction under it). SIGN_HOST's mainnet build sends no pool transaction until
// pinned pools land there, so today the check holds the pin and that rule for that day.
// It reads one spot of the minified bundle, so it does not prove the whole rule (no answer's txs name the helper's
// signature before the read-back, for buy and withdraw): that is held by packages/signpage/test/pool-buy.test.ts and
// test/pool-withdraw.test.ts (the helper answering a signature that is not this transaction's, red on main a95cce2).
// The recorded testnet answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg, { network:
// "testnet" }) of each tree (this file reaches no package code: the import check holds it).
//   node scripts/live-checks/signpage-sent-read-back.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-sent-read-back";
export const SIGN = "https://sign.confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The hooks the bundle calls right after it checks the helper's signature is one (64 bytes of base58), in order. */
const HOOK = /\.length!==64\)return [\w$]+\(\[\]\);await [\w$]+\.([\w$]+)\?\.\(/g;

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), poolSend: js.includes("/v1/pool/solana/send"), hooks: [...js.matchAll(HOOK)].map((m) => m[1]) };
}

/** The verdict on an answer { index, sha384, poolSend, hooks }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean" || !Array.isArray(a?.hooks)) bad("the bundle's facts are not read");
  else if (a.poolSend && a.hooks.length !== 1) bad(`the bundle sends pool transactions and its hook after the helper's signature is not read (${a.hooks.length} found)`);
  else if (a.poolSend && a.hooks[0] !== "named") bad(`the bundle calls ${a.hooks[0]} with the helper's signature before any read-back: the app is told a transaction the chain has not read as its own`);
  else if (!a.poolSend) lines.push("NOTE the bundle sends no pool transaction (no pinned pool on this build)");
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
