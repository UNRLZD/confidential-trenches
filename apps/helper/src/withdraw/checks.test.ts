// checks.ts, H3.4 checks 1-4 (M:1079-1110) in order: each check's bad cases, VT-U02's context vectors (the ones the
// kit's shapes.ts and the vault's context.rs are held to), and a real Withdraw(32) proof (fixtures/withdraw-request.json,
// made by the kit's vaultWithdrawRequest and vaultWithdrawInput and snarkjs 0.7.5 over the pinned setup files) that
// passes, with every single field it binds flipped and refused. The vault's own fixture proof verifies here too.
//   node --test apps/helper/src/withdraw/checks.test.ts
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  HELPER_WITHDRAW_CODES,
  VAULT_CONSTANTS,
  VAULT_FIELD_P,
  VAULT_FIELD_Q,
  ZK_SETUP_FILES,
  vaultAccountId,
  vaultContextOf,
  vaultContextPreimage,
  vaultScopeOf,
  vaultWithdrawRequest,
  type VaultWithdrawal,
} from "../../../../packages/kit/src/index.ts";
import {
  MAX_TREE_DEPTH,
  WITHDRAW_CHECK_CODES,
  WITHDRAW_VKEY_SHA256,
  checkWithdraw,
  isAccountId,
  keccak256,
  loadWithdrawVkey,
  verifyWithdrawProof,
  withdrawContext,
  type WithdrawConfig,
  type WithdrawReads,
  type WithdrawVerdict,
} from "./checks.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-request.json"), "utf8")) as {
  vault: string;
  token: string;
  scope: string;
  fee_recipient: string;
  request: Req;
};
// The fixture leaves the token out (a 64-hex id reads as a key to the secret scan): it is the kit's mainnet USDC.
fixture.token = VAULT_CONSTANTS.TOKEN;
fixture.request.token = VAULT_CONSTANTS.TOKEN;
type Req = {
  withdrawal: VaultWithdrawal;
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  public_signals: string[];
  fund_recipient?: unknown;
  token: string;
};
const CFG: WithdrawConfig = { vault: fixture.vault, token: fixture.token, scope: BigInt(fixture.scope), feeRecipient: fixture.fee_recipient };
const FEE = BigInt(fixture.request.withdrawal.relay_fee);

const req = (): Req => structuredClone(fixture.request);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function reads(feeMin = FEE): WithdrawReads & { calls: number } {
  const r = {
    calls: 0,
    async feeMin() {
      r.calls++;
      return feeMin;
    },
  };
  return r;
}

async function run(body: unknown, cfg = CFG, r: WithdrawReads = reads()): Promise<WithdrawVerdict> {
  return checkWithdraw(body, cfg, r);
}

function refused(v: WithdrawVerdict, code: string, why?: RegExp, name = ""): void {
  assert.equal(v.ok, false, `${name}: passed`);
  if (v.ok) return;
  assert.equal(v.code, code, `${name}: ${v.why}`);
  if (why) assert.match(v.why, why, name);
}

/** The value one away from `s`, still one canonical decimal below `bound`. */
const next = (s: string, bound: bigint): string => {
  const v = BigInt(s);
  return String(v + 1n < bound ? v + 1n : v - 1n);
};
/** A G1 or G2 point's negative: y -> q - y, coordinate by coordinate. */
const neg = (y: string): string => String((VAULT_FIELD_Q - BigInt(y)) % VAULT_FIELD_Q);

// ---- The values checks.ts shares with the kit and the vault ----

test("the codes are the kit's, in the kit's order, and the pins are the kit's", () => {
  const at = WITHDRAW_CHECK_CODES.map((c) => (HELPER_WITHDRAW_CODES as readonly string[]).indexOf(c));
  assert.ok(at.every((i) => i >= 0), "every code in HELPER_WITHDRAW_CODES");
  assert.deepEqual(at, [...at].sort((x, y) => x - y), "in the kit's order");
  assert.deepEqual(at, [0, 1, 2, 3, 4], "H3.4 checks 1-4 are the first five codes");
  assert.equal(WITHDRAW_VKEY_SHA256, ZK_SETUP_FILES["withdraw.vkey"].sha256);
  assert.equal(statSync(new URL("./withdraw.vkey", import.meta.url)).size, ZK_SETUP_FILES["withdraw.vkey"].bytes);
  assert.equal(MAX_TREE_DEPTH, BigInt(VAULT_CONSTANTS.MAX_TREE_DEPTH));
  for (const s of ["a", "ab", "relayer.confidential.unrlzd.near", "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de", "A1", "a..b", "-ab", "a_", "x".repeat(65), "", "intents.near"]) {
    let kit = true;
    try {
      vaultAccountId(s, "s");
    } catch {
      kit = false;
    }
    assert.equal(isAccountId(s), kit, s);
  }
});

test("a vkey that is not the pinned file is refused at load", () => {
  const bytes = readFileSync(new URL("./withdraw.vkey", import.meta.url));
  assert.doesNotThrow(() => loadWithdrawVkey(bytes));
  const changed = Buffer.from(bytes);
  changed[changed.indexOf("1")] = "2".charCodeAt(0);
  assert.throws(() => loadWithdrawVkey(changed), /not the pinned/);
});

// ---- Check 2: VT-U02's vectors, the same file the kit's shapes.ts and the vault's context.rs are tested on ----

const VECTORS = JSON.parse(readFileSync(join(ROOT, "packages/kit/test/vectors/vault-v1.json"), "utf8")) as {
  scope: { vault: string; asset: string; scope: string; preimage_hex: string; keccak_hex: string }[];
  context: { name: string; input: Record<string, string>; scope: string; preimage_hex: string; keccak_hex: string; context: string }[];
};

test("VT-U02: the relayer's context equals every vector's, byte for byte (32 context, 8 scope)", () => {
  assert.equal(VECTORS.context.length, 32);
  assert.equal(VECTORS.scope.length, 8);
  for (const t of VECTORS.scope) {
    assert.equal(hex(keccak256(Buffer.from(t.preimage_hex, "hex"))), t.keccak_hex, t.vault);
    assert.equal(vaultScopeOf(keccak256, t.vault, t.asset).toString(), t.scope, t.vault);
  }
  let viaRequest = 0;
  for (const t of VECTORS.context) {
    const i = t.input;
    const input = {
      processor: i.processor!,
      recipient: i.recipient!,
      register_deposit: BigInt(i.register_deposit!),
      fee_recipient: i.fee_recipient!,
      relay_fee: BigInt(i.relay_fee!),
      refund_precommitment: BigInt(i.refund_precommitment!),
      deadline_ms: BigInt(i.deadline_ms!),
      salt: i.salt!,
    };
    const pre = vaultContextPreimage(input, BigInt(t.scope));
    assert.equal(hex(pre), t.preimage_hex, t.name);
    assert.equal(hex(keccak256(pre)), t.keccak_hex, t.name);
    assert.equal(vaultContextOf(keccak256, input, BigInt(t.scope)).toString(), t.context, t.name);
    const w: VaultWithdrawal = {
      recipient: i.recipient!,
      register_deposit: i.register_deposit!,
      fee_recipient: i.fee_recipient!,
      relay_fee: i.relay_fee!,
      refund_precommitment: i.refund_precommitment!,
      deadline_ms: Number(i.deadline_ms),
      salt: i.salt!,
    };
    if (String(w.deadline_ms) === i.deadline_ms) {
      // The request as JSON carries it: the relayer's own recompute, from the withdrawal it parsed.
      assert.equal(withdrawContext(i.processor!, w, BigInt(t.scope)).toString(), t.context, t.name);
      viaRequest++;
    } else {
      // A deadline_ms past 2^53 has no exact JSON number in a JS client: the kit never builds one and the relayer
      // refuses one at check 1, never hashing a rounded value.
      assert.throws(() => withdrawContext(i.processor!, w, BigInt(t.scope)), /deadline_ms/, t.name);
    }
  }
  assert.equal(viaRequest, 29, "29 vectors through the relayer's own request path, 3 with a u64-max deadline");
});

test("a deadline_ms past 2^53 is refused at check 1, never rounded into a context", async () => {
  const r = req();
  r.withdrawal.deadline_ms = Number("18446744073709551615");
  refused(await run(r), "bad_shape", /deadline_ms/);
});

test("the fixture's scope is the vault's, and its context is the kit's vaultWithdrawRequest context for its withdrawal", () => {
  assert.equal(vaultScopeOf(keccak256, fixture.vault, fixture.token), CFG.scope);
  assert.equal(withdrawContext(CFG.vault, fixture.request.withdrawal, CFG.scope).toString(), fixture.request.public_signals[7]);
  // The kit's builder, with its own fresh salt: the relayer's recompute equals the context it hands the prover.
  const w = fixture.request.withdrawal;
  for (let k = 0; k < 4; k++) {
    const r = vaultWithdrawRequest({
      vaultId: CFG.vault,
      token: CFG.token,
      recipient: w.recipient,
      registerDeposit: BigInt(w.register_deposit),
      feeRecipient: w.fee_recipient,
      relayFee: BigInt(w.relay_fee),
      refundPrecommitment: BigInt(w.refund_precommitment),
      deadlineMs: w.deadline_ms,
      withdrawn: 3_000_000n,
      nowMs: w.deadline_ms - 600_000,
    });
    assert.equal(withdrawContext(CFG.vault, r.withdrawal, CFG.scope).toString(), r.context);
  }
});

// ---- A real proof passes; every single field it binds, flipped, is refused ----

test("a real withdraw proof passes checks 1-4, with every number carried as its value", async () => {
  const r = reads();
  const v = await run(req(), CFG, r);
  assert.equal(v.ok, true, v.ok ? "" : `${v.code}: ${v.why}`);
  if (!v.ok) return;
  const s = fixture.request.public_signals.map(BigInt);
  assert.equal(v.withdraw.existingNullifierHash, s[1]);
  assert.equal(v.withdraw.withdrawnValue, 3_000_000n);
  assert.equal(v.withdraw.context, s[7]);
  assert.equal(v.withdraw.relay_fee, FEE);
  assert.equal(v.withdraw.fund_recipient, true);
  assert.deepEqual(v.withdraw.withdrawal, fixture.request.withdrawal);
  assert.equal(r.calls, 1);
});

test("the vault's own fixture proof (contracts/vault/tests/fixtures/withdraw-proof.json) verifies, and its tampered copy does not", () => {
  const f = JSON.parse(readFileSync(join(ROOT, "contracts/vault/tests/fixtures/withdraw-proof.json"), "utf8")) as {
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
  };
  const p = { a: f.proof.pi_a.slice(0, 2), b: f.proof.pi_b.slice(0, 2), c: f.proof.pi_c.slice(0, 2) };
  const s = f.publicSignals.map(BigInt);
  assert.equal(verifyWithdrawProof(p, s), true);
  assert.equal(verifyWithdrawProof({ ...p, a: [p.a[0]!, next(p.a[1]!, VAULT_FIELD_Q)] }, s), false);
  assert.equal(verifyWithdrawProof(p, s.slice(0, 7)), false, "7 signals");
  assert.equal(verifyWithdrawProof(p, [...s.slice(0, 7), VAULT_FIELD_P + s[7]!]), false, "a signal not below p");
});

test("every withdrawal field, flipped alone, is refused at check 2 (bad_proof), the fee recipient included", async () => {
  const w = fixture.request.withdrawal;
  const flips: [keyof VaultWithdrawal, unknown][] = [
    ["recipient", "0".repeat(63) + "1"],
    ["recipient", "alice.near"],
    ["register_deposit", next(w.register_deposit, 1n << 128n)],
    ["register_deposit", "0"],
    ["fee_recipient", "other-relayer.near"],
    ["relay_fee", next(w.relay_fee, 1n << 128n)],
    ["relay_fee", "0"],
    ["refund_precommitment", next(w.refund_precommitment, VAULT_FIELD_P)],
    ["deadline_ms", w.deadline_ms + 1],
    ["deadline_ms", w.deadline_ms - 1],
    ["salt", (w.salt[0] === "0" ? "1" : "0") + w.salt.slice(1)],
    ["salt", w.salt.slice(0, 31) + (w.salt[31] === "f" ? "e" : "f")],
  ];
  for (const [k, value] of flips) {
    const r = req();
    (r.withdrawal as Record<string, unknown>)[k] = value;
    const rd = reads();
    refused(await run(r, CFG, rd), "bad_proof", /^context: /, `${k} = ${String(value)}`);
    assert.equal(rd.calls, 0, `${k}: no fee read before check 2 passed`);
  }
});

test("every public signal, flipped alone, is refused (bad_proof): context at check 2, the other seven at check 4", async () => {
  for (let i = 0; i < 8; i++) {
    const r = req();
    r.public_signals[i] = next(r.public_signals[i]!, i === 4 || i === 6 ? 33n : VAULT_FIELD_P);
    refused(await run(r), "bad_proof", i === 7 ? /^context: / : /^proof: does not verify/, `public_signals[${i}]`);
  }
  // The other way around: the context signal and the withdrawal changed together, so check 2 passes and check 4 refuses.
  const r = req();
  r.withdrawal.salt = "0".repeat(32);
  r.public_signals[7] = withdrawContext(CFG.vault, r.withdrawal, CFG.scope).toString();
  refused(await run(r), "bad_proof", /^proof: does not verify/, "a new salt with its own context");
});

test("every proof coordinate, flipped alone, is refused (bad_proof); b's c0 and c1 swapped is refused", async () => {
  const paths: [string, (r: Req) => [string[], number]][] = [
    ["a[0]", (r) => [r.proof.a, 0]],
    ["a[1]", (r) => [r.proof.a, 1]],
    ["b[0][0]", (r) => [r.proof.b[0], 0]],
    ["b[0][1]", (r) => [r.proof.b[0], 1]],
    ["b[1][0]", (r) => [r.proof.b[1], 0]],
    ["b[1][1]", (r) => [r.proof.b[1], 1]],
    ["c[0]", (r) => [r.proof.c, 0]],
    ["c[1]", (r) => [r.proof.c, 1]],
  ];
  for (const [name, at] of paths) {
    const r = req();
    const [arr, i] = at(r);
    arr[i] = next(arr[i]!, VAULT_FIELD_Q);
    refused(await run(r), "bad_proof", /^proof: does not verify/, name);
  }
  const r = req();
  r.proof.b = [
    [r.proof.b[0][1], r.proof.b[0][0]],
    [r.proof.b[1][1], r.proof.b[1][0]],
  ];
  refused(await run(r), "bad_proof", /^proof: does not verify/, "b as [c1, c0]");
  const s = req();
  [s.proof.a, s.proof.c] = [s.proof.c, s.proof.a];
  refused(await run(s), "bad_proof", /^proof: does not verify/, "a and c swapped");
});

test("(-A, -B, C) verifies too (Groth16 re-randomisation), so the verdict keys on the nullifier's value, never the proof", async () => {
  const r = req();
  r.proof.a = [r.proof.a[0], neg(r.proof.a[1])];
  r.proof.b = [r.proof.b[0], [neg(r.proof.b[1][0]), neg(r.proof.b[1][1])]];
  const v = await run(r);
  assert.equal(v.ok, true, v.ok ? "" : v.why);
  const base = await run(req());
  assert.ok(v.ok && base.ok && v.withdraw.existingNullifierHash === base.withdraw.existingNullifierHash);
  // -A alone, or -B alone, does not verify.
  const a = req();
  a.proof.a = [a.proof.a[0], neg(a.proof.a[1])];
  refused(await run(a), "bad_proof", /^proof: /, "-A alone");
  const b = req();
  b.proof.b = [b.proof.b[0], [neg(b.proof.b[1][0]), neg(b.proof.b[1][1])]];
  refused(await run(b), "bad_proof", /^proof: /, "-B alone");
});

test("points off the curve, at infinity, or outside G2's subgroup are refused, never thrown", async () => {
  const inf = req();
  inf.proof.a = ["0", "0"];
  refused(await run(inf), "bad_proof", /^proof: /, "A at infinity");
  // (1, 2) is BN254's G1 generator; (0, 0) in G2 is infinity; x = 1 off the twist.
  const off = req();
  off.proof.c = ["1", "3"];
  refused(await run(off), "bad_proof", /^proof: /, "C off the curve");
  // A point on the twist outside the r-order subgroup: found below by trying x = (k, 0) until y^2 has a root.
  const { bn254 } = await import("@noble/curves/bn254.js");
  const { Fp2 } = bn254.fields;
  const b3 = Fp2.div(Fp2.fromBigTuple([3n, 0n]), Fp2.fromBigTuple([9n, 1n]));
  let found: { x: bigint[]; y: bigint[] } | undefined;
  for (let k = 1n; k < 200n && !found; k++) {
    const x = Fp2.fromBigTuple([k, 0n]);
    const y2 = Fp2.add(Fp2.mul(Fp2.sqr(x), x), b3);
    let y;
    try {
      y = Fp2.sqrt(y2);
    } catch {
      continue;
    }
    const p = bn254.G2.Point.fromAffine({ x, y });
    if (!p.isTorsionFree()) {
      found = { x: [x.c0, x.c1], y: [y.c0, y.c1] };
      // On the twist, so only the subgroup test refuses it.
      assert.throws(() => p.assertValidity(), /not in prime-order subgroup/);
    }
  }
  assert.ok(found, "a twist point outside the subgroup");
  const sub = req();
  sub.proof.b = [found.x.map(String) as [string, string], found.y.map(String) as [string, string]];
  refused(await run(sub), "bad_proof", /^proof: /, "B outside G2's subgroup");
});

// ---- Check 1: shape ----

test("check 1 refuses every malformed request with bad_shape, before any read", async () => {
  const P = VAULT_FIELD_P.toString();
  const Q = VAULT_FIELD_Q.toString();
  const s = fixture.request.public_signals;
  const cases: [string, (r: Req & Record<string, unknown>) => unknown][] = [
    ["body null", () => null],
    ["body an array", () => []],
    ["body a string", () => JSON.stringify(req())],
    ["an extra field", (r) => ({ ...r, memo: "x" })],
    ["a __proto__ field", (r) => JSON.parse(JSON.stringify(r).replace("{", '{"__proto__":{},'))],
    ["withdrawal missing", (r) => ({ ...r, withdrawal: undefined })],
    ["proof missing", ({ proof: _, ...r }) => r],
    ["token missing", ({ token: _, ...r }) => r],
    ["token another", (r) => ({ ...r, token: "usdc.fakes.near" })],
    ["fund_recipient a string", (r) => ({ ...r, fund_recipient: "true" })],
    ["withdrawal an extra field", (r) => ({ ...r, withdrawal: { ...r.withdrawal, processor: CFG.vault } })],
    ["withdrawal a missing field", (r) => ({ ...r, withdrawal: { ...r.withdrawal, salt: undefined } })],
    ["recipient in uppercase hex", (r) => ((r.withdrawal.recipient = r.withdrawal.recipient.toUpperCase()), r)],
    ["recipient with a space", (r) => ((r.withdrawal.recipient = ` ${r.withdrawal.recipient}`), r)],
    ["fee_recipient not an id", (r) => ((r.withdrawal.fee_recipient = "Relayer!"), r)],
    ["register_deposit with a leading zero", (r) => ((r.withdrawal.register_deposit = `0${r.withdrawal.register_deposit}`), r)],
    ["register_deposit 2^128", (r) => ((r.withdrawal.register_deposit = String(1n << 128n)), r)],
    ["register_deposit a number", (r) => (((r.withdrawal as Record<string, unknown>).register_deposit = 0), r)],
    ["relay_fee negative", (r) => ((r.withdrawal.relay_fee = "-1"), r)],
    ["relay_fee with a plus", (r) => ((r.withdrawal.relay_fee = "+30000"), r)],
    ["relay_fee in hex", (r) => ((r.withdrawal.relay_fee = "0x7530"), r)],
    ["refund_precommitment 0", (r) => ((r.withdrawal.refund_precommitment = "0"), r)],
    ["refund_precommitment p", (r) => ((r.withdrawal.refund_precommitment = P), r)],
    ["refund_precommitment with a leading zero", (r) => ((r.withdrawal.refund_precommitment = `0${r.withdrawal.refund_precommitment}`), r)],
    ["deadline_ms a string", (r) => (((r.withdrawal as Record<string, unknown>).deadline_ms = String(r.withdrawal.deadline_ms)), r)],
    ["deadline_ms negative", (r) => ((r.withdrawal.deadline_ms = -1), r)],
    ["deadline_ms a fraction", (r) => ((r.withdrawal.deadline_ms = 1.5), r)],
    ["deadline_ms past 2^53", (r) => ((r.withdrawal.deadline_ms = 2 ** 53), r)],
    ["salt in uppercase", (r) => ((r.withdrawal.salt = r.withdrawal.salt.toUpperCase().replace(/^[0-9]/, "A")), r)],
    ["salt 31 characters", (r) => ((r.withdrawal.salt = r.withdrawal.salt.slice(1)), r)],
    ["salt with 0x", (r) => ((r.withdrawal.salt = `0x${r.withdrawal.salt.slice(2)}`), r)],
    ["proof an extra field", (r) => ({ ...r, proof: { ...r.proof, protocol: "groth16" } })],
    ["proof with snarkjs's z coordinate", (r) => ((r.proof.a = [...r.proof.a, "1"] as unknown as [string, string]), r)],
    ["proof b of one pair", (r) => ((r.proof.b = [r.proof.b[0]] as unknown as Req["proof"]["b"]), r)],
    ["a coordinate q", (r) => ((r.proof.c[0] = Q), r)],
    ["a coordinate + q, the same point spelled again", (r) => ((r.proof.a[0] = String(BigInt(r.proof.a[0]) + VAULT_FIELD_Q)), r)],
    ["a coordinate with a leading zero", (r) => ((r.proof.b[1][0] = `0${r.proof.b[1][0]}`), r)],
    ["a coordinate a number", (r) => (((r.proof.a as unknown[])[1] = 1), r)],
    ["public_signals 7", (r) => ((r.public_signals = s.slice(0, 7)), r)],
    ["public_signals 9", (r) => ((r.public_signals = [...s, "1"]), r)],
    ["public_signals an object", (r) => ({ ...r, public_signals: { ...s } })],
    ["a signal p", (r) => ((r.public_signals[3] = P), r)],
    ["the nullifier with a leading zero (P1-1)", (r) => ((r.public_signals[1] = `0${s[1]}`), r)],
    ["the nullifier + p (P1-1's other spelling)", (r) => ((r.public_signals[1] = String(BigInt(s[1]!) + VAULT_FIELD_P)), r)],
    ["a signal a number", (r) => (((r.public_signals as unknown[])[2] = 3000000), r)],
    ["newCommitmentHash 0", (r) => ((r.public_signals[0] = "0"), r)],
    ["withdrawnValue 0", (r) => ((r.public_signals[2] = "0"), r)],
    ["withdrawnValue 2^128", (r) => ((r.public_signals[2] = String(1n << 128n)), r)],
    ["stateTreeDepth 33", (r) => ((r.public_signals[4] = "33"), r)],
    ["ASPTreeDepth 33", (r) => ((r.public_signals[6] = "33"), r)],
  ];
  for (const [name, make] of cases) {
    const rd = reads();
    refused(await run(make(req() as Req & Record<string, unknown>), CFG, rd), "bad_shape", undefined, name);
    assert.equal(rd.calls, 0, `${name}: no read`);
  }
  // fund_recipient may be missing or false here: H3.7 item 1 answers fund_recipient_wrong after these checks.
  for (const fr of [undefined, false]) {
    const r = req();
    if (fr === undefined) delete r.fund_recipient;
    else r.fund_recipient = fr;
    const v = await run(r);
    assert.ok(v.ok && v.withdraw.fund_recipient === fr, `fund_recipient ${String(fr)}`);
  }
});

// ---- Check 3: the fee ----

/** The request with `w` changed and its context recomputed, so check 2 passes and check 3 is reached. */
function withContext(change: (r: Req) => void): Req {
  const r = req();
  change(r);
  r.public_signals[7] = withdrawContext(CFG.vault, r.withdrawal, CFG.scope).toString();
  return r;
}

test("check 3 refuses a foreign fee recipient, the vault and intents.near included, before the fee read", async () => {
  for (const fr of ["other-relayer.near", CFG.vault, VAULT_CONSTANTS.INTENTS, "0".repeat(64), `x.${CFG.feeRecipient}`]) {
    const rd = reads(FEE + 1n);
    refused(await run(withContext((r) => (r.withdrawal.fee_recipient = fr)), CFG, rd), "bad_fee_recipient", undefined, fr);
    assert.equal(rd.calls, 0, `${fr}: refused before fee_min is read`);
  }
});

test("check 3 refuses a fee under fee_min and a fee over the vault's 5,000 bps backstop, at the exact edges", async () => {
  refused(await run(req(), CFG, reads(FEE + 1n)), "fee_too_low", undefined, "fee_min one above");
  assert.equal((await run(req(), CFG, reads(FEE))).ok, true, "fee_min equal");
  // relay_fee × 10,000 ≤ withdrawn × 5,000: withdrawn 3,000,000 allows up to 1,500,000.
  refused(await run(withContext((r) => (r.withdrawal.relay_fee = "1500001")), CFG, reads(0n)), "fee_above_cap", undefined, "1,500,001");
  const edge = await run(withContext((r) => (r.withdrawal.relay_fee = "1500000")), CFG, reads(0n));
  refused(edge, "bad_proof", /^proof: /, "1,500,000 is within the backstop, so check 4 is reached");
  // A fee at or above the amount is past the backstop too.
  refused(await run(withContext((r) => (r.withdrawal.relay_fee = "3000000")), CFG, reads(0n)), "fee_above_cap", undefined, "fee = amount");
});

test("a fee_min read that fails throws: nothing is sent on an unknown", async () => {
  await assert.rejects(checkWithdraw(req(), CFG, { feeMin: async () => Promise.reject(new Error("rpc down")) }), /rpc down/);
  await assert.rejects(checkWithdraw(req(), CFG, { feeMin: async () => -1n }), /feeMin/);
  await assert.rejects(checkWithdraw(req(), { ...CFG, scope: VAULT_FIELD_P }, reads()), /scope/);
});

test("check 2 uses the configured vault and scope: another vault, or another scope, refuses an honest proof", async () => {
  refused(await run(req(), { ...CFG, vault: "other-vault.near" }), "bad_proof", /^context: /, "another vault");
  refused(await run(req(), { ...CFG, scope: CFG.scope + 1n }), "bad_proof", /^context: /, "another scope");
});
