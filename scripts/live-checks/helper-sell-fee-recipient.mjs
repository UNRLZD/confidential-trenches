#!/usr/bin/env node
// Live check of card helper-sell-fee-recipient: HELPER_HOST reads SellDelegate's 11-field Sell (feeRecipient after
// feeCap, contracts/pool-evm/src/SellDelegate.sol at pool review round 3) and sends a sale only when its fee goes to the
// network's fee collector its fee answer names (card helper-sender-fee-proof: fee_collector, the FeeCollector whose Paid
// log proves the fee; apps/helper/src/pool/evm.ts sellHeld, 422 fee_recipient), without sending anything or moving
// money. For each testnet pool its deploy record names (helper-evm-sender.mjs evmPoolRecords) it reads
// GET /v1/pool/fee?pool=<pool>, then POSTs four sells made by helper-evm-sender.mjs plantsOf (a throwaway W key made at
// run time, W's authorization nonce 2^62, which no fresh W holds):
//   - "pays_collector": the sell paying the fee answer's fee_collector. It passes every static check, the 11-field
//     shape and the fee recipient included, and stops at W's nonce read: 422 auth_nonce, nothing sent;
//   - "pays_fee_recipient": the same sell paying the fee answer's fee_recipient (a withdraw's, which leaves no proof of
//     a sale's fee): 422 fee_recipient;
//   - "pays_other": the same sell paying 0x...beef: 422 fee_recipient;
//   - "pays_sell_sender": the same sell paying the fee answer's sell_sender (the helper's own sell key): 422
//     fee_recipient.
// It passes only when the fee answer is 200 with fee_collector, fee_recipient and sell_sender three different addresses
// (a network with no collector set refuses every sell, and fails here until its collector is set), fee_collector is the
// collector the kit pins for the network (evmPoolVenues() feeCollector) and that pin is the FeeCollector card
// evm-fee-collector deployed (evm-fee-collector.<network>.json, read back on two RPCs by its check; card
// helper-sender-fee-proof, review M1: a sale is counted paid by the Paid log of the helper's collector, so any other
// address would let every sale read as paid), every sell answers its own status and code with no hash, and every answer
// carries a full-sha X-Helper-Commit.
//   node scripts/live-checks/helper-sell-fee-recipient.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { BASE, evmPoolRecords, feeCollectors, feeRecipientOf, plantsOf } from "./helper-evm-sender.mjs";

/** Each sell, the status and the code it must get. */
export const SELLS = [
  ["pays_collector", 422, "auth_nonce"],
  ["pays_fee_recipient", 422, "fee_recipient"],
  ["pays_other", 422, "fee_recipient"],
  ["pays_sell_sender", 422, "fee_recipient"],
];
export const OTHER = "0x000000000000000000000000000000000000beef";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The check on one recorded run: { base, pools: [{ network, pool, reads: [{ asked, status, headers, body }] }] }. */
export function judge(run, records = evmPoolRecords(), collectors = feeCollectors()) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const want = Object.entries(records);
  const pools = run.pools ?? [];
  say(want.length > 0, `pools with a deploy record: ${show(want.map(([n]) => n))}`);
  say(pools.length === want.length && want.every(([n, pool]) => pools.some((p) => p.network === n && p.pool === pool)), `pools read: ${show(pools.map((p) => `${p.network} ${p.pool}`))}`);
  for (const p of pools) {
    const n = p.network;
    const f = p.reads.find((r) => r.asked === "fee");
    const b = json(f?.body ?? "");
    const to = feeRecipientOf(f?.body);
    const seller = typeof b?.sell_sender === "string" ? b.sell_sender.toLowerCase() : null;
    const coll = typeof b?.fee_collector === "string" ? b.fee_collector.toLowerCase() : null;
    const three = [to, seller, coll];
    say(f?.status === 200 && three.every((a) => a !== null && ADDRESS.test(a)) && new Set(three).size === 3, `[${n} fee] ${f?.status}: fee_collector ${show(b?.fee_collector)}, fee_recipient ${show(b?.fee_recipient)}, sell_sender ${show(b?.sell_sender)}, three addresses`);
    const c = Object.hasOwn(collectors, n) ? collectors[n] : undefined;
    say(coll !== null && c?.pin != null && coll === c.pin && c.pin === c.recorded, `[${n} fee] fee_collector ${show(coll)} is the kit's pin ${show(c?.pin ?? null)}, which is evm-fee-collector.${n}.json's FeeCollector ${show(c?.recorded ?? null)}`);
    for (const [asked, status, code] of SELLS) {
      const r = p.reads.find((x) => x.asked === asked);
      const e = json(r?.body ?? "");
      say(r?.status === status && e?.error?.code === code && e?.hash === undefined, `[${n} ${asked}] POST /v1/pool/evm/sell answers ${r?.status} ${r?.body?.slice(0, 160)} (want ${status} ${code})`);
    }
    for (const r of p.reads) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${n} ${r.asked}] X-Helper-Commit: ${show(r.headers?.["x-helper-commit"])}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

/** The four sells for `pool`, each paying a payee of its own: the fee answer's fee_collector, its fee_recipient,
 *  another, the sell sender. */
export function sellsOf({ network, pool, feeCollector, feeRecipient, sellSender, nowMs = Date.now() }) {
  const pays = { pays_collector: feeCollector, pays_fee_recipient: feeRecipient, pays_other: OTHER, pays_sell_sender: sellSender };
  return Object.fromEntries(SELLS.map(([asked]) => [asked, plantsOf({ network, pool, feeRecipient: pays[asked], nowMs }).base]));
}

export async function read(base, fetchFn = fetch, records = evmPoolRecords()) {
  const pools = [];
  for (const [network, pool] of Object.entries(records)) {
    const reads = [];
    const get = async (asked, url, init = {}) => {
      const r = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
      reads.push({ asked, readAt: new Date().toISOString(), status: r.status, headers: Object.fromEntries(r.headers), body: (await r.text()).slice(0, 2_000) });
    };
    await get("fee", `${base}/v1/pool/fee?pool=${encodeURIComponent(pool)}`);
    const b = json(reads[0].body);
    const addr = (v) => (typeof v === "string" && ADDRESS.test(v.toLowerCase()) ? v.toLowerCase() : OTHER);
    // built just before they are sent, so the deadlines are measured from now; a payee the answer does not name is
    // OTHER, so the judge fails on the fee answer
    const sells = sellsOf({ network, pool, feeCollector: addr(b?.fee_collector), feeRecipient: feeRecipientOf(reads[0].body) ?? OTHER, sellSender: addr(b?.sell_sender) });
    for (const [asked] of SELLS) await get(asked, `${base}/v1/pool/evm/sell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sells[asked]) });
    pools.push({ network, pool, reads });
  }
  return { base, pools };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
  try {
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS helper-sell-fee-recipient" : "FAIL helper-sell-fee-recipient");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`helper-sell-fee-recipient: ${e.message}`);
    process.exit(2);
  }
}
