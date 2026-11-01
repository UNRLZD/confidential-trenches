// node --test packages/kit/test/vault-shapes.test.mjs: the vault's frozen shapes (src/vault/shapes.ts) against
// VT-U02's vectors (test/vectors/vault-v1.json) and the vault's own refusals.
// Anchors outside this code: this test's Keccak-256 against Keccak's published answers; scope and label vectors 1-5 against
// the values the Rust test contract of the gas proof matched byte for byte (research repo,
// proofs/g1-vault-gas/vectors/encodings.json, tests::vector_encodings_match); two context vectors against that
// contract's Borsh bytes for the older layout, with relay_fee and salt put where the frozen layout puts them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as S from "../src/vault/shapes.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/vault-v1.json", import.meta.url), "utf8"));
// Keccak-256: FIPS 202's Keccak-f[1600] with Keccak's own 0x01 padding, rate 136 bytes, written from the spec. The
// shapes take the hash as an argument; Node's official builds have no keccak-256 ("Digest method not supported").
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // r[x + 5y]
const rot = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
function keccak(data) {
  const padded = new Uint8Array((Math.floor(data.length / 136) + 1) * 136);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = Array(25).fill(0n);
  for (let o = 0; o < padded.length; o += 136) {
    for (let i = 0; i < 17; i++) for (let b = 7; b >= 0; b--) A[i] ^= BigInt(padded[o + 8 * i + b]) << BigInt(8 * b);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] ^= C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
      const B = Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(A[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= RC[r];
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((A[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}
const hex = (b) => Buffer.from(b).toString("hex");
const U128 = (1n << 128n) - 1n;
const U64 = (1n << 64n) - 1n;

const numbers = (i) => ({
  processor: i.processor,
  recipient: i.recipient,
  register_deposit: BigInt(i.register_deposit),
  fee_recipient: i.fee_recipient,
  relay_fee: BigInt(i.relay_fee),
  refund_precommitment: BigInt(i.refund_precommitment),
  deadline_ms: BigInt(i.deadline_ms),
  salt: i.salt,
});

test("this test's Keccak-256: Keccak's published answers for '' and 'abc', OpenSSL's for 200 'a's (two blocks)", () => {
  assert.equal(hex(keccak(new Uint8Array())), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(hex(keccak(new TextEncoder().encode("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  // OpenSSL 3.5.9's keccak-256 (Homebrew Node 24.22.1, 2026-11-01)
  assert.equal(hex(keccak(new TextEncoder().encode("a".repeat(200)))), "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
});

test("50 vectors: 8 scope, 10 label, 32 context", () => {
  assert.equal(V.version, "blindfill-vault-v1");
  assert.deepEqual([V.scope.length, V.label.length, V.context.length], [8, 10, 32]);
});

test("every scope vector recomputes: preimage, keccak, value", () => {
  for (const v of V.scope) {
    const pre = S.vaultScopePreimage(v.vault, v.asset);
    assert.equal(hex(pre), v.preimage_hex, v.vault);
    assert.equal(hex(keccak(pre)), v.keccak_hex, v.vault);
    assert.equal(S.vaultScopeOf(keccak, v.vault, v.asset).toString(), v.scope, v.vault);
  }
});

test("every label vector recomputes: preimage, keccak, value", () => {
  for (const v of V.label) {
    const pre = S.vaultLabelPreimage(BigInt(v.scope), BigInt(v.nonce));
    assert.equal(hex(pre), v.preimage_hex, v.nonce);
    assert.equal(hex(keccak(pre)), v.keccak_hex, v.nonce);
    assert.equal(S.vaultLabelOf(keccak, BigInt(v.scope), BigInt(v.nonce)).toString(), v.label, v.nonce);
  }
});

test("every context vector recomputes: preimage, keccak, value; the JSON request path gives the same bytes", () => {
  for (const v of V.context) {
    const c = numbers(v.input);
    const pre = S.vaultContextPreimage(c, BigInt(v.scope));
    assert.equal(hex(pre), v.preimage_hex, v.name);
    assert.equal(pre.length, 100 + c.processor.length + c.recipient.length + c.fee_recipient.length + 32, v.name);
    assert.equal(hex(keccak(pre)), v.keccak_hex, v.name);
    assert.equal(S.vaultContextOf(keccak, c, BigInt(v.scope)).toString(), v.context, v.name);
    if (c.deadline_ms <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const { processor, deadline_ms, ...rest } = v.input;
      const w = { ...rest, deadline_ms: Number(deadline_ms) };
      assert.equal(hex(S.vaultContextPreimage(S.vaultContextInput(processor, w), BigInt(v.scope))), v.preimage_hex, v.name);
    }
  }
});

test("scope and label vectors 1-5 equal the Rust test contract's checked values", () => {
  const rustScopes = [
    "5072219746749309470750818130492706027783139455468960929403255949759297921774",
    "16662280991785675369497844937667382859880671281709203477245988256153950627371",
    "14090770524410888430224531465369551299190548835170249055311171831321123385000",
    "20140971955816724150720695925831920467796116491617058689276657274348330201270",
    "9034959744937537139939941921384637516008514430191250421905699374517591735340",
  ];
  const rustLabels = [
    "4658404729088525114212902432163076279164051564274758828674194602518397827952",
    "21191667877100653879994570629138790103806258137606979449794495332957801757350",
    "6664887417991271485999758180436713535622031724821463201668337808157021070144",
    "14440030918343722459967934192161211715061971369022762455311673702646373551159",
    "21234485001799590847612286848541450892023551040792988963797719224933049675641",
  ];
  assert.deepEqual(V.scope.slice(0, 5).map((v) => v.scope), rustScopes);
  assert.deepEqual(V.label.slice(0, 5).map((v) => v.label), rustLabels);
});

test("context vectors 25 and 26 equal the Rust contract's Borsh bytes with relay_fee (u128 LE) and salt put in place", () => {
  // the older layout: ... fee_recipient, relay_fee_bps (u16 LE), refund_precommitment (32 BE), deadline_ms (u64 LE)
  const rust = [
    { i: 24, feeAt: 134, borsh: "140000007661756c742e626c696e6466696c6c2e6e6561724000000039383739336364393161336638373066623132366636363238353830386337653039346166636663346564613861393730663636343863646630646264366465000000000000000000000000000000001600000072656c617965722e626c696e6466696c6c2e6e656172e80300000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad200fcdaa3a1010000" },
    { i: 25, feeAt: 34, borsh: "020000006162020000006364ffffffffffffffffffffffffffffffff020000006566ffff30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000ffffffffffffffff" },
  ];
  for (const { i, feeAt, borsh } of rust) {
    const v = V.context[i];
    const b = Buffer.from(borsh, "hex");
    const fee = Buffer.alloc(16);
    fee.writeUInt16LE(b.readUInt16LE(feeAt), 0);
    const want = Buffer.concat([b.subarray(0, feeAt), fee, b.subarray(feeAt + 2), Buffer.alloc(16), Buffer.from(BigInt(v.scope).toString(16).padStart(64, "0"), "hex")]);
    assert.equal(v.preimage_hex, want.toString("hex"), v.name);
  }
});

test("VT-U02's cases are all present, and the two vectors that differ only in salt give two contexts", () => {
  const ins = V.context.map((v) => v.input);
  const has = (f, what) => assert.ok(ins.some(f), what);
  has((i) => i.register_deposit === "0", "register_deposit 0");
  has((i) => i.register_deposit !== "0", "register_deposit not 0");
  has((i) => i.relay_fee === "0", "relay_fee 0");
  has((i) => BigInt(i.relay_fee) === U128, "relay_fee 2^128 - 1");
  has((i) => i.deadline_ms === "0", "deadline_ms 0");
  has((i) => BigInt(i.deadline_ms) === U64, "deadline_ms u64::MAX");
  has((i) => i.salt === "0".repeat(32), "salt all zero");
  has((i) => i.salt === "f".repeat(32), "salt all 0xff");
  has((i) => [i.processor, i.recipient, i.fee_recipient].every((a) => a.length === 64), "64-character ids");
  const [a, b] = [V.context[2], V.context[3]];
  assert.notEqual(a.input.salt, b.input.salt);
  assert.deepEqual({ ...a.input, salt: "" }, { ...b.input, salt: "" });
  assert.equal(a.scope, b.scope);
  assert.notEqual(a.context, b.context);
});

test("swapping recipient and fee_recipient changes the context (the order is part of the freeze)", () => {
  const v = V.context[0];
  const c = numbers(v.input);
  const swapped = { ...c, recipient: c.fee_recipient, fee_recipient: c.recipient };
  assert.notEqual(S.vaultContextOf(keccak, swapped, BigInt(v.scope)).toString(), v.context);
  assert.deepEqual(S.VAULT_CONTEXT_FIELDS.map(([n]) => n), ["processor", "recipient", "register_deposit", "fee_recipient", "relay_fee", "refund_precommitment", "deadline_ms", "salt"]);
});

test("the deposit message: exactly precommitment and depositor, in that order, as the vault parses it", () => {
  assert.deepEqual([...S.VAULT_DEPOSIT_MESSAGE_FIELDS], ["precommitment", "depositor"]);
  const u = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  const m = S.vaultDepositMessage(S.VAULT_FIELD_P - 1n, u);
  assert.equal(m, `{"precommitment":"${S.VAULT_FIELD_P - 1n}","depositor":"${u}"}`);
  assert.deepEqual(Object.keys(JSON.parse(m)), ["precommitment", "depositor"]);
  assert.ok(Buffer.byteLength(m) <= S.VAULT_DEPOSIT_MESSAGE_MAX_BYTES);
  assert.throws(() => S.vaultDepositMessage(S.VAULT_FIELD_P, u), /precommitment/);
  assert.throws(() => S.vaultDepositMessage(-1n, u), /precommitment/);
  for (const bad of ["", "a", "Alice.near", "a..near", "a".repeat(65), "-a.near", "a b.near"]) {
    assert.throws(() => S.vaultDepositMessage(1n, bad), /depositor/, bad);
  }
});

test("every move into the vault is the moving account's own ft_transfer_call; no shape signs an ft_withdraw", () => {
  for (const id of ["U", "R", "V"]) {
    const c = S.VAULT_DEPOSIT_SIGNERS[id];
    assert.equal(c.method, "ft_transfer_call", id);
    assert.equal(c.receiver_id, "TOKEN", id);
    assert.equal(c.signed_as, "NEP-366 DelegateAction", id);
    assert.equal(c.deposit_yocto, 1n, id);
    assert.equal(c.gas_tgas, 180, id);
    assert.equal(c.signed_by_kit, true, id);
  }
  assert.deepEqual(Object.keys(S.VAULT_DEPOSIT_SIGNERS), ["U", "R", "V"]);
  assert.deepEqual(S.VAULT_ALSO_ACCEPTS.map((a) => [a.method, a.signed_by_kit]), [["ft_withdraw", false]]);
});

test("salt, numbers and ids are refused in every form the vault refuses", () => {
  const c = numbers(V.context[0].input);
  const scope = BigInt(V.context[0].scope);
  for (const salt of ["F".repeat(32), "0x" + "0".repeat(30), "0x" + "0".repeat(32), "0".repeat(31), "0".repeat(33), "g".repeat(32)]) {
    assert.throws(() => S.vaultContextPreimage({ ...c, salt }, scope), /salt/, salt);
  }
  assert.throws(() => S.vaultContextPreimage({ ...c, refund_precommitment: 0n }, scope), /refund_precommitment/);
  assert.throws(() => S.vaultContextPreimage({ ...c, refund_precommitment: S.VAULT_FIELD_P }, scope), /refund_precommitment/);
  assert.throws(() => S.vaultContextPreimage({ ...c, register_deposit: 1n << 128n }, scope), /register_deposit/);
  assert.throws(() => S.vaultContextPreimage({ ...c, relay_fee: -1n }, scope), /relay_fee/);
  assert.throws(() => S.vaultContextPreimage({ ...c, deadline_ms: 1n << 64n }, scope), /deadline_ms/);
  assert.throws(() => S.vaultContextPreimage({ ...c, recipient: "Bob.near" }, scope), /recipient/);
  assert.throws(() => S.vaultContextPreimage(c, S.VAULT_FIELD_P), /scope/);
  assert.throws(() => S.vaultLabelPreimage(1n, 1n << 64n), /nonce/);
  for (const d of ["", "01", "+1", "-1", "1e3", " 1", "1".repeat(79), (1n << 256n).toString()]) {
    assert.throws(() => S.vaultDecimal(d, "n"), /n: not/, d);
  }
  assert.equal(S.vaultDecimal("0", "n"), 0n);
  const w = { recipient: "a.near", register_deposit: "0", fee_recipient: "b.near", relay_fee: "1", refund_precommitment: "7", deadline_ms: 1, salt: "0".repeat(32) };
  assert.throws(() => S.vaultContextInput("v.near", { ...w, relay_fee: "01" }), /relay_fee/);
  assert.throws(() => S.vaultContextInput("v.near", { ...w, deadline_ms: -1 }), /deadline_ms/);
  assert.throws(() => S.vaultContextInput("v.near", { ...w, deadline_ms: 2 ** 53 }), /deadline_ms/);
});

test("snarkjs's proof becomes the vault's argument as written; a coordinate at q or a projective point is refused", () => {
  const p = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"], protocol: "groth16", curve: "bn128" };
  assert.deepEqual(S.vaultProof(p), { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] });
  assert.throws(() => S.vaultProof({ ...p, pi_a: [S.VAULT_FIELD_Q.toString(), "2", "1"] }), /below q/);
  assert.throws(() => S.vaultProof({ ...p, pi_a: ["01", "2", "1"] }), /canonical/);
  assert.throws(() => S.vaultProof({ ...p, pi_c: ["7", "8", "2"] }), /affine/);
  assert.equal(S.VAULT_WITHDRAW_SIGNALS.length, 8);
  assert.equal(S.VAULT_WITHDRAW_SIGNALS[7], "context");
  assert.deepEqual([...S.VAULT_RAGEQUIT_SIGNALS], ["commitment", "nullifierHash", "value", "label"]);
});

test("attached NEAR and the fee backstop follow 2.3 and 2.5.2 rows 8 and 14", () => {
  const e19 = 10n ** 19n;
  assert.equal(S.vaultPrepayYocto(false), 756n * e19);
  assert.equal(S.vaultPrepayYocto(true), 904n * e19);
  assert.equal(S.vaultWithdrawYocto(0n, 0n, false), 1099n * e19 + 1n);
  assert.equal(S.vaultWithdrawYocto(5n, 1n, true), 1247n * e19 + 5n + 2n);
  assert.equal(S.vaultRagequitYocto(3n), 864n * e19 + 3n + 1n);
  assert.equal(S.vaultRelayFeeWithinBackstop(50n, 100n), true);
  assert.equal(S.vaultRelayFeeWithinBackstop(51n, 100n), false);
  assert.equal(S.vaultRelayFeeWithinBackstop(U128 / 2n, U128), true);
  assert.equal(S.vaultRelayFeeWithinBackstop(U128 / 2n + 1n, U128), false);
});

test("events and constants: the frozen names and values", () => {
  assert.equal(S.VAULT_EVENT_STANDARD, "blindfill-vault");
  assert.equal(S.VAULT_EVENT_VERSION, "1.0.0");
  assert.deepEqual(Object.keys(S.VAULT_EVENTS), ["leaf_inserted", "deposited", "storage_prepaid", "withdrawn", "withdrawal_relayed", "ragequit", "payout", "refund_inserted"]);
  assert.equal(S.VAULT_CONSTANTS.TOKEN, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"); // gitleaks:allow (a public account id)
  assert.equal(S.VAULT_CONSTANTS.MIN_DEPOSIT, 1_000_000n);
  assert.equal(S.VAULT_CONSTANTS.MAX_RELAY_FEE_BPS, 5_000);
  assert.equal(S.VAULT_CONSTANTS.DEPOSIT_STORAGE_BYTES, 756);
  assert.equal(S.VAULT_CONSTANTS.REFUND_RESERVE_BYTES, 389);
  assert.equal(S.VAULT_FIELD_P % 2n ** 28n, 1n); // p - 1 is divisible by 2^28, BN254's scalar field
});

// Review round 1 (2026-11-01): the depositor rule, the event field lists and the withdrawal's own refusals.

test("the depositor is a lowercase 64-hex NEAR-implicit id, never a named id, an eth-implicit id, intents.near or the vault", () => {
  const u = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
  assert.equal(JSON.parse(S.vaultDepositMessage(1n, u)).depositor, u);
  for (const bad of ["alice.near", "0x" + "ab".repeat(20), "intents.near", "vault.confidential.unrlzd.near", u.toUpperCase(), u.slice(1), u + "0"]) {
    assert.throws(() => S.vaultDepositMessage(1n, bad), /depositor/, bad);
  }
});

test("every event's data fields, in order (VAULT_EVENTS), and data is an array of such objects", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(S.VAULT_EVENTS)), {
    leaf_inserted: ["tree", "index", "leaf", "root"],
    deposited: ["depositor", "commitment", "label", "value", "precommitment"],
    storage_prepaid: ["precommitment", "payer", "amount"],
    withdrawn: ["processor", "value", "spent_nullifier", "new_commitment"],
    withdrawal_relayed: ["relayer", "recipient", "amount", "fee", "refund_precommitment"],
    ragequit: ["ragequitter", "commitment", "label", "value"],
    payout: ["nullifier_hash", "delivered", "returned"],
    refund_inserted: ["nullifier_hash", "commitment", "label", "value"],
  });
  assert.equal(S.VAULT_EVENT_DATA, "array");
});

test("vaultWithdrawalProblems: every refusal of 2.5.2 rows 1, 2 and 8 the device can see before it proves", () => {
  const vault = "vault.confidential.unrlzd.near";
  const now = 1_793_750_000_000;
  const w = {
    recipient: "bob.near", register_deposit: "0", fee_recipient: "relayer.confidential.unrlzd.near", relay_fee: "30000",
    refund_precommitment: "7", deadline_ms: now + 600_000, salt: "0".repeat(32),
  };
  const p = (x, withdrawn = 1_000_000n) => S.vaultWithdrawalProblems({ ...w, ...x }, withdrawn, vault, now);
  assert.deepEqual(p({}), []);
  const has = (x, re, withdrawn) => assert.ok(p(x, withdrawn).some((m) => re.test(m)), `${JSON.stringify(x)} ${p(x, withdrawn)}`);
  has({ recipient: vault }, /recipient: the vault/);
  has({ fee_recipient: vault }, /fee_recipient: the vault/);
  has({ recipient: "intents.near" }, /recipient: intents\.near/);
  has({ fee_recipient: "intents.near" }, /fee_recipient: intents\.near/);
  has({ relay_fee: "500001" }, /relay_fee: over the backstop/);
  assert.deepEqual(p({ relay_fee: "500000" }), []);
  has({}, /withdrawn: 0/, 0n);
  has({}, /withdrawn: not a u128/, 1n << 128n);
  has({ deadline_ms: now - 1 }, /deadline_ms: passed/);
  has({ deadline_ms: 2 ** 53 }, /deadline_ms/);
  has({ salt: "A".repeat(32) }, /salt/);
  has({ salt: "0".repeat(30) }, /salt/);
  has({ refund_precommitment: "0" }, /refund_precommitment/);
  has({ register_deposit: "01" }, /register_deposit/);
  has({ recipient: "Bob.near" }, /recipient/);
});

// Card vault-withdraw-context (CO 2026-11-01): the withdrawal refusals the vault and the kit share. The vault's unit
// test (contracts/vault/tests/withdraw_vectors.rs) reads the same vectors and refuses each when it reads the call.
test("withdrawal_refusals: the kit refuses each shared vector with exactly its problem, and takes it without the key", () => {
  assert.equal(V.withdrawal_refusals.length, 1);
  for (const r of V.withdrawal_refusals) {
    const w = JSON.parse(r.json);
    assert.ok(r.key in w, r.name);
    const p = (x) => S.vaultWithdrawalProblems(x, 1_000_000n, "vault.confidential.unrlzd.near", 1_793_750_000_000);
    assert.deepEqual(p(w), [r.kit], r.name);
    const { [r.key]: _, ...rest } = w;
    assert.deepEqual(p(rest), [], `${r.name}: without the key`);
  }
});
