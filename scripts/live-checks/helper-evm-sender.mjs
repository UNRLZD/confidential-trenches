#!/usr/bin/env node
// Live check of card helper-evm-sender: HELPER_HOST names its EVM pool sender in each testnet pool's fee answer and
// refuses a planted bad sell on POST /v1/pool/evm/sell without reading a provider or sending anything
// (apps/helper/src/pool/evm.ts sellHeld). The pools are the ones pool-evm-deploy's records name
// (pool-evm-deploy.<network>.json, PrivacyPoolSimple); a network with no record has no pool to check.
// For each pool it reads GET /v1/pool/fee?pool=<pool>, then POSTs nine sells it builds with a throwaway W key made at
// run time, each good but for one field. The sell they are made from passes every static check: W's Sell signed over
// SellDelegate's digest, W's authorization of the kit's pinned sell delegate (evmPoolSignSellAuthorization), a swap the
// kit's sell builder makes (one v4 hop through the PoolManager, read back by evmSellRouteOf), the pool the record
// names, the fee answer's fee_collector as the Sell's feeRecipient (card helper-sell-fee-recipient: the 11-field Sell
// of SellDelegate at pool-review-3; card helper-sender-fee-proof: the network's FeeCollector, whose Paid log proves the
// fee), fee <= feeCap < minOut, a deadline 300 s away. Its authorization nonce is 2^62, which no fresh W
// holds, so a helper that skipped a static check still stops at auth_nonce, before any send.
//   - "auth_chain_zero": the authorization signed with chainId 0 (bad_authorization);
//   - "auth_other_delegate": the authorization of another delegate (bad_authorization);
//   - "sell_other_signer": the Sell signed by another throwaway key (bad_signature);
//   - "deadline_in_ms": the deadline written in milliseconds (deadline_far);
//   - "deadline_near": the deadline 59 s away (deadline_near: the helper sends only 60 s or more before it);
//   - "sell_other_pool": the Sell's pool another address (not_pool);
//   - "fee_over_cap": the fee one wei over the Sell's feeCap (fee_over_cap);
//   - "trailing_byte": the calldata and one byte more (400 bad_shape);
//   - "route_other_target": the swap's target 0x...dead, neither the PoolManager nor a listed router (bad_route).
// It passes only when:
//   - the fee answers 200 with exactly EvmFeeAnswer's fields, chain "evm", the network and pool asked, a sell_sender (an
//     address, or null where no sell key is set), a fee recipient address and a fee collector address (null where none
//     is set, which refuses every sell, so the plants fail here until it is set), a 60 s epoch on its grid, a block, a fee in wei and the 10^13 step; and where the kit pins a
//     sell sender for the network (evmPoolVenues() sellSender), the sender is that pin (the device sims each sale from
//     it, so a sale from any other key runs where the sim did not);
//   - every plant answers its own status and code (PLANTS), so none was sent;
//   - every answer carries a full-sha X-Helper-Commit;
//   - each testnet has a run of contracts/pool-evm/script/testnet-run.mjs --sell-helper through this helper
//     (helper-evm-sender.run.<network>.json), whole on both of its chain's RPCs (pool-evm-testnet-run's check), and
//     each sell the helper sent was sent by the fee answer's sell_sender, with gas limit 1,000,000, W's authorization of
//     the pinned delegate on the chain's id, and a fee at least its cost (paid to the caller by the SellDelegate these
//     runs used; pool-review-3's pays it to the Sell's feeRecipient, the fee answer's fee_recipient).
// After: helper
//   node scripts/live-checks/helper-evm-sender.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolSignSellAuthorization, evmPoolVenues, evmSellRouteOf } from "../../packages/kit/src/index.ts";
import { recorder as runRecorder } from "./notes-per-pool-evm.mjs";
import { poolRecordName } from "./pool-evm-deploy.mjs";
import { check as runCheck, RPCS as RUN_RPCS } from "./pool-evm-testnet-run.mjs";

// @noble from the helper's own dependencies (apps/ is outside Blindfill), for W's keys, its signatures and the digests
const req = createRequire(new URL("../../apps/helper/package.json", import.meta.url));
const { secp256k1 } = req("@noble/curves/secp256k1.js");
const { keccak_256 } = req("@noble/hashes/sha3.js");

export const BASE = "https://ct-api.unrealized.trade";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The EVM testnets a pool is deployed on, each with its deploy record. */
export const NETWORKS = ["base-sepolia", "robinhood-testnet"];
/** The record naming a network's current pool in `dir`: its newest pool set's (pool-evm-deploy.mjs poolRecordName). */
export const poolRecord = (network, dir = HERE) => poolRecordName(network, dir);
/** The first set's record of a network (card pool-evm-deploy's), before any pool redeploy. */
export const FIRST_SET = (network) => `pool-evm-deploy.${network}.json`;
/** The fee answer's field naming the helper's sell sender: an address, or null where no sell key is set */
export const SENDER_FIELD = "sell_sender";
/** EvmFeeAnswer's fields (apps/helper/src/pool/evm.ts). */
export const FIELDS = ["chain", "network", "pool", "fee_recipient", SENDER_FIELD, "fee_collector", "epoch_ms", "epoch_start_ms", "block", "fee", "step"];
/** Each plant, the status and the code it must get. */
export const PLANTS = [
  ["auth_chain_zero", 422, "bad_authorization"],
  ["auth_other_delegate", 422, "bad_authorization"],
  ["sell_other_signer", 422, "bad_signature"],
  ["deadline_in_ms", 422, "deadline_far"],
  ["deadline_near", 422, "deadline_near"],
  ["sell_other_pool", 422, "not_pool"],
  ["fee_over_cap", 422, "fee_over_cap"],
  ["trailing_byte", 400, "bad_shape"],
  ["route_other_target", 422, "bad_route"],
];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
const DEC = /^(0|[1-9][0-9]{0,77})$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const show = (v) => (v === undefined ? "none" : JSON.stringify(v));
const json = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The pool each network's deploy record names, for the networks with a record (`nameOf`: its current pool set's,
 * poolRecord; FIRST_SET: the first set's, which the helper checks' recordings of 6 Nov were made on). Throws on a bad
 * record. */
export function evmPoolRecords(dir = HERE, nameOf = poolRecord) {
  const out = {};
  for (const network of NETWORKS) {
    const file = path.join(dir, nameOf(network, dir));
    if (!existsSync(file)) continue;
    const rec = json(readFileSync(file, "utf8"));
    if (rec?.chain !== network) throw new Error(`${nameOf(network, dir)} names chain ${rec?.chain}, not ${network}`);
    const pool = rec.contracts?.PrivacyPoolSimple?.address;
    if (typeof pool !== "string" || !ADDRESS.test(pool)) throw new Error(`${nameOf(network, dir)} names no PrivacyPoolSimple address`);
    out[network] = pool;
  }
  return out;
}

/** card evm-fee-collector's deploy record of a network's FeeCollector (its address and sink, read back on two RPCs by
 *  that card's check). */
export const collectorRecord = (network, dir = HERE) => path.join(dir, `evm-fee-collector.${network}.json`);
/**
 * Each testnet's fee collector, as the kit pins it (evmPoolVenues() feeCollector, null where it pins none) and as
 * evm-fee-collector.<network>.json records it (its FeeCollector's address and sink, null where there is no record):
 * { network: { pin, recorded, sink } }, every address in lower case. Card helper-sender-fee-proof (review M1): a sale is
 * counted paid by the Paid log of the collector the helper is set with, so the checks hold the fee answer's collector
 * to the pin, and the pin to the deployed collector's record.
 */
export function feeCollectors({ networks = NETWORKS, venues = evmPoolVenues(), dir = HERE } = {}) {
  const lower = (v) => (typeof v === "string" ? v.toLowerCase() : null);
  return Object.fromEntries(networks.map((n) => {
    const v = Object.hasOwn(venues, n) ? venues[n] : undefined;
    const pin = v !== undefined && Object.hasOwn(v, "feeCollector") ? lower(v.feeCollector) : null;
    const file = collectorRecord(n, dir);
    const rec = existsSync(file) ? json(readFileSync(file, "utf8")) : undefined;
    const ok = rec?.chain === n;
    return [n, { pin, recorded: ok ? lower(rec.contracts?.FeeCollector?.address) : null, sink: ok ? lower(rec.contracts?.FeeCollector?.sink) : null }];
  }));
}

/** The check on one recorded run: { base, pools: [{ network, pool, reads: [{ asked, status, headers, body }] }] }. */
export function judge(run, { records = evmPoolRecords(), venues = evmPoolVenues() } = {}) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const want = Object.entries(records);
  const pools = run.pools ?? [];
  say(want.length > 0, `pools with a deploy record: ${show(want.map(([n]) => n))}`);
  say(pools.length === want.length && want.every(([n, pool]) => pools.some((p) => p.network === n && p.pool === pool)), `pools read: ${show(pools.map((p) => `${p.network} ${p.pool}`))}, want ${show(want.map(([n, p]) => `${n} ${p}`))}`);
  for (const p of pools) {
    const n = p.network;
    const f = p.reads.find((r) => r.asked === "fee");
    say(f?.status === 200, `[${n} fee] GET /v1/pool/fee answers ${f?.status}`);
    const b = json(f?.body ?? "");
    const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : [];
    say(keys.length === FIELDS.length && FIELDS.every((k) => keys.includes(k)), `[${n} fee] fields: ${show(keys)}`);
    say(b?.chain === "evm" && b?.network === n && b?.pool === p.pool, `[${n} fee] chain ${show(b?.chain)}, network ${show(b?.network)}, pool ${show(b?.pool)} (asked ${p.pool})`);
    const v = Object.hasOwn(venues, n) ? venues[n] : undefined;
    const pin = v !== undefined && Object.hasOwn(v, "sellSender") ? v.sellSender : undefined;
    // the sell sender: an address, or null where the helper holds no sell key (every sale then answers 503); where the
    // kit pins one, exactly the pin, since the device sims each sale from it
    const sender = b?.[SENDER_FIELD];
    const isAddress = typeof sender === "string" && ADDRESS.test(sender);
    say((sender === null || isAddress) && (pin === undefined || (isAddress && pin.toLowerCase() === sender)), `[${n} fee] ${SENDER_FIELD} ${show(sender)}, ${pin === undefined ? "the kit pins none for this network" : `the kit's pin ${pin}`}`);
    say(typeof b?.fee_recipient === "string" && ADDRESS.test(b.fee_recipient), `[${n} fee] fee recipient ${show(b?.fee_recipient)}`);
    // the fee collector: the kit's pin for the network (card helper-sender-fee-proof, review M1), which the helper is
    // held to at its start; any other address would let a sale read as paid with no fee
    const cpin = v !== undefined && Object.hasOwn(v, "feeCollector") ? v.feeCollector.toLowerCase() : undefined;
    say(typeof b?.fee_collector === "string" && ADDRESS.test(b.fee_collector) && b.fee_collector !== b.pool && b.fee_collector !== sender && cpin !== undefined && b.fee_collector === cpin, `[${n} fee] fee collector ${show(b?.fee_collector)}, not the pool or the sell sender, ${cpin === undefined ? "but the kit pins none for this network" : `the kit's pin ${cpin}`}`);
    say(b?.epoch_ms === 60_000 && Number.isSafeInteger(b?.epoch_start_ms) && b.epoch_start_ms > 0 && b.epoch_start_ms % 60_000 === 0, `[${n} fee] epoch ${show(b?.epoch_ms)} ms from ${show(b?.epoch_start_ms)}`);
    say(typeof b?.block === "string" && QUANTITY.test(b.block) && typeof b?.fee === "string" && DEC.test(b.fee) && b.fee !== "0" && b?.step === "10000000000000", `[${n} fee] block ${show(b?.block)}, fee ${show(b?.fee)} wei on its step ${show(b?.step)}`);
    for (const [asked, status, code] of PLANTS) {
      const r = p.reads.find((x) => x.asked === asked);
      const e = json(r?.body ?? "");
      say(r?.status === status && e?.error?.code === code && e?.hash === undefined, `[${n} ${asked}] POST /v1/pool/evm/sell answers ${r?.status} ${r?.body?.slice(0, 120)} (want ${status} ${code})`);
    }
    for (const r of p.reads) say(SHA.test(r.headers?.["x-helper-commit"] ?? ""), `[${n} ${r.asked}] X-Helper-Commit: ${show(r.headers?.["x-helper-commit"])}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The planted sells ----

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));
const w32 = (n) => n.toString(16).padStart(64, "0");
const a32 = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...p) => Uint8Array.from(p.flatMap((x) => [...x]));
const k = (t) => keccak_256(utf8(t));
const SELL_SELECTOR = hex(k("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,address,uint256,uint256),uint256,bytes)").subarray(0, 4));

/** A throwaway secp256k1 key, made here and never written anywhere. */
export const randomKey = () => secp256k1.utils.randomSecretKey();
const addressOf = (key) => `0x${hex(keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12))}`;

/** SellDelegate._sellDigest (contracts/pool-evm/src/SellDelegate.sol): domain Blindfill, 1, the chain id, W. */
function sellDigest(s, chainId) {
  const domain = keccak_256(cat(k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("Blindfill"), k("1"), unhex(w32(chainId)), unhex(a32(s.w))));
  const type = k("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)");
  const struct = keccak_256(cat(type, unhex(a32(s.token)), unhex(w32(s.amount)), unhex(a32(s.target)), keccak_256(unhex(s.data)), unhex(w32(s.minOut)), unhex(a32(s.pool)), unhex(w32(s.precommitment)), unhex(w32(s.feeCap)), unhex(a32(s.feeRecipient)), unhex(w32(s.deadline)), unhex(w32(s.nonce))));
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}
/** r ‖ s ‖ v, s low, v 27 or 28, as SellDelegate reads it. */
function sign65(key, digest) {
  const rec = secp256k1.sign(digest, key, { prehash: false, lowS: true, format: "recovered" });
  return cat(rec.subarray(1, 65), Uint8Array.of(27 + rec[0]));
}
/** sell(Sell, fee, signature) in its one canonical ABI encoding, as solc's abi.encode writes it. */
function sellData(s, fee, sig) {
  const d = unhex(s.data);
  const pad = (b) => hex(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
  const tuple = `${a32(s.token)}${w32(s.amount)}${a32(s.target)}${w32(0x160n)}${w32(s.minOut)}${a32(s.pool)}${w32(s.precommitment)}${w32(s.feeCap)}${a32(s.feeRecipient)}${w32(s.deadline)}${w32(s.nonce)}${w32(BigInt(d.length))}${pad(d)}`;
  return `0x${SELL_SELECTOR}${w32(0x60n)}${w32(fee)}${w32(BigInt(0x60 + tuple.length / 2))}${tuple}${w32(65n)}${pad(sig)}`;
}
const int = (n) => (n === 0n ? new Uint8Array() : unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0")));
const rlpShort = (items) => {
  const body = cat(...items.map((x) => (x.length === 1 && x[0] < 0x80 ? x : cat(Uint8Array.of(0x80 + x.length), x))));
  return cat(Uint8Array.of(0xc0 + body.length), body);
};
/** An EIP-7702 authorization of `address` at `nonce` on `chainId`, signed by `key`, in the route's JSON form. */
function authOf(key, chainId, address, nonce) {
  const rec = secp256k1.sign(keccak_256(cat(Uint8Array.of(5), rlpShort([int(chainId), unhex(address), int(nonce)]))), key, { prehash: false, lowS: true, format: "recovered" });
  return { chainId: `0x${chainId.toString(16)}`, address, nonce: `0x${nonce.toString(16)}`, yParity: `0x${rec[0].toString(16)}`, r: `0x${hex(rec.subarray(1, 33))}`, s: `0x${hex(rec.subarray(33, 65))}` };
}

/** W's authorization nonce in every plant: under 2^64 - 1, so it passes the static check, and far over any fresh W's. */
export const AUTH_NONCE = 1n << 62n;
const OTHER_ADDRESS = "0x000000000000000000000000000000000000dead";
/** One v4 hop to the native coin, fee 3000, tick spacing 60, no hook, as abi.encode(PathKey[]) writes it: the swap data
 *  the kit's sell builder makes for that route through the PoolManager. */
const ZERO = "0x0000000000000000000000000000000000000000";
/** The same hop through the pool behind `hooks` (card evm-sell-hook-converge: a hook no venue lists). */
export const v4PathThrough = (hooks) => `0x${w32(0x20n)}${w32(1n)}${w32(0x20n)}${a32(ZERO)}${w32(3000n)}${w32(60n)}${a32(hooks)}${w32(0xa0n)}${w32(0n)}`;
const V4_NATIVE_PATH = v4PathThrough(ZERO);

/**
 * The base sell for `pool` on `network` at `nowMs`, paying its fee to `feeRecipient` (the fee answer's fee_recipient),
 * and each plant made from it, as POST /v1/pool/evm/sell bodies. W and the other signer are throwaway keys made here
 * unless given; `wKey` is returned for the test only. `data`: the swap's data (the hookless hop by default).
 */
export function plantsOf({ network, pool, feeRecipient, nowMs = Date.now(), wKey = randomKey(), otherKey = randomKey(), data = V4_NATIVE_PATH }) {
  const v = evmPoolVenues()[network];
  if (!v?.sellDelegate || !v.poolManager) throw new Error(`the kit pins no sell delegate or PoolManager for ${network}`);
  if (typeof feeRecipient !== "string" || !ADDRESS.test(feeRecipient)) throw new Error(`the fee recipient ${show(feeRecipient)} is no address`);
  const chainId = BigInt(v.chainId);
  const w = addressOf(wKey);
  const nowS = BigInt(Math.floor(nowMs / 1000));
  const sell = {
    w,
    token: "0x0000000000000000000000000000000000007070", // no static check reads it, and W holds none of it
    amount: 10n ** 18n,
    target: v.poolManager.toLowerCase(),
    data,
    minOut: 10n ** 15n,
    pool,
    precommitment: 12_345n,
    feeCap: 3n * 10n ** 13n,
    feeRecipient,
    deadline: nowS + 300n,
    nonce: 0n,
  };
  // the swap is one the kit's sell builder makes, so the route check passes and every plant gets its own code
  evmSellRouteOf(network, { w, token: sell.token, amount: sell.amount, minOut: sell.minOut, target: sell.target, data: sell.data });
  const fee = sell.feeCap;
  const a = evmPoolSignSellAuthorization(wKey, network, AUTH_NONCE);
  const auth = { chainId: `0x${a.chainId.toString(16)}`, address: a.address, nonce: `0x${a.nonce.toString(16)}`, yParity: `0x${a.yParity.toString(16)}`, r: a.r, s: a.s };
  const bodyOf = ({ s = sell, f = fee, signer = wKey, authorization = auth } = {}) => ({ pool, w, data: sellData(s, f, sign65(signer, sellDigest(s, chainId))), authorization });
  const base = bodyOf();
  const plants = {
    auth_chain_zero: bodyOf({ authorization: authOf(wKey, 0n, a.address, AUTH_NONCE) }),
    auth_other_delegate: bodyOf({ authorization: authOf(wKey, chainId, OTHER_ADDRESS, AUTH_NONCE) }),
    sell_other_signer: bodyOf({ signer: otherKey }),
    deadline_in_ms: bodyOf({ s: { ...sell, deadline: BigInt(nowMs) + 300_000n } }),
    deadline_near: bodyOf({ s: { ...sell, deadline: nowS + 59n } }),
    sell_other_pool: bodyOf({ s: { ...sell, pool: "0x000000000000000000000000000000000000beef" } }),
    fee_over_cap: bodyOf({ f: sell.feeCap + 1n }),
    trailing_byte: { ...base, data: `${base.data}00` },
    route_other_target: bodyOf({ s: { ...sell, target: OTHER_ADDRESS } }),
  };
  return { base, plants, wKey };
}

// ---- The sells the helper sent (a run of contracts/pool-evm/script/testnet-run.mjs --sell-helper) ----

/** Each testnet's run through the deployed helper: helper-evm-sender.run.<network>.json, testnet-run.mjs --out */
export const sellRunFile = (network, dir = HERE) => path.join(dir, `helper-evm-sender.run.${network}.json`);
/** The gas limit the helper signs every sale with, the kit's EVM_POOL_SELL_GAS */
export const SELL_GAS = 1_000_000n;

/**
 * The runs' sells through the helper, each read back on both RPCs of its chain: pool-evm-testnet-run's check of the
 * whole run (every transaction landed on both, each sell a type-4 transaction to W whose one authorization names the
 * chain's pinned SellDelegate with the chain's id, W's Deposited into the pool), and for each sell the helper sent:
 * the sender is the helper's sell sender (`senders[network]`, its fee answer's sell_sender), the gas limit exactly
 * 1,000,000, the authorization's signer W, and the fee it took (the call's fee word: the SellDelegate these runs used paid
 * it to its caller, pool-review-3's pays it to the Sell's feeRecipient) at least the sale's cost (gasUsed x
 * effectiveGasPrice, plus the receipt's L1 fee on Base); and every testnet has one such sell.
 */
export async function checkSells(runs, transportOf, senders) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  // the networks with a sell the helper sent whose run and own reads were all ok on both RPCs (a record lists only the
  // rows that landed, testnet-run.mjs, so its rows carry no landed field: landing is what these reads show)
  const readBack = new Set();
  for (const run of runs) {
    const rec = run.record;
    const n = rec.chain;
    const transport = transportOf(run);
    const urls = run.urls ?? RUN_RPCS[n];
    const r = await runCheck(rec, transport, urls);
    for (const l of r.lines) say(r.ok, `[${n} run] ${l}`);
    if (!r.ok) continue;
    for (const t of rec.txs.filter((x) => x.kind === "sell" && x.via === "helper")) {
      const before = lines.length;
      // the fields read here, equal on both RPCs (one Robinhood RPC adds blockTimestamp to a transaction, the other not)
      const both = async (method, params, fields) => {
        const rs = await Promise.all(urls.map((u) => transport(u, method, params)));
        if (rs.some((x) => "error" in x || x.result == null)) throw new Error(`${method} ${t.hash}: ${show(rs.map((x) => x.error ?? null))}`);
        const [a, b] = rs.map((x) => JSON.stringify(fields.map((f) => x.result[f] ?? null)));
        if (a !== b) throw new Error(`${method} ${t.hash}: the two RPCs answer ${a} and ${b}`);
        return rs[0].result;
      };
      try {
        const tx = await both("eth_getTransactionByHash", [t.hash], ["hash", "blockHash", "type", "from", "to", "gas", "input", "authorizationList"]);
        const rc = await both("eth_getTransactionReceipt", [t.hash], ["transactionHash", "blockHash", "status", "gasUsed", "effectiveGasPrice", "l1Fee"]);
        const from = String(tx.from).toLowerCase();
        say(senders[n] != null && from === senders[n], `[${n} sell ${t.hash}] sent by ${from}, the helper's sell sender ${show(senders[n])}`);
        say(BigInt(tx.gas) === SELL_GAS, `[${n} sell ${t.hash}] gas limit ${BigInt(tx.gas)}, want ${SELL_GAS}`);
        const a = (tx.authorizationList ?? [])[0];
        const items = cat(rlpShort([int(BigInt(a.chainId)), unhex(a.address), int(BigInt(a.nonce))]));
        const digest = keccak_256(cat(Uint8Array.of(5), items));
        const sig = Uint8Array.from([Number(BigInt(a.yParity ?? a.v)), ...unhex(w32(BigInt(a.r))), ...unhex(w32(BigInt(a.s)))]);
        const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(sig, digest, { prehash: false })).toBytes(false);
        const signer = `0x${hex(keccak_256(pub.subarray(1)).subarray(12))}`;
        say(signer === String(t.w).toLowerCase(), `[${n} sell ${t.hash}] the authorization is signed by ${signer}, W ${t.w}`);
        const fee = BigInt(`0x${String(tx.input).slice(10 + 64, 10 + 128)}`);
        const cost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + (rc.l1Fee ? BigInt(rc.l1Fee) : 0n);
        say(fee >= cost, `[${n} sell ${t.hash}] the fee ${fee} covers the cost ${cost}, by ${fee - cost}`);
      } catch (e) {
        say(false, `[${n} sell ${t.hash}] ${e.message}`);
      }
      if (lines.slice(before).every((l) => l.startsWith("ok "))) readBack.add(n);
    }
  }
  for (const n of NETWORKS) {
    say(readBack.has(n), `[${n}] a sell the helper sent, read back (${path.basename(sellRunFile(n))})`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ---- The reads ----

/** The fee recipient a fee answer's body names, lowercase, or null where it names no address */
/** The fee answer's fee_collector, the address every Sell must pay (card helper-sender-fee-proof), or null. */
export const feeCollectorOf = (body) => {
  const b = json(body ?? "");
  const a = typeof b?.fee_collector === "string" ? b.fee_collector.toLowerCase() : null;
  return a !== null && ADDRESS.test(a) ? a : null;
};

export const feeRecipientOf = (body) => {
  const b = json(body ?? "");
  const a = typeof b?.fee_recipient === "string" ? b.fee_recipient.toLowerCase() : null;
  return a !== null && ADDRESS.test(a) ? a : null;
};

/** Each network's sell sender from its fee answer in `run` (null where the answer names none) */
export function sendersOf(run) {
  const out = {};
  for (const p of run.pools ?? []) {
    const b = json(p.reads.find((r) => r.asked === "fee")?.body ?? "");
    const a = typeof b?.[SENDER_FIELD] === "string" ? b[SENDER_FIELD].toLowerCase() : null;
    out[p.network] = a !== null && ADDRESS.test(a) ? a : null;
  }
  return out;
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
    // the plants are built just before they are sent, so the deadlines are measured from now; each pays the fee
    // collector the fee answer names (none named: another address, so the judge fails on the fee answer)
    const { plants } = plantsOf({ network, pool, feeRecipient: feeCollectorOf(reads[0].body) ?? OTHER_ADDRESS });
    for (const [asked] of PLANTS) await get(asked, `${base}/v1/pool/evm/sell`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plants[asked]) });
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
    const r = judge(run);
    // the sells the helper sent, each run's chain reads recorded with it
    const runs = NETWORKS.filter((n) => existsSync(sellRunFile(n))).map((n) => ({ record: JSON.parse(readFileSync(sellRunFile(n), "utf8")), rec: runRecorder() }));
    const s = await checkSells(runs, (x) => x.rec.transport, sendersOf(run));
    run.sells = runs.map((x) => ({ record: x.record, urls: RUN_RPCS[x.record.chain], log: x.rec.log }));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    for (const l of [...r.lines, ...s.lines]) console.log(l);
    const ok = r.ok && s.ok;
    console.log(ok ? "PASS helper-evm-sender" : "FAIL helper-evm-sender");
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`helper-evm-sender: ${e.message}`);
    process.exit(2);
  }
}
