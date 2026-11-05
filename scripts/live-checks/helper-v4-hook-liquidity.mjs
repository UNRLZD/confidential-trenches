#!/usr/bin/env node
// Live check of card helper-v4-hook-liquidity: a v4 trade whose transaction also makes one of the pool's other
// PoolManager calls (a launch: Initialize, ModifyLiquidity, the hook paying the liquidity in, then the first buy) is on
// the deployed helper's tape for exactly what the trader got, never with the hook's settle of that call counted in
// (apps/helper/src/data/evm/swaps.ts hookTakes). Before the card the helper at c68e2b7 showed Base tx 0x02b8198c...a2e5's
// first buy of 0xc98d5da7... as 1,000,005,978.99 for the 5,978.99 its buyer got (live run 41960089054).
// It reads the Base Discover lists at HELPER_HOST with Origin APP_HOST, newest launches first (New, then the rest), and
// for up to TOKENS of them the tape (GET /v1/market/trades?chain=base&token=<t>&limit=50), whose oldest trades are the
// launches'. For each of a tape's OLDEST oldest trades it reads the receipt on two Base providers that agree
// (SWAP_RPCS.base) and the token's decimals. A launch trade is one whose receipt holds a PoolManager Swap of a pool and
// one of that pool's Initialize, ModifyLiquidity or Donate. It passes only when at least one launch trade is read and
// every one's amt is exactly a Transfer of the token in its receipt. With no launch trade on any tape read it FAILS with
// that reason, never passes on nothing.
//   node scripts/live-checks/helper-v4-hook-liquidity.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BASE_VENUES, SWAP_RPCS, TOPIC } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "helper-v4-hook-liquidity";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const TOKENS = 12;
export const OLDEST = 2;
const PM = BASE_VENUES.poolManager;
const CALLS = [TOPIC.initialize, TOPIC.modifyLiquidity, TOPIC.donate];
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A tape's decimal amt in the token's units, or null. */
export function units(amt, decimals) {
  const [w, f = ""] = String(amt).split(".");
  if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, "0"));
}

/** The pool ids a receipt both swaps in and makes another PoolManager call on. */
export function launchPools(receipt) {
  const pm = (receipt?.logs ?? []).filter((l) => l.address === PM && Array.isArray(l.topics));
  const swapped = new Set(pm.filter((l) => l.topics[0] === TOPIC.swap4).map((l) => l.topics[1]));
  return [...new Set(pm.filter((l) => CALLS.includes(l.topics[0]) && swapped.has(l.topics[1])).map((l) => l.topics[1]))];
}

/** The check on one run: { base, at, coins, tapes: { [coin]: { status, trades } }, decimals, receipts }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  if (!Array.isArray(run.coins) || run.coins.length === 0) bad(`no Base token read from the lists (${run.lists ?? "no answer"})`);
  let launches = 0;
  for (const coin of run.coins ?? []) {
    const tape = run.tapes?.[coin];
    if (tape?.status !== 200 || !Array.isArray(tape.trades)) {
      lines.push(`--  ${coin}: tape ${tape?.status ?? "not read"}`);
      continue;
    }
    for (const t of tape.trades.slice(-OLDEST)) {
      const r = run.receipts?.[t.tx];
      if (r === undefined) continue;
      if (r === null) {
        bad(`${coin} trade ${t.tx}: its receipt is not agreed by two providers`);
        continue;
      }
      if (launchPools(r).length === 0) continue;
      launches++;
      const d = run.decimals?.[coin];
      const want = Number.isInteger(d) ? units(t.amt, d) : null;
      const moved = r.logs.filter((l) => l.address === coin && l.topics?.[0] === TOPIC.transfer && /^0x[0-9a-f]{64}$/.test(l.data ?? "")).map((l) => BigInt(l.data));
      if (want === null) bad(`${coin} trade ${t.tx}: amt ${t.amt} is no amount of a token of ${d} decimals`);
      else if (!moved.includes(want)) bad(`${coin} launch trade ${t.tx}: amt ${t.amt} is no Transfer of the token in its receipt (they moved ${moved.map(String).join(", ") || "none"})`);
      else lines.push(`ok  ${coin} launch trade ${t.tx}: amt ${t.amt} is the Transfer the trader got`);
    }
  }
  if (launches === 0) bad(`no launch trade (a v4 swap with a pool call in its transaction) among the oldest ${OLDEST} trades of ${run.coins?.length ?? 0} Base tapes: nothing checked`);
  else lines.push(`ok  ${launches} launch trade${launches === 1 ? "" : "s"} read`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

async function getJson(base, path, fetchFn) {
  const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" } });
  let body = null;
  try {
    body = await r.json();
  } catch {
    // not JSON: judged by its status
  }
  return { status: r.status, body };
}

/** One JSON-RPC call on the first two providers that answer, which must agree on `pick` of the result: it, or null. */
async function agreed(method, params, fetchFn, pick = (x) => x, rpcs = SWAP_RPCS.base) {
  const got = [];
  for (const url of rpcs) {
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (r.status === 200 && isObj(j) && "result" in j && j.result !== null) got.push(JSON.stringify(pick(j.result)));
    } catch {
      // the next provider
    }
    if (got.length === 2) break;
  }
  return got.length === 2 && got[0] === got[1] ? JSON.parse(got[0]) : null;
}
const receiptOf = (r) => ({ status: r.status, logs: (r.logs ?? []).map((l) => ({ address: String(l.address).toLowerCase(), topics: (l.topics ?? []).map((t) => String(t).toLowerCase()), data: String(l.data).toLowerCase() })) });

export async function read(base = BASE, fetchFn = fetch, rpcs = SWAP_RPCS.base) {
  const run = { base, at: new Date().toISOString(), coins: [], tapes: {}, decimals: {}, receipts: {} };
  const l = await getJson(base, "/v1/market/lists?chain=base", fetchFn);
  if (l.status !== 200 || !isObj(l.body?.lists)) {
    run.lists = `lists ${l.status}`;
    return run;
  }
  const order = ["new", ...Object.keys(l.body.lists).filter((k) => k !== "new")];
  for (const k of order) for (const row of l.body.lists[k] ?? []) if (ADDR.test(row?.token ?? "") && !run.coins.includes(row.token) && run.coins.length < TOKENS) run.coins.push(row.token);
  for (const coin of run.coins) {
    const t = await getJson(base, `/v1/market/trades?chain=base&token=${coin}&limit=50`, fetchFn);
    const trades = Array.isArray(t.body?.trades) ? t.body.trades.filter((x) => TX.test(x?.tx ?? "")).map((x) => ({ tx: x.tx, side: x.side, amt: x.amt })) : null;
    run.tapes[coin] = { status: t.status, trades };
    if (t.status !== 200 || trades === null) continue;
    for (const x of trades.slice(-OLDEST)) {
      const r = await agreed("eth_getTransactionReceipt", [x.tx], fetchFn, receiptOf, rpcs);
      run.receipts[x.tx] = r;
      if (r !== null && launchPools(r).length > 0 && run.decimals[coin] === undefined) {
        const d = await agreed("eth_call", [{ to: coin, data: "0x313ce567" }, "latest"], fetchFn, (x) => x, rpcs);
        run.decimals[coin] = typeof d === "string" && /^0x[0-9a-f]{1,64}$/.test(d) ? Number(BigInt(d)) : null;
      }
    }
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const run = await read(base);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const line of lines) console.log(line);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
