#!/usr/bin/env node
// Live check of card evm-tape-rows-exact: every Base and Robinhood trade row the deployed helper serves shows the exact
// amount the chain moved and the real trader, whichever source the tape came from. Before the card a listed token our
// reads price from no pool of ours was served CoinGecko's rows as they came: amounts through a float (Base 0x69643d21's
// tx 0xfa31c53f as 4029.69636401198 for the 4029696364011983028639 its buyer got) and the transaction's sender as the
// trader, a bundle's bundler (Robinhood 0x944307de's tx 0xd2f5c29d named bundler 0xfb32a11a for account 0xd22e3afc;
// helper 0d308d3bc, live runs 43689567273 and 43689580591).
// For each chain it reads the Discover lists at HELPER_HOST with Origin APP_HOST and, token by token (New first), the
// tape (GET /v1/market/trades?chain=<c>&token=<t>&limit=50), tapes not from our own reads first, up to TOKENS tapes and
// ROWS rows of each, until JUDGE_ENOUGH rows are judged. Each row's receipt and its token's decimals() are read on two of
// the chain's providers (SWAP_RPCS) that must give them alike. A row is judged when both are: its amt, in the token's
// units, must be exactly the value of a move of the token in the receipt (a Transfer of it, a leg of the v4
// PoolManager's Swap, or an ERC-6909 claim of it), and its trader, when named, must be the receipt's sender, or for a
// bundle sent to an ERC-4337 EntryPoint the account of a user operation whose run holds such a move (never the
// bundler). It passes only when every chain has a judged row and no judged row is wrong; a chain with none judged
// because the providers gave no two alike is INCONCLUSIVE (exit 3), and one with no tape to read is a FAIL.
// After: helper
// Serial: evm-keyed 155 after helper-tape-4337-trader, the other check of its rows
//   node scripts/live-checks/evm-tape-rows-exact.mjs [--base <url>] [--chain base|robinhood] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read, so the check's
//   test can replay it.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { SWAP_RPCS, TOPIC, VENUES } from "../../apps/helper/src/data/evm/swaps.ts";

const KEY = "evm-tape-rows-exact";
export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = 12;
export const ROWS = 4;
export const JUDGE_ENOUGH = 8;
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, ERROR: 2, INCONCLUSIVE: 3 });
// the EntryPoints (v0.6 to v0.9) and their events, as the eth-infinitism/account-abstraction releases name them; written
// out here, as helper-tape-4337-trader.mjs does, so the check does not take the rule it checks from the helper
export const ENTRY_POINTS = ["0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789", "0x0000000071727de22e5e9d8baf0edac6f37da032", "0x4337084d9e255ff0702461cf8895ce9e3b5ff108", "0x433709009b8330fda32311df1c2afa402ed8d009"];
const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE_EXECUTION = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const AGGREGATOR_CHANGED = "0x575ff3acadd5ab348fe1855e217e0f3678f8d767d7494c9f9fefbee2e17cca4d";
const ADDR = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A tape's decimal amt in the token's units, or null. */
export function units(amt, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(amt));
  if (m === null || (m[2] ?? "").length > decimals) return null;
  return BigInt(m[1] + (m[2] ?? "").padEnd(decimals, "0"));
}

/** Each move of `coin` in a receipt: { index, value } for a Transfer of it, each leg of a v4 Swap, an ERC-6909 claim of it. */
export function moves(receipt, coin, pm) {
  const out = [];
  const coinWord = `0x${coin.slice(2).padStart(64, "0")}`;
  for (const l of receipt.logs) {
    const t = l.topics;
    const words = (l.data.length - 2) / 64;
    const w = (i) => BigInt(`0x${l.data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
    if (l.address === coin && t[0] === TOPIC.transfer && t.length === 3 && words === 1) out.push({ index: l.index, value: w(0) });
    else if (l.address === pm && t[0] === TOPIC.swap4 && t.length === 3 && words === 6)
      for (const v of [BigInt.asIntN(128, w(0)), BigInt.asIntN(128, w(1))]) out.push({ index: l.index, value: v < 0n ? -v : v });
    else if (l.address === pm && t[0] === TOPIC.claims && t.length === 4 && t[3] === coinWord && words === 2) out.push({ index: l.index, value: w(1) });
  }
  return out;
}

/** A bundle's user operations: each one's account and the log indexes of its run (lo, hi exclusive). */
export function operations(receipt) {
  const ep = receipt.to;
  const ops = [];
  let start = null;
  for (const l of [...receipt.logs].sort((a, b) => a.index - b.index)) {
    if (l.address !== ep) continue;
    if (l.topics[0] === BEFORE_EXECUTION) start = l.index;
    else if (l.topics[0] === AGGREGATOR_CHANGED && start !== null) start = l.index;
    else if (l.topics[0] === USER_OP_EVENT && start !== null) {
      if (/^0x0{24}[0-9a-f]{40}$/.test(l.topics[2] ?? "")) ops.push({ lo: start, hi: l.index, account: `0x${l.topics[2].slice(26)}` });
      start = l.index;
    }
  }
  return ops;
}

/** The check on one run: { base, chains: { [chain]: { lists, tapes: [{ coin, status, src, rows }], decimals, receipts } } }. */
export function judge(run) {
  const lines = [];
  const bad = (s) => lines.push(`BAD ${s}`);
  let unread = false;
  for (const [chain, c] of Object.entries(run.chains ?? {})) {
    const pm = VENUES[chain].poolManager;
    let judged = 0;
    let vendor = 0;
    if (!Array.isArray(c.tapes) || c.tapes.length === 0) {
      bad(`${chain}: no tape read (${c.lists ?? "no list"})`);
      continue;
    }
    for (const tape of c.tapes) {
      if (tape.status !== 200 || !Array.isArray(tape.rows)) {
        lines.push(`--  ${chain} ${tape.coin}: tape ${tape.status}`);
        continue;
      }
      const dec = c.decimals?.[tape.coin];
      for (const row of tape.rows) {
        const r = c.receipts?.[row.tx];
        const name = `${chain} ${tape.coin} trade ${row.tx.slice(0, 10)} (src ${tape.src})`;
        if (!Number.isSafeInteger(dec) || !isObj(r)) {
          lines.push(`--  ${name}: ${Number.isSafeInteger(dec) ? "its receipt" : "the token's decimals"} not given alike by two providers`);
          continue;
        }
        judged++;
        if (tape.src !== "chain") vendor++;
        const want = units(row.amt, dec);
        const hits = want === null ? [] : moves(r, tape.coin, pm).filter((m) => m.value === want);
        if (hits.length === 0) {
          bad(`${name}: amt ${row.amt} is no move of the token in its receipt (${dec} decimals; its moves ${moves(r, tape.coin, pm).map((m) => m.value.toString()).join(", ") || "none"})`);
          continue;
        }
        if (row.trader === null) {
          lines.push(`ok  ${name}: amt ${row.amt} exactly a move of the token; no trader named`);
          continue;
        }
        if (ENTRY_POINTS.includes(r.to)) {
          const holders = operations(r).filter((o) => hits.some((m) => o.lo < m.index && m.index < o.hi)).map((o) => o.account);
          if (row.trader === r.from) bad(`${name}: trader ${row.trader} is the bundler that sent it, not the account (${holders.join(", ") || "none"})`);
          else if (!holders.includes(row.trader)) bad(`${name}: trader ${row.trader} is no account whose user operation moved the token (${holders.join(", ") || "none"})`);
          else lines.push(`ok  ${name}: amt ${row.amt} exactly a move of the token; trader ${row.trader}, the account (bundler ${r.from})`);
        } else if (row.trader !== r.from) bad(`${name}: trader ${row.trader} is not the transaction's sender ${r.from}`);
        else lines.push(`ok  ${name}: amt ${row.amt} exactly a move of the token; trader ${row.trader}, the sender`);
      }
    }
    if (judged === 0) {
      unread = true;
      lines.push(`--  ${chain}: no row judged on ${c.tapes.length} tape${c.tapes.length === 1 ? "" : "s"}`);
    } else lines.push(`ok  ${chain}: ${judged} row${judged === 1 ? "" : "s"} judged, ${vendor} of them from a tape not of our own reads`);
  }
  if (Object.keys(run.chains ?? {}).length === 0) bad("no chain read");
  const failed = lines.some((l) => l.startsWith("BAD"));
  return { ok: !failed && !unread, exit: failed ? EXIT.FAIL : unread ? EXIT.INCONCLUSIVE : EXIT.PASS, lines };
}

async function getJson(base, path, fetchFn) {
  try {
    const r = await fetchFn(`${base.replace(/\/$/, "")}${path}`, { redirect: "manual", headers: { origin: APP, "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    let body = null;
    try {
      body = await r.json();
    } catch {
      // not JSON: judged by its status
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: `no answer (${e.message})`, body: null };
  }
}

/** One provider's results for `calls`, in batches of 3 (the smallest a provider of ours takes); undefined where none. */
async function batch(url, calls, fetchFn) {
  const out = calls.map(() => undefined);
  for (let k = 0; k < calls.length; k += 3) {
    const part = calls.slice(k, k + 3);
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part.map((c, i) => ({ jsonrpc: "2.0", id: k + i, method: c.method, params: c.params }))), signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      if (Array.isArray(j)) for (const o of j) if (isObj(o) && Number.isInteger(o.id) && o.id >= k && o.id < k + part.length && o.result != null) out[o.id] = o.result;
    } catch {
      // that part unanswered: asked of the next provider
    }
  }
  return out;
}

const low = (v) => String(v).toLowerCase();
/** The parts of a receipt the check judges, or null for one that is not a successful transaction of `tx`. */
const receiptOf = (tx) => (r) =>
  isObj(r) && low(r.transactionHash) === tx && r.status === "0x1" && Array.isArray(r.logs)
    ? { from: low(r.from), to: low(r.to), logs: r.logs.map((l) => ({ address: low(l.address), index: parseInt(l.logIndex, 16), topics: (l.topics ?? []).map(low), data: /^0x([0-9a-f]{2})*$/i.test(l.data ?? "") ? low(l.data) : "0x" })) }
    : null;

/** Each call's result two providers gave alike (by `pick`), or null. */
async function agreed(calls, fetchFn, rpcs, pick) {
  const got = calls.map(() => []);
  for (const url of rpcs) {
    const want = calls.map((_, i) => i).filter((i) => got[i].length < 2);
    if (want.length === 0) break;
    const r = await batch(url, want.map((i) => calls[i]), fetchFn);
    want.forEach((i, k) => r[k] !== undefined && got[i].push(JSON.stringify(pick[i](r[k]))));
  }
  return got.map((g) => (g.length >= 2 && g[0] === g[1] ? JSON.parse(g[0]) : null));
}

/** What the check reads on one chain. */
export async function readChain(base, chain, fetchFn = fetch, rpcs = SWAP_RPCS[chain]) {
  const c = { tapes: [], decimals: {}, receipts: {} };
  const l = await getJson(base, `/v1/market/lists?chain=${chain}`, fetchFn);
  if (l.status !== 200 || !isObj(l.body?.lists)) {
    c.lists = `lists ${l.status}`;
    return c;
  }
  const order = ["new", ...Object.keys(l.body.lists).filter((k) => k !== "new")];
  const coins = [];
  for (const k of order) for (const row of l.body.lists[k] ?? []) if (ADDR.test(row?.token ?? "") && !coins.includes(row.token)) coins.push(row.token);
  const tapes = [];
  for (const coin of coins.slice(0, TOKENS)) {
    const t = await getJson(base, `/v1/market/trades?chain=${chain}&token=${coin}&limit=50`, fetchFn);
    const rows = Array.isArray(t.body?.trades)
      ? t.body.trades.filter((x) => TX.test(x?.tx ?? "")).slice(0, ROWS).map((x) => ({ tx: x.tx, side: x.side, amt: String(x.amt), trader: typeof x.trader === "string" ? low(x.trader) : null }))
      : null;
    tapes.push({ coin, status: t.status, src: typeof t.body?.src === "string" ? t.body.src : null, rows });
  }
  // tapes not of our own reads first: the vendor's rows are what the card made exact
  tapes.sort((a, b) => (a.src === "chain") - (b.src === "chain"));
  let judged = 0;
  for (const tape of tapes) {
    if (judged >= JUDGE_ENOUGH) break;
    c.tapes.push(tape);
    if (tape.status !== 200 || tape.rows === null || tape.rows.length === 0) continue;
    const txs = [...new Set(tape.rows.map((r) => r.tx))].filter((tx) => !(tx in c.receipts));
    const calls = [{ method: "eth_call", params: [{ to: tape.coin, data: "0x313ce567" }, "latest"] }, ...txs.map((tx) => ({ method: "eth_getTransactionReceipt", params: [tx] }))];
    const pick = [(d) => (typeof d === "string" && WORD.test(d) ? Number(BigInt(d)) : null), ...txs.map(receiptOf)];
    const got = await agreed(calls, fetchFn, rpcs, pick);
    c.decimals[tape.coin] = got[0];
    txs.forEach((tx, i) => (c.receipts[tx] = got[i + 1]));
    if (Number.isSafeInteger(got[0])) judged += tape.rows.filter((r) => isObj(c.receipts[r.tx])).length;
  }
  return c;
}

export async function read(base = BASE, fetchFn = fetch, chains = ["base", "robinhood"]) {
  const run = { base, at: new Date().toISOString(), chains: {} };
  for (const chain of chains) run.chains[chain] = await readChain(base, chain, fetchFn);
  return run;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const base = opt("--base", BASE);
    const chains = opt("--chain") ? [opt("--chain")] : ["base", "robinhood"];
    for (const c of chains) if (!(c in SWAP_RPCS)) throw new Error(`no chain ${c}`);
    const run = await read(base, fetch, chains);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const { exit, lines } = judge(run);
    for (const line of lines) console.log(line);
    console.log(`live-check ${KEY}: ${exit === EXIT.PASS ? "PASS" : exit === EXIT.FAIL ? "FAIL" : "INCONCLUSIVE"} (${base}, ${chains.join(" and ")})`);
    process.exit(exit);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(EXIT.ERROR);
  }
}
