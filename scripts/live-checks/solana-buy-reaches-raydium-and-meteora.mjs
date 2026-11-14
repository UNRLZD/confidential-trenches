#!/usr/bin/env node
// Live check of card solana-buy-reaches-raydium-and-meteora: the deployed helper carries the signing page's DLMM pair
// scan, so a coin whose SOL pools are Meteora DLMM pairs has its pairs found. POST /v1/rpc/solana with the kit's
// solanaDlmmPairScan for NEARKAT (6UtY9iTZ…) and wSOL, the coin as X, must answer 200 with a list of addresses that
// holds NEARKAT's two pairs with SOL in them (B8BH6ZKr… and J3wZVx37…, read on two mainnet RPCs 14 Nov); the same scan
// with one mint alone (a sweep of every pair of the coin) must be refused 400, before any call. A helper that refuses the
// scan, or whose upstream cannot answer it (the page then finds no pair and the coin stays unbought), fails.
// Its recorded runs are solana-buy-reaches-raydium-and-meteora.answers.json, replayed by its .test.mjs.
// After: helper
//   node scripts/live-checks/solana-buy-reaches-raydium-and-meteora.mjs [--base <helper url>] [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2 (no answer). Reads only: no key, no transaction.
import { writeFileSync } from "node:fs";
import { SOLANA_SOL_MINT, solanaDlmmPairScan } from "../../packages/kit/src/index.ts";

const KEY = "solana-buy-reaches-raydium-and-meteora";
export const NEARKAT = "6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr";
export const NEARKAT_PAIRS = ["B8BH6ZKr64agqNWG51CQWUKrLZZw5L31u2K6hubsZfyf", "J3wZVx37wfEpGNjBHiJyuGZf948jsFe3toCiMkD4D1oz"];
const BASE = "https://ct-api.unrealized.trade";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The two requests: the kit's scan, and the same with the wSOL filter dropped (one mint alone). */
export function requests() {
  const scan = solanaDlmmPairScan(NEARKAT, SOLANA_SOL_MINT);
  const [program, cfg] = scan;
  const wide = [program, { ...cfg, filters: cfg.filters.slice(0, 2) }];
  return { scan: { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: scan }, wide: { jsonrpc: "2.0", id: 2, method: "getProgramAccounts", params: wide } };
}

/** The verdict on one run's two answers ({ status, json } each): { verdict: PASS | FAIL | ERROR, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, s) => lines.push(`${ok ? "ok  " : "FAIL"} ${s}`);
  const s = run?.scan;
  const w = run?.wide;
  if (!s || !w || typeof s.status !== "number" || typeof w.status !== "number") return { verdict: "ERROR", lines: ["no answer to one of the two requests"] };
  const value = s.json?.result?.value;
  const keys = Array.isArray(value) ? value.map((e) => e?.pubkey) : null;
  say(s.status === 200 && keys !== null, `the kit's DLMM pair scan for NEARKAT answers 200 with a list (status ${s.status}${s.json?.error ? `, error ${JSON.stringify(s.json.error).slice(0, 120)}` : ""})`);
  if (keys !== null) {
    say(keys.every((k) => typeof k === "string" && B58.test(k)), `every entry is an address (${keys.length} entries)`);
    for (const p of NEARKAT_PAIRS) say(keys.includes(p), `it names NEARKAT's SOL pair ${p}`);
  }
  say(w.status === 400, `the scan with one mint alone is refused 400 (status ${w.status})`);
  return { verdict: lines.every((l) => l.startsWith("ok")) ? "PASS" : "FAIL", lines };
}

async function post(base, body) {
  const r = await fetch(`${base}/v1/rpc/solana`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const base = (opt("--base") ?? BASE).replace(/\/$/, "");
  const q = requests();
  let run;
  try {
    run = { base, at: new Date().toISOString(), scan: await post(base, q.scan), wide: await post(base, q.wide) };
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(2);
  }
  if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(run, null, 2) + "\n");
  const r = judge(run);
  for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
  console.log(`live-check ${KEY}: ${r.verdict}`);
  process.exit(r.verdict === "PASS" ? 0 : r.verdict === "FAIL" ? 1 : 2);
}
