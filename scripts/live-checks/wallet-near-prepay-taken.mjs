#!/usr/bin/env node
// Live check of card wallet-near-prepay-taken (audit V-01, Pillow Auditors v1.0): a NEAR deposit still lands by itself
// when a stranger takes its precommitment P first after the relayer's storage_prepay(P), and the stranger's note under P
// is the user's, never this deposit done. The device tells the stranger's note from this deposit by value as well as
// depositor (packages/wallet/src/deposit/bind.ts ownRow: the value one of the note's calls signed, read from the call's
// own bytes by callAmount), since the vault takes the depositor from the message; follow.ts counts only such a note and
// binds U's refunded USDC on U's next second-arrival note P'.
// What it holds on what is deployed, and only that:
//   - SIGN_HOST's served /app.js is the one its index.html pins (sha384);
//   - its code carries the value read (callAmount's refusal, MARK below) and the deposit follow (its lock, LOCK).
// A page without it counts a stranger's deposit naming U as U's own: the op shows done with the stranger's money and,
// with no follow left running, U's refund waits in U (packages/wallet/test/deposit-prepay-taken.test.ts, red at 361a04f2).
// The recorded answers: facts() over this card's committed SIGN_HOST build (packages/signpage/index.html and
// public/app.js), and SIGN_HOST as served before the card's deploy (read 7 Nov).
//   node scripts/live-checks/wallet-near-prepay-taken.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "wallet-near-prepay-taken";
export const SIGN = "https://sign.confidential.unrealized.trade";
/** bind.ts callAmount's refusal: in the bundle only where the device reads a call's signed amount. */
export const MARK = "the note's call names no amount";
/** The deposit follow's lock (packages/signpage/src/deposit-follow.ts FOLLOW_LOCK). */
export const LOCK = "ct-wallet/deposit-follow/";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** What the check keeps of the reads: the index, the bundle's sha384 and its two marks. */
export function facts(index, js) {
  return { index, sha384: sha384(js), value_read: js.includes(MARK), lock: js.includes(LOCK) };
}

/** The verdict on an answer { index, sha384, value_read, lock }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.value_read !== true) bad(`SIGN_HOST's bundle does not read a deposit call's signed amount (${JSON.stringify(MARK)}): a stranger's deposit naming U counts as U's`);
  if (a?.lock !== true) bad(`SIGN_HOST's bundle has no deposit follow (${LOCK})`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error", headers: { "cache-control": "no-cache" } });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return facts(index, await get("/app.js"));
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
