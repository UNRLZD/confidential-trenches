// The mainnet run's record (scripts/pool-deposit-address-mainnet.mjs recordOf): a SUCCESS status of the device's own
// pool quote gives the record's lines; any other status, recipient, refund or tx shape is refused and nothing written.
// On 1Click's own recorded SUCCESS answer into Solana (apps/helper/src/bind/fixtures/oneclick-status.json success_sol),
// changed only where the pool quote differs from that test-money deposit.
//   node --test packages/signpage/scripts/pool-deposit-address-mainnet.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58, hex } from "@scure/base";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { onePass, POOL_RPCS, readPoolTx, recordOf, originChainOf, STATUS_URL } from "./pool-deposit-address-mainnet.mjs";
import { RPCS } from "../../../scripts/ci/money-gate.mjs";

const FIX = JSON.parse(readFileSync(new URL("../../../apps/helper/src/bind/fixtures/oneclick-status.json", import.meta.url), "utf8")).answers.success_sol;
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ORIGIN_TX = "0x" + "1a".repeat(32);
const POOL_TX = "3".repeat(87);
function good() {
  const s = structuredClone(FIX);
  const qr = s.quoteResponse.quoteRequest;
  qr.originAsset = BASE_USDC;
  qr.refundType = "INTENTS";
  qr.refundTo = hex.encode(base58.decode(qr.recipient)); // U_X's own key, as the device's pool quote asks
  s.swapDetails.originChainTxHashes = [{ hash: ORIGIN_TX, explorerUrl: "" }];
  return s;
}
const ADDR = FIX.quoteResponse.quote.depositAddress;
const DELIVERY = FIX.swapDetails.destinationChainTxHashes[0].hash;
const U = FIX.quoteResponse.quoteRequest.recipient; // the Solana U_X the device's pool.address answered
const OWN = { u: U };

test("recorded good answer: a SUCCESS of the pool quote into Solana gives the record, three txs, money path", () => {
  assert.deepEqual(recordOf("solana", ADDR, good(), POOL_TX, OWN), [
    "CARD pool-deposit-address / live: PASS", "Money path: yes", `Tx: base ${ORIGIN_TX}`, `Tx: solana ${DELIVERY}`, `Tx: solana ${POOL_TX}`,
  ]);
});

test("recorded bad answer: 1Click's own test-money deposit as recorded (refund to the origin chain, from NEAR) is refused", () => {
  assert.throws(() => recordOf("solana", ADDR, FIX, POOL_TX, OWN), /refund is not to a 64-hex id/);
});

test("refused, nothing written: another status, address, chain, recipient, refund or tx shape", () => {
  const bad = [
    [(s) => { s.status = "REFUNDED"; }, /status REFUNDED/],
    [(s) => { s.quoteResponse.quote.depositAddress = "x"; }, /another deposit address/],
    [(s) => { s.quoteResponse.quoteRequest.dry = true; }, /not a live quote/],
    [(s) => { s.quoteResponse.quoteRequest.destinationAsset = "nep141:base.omft.near"; }, /not solana's pool coin/],
    [(s) => { s.quoteResponse.quoteRequest.refundTo = "ab".repeat(32); }, /not its own key/],
    [(s) => { s.quoteResponse.quoteRequest.recipientType = "INTENTS"; }, /not on the destination chain/],
    [(s) => { s.quoteResponse.quoteRequest.originAsset = "nep141:wrap.near"; }, /not on Solana or Base/],
    [(s) => { s.swapDetails.originChainTxHashes = []; }, /one origin tx/],
    [(s) => { s.swapDetails.originChainTxHashes = [{ hash: DELIVERY }]; }, /not a base tx/],
  ];
  for (const [change, why] of bad) {
    const s = good();
    change(s);
    assert.throws(() => recordOf("solana", ADDR, s, POOL_TX, OWN), why, String(why));
  }
  assert.throws(() => recordOf("solana", ADDR, good(), "0x" + "2b".repeat(32), OWN), /pool tx/);
  assert.throws(() => recordOf("solana", ADDR, good(), DELIVERY, OWN), /a tx twice/);
  assert.throws(() => recordOf("near", ADDR, good(), POOL_TX, OWN), /no pool on near/);
  assert.equal(originChainOf("nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"), "solana");
  assert.equal(originChainOf("nep141:wrap.near"), null);
});

// ---- review F1: the record is the device's own deposit, whole, and its pool tx is U_X's deposit into the pinned pool ----
const EVM_U = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"; // an EIP-55 vector, no user's
const EVM_ID = "cd".repeat(32);
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const EVM_OWN = { u: EVM_U, refundId: EVM_ID };
function baseGood() {
  const s = structuredClone(FIX);
  const qr = s.quoteResponse.quoteRequest;
  Object.assign(qr, { originAsset: SOL_USDC, destinationAsset: "nep141:base.omft.near", recipient: EVM_U, refundType: "INTENTS", refundTo: EVM_ID });
  s.swapDetails.originChainTxHashes = [{ hash: "5".repeat(87), explorerUrl: "" }];
  s.swapDetails.destinationChainTxHashes = [{ hash: "0x" + "ab".repeat(32), explorerUrl: "" }];
  return s;
}

test("review F1: a Base record passes only for the device's own EIP-55 U_X and its U_{s,i} refund id", () => {
  assert.equal(recordOf("base", ADDR, baseGood(), "0x" + "ef".repeat(32), EVM_OWN)[0], "CARD pool-deposit-address / live: PASS");
  const bad = [
    [(s) => { s.quoteResponse.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"; }, EVM_OWN, /not the device's U_X/], // a stranger's 0x
    [(s) => { s.quoteResponse.quoteRequest.recipient = EVM_U.toLowerCase(); }, EVM_OWN, /not the device's U_X/], // not EIP-55
    [(s) => { s.quoteResponse.quoteRequest.refundTo = "ab".repeat(32); }, EVM_OWN, /not the device's U_\{s,i\}/], // a foreign refund id
    [() => {}, { u: EVM_U.toLowerCase(), refundId: EVM_ID }, /not an EIP-55 address/],
    [() => {}, { u: EVM_U }, /--refund-id/],
    [(s) => { s.quoteResponse.quoteRequest.originAsset = "nep141:base.omft.near"; }, EVM_OWN, /the pool's own coin/],
  ];
  for (const [change, own, why] of bad) {
    const s = baseGood();
    change(s);
    assert.throws(() => recordOf("base", ADDR, s, "0x" + "ef".repeat(32), own), why, String(why));
  }
});

test("review F1: on Solana a self-refunding keypair that is not the device's U_X is refused", () => {
  const s = good();
  const other = base58.encode(new Uint8Array(32).fill(7));
  s.quoteResponse.quoteRequest.recipient = other;
  s.quoteResponse.quoteRequest.refundTo = hex.encode(base58.decode(other)); // its own key, as the device asks, but not U_X
  assert.throws(() => recordOf("solana", ADDR, s, POOL_TX, OWN), /not the device's U_X/);
  assert.throws(() => recordOf("solana", ADDR, good(), POOL_TX, { u: U, refundId: "ab".repeat(32) }), /its own key/);
});

test("review F1: a SUCCESS that refunded any part, or deposited other than the quote's amount, is refused", () => {
  const most = good();
  most.swapDetails.refundedAmount = "8000000000000000000000000";
  most.swapDetails.depositedAmount = "1";
  assert.throws(() => recordOf("solana", ADDR, most, POOL_TX, OWN), /refunded/);
  const short = good();
  short.swapDetails.depositedAmount = "1";
  assert.throws(() => recordOf("solana", ADDR, short, POOL_TX, OWN), /deposited 1/);
  const none = good();
  delete none.swapDetails.refundedAmount;
  assert.throws(() => recordOf("solana", ADDR, none, POOL_TX, OWN), /refunded/);
});

test("review F1 (P3, P6): a delivery tx of another chain's shape, or two delivery txs, is refused", () => {
  const shape = good();
  shape.swapDetails.destinationChainTxHashes = [{ hash: "0x" + "ab".repeat(32), explorerUrl: "" }];
  assert.throws(() => recordOf("solana", ADDR, shape, POOL_TX, OWN), /delivery tx/);
  const two = good();
  two.swapDetails.destinationChainTxHashes = [{ hash: DELIVERY }, { hash: "4".repeat(87) }];
  assert.throws(() => recordOf("solana", ADDR, two, POOL_TX, OWN), /one delivery tx/);
});

// The pool tx's reads (review G1, G2, G3). Each RPC answers only what a public node would: on Solana getTransaction at
// finalized and null at any lower commitment (R1); on Base the finalized block, receipts and txs by hash.
const PIN = "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF";
const TWO = ["https://a.test", "https://b.test"];
const SYS = "11111111111111111111111111111111";
const OTHER = base58.encode(new Uint8Array(32).fill(7));
const SOLVER = base58.encode(new Uint8Array(32).fill(9)); // 1Click's sender of the delivery
const MIN = FIX.quoteResponse.quote.minAmountOut; // the quote's least delivery, lamports
const DEP = { poolTx: POOL_TX, delivery: DELIVERY, minOut: MIN };
const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
const solFetch = (answer, asked = []) => async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  asked.push(params?.[1]?.commitment);
  return reply(method === "getTransaction" && params?.[1]?.commitment === "finalized" ? answer(String(url), params[0]) : null);
};
// A deposit's 41 bytes (contracts/pool-solana/src/deposit.rs:7, 77-83): tag, value u64 LE, precommitment.
const dataOf = (tag, value) => {
  const d = new Uint8Array(41).fill(1, 9);
  d[0] = tag;
  new DataView(d.buffer).setBigUint64(1, value, true);
  return base58.encode(d);
};
const solPool = (o = {}) => ({
  slot: o.slot ?? 9,
  meta: { err: o.err ?? null, loadedAddresses: { writable: [], readonly: [] } },
  transaction: { message: { header: { numRequiredSignatures: o.signers ?? 1 }, accountKeys: o.keys ?? [o.signer ?? U, SYS, o.program ?? PIN],
    instructions: [{ programIdIndex: o.programIdIndex ?? 2, accounts: o.accounts ?? [1, 0, 1, 1, 1, 1], data: dataOf(o.tag ?? 1, o.value ?? 200_000_000n) }] } },
});
const solDelivery = (o = {}) => ({
  slot: o.slot ?? 7,
  meta: { err: o.err ?? null, preBalances: [5_000_000_000, 1_000, 1], postBalances: [4_000_000_000, 1_000 + (o.credit ?? Number(MIN)), 1],
    loadedAddresses: { writable: [], readonly: [] } },
  transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [SOLVER, o.to ?? U, SYS], instructions: [] } },
});
const solAnswer = (o = {}) => (url, sig) => (sig === DELIVERY ? (o.delivery ?? (() => solDelivery()))(url) : (o.pool ?? (() => solPool()))(url));
const solRead = (answer, dep = DEP) => readPoolTx("solana", dep, U, { fetch: solFetch(answer), rpcs: TWO, pin: PIN });

test("review F1, R1: the pool tx and the delivery read finalized on both RPCs as U_X's tag 1 deposit after its delivery, alike", async () => {
  const asked = [];
  await readPoolTx("solana", DEP, U, { fetch: solFetch(solAnswer(), asked), rpcs: TWO, pin: PIN });
  assert.deepEqual(asked, ["finalized", "finalized", "finalized", "finalized"]); // each RPC: the delivery, then the pool tx
  const bad = [
    [solAnswer({ pool: () => solPool({ program: "11111111111111111111111111111112" }) }), /no deposit \(tag 1\)/], // any other program's tx
    [solAnswer({ pool: () => solPool({ tag: 2 }) }), /no deposit \(tag 1\)/],
    [solAnswer({ pool: () => solPool({ signer: OTHER }) }), /not signed by U_X/],
    [solAnswer({ pool: () => solPool({ err: { InstructionError: [0, "Custom"] } }) }), /the pool tx failed or is not final/],
    [solAnswer({ pool: (url) => (url.includes("b.test") ? null : solPool()) }), /pool tx has no answer/],
    [solAnswer({ pool: (url) => solPool({ slot: url.includes("b.test") ? 10 : 9 }) }), /read the pool tx apart/],
    [solAnswer({ delivery: (url) => solDelivery({ slot: url.includes("b.test") ? 8 : 7 }) }), /read the pool tx apart/],
  ];
  for (const [answer, why] of bad) await assert.rejects(solRead(answer), why, String(why));
});

test("review R2: U_X among the tx's keys but not among its signers is refused", async () => {
  // U_X is the deposit's accounts[1], but only OTHER signs (numRequiredSignatures 1)
  const pool = () => solPool({ keys: [OTHER, U, SYS, PIN], programIdIndex: 3, accounts: [2, 1, 2, 2, 2, 2] });
  await assert.rejects(solRead(solAnswer({ pool })), /not signed by U_X/);
});

test("review G1: the pool tx is after the delivery, U_X is its depositor, and its value is a rung of the ladder", async () => {
  const bad = [
    [solAnswer({ pool: () => solPool({ slot: 5 }) }), /not after the delivery/], // an earlier deposit of U_X's
    [solAnswer({ pool: () => solPool({ slot: 7 }) }), /not after the delivery/],
    // U_X co-signs, but the deposit's depositor (accounts[1]) is OTHER
    [solAnswer({ pool: () => solPool({ keys: [U, OTHER, SYS, PIN], signers: 2, programIdIndex: 3, accounts: [2, 1, 2, 2, 2, 2] }) }), /depositor is not U_X/],
    [solAnswer({ pool: () => solPool({ value: 15_000_000n }) }), /not a rung/],
    [solAnswer({ pool: () => solPool({ value: 5_000_000n }) }), /not a rung/], // below SOL_LADDER's smallest rung
    [solAnswer({ pool: () => ({ ...solPool(), transaction: { message: { ...solPool().transaction.message, instructions: [{ programIdIndex: 2, accounts: [1, 0], data: base58.encode(Uint8Array.of(1, 0, 0)) }] } } }) }), /41 bytes/],
  ];
  for (const [answer, why] of bad) await assert.rejects(solRead(answer), why, String(why));
});

test("review G1: the delivery is final, with no error, and credits U_X at least the quote's minAmountOut", async () => {
  const bad = [
    [solAnswer({ delivery: () => solDelivery({ credit: Number(MIN) - 1 }) }), /under the quote's minAmountOut/],
    [solAnswer({ delivery: () => solDelivery({ to: OTHER }) }), /does not credit U_X/],
    [solAnswer({ delivery: () => null }), /delivery tx has no answer/], // not finalized
    [solAnswer({ delivery: () => solDelivery({ err: { InstructionError: [0, "Custom"] } }) }), /the delivery tx failed or is not final/],
  ];
  for (const [answer, why] of bad) await assert.rejects(solRead(answer), why, String(why));
  for (const minOut of ["1e9", "-1", "", "0", "01", 367921749, undefined])
    await assert.rejects(solRead(solAnswer(), { ...DEP, minOut }), /minAmountOut/, String(minOut));
});

const EVM_POOL = "0x" + "77".repeat(20);
const EVM_DELIVERY = "0x" + "ab".repeat(32);
const EVM_POOL_TX = "0x" + "ef".repeat(32);
const EVM_DEP = { poolTx: EVM_POOL_TX, delivery: EVM_DELIVERY, minOut: MIN };
const topic = `0x${hex.encode(keccak_256(new TextEncoder().encode("Deposited(address,uint256,uint256,uint256,uint256)")))}`;
const evmAnswers = (o = {}) => ({
  finalized: { number: "0x64" },
  dReceipt: { status: "0x1", blockNumber: "0x50", blockHash: "0x" + "88".repeat(32), logs: [] },
  dTx: { to: EVM_U.toLowerCase(), value: `0x${BigInt(MIN).toString(16)}`, blockNumber: "0x50" },
  pReceipt: { status: "0x1", from: EVM_U.toLowerCase(), blockNumber: "0x60", blockHash: "0x" + "99".repeat(32), logs: [{ address: EVM_POOL, topics: [topic] }] },
  ...o,
});
const evmFetch = (a, asked = []) => async (url, init) => {
  const { method, params } = JSON.parse(init.body);
  asked.push(method);
  if (method === "eth_getBlockByNumber") return reply(params[0] === "finalized" && params[1] === false ? a.finalized : null);
  if (method === "eth_getTransactionReceipt") return reply(params[0] === EVM_DELIVERY ? a.dReceipt : params[0] === EVM_POOL_TX ? a.pReceipt : null);
  if (method === "eth_getTransactionByHash") return reply(params[0] === EVM_DELIVERY ? a.dTx : null);
  return reply(null);
};
const evmRead = (a, opts = {}) => readPoolTx("base", EVM_DEP, EVM_U, { fetch: evmFetch(a), rpcs: TWO, pin: EVM_POOL, ...opts });

test("review F1, G1, G2: on Base the delivery sends U_X the quote's least, then U_X's Deposited receipt, both final; no pin, no record", async () => {
  const asked = [];
  await readPoolTx("base", EVM_DEP, EVM_U, { fetch: evmFetch(evmAnswers(), asked), rpcs: TWO, pin: EVM_POOL });
  assert.ok(asked.includes("eth_getBlockByNumber"), "the finalized block is read");
  const p = evmAnswers().pReceipt, d = evmAnswers().dReceipt, t = evmAnswers().dTx;
  const bad = [
    [{ pReceipt: { ...p, status: "0x0" } }, /pool tx did not succeed/],
    [{ pReceipt: { ...p, from: "0x" + "12".repeat(20) } }, /not sent by U_X/],
    [{ pReceipt: { ...p, logs: [{ address: "0x" + "78".repeat(20), topics: [topic] }] } }, /no Deposited log/],
    [{ pReceipt: { ...p, logs: [{ address: EVM_POOL, topics: ["0x" + "00".repeat(32)] }] } }, /no Deposited log/],
    [{ pReceipt: { ...p, blockNumber: "0x65" } }, /the pool tx is not final/], // G2: above the finalized block
    [{ dReceipt: { ...d, blockNumber: "0x65" } }, /the delivery tx is not final/],
    [{ finalized: null }, /no answer/],
    [{ dReceipt: { ...d, status: "0x0" } }, /delivery tx did not succeed/],
    [{ dTx: { ...t, to: "0x" + "12".repeat(20) } }, /does not send U_X/],
    [{ dTx: { ...t, value: `0x${(BigInt(MIN) - 1n).toString(16)}` } }, /under the quote's minAmountOut/],
    [{ pReceipt: { ...p, blockNumber: "0x50" } }, /not after the delivery/],
  ];
  for (const [o, why] of bad) await assert.rejects(evmRead(evmAnswers(o)), why, String(why));
  await assert.rejects(evmRead(evmAnswers(), { pin: undefined }), /no pool pinned on base/);
});

test("review R6: one pass writes the record only once the delivery and the pool tx read right", async () => {
  const run = async (answer, change = () => {}) => {
    const status = good();
    change(status);
    const wrote = [];
    const rpc = solFetch(answer);
    const f = async (url, init) => (String(url).startsWith(STATUS_URL) ? new Response(JSON.stringify(status), { status: 200 }) : rpc(url, init));
    const r = await onePass({ chain: "solana", address: ADDR, poolTx: POOL_TX, own: OWN, out: "record.md" }, { fetch: f, append: (p, t) => wrote.push([p, t]), rpcs: TWO, pin: PIN })
      .then((v) => v, (e) => e.message);
    return { r, wrote };
  };
  const ok = await run(solAnswer());
  assert.equal(ok.r, true);
  assert.deepEqual(ok.wrote, [["record.md", `\nCARD pool-deposit-address / live: PASS\nMoney path: yes\nTx: base ${ORIGIN_TX}\nTx: solana ${DELIVERY}\nTx: solana ${POOL_TX}\n`]]);
  const bad = [
    [solAnswer({ pool: () => solPool({ tag: 2 }) }), undefined, /no deposit/], // the pool tx read fails
    [solAnswer({ delivery: () => null }), undefined, /delivery tx has no answer/], // the delivery read fails
    [solAnswer(), (s) => { s.quoteResponse.quote.minAmountOut = String(BigInt(MIN) + 1n); }, /under the quote's minAmountOut/], // the quote's own least
  ];
  for (const [answer, change, why] of bad) {
    const { r, wrote } = await run(answer, change);
    assert.match(String(r), why);
    assert.deepEqual(wrote, [], String(why));
  }
  const pending = await run(solAnswer(), (s) => { s.status = "PROCESSING"; });
  assert.deepEqual(pending, { r: false, wrote: [] });
});

test("the pool tx's RPCs are the money gate's, so the record's reads and the gate's are one list", () => {
  for (const c of ["solana", "base", "robinhood"]) assert.deepEqual(POOL_RPCS[c], RPCS[c], c);
});
