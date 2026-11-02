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
import { HELPER_BIND_DEPOSIT_CAP } from "../../kit/src/helper/v1.ts";

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
const TOKEN = NEAR_NETWORKS.testnet.usdc;
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

// ---------- the review's cases (card signpage-deposit-kinds, Opus review on 158005f), on U ----------
// Raw borsh pieces field by field, for shapes encodeDelegateAction refuses to make.
const enc8 = (t: string) => new TextEncoder().encode(t);
const BOM = [0xef, 0xbb, 0xbf];
const strB = (b: number[]) => [...u32(b.length), ...b];
const uread = (over: Partial<DepositRead> = {}) => read(U, over);
const uctx = (over: Partial<DepositCallContext> = {}) => ctx(U, over);
const ugood = (over: Partial<DelegateFields> = {}) => good(U, over);
function rawU(o: { sender?: number[]; receiver?: number[]; method?: number[]; args?: number[]; nonce?: bigint; mbh?: bigint; key?: number[]; count?: number } = {}): Uint8Array {
  return Uint8Array.from([
    ...(o.sender ?? str(U.id)), ...(o.receiver ?? str(TOKEN)), ...u32(o.count ?? 1), 2,
    ...(o.method ?? str("ft_transfer_call")), ...(o.args ?? str(argsOf(U))), ...le(180_000_000_000_000n, 8), ...le(1n, 16),
    ...le(o.nonce ?? NONCE + 1n, 8), ...le(o.mbh ?? HEIGHT + 120n, 8), ...(o.key ?? [0, ...U.publicKey]),
  ]);
}
const refusedAny = (f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof DepositRuleRefused && e.code === "not_allowed");

test("rawU rebuilds the good bytes exactly, so the raw cases below differ only where they say", () => {
  assert.deepEqual(rawU(), ugood());
  assert.equal(checkDepositCall(rawU(), uctx()).sender_id, U.id);
});

test("the key type: a secp256k1 key, and a tag-1 key followed by U's own 32 bytes, are refused", () => {
  refused("public_key", () => checkDepositCall(rawU({ key: [1, ...new Uint8Array(64).fill(3)] }), uctx()));
  refused("public_key", () => checkDepositCall(rawU({ key: [1, ...U.publicKey] }), uctx()));
});

test("lying length prefixes are refused (past the buffer, one short, one long, 2^32-1, a count whose low byte is 1)", () => {
  const a = [...enc8(argsOf(U))];
  refused("payload", () => checkDepositCall(rawU({ args: [...u32(0xffffffff), ...a] }), uctx()));
  refusedAny(() => checkDepositCall(rawU({ args: [...u32(a.length - 1), ...a] }), uctx()));
  refusedAny(() => checkDepositCall(rawU({ args: [...u32(a.length + 1), ...a] }), uctx()));
  const sid = [...enc8(U.id)];
  refusedAny(() => checkDepositCall(rawU({ sender: [...u32(sid.length + 4), ...sid] }), uctx()));
  refusedAny(() => checkDepositCall(rawU({ count: 0x01000001 }), uctx()));
});

test("invalid UTF-8 (overlong, CESU surrogate, lone continuation) in any string is refused", () => {
  for (const bad of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0x80]]) {
    refused("payload", () => checkDepositCall(rawU({ args: strB([...enc8(argsOf(U)), ...bad]) }), uctx()));
    refused("payload", () => checkDepositCall(rawU({ method: strB([...enc8("ft_transfer_call"), ...bad]) }), uctx()));
  }
});

test("a leading U+FEFF is kept, never dropped: a BOM in sender_id, receiver_id, method_name or args is refused", () => {
  const withBom = rawU({ args: strB([...BOM, ...enc8(argsOf(U))]) });
  assert.equal(withBom.length, ugood().length + 3); // the BOM's bytes are in what would be signed
  refused("sender_id", () => checkDepositCall(rawU({ sender: strB([...BOM, ...enc8(U.id)]) }), uctx()));
  refused("receiver_id", () => checkDepositCall(rawU({ receiver: strB([...BOM, ...enc8(TOKEN)]) }), uctx()));
  refused("method", () => checkDepositCall(rawU({ method: strB([...BOM, ...enc8("ft_transfer_call")]) }), uctx()));
  refused("args", () => checkDepositCall(withBom, uctx()));
  refused("args", () => checkDepositCall(rawU({ args: strB([...BOM, ...BOM, ...enc8(argsOf(U))]) }), uctx()));
});

test("the u64 edges of nonce and max_block_height", () => {
  const MAX = (1n << 64n) - 1n;
  const at = [uread({ nonce: MAX }), uread({ nonce: MAX, height: HEIGHT + 3n })] as const;
  refused("nonce", () => checkDepositCall(rawU({ nonce: MAX }), uctx({ reads: at })));
  refused("nonce", () => checkDepositCall(rawU({ nonce: 0n }), uctx({ reads: at })));
  refused("max_block_height", () => checkDepositCall(rawU({ mbh: MAX }), uctx()));
  refused("max_block_height", () => checkDepositCall(rawU({ mbh: 0n }), uctx()));
  refused("max_block_height", () => checkDepositCall(ugood({ max_block_height: HEIGHT + 119n }), uctx())); // below lower + 120
});

test("a payload that is not a Uint8Array, or is empty, is refused; the bytes returned are the rule's own copy", () => {
  refused("payload", () => checkDepositCall([...ugood()] as unknown as Uint8Array, uctx()));
  refused("payload", () => checkDepositCall(new Uint8Array(0), uctx()));
  const mine = ugood();
  const d = checkDepositCall(mine, uctx());
  assert.deepEqual(d.bytes, ugood());
  mine.fill(0); // a change after the check reaches nothing the caller signs
  assert.deepEqual(d.bytes, ugood());
  assert.notEqual(d.bytes.buffer, mine.buffer);
});

test("other spellings of the same args are refused (duplicate key, \\u escapes, whitespace, order, number amount)", () => {
  const t = argsOf(U);
  const spellings = [
    t.replace('{"receiver_id"', `{"amount":"1","receiver_id"`),
    t.replace(`"amount":"${AMOUNT}"`, `"amount":"${AMOUNT}","amount":"${AMOUNT}"`),
    t.replace(`"receiver_id"`, `"\\u0072eceiver_id"`),
    t.replace(VAULT, VAULT.replace("v", "\\u0076")),
    t.replace(`\\"depositor\\"`, `\\"\\\\u0064epositor\\"`),
    ` ${t}`, `${t}\n`, t.replace(":", ": "),
    JSON.stringify({ amount: AMOUNT.toString(), receiver_id: VAULT, msg: JSON.parse(t).msg }),
    t.replace(`"amount":"${AMOUNT}"`, `"amount":${AMOUNT}`),
    t.replace(`"amount":"${AMOUNT}"`, `"amount":"0${AMOUNT}"`),
    JSON.stringify({ ...JSON.parse(t), msg: JSON.stringify({ depositor: U.id, precommitment: P.toString() }) }),
    JSON.stringify({ ...JSON.parse(t), msg: JSON.stringify({ precommitment: P.toString(), depositor: U.id }, null, 1) }),
    JSON.stringify({ ...JSON.parse(t), memo: "" }),
  ];
  for (const sp of spellings) refusedAny(() => checkDepositCall(ugood({ args: enc8(sp) }), uctx()));
});

test("a depositor that is not the signer (upper case, another id, intents.near, the vault) is refused", () => {
  for (const d of [U.id.toUpperCase(), "cd".repeat(32), "intents.near", VAULT]) {
    const sp = JSON.stringify({ ...JSON.parse(argsOf(U)), msg: JSON.stringify({ precommitment: P.toString(), depositor: d }) });
    refusedAny(() => checkDepositCall(ugood({ args: enc8(sp) }), uctx()));
  }
});

test("upper-case signer ids and network names off the own list are refused", () => {
  refused("signer", () => checkDepositCall(ugood(), uctx({ signer: { id: U.id.toUpperCase(), publicKey: U.publicKey } })));
  for (const n of ["__proto__", "constructor", "toString", "hasOwnProperty"])
    refused("network", () => checkDepositCall(ugood(), uctx({ network: n as "testnet" })));
});

test("one lying RPC cannot make the rule pass, and a lying low height only moves the window down", () => {
  const lies: [string, Partial<DepositRead>][] = [
    ["balance", { balance: AMOUNT - 1n }], ["keys", { keys: [] }], ["halted", { balance: "paused" }],
    ["code_hash", { codeHash: "x" }], ["vault_storage", { vaultRegistered: false }],
    ["precommitment_used", { precommitmentInVault: true }], ["prior_note", { priorInVault: false }],
    ["pause_pending", { pausePending: true }], ["nonce", { nonce: NONCE - 1n }],
  ];
  for (const [rule, lie] of lies) {
    refused(rule, () => checkDepositCall(ugood(), uctx({ reads: [uread(lie), uread({ height: HEIGHT + 3n })] })));
    refused(rule, () => checkDepositCall(ugood(), uctx({ reads: [uread(), uread({ ...lie, height: HEIGHT + 3n })] })));
  }
  refused("max_block_height", () => checkDepositCall(ugood(), uctx({ reads: [uread(), uread({ height: HEIGHT - 50n })] })));
});

test("a short or empty reads list throws, never passes", () => {
  assert.throws(() => checkDepositCall(ugood(), uctx({ reads: [uread()] as unknown as [DepositRead, DepositRead] })));
  assert.throws(() => checkDepositCall(ugood(), uctx({ reads: [] as unknown as [DepositRead, DepositRead] })));
});

test("each read is checked by its type, never by truthiness: a missing or odd field is refused", () => {
  const holes: [string, Partial<Record<keyof DepositRead, unknown>>][] = [
    ["balance", { balance: undefined }], ["balance", { balance: "FiatToken: blacklisted" }], ["balance", { balance: Number.NaN }],
    ["balance", { balance: 25_000_000 }], ["pause_pending", { pausePending: undefined }], ["pause_pending", { pausePending: 0 }],
    ["precommitment_used", { precommitmentInVault: undefined }], ["vault_storage", { vaultRegistered: "false" }],
    ["vault_storage", { vaultRegistered: 1 }], ["prior_note", { priorInVault: "true" }], ["keys", { keys: `ed25519:${b58(U.publicKey)}` }],
    ["keys", { keys: { length: 1, 0: `ed25519:${b58(U.publicKey)}` } }],
    ["nonce", { nonce: Number(NONCE) }], ["max_block_height", { height: Number(HEIGHT) }],
  ];
  for (const [rule, h] of holes) {
    const bad = { ...uread(), ...h } as DepositRead;
    refused(rule, () => checkDepositCall(ugood(), uctx({ reads: [bad, { ...bad, height: HEIGHT + 3n }] })));
  }
});

test("the nonce is always the read nonce + 1; an unlanded call above it is refused, so two can never both land", () => {
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE }), uctx({ unlandedNonce: NONCE })));
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE - 1n }), uctx({ unlandedNonce: NONCE - 1n })));
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE + 3n }), uctx({ unlandedNonce: NONCE + 2n })));
  // an unlanded call at N > read + 1: neither read + 1 nor N signs (N = read + 2 included)
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE + 1n }), uctx({ unlandedNonce: NONCE + 2n })));
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE + 1n }), uctx({ unlandedNonce: NONCE + 5n })));
  refused("nonce", () => checkDepositCall(ugood({ nonce: NONCE + 5n }), uctx({ unlandedNonce: NONCE + 5n })));
  // an unlanded call at or below the read nonce has had its nonce used: the new call is the read nonce + 1
  assert.equal(checkDepositCall(ugood(), uctx({ unlandedNonce: NONCE })).nonce, NONCE + 1n);
  // nearcore's range (nonce < height x 1,000,000) is never reached: the nonce is the read's + 1
  const big = HEIGHT * 1_000_000n + 7n;
  refused("nonce", () => checkDepositCall(ugood({ nonce: big }), uctx({ unlandedNonce: big })));
});

test("an unlanded nonce that is not a bigint is refused, never ignored", () => {
  for (const bad of ["abc", null, Number.NaN, {}, Number(NONCE + 1n), `${NONCE + 1n}`])
    refused("nonce", () => checkDepositCall(ugood(), uctx({ unlandedNonce: bad as unknown as bigint })));
  assert.equal(checkDepositCall(ugood(), uctx({ unlandedNonce: NONCE + 1n })).nonce, NONCE + 1n);
});

test("an amount above HELPER_BIND_DEPOSIT_CAP is refused; the cap itself signs", () => {
  const at = (amt: bigint) => uctx({ note: { precommitment: P, amount: amt }, reads: [uread({ balance: amt }), uread({ balance: amt, height: HEIGHT + 3n })] });
  refused("cap", () => checkDepositCall(ugood({ args: enc8(argsOf(U, HELPER_BIND_DEPOSIT_CAP + 1n)) }), at(HELPER_BIND_DEPOSIT_CAP + 1n)));
  assert.equal(checkDepositCall(ugood({ args: enc8(argsOf(U, HELPER_BIND_DEPOSIT_CAP)) }), at(HELPER_BIND_DEPOSIT_CAP)).sender_id, U.id);
});

test("info: P is not checked below the field here (P >= p or negative: the vault refuses it and the token returns the USDC to U)", () => {
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  for (const bad of [p, -1n]) {
    const sp = JSON.stringify({ receiver_id: VAULT, amount: AMOUNT.toString(), msg: JSON.stringify({ precommitment: bad.toString(), depositor: U.id }) });
    assert.equal(checkDepositCall(ugood({ args: enc8(sp) }), uctx({ note: { precommitment: bad, amount: AMOUNT } })).sender_id, U.id);
  }
});

test("near-api-js 7.3.1's own deposit delegate (the helper's fixture) decodes whole: its refusal is the receiver, not the payload", () => {
  const fx = JSON.parse(readFileSync(new URL("../../../apps/helper/src/bind/fixtures/near-api-js-deposit.json", import.meta.url), "utf8"));
  const signed = new Uint8Array(Buffer.from(fx.signed_delegate, "base64"));
  const delegate = signed.subarray(0, signed.length - 65);
  const pk = Uint8Array.from(Buffer.from(fx.sender_id, "hex"));
  assert.equal(`ed25519:${b58(pk)}`, fx.public_key);
  refused("receiver_id", () => checkDepositCall(delegate, uctx({ signer: { id: fx.sender_id, publicKey: pk } })));
  refused("payload", () => checkDepositCall(signed, uctx({ signer: { id: fx.sender_id, publicKey: pk } }))); // the signature left on
});

test("the backup gate for every no-PRF source, and code_saved other than true", () => {
  for (const source of ["random", "code", "wallet", "PRF", "prf ", null])
    for (const code_saved of [false, undefined, 1, "true"])
      refused("backup", () => checkDepositQuote(req(), Q.answer, qctx({ seed: { source, code_saved } as DepositQuoteContext["seed"] })));
});

test("intoVault cannot be turned off by a getter, a proxy or a prototype on ctx.check", () => {
  const now = Date.parse(small.answer.timestamp) + 1_000;
  const base = { path: "keyless", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, now };
  const getter = Object.defineProperty({ ...base }, "intoVault", { get: () => false, enumerable: true });
  const proto = Object.assign(Object.create({ intoVault: false }), base);
  const proxy = new Proxy({ ...base, intoVault: false }, {});
  for (const check of [getter, proto, proxy])
    assert.throws(() => checkDepositQuote(small.request, small.answer, qctx({ check: check as DepositQuoteContext["check"] })),
      (e: unknown) => e instanceof OneClickQuoteError && e.check === "floor");
});

test("no recipient or refund smuggled through extra request keys (both virtual-chain ids, appFees, an own __proto__)", () => {
  for (const k of ["virtualChainRecipient", "virtualChainRefundRecipient", "appFees", "customRecipientMsg", "depositMode"])
    refused("request", () => checkDepositQuote(req({ [k]: "x" }), Q.answer, qctx()));
  const own = JSON.parse(`{"__proto__":{"recipient":"x"},${JSON.stringify(Q.request).slice(1)}`);
  refused("request", () => checkDepositQuote(own, Q.answer, qctx()));
  refused("request", () => checkDepositQuote([] as unknown as OneClickRequest, Q.answer, qctx()));
});

test("the request is read once: getters that show U to the rule and another id to the echo cannot pass", () => {
  const OWN_U = "cd".repeat(32); // the device's own U for this deposit
  const r = { ...Q.request } as Record<string, unknown>;
  for (const k of ["recipient", "refundTo"]) {
    let n = 0;
    Object.defineProperty(r, k, { enumerable: true, get: () => (n++ === 0 ? OWN_U : QU) });
  }
  // the signed answer names QU; the rule read OWN_U once, and the kit's echo sees that same OWN_U
  assert.throws(() => checkDepositQuote(r as unknown as OneClickRequest, Q.answer, qctx({ depositId: OWN_U })),
    (e: unknown) => e instanceof OneClickQuoteError && e.check === "echo");
});

test("info: slippageTolerance reaches the kit unchanged, whose echo binds it to the signed answer", () => {
  assert.throws(() => checkDepositQuote(req({ slippageTolerance: 9999 }), Q.answer, qctx()), (e: unknown) => e instanceof OneClickQuoteError);
});
