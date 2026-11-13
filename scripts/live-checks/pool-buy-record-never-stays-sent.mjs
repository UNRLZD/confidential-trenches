#!/usr/bin/env node
// Live check of card pool-buy-record-never-stays-sent on SIGN_HOST (https://confidential.unrealized.trade). What it
// holds, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - store: the note store frees a RESERVED note on a finalized height past its last height, as well as past its
//     deadline (packages/wallet/src/notes/store.ts: the refusal names both), and writes that height with the move
//     HELD -> RESERVED only;
//   - take: the proof queue's take and the withdraw's take write the height with HELD -> RESERVED, and the Solana pool
//     send hands its signed transaction's last height to the take (src/pool-buy.ts sendAndSettle);
//   - pass: the settle pass over RESERVED notes reads each RPC's finalized height (getEpochInfo) and frees a note whose
//     last height both are past with no spent mark (packages/wallet/src/pool/solana-restore.ts solanaSettleReserved);
//   - balance: the pool balance counts a RESERVED note, as its change once its release is read landed
//     (packages/wallet/src/pool/balances.ts);
//   - none of the old shape: no refusal that frees a RESERVED note only past its deadline.
// What each does is held by the card's tests (packages/wallet/test/note-store.test.ts F1b, test/pool-solana.test.ts
// "a pass frees a RESERVED note whose signed transaction can no longer land", test/pool-balances.test.ts, and
// packages/signpage/test/pool-buy.test.ts, test/pools.test.ts). The recorded answers are facts() over a tree's
// packages/signpage/index.html and public/app.js (build-app.mjs), or SIGN_HOST's own page. This file reaches no package
// code (the import check holds it). The PR's own build runs it in scripts/ci/bundle-checks.mjs.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/pool-buy-record-never-stays-sent.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "pool-buy-record-never-stays-sent";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const I = "[\\w$]+"; // a minified name
const count = (js, re) => (js.match(new RegExp(re.source, "g")) ?? []).length;

// the store's refusal of RESERVED -> UNSPENT, naming both ways out, its rule for where a last height is written, and the
// key of the notes' marks (meta owed/reserved-notes), where the last height lives, out of the note record
const STORE_FREE = "is RESERVED until block time is past its deadline_ms, or the finalized height past its last height: its proof can still land";
const STORE_WRITE = "a last height or nullifier is written with the move HELD -> RESERVED only";
const MARKS_KEY = "`owed/reserved-notes`";
// the note record's keys, exactly release 116's (its reader refuses any other): no lastHeight among them
const RECORD_KEYS = "`deadlineMs`,`attempt`,`tab`,`calls`,`searchFrom`,`sends`,`evmSends`,`evmSpent`,`contexts`,`request`]";
// the old refusal: RESERVED until the deadline only
const OLD = "is RESERVED until block time is past its deadline_ms: its proof can still land";
// a take's move: `move(id, "HELD", "RESERVED", { attempt: ..., ...(h === undefined ? {} : { lastHeight: h }), ... })`,
// the queue's and the withdraw's (the store writes the height on the note's mark)
const TAKE_MOVE = new RegExp(String.raw`\`HELD\`,\`RESERVED\`,\{attempt:${I}(?:\.attempt)?,\.\.\.${I}===void 0\?\{\}:\{lastHeight:${I}\}`);
// the send's take: `take(r.noteId, r.attempt, fill?.early, BigInt(lastHeight))`
const TAKE_CALL = new RegExp(String.raw`\.take\(${I}\.noteId,${I}\.attempt,${I}\?\.early,BigInt\(${I}\)\)`);
// the pass: `height !== undefined && lastOf(n) !== undefined && height > lastOf(n)! ? (await a.notes.move(n.id,
// "RESERVED", "UNSPENT", { finalHeight: height }), freed) : held`, lastOf reading the note's mark of its own attempt
const PASS = new RegExp(String.raw`(?<h>${I})!==void 0&&(?<f>${I})\((?<n>${I})\)!==void 0&&\k<h>>\k<f>\(\k<n>\)\?\(await ${I}\.notes\.move\(\k<n>\.id,\`RESERVED\`,\`UNSPENT\`,\{finalHeight:\k<h>\}\)`);
const PASS_READ = "getEpochInfo: no finalized height";
// the balance: a RESERVED note counted, less its landed release's withdrawn value
const BALANCE = "its landed release withdrew more than it holds";
const BALANCE_STATES = /`UNSPENT`&&[\w$]+\.state!==`HELD`&&[\w$]+\.state!==`RESERVED`/;

/** What the check keeps of SIGN_HOST's page: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return {
    index,
    sha384: sha384(js),
    store: js.includes(STORE_FREE) && js.includes(STORE_WRITE) && js.includes(MARKS_KEY) && js.includes(RECORD_KEYS),
    take: count(js, TAKE_MOVE) >= 2 && TAKE_CALL.test(js),
    pass: PASS.test(js) && js.includes(PASS_READ),
    balance: js.includes(BALANCE) && BALANCE_STATES.test(js),
    old: js.includes(OLD),
  };
}

/** The verdict on an answer { index, sha384, store, take, pass, balance, old }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.store !== true) bad("the note store frees a RESERVED note only past its deadline, takes a last height on another move, or keeps it in the note record");
  if (a?.take !== true) bad("a take does not write the signed transaction's last height on the RESERVED note");
  if (a?.pass !== true) bad("the settle pass does not free a RESERVED note once both RPCs' finalized height is past its last height");
  if (a?.balance !== true) bad("the pool balance leaves out a RESERVED note: a buy in flight reads its money gone");
  if (a?.old !== false) bad("the bundle still holds a RESERVED note until its deadline only");
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
