#!/usr/bin/env node
// Live check of card pool-amounts-are-standard-sizes: every amount that enters or leaves the mainnet Solana pool after
// the fix's first transaction is a standard size, a rung of the 1-2-5 ladder from 0.005 SOL (the wallet's
// SOL_PIECE_LADDER: one = 1,000,000 lamports, min = 5,000,000; packages/wallet/test/pool-standard-sizes.test.ts holds the
// rule on the device). Read 13 Nov 20:27Z: a sale's W deposited 12,000,000 back and a buy released 6,661,767.
//   1. every finalized signature of the pool account, on two public RPCs (CHAIN_PAIR), paged to the first;
//   2. each successful transaction on both, and the pool account's lamport change in it: above 0 a deposit, under 0 a
//      release (the pool pays every release out of its own account, and takes every deposit into it);
// and passes when both RPCs read the same transactions with the same changes from --from on (before it, a public RPC
// may keep less history: a transaction read on one only counts there, one read differently on the two fails), every
// deposit at or after --from is a rung, and every release at or after --from is a rung but the last remainders of notes made before the fix: at most
// one per deposit before --from (each note's line starts at one deposit and ends in at most one remainder off the
// ladder, released whole once: the circuit has one input and withdrawnValue is public).
// Runs: pending pool-amounts-are-standard-sizes, it needs --from, the time this card's build went live on SIGN_HOST: the
// release that ships it adds `// After: sign --from <that time>` here, so no run before it reads the old build's sizes
//   node scripts/live-checks/pool-amounts-are-standard-sizes.mjs --from <ISO time of the fix's first transaction> [--record <file>] [--answer <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHAIN_PAIR } from "./signpage-pool-pins.mjs";

const KEY = "pool-amounts-are-standard-sizes";
/** The mainnet Solana pool (packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet's pool account). */
export const POOL = "7ijWvp3xEk5yUfGYQJfgoabReCTpSyZhiWjmCt3TQDz8";
/** The ladder, lamports: one and the least rung (the wallet's SOL_PIECE_LADDER; the test holds them equal). */
export const ONE = 1_000_000n;
export const MIN = 5_000_000n;

/** Whether `x` lamports is a rung: d x 10^k x ONE, d in {1, 2, 5}, at least MIN. */
export function isRung(x) {
  if (typeof x !== "bigint" || x < MIN || x % ONE !== 0n) return false;
  let q = x / ONE;
  while (q % 10n === 0n) q /= 10n;
  return q === 1n || q === 2n || q === 5n;
}

// ------------------------------------------------------------------------------------------------ the verdict
/** The verdict on a record { rpcs, pool, from, rows: [rows on RPC 0, rows on RPC 1] }, each row { sig, time (unix s),
 *  delta (lamports, a decimal string) }. */
export function judge(rec) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pair = Array.isArray(rec?.rpcs) && rec.rpcs.length === 2 && rec.rpcs.every((u, i) => u === CHAIN_PAIR[i]);
  if (!pair) bad(`the reads are not on the two public RPCs ${CHAIN_PAIR.join(" and ")}`);
  if (rec?.pool !== POOL) bad(`the pool read is not ${POOL}`);
  const from = typeof rec?.from === "string" ? Date.parse(rec.from) / 1000 : NaN;
  if (!Number.isFinite(from)) bad("no --from: the time of the fix's first transaction is not named");
  const rows = Array.isArray(rec?.rows) && rec.rows.length === 2 && rec.rows.every(Array.isArray) ? rec.rows : null;
  if (!rows) bad("the pool's transactions are not read on both RPCs");
  if (lines.length > 0) return { ok: false, lines };
  const key = (r) => `${r.sig} ${r.time} ${r.delta}`;
  const [a, b] = rows.map((list) => list.filter((r) => !(r.time < from)).map(key).sort());
  if (rows[0].length === 0) bad("no transaction of the pool read");
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) bad(`the two RPCs read the pool's transactions from ${rec.from} on differently`);
  // before --from: the union of both reads, a signature both read the same on both
  const seen = new Map();
  for (const r of [...rows[0], ...rows[1]].filter((r) => r.time < from)) {
    const was = seen.get(r.sig);
    if (was !== undefined && key(was) !== key(r)) bad(`${r.sig}: the two RPCs read it differently`);
    seen.set(r.sig, r);
  }
  const all = [...seen.values(), ...rows[0].filter((r) => !(r.time < from))].sort((x, y) => x.time - y.time);
  let allowed = 0;
  let off = 0;
  for (const r of all) {
    let d;
    try {
      d = BigInt(r.delta);
    } catch {
      bad(`${r.sig}: a change that is not a whole number`);
      continue;
    }
    if (!Number.isSafeInteger(r.time)) bad(`${r.sig}: no block time`);
    if (r.time < from) {
      if (d > 0n) allowed += 1;
      continue;
    }
    if (d > 0n && !isRung(d)) bad(`${r.sig}: a deposit of ${d} lamports, off the ladder`);
    if (d < 0n && !isRung(-d)) off += 1;
    if (d < 0n && !isRung(-d) && off > allowed) bad(`${r.sig}: a release of ${-d} lamports, off the ladder, past the ${allowed} remainders of notes made before the fix`);
  }
  if (lines.length === 0) lines.push(`ok ${all.length} transactions, ${allowed} deposits before ${rec.from}, ${off} remainder release${off === 1 ? "" : "s"} off the ladder after it`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

// ------------------------------------------------------------------------------------------------ the reads
const callOn = (url) => async (method, params) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((s) => setTimeout(s, 1_000 * 2 ** Math.min(i, 4)));
      continue;
    }
    if (r.status !== 200) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${new URL(url).host}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  }
  throw new Error(`${new URL(url).host}: throttled`);
};

/** The pool's successful finalized transactions on one RPC, oldest first: signature, block time, the pool's change. */
async function rowsOn(url) {
  const call = callOn(url);
  const sigs = [];
  for (let before; ; ) {
    const page = await call("getSignaturesForAddress", [POOL, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1).signature;
  }
  const rows = [];
  for (const s of sigs.reverse()) {
    if (s.err !== null) continue;
    const tx = await call("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]);
    if (!tx?.meta) throw new Error(`${s.signature}: no transaction`);
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const i = keys.indexOf(POOL);
    const delta = i < 0 ? 0n : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    rows.push({ sig: s.signature, time: tx.blockTime, delta: delta.toString() });
  }
  return rows;
}

export async function read(from) {
  return { rpcs: CHAIN_PAIR, pool: POOL, from, rows: await Promise.all(CHAIN_PAIR.map(rowsOn)) };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(arg("--from"));
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
