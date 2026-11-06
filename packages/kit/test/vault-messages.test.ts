// node --test packages/kit/test/vault-messages.test.ts: the vault module's messages (src/vault/messages.ts and
// request.ts, card vault-kit-messages), reached only through the kit's public entry. The deposit call is one shape for
// U, R and V, exactly the frozen carrier and message; the prepay keys the same decimal; the withdrawal request is the
// frozen VaultWithdrawal with a fresh 16-byte salt from crypto.getRandomValues alone and the vault's own scope, its
// context equals vault-v1.json's vectors, and the request fed to vaultWithdrawInput (inputs.ts) gives the same context,
// which the pinned withdraw.wasm carries as its last signal. The vectors' salts are set by mocking the global
// crypto.getRandomValues, since the builder takes no other source. Test values only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
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
  VAULT_STORAGE_PREPAY,
  HELPER_BIND_DEPOSIT_CAP,
  vaultContextInput,
  vaultContextOf,
  vaultDepositCall,
  vaultDepositMessage,
  vaultLabelOf,
  vaultScopeOf,
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
  // the beta cap, read from the helper's constant: the cap builds, one base unit more is refused before any signing
  assert.equal(HELPER_BIND_DEPOSIT_CAP, 1_000_000_000n);
  assert.equal(vaultDepositCall({ ...ok, amount: HELPER_BIND_DEPOSIT_CAP }).actions[0].FunctionCall.args.amount, "1000000000");
  // a 64-hex vault that is not the mover builds
  assert.equal(vaultDepositCall({ ...ok, vault: R }).actions[0].FunctionCall.args.receiver_id, R);
  assert.equal(JSON.parse(vaultDepositCall({ ...ok, precommitment: VAULT_FIELD_P - 1n }).actions[0].FunctionCall.args.msg).precommitment, String(VAULT_FIELD_P - 1n));
  const refused: [Partial<typeof ok> | Record<string, unknown>, RegExp][] = [
    [{ amount: VAULT_CONSTANTS.MIN_DEPOSIT - 1n }, /amount: under MIN_DEPOSIT/],
    [{ amount: 0n }, /amount: under MIN_DEPOSIT/],
    [{ amount: -5_000_000n }, /amount: under MIN_DEPOSIT/],
    [{ amount: 5_000_000 }, /amount: not a bigint/],
    [{ amount: "5000000" }, /amount: not a bigint/],
    [{ amount: undefined }, /amount: not a bigint/],
    [{ amount: HELPER_BIND_DEPOSIT_CAP + 1n }, /amount: over HELPER_BIND_DEPOSIT_CAP/],
    [{ amount: (1n << 128n) - 1n }, /amount: over HELPER_BIND_DEPOSIT_CAP/],
    [{ amount: 1n << 128n }, /amount: over HELPER_BIND_DEPOSIT_CAP/],
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
    [{ vault: "intents.near" }, /vault: intents.near/],
    [{ vault: U }, /mover: the vault/],
  ];
  for (const [o, re] of refused) assert.throws(() => vaultDepositCall({ ...ok, ...o } as typeof ok), re, JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
});

test("the prepay keys the deposit message's own decimal and attaches the bytes it is given", () => {
  const d = vaultDepositCall({ vault: VAULT, token: TOKEN, mover: U, amount: 5_000_000n, precommitment: P });
  const msgP = (JSON.parse(d.actions[0].FunctionCall.args.msg) as { precommitment: string }).precommitment;
  assert.deepEqual(vaultStoragePrepay(VAULT, P, VAULT_STORAGE_PREPAY.min_bytes), {
    receiver_id: VAULT,
    method: "storage_prepay",
    args: { precommitment: msgP },
    deposit_yocto: 756n * VAULT_STORAGE_BYTE_COST,
  });
  assert.equal(vaultStoragePrepay(VAULT, P, VAULT_STORAGE_PREPAY.bytes_when_a_tree_may_grow).deposit_yocto, 904n * VAULT_STORAGE_BYTE_COST);
  // a top-up on a record that exists: the 148 bytes a tree's growth adds
  assert.equal(vaultStoragePrepay(VAULT, P, 148).deposit_yocto, 148n * VAULT_STORAGE_BYTE_COST);
  // R-01: the vault refuses precommitment 0 (no note on it could be spent), so the kit builds none
  assert.throws(() => vaultStoragePrepay(VAULT, 0n, 756), /precommitment: not in 1\.\.p-1/);
  assert.equal(vaultStoragePrepay(VAULT, 1n, 756).args.precommitment, "1");
  assert.equal(vaultStoragePrepay(VAULT, VAULT_FIELD_P - 1n, 756).args.precommitment, (VAULT_FIELD_P - 1n).toString());
  assert.throws(() => vaultStoragePrepay(VAULT, VAULT_FIELD_P, 756), /precommitment: not in 1\.\.p-1/);
  assert.throws(() => vaultStoragePrepay(VAULT, -1n, 756), /precommitment: not in 1\.\.p-1/);
  assert.throws(() => vaultStoragePrepay(VAULT, 5 as unknown as bigint, 756), /precommitment: not in 1\.\.p-1/);
  assert.throws(() => vaultStoragePrepay("not a vault", P, 756), /vault: not a NEAR account id/);
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, true, "756", 756n, undefined]) {
    assert.throws(() => vaultStoragePrepay(VAULT, P, bad as unknown as number), /bytes: not a positive whole number/, String(bad));
  }
});

// ---- The withdrawal request ----

type ContextVector = { name: string; input: Record<string, string>; scope: string; context: string };
const V1 = JSON.parse(readFileSync(new URL("./vectors/vault-v1.json", import.meta.url), "utf8")) as {
  scope: { vault: string; asset: string }[];
  context: ContextVector[];
};
const VECTORS = V1.context;
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
const U128_MAX = (1n << 128n) - 1n;
/** Each vault's token, from the scope vectors; a vault with none gets token.test.near. */
const tokenOf = (vault: string): string => V1.scope.find((x) => x.vault === vault)?.asset ?? "token.test.near";

/**
 * Mocks crypto.getRandomValues for this test: it writes the salt last set by the returned setter, or real random
 * bytes while none is set. The builder's only randomness is this global.
 */
function mockSalt(t: TestContext): { set(salt: string | undefined): void; calls(): number } {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let next: string | undefined;
  const m = t.mock.method(globalThis.crypto, "getRandomValues", <T extends ArrayBufferView | null>(b: T): T => {
    if (next === undefined) return real(b as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
    (b as unknown as Uint8Array).set(unhex(next));
    return b;
  });
  return { set: (s) => void (next = s), calls: () => m.mock.callCount() };
}

/** The vector's request arguments; the vault's token from the scope vectors. */
function argsOf(v: ContextVector): Kit.VaultWithdrawRequestArgs {
  const i = v.input;
  return {
    vaultId: i.processor!,
    token: tokenOf(i.processor!),
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

// Vectors refused as requests (the vectors pin the context's bytes, not a request). By the kit only: a deadline past
// 2^53 cannot be held exactly by a JS number, which the frozen VaultWithdrawal's deadline_ms is, though the vault's u64
// takes it ("deadline_ms u64 max", "g1 context 4", and "every field at its maximum"). By the vault as well: a fee of
// u128::MAX is over the backstop for any withdrawn u128, and "every field at its minimum" names the vault as recipient.
const REFUSED: Record<string, RegExp> = {
  "relay_fee u128 max": /relay_fee: over the backstop/,
  "deadline_ms u64 max": /deadline_ms: not a u64 JSON number/,
  "every field at its maximum": /deadline_ms: not a u64 JSON number/,
  "every field at its minimum": /recipient: the vault/,
  "g1 context 4, new layout": /deadline_ms: not a u64 JSON number/,
};

test("vault-v1.json's context vectors: the request is the vector's withdrawal; with the vault's own scope, the vector's context", (t) => {
  const salt = mockSalt(t);
  assert.equal(VECTORS.length, 32);
  let pinned = 0;
  let other = 0;
  for (const v of VECTORS) {
    salt.set(v.input.salt!);
    const refused = REFUSED[v.name];
    if (refused) {
      assert.throws(() => vaultWithdrawRequest(argsOf(v)), refused, v.name);
      continue;
    }
    const r = vaultWithdrawRequest(argsOf(v));
    const { processor: _p, ...withdrawal } = v.input;
    assert.deepEqual(r.withdrawal, { ...withdrawal, deadline_ms: Number(v.input.deadline_ms) }, v.name);
    assert.deepEqual(Object.keys(r.withdrawal), ["recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"], v.name);
    const scope = vaultScopeOf(keccak_256, v.input.processor!, tokenOf(v.input.processor!));
    if (scope === BigInt(v.scope)) {
      // the vector's scope is a real vault's (vault, token): its pinned context, byte for byte
      assert.equal(r.context, v.context, v.name);
      pinned++;
    } else {
      // a scope no (vault, token) pair gives: the request uses the vault's own scope, never the vector's
      assert.notEqual(r.context, v.context, v.name);
      assert.equal(r.context, String(vaultContextOf(keccak_256, vaultContextInput(v.input.processor!, r.withdrawal), scope)), v.name);
      other++;
    }
  }
  assert.equal(pinned, 23);
  assert.equal(other, 4);
});

test("the salt: 16 fresh bytes from crypto.getRandomValues on every call, as 32 lowercase hex characters", (t) => {
  const v = VECTORS[0]!;
  const salt = mockSalt(t);
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
  assert.equal(salt.calls(), 64, "one draw per request");
});

test("the builder takes no caller-supplied random source or salt: the device's crypto.getRandomValues only", (t) => {
  const v = VECTORS[0]!;
  const salt = mockSalt(t);
  salt.set("0123456789abcdef0123456789abcdef");
  let used = 0;
  const noop = (b: Uint8Array): Uint8Array => (used++, b);
  for (const extra of [{ getRandomValues: noop }, { random: noop }, { salt: "00".repeat(16) }, { scope: 5n }]) {
    assert.throws(() => vaultWithdrawRequest({ ...argsOf(v), ...extra } as Kit.VaultWithdrawRequestArgs), /: not an argument of the request/, Object.keys(extra)[0]);
  }
  assert.equal(used, 0, "a caller's source was called");
  // the salt is the global's bytes, whatever else the caller holds
  assert.equal(vaultWithdrawRequest(argsOf(v)).withdrawal.salt, "0123456789abcdef0123456789abcdef");
});

test("the scope is the vault's own: computed from the vault and its token, never passed in", (t) => {
  mockSalt(t).set("00".repeat(16));
  const v = VECTORS[0]!;
  const a = argsOf(v);
  const r = vaultWithdrawRequest(a);
  assert.equal(r.context, v.context);
  const other = vaultWithdrawRequest({ ...a, token: "token.test.near" });
  assert.notEqual(other.context, r.context);
  const scope = vaultScopeOf(keccak_256, a.vaultId, "token.test.near");
  assert.equal(other.context, String(vaultContextOf(keccak_256, vaultContextInput(a.vaultId, other.withdrawal), scope)));
  assert.throws(() => vaultWithdrawRequest({ ...a, token: "Token.near" }), /token: not a NEAR account id/);
  assert.throws(() => vaultWithdrawRequest({ ...a, vaultId: "not a vault" }), /vault: not a NEAR account id/);
});

test("the request refuses every field the vault would refuse, before a proof is spent on it", () => {
  const v = VECTORS[0]!;
  const vault = v.input.processor!;
  const cases: [Partial<Record<keyof Kit.VaultWithdrawRequestArgs, unknown>>, RegExp][] = [
    [{ recipient: vault }, /recipient: the vault/],
    [{ feeRecipient: vault }, /fee_recipient: the vault/],
    [{ recipient: "intents.near" }, /recipient: intents.near/],
    [{ feeRecipient: "intents.near" }, /fee_recipient: intents.near/],
    [{ recipient: "Bob.near" }, /recipient: not a NEAR account id/],
    [{ feeRecipient: "" }, /fee_recipient: not a NEAR account id/],
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
    [{ registerDeposit: 0 }, /registerDeposit: not a bigint/],
    [{ relayFee: "30000" }, /relayFee: not a bigint/],
    [{ withdrawn: 5 }, /withdrawn: not a bigint/],
    [{ nowMs: Number.NaN }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: undefined }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: null }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: "2000x" }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: "2000" }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: -1 }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: 1.5 }, /nowMs: not a whole number, 0 or more/],
    [{ nowMs: 2 ** 53 }, /nowMs: not a whole number, 0 or more/],
  ];
  const at = (o: object): Kit.VaultWithdrawRequestArgs => ({ ...argsOf(v), ...o }) as Kit.VaultWithdrawRequestArgs;
  for (const [o, re] of cases) assert.throws(() => vaultWithdrawRequest(at(o)), re, JSON.stringify(o, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)));
  // the backstop's edge passes: fee × 10,000 = withdrawn × 5,000
  assert.equal(vaultWithdrawRequest(at({ relayFee: 30_000n, withdrawn: 60_000n })).withdrawal.relay_fee, "30000");
  // a deadline equal to now passes, as the vault's block_timestamp_ms() <= deadline_ms
  assert.equal(vaultWithdrawRequest(at({ deadlineMs: 1_000, nowMs: 1_000 })).withdrawal.deadline_ms, 1_000);
});

// ---- The request, fed to the circuit inputs ----

type Wtns = { type: "mem"; data?: Uint8Array };
const snarkjs = createRequire(import.meta.url)("snarkjs") as {
  wtns: { calculate(input: unknown, wasm: Uint8Array, out: Wtns): Promise<void>; exportJson(w: Wtns): Promise<bigint[]> };
};

test("vaultWithdrawInput takes the request as built: the same context, carried by withdraw.wasm as its last signal", async (t) => {
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
  mockSalt(t).set(v.input.salt!);
  const r = vaultWithdrawRequest({ ...argsOf(v), withdrawn, nowMs });
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
  assert.equal(scope, vaultScopeOf(keccak_256, vaultId, tokenOf(vaultId)));
  // a request on another token's scope gives another context, which this proof would not carry
  const other = vaultWithdrawRequest({ ...argsOf(v), token: "token.test.near", withdrawn, nowMs });
  assert.notEqual(other.context, r.context);
});
