// A timing record, not a gate (card wallet-restore-notes): the deposit index walk at RESTORE_GAP on this thread, and how
// long it holds the thread in one piece. The proof pool's workers take the walk off the page's thread through
// restoreNotes `walk` (card wallet-restore-wallets builds them and times the phone).
//   node test/restore-timing.ts      (from packages/wallet; about a minute)
// Test secrets: the all-zero BIP-39 entropy, as test/note-restore.test.ts.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { vaultScopeOf } from "@blindfill/kit";
import * as d from "../src/derive/index.ts";
import { RESTORE_GAP, RESTORE_LANES, restorePages } from "../src/notes/restore.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const SCOPE = vaultScopeOf(keccak_256, "vault.bf-restore.testnet", "usdc.fakes.testnet");

let last = performance.now();
let worst = 0;
const tick = setInterval(() => {
  const now = performance.now();
  worst = Math.max(worst, now - last);
  last = now;
}, 20);
await new Promise((r) => setTimeout(r, 50));
const t0 = performance.now();
last = t0;
restorePages(SEED, SCOPE, { deposits: [], spends: [], leaves: [] });
const ms = performance.now() - t0;
await new Promise((r) => setTimeout(r, 50));
clearInterval(tick);
console.log(
  JSON.stringify({
    walk: `${RESTORE_LANES} lanes x ${RESTORE_GAP} on an empty vault, one thread`,
    walkMs: Math.round(ms),
    perIndexMs: +(ms / (RESTORE_LANES * RESTORE_GAP)).toFixed(4),
    longestStallOf20msTimerMs: Math.round(worst),
    node: process.version,
    at: new Date().toISOString(),
  }),
);
