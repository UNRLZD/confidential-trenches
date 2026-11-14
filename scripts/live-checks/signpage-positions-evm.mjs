#!/usr/bin/env node
// Live check of card signpage-positions-evm: the testnet run in which a Base Sepolia pool buy became a position in the
// signing page's state and the page's EVM sell sold it in full (signpage-positions-evm.md, its W, Buy and Sell lines;
// packages/signpage/scripts/pool-positions-evm-testnet.mjs), read on the chain. It passes only when, on both of Base
// Sepolia's pool RPCs (signpage-evm-pool-buy.mjs RPCS, the pair the page reads its positions on):
//   1. the buy is PrivacyPoolSimple.buy (selector 0x3edadd79) to the pinned pool (evm-pool-pins.mjs PINS), on the
//      chain's own id, succeeded, in one block on both, with the pool's Bought log naming W: the holding the page's
//      positions pass reads W's balanceOf for;
//   2. the sell is a transaction to W (SellDelegate.sell through W's delegation, which the helper's sell sender carries),
//      on the chain's id, succeeded, in one block on both, after the buy's, with the pool's Deposited log naming W: the
//      sale of what the position showed went back into the pool;
//   3. at each RPC's newest block, W holds none of the token: the position the page showed is gone, so its pass shows
//      it no more;
// and on SIGN_HOST:
//   4. the served /app.js is the one its index.html pins; it carries the state read that joins each EVM chain's
//      positions after Solana's (JOIN), so a deploy that drops it serves a page whose Base and Robinhood positions are
//      never read; and, as the mainnet build pins both EVM pools (card evm-pools-on-mainnet, which turned this part
//      over), it carries the EVM positions pass (its agreed balance's refusal, PASS_MARK), so a deploy that leaves the
//      pass out serves a page that never shows a Base or Robinhood position.
// What it cannot see from outside: the page's state itself. It needs the run's seed, which a runner never holds; the
// positions after the buy and after the sell are the run's (its out record) and the card's tests hold the pass
// (packages/signpage/test/positions-evm.test.ts).
// DEPOSITED is this file's own (it reaches no package code: check:imports holds it); packages/signpage/test/
// positions-evm.test.ts holds it equal to keccak256 of the wallet's EVM_POOL_EVENTS.Deposited.
// After: sign
// Bundle: out a run record's Base Sepolia buy and sell, and W's balance, on two testnet RPCs; the testnet build's positions pass is held by packages/signpage/test/positions-evm.test.ts (the mainnet build pins no EVM pool)
//   node scripts/live-checks/signpage-positions-evm.mjs [--record <file>] [--txs <md>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3 (a pool RPC gave no answer, provider-answer.mjs: never a
//   pass). --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PINS } from "./evm-pool-pins.mjs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";
import { BOUGHT, BUY_SELECTOR, CHAIN_IDS, RPCS } from "./signpage-evm-pool-buy.mjs";

const KEY = "signpage-positions-evm";
export const SIGN = "https://confidential.unrealized.trade";
/** src/positions-evm.ts agreedBalance's refusal: only the EVM positions pass carries it. */
export const PASS_MARK = "balanceOf: the two RPCs differ";
/** src/pool-testnet.ts's state read, as minified: Solana's read first, then each EVM chain's,
 *  `positions:async()=>{let[e,...t]=await Promise.all([c.read(),...[`base`,`robinhood`].map(`, or since card
 *  move-sends-or-says-why (T1) each read bounded by STATE_READ_MS:
 *  `...Promise.all([Tz(Bt.read(),r5,`solana's positions`).catch(()=>null),...[`base`,`robinhood`].map(`. */
export const JOIN = /positions:async\(\)=>\{let ?(?:[\w$]+=[\w$]+,)*\[[\w$]+,\.\.\.[\w$]+\]=await Promise\.all\(\[(?:[\w$]+\.read\(\)|[\w$]+\([\w$]+\.read\(\),[\w$]+,`solana's positions`\)\.catch\(\(\)=>null\)),\.\.\.\[[`"]base[`"],[`"]robinhood[`"]\]\.map\(/g;
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
/** What the check keeps of SIGN_HOST: its index's /app.js pin, the served bundle's sha384, and the two marks' counts. */
export function pageFacts(index, js) {
  return { pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null, sha384: sha384(js), marks: { pass: js.split(PASS_MARK).length - 1, join: [...js.matchAll(JOIN)].length } };
}
export const NETWORK = "base-sepolia";
/** keccak256("Deposited(address,uint256,uint256,uint256,uint256)"). */
export const DEPOSITED = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const RECORD = new URL("./signpage-positions-evm.md", import.meta.url);
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/** The run of a record: its `W: <address>`, `Asset: <address>`, `Buy: base-sepolia <hash>` and `Sell: base-sepolia <hash>`. */
export function runOf(md) {
  const one = (re) => re.exec(md)?.[1]?.toLowerCase() ?? null;
  return { w: one(/^W: (0x[0-9a-fA-F]{40})$/m), asset: one(/^Asset: (0x[0-9a-fA-F]{40})$/m), buy: one(/^Buy: base-sepolia (0x[0-9a-f]{64})$/m), sell: one(/^Sell: base-sepolia (0x[0-9a-f]{64})$/m) };
}

const word = (a) => a.slice(2).padStart(64, "0");
const names = (log, w) => Array.isArray(log?.topics) && (log.topics.some((t) => String(t).toLowerCase() === `0x${word(w)}`) || String(log.data ?? "").toLowerCase().includes(word(w)));

/** The check on one run: { run, reads: [{ rpc, method, of, answer }] (answer: rpcAnswer's). A pool RPC's no-answer is a
 *  NOTE and leaves the run INCONCLUSIVE, never a pass. */
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  let quiet = false;
  const { w, asset, buy, sell } = rec.run ?? {};
  const pin = PINS[NETWORK];
  say(ADDRESS.test(w ?? "") && ADDRESS.test(asset ?? "") && HASH.test(buy ?? "") && HASH.test(sell ?? "") && buy !== sell, `the record names W, the bought asset, a buy and a sell on ${NETWORK}`);
  const at = (rpc, method, of) => rec.reads.find((r) => r.rpc === rpc && r.method === method && r.of === of)?.answer;
  const blocks = { buy: [], sell: [] };
  for (const rpc of RPCS[NETWORK]) {
    const host = new URL(rpc).host;
    for (const leg of ["buy", "sell"]) {
      const hash = leg === "buy" ? buy : sell;
      const tag = `[${leg} ${String(hash).slice(0, 10)}] ${host}:`;
      const got = ["eth_getTransactionByHash", "eth_getTransactionReceipt"].map((m) => at(rpc, m, hash));
      const silent = got.find((a) => a?.noAnswer !== undefined);
      if (silent) {
        quiet = true;
        lines.push(`NOTE ${tag} ${silent.noAnswer}`);
        continue;
      }
      const [tx, rc] = got.map((a) => a?.result);
      const ok = tx?.hash?.toLowerCase() === hash && BigInt(tx?.chainId ?? -1) === CHAIN_IDS[NETWORK] && rc?.status === "0x1";
      const logs = Array.isArray(rc?.logs) ? rc.logs.filter((l) => l?.address?.toLowerCase() === pin.pool) : [];
      if (leg === "buy") {
        const bought = logs.some((l) => l?.topics?.[0] === BOUGHT && names(l, w));
        say(ok && tx?.to?.toLowerCase() === pin.pool && String(tx?.input ?? "").startsWith(BUY_SELECTOR) && bought, `${tag} buy() to the pinned pool, succeeded, with the pool's Bought for W (status ${rc?.status ?? "none"}, Bought for W ${bought})`);
      } else {
        const deposited = logs.some((l) => l?.topics?.[0] === DEPOSITED && names(l, w));
        say(ok && tx?.to?.toLowerCase() === w && deposited, `${tag} the sell to W, succeeded, with the pool's Deposited from W (to ${tx?.to ?? "none"}, status ${rc?.status ?? "none"}, Deposited from W ${deposited})`);
      }
      blocks[leg].push(rc?.blockNumber ?? null);
    }
    const bal = at(rpc, "eth_call", `${w} ${asset}`);
    if (bal?.noAnswer !== undefined) {
      quiet = true;
      lines.push(`NOTE [W's balance] ${host}: ${bal.noAnswer}`);
    } else {
      const v = typeof bal?.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(bal.result) ? BigInt(bal.result) : null;
      say(v === 0n, `[W's balance] ${host}: W holds none of the token at the newest block (${v ?? "not read"})`);
    }
  }
  for (const leg of ["buy", "sell"]) {
    const b = blocks[leg];
    if (b.length === 2) say(b[0] !== null && b[0] === b[1], `[${leg}] one block on both RPCs: ${b.join(", ")}`);
  }
  const p = rec.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.marks?.join >= 1, `[SIGN_HOST] /app.js joins each EVM chain's positions into the state read (join ${p?.marks?.join ?? "?"})`);
  say(p?.marks?.pass >= 1, `[SIGN_HOST] the mainnet build carries the EVM positions pass (both mainnet EVM pools pinned; pass ${p?.marks?.pass ?? "?"})`);
  if (blocks.buy[0] && blocks.sell[0]) say(BigInt(blocks.sell[0]) > BigInt(blocks.buy[0]), `[sell] after the buy: block ${BigInt(blocks.sell[0])} > ${BigInt(blocks.buy[0])}`);
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

/** The run's reads: the buy and the sell on both pool RPCs, W's balance of the token at each one's newest block, and
 *  SIGN_HOST's page. */
export async function read(md = readFileSync(RECORD, "utf8"), fetchFn = fetch) {
  const run = runOf(md);
  const reads = [];
  for (const rpc of RPCS[NETWORK]) {
    for (const hash of [run.buy, run.sell])
      for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) if (hash) reads.push({ rpc, method, of: hash, answer: await rpcAnswer(rpc, method, [hash], { fetchFn, nullNoAnswer: true }) });
    if (run.w && run.asset) reads.push({ rpc, method: "eth_call", of: `${run.w} ${run.asset}`, answer: await rpcAnswer(rpc, "eth_call", [{ to: run.asset, data: `0x70a08231${word(run.w)}` }, "latest"], { fetchFn }) });
  }
  const get = async (path) => {
    const r = await fetchFn(`${SIGN}${path}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${path}: HTTP ${r.status}`);
    return r.text();
  };
  const page = pageFacts(await get("/"), await get("/app.js"));
  return { readAt: new Date().toISOString(), run, reads, page };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rec = await read(opt("--txs") ? readFileSync(opt("--txs"), "utf8") : undefined);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    const { verdict, lines } = judge(rec);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
