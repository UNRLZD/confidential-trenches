#!/usr/bin/env node
// Live check of card helper-receipts-past-retention: HELPER_HOST's POST /v1/rpc/{base,robinhood} answers a mined
// transaction's receipt, the transaction and its block by number however old they are, never null while one of the
// route's upstreams keeps them. Read 19 Nov 02:20Z (a run of evm-pool-index.mjs at main f1bb364ad): the helper's
// /v1/rpc/robinhood?keyed=only answered 0 of 10 Initialize receipts of blocks 116376549-116876548 null, where
// rpc.mainnet.chain.robinhood.com answered 10 of 10; an upstream behind the route no longer kept them, and the helper
// passed its null on. Now a null for a receipt, a transaction or a numbered block is asked of the route's next
// upstreams (apps/helper/src/rpc/rpc.ts PAST_NULL_TRIES).
// For each chain, read only: a reader not ours (REF) names a block DEPTH below its head and that block's last RECEIPTS
// transactions; then on the helper's keyed route (?keyed=only) one call each of eth_getBlockByNumber (that number),
// eth_getTransactionByHash and eth_getTransactionReceipt (its last transaction), and one batch of every listed
// transaction's receipt; and that batch once more on the device's route (no keyed=only). 5 posts a chain.
// PASS when every answer names the block REF named (its number and hash; each transaction's hash and block number).
// FAIL: a null, a call's error, an answer naming another block or transaction, or an HTTP error for the batch.
// INCONCLUSIVE (exit 3), named: REF did not answer its head or the block, or a no-answer from the helper (no
// connection, a 429 or a rate limit's words, provider-answer.mjs classify).
// After: helper
// Serial: evm-keyed 16 (its reads on the helper's keyed Base and Robinhood route draw the keyed providers)
//   node scripts/live-checks/helper-receipts-past-retention.mjs [--base <url>] [--record <file> --as good|bad]
//     [--answer <file> --as good|bad]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3. --record writes what the run read; --answer judges a
//   recorded run instead of reading.
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EXIT, rpcAnswer, rpcBatchAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-receipts-past-retention";
export const BASE = "https://ct-api.unrealized.trade";
/** Each chain's reader not ours, on an operator apart from the helper's keyed ones. */
export const REF = Object.freeze({ base: "https://base-rpc.publicnode.com", robinhood: "https://robinhood-rpc.publicnode.com" });
/** How far below REF's head the block is: past the span the upstream forgot on 19 Nov (blocks 116376549 on, about
 *  1.0 to 1.5 million below Robinhood's head of 117.9 million). [design: 1,500,000; on Base, 2 s blocks, 35 days.] */
export const DEPTH = 1_500_000;
/** The most receipts in the batch: the route's own batch limit (packages/kit/src/helper/v1.ts HELPER_RPC_BATCH_MAX). */
export const RECEIPTS = 10;
export const TIMEOUT_MS = 15_000;
const HEX = /^0x[0-9a-f]{1,64}$/i;
const cut = (v, n = 160) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n).replace(/\s+/g, " ");
const hex = (n) => `0x${n.toString(16)}`;

/** One run: each chain's REF block and the helper's answers. */
export async function read(base = BASE, fetchFn = fetch) {
  const chains = {};
  for (const [chain, ref] of Object.entries(REF)) {
    const h = await rpcAnswer(ref, "eth_blockNumber", [], { fetchFn, timeoutMs: TIMEOUT_MS });
    if (typeof h.result !== "string" || !HEX.test(h.result)) {
      chains[chain] = { ref: { head: h } };
      continue;
    }
    const n = hex(Number(BigInt(h.result)) - DEPTH);
    const b = await rpcAnswer(ref, "eth_getBlockByNumber", [n, false], { fetchFn, timeoutMs: TIMEOUT_MS });
    const txs = Array.isArray(b.result?.transactions) ? b.result.transactions.filter((t) => typeof t === "string" && HEX.test(t)).slice(-RECEIPTS) : [];
    if (txs.length === 0) {
      chains[chain] = { ref: { head: h.result, number: n, block: b } };
      continue;
    }
    const keyed = `${base.replace(/\/$/, "")}/v1/rpc/${chain}?keyed=only`;
    const plain = `${base.replace(/\/$/, "")}/v1/rpc/${chain}`;
    const last = txs[txs.length - 1];
    const o = { fetchFn, timeoutMs: TIMEOUT_MS };
    chains[chain] = {
      ref: { head: h.result, number: n, hash: b.result.hash, txs },
      block: await rpcAnswer(keyed, "eth_getBlockByNumber", [n, false], o),
      tx: await rpcAnswer(keyed, "eth_getTransactionByHash", [last], o),
      receipt: await rpcAnswer(keyed, "eth_getTransactionReceipt", [last], o),
      keyedBatch: await rpcBatchAnswer(keyed, txs.map((t) => ["eth_getTransactionReceipt", [t]]), o),
      plainBatch: await rpcBatchAnswer(plain, txs.map((t) => ["eth_getTransactionReceipt", [t]]), o),
    };
  }
  return { base, at: new Date().toISOString(), depth: DEPTH, chains };
}

/** The check on one run: { verdict, ok, lines }. */
export function judge(run) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const line = (good, s) => {
    lines.push(`${good ? "ok " : "BAD"} ${s}`);
    if (!good) bad = true;
  };
  const silent = (s) => {
    quiet = true;
    lines.push(`--- ${s}: INCONCLUSIVE`);
  };
  line(run?.depth === DEPTH, `the run's block is ${run?.depth} below the reference's head (the card's: ${DEPTH})`);
  for (const chain of Object.keys(REF)) {
    const c = run?.chains?.[chain];
    if (c === undefined) {
      line(false, `${chain}: not read`);
      continue;
    }
    const ref = c.ref ?? {};
    if (!Array.isArray(ref.txs) || ref.txs.length === 0 || typeof ref.hash !== "string") {
      silent(`${chain}: the reference reader named no block with transactions ${cut(ref.block ?? ref.head ?? ref)}`);
      continue;
    }
    const n = String(ref.number).toLowerCase();
    // one answer: null or wrong is FAIL, a no-answer INCONCLUSIVE; `fits` the answer naming what REF named
    const one = (what, a, fits) => {
      if (a === undefined) return line(false, `${chain} ${what}: not read`);
      if (a.noAnswer !== undefined) return silent(`${chain} ${what}: ${cut(a.noAnswer)}`);
      if (a.error !== undefined) return line(false, `${chain} ${what}: an error: ${cut(a.error)}`);
      if (a.result === null) return line(false, `${chain} ${what}: null, for a record the reference keeps`);
      line(fits(a.result), `${chain} ${what}: ${fits(a.result) ? "answered" : `another record: ${cut(a.result)}`}`);
    };
    const inBlock = (t) => (r) => r !== null && typeof r === "object" && String(r.blockNumber).toLowerCase() === n && String(r.blockHash).toLowerCase() === ref.hash.toLowerCase() && String(r.transactionHash ?? r.hash).toLowerCase() === t.toLowerCase();
    const last = ref.txs[ref.txs.length - 1];
    one(`block ${Number(BigInt(n))} by number`, c.block, (r) => r !== null && typeof r === "object" && String(r.number).toLowerCase() === n && String(r.hash).toLowerCase() === ref.hash.toLowerCase());
    one(`transaction ${last.slice(0, 10)}`, c.tx, inBlock(last));
    one(`receipt ${last.slice(0, 10)}`, c.receipt, inBlock(last));
    for (const [what, b] of [["keyed route", c.keyedBatch], ["device's route", c.plainBatch]]) {
      const name = `${chain} ${what}, a batch of ${ref.txs.length} receipts`;
      if (b === undefined) {
        line(false, `${name}: not read`);
        continue;
      }
      if (b.error !== undefined) {
        line(false, `${name}: HTTP ${b.status} with one error for the batch: ${cut(b.error)}`);
        continue;
      }
      if (b.noAnswer !== undefined) {
        silent(`${name}: ${cut(b.noAnswer)}`);
        continue;
      }
      const answers = Array.isArray(b.answers) ? b.answers : [];
      line(b.status === 200 && answers.length === ref.txs.length, `${name}: HTTP ${b.status}, ${answers.length} answers`);
      const before = lines.length;
      answers.forEach((a, k) => one(`${what} receipt ${k + 1} (${String(ref.txs[k]).slice(0, 10)})`, a, inBlock(ref.txs[k])));
      // the batch's ok lines folded into one, its BAD and --- lines kept
      const mine = lines.splice(before);
      const kept = mine.filter((l) => !l.startsWith("ok "));
      lines.push(...kept);
      if (kept.length === 0) lines.push(`ok  ${name}: every receipt in block ${Number(BigInt(n))}`);
    }
  }
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  try {
    const run = arg("--answer") !== undefined ? JSON.parse(readFileSync(arg("--answer"), "utf8"))[arg("--as") ?? "good"] : await read(arg("--base") ?? BASE);
    if (arg("--record") !== undefined) {
      const f = arg("--record");
      const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      all[arg("--as") ?? "good"] = run;
      writeFileSync(f, JSON.stringify(all, null, 1) + "\n");
    }
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`${KEY}: ${verdict}`);
    process.exit(EXIT[verdict]);
  } catch (e) {
    console.error(`${KEY}: error: ${e?.message ?? e}`);
    process.exit(2);
  }
}
