#!/usr/bin/env node
// Live check of card helper-tape-4337-trader: a trade sent through an ERC-4337 smart account shows that account as its
// trader on the deployed helper's tape, never the bundler that sent the transaction (apps/helper/src/data/evm/index.ts
// txTraders). Before the card the helper named each bundle's sender: Robinhood tx 0x85c994df...4bfd's sell on token
// 0x7c612597...'s tape showed bundler 0x4337316b..., where the account was 0x4a6dca90... (deployed d496961, read
// 2026-11-05 10:5xZ).
// It reads the chain's Discover lists at HELPER_HOST with Origin APP_HOST and, token by token, the tape
// (GET /v1/market/trades?chain=<c>&token=<t>&limit=50) until it has judged JUDGE_ENOUGH bundles or read TOKENS tapes.
// Each trade's transaction is looked up on one of the chain's providers (SWAP_RPCS); one sent to an EntryPoint (v0.6,
// v0.7, v0.8, v0.9) has its receipt read on two providers that must agree, and the receipt names who sent it (from, to)
// and its user operations: each operation's run is the logs after the EntryPoint's BeforeExecution,
// SignatureAggregatorChanged or previous UserOperationEvent and before its own UserOperationEvent, whose second indexed
// topic is its account. A trade is judged when its bundle's receipt holds a swap log in some operation's run; its trader
// must then be the account of one such operation, never the bundler, never none. It passes only when at least one trade
// is judged and none is wrong; with none judged it FAILS with that reason, never passes on nothing.
// After: helper
//   node scripts/live-checks/helper-tape-4337-trader.mjs [--base <url>] [--chain robinhood|base] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { SWAP_RPCS, TOPIC } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "helper-tape-4337-trader";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = 30;
export const JUDGE_ENOUGH = 5;
// the EntryPoints and their events, as the eth-infinitism/account-abstraction releases name them (read on chain in
// index.ts's note); written out here, not imported, so the check does not take the rule it checks from the helper
export const ENTRY_POINTS = ["0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032", "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", "0x433709009b8330fda32311df1c2afa402ed8d009"];
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE_EXECUTION = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const AGGREGATOR_CHANGED = "0x575ff3acadd5ab348fe1855e217e0f3678f8d767d7494c9f9fefbee2e17cca4d";
const SWAPS = [TOPIC.swap4, TOPIC.swap3, TOPIC.swap2, TOPIC.curveBuy, TOPIC.curveSell];
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The accounts of a bundle's user operations whose run holds a swap log, from its receipt; empty when none does. */
export function swapAccounts(receipt) {
  const ep = receipt.to;
  const logs = [...receipt.logs].sort((a, b) => a.index - b.index);
  const out = new Set();
  let start = null;
  let swapped = false;
  for (const l of logs) {
    const t0 = l.topics[0];
    if (l.address === ep && t0 === BEFORE_EXECUTION) [start, swapped] = [l.index, false];
    else if (l.address === ep && t0 === AGGREGATOR_CHANGED && start !== null) [start, swapped] = [l.index, false];
    else if (l.address === ep && t0 === USER_OP_EVENT && start !== null) {
      if (swapped && /^0x0{24}[0-9a-f]{40}$/.test(l.topics[2] ?? "")) out.add(`0x${l.topics[2].slice(26)}`);
      [start, swapped] = [l.index, false];
    } else if (start !== null && SWAPS.includes(t0)) swapped = true;
  }
  return out;
}

/** The check on one run: { base, chain, at, coins, tapes: { [coin]: { status, trades } }, receipts }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  const chain = run.chain ?? "robinhood";
  if (!Array.isArray(run.coins) || run.coins.length === 0) bad(`no ${chain} token read from the lists (${run.lists ?? "no answer"})`);
  let judged = 0;
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
        bad(`${coin} trade ${t.tx}: its bundle's receipt is not agreed by two providers`);
        continue;
      }
      const accounts = swapAccounts(r);
      if (accounts.size === 0) continue;
      judged++;
      if (t.trader === r.from) bad(`${coin} trade ${t.tx}: trader ${t.trader} is the bundler that sent it, not the account (${[...accounts].join(", ")})`);
      else if (t.trader === null || !accounts.has(t.trader)) bad(`${coin} trade ${t.tx}: trader ${t.trader} is no account whose user operation swapped (${[...accounts].join(", ")})`);
      else lines.push(`ok  ${coin} trade ${t.tx}: trader ${t.trader}, the account (bundler ${r.from}, EntryPoint ${r.to})`);
    }
  }
  if (judged === 0) bad(`no trade sent through a smart account judged on ${run.coins?.length ?? 0} ${chain} tapes: nothing checked`);
  else lines.push(`ok  ${judged} smart-account trade${judged === 1 ? "" : "s"} judged`);
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

/** One batch of JSON-RPC calls to `url` (batches of 3, the smallest a provider of ours takes): each call's result, or
 *  undefined where it gave none. */
async function batch(url, calls, fetchFn) {
  const out = calls.map(() => undefined);
  for (let k = 0; k < calls.length; k += 3) {
    const part = calls.slice(k, k + 3);
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part.map((c, i) => ({ jsonrpc: "2.0", id: k + i, method: c.method, params: c.params }))), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (Array.isArray(j)) for (const o of j) if (isObj(o) && Number.isInteger(o.id) && o.id >= k && o.id < k + part.length && o.result != null) out[o.id] = o.result;
    } catch {
      // that part unanswered: asked of the next provider
    }
  }
  return out;
}
const receiptOf = (r) => ({ from: String(r.from).toLowerCase(), to: String(r.to).toLowerCase(), status: r.status, logs: (r.logs ?? []).map((l) => ({ address: String(l.address).toLowerCase(), index: parseInt(l.logIndex, 16), topics: (l.topics ?? []).map((t) => String(t).toLowerCase()) })) });

/** Each call's result two providers gave alike (by `pick`), or null. */
async function agreed(calls, fetchFn, rpcs, pick) {
  const got = calls.map(() => []);
  for (const url of rpcs) {
    const want = calls.map((_, i) => i).filter((i) => got[i].length < 2);
    if (want.length === 0) break;
    const r = await batch(url, want.map((i) => calls[i]), fetchFn);
    want.forEach((i, k) => r[k] !== undefined && got[i].push(JSON.stringify(pick(r[k]))));
  }
  return got.map((g) => (g.length >= 2 && g[0] === g[1] ? JSON.parse(g[0]) : null));
}

export async function read(base = BASE, fetchFn = fetch, chain = "robinhood", rpcs = SWAP_RPCS[chain]) {
  const run = { base, chain, at: new Date().toISOString(), coins: [], tapes: {}, receipts: {} };
  const l = await getJson(base, `/v1/market/lists?chain=${chain}`, fetchFn);
  if (l.status !== 200 || !isObj(l.body?.lists)) {
    run.lists = `lists ${l.status}`;
    return run;
  }
  const order = ["new", ...Object.keys(l.body.lists).filter((k) => k !== "new")];
  const all = [];
  for (const k of order) for (const row of l.body.lists[k] ?? []) if (ADDR.test(row?.token ?? "") && !all.includes(row.token)) all.push(row.token);
  let bundles = 0;
  for (const coin of all.slice(0, TOKENS)) {
    if (bundles >= JUDGE_ENOUGH) break;
    run.coins.push(coin);
    const t = await getJson(base, `/v1/market/trades?chain=${chain}&token=${coin}&limit=50`, fetchFn);
    const trades = Array.isArray(t.body?.trades) ? t.body.trades.filter((x) => TX.test(x?.tx ?? "")).map((x) => ({ tx: x.tx, side: x.side, trader: typeof x.trader === "string" ? x.trader.toLowerCase() : null })) : null;
    run.tapes[coin] = { status: t.status, trades };
    if (t.status !== 200 || trades === null) continue;
    // which transactions went to an EntryPoint: one provider's word, enough to choose what to read (each one chosen is
    // then judged by its receipt, which two providers must give alike and which names its own `to`)
    const txs = [...new Set(trades.map((x) => x.tx))].filter((tx) => !(tx in run.receipts));
    let left = txs;
    const to = new Map();
    for (const url of rpcs) {
      if (left.length === 0) break;
      const r = await batch(url, left.map((tx) => ({ method: "eth_getTransactionByHash", params: [tx] })), fetchFn);
      left.forEach((tx, i) => isObj(r[i]) && to.set(tx, String(r[i].to).toLowerCase()));
      left = left.filter((tx) => !to.has(tx));
    }
    const eps = txs.filter((tx) => ENTRY_POINTS.includes(to.get(tx)));
    if (eps.length === 0) continue;
    const rs = await agreed(eps.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] })), fetchFn, rpcs, receiptOf);
    eps.forEach((tx, i) => {
      // a receipt that is not the bundle's own (another `to`) is none
      run.receipts[tx] = rs[i] !== null && ENTRY_POINTS.includes(rs[i].to) ? rs[i] : null;
      if (run.receipts[tx] !== null && swapAccounts(run.receipts[tx]).size > 0) bundles++;
    });
  }
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const chain = opt("--chain", "robinhood");
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
