#!/usr/bin/env node
// Live check of card helper-v4-hook-liquidity: every v4 trade on the deployed helper's tape is exactly the token its
// trader got or paid, whatever a hook cut from it or settled next to it (apps/helper/src/data/evm/swaps.ts hookTakes).
// Before the card the helper showed Base tx 0x02b8198c...a2e5's first buy as 1,000,005,978.99 for the 5,978.99 its buyer
// got (c68e2b7, live run 41960089054), tx 0xfaaa9cc9's buy as 0.000051015555490232 for the 0.000044726051716064 minted
// to its buyer as claims (04bb10f, live run 41990876403), and tx 0x72c376b7's buy as 11,785.03 for 11,661.28 (6e4c723,
// a hook whose cut another contract takes).
// It reads the chain's Discover lists at HELPER_HOST with Origin APP_HOST, newest launches first (New, then the rest),
// and for up to TOKENS of them the whole tape (GET /v1/market/trades?chain=<c>&token=<t>&limit=50), then every trade's
// receipt on two of the chain's providers that agree (SWAP_RPCS). In v4 the contract that calls swap() (the Swap log's
// sender) settles exactly its swap's delta, after any hook's: the token it moved with the PoolManager, as a Transfer or
// as ERC-6909 claims, is what the trader got or paid; when it sent the take straight to a recipient (take names no
// sender), the transaction's only swap's trader is the one address that moved the token and sent no swap or call. A
// trade is judged when its receipt names one such trader whose net move of the token has the trade's side, and no v2,
// v3 or curve swap moves the token in the same transaction. Each judged trade's amt must be exactly that move. It passes only when
// at least one trade is judged and none is wrong; with none judged it FAILS with that reason, never passes on nothing.
//   node scripts/live-checks/helper-v4-hook-liquidity.mjs [--base <url>] [--chain base|robinhood] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "helper-v4-hook-liquidity";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const TOKENS = 12;
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const OTHER_SWAPS = [TOPIC.swap3, TOPIC.swap2, TOPIC.curveBuy, TOPIC.curveSell];
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const word = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const addr = (w) => `0x${w.slice(26)}`;

/** A tape's decimal amt in the token's units, or null. */
export function units(amt, decimals) {
  const [w, f = ""] = String(amt).split(".");
  if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > decimals) return null;
  return BigInt(w + f.padEnd(decimals, "0"));
}

/** The traders' moves of `coin` with the PoolManager in a receipt (what each got, less what it paid in): each v4 swap
 *  sender's that settles one swap alone; with the transaction's only swap and no move of its sender, the one address
 *  that moved the coin and sent no swap or call (a take sent straight to its recipient: v4's take names no sender).
 *  Null when a v2, v3 or curve swap moves the coin in the same transaction. */
export function senderMoves(receipt, coin, pm) {
  const logs = receipt?.logs ?? [];
  const swaps = new Map();
  const callers = new Set(logs.filter((l) => l.address === pm && (l.topics?.[0] === TOPIC.modifyLiquidity || l.topics?.[0] === TOPIC.donate) && WORD.test(l.topics?.[2] ?? "")).map((l) => addr(l.topics[2])));
  const net = new Map();
  const add = (a, v) => net.set(a, (net.get(a) ?? 0n) + v);
  const others = new Set(logs.filter((l) => OTHER_SWAPS.includes(l.topics?.[0])).map((l) => l.address));
  for (const l of logs) {
    const t = l.topics ?? [];
    if (l.address === pm && t.length === 3 && t[0] === TOPIC.swap4 && WORD.test(t[2])) swaps.set(addr(t[2]), (swaps.get(addr(t[2])) ?? 0) + 1);
    else if (l.address === coin && t.length === 3 && t[0] === TOPIC.transfer && WORD.test(l.data ?? "")) {
      const [from, to, v] = [addr(t[1]), addr(t[2]), BigInt(l.data)];
      if (others.has(from) || others.has(to)) return null;
      if (from === pm && to !== pm) add(to, v);
      else if (to === pm && from !== pm) add(from, -v);
    } else if (l.address === pm && t.length === 4 && t[0] === TOPIC.claims && t[3] === word(coin) && /^0x[0-9a-f]{128}$/.test(l.data ?? "")) {
      const v = BigInt(`0x${l.data.slice(66)}`);
      if (t[1] === ZERO_WORD && t[2] !== ZERO_WORD) add(addr(t[2]), v);
      else if (t[2] === ZERO_WORD && t[1] !== ZERO_WORD) add(addr(t[1]), -v);
    }
  }
  const own = [...swaps].filter(([s, n]) => n === 1 && (net.get(s) ?? 0n) !== 0n).map(([sender]) => ({ sender, net: net.get(sender) }));
  if (own.length > 0 || swaps.size !== 1 || [...swaps.values()][0] !== 1) return own;
  const to = [...net].filter(([a, v]) => v !== 0n && !swaps.has(a) && !callers.has(a));
  return to.length === 1 ? [{ sender: to[0][0], net: to[0][1] }] : [];
}

/** The check on one run: { base, chain, at, coins, tapes: { [coin]: { status, trades } }, decimals, receipts }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  const chain = run.chain ?? "base";
  const pm = VENUES[chain].poolManager;
  if (!Array.isArray(run.coins) || run.coins.length === 0) bad(`no ${chain} token read from the lists (${run.lists ?? "no answer"})`);
  let judged = 0;
  let skipped = 0;
  for (const coin of run.coins ?? []) {
    const tape = run.tapes?.[coin];
    if (tape?.status !== 200 || !Array.isArray(tape.trades)) {
      lines.push(`--  ${coin}: tape ${tape?.status ?? "not read"}`);
      continue;
    }
    for (const t of tape.trades) {
      const r = run.receipts?.[t.tx];
      if (r === undefined) continue;
      if (r === null) {
        bad(`${coin} trade ${t.tx}: its receipt is not agreed by two providers`);
        continue;
      }
      const moves = senderMoves(r, coin, pm)?.filter((m) => (t.side === "b" ? m.net > 0n : m.net < 0n)) ?? [];
      if (moves.length !== 1) {
        skipped++;
        continue;
      }
      judged++;
      const d = run.decimals?.[coin];
      const want = Number.isInteger(d) ? units(t.amt, d) : null;
      const leg = moves[0].net < 0n ? -moves[0].net : moves[0].net;
      if (want === null) bad(`${coin} trade ${t.tx}: amt ${t.amt} is no amount of a token of ${d} decimals`);
      else if (want !== leg) bad(`${coin} trade ${t.tx}: amt ${t.amt} is not the ${leg} its trader ${moves[0].sender} ${t.side === "b" ? "got" : "paid"} (${want})`);
    }
  }
  if (judged === 0) bad(`no v4 trade judged on ${run.coins?.length ?? 0} ${chain} tapes (${skipped} trades with no single sender's move of the token): nothing checked`);
  else lines.push(`ok  ${judged} v4 trade${judged === 1 ? "" : "s"} judged, each the token its trader moved (${skipped} not judged)`);
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

/** JSON-RPC calls batched on the providers in turn until each has two answers, which must agree on `pick` of the
 *  result: each call's agreed answer, or null. A batch is 10 calls (base-pokt.nodies.app's most, 2026-11-05), and a
 *  refused one is sent again as batches of 3 (base.drpc.org's free most). */
async function agreedMany(calls, fetchFn, rpcs, pick = (x) => x) {
  const got = calls.map(() => []);
  const send = async (url, part) => {
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part.map((i) => ({ jsonrpc: "2.0", id: i, method: calls[i].method, params: calls[i].params }))), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (r.status !== 200 || !Array.isArray(j)) return false;
      for (const o of j) if (isObj(o) && part.includes(o.id) && "result" in o && o.result !== null) got[o.id].push(JSON.stringify(pick(o.result)));
      return true;
    } catch {
      return false;
    }
  };
  for (const url of rpcs) {
    const want = calls.map((_, i) => i).filter((i) => got[i].length < 2);
    if (want.length === 0) break;
    for (let k = 0; k < want.length; k += 10) {
      const part = want.slice(k, k + 10);
      if (!(await send(url, part))) for (let m = 0; m < part.length; m += 3) await send(url, part.slice(m, m + 3));
    }
  }
  return got.map((g) => (g.length >= 2 && g[0] === g[1] ? JSON.parse(g[0]) : null));
}
const receiptOf = (r) => ({ status: r.status, logs: (r.logs ?? []).map((l) => ({ address: String(l.address).toLowerCase(), topics: (l.topics ?? []).map((t) => String(t).toLowerCase()), data: String(l.data).toLowerCase() })) });

export async function read(base = BASE, fetchFn = fetch, chain = "base", rpcs = SWAP_RPCS[chain]) {
  const run = { base, chain, at: new Date().toISOString(), coins: [], tapes: {}, decimals: {}, receipts: {} };
  const l = await getJson(base, `/v1/market/lists?chain=${chain}`, fetchFn);
  if (l.status !== 200 || !isObj(l.body?.lists)) {
    run.lists = `lists ${l.status}`;
    return run;
  }
  const order = ["new", ...Object.keys(l.body.lists).filter((k) => k !== "new")];
  for (const k of order) for (const row of l.body.lists[k] ?? []) if (ADDR.test(row?.token ?? "") && !run.coins.includes(row.token) && run.coins.length < TOKENS) run.coins.push(row.token);
  for (const coin of run.coins) {
    const t = await getJson(base, `/v1/market/trades?chain=${chain}&token=${coin}&limit=50`, fetchFn);
    const trades = Array.isArray(t.body?.trades) ? t.body.trades.filter((x) => TX.test(x?.tx ?? "")).map((x) => ({ tx: x.tx, side: x.side, amt: x.amt })) : null;
    run.tapes[coin] = { status: t.status, trades };
    if (t.status !== 200 || trades === null) continue;
    const txs = [...new Set(trades.map((x) => x.tx))].filter((tx) => !(tx in run.receipts));
    const rs = await agreedMany(txs.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] })), fetchFn, rpcs, receiptOf);
    txs.forEach((tx, i) => (run.receipts[tx] = rs[i]));
    if (trades.some((x) => senderMoves(run.receipts[x.tx], coin, VENUES[chain].poolManager)?.length)) {
      const [d] = await agreedMany([{ method: "eth_call", params: [{ to: coin, data: "0x313ce567" }, "latest"] }], fetchFn, rpcs);
      run.decimals[coin] = typeof d === "string" && /^0x[0-9a-f]{1,64}$/.test(d) ? Number(BigInt(d)) : null;
    }
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const chain = opt("--chain", "base");
    if (!(chain in SWAP_RPCS)) throw new Error(`no chain ${chain}`);
    const run = await read(base, fetch, chain);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { ok, lines } = judge(run);
    for (const line of lines) console.log(line);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${base}, ${chain})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
