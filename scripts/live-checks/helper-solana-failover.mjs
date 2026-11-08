#!/usr/bin/env node
// Live check of card helper-solana-failover: the deployed helper names each Solana provider slot in GET /v1/health
// (`solana`), so a slot whose key stopped serving shows as "fallback" while the public endpoint stands in. It passes
// only when:
//   - GET /v1/health answers 200 with a `solana` object;
//   - each slot the host sets (WANT: rpc, trades, holders and stream, the four the box sets) is named, and no other;
//   - each is "keyed", "fallback" or "public", and no value holds a URL or a key;
//   - a "fallback" slot is a note, not a failure: the pages keep answering from the public endpoint (the card's end
//     state), and the box log names the switch.
// After: helper
//   node scripts/live-checks/helper-solana-failover.mjs [--base <url>] [--want rpc,trades,holders,stream] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";

const KEY = "helper-solana-failover";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const SLOTS = ["rpc", "trades", "holders", "stream"];
export const STATES = ["keyed", "fallback", "public"];

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

export async function read(base = BASE, fetchFn = fetch) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  return { base, status: r.status, body: await r.text() };
}

/** The check on one recorded read; `want` the slots the host sets. */
export function judge({ status, body }, want = SLOTS) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(status === 200, `GET /v1/health answers ${status}`);
  let b;
  try {
    b = JSON.parse(body);
  } catch {
    b = undefined;
  }
  const s = b?.solana;
  const isObj = typeof s === "object" && s !== null && !Array.isArray(s);
  say(isObj, `solana ${isObj ? "is" : "is not"} an object (${show(s)})`);
  if (isObj) {
    const keys = Object.keys(s).sort();
    say(JSON.stringify(keys) === JSON.stringify([...want].sort()), `the slots named are ${keys.join(", ") || "none"}, want ${[...want].sort().join(", ")}`);
    for (const k of keys) say(STATES.includes(s[k]), `${k}: ${show(s[k])} is one of ${STATES.join(", ")}`);
    say(!/https?:|wss?:|api-key|\?/i.test(JSON.stringify(s)), "no URL and no key in solana");
    for (const k of keys) if (s[k] === "fallback") lines.push(`note ${k}: fallback, the public endpoint stands in for its key (the box log names why)`);
  }
  return { ok: lines.every((l) => !l.startsWith("BAD")), lines };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const { ok, lines } = judge(answer, opt("--want", SLOTS.join(",")).split(","));
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
