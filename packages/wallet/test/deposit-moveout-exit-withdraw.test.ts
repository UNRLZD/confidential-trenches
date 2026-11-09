// Card exit-withdraw (vault paper 2.12 step 6; SB-04's WM-10 vault leg, wallet.md l.1080): the exit tool's withdrawal,
// sent by the note's own arming account A_{l,j} with no relayer, and A's DeleteAccount to the typed account once its
// spend is settled. Both go through moveout.ts's one sealed signer: buildVaultWithdrawOut (one withdraw on a release's
// vault, relay_fee "0", recipient and fee_recipient the typed account) and buildDeleteOut (one DeleteAccount, action tag
// 7, only after the spend reads settled with reserve 0, A's USDC reads held at 0 and nothing under A in intents.near).
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { vaultContextInput, vaultContextOf, vaultScopeOf, vaultWithdrawYocto, type VaultWithdrawal } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import * as moveout from "../src/deposit/moveout.ts";

// RFC 8032 section 7.1 test 1's published key (never a wallet of anyone's); A is its implicit account
const SK = Uint8Array.from(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"));
const PK = ed25519.getPublicKey(SK);
const A = Buffer.from(PK).toString("hex");
const BH = base58.encode(new Uint8Array(32).fill(7));
const TO = "x-typed.testnet";
const NET = NEAR_NETWORKS.testnet;
const MAIN = NEAR_NETWORKS.mainnet;
const TGAS = 10n ** 12n;
const REG = 1_250_000_000_000_000_000_000n;
const WITHDRAWN = 1_000_000n;
const NH = 12345678901234567890n;
const key = () => ({ id: A, publicKey: PK, secretKey: SK.slice() });
const read = { height: 100, blockHash: BH, nonce: 41n, free: 10n ** 24n, gasPrice: 100_000_000n, a: A };

function request(vault: string, token: string, o: Partial<VaultWithdrawal> = {}) {
  const withdrawal: VaultWithdrawal = { recipient: TO, register_deposit: REG.toString(), fee_recipient: TO, relay_fee: "0", refund_precommitment: "77", deadline_ms: 1_900_000_000_000, salt: "ab".repeat(16), ...o };
  const context = vaultContextOf(keccak_256, vaultContextInput(vault, withdrawal), vaultScopeOf(keccak_256, vault, token));
  const proof = { a: ["1", "2"] as [string, string], b: [["3", "4"], ["5", "6"]] as [[string, string], [string, string]], c: ["7", "8"] as [string, string] };
  const publicSignals = ["11", NH.toString(), WITHDRAWN.toString(), "13", "2", "14", "1", context.toString()];
  return { withdrawal, proof, publicSignals };
}

test("buildVaultWithdrawOut: A signs one withdraw on the release vault, relay_fee 0, recipient and fee recipient the typed account, 300 Tgas and the vault's attachment, at A's nonce + 1", () => {
  const r = request(NET.vault, NET.usdc);
  const m = moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...r });
  assert.equal(m.receiver, NET.vault);
  assert.equal(m.nonce, 42n);
  assert.equal(m.amount, WITHDRAWN);
  assert.equal(m.calls.length, 1);
  const c = m.calls[0] as { method: string; args: Record<string, unknown>; gas: bigint; deposit: bigint };
  assert.equal(c.method, "withdraw");
  assert.equal(c.gas, 300n * TGAS);
  assert.equal(c.deposit, vaultWithdrawYocto(REG, 0n, true));
  assert.deepEqual(c.args, { withdrawal: r.withdrawal, proof: r.proof, public_signals: r.publicSignals });
  const signed = base64.decode(m.signed);
  const bytes = signed.subarray(0, signed.length - 65);
  assert.equal(m.hash, base58.encode(sha256(bytes)));
  assert.ok(ed25519.verify(signed.subarray(signed.length - 64), sha256(bytes), PK));
  assert.ok(Buffer.from(bytes).includes(Buffer.from(`"relay_fee":"0"`)) && Buffer.from(bytes).includes(Buffer.from(`"fee_recipient":"${TO}"`)));
});

test("buildVaultWithdrawOut refuses before any seal: a fee, another recipient or fee recipient, a vault that is no release's, a context that is not the request's, another gas or attachment, another key or read", () => {
  const ok = request(NET.vault, NET.usdc);
  const bad: [string, () => unknown][] = [
    ["a relay fee", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...request(NET.vault, NET.usdc, { relay_fee: "1" }) })],
    ["another recipient", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...request(NET.vault, NET.usdc, { recipient: "evil.testnet" }) })],
    ["another fee recipient", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...request(NET.vault, NET.usdc, { fee_recipient: "evil.testnet" }) })],
    ["A as the typed account", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: A, ...request(NET.vault, NET.usdc, { recipient: A, fee_recipient: A }) })],
    ["the vault as the typed account", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: NET.vault, ...request(NET.vault, NET.usdc, { recipient: NET.vault, fee_recipient: NET.vault }) })],
    ["intents.near as the typed account", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: "intents.near", ...request(NET.vault, NET.usdc, { recipient: "intents.near", fee_recipient: "intents.near" }) })],
    ["a vault that is no release's", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: "evil.testnet", to: TO, ...request("evil.testnet", NET.usdc) })],
    ["the token as vault", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.usdc, to: TO, ...request(NET.usdc, NET.usdc) })],
    ["a context of another vault", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...request(MAIN.vault, MAIN.usdc) })],
    ["a context of another request", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, withdrawal: { ...ok.withdrawal, salt: "cd".repeat(16) } })],
    ["seven signals", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, publicSignals: ok.publicSignals.slice(1) })],
    ["withdrawn 0", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, publicSignals: ok.publicSignals.map((s, i) => (i === 2 ? "0" : s)) })],
    ["a non-canonical signal", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, publicSignals: ok.publicSignals.map((s, i) => (i === 0 ? "011" : s)) })],
    ["a proof coordinate not a decimal", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, proof: { ...ok.proof, a: ["0x1", "2"] } })],
    ["a proof with another field", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, proof: { ...ok.proof, z: ["1", "1"] } as never })],
    ["a withdrawal with another field", () => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault, to: TO, ...ok, withdrawal: { ...ok.withdrawal, memo: "x" } as never })],
    ["a read of another account", () => moveout.buildVaultWithdrawOut({ read: { ...read, a: "b".repeat(64) }, key: key(), vault: NET.vault, to: TO, ...ok })],
    ["a nonce past a u64", () => moveout.buildVaultWithdrawOut({ read: { ...read, nonce: 2n ** 64n - 1n }, key: key(), vault: NET.vault, to: TO, ...ok })],
    ["another key", () => moveout.buildVaultWithdrawOut({ read, key: { ...key(), secretKey: new Uint8Array(32).fill(1) }, vault: NET.vault, to: TO, ...ok })],
  ];
  for (const [why, f] of bad) assert.throws(f, moveout.MoveOutRefused, why);
  // the calls the check seals: another gas, another attachment, another method, two calls
  const call = (o: Record<string, unknown> = {}) => [{ method: "withdraw" as const, args: { withdrawal: ok.withdrawal, proof: ok.proof, public_signals: ok.publicSignals }, gas: 300n * TGAS, deposit: vaultWithdrawYocto(REG, 0n, true), ...o }];
  moveout.checkVaultWithdrawCalls(A, NET.vault, TO, call());
  for (const [why, c] of [
    ["more gas", call({ gas: 301n * TGAS })],
    ["less attachment", call({ deposit: vaultWithdrawYocto(REG, 0n, true) - 1n })],
    ["ragequit", call({ method: "ragequit" })],
    ["two calls", [...call(), ...call()]],
    ["an extra arg", call({ args: { withdrawal: ok.withdrawal, proof: ok.proof, public_signals: ok.publicSignals, x: 1 } })],
  ] as const)
    assert.throws(() => moveout.checkVaultWithdrawCalls(A, NET.vault, TO, c as never), moveout.MoveOutRefused, why);
  // the caller's key is the caller's; the builder's copy is zeroed
  const own = SK.slice();
  moveout.buildVaultWithdrawOut({ read, key: { ...key(), secretKey: own }, vault: NET.vault, to: TO, ...ok });
  assert.deepEqual(own, SK);
});

const settled = { nullifierHash: NH, status: "settled" as const, reserve: 0n };
const del = (o: Partial<moveout.DeleteReadFor> = {}): moveout.DeleteReadFor => ({ a: A, to: TO, token: NET.usdc, height: 100, blockHash: BH, nonce: 43n, spend: settled, usdc: { state: "held", amount: 0n }, intents: null, ...o });

test("buildDeleteOut: once the spend reads settled with reserve 0, A's USDC held at 0 and nothing under A in intents.near, A signs one DeleteAccount (tag 7) on itself, its NEAR to the typed account", () => {
  const m = moveout.buildDeleteOut({ read: del(), key: key(), to: TO, token: NET.usdc, nullifierHash: NH });
  assert.equal(m.receiver, A);
  assert.equal(m.nonce, 44n);
  assert.equal(m.amount, 0n);
  assert.deepEqual(m.calls, [{ method: "DeleteAccount", beneficiary_id: TO }]);
  const signed = base64.decode(m.signed);
  const bytes = signed.subarray(0, signed.length - 65);
  assert.ok(ed25519.verify(signed.subarray(signed.length - 64), sha256(bytes), PK));
  // nearcore's Transaction V0: signer, key, nonce, receiver, block hash, then one action: tag 7 and the beneficiary
  const tail = Buffer.concat([Buffer.from([1, 0, 0, 0, 7]), Buffer.from(new Uint32Array([TO.length]).buffer), Buffer.from(TO)]);
  assert.ok(Buffer.from(bytes).subarray(bytes.length - tail.length).equals(tail), "the one action is DeleteAccount(the typed account)");
  // mainnet: what A holds inside intents.near read at 0
  const k = moveout.buildDeleteOut({ read: del({ token: MAIN.usdc, intents: 0n, to: "x-typed.near" }), key: key(), to: "x-typed.near", token: MAIN.usdc, nullifierHash: NH });
  assert.equal(k.receiver, A);
});

test("buildDeleteOut refuses: a delete before settle (in_flight, paid, refund_pending), reserve above 0, a halted USDC read, USDC left in A, money under A in intents.near or unread there on mainnet, another spend, another beneficiary", () => {
  const bad: [string, moveout.DeleteReadFor, string?][] = [
    ["before the withdrawal's payout", del({ spend: { ...settled, status: "in_flight" as never } })],
    ["paid, not settled", del({ spend: { ...settled, status: "paid" as never } })],
    ["refund_pending, not settled", del({ spend: { ...settled, status: "refund_pending" as never } })],
    ["settled with reserve above 0", del({ spend: { ...settled, reserve: 1n } })],
    ["USDC halted (a view that fails is not a zero)", del({ usdc: { state: "halted" } })],
    ["USDC halted, with a zero beside it", del({ usdc: { state: "halted", amount: 0n } as never })],
    ["USDC left in A", del({ usdc: { state: "held", amount: 1n } })],
    ["money under A in intents.near", del({ intents: 1n })],
    ["intents.near unread on mainnet", del({ token: MAIN.usdc, intents: null, to: "x-typed.near" }), "x-typed.near"],
    ["another spend's row", del({ spend: { ...settled, nullifierHash: NH + 1n } })],
    ["a read of another account", del({ a: "b".repeat(64) })],
    ["a read for another typed account", del({ to: "evil.testnet" })],
    ["a nonce past a u64", del({ nonce: 2n ** 64n - 1n })],
  ];
  for (const [why, r, to] of bad) {
    const tok = r.token;
    assert.throws(() => moveout.buildDeleteOut({ read: r, key: key(), to: to ?? TO, token: tok, nullifierHash: NH }), moveout.MoveOutRefused, why);
  }
  for (const [why, to] of [["A itself", A], ["the vault", NET.vault], ["intents.near", "intents.near"], ["the token", NET.usdc]] as const)
    assert.throws(() => moveout.buildDeleteOut({ read: del({ to }), key: key(), to, token: NET.usdc, nullifierHash: NH }), moveout.MoveOutRefused, why);
  // the check: one DeleteAccount, its beneficiary the typed account and nothing else
  moveout.checkDeleteCalls(A, TO, NET.usdc, [{ method: "DeleteAccount", beneficiary_id: TO }]);
  for (const [why, c] of [
    ["another beneficiary", [{ method: "DeleteAccount", beneficiary_id: "evil.testnet" }]],
    ["two deletes", [{ method: "DeleteAccount", beneficiary_id: TO }, { method: "DeleteAccount", beneficiary_id: TO }]],
    ["an extra field", [{ method: "DeleteAccount", beneficiary_id: TO, gas: 1n }]],
    ["a beneficiary that is no string", [{ method: "DeleteAccount", beneficiary_id: new String(TO) }]],
  ] as const)
    assert.throws(() => moveout.checkDeleteCalls(A, TO, NET.usdc, c as never), moveout.MoveOutRefused, why);
  const own = SK.slice();
  moveout.buildDeleteOut({ read: del(), key: { ...key(), secretKey: own }, to: TO, token: NET.usdc, nullifierHash: NH });
  assert.deepEqual(own, SK);
});

/** The module with its private signer exported, loaded from a copy (deposit-moveout-signers.test.ts's probe). */
async function probe(): Promise<typeof moveout & { signMoveTx: (publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, blockHash: string, move: unknown) => { hash: string; signed: string } }> {
  const FILE = new URL("../src/deposit/moveout.ts", import.meta.url);
  const SRC = readFileSync(FILE, "utf8");
  const src = `${SRC.replace(/from "(\.{1,2}\/[^"]+)"/g, (_, p: string) => `from "${new URL(p, FILE).href}"`).replace(/from "([^".][^"]*)"/g, (_, p: string) => `from "${import.meta.resolve(p)}"`)}\nexport { signMoveTx };\n`;
  const dir = mkdtempSync(path.join(tmpdir(), "moveout-probe-"));
  try {
    const f = path.join(dir, "moveout-probe.ts");
    writeFileSync(f, src);
    return await import(pathToFileURL(f).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the signer signs a DeleteAccount only as checkDeleteCalls sealed it: an unsealed one, one naming another beneficiary, one on another receiver, one riding with a call are refused", async () => {
  const m = await probe();
  const sealed = m.checkDeleteCalls(A, TO, NET.usdc, [{ method: "DeleteAccount", beneficiary_id: TO }]);
  assert.equal(sealed.receiver, A);
  m.signMoveTx(PK, SK, 1n, BH, sealed);
  const refused = (move: unknown, why: string) => assert.throws(() => m.signMoveTx(PK, SK, 1n, BH, move), /not one a check of this module passed/, why);
  refused({ signer: A, receiver: A, calls: [{ method: "DeleteAccount", beneficiary_id: TO }] }, "an unsealed DeleteAccount");
  refused({ signer: A, receiver: A, calls: [{ method: "DeleteAccount", beneficiary_id: "evil.testnet" }] }, "an unsealed DeleteAccount to another beneficiary");
  refused({ ...sealed, receiver: NET.vault }, "a sealed delete's copy on another receiver");
  assert.throws(() => Object.assign(sealed.calls[0]!, { beneficiary_id: "evil.testnet" }), TypeError);
  assert.throws(() => m.checkDeleteCalls(A, TO, NET.usdc, [{ method: "DeleteAccount", beneficiary_id: "evil.testnet" }]), m.MoveOutRefused);
  // a function-call check never seals a call named DeleteAccount, so no FunctionCall reaches tag 7 and no delete tag 2
  assert.throws(() => m.checkSettleCalls(A, NET.vault, [{ method: "DeleteAccount" as never, args: { nullifier_hash: "5" }, gas: 150n * TGAS, deposit: 0n }], "paid"), m.MoveOutRefused);
});
