#!/usr/bin/env node
// Live check of card buy-spends-its-change-in-the-same-tap on SIGN_HOST (https://confidential.unrealized.trade).
// What it holds, signed out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as
// minified:
//   - carry: Max and the buy's pick weigh, beside the ready pieces, the change a released note leaves (src/pool-carry.ts
//     carriesOf: a pick piece `<note>#change`), so Max is what the pool holds less one tap's costs;
//   - prove: the proof queue proves a first round's change to the round's W at once (packages/wallet/src/pool/queue.ts
//     proveFor, its refusal of a note that is not UNSPENT and landed);
//   - round: the page's host finds that change by its parent and hands it to proveFor (src/pool-testnet.ts carry.prove).
// What each does is held by the card's tests (packages/signpage/test/pool-buy.test.ts's recorded two-round run,
// buy-spends-its-change.test.ts from the owner's account as read 13 Nov 18:23Z, rules-pool.test.ts's first-round
// rules, packages/wallet/test/pool-queue-prove-for.test.ts); a real carried buy is the owner's next trade past Max.
// The recorded answers are facts() over a built tree's index.html and app.js (good: this card's branch, built with
// packages/signpage/scripts/build-app.mjs --out) and over SIGN_HOST as served before the card (bad).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/buy-spends-its-change-in-the-same-tap.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "buy-spends-its-change-in-the-same-tap";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const ID = "[\\w$]+";
// carriesOf: the carried piece's id, the parent's with #change
const CARRY = new RegExp(`noteId:\`\\$\\{${ID}\\.noteId\\}#change\``);
// proveFor's refusal of a note it cannot prove
const PROVE = /proveFor: note \$\{[\w$]+\} is not an UNSPENT landed note of this pool with a listed piece/;
// the host's carry.prove: the change its settle wrote, found by its parent
const ROUND = /no change written for note \$\{[\w$]+\}/;

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), carry: CARRY.test(js), prove: PROVE.test(js), round: ROUND.test(js) };
}

/** The verdict on an answer { index, sha384, carry, prove, round }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.carry !== true) bad("Max and the pick weigh no carried change: a buy stops at the ready pieces, Max under what the pool holds");
  if (a?.prove !== true) bad("the proof queue cannot prove a first round's change to its W: no carried change is spent in the tap");
  if (a?.round !== true) bad("the page hands no settled change to the queue: the buy has no first round");
  if (lines.length === 0) lines.push("ok  a buy past the ready pieces carries the change in the same tap, and Max counts it");
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    return r.text();
  };
  const index = await get("/");
  return facts(index, await get("/app.js"));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer);
    for (const l of lines) console.log(l);
    console.log(`CARD ${KEY} / live: ${ok ? "PASS" : "FAIL"} (${arg("--answer") ? `answer ${arg("--answer")}` : SIGN})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`CARD ${KEY} / live: ERROR ${e?.stack ?? e}`);
    process.exit(2);
  }
}
