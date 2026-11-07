// U's same-chain EVM pool deposit (card pool-deposits, slice 3): rules/pool.ts checkEvmDeposit holds each field of U's
// EIP-1559 deposit to the wallet's call, the device's pin and its two-RPC reads; signEvmDeposit signs only a send the
// check passed, with U's key alone, and the raw tx recovers to U's address.
//   node --test test/rules-pool-deposit-evm.test.ts      (from packages/signpage)
// U is depositIdEvm on the published all-zero seed (packages/wallet/test/vectors/a8.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import * as d from "../../wallet/src/derive/index.ts";
import { depositIdEvm } from "../../wallet/src/derive/keys.ts";
import { evmPoolScopeOf, EVM_LADDER, type EvmPoolPin } from "../../wallet/src/pool/evm.ts";
import { evmSameChainDeposit } from "../../wallet/src/pool/same-chain.ts";
import type { NoteRef } from "../../wallet/src/notes/secrets.ts";
import { VAULT_FIELD_P } from "../../kit/src/vault/shapes.ts";
import { EVM_POOL_MIN_DEPOSIT } from "../../kit/src/trade/evm/pool-fee.ts";
import { checkEvmDeposit, EVM_DEPOSIT_FIELD_P, EVM_DEPOSIT_GAS_MAX, evmOnwardSendDigest, PoolRuleRefused, signEvmDeposit, type EvmDepositContext, type EvmDepositReads, type EvmOnwardSend, type PoolAsk } from "../src/rules/pool.ts";

const refusedAs = (rule: string) => (e: unknown) => e instanceof PoolRuleRefused && e.code === "not_allowed" && e.rule === rule;
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const POOL = "0x00000000000000000000000000000000000f0011";
const PIN: EvmPoolPin = Object.freeze({ network: "base", pool: POOL, feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(POOL, 8453n);
const FIRST: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const U = depositIdEvm(SEED, SCOPE, 0);
const RUNG = EVM_LADDER.min; // 0.001 ETH
const step = evmSameChainDeposit({ pin: PIN, seed64: SEED, scope: SCOPE, ladder: EVM_LADDER, first: FIRST, held: [], events: [], finalBlock: 100n, balance: RUNG + 10n ** 15n, cost: 10n ** 15n });
assert.equal(step.kind, "deposit");
const CALL = step.call!;
const PRE = (step as { precommitment: bigint }).precommitment;
const ASK: PoolAsk = { kind: "pool.deposit", chain: "base", token: null, amount: RUNG, slippageBps: 0, decimals: 18 };
const BASE_FEE = 1_000_000n, TIP = 100_000n, GAS = 250_000n, L1 = 5_000_000n;
const ctxOf = (o: Partial<EvmDepositContext> = {}): EvmDepositContext => ({ wallet: U.address, precommitment: PRE, call: CALL, pin: PIN, ...o });
const txOf = (o: Partial<EvmOnwardSend> = {}): EvmOnwardSend => ({ type: 2, chainId: 8453n, nonce: 7n, maxPriorityFeePerGas: TIP, maxFeePerGas: 2n * BASE_FEE + TIP, gasLimit: GAS, to: POOL, value: RUNG, data: CALL.data, accessList: [], ...o });
const FEE = GAS * (2n * BASE_FEE + TIP) + L1;
const readsOf = (o: Partial<EvmDepositReads> = {}): EvmDepositReads => ({ nonce: [7n, 7n], balance: [RUNG + FEE, RUNG + FEE + 5n], estimate: [GAS, GAS], baseFee: [BASE_FEE, BASE_FEE], l1Fee: [L1, L1], priorityCap: TIP, ...o });

test("EVM deposit: U's one rung into the pinned pool with its fee bound passes; the draw names the pool", () => {
  assert.deepEqual(checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf()), { chain: "base", op: "pool.deposit", token: null, amount: RUNG, feeCap: FEE, pool: POOL, to: POOL, decimals: 18, back: null });
  // the testnet: base-sepolia's pin and chain id
  const sep = Object.freeze({ ...PIN, network: "base-sepolia" as const });
  const s2 = evmSameChainDeposit({ pin: sep, seed64: SEED, scope: evmPoolScopeOf(POOL, 84532n), ladder: EVM_LADDER, first: { kind: "deposit", s: evmPoolScopeOf(POOL, 84532n), i: 0 }, held: [], events: [], finalBlock: 1n, balance: RUNG, cost: 0n });
  checkEvmDeposit(txOf({ chainId: 84532n, data: s2.call!.data }), ASK, ctxOf({ pin: sep, call: s2.call!, precommitment: (s2 as { precommitment: bigint }).precommitment }), readsOf(), true);
  // Robinhood: no L1 fee beside the gas
  const rh = Object.freeze({ ...PIN, network: "robinhood" as const });
  checkEvmDeposit(txOf({ chainId: 4663n }), { ...ASK, chain: "robinhood" }, ctxOf({ pin: rh }), readsOf({ l1Fee: [0n, 0n] }));
});

test("EVM deposit: one refusal per field", () => {
  const cases: [string, () => unknown][] = [
    ["kind", () => checkEvmDeposit(txOf(), { ...ASK, kind: "pool.withdraw" }, ctxOf(), readsOf())],
    ["chain", () => checkEvmDeposit(txOf(), { ...ASK, chain: "solana" }, ctxOf(), readsOf())],
    ["evm_not_pinned", () => checkEvmDeposit(txOf(), ASK, ctxOf({ pin: undefined as never }), readsOf())],
    ["evm_not_pinned", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf(), true)], // a mainnet pin on the testnet page
    ["evm_not_pinned", () => checkEvmDeposit(txOf(), { ...ASK, chain: "robinhood" }, ctxOf(), readsOf())], // Base's pin for Robinhood
    ["wallet", () => checkEvmDeposit(txOf(), ASK, ctxOf({ wallet: "U" }), readsOf())],
    ["type", () => checkEvmDeposit({ ...txOf(), type: 4 } as never, ASK, ctxOf(), readsOf())],
    ["type", () => checkEvmDeposit({ ...txOf(), authorizationList: [] } as never, ASK, ctxOf(), readsOf())],
    ["tx_fields", () => checkEvmDeposit(txOf({ nonce: (1n << 64n) - 1n }), ASK, ctxOf(), readsOf())],
    ["chain_id", () => checkEvmDeposit(txOf({ chainId: 1n }), ASK, ctxOf(), readsOf())],
    ["to", () => checkEvmDeposit(txOf({ to: "0x1111111111111111111111111111111111111111" }), ASK, ctxOf(), readsOf())],
    ["to", () => checkEvmDeposit(txOf(), ASK, ctxOf({ call: Object.freeze({ ...CALL, to: "0x1111111111111111111111111111111111111111" }) }), readsOf())],
    ["call", () => checkEvmDeposit(txOf(), ASK, ctxOf({ call: { ...CALL } }), readsOf())], // not the wallet's frozen call
    ["amount", () => checkEvmDeposit(txOf(), { ...ASK, amount: RUNG - 1n }, ctxOf(), readsOf())], // more than asked
    ["amount", () => checkEvmDeposit(txOf({ value: 1n }), ASK, ctxOf({ call: Object.freeze({ ...CALL, value: 1n }) }), readsOf())], // under MIN_DEPOSIT
    ["value", () => checkEvmDeposit(txOf({ value: RUNG + 1n }), ASK, ctxOf(), readsOf())], // msg.value not the call's
    ["precommitment", () => checkEvmDeposit(txOf(), ASK, ctxOf({ precommitment: 0n }), readsOf())],
    ["data", () => checkEvmDeposit(txOf(), ASK, ctxOf({ precommitment: PRE + 1n }), readsOf())], // another note's
    ["data", () => checkEvmDeposit(txOf({ data: CALL.data + "00" }), ASK, ctxOf(), readsOf())],
    ["data", () => checkEvmDeposit(txOf({ data: "0x12345678" + CALL.data.slice(10) }), ASK, ctxOf(), readsOf())], // another selector
    ["nonce", () => checkEvmDeposit(txOf({ nonce: 6n }), ASK, ctxOf(), readsOf())],
    ["reads", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ nonce: [7n, 8n] }))], // the RPCs disagree
    ["reads", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ baseFee: [BASE_FEE, BASE_FEE + 1n] }))],
    ["reads", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ estimate: [GAS, GAS + 1n] }))],
    ["reads", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ l1Fee: [L1, L1 + 1n] }))],
    ["access_list", () => checkEvmDeposit(txOf({ accessList: [[POOL, []]] }), ASK, ctxOf(), readsOf())],
    ["gas_estimate", () => checkEvmDeposit(txOf({ gasLimit: GAS + 1n }), ASK, ctxOf(), readsOf())],
    ["gas_over_cap", () => checkEvmDeposit(txOf({ gasLimit: EVM_DEPOSIT_GAS_MAX + 1n }), ASK, ctxOf(), readsOf({ estimate: [EVM_DEPOSIT_GAS_MAX + 1n, EVM_DEPOSIT_GAS_MAX + 1n], balance: [10n ** 18n, 10n ** 18n] }))],
    ["priority_fee", () => checkEvmDeposit(txOf({ maxPriorityFeePerGas: TIP + 1n }), ASK, ctxOf(), readsOf())],
    ["priority_fee", () => checkEvmDeposit(txOf({ maxPriorityFeePerGas: TIP, maxFeePerGas: TIP - 1n }), ASK, ctxOf(), readsOf({ baseFee: [0n, 0n] }))],
    ["max_fee", () => checkEvmDeposit(txOf({ maxFeePerGas: 2n * BASE_FEE + TIP + 1n }), ASK, ctxOf(), readsOf())],
    ["max_fee", () => checkEvmDeposit(txOf({ maxFeePerGas: BASE_FEE - 1n, maxPriorityFeePerGas: 0n }), ASK, ctxOf(), readsOf())],
    ["l1_fee", () => checkEvmDeposit(txOf({ chainId: 4663n }), { ...ASK, chain: "robinhood" }, ctxOf({ pin: Object.freeze({ ...PIN, network: "robinhood" as const }) }), readsOf())],
    ["balance", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ balance: [RUNG + FEE, RUNG + FEE - 1n] }))], // one RPC's reading short
    ["balance", () => checkEvmDeposit(txOf(), ASK, ctxOf(), readsOf({ balance: [RUNG + FEE - 1n, 10n ** 18n] }))],
  ];
  for (const [rule, f] of cases) assert.throws(f, refusedAs(rule), rule);
});

const addressOf = (pub: Uint8Array): string => "0x" + Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString("hex");
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
    else if (x <= 0xbf) { const l = len(at + 1, x - 0xb7); out.push(b.slice(at + 1 + x - 0xb7, at + 1 + x - 0xb7 + l)); at += 1 + x - 0xb7 + l; }
    else if (x <= 0xf7) (out.push(new Uint8Array(0)), (at += 1 + x - 0xc0));
    else throw new Error("long list");
  }
  return out;
}
const big = (b: Uint8Array) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);

test("EVM deposit: signs as U the send the check passed, and the raw tx recovers to U's address; nothing else", () => {
  const tx = txOf();
  checkEvmDeposit(tx, ASK, ctxOf(), readsOf());
  const raw = signEvmDeposit(U.secretKey, tx);
  assert.equal(raw[0], 2, "a type 2 tx");
  const f = rlpItems(raw.slice(1));
  assert.equal(f.length, 12);
  assert.equal(big(f[1]!), 7n);
  assert.equal("0x" + Buffer.from(f[5]!).toString("hex"), POOL);
  assert.equal(big(f[6]!), RUNG);
  assert.equal("0x" + Buffer.from(f[7]!).toString("hex"), CALL.data);
  const sig = new secp256k1.Signature(big(f[10]!), big(f[11]!)).addRecoveryBit(Number(big(f[9]!)));
  const pub = sig.recoverPublicKey(evmOnwardSendDigest(tx)).toBytes(false);
  assert.equal(addressOf(pub), U.address.toLowerCase(), "recovers to U");
  // unchecked, changed after its check, or another key: refused
  assert.throws(() => signEvmDeposit(U.secretKey, txOf()), refusedAs("unchecked"));
  const t2 = txOf();
  checkEvmDeposit(t2, ASK, ctxOf(), readsOf());
  (t2 as { value: bigint }).value = RUNG + 1n;
  assert.throws(() => signEvmDeposit(U.secretKey, t2), refusedAs("unchecked"));
  const t3 = txOf();
  checkEvmDeposit(t3, ASK, ctxOf(), readsOf());
  assert.throws(() => signEvmDeposit(depositIdEvm(SEED, SCOPE, 1).secretKey, t3), refusedAs("wallet"));
});

test("EVM deposit: the rule's own bounds are the kit's: the field's order and the pool's MIN_DEPOSIT (its ladder's one)", () => {
  assert.equal(EVM_DEPOSIT_FIELD_P, VAULT_FIELD_P);
  assert.equal(EVM_LADDER.one, EVM_POOL_MIN_DEPOSIT);
  // a rung of one MIN_DEPOSIT passes the bound; one wei under it is refused (the amount case above)
  assert.throws(() => checkEvmDeposit(txOf(), ASK, ctxOf({ precommitment: EVM_DEPOSIT_FIELD_P }), readsOf()), refusedAs("precommitment"));
});
