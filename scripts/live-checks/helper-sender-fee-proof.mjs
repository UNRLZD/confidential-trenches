#!/usr/bin/env node
// Live check of card helper-sender-fee-proof: the helper counts a landed sale as paid only when both providers'
// receipts prove its fee (apps/helper/src/pool/evm.ts evmSaleUnpaid: status 1 and the fee collector's Paid log, from
// the collector, `from` W, `value` at least the Sell's fee, on each receipt); any other pair is charged its whole cost
// and marks nothing paid. Nothing is sent and no key is read: for each EVM testnet it reads, on both of the run's public
// RPCs (pool-evm-testnet-run.mjs RPCS), the transaction and the receipt of the sale the deployed helper sent in that
// chain's recorded run (helper-evm-sender.run.<chain>.json, the sell with via "helper").
// DERIVED RECEIPTS: no FeeCollector (card evm-fee-collector) is deployed on a testnet yet, and these sales paid their
// fee to the caller, so the check adds to each real receipt, as read, the Paid log the collector's receive() would emit
// for the sale (from COLLECTORS' stand-in, topic 1 W, data the fee) and replays the rule over those derived receipts.
// Once a testnet collector is deployed and a sale through it is recorded, COLLECTORS names it, DERIVE is false and the
// receipts are judged as the RPCs answer them.
// Over each sale's two receipts it runs the helper's own rule (this commit's evm.ts):
//   - the sale with the collector's Paid log on both receipts: proven and paid, 0 unpaid;
//   - the same with the Paid log taken out of one receipt (landed without paying the collector, as when W's call ran
//     another contract's code), the log from W's own address or the pool's, from another payer, a value one wei under
//     the fee, or one receipt's status 0: each charged its whole cost (the higher receipt's gasUsed x
//     effectiveGasPrice + l1Fee), nothing paid.
// The Sell's fee is the call's fee word (word 1 of SellDelegate.sell's input, the same in the 10- and 11-field Sell); W is
// the transaction's `to`, and the pool is the Sell tuple's word 5.
// Runs: once, at merge: it reads no host; it runs this commit's evmSaleUnpaid over both testnets' recorded helper sales,
// read on two public RPCs each, so a deploy changes nothing it reads.
//   node scripts/live-checks/helper-sender-fee-proof.mjs [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { evmSaleUnpaid } from "../../apps/helper/src/pool/evm.ts";
import { NETWORKS, sellRunFile } from "./helper-evm-sender.mjs";
import { RPCS } from "./pool-evm-testnet-run.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const word = (v) => v.toString(16).padStart(64, "0");

/** FeeCollector's Paid(address indexed from, uint256 value) topic 0, written out (cast keccak "Paid(address,uint256)"). */
export const PAID_TOPIC = "0x737c69225d647e5994eab1a6c301bf6d9232beb2759ae1e27a8966b4732bc489";
/** Each testnet's fee collector: a stand-in until card evm-fee-collector deploys one (no code is read at it). */
export const COLLECTORS = { "base-sepolia": "0x00000000000000000000000000000000c011ec70", "robinhood-testnet": "0x00000000000000000000000000000000c011ec70" };
/** Whether read() adds the collector's Paid log to each receipt it reads (no testnet collector yet: true). */
export const DERIVE = true;

/** The Paid log the collector emits for a sale: from `collector`, topic 1 W, data `value`. */
export const paidLog = (collector, w, value) => ({ address: collector, topics: [PAID_TOPIC, `0x${word(BigInt(w))}`], data: `0x${word(value)}`, removed: false, derived: true });

/** The sale the deployed helper sent in each chain's recorded run: { network: hash }. */
export function helperSales(networks = NETWORKS) {
  return Object.fromEntries(networks.map((n) => {
    const rec = JSON.parse(readFileSync(sellRunFile(n), "utf8"));
    const t = rec.txs.filter((x) => x.kind === "sell" && x.via === "helper");
    if (t.length !== 1 || !HASH.test(t[0].hash)) throw new Error(`${n}: the run record holds ${t.length} helper sells`);
    return [n, t[0].hash];
  }));
}

/** The Sell a sale's transaction carries, as the helper reads it: W its `to`, the pool and fee words. */
export function saleOf(tx) {
  const input = lower(tx?.input) ?? "";
  if (!/^0x[0-9a-f]{8}([0-9a-f]{64})+$/.test(input)) throw new Error("the transaction's input is no call");
  const wordAt = (i) => BigInt(`0x${input.slice(10 + 64 * i, 10 + 64 * (i + 1)) || "0"}`);
  const at = Number(wordAt(0) / 32n); // the Sell tuple's head
  const w = lower(tx.to);
  if (!ADDRESS.test(w ?? "")) throw new Error("the transaction has no `to`");
  return { w, pool: `0x${wordAt(at + 5).toString(16).padStart(40, "0")}`, fee: wordAt(1) };
}

const isPaid = (l) => lower(l?.topics?.[0]) === PAID_TOPIC;
const strip = (r) => ({ ...r, logs: (r.logs ?? []).filter((l) => !isPaid(l)) });
const editLog = (r, f) => ({ ...r, logs: (r.logs ?? []).map((l) => (isPaid(l) ? f(l) : l)) });
/** The landed-without-proof answers made from a sale's two receipts: each must be charged in full. */
export const PLANTS = [
  ["no Paid log on provider a", (a, b) => [strip(a), b]],
  ["no Paid log on provider b", (a, b) => [a, strip(b)]],
  ["the log from W's own address", (a, b, s) => [editLog(a, (l) => ({ ...l, address: s.w })), b]],
  ["the log from the pool", (a, b, s) => [a, editLog(b, (l) => ({ ...l, address: s.pool }))]],
  ["from another payer", (a, b) => [a, editLog(b, (l) => ({ ...l, topics: [l.topics[0], `0x${"00".repeat(12)}${"ba".repeat(20)}`] }))]],
  ["a value one wei under the fee", (a, b, s) => [editLog(a, (l) => ({ ...l, data: `0x${word(s.fee - 1n)}` })), b]],
  ["status 0 on provider b", (a, b) => [a, { ...b, status: "0x0" }]],
];

/** The check on one recorded run: { derived, sales: [{ network, hash, reads: [{ url, tx, receipt }] }] }. */
export function judge(run, sales = helperSales(), collectors = COLLECTORS) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const got = run.sales ?? [];
  say(got.length === Object.keys(sales).length && Object.entries(sales).every(([n, h]) => got.some((x) => x.network === n && x.hash === h)), `sales read: ${show(got.map((x) => `${x.network} ${x.hash}`))}, want ${show(sales)}`);
  say(run.derived === DERIVE, `receipts ${run.derived ? "carry a derived Paid log (no testnet FeeCollector yet)" : "as the RPCs answer them"}, want ${DERIVE ? "derived" : "as answered"}`);
  for (const x of got) {
    const n = x.network;
    const collector = Object.hasOwn(collectors, n) ? collectors[n] : undefined;
    if (!ADDRESS.test(collector ?? "")) {
      say(false, `[${n}] no fee collector named`);
      continue;
    }
    const urls = RPCS[n] ?? [];
    const reads = x.reads ?? [];
    const both = reads.length === 2 && urls.every((u, i) => reads[i]?.url === u) && reads.every((r) => r.tx && r.receipt && lower(r.tx.hash) === x.hash && lower(r.receipt.transactionHash) === x.hash);
    say(both, `[${n} ${x.hash}] its transaction and receipt read on both RPCs ${show(urls)}`);
    if (!both) continue;
    let s;
    try {
      s = saleOf(reads[0].tx);
    } catch (e) {
      say(false, `[${n}] ${e.message}`);
      continue;
    }
    const worst = BigInt(reads[0].tx.gas ?? 0) * BigInt(reads[0].tx.maxFeePerGas ?? 0);
    const [ra, rb] = reads.map((r) => r.receipt);
    const sale = { collector, w: s.w, fee: s.fee };
    const real = evmSaleUnpaid(ra, rb, sale, worst);
    say(real.proven && real.paid && real.unpaid === 0n, `[${n}] the sale as both receipts hold it: ${show(real)}, want proven and paid, 0 unpaid (W ${s.w}, collector ${collector}, fee ${s.fee})`);
    const costOf = (r) => BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + (r.l1Fee ? BigInt(r.l1Fee) : 0n);
    for (const [name, plant] of PLANTS) {
      const [pa, pb] = plant(ra, rb, s);
      const cost = [costOf(pa), costOf(pb)].reduce((p, q) => (p > q ? p : q));
      const r = evmSaleUnpaid(pa, pb, sale, worst);
      say(!r.proven && !r.paid && r.unpaid === cost, `[${n}] ${name}: ${show(r)}, want charged its whole cost ${cost}, nothing paid`);
    }
  }
  return { ok: lines.length > 0 && lines.every((l) => l.startsWith("ok ")), lines };
}

/** One JSON-RPC call; its result, or a throw. */
async function call(url, method, params, fetchFn) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  const j = await r.json();
  if (j.error || j.result == null) throw new Error(`${new URL(url).host} ${method}: ${show(j.error ?? null)}`);
  return j.result;
}

export async function read(fetchFn = fetch, sales = helperSales(), collectors = COLLECTORS) {
  const out = [];
  for (const [network, hash] of Object.entries(sales)) {
    const reads = [];
    for (const url of RPCS[network]) {
      const tx = await call(url, "eth_getTransactionByHash", [hash], fetchFn);
      const receipt = await call(url, "eth_getTransactionReceipt", [hash], fetchFn);
      // DERIVE: the Paid log the collector would emit for this sale, added to the receipt as read (see the header)
      if (DERIVE && Array.isArray(receipt?.logs)) {
        const s = saleOf(tx);
        receipt.logs = [...receipt.logs, paidLog(collectors[network], s.w, s.fee)];
      }
      reads.push({ url, readAt: new Date().toISOString(), tx, receipt });
    }
    out.push({ network, hash, reads });
  }
  return { derived: DERIVE, sales: out };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--record");
  try {
    const run = await read();
    if (i >= 0) writeFileSync(args[i + 1], `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS helper-sender-fee-proof" : "FAIL helper-sender-fee-proof");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`helper-sender-fee-proof: ${e.message}`);
    process.exit(2);
  }
}
