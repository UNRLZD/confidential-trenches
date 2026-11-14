// node --test packages/signpage/test/carry-cash-evm.test.ts (card leftovers-carry-to-cash): a Base or Robinhood wallet's
// leftover goes, whole less the send's fee bound, to Cash's deposit address in one checked plain transfer, recorded
// before it leaves, read on both RPCs after; never sent twice. Keys from the published all-zero vector
// (packages/wallet/test/vectors/a8.json) only; the RPCs are fakes. Red at 072ba8367: no carry-cash-evm.ts and no
// checkEvmCashCarry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { depositIdEvm, freshWallet } from "../../wallet/src/derive/keys.ts";
import { EVM_CHAIN_IDS } from "../../wallet/src/pool/evm.ts";
import { evmCashCarrySender } from "../src/carry-cash-evm.ts";
import { checkEvmCashCarry, evmOnwardSendDigest, PoolRuleRefused, signEvmOnwardSend, type EvmOnwardSend } from "../src/rules/pool.ts";
import { EVM_DEPOSIT_PRIORITY_CAP } from "../src/pool-deposit-evm.ts";
import type { CarryOpen, CarrySource } from "../src/carry-cash.ts";

const SEED = () => wordsToSeed64(entropyToWords(new Uint8Array(16)));
const UX = depositIdEvm(SEED(), 7n, 2);
UX.secretKey.fill(0);
const W = freshWallet(SEED(), "evm", 3n, 1);
W.secretKey.fill(0);
const SRC_UX: CarrySource = { chain: "robinhood", kind: "ux", address: UX.address, s: "7", i: 2 };
const SRC_W: CarrySource = { chain: "base", kind: "w", address: W.address, l: "3", j: 1 };
const TO = "0x" + "9a".repeat(20);
const CAP = EVM_DEPOSIT_PRIORITY_CAP;
const q = (v: bigint) => "0x" + v.toString(16);
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const hashOf = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const H = "0x" + "ee".repeat(32);

type Receipt = { transactionHash: string; status: string; blockNumber: string; blockHash: string } | null;
function rpc(o: { balance?: [bigint, bigint]; nonces?: [bigint, bigint]; pending?: [bigint, bigint]; nonceAt?: [bigint, bigint]; estimate?: [bigint, bigint]; baseFee?: bigint; l1?: bigint; simFail?: [boolean, boolean]; receipts?: [Receipt, Receipt]; block?: bigint; fin?: bigint } = {}) {
  const c = { balance: [994_100_000_000_000n, 994_100_000_000_000n], nonces: [5n, 5n], estimate: [21_000n, 21_000n], baseFee: 10_000_000n, l1: 0n, simFail: [false, false], receipts: [null, null] as [Receipt, Receipt], block: 100n, fin: 90n, ...o };
  const pending = o.pending ?? c.nonces;
  const nonceAt = o.nonceAt ?? c.nonces;
  const sent: string[][] = [[], []];
  const calls: string[] = [];
  const make = (k: 0 | 1) => async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const p = params as unknown[];
    calls.push(method);
    switch (method) {
      case "eth_getBlockByNumber": {
        const n = p[0] === "latest" ? c.block : p[0] === "finalized" ? c.fin : BigInt(p[0] as string);
        return { number: q(n), hash: hashOf(n), timestamp: "0x1", baseFeePerGas: q(c.baseFee) };
      }
      case "eth_getTransactionCount":
        if (typeof p[1] === "object" && p[1] !== null) return q(nonceAt[k]!);
        return q(p[1] === "pending" ? pending[k]! : c.nonces[k]!);
      case "eth_getBalance":
        return q(c.balance[k]!);
      case "eth_estimateGas":
        return q(c.estimate[k]!);
      case "eth_call": {
        const call = p[0] as { from?: string; data?: string };
        if (call.from !== undefined) {
          if (c.simFail[k]) throw new Error("execution reverted");
          return "0x";
        }
        // Base's GasPriceOracle: getL1FeeUpperBound, then the operator fee (0)
        return "0x" + word(String(call.data).startsWith("0xf1c7a58b") ? c.l1 : 0n);
      }
      case "eth_sendRawTransaction":
        return void sent[k]!.push(p[0] as string);
      case "eth_getTransactionReceipt":
        return c.receipts[k];
    }
    throw new Error(`unmocked ${method}`);
  };
  return { rpcs: [make(0), make(1)] as const, sent, calls };
}
const OPEN = (amount: bigint): CarryOpen => ({ to: TO, amount: amount.toString(), quote: "carry/robinhood/ab", quotedMs: "1", sends: [] });
const sender = (r: ReturnType<typeof rpc>, chain: "base" | "robinhood") => evmCashCarrySender({ chain, network: chain, rpcs: r.rpcs, seed64: async () => SEED(), now: () => 5 });

// RLP decode, enough for a type 2 tx: a list of byte strings and one empty list
function rlpItems(b: Uint8Array): Uint8Array[] {
  const len = (o: number, n: number) => b.slice(o, o + n).reduce((a, x) => a * 256 + x, 0);
  let at = 0;
  const h = b[at]!;
  at += h <= 0xf7 ? 1 : 1 + (h - 0xf7);
  const out: Uint8Array[] = [];
  while (at < b.length) {
    const x = b[at]!;
    if (x < 0x80) (out.push(b.slice(at, at + 1)), (at += 1));
    else if (x <= 0xb7) (out.push(b.slice(at + 1, at + 1 + x - 0x80)), (at += 1 + x - 0x80));
    else if (x <= 0xbf) {
      const l = len(at + 1, x - 0xb7);
      out.push(b.slice(at + 1 + x - 0xb7, at + 1 + x - 0xb7 + l));
      at += 1 + x - 0xb7 + l;
    } else if (x <= 0xf7) (out.push(new Uint8Array(0)), (at += 1 + x - 0xc0));
    else throw new Error("long list");
  }
  return out;
}
const big = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
const hexOf = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const addressOf = (pub: Uint8Array): string => hexOf(keccak_256(pub.slice(1)).slice(12));
/** The raw tx's fields and the address its signature recovers to. */
function decoded(raw: string) {
  const b = Uint8Array.from(Buffer.from(raw.slice(2), "hex"));
  assert.equal(b[0], 2, "a type 2 tx");
  const f = rlpItems(b.slice(1));
  assert.equal(f.length, 12);
  const tx: EvmOnwardSend = { type: 2, chainId: big(f[0]!), nonce: big(f[1]!), maxPriorityFeePerGas: big(f[2]!), maxFeePerGas: big(f[3]!), gasLimit: big(f[4]!), to: hexOf(f[5]!), value: big(f[6]!), data: hexOf(f[7]!), accessList: [] };
  assert.equal(f[8]!.length, 0, "no access list");
  const sig = new secp256k1.Signature(big(f[10]!), big(f[11]!)).addRecoveryBit(Number(big(f[9]!)));
  return { tx, signer: addressOf(sig.recoverPublicKey(evmOnwardSendDigest(tx)).toBytes(false)), hash: hexOf(keccak_256(b)) };
}

test("(a) the owner's case: a Robinhood U_X holding 994100000000000 wei sends one type 2 plain transfer of the amount to the deposit address, signed by U_X, recorded before it leaves", async () => {
  // Robinhood (Nitro) estimates a plain send at 21,235 (eth_estimateGas on rpc.mainnet.chain.robinhood.com and
  // rpc-robinhood.globalstake.io, both 0x52f3, 2026-11-14 02:03Z)
  const r = rpc({ estimate: [21_235n, 21_235n] });
  const kept: CarryOpen[] = [];
  const s = sender(r, "robinhood");
  const maxFee = 2n * 10_000_000n + CAP;
  // the bound sendable takes: the estimate and a fifth, at 2 x base fee + the tip cap; no L1 fee on Nitro
  const amount = await s.sendable(SRC_UX);
  assert.equal(amount, 994_100_000_000_000n - (21_235n + 21_235n / 5n) * maxFee);
  r.calls.length = 0;
  assert.equal(await s.send(SRC_UX, OPEN(amount!), async (o) => void (kept.push(o), r.calls.push("keep"))), "pending");
  assert.equal(kept.length, 1);
  assert.deepEqual(r.sent.map((x) => x.length), [1, 1], "the one raw tx to both RPCs");
  assert.equal(r.sent[0]![0], r.sent[1]![0]);
  const d = decoded(r.sent[0]![0]!);
  assert.equal(d.tx.chainId, EVM_CHAIN_IDS.robinhood);
  assert.equal(d.tx.to, TO);
  assert.equal(d.tx.value, amount);
  assert.equal(d.tx.data, "0x");
  assert.equal(d.tx.gasLimit, 21_235n, "Nitro: the agreed estimate");
  assert.equal(d.tx.nonce, 5n);
  assert.equal(d.tx.maxFeePerGas, maxFee);
  assert.equal(d.tx.maxPriorityFeePerGas, CAP);
  assert.equal(d.signer, UX.address.toLowerCase(), "U_X signed it");
  assert.deepEqual(kept[0]!.sends, [{ hash: d.hash, value: amount!.toString(), sentMs: "5", nonce: "5" }]);
  // the record is written before the raw tx leaves
  const at = r.calls.indexOf("keep");
  assert.ok(at >= 0 && at < r.calls.indexOf("eth_sendRawTransaction"), r.calls.join());
  assert.ok(r.calls.indexOf("eth_call") < at, "simulated before");
});

test("(b) a W (kind w) on Base signs with W's own key: gas 21,000, the L1 fee bound held", async () => {
  const r = rpc({ baseFee: 5_000_000n, l1: 7_000_000_000n, balance: [3_000_000_000_000_000n, 3_000_000_000_100_000n] });
  const s = sender(r, "base");
  const amount = await s.sendable(SRC_W);
  assert.equal(amount, 3_000_000_000_000_000n - 21_000n * (2n * 5_000_000n + CAP) - 7_000_000_000n, "the lower balance less the bound");
  assert.equal(await s.send(SRC_W, { ...OPEN(amount!), quote: "carry/base/cd" }, async () => {}), "pending");
  const d = decoded(r.sent[0]![0]!);
  assert.equal(d.signer, W.address.toLowerCase(), "W signed it");
  assert.equal(d.tx.chainId, EVM_CHAIN_IDS.base);
  assert.equal(d.tx.gasLimit, 21_000n);
  assert.equal(d.tx.value, amount);
});

test("(c) a balance short, nonces apart, a pending nonce ahead, a failed eth_call, a keep that throws, or an address that is not the key's: nothing is sent", async () => {
  const amount = 994_100_000_000_000n - 21_000n * (2n * 10_000_000n + CAP);
  const cases: [Parameters<typeof rpc>[0], CarrySource, string][] = [
    [{ balance: [994_100_000_000_000n, 994_099_999_999_999n] }, SRC_UX, "short"],
    [{ nonces: [5n, 6n] }, SRC_UX, "fault"],
    [{ pending: [6n, 5n] }, SRC_UX, "fault"],
    [{ simFail: [false, true] }, SRC_UX, "fault"],
    [{}, { ...SRC_UX, address: W.address }, "fault"],
    [{}, { ...SRC_UX, i: 3 }, "fault"],
  ];
  for (const [o, src, want] of cases) {
    const r = rpc(o);
    const kept: CarryOpen[] = [];
    assert.equal(await sender(r, "robinhood").send(src, OPEN(amount), async (x) => void kept.push(x)), want, JSON.stringify(o, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
    assert.deepEqual(r.sent, [[], []]);
    assert.equal(kept.length, 0);
  }
  const r = rpc();
  assert.equal(await sender(r, "robinhood").send(SRC_UX, OPEN(amount), async () => {
    throw new Error("store");
  }), "fault");
  assert.deepEqual(r.sent, [[], []], "a record that cannot be written sends nothing");
  // a read that fails: no amount
  assert.equal(await sender(rpc({ nonces: [5n, 6n] }), "robinhood").sendable(SRC_UX), null);
  // a source of another chain than the sender's: no amount, no send
  assert.equal(await sender(rpc(), "base").sendable(SRC_UX), null);
});

test("(d) a reload reads its recorded send first and never sends again: landed, dead, pending", async () => {
  const open: CarryOpen = { ...OPEN(1n), sends: [{ hash: H, value: "1", sentMs: "1", nonce: "5" }] };
  const ok = (n: bigint): Receipt => ({ transactionHash: H, status: "0x1", blockNumber: q(n), blockHash: hashOf(n) });
  // landed: both RPCs read its receipt, status 1, at or under the final block
  for (const [o, want] of [
    [{ receipts: [ok(80n), ok(80n)] }, "landed"],
    [{ receipts: [ok(95n), ok(95n)] }, "pending"], // above the final block
    [{ receipts: [ok(80n), null] }, "pending"], // one RPC alone
    [{ receipts: [{ ...ok(80n)!, status: "0x0" }, { ...ok(80n)!, status: "0x0" }] }, "pending"], // reverted, nonce not yet past at a final block
    [{}, "pending"], // nothing known, nonce not past
  ] as const) {
    const r = rpc(o as never);
    assert.equal(await sender(r, "robinhood").send(SRC_UX, open, async () => {}), want, JSON.stringify(o));
    assert.deepEqual(r.sent, [[], []]);
    assert.equal(r.calls.includes("eth_sendRawTransaction"), false);
  }
  // dead: the wallet's nonce past the recorded one on both, at a block that turns final, none of its hashes mined. The
  // first pass keeps that block in the record; a reload waits on that same block.
  const r1 = rpc({ nonceAt: [6n, 6n] });
  const kept: CarryOpen[] = [];
  assert.equal(await sender(r1, "robinhood").send(SRC_UX, open, async (o) => void kept.push(o)), "pending");
  assert.deepEqual(kept.at(-1)!.spent, { nonce: "5", number: "100", hash: hashOf(100n) });
  const r2 = rpc({ nonceAt: [6n, 6n], fin: 100n, block: 120n });
  assert.equal(await sender(r2, "robinhood").send(SRC_UX, kept.at(-1)!, async () => {}), "dead");
  assert.deepEqual(r2.sent, [[], []]);
  // past on one RPC only: never dead
  const r3 = rpc({ nonceAt: [6n, 5n], fin: 200n });
  assert.equal(await sender(r3, "robinhood").send(SRC_UX, open, async () => {}), "pending");
  // a send that reached the chain and reverted, final on both, with the nonce past: dead (nothing of it moved)
  const bad = { ...ok(80n)!, status: "0x0" };
  const r4 = rpc({ nonceAt: [6n, 6n], fin: 100n, block: 120n, receipts: [bad, bad] });
  assert.equal(await sender(r4, "robinhood").send(SRC_UX, kept.at(-1)!, async () => {}), "dead");
  // mined on one RPC alone with the nonce past at a final block: never dead (it may still read landed on both)
  const r6 = rpc({ nonceAt: [6n, 6n], fin: 100n, block: 120n, receipts: [ok(80n), null] });
  assert.equal(await sender(r6, "robinhood").send(SRC_UX, kept.at(-1)!, async () => {}), "pending");
  // landed wins over a nonce past: its own send used it
  const r5 = rpc({ nonceAt: [6n, 6n], fin: 100n, block: 120n, receipts: [ok(80n), ok(80n)] });
  assert.equal(await sender(r5, "robinhood").send(SRC_UX, kept.at(-1)!, async () => {}), "landed");
});

test("(e) the rule: each field held, each refusal its word; the signer signs only the checked send with the wallet's key", () => {
  const wallet = UX.address;
  const baseFee = 10_000_000n;
  const maxFee = 2n * baseFee + CAP;
  const value = 994_100_000_000_000n - 21_000n * maxFee;
  const tx = (o: Partial<EvmOnwardSend> = {}): EvmOnwardSend => ({ type: 2, chainId: EVM_CHAIN_IDS.base, nonce: 5n, maxPriorityFeePerGas: CAP, maxFeePerGas: maxFee, gasLimit: 21_000n, to: TO, value, data: "0x", accessList: [], ...o });
  const ctx = { wallet, to: TO, amount: value, chain: "base" as const, network: "base" as const };
  const reads = { nonce: [5n, 5n] as const, balance: [994_100_000_000_000n, 994_200_000_000_000n] as const, estimate: [21_000n, 21_000n] as const, baseFee: [baseFee, baseFee] as const, l1Fee: [0n, 0n] as const, priorityCap: CAP };
  checkEvmCashCarry(tx(), ctx, reads);
  const refused = (rule: string) => (e: unknown) => e instanceof PoolRuleRefused && e.rule === rule;
  for (const [rule, f] of [
    ["transfer_to", () => checkEvmCashCarry(tx({ to: "0x" + "9b".repeat(20) }), ctx, reads)],
    ["to", () => checkEvmCashCarry(tx({ to: wallet }), { ...ctx, to: wallet }, reads)],
    ["to", () => checkEvmCashCarry(tx({ to: "0x" + "00".repeat(19) + "01" }), { ...ctx, to: "0x" + "00".repeat(19) + "01" }, reads)],
    ["value", () => checkEvmCashCarry(tx({ value: value + 1n }), ctx, reads)],
    ["data", () => checkEvmCashCarry(tx({ data: "0x00" }), ctx, reads)],
    ["access_list", () => checkEvmCashCarry(tx({ accessList: [{ address: TO, storageKeys: [] }] }), ctx, reads)],
    ["gas_limit", () => checkEvmCashCarry(tx({ gasLimit: 21_001n }), ctx, reads)],
    ["gas_estimate", () => checkEvmCashCarry(tx(), ctx, { ...reads, estimate: [21_001n, 21_001n] })],
    ["reads", () => checkEvmCashCarry(tx(), ctx, { ...reads, estimate: [21_000n, 21_001n] })],
    ["chain_id", () => checkEvmCashCarry(tx({ chainId: EVM_CHAIN_IDS.robinhood }), ctx, reads)],
    ["chain", () => checkEvmCashCarry(tx(), { ...ctx, network: "robinhood" as never }, reads)],
    ["nonce", () => checkEvmCashCarry(tx({ nonce: 6n }), ctx, reads)],
    ["reads", () => checkEvmCashCarry(tx(), ctx, { ...reads, nonce: [5n, 6n] })],
    ["max_fee", () => checkEvmCashCarry(tx({ maxFeePerGas: maxFee + 1n }), ctx, reads)],
    ["max_fee", () => checkEvmCashCarry(tx({ maxFeePerGas: baseFee - 1n, maxPriorityFeePerGas: 0n }), ctx, reads)],
    ["priority_fee", () => checkEvmCashCarry(tx({ maxPriorityFeePerGas: CAP + 1n }), ctx, reads)],
    ["balance", () => checkEvmCashCarry(tx(), ctx, { ...reads, balance: [994_099_999_999_999n, 10n ** 18n] })],
    ["balance", () => checkEvmCashCarry(tx(), ctx, { ...reads, l1Fee: [0n, 1n] })],
    ["type", () => checkEvmCashCarry({ ...tx(), type: 4 } as never, ctx, reads)],
    ["wallet", () => checkEvmCashCarry(tx(), { ...ctx, wallet: "0x12" }, reads)],
    ["carry_ctx", () => checkEvmCashCarry(tx({ value: 0n }), { ...ctx, amount: 0n }, reads)],
  ] as [string, () => void][]) assert.throws(f, refused(rule), rule);
  // Robinhood (Nitro): the gas is the agreed estimate, never past the cap, and no L1 fee beside it
  const rh = { ...ctx, chain: "robinhood" as const, network: "robinhood" as const };
  const rtx = (o: Partial<EvmOnwardSend> = {}) => tx({ chainId: EVM_CHAIN_IDS.robinhood, gasLimit: 21_235n, value: value - 235n * maxFee, ...o });
  const rr = { ...reads, estimate: [21_235n, 21_235n] as const };
  checkEvmCashCarry(rtx(), { ...rh, amount: value - 235n * maxFee }, rr);
  assert.throws(() => checkEvmCashCarry(rtx({ gasLimit: 21_000n }), { ...rh, amount: value - 235n * maxFee }, rr), refused("gas_limit"));
  assert.throws(() => checkEvmCashCarry(rtx({ gasLimit: 100_001n }), { ...rh, amount: value - 235n * maxFee }, { ...rr, estimate: [100_001n, 100_001n] }), refused("gas_over_cap"));
  assert.throws(() => checkEvmCashCarry(rtx(), { ...rh, amount: value - 235n * maxFee }, { ...rr, l1Fee: [1n, 1n] }), refused("l1_fee"));
  // the signer: only the send the check passed, as it read it, with the wallet's own key
  const k = depositIdEvm(SEED(), 7n, 2);
  try {
    assert.throws(() => signEvmOnwardSend(k.secretKey, tx()), refused("unchecked"));
    const t = tx();
    checkEvmCashCarry(t, ctx, reads);
    const other = freshWallet(SEED(), "evm", 3n, 1);
    assert.throws(() => signEvmOnwardSend(other.secretKey, t), refused("wallet"));
    other.secretKey.fill(0);
    const raw = hexOf(signEvmOnwardSend(k.secretKey, t));
    assert.equal(decoded(raw).signer, wallet.toLowerCase());
    (t as { value: bigint }).value = value - 1n;
    assert.throws(() => signEvmOnwardSend(k.secretKey, t), refused("unchecked"));
  } finally {
    k.secretKey.fill(0);
  }
});
