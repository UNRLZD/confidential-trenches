// WU-05 (docs/plan1/wallet.md:1044 at research ffcba5e), the deposit kinds: the deposit call (W:889) for U, R and V,
// the storage prepay (W:890) and the deposit quote (W:888). A good payload passes and each bad field is refused.
//   node --test test/rules-deposit.test.ts      (from packages/signpage)
// The good call is the wallet's own recorded signed delegate (packages/wallet/test/vectors/deposit-delegate.json, made by
// depositDelegate on U_{1,0} of the public test seed, 64 bytes of 0x42); R's and V's are built by the same encoder
// (encodeDelegateAction) from ids of that seed. The good quote is the kit's recorded dry 1Click answer, which names
// the placeholder 64-hex id "ab" x 32 as recipient and refundTo.
/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkOneClickQuote, ONECLICK_SIGNING_KEYS, OneClickQuoteError, type OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { refundId, returnId, depositId } from "../../wallet/src/derive/keys.ts";
import { encodeDelegateAction, RELEASE_BIND_URL, type DelegateFields } from "../../wallet/src/deposit/delegate.ts";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";
import {
  checkDepositCall,
  checkDepositQuote,
  DEPOSIT_GAS,
  DepositRuleRefused,
  type DepositCallContext,
  type DepositQuoteContext,
  type DepositRead,
} from "../src/rules/deposit.ts";
import { VAULT_TOKEN_CODE_HASH } from "../../kit/src/vault/shapes.ts";

const vector = JSON.parse(readFileSync(new URL("../../wallet/test/vectors/deposit-delegate.json", import.meta.url), "utf8")) as {
  input: { s: string; i: number; amount: string; precommitment: string; window: number; read: { nonce: number; height: number } };
  signed_delegate: string;
  expect: { public_key: string };
};
const quotes = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-quotes.json", import.meta.url), "utf8")) as {
  dry: { request: OneClickRequest; answer: { timestamp: string } & Record<string, unknown> };
};
// A real keyless dry answer for 1 USDC from Solana: its minAmountOut 984,526 is under MIN_DEPOSIT (its source in the file; kept beside the kit's 1Click answers, where the gitleaks allowlist takes a signature field).
const small = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/deposit-quote-1usdc.json", import.meta.url), "utf8")) as {
  request: OneClickRequest; answer: { timestamp: string; quote: { minAmountOut: string } } & Record<string, unknown>;
};

const SEED = new Uint8Array(64).fill(0x42); // the wallet's public test seed (its vectors' made_by)
const TOKEN = NEAR_NETWORKS.testnet.token;
const VAULT = NEAR_NETWORKS.testnet.vault as string;
const ATTACKER = "cd".repeat(32);

type Id = { name: string; id: string; publicKey: Uint8Array };
const pick = (name: string, o: { id: string; publicKey: Uint8Array; secretKey: Uint8Array }): Id => {
  o.secretKey.fill(0);
  return { name, id: o.id, publicKey: o.publicKey };
};
const U = pick("U", depositId(SEED, BigInt(vector.input.s), vector.input.i));
const R = pick("R", returnId(SEED, "sol", 3n, 0));
const V = pick("V", refundId(SEED, 3n, 1));
// base58 (Bitcoin alphabet) for the reads' key strings, anchored below on the vector's own ed25519:<base58> of U's key.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(b: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`), s = "";
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (let k = 0; k < b.length && b[k] === 0; k++) s = `1${s}`;
  return s;
}
const keyOf = (x: Id) => `ed25519:${b58(x.publicKey)}`;

const P = BigInt(vector.input.precommitment);
const AMOUNT = BigInt(vector.input.amount);
const NONCE = BigInt(vector.input.read.nonce);
const HEIGHT = BigInt(vector.input.read.height);

function read(x: Id, over: Partial<DepositRead> = {}): DepositRead {
  return {
    height: HEIGHT, keys: [keyOf(x)], nonce: NONCE, balance: AMOUNT, vaultRegistered: true, codeHash: VAULT_TOKEN_CODE_HASH,
    pausePending: false, precommitmentInVault: false, priorInVault: true, ...over,
  };
}
function ctx(x: Id, over: Partial<DepositCallContext> = {}): DepositCallContext {
  return {
    network: "testnet", signer: { id: x.id, publicKey: x.publicKey }, note: { precommitment: P, amount: AMOUNT },
    reads: [read(x), read(x, { height: HEIGHT + 3n })], route: RELEASE_BIND_URL, ...over,
  };
}
const argsOf = (x: Id, amount = AMOUNT, msg?: string, vault = VAULT): string =>
  JSON.stringify({ receiver_id: vault, amount: amount.toString(), msg: msg ?? JSON.stringify({ precommitment: P.toString(), depositor: x.id }) });
function fields(x: Id, over: Partial<DelegateFields> = {}): DelegateFields {
  return {
    sender_id: x.id, receiver_id: TOKEN, method_name: "ft_transfer_call", args: new TextEncoder().encode(argsOf(x)),
    gas: 180_000_000_000_000n, deposit: 1n, nonce: NONCE + 1n, max_block_height: HEIGHT + 120n, public_key: x.publicKey, ...over,
  };
}
const good = (x: Id, over: Partial<DelegateFields> = {}) => encodeDelegateAction(fields(x, over));

// borsh(DelegateAction) with any actions, each given as its own borsh bytes (tag first): the shapes encodeDelegateAction
// cannot make.
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return [...b]; };
const le = (v: bigint, n: number) => Array.from({ length: n }, (_, k) => Number((v >> BigInt(8 * k)) & 0xffn));
const str = (s: string) => { const b = new TextEncoder().encode(s); return [...u32(b.length), ...b]; };
const functionCall = (method: string, args: string, gas = 180_000_000_000_000n, deposit = 1n) =>
  [2, ...str(method), ...str(args), ...le(gas, 8), ...le(deposit, 16)];
function raw(x: Id, actions: number[][], receiver = TOKEN): Uint8Array {
  return Uint8Array.from([
    ...str(x.id), ...str(receiver), ...u32(actions.length), ...actions.flat(), ...le(NONCE + 1n, 8), ...le(HEIGHT + 120n, 8), 0, ...x.publicKey,
  ]);
}

function refused(rule: string, f: () => unknown): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof DepositRuleRefused, `expected a refusal, got ${String(e)}`);
    assert.equal(e.code, "not_allowed");
    assert.equal(e.rule, rule);
    return true;
  });
}

test("the wallet's recorded signed deposit call from U passes the rule as signed", () => {
  assert.equal(keyOf(U), vector.expect.public_key);
  const signed = new Uint8Array(Buffer.from(vector.signed_delegate, "base64"));
  const delegate = signed.subarray(0, signed.length - 65); // borsh(SignedDelegateAction) = delegate || 0 || 64-byte signature
  const d = checkDepositCall(delegate, ctx(U));
  assert.equal(d.sender_id, U.id);
  assert.equal(d.receiver_id, TOKEN);
  assert.equal(d.gas, DEPOSIT_GAS);
  assert.equal(d.max_block_height, HEIGHT + 120n);
});

for (const x of [U, R, V]) {
  test(`${x.name}'s deposit call: the good one signs, each bad field is refused`, () => {
    assert.equal(checkDepositCall(good(x), ctx(x)).sender_id, x.id);
    // the earlier call's nonce while it has not landed signs too
    assert.equal(checkDepositCall(good(x, { nonce: NONCE + 1n }), ctx(x, { unlandedNonce: NONCE + 1n })).nonce, NONCE + 1n);

    refused("receiver_id", () => checkDepositCall(good(x, { receiver_id: "usdc.fakes.testnet" }), ctx(x)));
    refused("sender_id", () => checkDepositCall(good(x, { sender_id: ATTACKER }), ctx(x)));
    refused("public_key", () => checkDepositCall(good(x, { public_key: new Uint8Array(32).fill(7) }), ctx(x)));
    refused("method", () => checkDepositCall(good(x, { method_name: "ft_transfer" }), ctx(x)));
    refused("actions", () => checkDepositCall(raw(x, [functionCall("ft_transfer_call", argsOf(x)), functionCall("ft_transfer_call", argsOf(x))]), ctx(x)));
    refused("actions", () => checkDepositCall(raw(x, []), ctx(x)));
    refused("action", () => checkDepositCall(raw(x, [[3, ...le(1n, 16)]]), ctx(x))); // a Transfer
    refused("deposit", () => checkDepositCall(good(x, { deposit: 0n }), ctx(x)));
    refused("deposit", () => checkDepositCall(good(x, { deposit: 2n }), ctx(x)));
    refused("gas", () => checkDepositCall(good(x, { gas: 179_999_999_999_999n }), ctx(x)));
    refused("gas", () => checkDepositCall(good(x, { gas: 300_000_000_000_000n }), ctx(x)));
    // the amount: above the balance on either RPC, below MIN_DEPOSIT, other than this note's
    refused("balance", () => checkDepositCall(good(x), ctx(x, { reads: [read(x), read(x, { balance: AMOUNT - 1n })] })));
    refused("balance", () => checkDepositCall(good(x), ctx(x, { reads: [read(x, { balance: AMOUNT - 1n }), read(x)] })));
    const small = 999_999n;
    refused("amount", () =>
      checkDepositCall(good(x, { args: new TextEncoder().encode(argsOf(x, small)) }), ctx(x, { note: { precommitment: P, amount: small } })));
    refused("args.amount", () => checkDepositCall(good(x, { args: new TextEncoder().encode(argsOf(x, AMOUNT - 1n)) }), ctx(x)));
    // msg: another depositor, another key, another P, not a string
    const enc = (s: string) => new TextEncoder().encode(s);
    refused("msg.depositor", () =>
      checkDepositCall(good(x, { args: enc(argsOf(x, AMOUNT, JSON.stringify({ precommitment: P.toString(), depositor: ATTACKER }))) }), ctx(x)));
    refused("msg", () =>
      checkDepositCall(good(x, { args: enc(argsOf(x, AMOUNT, JSON.stringify({ precommitment: P.toString(), depositor: x.id, memo: "x" }))) }), ctx(x)));
    refused("msg.precommitment", () =>
      checkDepositCall(good(x, { args: enc(argsOf(x, AMOUNT, JSON.stringify({ precommitment: (P + 1n).toString(), depositor: x.id }))) }), ctx(x)));
    refused("msg", () => checkDepositCall(good(x, { args: enc(JSON.stringify({ receiver_id: VAULT, amount: AMOUNT.toString(), msg: { precommitment: P.toString(), depositor: x.id } })) }), ctx(x)));
    // args: another vault, a fourth key, another spelling of the same call, a repeated key
    refused("args.receiver_id", () => checkDepositCall(good(x, { args: enc(argsOf(x, AMOUNT, undefined, "vault.attacker.testnet")) }), ctx(x)));
    refused("args", () => checkDepositCall(good(x, { args: enc(JSON.stringify({ ...JSON.parse(argsOf(x)), memo: null })) }), ctx(x)));
    refused("args", () => checkDepositCall(good(x, { args: enc(JSON.stringify(JSON.parse(argsOf(x)), null, 1)) }), ctx(x)));
    refused("args", () => checkDepositCall(good(x, { args: enc(argsOf(x).replace("{", `{"receiver_id":"vault.attacker.testnet",`)) }), ctx(x)));
    // the height bound: one block past the window, and more than 600 past the lower height
    refused("max_block_height", () => checkDepositCall(good(x, { max_block_height: HEIGHT + 121n }), ctx(x)));
    refused("max_block_height", () => checkDepositCall(good(x, { max_block_height: HEIGHT + 601n }), ctx(x)));
    refused("max_block_height", () => checkDepositCall(good(x, { max_block_height: HEIGHT + 123n }), ctx(x))); // the higher height's + 120
    // the nonce: other than the key nonce + 1 or the unlanded call's, or the two RPCs disagreeing
    refused("nonce", () => checkDepositCall(good(x, { nonce: NONCE + 2n }), ctx(x)));
    refused("nonce", () => checkDepositCall(good(x, { nonce: NONCE }), ctx(x, { unlandedNonce: NONCE })));
    refused("nonce", () => checkDepositCall(good(x), ctx(x, { reads: [read(x), read(x, { nonce: NONCE + 1n })] })));
    // the reads, on either RPC: a second key, a pending Pause, a halt (never read as zero), another code hash, no vault
    // storage on the token, P already in the vault (a retry of a refused call included), the note before not in yet
    const onEither = (rule: string, bad: Partial<DepositRead>) => {
      refused(rule, () => checkDepositCall(good(x), ctx(x, { reads: [read(x, bad), read(x)] })));
      refused(rule, () => checkDepositCall(good(x), ctx(x, { reads: [read(x), read(x, bad)] })));
    };
    onEither("keys", { keys: [keyOf(x), `ed25519:${b58(new Uint8Array(32).fill(9))}`] });
    onEither("keys", { keys: [] });
    onEither("pause_pending", { pausePending: true });
    onEither("halted", { balance: "paused" });
    onEither("code_hash", { codeHash: "11111111111111111111111111111111" });
    onEither("vault_storage", { vaultRegistered: false });
    onEither("precommitment_used", { precommitmentInVault: true });
    onEither("prior_note", { priorInVault: false });
    // only through the release's relayer
    refused("route", () => checkDepositCall(good(x), ctx(x, { route: "https://relayer.attacker.example/v1/bind" })));
    refused("route", () => checkDepositCall(good(x), ctx(x, { route: "self" })));
    // the signer: an id that is not its key's
    refused("signer", () => checkDepositCall(good(x), ctx(x, { signer: { id: ATTACKER, publicKey: x.publicKey } })));
    // trailing bytes, a short payload
    refused("payload", () => checkDepositCall(Uint8Array.from([...good(x), 0]), ctx(x)));
    refused("payload", () => checkDepositCall(good(x).subarray(0, 40), ctx(x)));
  });

  test(`an intents.near ft_withdraw whose receiver is the vault, from ${x.name}, is refused`, () => {
    const args = JSON.stringify({ token: TOKEN, receiver_id: VAULT, amount: AMOUNT.toString(), msg: JSON.stringify({ precommitment: P.toString(), depositor: x.id }) });
    refused("receiver_id", () => checkDepositCall(good(x, { receiver_id: "intents.near", method_name: "ft_withdraw", args: new TextEncoder().encode(args) }), ctx(x)));
    refused("method", () => checkDepositCall(good(x, { method_name: "ft_withdraw", args: new TextEncoder().encode(args) }), ctx(x)));
  });

  test(`a storage prepay has nothing for ${x.name} to sign (W:890)`, () => {
    const args = new TextEncoder().encode(JSON.stringify({ precommitment: P.toString() }));
    refused("receiver_id", () => checkDepositCall(good(x, { receiver_id: VAULT, method_name: "storage_prepay", args, deposit: 756n * 10n ** 19n }), ctx(x)));
    refused("method", () => checkDepositCall(good(x, { method_name: "storage_prepay", args }), ctx(x)));
  });
}

test("no deposit call is signed on a network whose release names no vault", () => {
  refused("vault", () => checkDepositCall(good(U), ctx(U, { network: "mainnet" })));
  refused("network", () => checkDepositCall(good(U), ctx(U, { network: "betanet" as "testnet" })));
});

// ---------- the deposit quote ----------

const Q = quotes.dry;
const QU = "ab".repeat(32); // the recorded quote's placeholder U
const qctx = (over: Partial<DepositQuoteContext> = {}): DepositQuoteContext => ({
  seed: { source: "prf", code_saved: false }, depositId: QU,
  check: { path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, now: Date.parse(Q.answer.timestamp) + 1_000 }, ...over,
});
const req = (over: Record<string, unknown> = {}) => ({ ...Q.request, ...over }) as OneClickRequest;

test("the deposit quote: the recorded answer for U passes, a no-PRF seed only once its backup is saved", () => {
  assert.deepEqual([...ONECLICK_SIGNING_KEYS], ["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]);
  assert.equal(checkDepositQuote(req(), Q.answer, qctx()).amountIn, 2_000_000n);
  assert.equal(checkDepositQuote(req(), Q.answer, qctx({ seed: { source: "words", code_saved: true } })).amountIn, 2_000_000n);
  refused("backup", () => checkDepositQuote(req(), Q.answer, qctx({ seed: { source: "words", code_saved: false } })));
  refused("backup", () => checkDepositQuote(req(), Q.answer, qctx({ seed: { source: null, code_saved: false } })));
});

test("the deposit quote: each bad request field is refused before the answer is read", () => {
  refused("refundTo", () => checkDepositQuote(req({ refundTo: ATTACKER }), Q.answer, qctx()));
  refused("refundType", () => checkDepositQuote(req({ refundType: "ORIGIN_CHAIN" }), Q.answer, qctx()));
  refused("recipientType", () => checkDepositQuote(req({ recipientType: "INTENTS" }), Q.answer, qctx()));
  refused("recipient", () => checkDepositQuote(req({ recipient: ATTACKER }), Q.answer, qctx()));
  refused("recipient", () => checkDepositQuote(req(), Q.answer, qctx({ depositId: ATTACKER }))); // U is not the quote's
  refused("depositType", () => checkDepositQuote(req({ depositType: "INTENTS" }), Q.answer, qctx()));
  refused("destinationAsset", () => checkDepositQuote(req({ destinationAsset: "nep141:wrap.near" }), Q.answer, qctx()));
  refused("swapType", () => checkDepositQuote(req({ swapType: "EXACT_OUTPUT" }), Q.answer, qctx()));
  for (const extra of ["customRecipientMsg", "sessionId", "connectedWallets", "virtualChainRecipient"])
    refused("request", () => checkDepositQuote(req({ [extra]: "x" }), Q.answer, qctx()));
  refused("deposit_id", () => checkDepositQuote(req(), Q.answer, qctx({ depositId: "AB".repeat(32) })));
});

test("the deposit quote: the answer goes through the kit's 1Click check with its output into the vault", () => {
  const a = structuredClone(Q.answer) as Record<string, Record<string, unknown>>;
  a.quote.amountOut = String(BigInt(a.quote.amountOut as string) + 1n); // a signed field changed
  assert.throws(() => checkDepositQuote(req(), a, qctx()), (e: unknown) => e instanceof OneClickQuoteError && e.check === "signature");
  // A quote whose minAmountOut is under MIN_DEPOSIT: the kit's check passes it when the output is not for the vault,
  // and the deposit rule refuses it, whatever the caller puts in its options.
  assert.ok(BigInt(small.answer.quote.minAmountOut) < 1_000_000n);
  const now = Date.parse(small.answer.timestamp) + 1_000;
  const opts = { path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, now } as const;
  assert.equal(checkOneClickQuote(small.request, small.answer, { ...opts, intoVault: false }).amountIn, 1_000_000n);
  const c = qctx({ check: opts });
  (c.check as Record<string, unknown>).intoVault = false;
  assert.throws(() => checkDepositQuote(small.request, small.answer, c), (e: unknown) => e instanceof OneClickQuoteError && e.check === "floor");
});
