// Card exit-withdraw (vault paper 2.12 step 6; SB-04's WM-10 vault leg, wallet.md l.1080): the exit tool's withdrawal,
// sent by the note's own arming account A_{l,j} with no relayer, and A's DeleteAccount to the typed account once its
// spend is settled. Both go through moveout.ts's one sealed signer: buildVaultWithdrawOut (one withdraw on a release's
// vault, relay_fee "0", recipient and fee_recipient the typed account, register_deposit the token's minimum, checked at
// the vault's block time) and buildDeleteOut (one DeleteAccount, action tag 7 told apart by its shape, only to a typed
// account that exists, after the spend reads settled with reserve 0 past its refunds, the withdraw tx FINAL, A's USDC
// held at 0 and nothing under A in intents.near). Each refusal names the guard that fired.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { VAULT_FIELD_Q, vaultContextInput, vaultContextOf, vaultScopeOf, vaultWithdrawYocto, type VaultWithdrawal } from "@blindfill/kit";
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
const NOW = 1_800_000_000_000;
const key = () => ({ id: A, publicKey: PK, secretKey: SK.slice() });
const read = { height: 100, blockHash: BH, nonce: 41n, free: 10n ** 24n, gasPrice: 100_000_000n, a: A };

function request(vault: string, token: string, o: Partial<VaultWithdrawal> = {}) {
  const withdrawal: VaultWithdrawal = { recipient: TO, register_deposit: REG.toString(), fee_recipient: TO, relay_fee: "0", refund_precommitment: "77", deadline_ms: NOW + 500_000, salt: "ab".repeat(16), ...o };
  const context = vaultContextOf(keccak_256, vaultContextInput(vault, withdrawal), vaultScopeOf(keccak_256, vault, token));
  const proof = { a: ["1", "2"] as [string, string], b: [["3", "4"], ["5", "6"]] as [[string, string], [string, string]], c: ["7", "8"] as [string, string] };
  const publicSignals = ["11", NH.toString(), WITHDRAWN.toString(), "13", "2", "14", "1", context.toString()];
  return { withdrawal, proof, publicSignals };
}
const wd = (o: Partial<Parameters<typeof moveout.buildVaultWithdrawOut>[0]> = {}) => moveout.buildVaultWithdrawOut({ read, key: key(), vault: NET.vault!, to: TO, ...request(NET.vault!, NET.usdc), storageMin: REG, registered: false, nowMs: NOW, ...o });

test("buildVaultWithdrawOut: A signs one withdraw on the release vault, relay_fee 0, recipient and fee recipient the typed account, the token's minimum as register_deposit, 300 Tgas and the vault's attachment, at A's nonce + 1", () => {
  const r = request(NET.vault!, NET.usdc);
  const m = wd();
  assert.equal(m.receiver, NET.vault);
  assert.equal(m.nonce, 42n);
  assert.equal(m.amount, WITHDRAWN);
  assert.equal(m.calls.length, 1);
  const c = m.calls[0]!;
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

test("buildVaultWithdrawOut refuses before any seal, each at its own guard", () => {
  const ok = request(NET.vault!, NET.usdc);
  const Q = VAULT_FIELD_Q.toString();
  const bad: [string, () => unknown, RegExp][] = [
    ["a relay fee", () => wd(request(NET.vault!, NET.usdc, { relay_fee: "1" })), /the fee is 0/],
    ["another recipient", () => wd(request(NET.vault!, NET.usdc, { recipient: "evil.testnet" })), /recipient and the fee recipient are the typed account/],
    ["another fee recipient", () => wd(request(NET.vault!, NET.usdc, { fee_recipient: "evil.testnet" })), /recipient and the fee recipient are the typed account/],
    ["A as the typed account", () => wd({ to: A, ...request(NET.vault!, NET.usdc, { recipient: A, fee_recipient: A }) }), /typed account is U or the token/],
    ["the vault as the typed account", () => wd({ to: NET.vault!, ...request(NET.vault!, NET.usdc, { recipient: NET.vault!, fee_recipient: NET.vault! }) }), /the vault or intents.near/],
    ["intents.near as the typed account", () => wd({ to: "intents.near", ...request(NET.vault!, NET.usdc, { recipient: "intents.near", fee_recipient: "intents.near" }) }), /the vault or intents.near/],
    ["mainnet's vault as the typed account on testnet", () => wd({ to: MAIN.vault, ...request(NET.vault!, NET.usdc, { recipient: MAIN.vault, fee_recipient: MAIN.vault }) }), /a release's vault or USDC, or under a vault/],
    ["an account under the vault", () => wd({ to: `x.${NET.vault}`, ...request(NET.vault!, NET.usdc, { recipient: `x.${NET.vault}`, fee_recipient: `x.${NET.vault}` }) }), /a release's vault or USDC, or under a vault/],
    ["a vault that is no release's", () => wd({ vault: "evil.testnet", ...request("evil.testnet", NET.usdc) }), /no release's vault/],
    ["the token as vault", () => wd({ vault: NET.usdc, ...request(NET.usdc, NET.usdc) }), /no release's vault/],
    ["a context of another vault", () => wd(request(MAIN.vault, MAIN.usdc)), /context is not this request's/],
    ["a context of another request", () => wd({ withdrawal: { ...ok.withdrawal, salt: "cd".repeat(16) } }), /context is not this request's/],
    ["1000 N as register_deposit", () => wd(request(NET.vault!, NET.usdc, { register_deposit: (1000n * 10n ** 24n).toString() })), /not 0 for a registered typed account, or the token's storage minimum/],
    ["register_deposit 0 for a typed account not registered", () => wd(request(NET.vault!, NET.usdc, { register_deposit: "0" })), /not 0 for a registered typed account, or the token's storage minimum/],
    ["the storage minimum for a registered typed account (NEP-145 refunds it to the keyless vault)", () => wd({ registered: true }), /not 0 for a registered typed account/],
    ["the registration not read", () => wd({ registered: undefined as never }), /registration on the token is not read/],
    ["no storage minimum read", () => wd({ storageMin: 0n }), /storage minimum is not read/],
    ["a deadline passed at the vault's block time", () => wd({ nowMs: NOW + 500_001 }), /deadline_ms: passed/],
    ["no block time", () => wd({ nowMs: -1 }), /block time is not read/],
    ["seven signals", () => wd({ publicSignals: ok.publicSignals.slice(1) }), /8 public signals/],
    ["withdrawn 0", () => wd({ publicSignals: ok.publicSignals.map((s, i) => (i === 2 ? "0" : s)) }), /withdrawn: 0/],
    ["a non-canonical signal", () => wd({ publicSignals: ok.publicSignals.map((s, i) => (i === 0 ? "011" : s)) }), /8 public signals/],
    ["a proof coordinate of q", () => wd({ proof: { ...ok.proof, a: [Q, "2"] } }), /below q/],
    ["a proof coordinate not a decimal", () => wd({ proof: { ...ok.proof, a: ["0x1", "2"] } }), /below q/],
    ["a proof with another field", () => wd({ proof: { ...ok.proof, z: ["1", "1"] } as never }), /three points/],
    ["a withdrawal with another field", () => wd({ withdrawal: { ...ok.withdrawal, memo: "x" } as never }), /seven fields/],
    ["a read of another account", () => wd({ read: { ...read, a: "b".repeat(64) } }), /not A's/],
    ["a nonce past a u64", () => wd({ read: { ...read, nonce: 2n ** 64n - 1n } }), /not A's, or its nonce/],
    ["another key", () => wd({ key: { ...key(), secretKey: new Uint8Array(32).fill(1) } }), /moving account's own/],
  ];
  for (const [why, f, re] of bad) assert.throws(f, (e: unknown) => e instanceof moveout.MoveOutRefused && re.test(e.message), why);
  // a registered typed account: register_deposit 0, so the vault makes no storage_deposit and attaches no NEAR for one
  const r0 = request(NET.vault!, NET.usdc, { register_deposit: "0" });
  const m0 = wd({ ...r0, registered: true });
  assert.equal((m0.calls[0]!.args.withdrawal as VaultWithdrawal).register_deposit, "0");
  assert.equal(m0.calls[0]!.deposit, vaultWithdrawYocto(0n, 0n, true));
  // q - 1 is a coordinate the vault parses
  wd({ proof: { ...ok.proof, a: [(VAULT_FIELD_Q - 1n).toString(), "2"] } });
  // the calls the check seals: another gas, another attachment, another method, two calls
  const call = (o: Record<string, unknown> = {}) => [{ method: "withdraw" as const, args: { withdrawal: ok.withdrawal, proof: ok.proof, public_signals: ok.publicSignals }, gas: 300n * TGAS, deposit: vaultWithdrawYocto(REG, 0n, true), ...o }];
  moveout.checkVaultWithdrawCalls(A, NET.vault!, TO, call(), REG, false, NOW);
  for (const [why, c, re] of [
    ["more gas", call({ gas: 301n * TGAS }), /gas and attachment/],
    ["less attachment", call({ deposit: vaultWithdrawYocto(REG, 0n, true) - 1n }), /gas and attachment/],
    ["ragequit", call({ method: "ragequit" }), /one withdraw call/],
    ["two calls", [...call(), ...call()], /one withdraw call/],
    ["an extra arg", call({ args: { withdrawal: ok.withdrawal, proof: ok.proof, public_signals: ok.publicSignals, x: 1 } }), /alone/],
  ] as const)
    assert.throws(() => moveout.checkVaultWithdrawCalls(A, NET.vault!, TO, c as never, REG, false, NOW), (e: unknown) => e instanceof moveout.MoveOutRefused && re.test(e.message), why);
  // the caller's key is the caller's; the builder's copy is zeroed
  const own = SK.slice();
  wd({ key: { ...key(), secretKey: own } });
  assert.deepEqual(own, SK);
});

const settled = { nullifierHash: NH, status: "settled" as const, reserve: 0n };
const del = (o: Partial<moveout.DeleteReadFor> = {}): moveout.DeleteReadFor => ({
  network: "testnet", a: A, to: TO, token: NET.usdc, height: 1000, blockHash: BH, nonce: 43n, beneficiary: "exists", spend: settled,
  usdc: { state: "held", amount: 0n }, intents: "no-intents", withdrawTx: "final", settleTx: "final", settledBack: null, nonceBack: null, settleNonce: 43n, ...o,
});
const close = (r: moveout.DeleteReadFor, o: { to?: string; token?: string; network?: "testnet" | "mainnet"; k?: ReturnType<typeof key> } = {}) =>
  moveout.buildDeleteOut({ read: r, key: o.k ?? key(), network: o.network ?? "testnet", to: o.to ?? TO, token: o.token ?? NET.usdc, nullifierHash: NH });

test("buildDeleteOut: on a read with nothing left behind, A signs one DeleteAccount (tag 7) on itself, its NEAR to the typed account", () => {
  const m = close(del());
  assert.equal(m.receiver, A);
  assert.equal(m.nonce, 44n);
  assert.equal(m.amount, 0n);
  assert.deepEqual(m.calls, [{ action: "DeleteAccount", beneficiary_id: TO }]);
  const signed = base64.decode(m.signed);
  const bytes = signed.subarray(0, signed.length - 65);
  assert.ok(ed25519.verify(signed.subarray(signed.length - 64), sha256(bytes), PK));
  // nearcore's Transaction V0: signer, key, nonce, receiver, block hash, then one action: tag 7 and the beneficiary
  const tail = Buffer.concat([Buffer.from([1, 0, 0, 0, 7]), Buffer.from(new Uint32Array([TO.length]).buffer), Buffer.from(TO)]);
  assert.ok(Buffer.from(bytes).subarray(bytes.length - tail.length).equals(tail), "the one action is DeleteAccount(the typed account)");
  // mainnet: intents.near read with no token under A; the spend read settled SETTLE_BLOCKS back, so neither tx hash is
  // needed (a reload lost them, or another settled it: the withdraw comes before the settle)
  close(del({ network: "mainnet", token: MAIN.usdc, to: "x-typed.near", intents: "empty", withdrawTx: "unread", settleTx: "none", settledBack: 1000 - moveout.SETTLE_BLOCKS, nonceBack: 43n }), { network: "mainnet", token: MAIN.usdc, to: "x-typed.near" });
});

test("closeRefundsRan: the lookback with A's nonce unmoved, or both txs FINAL with the settle A's last; never on a nonce that is not read", () => {
  const r = { height: 1000, nonce: 43n, withdrawTx: "unread", settleTx: "none", settledBack: 1000 - moveout.SETTLE_BLOCKS, nonceBack: 43n, settleNonce: null } as const;
  assert.equal(moveout.closeRefundsRan(r), true);
  assert.equal(moveout.closeRefundsRan({ ...r, withdrawTx: "final", settleTx: "final", settledBack: null, nonceBack: null, settleNonce: 43n }), true);
  // a read with no nonce now: never a match, even where both sides read null
  assert.equal(moveout.closeRefundsRan({ ...r, nonce: null as never, nonceBack: null }), false);
  assert.equal(moveout.closeRefundsRan({ ...r, nonce: null as never, withdrawTx: "final", settleTx: "final", settledBack: null, nonceBack: null, settleNonce: null }), false);
});

test("buildDeleteOut refuses, each at its own guard: a missing typed account, a delete before settle or its refunds, a halted or nonzero USDC, anything under A in intents.near, another network, token or spend", () => {
  const bad: [string, () => unknown, RegExp][] = [
    ["the typed account does not exist (P1: its NEAR would burn)", () => close(del({ beneficiary: "absent" })), /fund the typed account first/],
    ["the typed account not read", () => close(del({ beneficiary: "unread" as never })), /not read as existing/],
    ["before the withdrawal's payout", () => close(del({ spend: { ...settled, status: "in_flight" } })), /settled with reserve 0/],
    ["paid, not settled", () => close(del({ spend: { ...settled, status: "paid" } })), /settled with reserve 0/],
    ["refund_pending, not settled", () => close(del({ spend: { ...settled, status: "refund_pending" } })), /settled with reserve 0/],
    ["settled with reserve above 0", () => close(del({ spend: { ...settled, reserve: 1n } })), /settled with reserve 0/],
    ["the withdraw tx not FINAL (its refunds may still run), no lookback", () => close(del({ withdrawTx: "unread" })), /not read past their refunds/],
    ["A's settle not FINAL, no lookback", () => close(del({ settleTx: "unread" })), /not read past their refunds/],
    ["another's settle, no lookback", () => close(del({ settleTx: "none" })), /not read past their refunds/],
    ["settled too recently, no tx read", () => close(del({ withdrawTx: "unread", settleTx: "none", settledBack: 1000 - moveout.SETTLE_BLOCKS + 1, nonceBack: 43n })), /not read past their refunds/],
    ["a lookback at block 0", () => close(del({ withdrawTx: "unread", settleTx: "none", settledBack: 0, height: moveout.SETTLE_BLOCKS, nonceBack: 43n })), /not read past their refunds/],
    ["a lookback not a block", () => close(del({ withdrawTx: "unread", settleTx: "none", settledBack: 1.5, nonceBack: 43n })), /not read past their refunds/],
    // P3-2: A's own settle held back, another's settle first: A's held settle landed after the lookback block
    ["settled long ago, but A's nonce moved since the lookback", () => close(del({ withdrawTx: "unread", settleTx: "none", settledBack: 1000 - moveout.SETTLE_BLOCKS, nonceBack: 42n })), /not read past their refunds/],
    ["settled long ago, A's nonce at the lookback not read", () => close(del({ withdrawTx: "unread", settleTx: "none", settledBack: 1000 - moveout.SETTLE_BLOCKS, nonceBack: null })), /not read past their refunds/],
    ["both txs FINAL, but a later tx of A after its settle", () => close(del({ settleNonce: 42n })), /not read past their refunds/],
    ["both txs FINAL, the settle's nonce not read", () => close(del({ settleNonce: null })), /not read past their refunds/],
    ["USDC halted (a view that fails is not a zero)", () => close(del({ usdc: { state: "halted" } })), /USDC is not read at zero/],
    ["USDC halted, with a zero beside it", () => close(del({ usdc: { state: "halted", amount: 0n } as never })), /USDC is not read at zero/],
    ["USDC left in A", () => close(del({ usdc: { state: "held", amount: 1n } })), /USDC is not read at zero/],
    ["a token under A in intents.near", () => close(del({ intents: "holds" })), /stranded/],
    ["intents.near not read", () => close(del({ intents: null as never })), /stranded/],
    ["another spend's row", () => close(del({ spend: { ...settled, nullifierHash: NH + 1n } })), /not this withdrawal's/],
    ["a read of another account", () => close(del({ a: "b".repeat(64) })), /not of A/],
    ["a read for another typed account", () => close(del({ to: "evil.testnet" })), /not of this typed account/],
    ["a read for another token", () => close(del({ token: MAIN.usdc })), /not of this token/],
    ["a read of another network", () => close(del({ network: "mainnet" })), /not of this network/],
    ["testnet USDC named on mainnet (P2-1)", () => close(del({ network: "mainnet" }), { network: "mainnet" }), /not the network's USDC/],
    ["a nonce past a u64", () => close(del({ nonce: 2n ** 64n - 1n })), /height, nonce or block hash/],
  ];
  for (const [why, f, re] of bad) assert.throws(f, (e: unknown) => e instanceof moveout.MoveOutRefused && re.test(e.message), why);
  for (const [why, to, re] of [
    ["A itself", A, /U or the token/],
    ["the vault", NET.vault!, /vault or intents.near/],
    ["intents.near", "intents.near", /vault or intents.near/],
    ["the token", NET.usdc, /U or the token/],
    ["mainnet's vault (P2-1)", MAIN.vault, /a release's vault or USDC/],
    ["mainnet's USDC (P2-1)", MAIN.usdc, /a release's vault or USDC/],
    ["an account under the vault", `x.${NET.vault}`, /under a vault/],
    ["a name with a space", " alice.testnet", /not a NEAR account id/],
    ["an upper-case name", "Alice.testnet", /not a NEAR account id/],
    ["an empty name", "", /not a NEAR account id/],
  ] as const)
    assert.throws(() => close(del({ to }), { to }), (e: unknown) => e instanceof moveout.MoveOutRefused && re.test(e.message), why);
  // the check: one DeleteAccount, its beneficiary the typed account and nothing else
  moveout.checkDeleteCalls(A, TO, NET.usdc, [{ action: "DeleteAccount", beneficiary_id: TO }]);
  for (const [why, c] of [
    ["another beneficiary", [{ action: "DeleteAccount", beneficiary_id: "evil.testnet" }]],
    ["two deletes", [{ action: "DeleteAccount", beneficiary_id: TO }, { action: "DeleteAccount", beneficiary_id: TO }]],
    ["an extra field", [{ action: "DeleteAccount", beneficiary_id: TO, gas: 1n }]],
    ["a method in place of the action", [{ method: "DeleteAccount", beneficiary_id: TO }]],
    ["a beneficiary that is no string", [{ action: "DeleteAccount", beneficiary_id: new String(TO) }]],
  ] as const)
    assert.throws(() => moveout.checkDeleteCalls(A, TO, NET.usdc, c as never), /one DeleteAccount, its beneficiary the typed account/, why);
  const own = SK.slice();
  close(del(), { k: { ...key(), secretKey: own } });
  assert.deepEqual(own, SK);
});

/** The module with its private signer and seal exported, loaded from a copy (deposit-moveout-signers.test.ts's probe). */
async function probe(): Promise<typeof moveout & { signMoveTx: (publicKey: Uint8Array, secretKey: Uint8Array, nonce: bigint, blockHash: string, move: unknown) => { hash: string; signed: string }; seal: (move: unknown) => unknown }> {
  const FILE = new URL("../src/deposit/moveout.ts", import.meta.url);
  const SRC = readFileSync(FILE, "utf8");
  const src = `${SRC.replace(/from "(\.{1,2}\/[^"]+)"/g, (_, p: string) => `from "${new URL(p, FILE).href}"`).replace(/from "([^".][^"]*)"/g, (_, p: string) => `from "${import.meta.resolve(p)}"`)}\nexport { signMoveTx, seal };\n`;
  const dir = mkdtempSync(path.join(tmpdir(), "moveout-probe-"));
  try {
    const f = path.join(dir, "moveout-probe.ts");
    writeFileSync(f, src);
    return await import(pathToFileURL(f).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the signer signs tag 7 only for a sealed DeleteAccount, by its shape, alone and on the signer's own account; a method named DeleteAccount stays a FunctionCall", async () => {
  const m = await probe();
  const sealed = m.checkDeleteCalls(A, TO, NET.usdc, [{ action: "DeleteAccount", beneficiary_id: TO }]);
  assert.equal(sealed.receiver, A);
  m.signMoveTx(PK, SK, 1n, BH, sealed);
  const refused = (move: unknown, why: string) => assert.throws(() => m.signMoveTx(PK, SK, 1n, BH, move), /not one a check of this module passed/, why);
  refused({ signer: A, receiver: A, calls: [{ action: "DeleteAccount", beneficiary_id: TO }] }, "an unsealed DeleteAccount");
  refused({ signer: A, receiver: A, calls: [{ action: "DeleteAccount", beneficiary_id: "evil.testnet" }] }, "an unsealed DeleteAccount to another beneficiary");
  refused({ ...sealed, receiver: NET.vault }, "a sealed delete's copy on another receiver");
  assert.throws(() => Object.assign(sealed.calls[0]!, { beneficiary_id: "evil.testnet" }), TypeError);
  // the signer's own guard, behind the seal: a sealed delete on another receiver, two deletes, a delete with a call
  const D = { action: "DeleteAccount", beneficiary_id: TO };
  const F = { method: "settle", args: { nullifier_hash: "5" }, gas: 150n * TGAS, deposit: 0n };
  for (const [why, move] of [
    ["on another receiver", { signer: A, receiver: NET.vault, calls: [D] }],
    ["two deletes", { signer: A, receiver: A, calls: [D, D] }],
    ["a delete with a call", { signer: A, receiver: A, calls: [F, D] }],
  ] as const)
    assert.throws(() => m.signMoveTx(PK, SK, 1n, BH, m.seal(move)), /the one action, on the signer's own account/, why);
  // a FunctionCall whose method is the string "DeleteAccount" is signed as a FunctionCall (tag 2), never tag 7
  const named = m.seal({ signer: A, receiver: A, calls: [{ method: "DeleteAccount", args: {}, gas: 1n, deposit: 0n }] });
  const bytes = base64.decode(m.signMoveTx(PK, SK, 1n, BH, named).signed);
  const at = 4 + 64 + 1 + 32 + 8 + 4 + 64 + 32 + 4;
  assert.equal(bytes[at], 2, "a method name never makes tag 7");
});
