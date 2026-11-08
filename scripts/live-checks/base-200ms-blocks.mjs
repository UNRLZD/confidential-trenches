#!/usr/bin/env node
// Live check of card base-200ms-blocks: Base's block time is the one the helper's clock says. Base went from 2 s to 200 ms
// blocks at block 53556127 (5 Nov 18:00:01Z) and nothing noticed for 1.5 h: the helper still timed Base blocks on a 2 s
// clock, so every Base head read off the clock and every chart read answered 503. The clock is BLOCK_CLOCK in
// apps/helper/src/data/evm/lists.ts; this check reads Base's real blocks and holds the clock to them, so the next change of
// Base's block time fails here, within one deploy or one scheduled run, and not at a user.
// It reads Base's newest block (eth_getBlockByNumber "latest") and the block BACK (10,000) below it on two providers,
// base-rpc.publicnode.com and base.gateway.tenderly.co, and passes only when, on BOTH:
//   - the head's block number is within DRIFT (10 blocks, 2 s) of what the newest clock era puts at the head's own time
//     (timestampMs when the header has it, else timestamp * 1000);
//   - the time the 10,000 blocks took, per block, is what the clock says for them (the newest era's blockMs when both are
//     in it) within 1%;
//   - the head's time is within 60 s of this check's own clock (a stale provider is no read).
// Every answer is hostile: the numbers must be canonical hex quantities and safe integers in bounds, the back block must be
// exactly BACK below the head, and a provider that errors, times out (10 s) or answers a JSON-RPC error is a BAD line naming it.
// After: helper
//   node scripts/live-checks/base-200ms-blocks.mjs [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BLOCK_CLOCK } from "../../apps/helper/src/data/evm/lists.ts";

const KEY = "base-200ms-blocks";
export const PROVIDERS = [
  { name: "base-rpc.publicnode.com", url: "https://base-rpc.publicnode.com" },
  { name: "base.gateway.tenderly.co", url: "https://base.gateway.tenderly.co" },
];
/** Blocks between the head and the block the block time is measured against. */
export const BACK = 10_000;
/** Blocks the head may be off the clock's prediction: 2 s of 200 ms blocks. */
export const DRIFT = 10;
/** How far the measured block time may be from the clock's, as a share. */
export const RATE_TOLERANCE = 0.01;
/** How old the head may be at the check's own clock. */
export const FRESH_MS = 60_000;
const TIMEOUT_MS = 10_000;
/** The most bytes of one answer the check keeps (a block header with hashes is some tens of kB). */
const MAX_BYTES = 1_000_000;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,12})$/i;

/** One JSON-RPC call: { status, text } or { error }, never a throw. */
async function rpc(url, params, fetchFn) {
  try {
    const r = await fetchFn(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (text.length > MAX_BYTES) return { error: `answer of ${text.length} bytes, over ${MAX_BYTES}` };
    return { status: r.status, text: r.status === 200 ? text : text.slice(0, 300) };
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}

const hex = (n) => `0x${n.toString(16)}`;

/** Base's newest block and the one BACK below it on each provider, as the providers answered. */
export async function read(fetchFn = fetch) {
  const providers = await Promise.all(
    PROVIDERS.map(async (p) => {
      const head = await rpc(p.url, ["latest", false], fetchFn);
      const n = parseBlock(head).number;
      const back = n === undefined || n < BACK ? { error: "no head number to step back from" } : await rpc(p.url, [hex(n - BACK), false], fetchFn);
      return { name: p.name, url: p.url, head, back };
    }),
  );
  return { providers };
}

/** { number, tMs, ms } of a recorded answer ({ status, text } or { error }), or { fault } saying what is wrong with it.
 *  tMs is the block's time in ms; ms says it came from timestampMs, not whole seconds. */
export function parseBlock(a) {
  if (typeof a !== "object" || a === null) return { fault: "no answer" };
  if (typeof a.error === "string") return { fault: a.error };
  if (a.status !== 200) return { fault: `HTTP ${a.status} ${typeof a.text === "string" ? JSON.stringify(a.text.slice(0, 80)) : ""}`.trim() };
  let j;
  try {
    j = JSON.parse(a.text);
  } catch {
    return { fault: `not JSON ${JSON.stringify(String(a.text).slice(0, 40))}` };
  }
  if (typeof j !== "object" || j === null) return { fault: "not a JSON-RPC answer" };
  if (j.error !== undefined) return { fault: `JSON-RPC error ${JSON.stringify(j.error?.code)} ${JSON.stringify(String(j.error?.message ?? "").slice(0, 80))}` };
  const b = j.result;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return { fault: `result is ${b === null ? "null" : typeof b}` };
  const q = (k, v) => (typeof v === "string" && QUANTITY.test(v) && Number.isSafeInteger(Number(BigInt(v))) ? Number(BigInt(v)) : { fault: `${k} ${JSON.stringify(typeof v === "string" ? v.slice(0, 24) : v)} is no hex quantity` });
  const number = q("number", b.number);
  if (typeof number === "object") return number;
  if (number < 1) return { fault: `number ${number} is no block` };
  const sec = q("timestamp", b.timestamp);
  if (typeof sec === "object") return sec;
  if (sec < 1_600_000_000 || sec > 10_000_000_000) return { fault: `timestamp ${sec} is out of bounds` };
  if (b.timestampMs === undefined) return { number, tMs: sec * 1000, ms: false };
  const ms = q("timestampMs", b.timestampMs);
  if (typeof ms === "object") return ms;
  if (Math.floor(ms / 1000) !== sec) return { fault: `timestampMs ${ms} is not in timestamp ${sec}` };
  return { number, tMs: ms, ms: true };
}

/** A block's time in ms by a clock table. */
const timeOf = (clock, n) => {
  const e = clock.findLast((x) => x.fromBlock <= n) ?? clock[0];
  return e.atMs + e.blockMs * (n - e.fromBlock);
};

/**
 * The check on one run: `reads` is what `read` took, `now` the check's clock in ms, `clock` the table to hold to Base's
 * blocks (the helper's own, BLOCK_CLOCK.base; a test passes another to replay a stale one).
 */
export function judge(reads, now, clock = BLOCK_CLOCK.base) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const providers = reads?.providers;
  if (!Array.isArray(providers) || providers.length === 0 || !Number.isSafeInteger(now) || !Array.isArray(clock) || clock.length === 0) {
    say(false, "no provider read, or no clock to read it against");
    return { ok: false, lines };
  }
  const era = clock.at(-1);
  for (const p of providers) {
    const name = typeof p?.name === "string" ? p.name : "unnamed provider";
    const head = parseBlock(p?.head);
    if (head.fault !== undefined) {
      say(false, `${name}: newest block unread: ${head.fault}`);
      continue;
    }
    const age = now - head.tMs;
    say(Math.abs(age) <= FRESH_MS, `${name}: head ${head.number} is ${age >= 0 ? `${Math.round(age / 1000)} s old` : `${Math.round(-age / 1000)} s ahead of the clock`}${age > FRESH_MS ? " (stale)" : ""}, within ${FRESH_MS / 1000} s`);
    const predicted = era.fromBlock + Math.floor((head.tMs - era.atMs) / era.blockMs);
    say(Math.abs(head.number - predicted) <= DRIFT, `${name}: head ${head.number} is ${head.number - predicted} blocks from ${predicted} that the clock (${era.blockMs} ms a block from block ${era.fromBlock}) puts at its time (block drift, at most ${DRIFT})`);
    const back = parseBlock(p?.back);
    if (back.fault !== undefined) {
      say(false, `${name}: block ${head.number - BACK} unread: ${back.fault}`);
      continue;
    }
    if (back.number !== head.number - BACK) {
      say(false, `${name}: asked block ${head.number - BACK}, answered block ${back.number}`);
      continue;
    }
    const unit = head.ms && back.ms ? "ms" : "s";
    const per = (head.ms && back.ms ? head.tMs - back.tMs : Math.floor(head.tMs / 1000) * 1000 - Math.floor(back.tMs / 1000) * 1000) / BACK;
    const want = (timeOf(clock, head.number) - timeOf(clock, back.number)) / BACK;
    say(per > 0 && Math.abs(per - want) <= want * RATE_TOLERANCE, `${name}: ${BACK} blocks took ${per.toFixed(1)} ms a block (from ${unit === "ms" ? "timestampMs" : "timestamp"}), the clock says ${want.toFixed(1)} ms (block time, within ${RATE_TOLERANCE * 100}%)`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const reads = await read(fetch);
    const now = Date.now();
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ now, reads }, null, 1)}\n`);
    const { ok, lines } = judge(reads, now);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${PROVIDERS.map((p) => p.name).join(" and ")}, at ${new Date(now).toISOString()})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
