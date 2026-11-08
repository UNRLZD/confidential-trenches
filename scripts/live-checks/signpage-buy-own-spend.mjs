#!/usr/bin/env node
// Live check of card signpage-buy-own-spend on SIGN_HOST (https://confidential.unrealized.trade). What it holds,
// and only that: the served /app.js is the one index.html pins (its sha384); and the bundle sends no pool transaction
// (it never names the helper's /v1/pool/solana/send), or it reads a landed transaction's loaded keys
// (loadedAddresses, src/pool-spend.ts keysOf: without it, a buy's own tag 3, whose pool account comes from the lookup
// table, never reads as its own spend). SIGN_HOST's mainnet build sends no pool transaction until pinned pools land
// there, so today the check holds the pin and that rule for that day.
// It does not prove the buy's owner rule (filled only on this attempt's own spend, src/pool-buy.ts sendAndSettle): a
// bundle of main's pool-buy.ts with this card's spend reader reads loaded keys too and passes here (the recorded
// "mutant" answer). That rule is held by packages/signpage/test/pool-buy.test.ts (each path with another device's
// spend answers not_landed, red on main 8791c3d) and test/pool-withdraw.test.ts (spendOwner on the kit's real tag 3),
// and by the two-device devnet run in signpage-buy-own-spend.md.
// The recorded testnet answers are facts() over packages/signpage/scripts/build-app.mjs bundle(pkg, { network:
// "testnet" }) of each tree (this file reaches no package code: the import check holds it).
// After: sign
//   node scripts/live-checks/signpage-buy-own-spend.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "signpage-buy-own-spend";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const count = (js, s) => js.split(s).length - 1;

/** What the check keeps of the reads: the index, the served bundle's sha384 and the facts read from it. */
export function facts(index, js) {
  return { index, sha384: sha384(js), poolSend: count(js, "/v1/pool/solana/send") > 0, loadedKeys: count(js, "loadedAddresses") > 0 };
}

/** The verdict on an answer { index, sha384, poolSend, loadedKeys }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (typeof a?.poolSend !== "boolean" || typeof a?.loadedKeys !== "boolean") bad("the bundle's facts are not read");
  else if (a.poolSend && !a.loadedKeys) bad("the bundle sends pool transactions and never reads a landed transaction's loaded keys: a buy's own tag 3 never reads as its own spend");
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
