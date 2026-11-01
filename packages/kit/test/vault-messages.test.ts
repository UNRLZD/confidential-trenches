// node --test packages/kit/test/vault-messages.test.ts: the vault module's messages (src/vault/messages.ts and
// request.ts, card vault-kit-messages), reached only through the kit's public entry. The deposit call is one shape for
// U, R and V, exactly the frozen carrier and message; the prepay keys the same decimal; the withdrawal request is the
// frozen VaultWithdrawal with a fresh 16-byte salt, its context equals vault-v1.json's 32 vectors, and the request fed
// to vaultWithdrawInput (inputs.ts) gives the same context, which the pinned withdraw.wasm carries as its last signal.
// Test values only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { poseidon2, poseidon3 } from "poseidon-lite";
import * as Kit from "../src/index.ts";
import { VaultTree, vaultWithdrawInput } from "../src/vault/inputs.ts";

const {
  VAULT_CONSTANTS,
  VAULT_DEPOSIT_CARRIER,
  VAULT_DEPOSIT_MESSAGE_FIELDS,
  VAULT_FIELD_P,
  VAULT_STORAGE_BYTE_COST,
  vaultDepositCall,
  vaultDepositMessage,
  vaultLabelOf,
  vaultStoragePrepay,
  vaultWithdrawRequest,
} = Kit;

const VAULT = "vault.confidential.unrlzd.near";
const TOKEN = "usdc.fakes.testnet";
const U = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
const R = "0d04229851cfaececfd8555b8951387197dee82f15d5f22a725e1d14b948c68a";
const V = "35b4d174e4b3fe6f9dd9b60d0046ccc0a02dadc9981a637f127233da5657cbb7";
const P = 123456789012345678901234567890n;

// ---- The deposit call ----

test("one deposit call for U, R and V: the mover's own ft_transfer_call on the token, 1 yocto, 180 Tgas", () => {
  for (const mover of [U, R, V]) {
    const c = vaultDepositCall({ vault: VAULT, token: TOKEN, mover, amount: 5_000_000n, precommitment: P });
    assert.deepEqual(c, {
      sender_id: mover,
      receiver_id: TOKEN,
      actions: [
        {
          FunctionCall: {
            method_name: "ft_transfer_call",
            args: { receiver_id: VAULT, amount: "5000000", msg: `{"precommitment":"${P}","depositor":"${mover}"}` },
            gas: 180_000_000_000_000,
            deposit: "1",
          },
        },
      ],
    });
    const fc = c.actions[0].FunctionCall;
    assert.equal(fc.method_name, VAULT_DEPOSIT_CARRIER.method);
    assert.deepEqual(Object.keys(fc.args), [...VAULT_DEPOSIT_CARRIER.args]);
    assert.equal(BigInt(fc.deposit), VAULT_DEPOSIT_CARRIER.deposit_yocto);
    assert.equal(fc.gas, VAULT_DEPOSIT_CARRIER.gas_tgas * 1e12);
    // the message is the frozen one, byte for byte, and its depositor is the signer
    assert.equal(fc.args.msg, vaultDepositMessage(P, mover));
    const m = JSON.parse(fc.args.msg) as Record<string, string>;
    assert.deepEqual(Object.keys(m), [...VAULT_DEPOSIT_MESSAGE_FIELDS]);
    assert.equal(m.depositor, c.sender_id);
  }
});

test("the deposit call refuses what the vault would refuse, and any mover that is not a 64-hex implicit id", () => {
  const ok = { vault: VAULT, token: TOKEN, mover: U, amount: VAULT_CONSTANTS.MIN_DEPOSIT, precommitment: P };
  assert.equal(vaultDepositCall(ok).actions[0].FunctionCall.args.amount, "1000000");
  assert.equal(vaultDepositCall({ ...ok, amount: (1n << 128n) - 2n }).actions[0].FunctionCall.args.amount, String((1n << 128n) - 2n));
  assert.equal(JSON.parse(vaultDepositCall({ ...ok, precommitment: VAULT_FIELD_P - 1n }).actions[0].FunctionCall.args.msg).precommitment, String(VAULT_FIELD_P - 1n));
  const refused: [Partial<typeof ok> | Record<string, unknown>, RegExp][] = [
    [{ amount: VAULT_CONSTANTS.MIN_DEPOSIT - 1n }, /amount: under MIN_DEPOSIT/],
    [{ amount: 0n }, /amount: under MIN_DEPOSIT/],
    [{ amount: -5_000_000n }, /amount: under MIN_DEPOSIT/],
    [{ amount: 5_000_000 }, /amount: under MIN_DEPOSIT/],
    [{ amount: "5000000" }, /amount: under MIN_DEPOSIT/],
    [{ amount: (1n << 128n) - 1n }, /amount: not below u128::MAX/],
    [{ amount: 1n << 128n }, /amount: not below u128::MAX/],
    [{ precommitment: VAULT_FIELD_P }, /precommitment/],
    [{ precommitment: -1n }, /precommitment/],
    [{ mover: U.toUpperCase() }, /depositor/],
    [{ mover: "alice.near" }, /depositor/],
    [{ mover: "intents.near" }, /depositor/],
    [{ mover: "0x" + U.slice(0, 40) }, /depositor/],
    [{ mover: U.slice(1) }, /depositor/],
    [{ vault: "Vault.near" }, /vault: not a NEAR account id/],
    [{ token: "" }, /token: not a NEAR account id/],
    [{ token: VAULT }, /vault: the token/],
  ];
  for (const [o, re] of refused) assert.throws(() => vaultDepositCall({ ...ok, ...o } as typeof ok), re, JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
});

test("the prepay keys the deposit message's own decimal and attaches 756 or 904 bytes' worth", () => {
  const d = vaultDepositCall({ vault: VAULT, token: TOKEN, mover: U, amount: 5_000_000n, precommitment: P });
  const msgP = (JSON.parse(d.actions[0].FunctionCall.args.msg) as { precommitment: string }).precommitment;
  assert.deepEqual(vaultStoragePrepay(VAULT, P, false), {
    receiver_id: VAULT,
    method: "storage_prepay",
    args: { precommitment: msgP },
    deposit_yocto: 756n * VAULT_STORAGE_BYTE_COST,
  });
  assert.equal(vaultStoragePrepay(VAULT, P, true).deposit_yocto, 904n * VAULT_STORAGE_BYTE_COST);
  assert.equal(vaultStoragePrepay(VAULT, 0n, false).args.precommitment, "0");
  assert.throws(() => vaultStoragePrepay(VAULT, VAULT_FIELD_P, false), /precommitment: not below p/);
  assert.throws(() => vaultStoragePrepay(VAULT, -1n, false), /precommitment: not below p/);
  assert.throws(() => vaultStoragePrepay(VAULT, 5 as unknown as bigint, false), /precommitment: not below p/);
  assert.throws(() => vaultStoragePrepay("not a vault", P, false), /vault: not a NEAR account id/);
  assert.throws(() => vaultStoragePrepay(VAULT, P, "yes" as unknown as boolean), /aTreeMayGrow/);
});

// ---- The withdrawal request ----

type ContextVector = { name: string; input: Record<string, string>; scope: string; context: string };
const VECTORS = (JSON.parse(readFileSync(new URL("./vectors/vault-v1.json", import.meta.url), "utf8")) as { context: ContextVector[] }).context;
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
/** A random source that writes these 16 bytes, as crypto.getRandomValues would write its own. */
const fixedSalt = (salt: string) => (b: Uint8Array): Uint8Array => {
  b.set(unhex(salt));
  return b;
};
const U128_MAX = (1n << 128n) - 1n;

/** The vector's request arguments, with no random source: the kit's own crypto.getRandomValues. */
function argsOf(v: ContextVector): Kit.VaultWithdrawRequestArgs {
  const i = v.input;
  return {
    vaultId: i.processor!,
    scope: BigInt(v.scope),
    recipient: i.recipient!,
    registerDeposit: BigInt(i.register_deposit!),
    feeRecipient: i.fee_recipient!,
    relayFee: BigInt(i.relay_fee!),
    refundPrecommitment: BigInt(i.refund_precommitment!),
    deadlineMs: Number(i.deadline_ms),
    withdrawn: U128_MAX,
    nowMs: 0,
  };
}
const requestOf = (v: ContextVector, o: Partial<Kit.VaultWithdrawRequestArgs> = {}): Kit.VaultWithdrawRequest =>
  vaultWithdrawRequest({ ...argsOf(v), getRandomValues: fixedSalt(v.input.salt!), ...o });

// The vectors the vault itself would refuse as a withdrawal (the vectors pin the context's bytes, not a request):
// a deadline past 2^53 is no JSON number the vault's u64 reads exactly, a fee of u128::MAX is over the backstop for
// any withdrawn u128, and "every field at its minimum" names the vault as its recipient.
const REFUSED: Record<string, RegExp> = {
  "relay_fee u128 max": /relay_fee: over the backstop/,
  "deadline_ms u64 max": /deadline_ms: not a u64 JSON number/,
  "every field at its maximum": /deadline_ms: not a u64 JSON number/,
  "every field at its minimum": /recipient: the vault/,
  "g1 context 4, new layout": /deadline_ms: not a u64 JSON number/,
};

test("vault-v1.json's 32 context vectors: the request is the vector's withdrawal and its context the vector's", () => {
  assert.equal(VECTORS.length, 32);
  let built = 0;
  for (const v of VECTORS) {
    const refused = REFUSED[v.name];
    if (refused) {
      assert.throws(() => requestOf(v), refused, v.name);
      continue;
    }
    const r = requestOf(v);
    const { processor: _p, ...withdrawal } = v.input;
    assert.deepEqual(r.withdrawal, { ...withdrawal, deadline_ms: Number(v.input.deadline_ms) }, v.name);
    assert.deepEqual(Object.keys(r.withdrawal), ["recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"], v.name);
    assert.equal(r.context, v.context, v.name);
    built++;
  }
  assert.equal(built, 32 - Object.keys(REFUSED).length);
});

test("the salt: 16 fresh bytes from crypto.getRandomValues on every call, as 32 lowercase hex characters", () => {
  const v = VECTORS[0]!;
  const seen = new Set<string>();
  const contexts = new Set<string>();
  for (let n = 0; n < 64; n++) {
    const r = vaultWithdrawRequest(argsOf(v));
    assert.match(r.withdrawal.salt, /^[0-9a-f]{32}$/);
    seen.add(r.withdrawal.salt);
    contexts.add(r.context);
  }
  assert.equal(seen.size, 64, "a salt repeated");
  assert.equal(contexts.size, 64, "a context repeated");
  // the source is given exactly one 16-byte buffer, and must fill and return that one
  const sizes: number[] = [];
  requestOf(v, { getRandomValues: (b) => (sizes.push(b.length), b) });
  assert.deepEqual(sizes, [16]);
  assert.throws(() => requestOf(v, { getRandomValues: () => new Uint8Array(16) }), /salt: the random source did not return the buffer/);
  assert.throws(() => requestOf(v, { getRandomValues: () => new Uint8Array(32) }), /salt: the random source did not return the buffer/);
});

test("the request refuses every field the vault would refuse, before a proof is spent on it", () => {
  const v = VECTORS[0]!;
  const vault = v.input.processor!;
  const cases: [Partial<Kit.VaultWithdrawRequestArgs>, RegExp][] = [
    [{ recipient: vault }, /recipient: the vault/],
    [{ feeRecipient: vault }, /fee_recipient: the vault/],
    [{ recipient: "intents.near" }, /recipient: intents.near/],
    [{ feeRecipient: "intents.near" }, /fee_recipient: intents.near/],
    [{ recipient: "Bob.near" }, /recipient: not a NEAR account id/],
    [{ feeRecipient: "" }, /fee_recipient: not a NEAR account id/],
    [{ vaultId: "not a vault" }, /processor: not a NEAR account id/],
    [{ registerDeposit: -1n }, /register_deposit: not one canonical decimal/],
    [{ registerDeposit: 1n << 128n }, /register_deposit: not a u128/],
    [{ relayFee: -1n }, /relay_fee: not one canonical decimal/],
    [{ relayFee: 1n << 128n }, /relay_fee: not a u128/],
    [{ relayFee: 30_001n, withdrawn: 60_000n }, /relay_fee: over the backstop/],
    [{ refundPrecommitment: 0n }, /refund_precommitment: not in 1\.\.p-1/],
    [{ refundPrecommitment: VAULT_FIELD_P }, /refund_precommitment: not in 1\.\.p-1/],
    [{ deadlineMs: 1_000, nowMs: 1_001 }, /deadline_ms: passed/],
    [{ deadlineMs: 1.5 }, /deadline_ms: not a u64 JSON number/],
    [{ deadlineMs: -1 }, /deadline_ms: not a u64 JSON number/],
    [{ withdrawn: 0n }, /withdrawn: 0/],
    [{ withdrawn: 1n << 128n }, /withdrawn: not a u128/],
    [{ scope: VAULT_FIELD_P }, /scope: not below p/],
    [{ registerDeposit: 0 as unknown as bigint }, /registerDeposit: not a bigint/],
    [{ relayFee: "30000" as unknown as bigint }, /relayFee: not a bigint/],
    [{ withdrawn: 5 as unknown as bigint }, /withdrawn: not a bigint/],
  ];
  for (const [o, re] of cases) assert.throws(() => requestOf(v, o), re, JSON.stringify(o, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)));
  // the backstop's edge passes: fee × 10,000 = withdrawn × 5,000
  assert.equal(requestOf(v, { relayFee: 30_000n, withdrawn: 60_000n }).withdrawal.relay_fee, "30000");
  // a deadline equal to now passes, as the vault's block_timestamp_ms() <= deadline_ms
  assert.equal(requestOf(v, { deadlineMs: 1_000, nowMs: 1_000 }).withdrawal.deadline_ms, 1_000);
});

// ---- The request, fed to the circuit inputs ----

type Wtns = { type: "mem"; data?: Uint8Array };
const snarkjs = createRequire(import.meta.url)("snarkjs") as {
  wtns: { calculate(input: unknown, wasm: Uint8Array, out: Wtns): Promise<void>; exportJson(w: Wtns): Promise<bigint[]> };
};

test("vaultWithdrawInput takes the request as built: the same context, carried by withdraw.wasm as its last signal", async () => {
  const v = VECTORS.find((x) => x.name === "a withdrawal to a new recipient with a fee")!;
  const scope = BigInt(v.scope);
  const vaultId = v.input.processor!;
  const nowMs = 1_700_000_000_000;
  const label = vaultLabelOf(keccak_256, scope, 1n);
  const note = { value: 5_000_000n, label, nullifier: 11n, secret: 13n };
  const commitment = poseidon3([note.value, label, poseidon2([note.nullifier, note.secret])]);
  const stateTree = new VaultTree([commitment]);
  const labelTree = new VaultTree([label]);
  const withdrawn = 2_000_000n;
  const r = requestOf(v, { withdrawn, nowMs });
  assert.equal(r.context, v.context);
  const input = vaultWithdrawInput({
    stateTree,
    labelTree,
    newestStateRoot: stateTree.root!,
    newestLabelRoot: labelTree.root!,
    note,
    newNullifier: 17n,
    newSecret: 19n,
    withdrawn,
    withdrawal: r.withdrawal,
    vaultId,
    scope,
    nowMs,
  });
  assert.equal(input.context, r.context);
  const wasm = new Uint8Array(readFileSync(new URL("../zk/withdraw.wasm", import.meta.url)));
  const out: Wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, wasm, out);
  const w = (await snarkjs.wtns.exportJson(out)).slice(0, 9).map(String);
  assert.equal(w[8], r.context);
  assert.equal(w[3], String(withdrawn));
  // a request for another vault's scope gives another context, which this proof would not carry
  const other = requestOf(v, { withdrawn, nowMs, scope: scope + 1n });
  assert.notEqual(other.context, r.context);
});
