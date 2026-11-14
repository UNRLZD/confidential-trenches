#!/usr/bin/env node
// Live check of card balance-shows-fast on SIGN_HOST (https://confidential.unrealized.trade). Before the card a pool's
// ready proofs lived only in the proving tab's memory: a reload or a hand-over to another tab freed their notes and
// proved each one again (a phone about 8.4 s a proof, a desktop about 2 s), so Max waited on the prover at every open.
// With the card the proof queue keeps its ready list in the wallet store and a new queue adopts each kept proof it would
// make itself (packages/wallet/src/pool/queue.ts "Kept on the device", src/pool/kept-proofs.ts). What it holds, signed
// out, and only that: the served /app.js is the one index.html pins (its sha384), and in it, as minified:
//   - store: the wallet store takes meta proofs/<pool id> as a caller's key (src/store/index.ts PROOFS_KEY);
//   - adopt: a kept proof is adopted only when its signals are this note's nullifier hash, its chunk and its epoch's
//     state root (queue.ts adopt), so it spends only that note on a root the pool holds;
//   - wired: both of the signing page's queues (Solana and EVM, src/pool-testnet.ts) open with their kept proofs in the
//     wallet store.
// That a kept proof saves the prover's run is packages/wallet/test/pool-queue-kept.test.ts's (counted prover runs).
// After: sign
// Bundle: read sign
//   node scripts/live-checks/balance-shows-fast.mjs [--record <file>] [--answer <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "balance-shows-fast";
export const SIGN = "https://confidential.unrealized.trade";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

const V = "[\\w$]+";
// the store's key for a pool's kept proofs, a regex literal the minifier keeps as written
const STORE = /\/\^proofs\\\/\[\^\/\]\{1,200\}\$\//;
// adopt's signal checks: [1] the note's nullifier hash, [2] the chunk, [3] the epoch's state root
const ADOPT = new RegExp(`${V}\\[1\\]!==${V}\\(${V},${V}\\.ref\\)\\.nullifierHash\\.toString\\(\\)\\|\\|${V}\\[2\\]!==${V}\\.toString\\(\\)\\|\\|${V}\\[3\\]!==${V}\\.stateRoot\\.toString\\(\\)`);
// a queue opened with its kept proofs in the wallet store: skip: the owed notes, kept: keptProofs(await store(), pool.id)
const WIRED = new RegExp(`skip:${V},kept:${V}\\(await ${V}\\.store\\(\\),${V}\\.id\\)`, "g");

/** What the check keeps of the reads: the index, the served bundle's sha384, and which marks the bundle holds. */
export function facts(index, js) {
  return { index, sha384: sha384(js), store: STORE.test(js), adopt: ADOPT.test(js), wired: (js.match(WIRED) ?? []).length };
}

export const NO_STORE = "BAD the wallet store does not keep a pool's ready proofs (meta proofs/<pool id>)";
export const NO_ADOPT = "BAD the proof queue does not adopt a kept proof only on its note's nullifier hash, its chunk and its epoch's root";
export const NO_WIRED = "BAD the signing page's Solana and EVM queues do not both open with their kept proofs";

/** The verdict on an answer { index, sha384, store, adopt, wired }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(m.startsWith("BAD ") ? m : `BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (a?.store !== true) bad(NO_STORE);
  if (a?.adopt !== true) bad(NO_ADOPT);
  if (a?.wired !== 2) bad(NO_WIRED);
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
