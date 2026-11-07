// The refund-kind rules (card signpage-refund-kinds, src/rules/refund.ts; wallet.md §2.8 W:914, W:922, W:928, W:930 and
// WU-05 W:1067 at research 1476ae8): the refund move and V's move, the withdraw from a one-time id from inside
// intents.near (to another chain, and ft_withdraw to a typed NEAR account) and W's return. A good payload signs and each
// bad field is refused not_allowed, named by its rule; only the object a check returned signs, with its own key.
// 1Click answers come from the H-1c mock (test/oneclick-mock.ts), signed by a key only this process trusts. Keys: RFC 8032
// test 1 (the id) and test 2 (the Solana W), the Hardhat mnemonic's account 0 (the EVM W): published test vectors.
// Mainnet has no vault yet (kit near/networks.ts), so a load hook gives this process a networks.ts whose mainnet names
// VAULT, a test id, frozen as the real one is: every "never the vault" rule then runs against a vault that is there.
//   node --test test/rules-refund.test.ts      (from packages/signpage)
/// <reference types="node" />
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58, base64 } from "@scure/base";
import type { OneClickRequest } from "../../kit/src/checks/oneclick.ts";
import { ATTACKER, COLLECTOR, NEAR_USDC, NOW, SOL_USDC, liveAnswer, mockKey, signAnswer, type Answer } from "./oneclick-mock.ts";
const VAULT = "vault.blindfill-test.near";
const NETWORKS_URL = new URL("../../kit/src/near/networks.ts", import.meta.url).href;
registerHooks({
  load(url, context, next) {
    if (url !== NETWORKS_URL) return next(url, context);
    // the real module under another address (the hook passes it through), its mainnet with VAULT, frozen
    const real = JSON.stringify(`${NETWORKS_URL}?real`);
    const source = `import { NEAR_NETWORKS as REAL } from ${real};
export * from ${real};
export const NEAR_NETWORKS = Object.freeze({ ...REAL, mainnet: Object.freeze({ ...REAL.mainnet, vault: ${JSON.stringify(VAULT)} }) });
`;
    return { format: "module", source, shortCircuit: true };
  },
});
// after the mock, so the rule loads the mock's 1Click keys (a static import would load the kit's first)
const R = await import("../src/rules/refund.ts");
const { NEAR_NETWORKS } = await import("../../kit/src/near/networks.ts");
const { VAULT_TOKEN_CODE_HASH } = await import("../../kit/src/vault/shapes.ts");
const { DEPOSIT_ASSET_CHAINS } = await import("../src/rules/deposit-dry.ts");
if (NEAR_NETWORKS.mainnet.vault !== VAULT) throw new Error("rules-refund.test.ts: networks.ts was loaded before the vault hook");
type IdIntentRead = import("../src/rules/refund.ts").IdIntentRead;
type IdIntentContext = import("../src/rules/refund.ts").IdIntentContext;
type FtWithdrawReads = import("../src/rules/refund.ts").FtWithdrawReads;
type OneTimeId = import("../src/rules/refund.ts").OneTimeId;
type EvmReturnSend = import("../src/rules/refund.ts").EvmReturnSend;
type EvmReturnReads = import("../src/rules/refund.ts").EvmReturnReads;

const refusedAs = (rule: string) => (e: unknown) => e instanceof R.RefundRuleRefused && e.code === "not_allowed" && e.rule === rule;
const refused = (rule: string, f: () => unknown) => assert.throws(f, refusedAs(rule), rule);
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ---------- the parties ----------
const ID_SECRET = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"); // gitleaks:allow (RFC 8032 test 1)
const ID_PUB = ed25519.getPublicKey(ID_SECRET);
const ID = hexOf(ID_PUB);
const OTHER_SECRET = fromHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"); // gitleaks:allow (RFC 8032 test 2)
const signer = (role: OneTimeId["role"] = "U"): OneTimeId => ({ role, id: ID, publicKey: ID_PUB });
const OWN_KEY = `ed25519:${base58.encode(ID_PUB)}`;
const USDC = NEAR_NETWORKS.mainnet.usdc;
const DEPOSIT = "ab".repeat(32); // a 1Click deposit address inside intents.near: a 64-hex id
const OPTS = { path: "partner", pricing: "usdc", decimalsIn: 6, decimalsOut: 6, now: NOW } as const;
const AMOUNT = 25_000_000n;

/** A request as the device asks it for a refund move of U's 25 USDC (on Solana) inside intents.near. */
const refundReq = (o: Partial<OneClickRequest> = {}): OneClickRequest => ({
  dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: SOL_USDC, depositType: "INTENTS",
  destinationAsset: NEAR_USDC, amount: AMOUNT.toString(), refundTo: ID, refundType: "INTENTS", recipient: ID,
  recipientType: "DESTINATION_CHAIN", deadline: new Date(NOW + 600_000).toISOString(), ...o,
});
/** 1Click's signed answer to `req` (the mock's key), its deposit address `DEPOSIT`, with `before` applied before signing. */
const answerTo = (req: OneClickRequest, before?: (a: Answer) => void): Answer => {
  const a = liveAnswer(req, NOW - 500);
  a.quote.depositAddress = DEPOSIT;
  before?.(a);
  signAnswer(a, mockKey.privateKey);
  return a;
};
const refundQuote = (o: Partial<OneClickRequest> = {}, role: OneTimeId["role"] = "U") => {
  const req = refundReq(o);
  return R.checkRefundMoveQuote(req, answerTo(req), { network: "mainnet", signer: signer(role), origin: SOL_USDC, check: OPTS });
};

// ---------- the intent ----------
const BLOCK_MS = NOW + 1_000;
const reads = (o: Partial<IdIntentRead> = {}, o1: Partial<IdIntentRead> = {}): [IdIntentRead, IdIntentRead] => [
  { blockTimeNs: BigInt(BLOCK_MS) * 1_000_000n, held: AMOUNT, keys: [OWN_KEY], ...o },
  { blockTimeNs: BigInt(BLOCK_MS + 400) * 1_000_000n + 123n, held: AMOUNT, keys: [OWN_KEY], ...o1 },
];
const ictx = (o: Partial<IdIntentContext> = {}): IdIntentContext => ({ network: "mainnet", signer: signer(), reads: reads(), priorDeadline: null, ...o });
const DEADLINE = new Date(BLOCK_MS + R.ID_INTENT_WINDOW_MS).toISOString();
/** A V1 versioned nonce: magic, version 0, a salt, the deadline in ns (LE), 15 bytes. */
const nonceOf = (deadline: string, magic = [0x56, 0x28, 0xf6, 0xc6, 0]): string => {
  const n = new Uint8Array(32);
  n.set(magic, 0);
  n.set([1, 2, 3, 4], 5);
  new DataView(n.buffer).setBigUint64(9, BigInt(Date.parse(deadline)) * 1_000_000n, true);
  n.fill(9, 17);
  return base64.encode(n);
};
type Payload = { signer_id: unknown; verifying_contract: unknown; deadline: unknown; nonce: unknown; intents: unknown };
const payloadOf = (intent: Record<string, unknown>, o: Partial<Payload> = {}): Payload => ({
  signer_id: ID, verifying_contract: "intents.near", deadline: DEADLINE, nonce: nonceOf(DEADLINE), intents: [intent], ...o,
});
const transfer = (o: Record<string, unknown> = {}) => ({ intent: "transfer", receiver_id: DEPOSIT, tokens: { [SOL_USDC]: AMOUNT.toString() }, ...o });
const transferPayload = (o: Record<string, unknown> = {}, p: Partial<Payload> = {}) => JSON.stringify(payloadOf(transfer(o), p));

test("refund move: a good quote and its one transfer intent sign as the id, raw_ed25519 over the payload", () => {
  const q = refundQuote();
  const payload = transferPayload();
  const it = R.checkIdTransferIntent(payload, q, ictx());
  assert.equal(it.amount, AMOUNT);
  const s = R.signIdIntent(ID_SECRET, it);
  assert.deepEqual(Object.keys(s), ["standard", "payload", "public_key", "signature"]);
  assert.equal(s.standard, "raw_ed25519");
  assert.equal(s.payload, payload);
  assert.equal(s.public_key, OWN_KEY);
  assert.ok(ed25519.verify(base58.decode(s.signature.slice(8)), new TextEncoder().encode(payload), ID_PUB));
  // V's move: the same rule from V
  const v = refundQuote({}, "V");
  assert.equal(R.checkIdTransferIntent(payload, v, ictx({ signer: signer("V") })).receiver, DEPOSIT);
});

test("refund move quote: each bad request field is refused before the answer is read", () => {
  refused("recipient", () => refundQuote({ recipient: ATTACKER }));
  refused("recipientType", () => refundQuote({ recipientType: "INTENTS" }));
  refused("refundTo", () => refundQuote({ refundTo: ATTACKER }));
  refused("refundType", () => refundQuote({ refundType: "ORIGIN_CHAIN" }));
  refused("depositType", () => refundQuote({ depositType: "ORIGIN_CHAIN" }));
  refused("destinationAsset", () => refundQuote({ destinationAsset: "nep141:wrap.near" }));
  refused("originAsset", () => refundQuote({ originAsset: "nep141:wrap.near" }));
  refused("dry", () => refundQuote({ dry: true }));
  refused("swapType", () => refundQuote({ swapType: "EXACT_OUTPUT" as "EXACT_INPUT" }));
  refused("request", () => refundQuote({ customRecipientMsg: "x" } as Partial<OneClickRequest>));
  refused("signer", () => refundQuote({}, "R"));
  const req = refundReq();
  refused("network", () => R.checkRefundMoveQuote(req, answerTo(req), { network: "testnet", signer: signer(), origin: SOL_USDC, check: OPTS }));
  refused("signer", () => R.checkRefundMoveQuote(req, answerTo(req), { network: "mainnet", signer: { ...signer(), id: ATTACKER }, origin: SOL_USDC, check: OPTS }));
});

test("refund move quote: the answer goes through the kit's check, its output into the vault", () => {
  const req = refundReq();
  const ctx = { network: "mainnet" as const, signer: signer(), origin: SOL_USDC, check: OPTS };
  // a signed field changed after 1Click signed
  const a = answerTo(req);
  a.quote.amountOut = "99999999";
  assert.throws(() => R.checkRefundMoveQuote(req, a, ctx), /signature/);
  // a signed dry answer to a live request
  assert.throws(() => R.checkRefundMoveQuote(req, answerTo(req, (x) => { x.quoteRequest.dry = true; }), ctx), /echo/);
  // minAmountOut under MIN_DEPOSIT, on a quote small enough for the floor to allow it otherwise
  const small = refundReq({ amount: "1000000" });
  const s = answerTo(small, (x) => Object.assign(x.quote, { amountIn: "1000000", minAmountIn: "1000000", amountInFormatted: "1.0", amountOut: "999000", amountOutFormatted: "0.999", minAmountOut: "989010", withdrawFee: "0" }));
  assert.throws(() => R.checkRefundMoveQuote(small, s, ctx), /floor/);
  // a caller cannot turn the vault floor off
  assert.throws(() => R.checkRefundMoveQuote(small, s, { ...ctx, check: { ...OPTS, intoVault: false } as typeof OPTS }), /floor/);
});

test("id intent: each bad field of the transfer is refused", () => {
  const q = refundQuote();
  const bad = (rule: string, payload: string, c: IdIntentContext = ictx()) => refused(rule, () => R.checkIdTransferIntent(payload, q, c));
  bad("intents", JSON.stringify(payloadOf(transfer(), { intents: [transfer(), transfer()] })));
  bad("intents", JSON.stringify(payloadOf(transfer(), { intents: [] })));
  bad("tokens", transferPayload({ tokens: { [SOL_USDC]: AMOUNT.toString(), [NEAR_USDC]: "1" } }));
  bad("tokens", transferPayload({ tokens: { [NEAR_USDC]: AMOUNT.toString() } }));
  bad("intent", transferPayload({ memo: "x" }));
  bad("intent", transferPayload({ msg: "x" }));
  bad("intent", transferPayload({ notification: { msg: "x" } }));
  bad("intent", JSON.stringify(payloadOf({ intent: "ft_withdraw", token: USDC, receiver_id: DEPOSIT, amount: "1" })));
  // an unsigned address, and the places nothing of the id's ever goes
  bad("receiver_id", transferPayload({ receiver_id: ATTACKER }));
  bad("receiver_id", transferPayload({ receiver_id: "intents.near" }));
  bad("amount", transferPayload({ tokens: { [SOL_USDC]: (AMOUNT - 1n).toString() } }));
  bad("amount", transferPayload({ tokens: { [SOL_USDC]: (AMOUNT + 1n).toString() } }));
  bad("amount", transferPayload({ tokens: { [SOL_USDC]: "025000000" } }));
  bad("signer_id", transferPayload({}, { signer_id: ATTACKER }));
  bad("verifying_contract", transferPayload({}, { verifying_contract: "intents.testnet" }));
  // one spelling only
  bad("payload", JSON.stringify(payloadOf(transfer()), null, 1));
  bad("payload", transferPayload().replace('{"signer_id"', '{"signer_id":"x","signer_id"'));
  const p = payloadOf(transfer());
  bad("payload", JSON.stringify({ verifying_contract: p.verifying_contract, signer_id: p.signer_id, deadline: p.deadline, nonce: p.nonce, intents: p.intents }));
  bad("payload", JSON.stringify({ ...p, memo: "x" }));
  // the held amount: on both RPCs, alike, and enough
  bad("held", transferPayload(), ictx({ reads: reads({ held: AMOUNT - 1n }, { held: AMOUNT - 1n }) }));
  bad("held", transferPayload(), ictx({ reads: reads({}, { held: AMOUNT + 5n }) }));
  bad("reads", transferPayload(), ictx({ reads: [reads()[0]] as unknown as [IdIntentRead, IdIntentRead] }));
});

test("id intent: the deadline is the lower final-block time + 120 s, the nonce V1 with that deadline, and a fresh intent waits", () => {
  const q = refundQuote();
  const bad = (rule: string, payload: string, c: IdIntentContext = ictx()) => refused(rule, () => R.checkIdTransferIntent(payload, q, c));
  const later = new Date(BLOCK_MS + R.ID_INTENT_WINDOW_MS + 1).toISOString();
  bad("deadline", transferPayload({}, { deadline: later, nonce: nonceOf(later) }));
  const sooner = new Date(BLOCK_MS + 60_000).toISOString();
  bad("deadline", transferPayload({}, { deadline: sooner, nonce: nonceOf(sooner) }));
  bad("deadline", transferPayload({}, { deadline: DEADLINE.replace(".000Z", "Z") }));
  bad("deadline", transferPayload({}, { deadline: DEADLINE.replace("Z", "+00:00") }));
  // two RPCs more than 120 s apart: the deadline would be past on the newer
  bad("deadline", transferPayload(), ictx({ reads: reads({}, { blockTimeNs: BigInt(BLOCK_MS + 130_000) * 1_000_000n }) }));
  bad("nonce", transferPayload({}, { nonce: nonceOf(DEADLINE, [0, 0, 0, 0, 0]) }));
  bad("nonce", transferPayload({}, { nonce: nonceOf(DEADLINE, [0x56, 0x28, 0xf6, 0xc6, 1]) }));
  bad("nonce", transferPayload({}, { nonce: nonceOf(new Date(BLOCK_MS + 90_000).toISOString()) }));
  bad("nonce", transferPayload({}, { nonce: base64.encode(new Uint8Array(31)) }));
  bad("nonce", transferPayload({}, { nonce: "not base64!" }));
  // a fresh intent for the same money: only once the old one's deadline has passed on both RPCs
  bad("prior_deadline", transferPayload(), ictx({ priorDeadline: new Date(BLOCK_MS).toISOString() }));
  bad("prior_deadline", transferPayload(), ictx({ priorDeadline: "soon" }));
  assert.equal(R.checkIdTransferIntent(transferPayload(), q, ictx({ priorDeadline: new Date(BLOCK_MS - 1).toISOString() })).amount, AMOUNT);
});

test("id intent: only a quote a check returned, for this id, and only the checked intent signs, with the id's own key", () => {
  const q = refundQuote();
  refused("unchecked", () => R.checkIdTransferIntent(transferPayload(), { ...q }, ictx()));
  const other = { role: "U" as const, id: hexOf(ed25519.getPublicKey(OTHER_SECRET)), publicKey: ed25519.getPublicKey(OTHER_SECRET) };
  refused("signer_id", () => R.checkIdTransferIntent(transferPayload(), q, ictx({ signer: other })));
  // another id's own intent to this id's quote: its money would go to a quote that delivers to this id
  refused("signer_id", () => R.checkIdTransferIntent(transferPayload({}, { signer_id: other.id }), q, ictx({ signer: other })));
  const it = R.checkIdTransferIntent(transferPayload(), q, ictx());
  refused("unchecked", () => R.signIdIntent(ID_SECRET, { ...it }));
  refused("key", () => R.signIdIntent(OTHER_SECRET, it));
});

// ---------- the withdraw from an id ----------
const TYPED_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const withdrawReq = (o: Partial<OneClickRequest> = {}): OneClickRequest => refundReq({ destinationAsset: SOL_USDC, originAsset: NEAR_USDC, recipient: TYPED_SOL, ...o });
const withdrawQuote = (o: Partial<OneClickRequest> = {}, typed = TYPED_SOL) => {
  const req = withdrawReq(o);
  return R.checkIdWithdrawQuote(req, answerTo(req), { network: "mainnet", signer: signer("R"), origin: NEAR_USDC, typed, check: OPTS });
};
const wctx = (o: Partial<IdIntentContext> = {}) => ictx({ signer: signer("R"), reads: reads({ held: AMOUNT + 1n }, { held: AMOUNT + 1n }), ...o });
const wPayload = (o: Record<string, unknown> = {}) => transferPayload({ tokens: { [NEAR_USDC]: AMOUNT.toString() }, ...o });

test("withdraw from an id to another chain: a good quote and transfer sign, at most what it holds less one base unit", () => {
  const q = withdrawQuote();
  // all it holds: one base unit stays so restore still finds the id
  refused("held", () => R.checkIdTransferIntent(wPayload(), q, wctx({ reads: reads({ held: AMOUNT }, { held: AMOUNT }) })));
  assert.equal(R.checkIdTransferIntent(wPayload(), q, wctx()).amount, AMOUNT);
  // the key list: exactly its own key, or no account, on both RPCs
  assert.equal(R.checkIdTransferIntent(wPayload(), withdrawQuote(), wctx({ reads: reads({ held: AMOUNT + 1n, keys: "absent" }, { held: AMOUNT + 1n, keys: "absent" }) })).amount, AMOUNT);
  refused("keys", () => R.checkIdTransferIntent(wPayload(), withdrawQuote(), wctx({ reads: reads({ held: AMOUNT + 1n, keys: [OWN_KEY, "ed25519:11111111111111111111111111111111"] }, { held: AMOUNT + 1n }) })));
  refused("keys", () => R.checkIdTransferIntent(wPayload(), withdrawQuote(), wctx({ reads: reads({ held: AMOUNT + 1n, keys: "absent" }, { held: AMOUNT + 1n }) })));
  refused("keys", () => R.checkIdTransferIntent(wPayload(), withdrawQuote(), wctx({ reads: reads({ held: AMOUNT + 1n, keys: undefined }, { held: AMOUNT + 1n, keys: undefined }) })));
});

test("withdraw from an id to another chain: each bad quote field is refused", () => {
  refused("recipient", () => withdrawQuote({ recipient: ATTACKER }));
  refused("refundTo", () => withdrawQuote({ refundTo: ATTACKER }));
  refused("refundType", () => withdrawQuote({ refundType: "ORIGIN_CHAIN" }));
  refused("recipientType", () => withdrawQuote({ recipientType: "INTENTS" }));
  refused("depositType", () => withdrawQuote({ depositType: "ORIGIN_CHAIN" }));
  refused("destinationAsset", () => withdrawQuote({ destinationAsset: NEAR_USDC, recipient: "alice.near" }, "alice.near"));
  for (const typed of ["intents.near", USDC, ID, "", ` ${TYPED_SOL}`]) refused("typed", () => withdrawQuote({ recipient: typed }, typed));
  // a refund-move quote is no withdraw quote, and the reverse: the kind is the check's
  refused("unchecked", () => R.checkReturnSolana(new Uint8Array(1), withdrawQuote(), { blockhash: "x", balance: [1n, 1n], fee: [1n, 1n] }));
});

// ---------- ft_withdraw out of intents.near ----------
const ftReads = (o: Partial<FtWithdrawReads> = {}): FtWithdrawReads => ({ asset: NEAR_USDC, receiverExists: [true, true], receiverRegistered: [true, true], codeHash: [VAULT_TOKEN_CODE_HASH, VAULT_TOKEN_CODE_HASH], ...o });
const ft = (o: Record<string, unknown> = {}) => JSON.stringify(payloadOf({ intent: "ft_withdraw", token: USDC, receiver_id: "alice.near", amount: AMOUNT.toString(), ...o }));
const fctx = (o: Partial<FtWithdrawReads> = {}, c: Partial<IdIntentContext> = {}) => ({ ...wctx(c), ft: ftReads(o) });

test("ft_withdraw out of intents.near: to a typed account, signed; each bad field refused", () => {
  const it = R.checkIdFtWithdrawIntent(ft(), "alice.near", fctx());
  assert.equal(it.receiver, "alice.near");
  assert.equal(R.signIdIntent(ID_SECRET, it).payload, ft());
  // an unregistered account on both reads: signed as it is (the relayer registers it); an absent implicit id: signed
  assert.equal(R.checkIdFtWithdrawIntent(ft(), "alice.near", fctx({ receiverRegistered: [false, false] })).amount, AMOUNT);
  const implicit = "cd".repeat(32);
  assert.equal(R.checkIdFtWithdrawIntent(ft({ receiver_id: implicit }), implicit, fctx({ receiverExists: undefined })).receiver, implicit);
  const bad = (rule: string, payload: string, typed = "alice.near", c = fctx()) => refused(rule, () => R.checkIdFtWithdrawIntent(payload, typed, c));
  bad("registration", ft(), "alice.near", fctx({ receiverRegistered: [true, false] }));
  bad("receiver", ft(), "alice.near", fctx({ receiverExists: [false, false] }));
  bad("receiver", ft(), "alice.near", fctx({ receiverExists: [true, false] }));
  bad("receiver_id", ft({ receiver_id: "intents.near" }), "intents.near");
  bad("receiver_id", ft({ receiver_id: USDC }), USDC);
  bad("receiver_id", ft({ receiver_id: "bob.near" }));
  bad("receiver_id", ft({ receiver_id: " alice.near" }), " alice.near");
  bad("intent", ft({ memo: "x" }));
  bad("intent", ft({ msg: "x" }));
  bad("intent", ft({ storage_deposit: "1250000000000000000000" }));
  bad("intent", ft({ min_gas: "1" }));
  bad("token", ft({ token: "wrap.near" }), "alice.near", fctx({ asset: "nep141:wrap.near" }));
  bad("token", ft({ token: "wrap.near" }));
  bad("code_hash", ft(), "alice.near", fctx({ codeHash: ["11111111111111111111111111111111", "11111111111111111111111111111111"] }));
  bad("reads", ft(), "alice.near", fctx({ codeHash: [VAULT_TOKEN_CODE_HASH, "x"] }));
  bad("held", ft({ amount: (AMOUNT + 1n).toString() }));
  bad("amount", ft({ amount: "0" }));
  bad("keys", ft(), "alice.near", fctx({}, { reads: reads({ held: AMOUNT + 1n, keys: [] }, { held: AMOUNT + 1n, keys: [] }) }));
  bad("signer_id", JSON.stringify(payloadOf({ intent: "ft_withdraw", token: USDC, receiver_id: "alice.near", amount: "1" }, { signer_id: ATTACKER })));
});

// ---------- the return ----------
const W_SECRET = OTHER_SECRET;
const W_SOL = base58.encode(ed25519.getPublicKey(W_SECRET));
const R_PUB = ed25519.getPublicKey(fromHex("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")); // gitleaks:allow (RFC 8032 test 3)
const RID: OneTimeId = { role: "R", id: hexOf(R_PUB), publicKey: R_PUB };
const SOL_DEPOSIT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const RET_OPTS = { path: "partner", pricing: { in: ["1", "1"], out: ["1", "1"] }, decimalsIn: 6, decimalsOut: 6, now: NOW } as const;
type Chain = "solana" | "base" | "robinhood";
const returnReq = (chain: Chain, o: Partial<OneClickRequest> = {}): OneClickRequest =>
  refundReq({ originAsset: R.RETURN_NATIVE[chain], depositType: "ORIGIN_CHAIN", recipient: RID.id, refundTo: chain === "solana" ? W_SOL : EVM_W, refundType: "ORIGIN_CHAIN", ...o });
const returnQuote = (chain: Chain = "solana", o: Partial<OneClickRequest> = {}, c: Record<string, unknown> = {}, dep = chain === "solana" ? SOL_DEPOSIT : EVM_DEPOSIT) => {
  const req = returnReq(chain, o);
  const a = answerTo(req, (x) => {
    x.quote.depositAddress = dep;
    x.quoteRequest.appFees = [{ recipient: COLLECTOR, fee: 20 }];
    Object.assign(x.quote, { amountOut: "24900000", amountOutFormatted: "24.9", minAmountOut: "24660000" });
  });
  return R.checkReturnQuote(req, a, { chain, wallet: chain === "solana" ? W_SOL : EVM_W, ownArm: true, returnId: RID, check: RET_OPTS, ...c } as Parameters<typeof R.checkReturnQuote>[2]);
};

// a v0 Solana message: header, static keys, blockhash, instructions, no lookups
const compact = (n: number) => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
const BLOCKHASH = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn";
function solMessage(o: { keys?: string[]; header?: number[]; ixs?: { p: number; a: number[]; d: number[] }[]; table?: string } = {}): Uint8Array {
  const keys = o.keys ?? [W_SOL, SOL_DEPOSIT, "11111111111111111111111111111111"];
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, AMOUNT, true);
  const ixs = o.ixs ?? [{ p: 2, a: [0, 1], d: [2, 0, 0, 0, ...amount] }];
  return Uint8Array.from([0x80, ...(o.header ?? [1, 0, 1]), ...compact(keys.length), ...keys.flatMap((k) => [...base58.decode(k)]), ...base58.decode(BLOCKHASH),
    ...compact(ixs.length), ...ixs.flatMap((x) => [x.p, ...compact(x.a.length), ...x.a, ...compact(x.d.length), ...x.d]), ...(o.table === undefined ? [0] : [1, ...base58.decode(o.table), 1, 0, 0])]);
}
const wireOf = (m: Uint8Array, slots = 1) => Uint8Array.from([slots, ...new Uint8Array(64 * slots), ...m]);
const solReads = (o: Record<string, unknown> = {}) => ({ blockhash: BLOCKHASH, balance: [AMOUNT + 5_000n, AMOUNT + 5_000n] as [bigint, bigint], fee: [5_000n, 5_000n] as [bigint, bigint], ...o });

test("return on Solana: a good quote and W's one transfer to the signed deposit address sign as W", () => {
  const q = returnQuote();
  const m = solMessage();
  const wire = wireOf(m);
  R.checkReturnSolana(wire, q, solReads());
  // a copy, another key, a wire changed after the check
  refused("unchecked", () => R.signReturnSolana(W_SECRET, wire.slice()));
  refused("key", () => R.signReturnSolana(ID_SECRET, wire));
  const sig = R.signReturnSolana(W_SECRET, wire);
  assert.ok(ed25519.verify(sig, m, ed25519.getPublicKey(W_SECRET)));
  const w2 = wireOf(m);
  R.checkReturnSolana(w2, returnQuote(), solReads());
  w2[w2.length - 2] ^= 1;
  refused("unchecked", () => R.signReturnSolana(W_SECRET, w2));
});

test("return quote: each bad field is refused", () => {
  refused("own_arm", () => returnQuote("solana", {}, { ownArm: false }));
  refused("refundTo", () => returnQuote("solana", { refundTo: ID }));
  refused("refundType", () => returnQuote("solana", { refundType: "INTENTS" }));
  refused("recipient", () => returnQuote("solana", { recipient: ATTACKER }));
  refused("recipient", () => returnQuote("solana", {}, { returnId: { ...RID, role: "U" } }));
  refused("recipientType", () => returnQuote("solana", { recipientType: "INTENTS" }));
  refused("originAsset", () => returnQuote("solana", { originAsset: SOL_USDC }));
  refused("depositType", () => returnQuote("solana", { depositType: "INTENTS" }));
  refused("destinationAsset", () => returnQuote("solana", { destinationAsset: SOL_USDC }));
  refused("chain", () => returnQuote("solana", {}, { chain: "near" }));
  refused("wallet", () => returnQuote("solana", {}, { wallet: EVM_W }));
  refused("dry", () => returnQuote("solana", { dry: true }));
});

test("return on Solana: each bad field of W's send is refused", () => {
  const q = returnQuote();
  const bad = (rule: string, wire: Uint8Array, r = solReads()) => refused(rule, () => R.checkReturnSolana(wire, q, r));
  const amt = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return [...b]; };
  // a return whose send goes to another address
  bad("transfer_to", wireOf(solMessage({ keys: [W_SOL, TYPED_SOL, "11111111111111111111111111111111"] })));
  bad("transfer_amount", wireOf(solMessage({ ixs: [{ p: 2, a: [0, 1], d: [2, 0, 0, 0, ...amt(AMOUNT - 1n)] }] })));
  bad("instructions", wireOf(solMessage({ ixs: [{ p: 2, a: [0, 1], d: [2, 0, 0, 0, ...amt(AMOUNT)] }, { p: 2, a: [0, 1], d: [2, 0, 0, 0, ...amt(1n)] }] })));
  bad("transfer", wireOf(solMessage({ ixs: [{ p: 2, a: [0, 1], d: [3, 0, 0, 0, ...amt(AMOUNT)] }] })));
  bad("transfer", wireOf(solMessage({ ixs: [{ p: 1, a: [0, 1], d: [2, 0, 0, 0, ...amt(AMOUNT)] }] })));
  bad("signers", wireOf(solMessage({ keys: [TYPED_SOL, W_SOL, SOL_DEPOSIT, "11111111111111111111111111111111"], header: [2, 0, 1], ixs: [{ p: 3, a: [1, 2], d: [2, 0, 0, 0, ...amt(AMOUNT)] }] })));
  bad("wire", wireOf(solMessage({ keys: [TYPED_SOL, W_SOL, SOL_DEPOSIT, "11111111111111111111111111111111"], header: [2, 0, 1] }), 2));
  bad("signers", wireOf(solMessage({ keys: [TYPED_SOL, SOL_DEPOSIT, "11111111111111111111111111111111"] })));
  bad("blockhash", wireOf(solMessage()), solReads({ blockhash: TYPED_SOL }));
  bad("balance", wireOf(solMessage()), solReads({ balance: [AMOUNT + 4_999n, AMOUNT + 4_999n] }));
  bad("reads", wireOf(solMessage()), solReads({ balance: [AMOUNT + 5_000n, AMOUNT + 6_000n] }));
  bad("decode", wireOf(Uint8Array.of(1, 2, 3)));
  bad("lookups", wireOf(solMessage({ table: TYPED_SOL })));
  refused("unchecked", () => R.checkReturnSolana(wireOf(solMessage()), refundQuote(), solReads()));
});

// ---------- the return on EVM ----------
const enc = (s: string) => new TextEncoder().encode(s);
const N = secp256k1.Point.CURVE().n;
function hardhatAccount0(): Uint8Array {
  const seed = pbkdf2(sha512, enc("test test test test test test test test test test test junk"), enc("mnemonic"), { c: 2048, dkLen: 64 });
  let I = hmac(sha512, enc("Bitcoin seed"), seed);
  let k = BigInt("0x" + hexOf(I.slice(0, 32)));
  let c = I.slice(32);
  for (const [i, hard] of [[44, true], [60, true], [0, true], [0, false], [0, false]] as [number, boolean][]) {
    const kb = fromHex(k.toString(16).padStart(64, "0"));
    const head = hard ? Uint8Array.of(0, ...kb) : secp256k1.getPublicKey(kb, true);
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(hard ? i + 0x80000000 : i);
    I = hmac(sha512, c, Uint8Array.of(...head, ...idx));
    k = (BigInt("0x" + hexOf(I.slice(0, 32))) + k) % N;
    c = I.slice(32);
  }
  return fromHex(k.toString(16).padStart(64, "0"));
}
const EVM_SECRET = hardhatAccount0();
const EVM_W = "0x" + hexOf(keccak_256(secp256k1.getPublicKey(EVM_SECRET, false).slice(1)).slice(12));
const EVM_DEPOSIT = "0x2222222222222222222222222222222222222222";
const BASE_FEE = 1_000_000n, CAP = 1_000_000n;
const evmReads = (o: Partial<EvmReturnReads> = {}): EvmReturnReads => ({ nonce: [3n, 3n], balance: [AMOUNT + 10n ** 12n, AMOUNT + 10n ** 12n], toHasCode: [false, false], estimate: null, baseFee: [BASE_FEE, BASE_FEE], l1Fee: [10n, 10n], priorityCap: CAP, ...o });
const evmTx = (o: Partial<Record<keyof EvmReturnSend, unknown>> = {}): EvmReturnSend => ({ type: 2, chainId: 8453n, nonce: 3n, maxPriorityFeePerGas: CAP, maxFeePerGas: 2n * BASE_FEE + CAP, gasLimit: 21_000n, to: EVM_DEPOSIT, value: AMOUNT, data: "0x", accessList: [], ...o }) as EvmReturnSend;

/** The raw type 2 send's twelve RLP fields and the address its signature recovers over 0x02 ‖ rlp(first nine). */
function readSend(raw: Uint8Array): { fields: Uint8Array[]; from: string } {
  assert.equal(raw[0], 2);
  const body = raw.subarray(1);
  const fields: Uint8Array[] = [];
  let at = body[0]! - 0xc0 <= 55 ? 1 : 2 + body[0]! - 0xf8;
  while (at < body.length) {
    const b = body[at]!;
    if (b < 0x80) { fields.push(body.subarray(at, at + 1)); at += 1; }
    else if (b <= 0xb7) { fields.push(body.subarray(at + 1, at + 1 + b - 0x80)); at += 1 + b - 0x80; }
    else if (b === 0xc0) { fields.push(new Uint8Array(0)); at += 1; }
    else throw new Error("an rlp form this test does not read");
  }
  assert.equal(fields.length, 12);
  const big = (b: Uint8Array) => BigInt("0x" + (hexOf(b) || "0"));
  const sig = new secp256k1.Signature(big(fields[10]!), big(fields[11]!)).addRecoveryBit(Number(big(fields[9]!)));
  const rl = (x: Uint8Array) => (x.length === 1 && x[0]! < 0x80 ? [...x] : [0x80 + x.length, ...x]);
  const items = fields.slice(0, 9).flatMap((f, i) => (i === 8 ? [0xc0] : rl(f)));
  const list = items.length <= 55 ? [0xc0 + items.length, ...items] : [0xf7 + 1, items.length, ...items];
  const pub = sig.recoverPublicKey(keccak_256(Uint8Array.from([2, ...list]))).toBytes(false);
  return { fields, from: "0x" + hexOf(keccak_256(pub.slice(1)).slice(12)) };
}

test("return on Base: W's one plain send to the signed deposit address signs as W", () => {
  const q = returnQuote("base");
  const tx = evmTx();
  R.checkReturnEvm(tx, q, evmReads());
  // only the checked send, with W's key
  refused("unchecked", () => R.signReturnEvm(EVM_SECRET, { ...tx }));
  refused("key", () => R.signReturnEvm(fromHex("01".repeat(32)), tx));
  const { fields, from } = readSend(R.signReturnEvm(EVM_SECRET, tx));
  assert.equal(hexOf(fields[0]!), "2105"); // 8453
  assert.equal(hexOf(fields[5]!), EVM_DEPOSIT.slice(2));
  assert.equal(from, EVM_W);
  // a send changed after its check
  const tx2 = evmTx();
  R.checkReturnEvm(tx2, returnQuote("base"), evmReads());
  (tx2 as { value: bigint }).value = AMOUNT + 1n;
  refused("unchecked", () => R.signReturnEvm(EVM_SECRET, tx2));
});

test("return on EVM: each bad field of W's send is refused", () => {
  const q = returnQuote("base");
  const bad = (rule: string, tx: EvmReturnSend, r = evmReads()) => refused(rule, () => R.checkReturnEvm(tx, q, r));
  bad("transfer_to", evmTx({ to: "0x1111111111111111111111111111111111111111" }));
  bad("value", evmTx({ value: AMOUNT - 1n }));
  bad("data", evmTx({ data: "0xa9059cbb" }));
  bad("access_list", evmTx({ accessList: [{ address: EVM_DEPOSIT, storageKeys: [] }] }));
  bad("chain_id", evmTx({ chainId: 4663n }));
  bad("nonce", evmTx({ nonce: 4n }));
  bad("gas_limit", evmTx({ gasLimit: 21_001n }));
  bad("to_code", evmTx(), evmReads({ toHasCode: [true, true] }));
  bad("priority_fee", evmTx({ maxPriorityFeePerGas: CAP + 1n }));
  bad("max_fee", evmTx({ maxFeePerGas: 2n * BASE_FEE + CAP + 1n }));
  bad("max_fee", evmTx({ maxFeePerGas: BASE_FEE - 1n, maxPriorityFeePerGas: 0n }));
  bad("balance", evmTx(), evmReads({ balance: [AMOUNT, AMOUNT] }));
  // W must also hold the L1 data fee (10 here)
  const need = AMOUNT + 21_000n * (2n * BASE_FEE + CAP) + 10n;
  bad("balance", evmTx(), evmReads({ balance: [need - 1n, need - 1n] }));
  bad("reads", evmTx(), evmReads({ nonce: [3n, 4n] }));
  bad("reads", evmTx(), evmReads({ priorityCap: undefined as unknown as bigint }));
  bad("type", { ...evmTx(), type: 4 } as unknown as EvmReturnSend);
  bad("type", { ...evmTx(), authorizationList: [] } as unknown as EvmReturnSend);
  refused("chain", () => R.checkReturnEvm(evmTx(), returnQuote(), evmReads()));
  assert.doesNotThrow(() => R.checkReturnEvm(evmTx(), q, evmReads({ balance: [need, need] })));
});

// ---------- the return on Robinhood (Nitro: L1 data is charged as gas, so the gas limit is the send's own estimate) ----------
const RH_GAS = 63_000n;
const rhTx = (o: Partial<Record<keyof EvmReturnSend, unknown>> = {}) => evmTx({ chainId: 4663n, gasLimit: RH_GAS, ...o });
const rhReads = (o: Partial<EvmReturnReads> = {}) => evmReads({ l1Fee: [0n, 0n], estimate: [RH_GAS, RH_GAS], ...o });

test("return on Robinhood: W's one plain send at the two RPCs' gas estimate signs as W", () => {
  const q = returnQuote("robinhood");
  const tx = rhTx();
  R.checkReturnEvm(tx, q, rhReads());
  const { fields, from } = readSend(R.signReturnEvm(EVM_SECRET, tx));
  assert.equal(hexOf(fields[0]!), "1237"); // 4663
  assert.equal(hexOf(fields[4]!), "f618"); // 63,000
  assert.equal(hexOf(fields[5]!), EVM_DEPOSIT.slice(2));
  assert.equal(from, EVM_W);
});

test("return on Robinhood: each bad gas or fee field is refused", () => {
  const q = returnQuote("robinhood");
  const bad = (rule: string, tx: EvmReturnSend, r = rhReads()) => refused(rule, () => R.checkReturnEvm(tx, q, r));
  const cap = R.RETURN_EVM_GAS_MAX;
  // over the cap, though both RPCs estimate it
  bad("gas_limit", rhTx({ gasLimit: cap + 1n }), rhReads({ estimate: [cap + 1n, cap + 1n] }));
  // not the estimate
  bad("gas_limit", rhTx({ gasLimit: RH_GAS + 1n }));
  bad("gas_limit", rhTx({ gasLimit: 21_000n }));
  // Nitro has no separate L1 fee: a nonzero one is a read of another chain
  bad("l1_fee", rhTx(), rhReads({ l1Fee: [1n, 1n] }));
  // the two estimates disagree, or there is none
  bad("reads", rhTx(), rhReads({ estimate: [RH_GAS, RH_GAS + 1n] }));
  bad("reads", rhTx(), rhReads({ estimate: null }));
  bad("chain_id", rhTx({ chainId: 8453n }));
  // the cap itself signs
  assert.doesNotThrow(() => R.checkReturnEvm(rhTx({ gasLimit: cap }), q, rhReads({ estimate: [cap, cap] })));
});

test("return quote: the signed deposit address is an address of the chain and never W", () => {
  // "0x" would be a send with no to: a contract creation carrying the value
  refused("deposit_address", () => returnQuote("base", {}, {}, "0x"));
  refused("deposit_address", () => returnQuote("robinhood", {}, {}, "0x"));
  refused("deposit_address", () => returnQuote("base", {}, {}, EVM_W.toUpperCase().replace("0X", "0x")));
  refused("deposit_address", () => returnQuote("base", {}, {}, DEPOSIT));
  refused("deposit_address", () => returnQuote("solana", {}, {}, W_SOL));
  refused("deposit_address", () => returnQuote("solana", {}, {}, EVM_DEPOSIT));
  assert.equal(returnQuote("base").depositAddress, EVM_DEPOSIT);
});

// ---------- the fold of the card's review ----------

test("id intent: it dies before the quote's deposit address does", () => {
  const q = refundQuote();
  // the quote's signed deadline: the request's + 72 h (the kit's ONECLICK_LIVE_DEADLINE_MS)
  const quoteMs = Date.parse(q.deadline as string);
  const at = (blockMs: number) => {
    const d = new Date(blockMs + R.ID_INTENT_WINDOW_MS).toISOString();
    const r: [IdIntentRead, IdIntentRead] = [{ blockTimeNs: BigInt(blockMs) * 1_000_000n, held: AMOUNT, keys: [OWN_KEY] }, { blockTimeNs: BigInt(blockMs) * 1_000_000n, held: AMOUNT, keys: [OWN_KEY] }];
    return () => R.checkIdTransferIntent(transferPayload({}, { deadline: d, nonce: nonceOf(d) }), q, ictx({ reads: r }));
  };
  refused("deadline", at(quoteMs - R.ID_INTENT_WINDOW_MS + 1));
  assert.equal(at(quoteMs - R.ID_INTENT_WINDOW_MS)().amount, AMOUNT);
});

test("id intents: mainnet only", () => {
  const req = refundReq();
  // a quote checked on mainnet, its intent asked on testnet
  refused("network", () => R.checkIdTransferIntent(transferPayload(), refundQuote(), ictx({ network: "testnet" })));
  refused("network", () => R.checkIdFtWithdrawIntent(ft(), "alice.near", { ...fctx(), network: "testnet" }));
  refused("network", () => R.checkIdWithdrawQuote(withdrawReq(), answerTo(withdrawReq()), { network: "testnet", signer: signer("R"), origin: NEAR_USDC, typed: TYPED_SOL, check: OPTS }));
  refused("network", () => R.checkRefundMoveQuote(req, answerTo(req), { network: "testnet", signer: signer(), origin: SOL_USDC, check: OPTS }));
});

test("quotes: the slippage is at most the device's own 100 bps", () => {
  for (const slippageTolerance of [9999, 101, -1, 1.5]) {
    refused("slippage", () => refundQuote({ slippageTolerance }));
    refused("slippage", () => withdrawQuote({ slippageTolerance }));
    refused("slippage", () => returnQuote("solana", { slippageTolerance }));
  }
  refused("slippage", () => refundQuote({ slippageTolerance: "100" as unknown as number }));
  // the device's own 100 bps itself passes (as every good quote here asks)
  assert.equal(refundQuote({ slippageTolerance: 100 }).amountIn, AMOUNT);
});

test("never the vault: an injected vault id is refused as the typed account, the transfer's receiver and the ft_withdraw's", () => {
  // the typed address of a withdraw to another chain
  refused("typed", () => withdrawQuote({ recipient: VAULT }, VAULT));
  // a quote whose signed deposit address is the vault (or intents.near, the token, the id itself): its transfer
  for (const to of [VAULT, "intents.near", USDC, ID]) {
    const req = refundReq();
    const q = R.checkRefundMoveQuote(req, answerTo(req, (a) => { a.quote.depositAddress = to; }), { network: "mainnet", signer: signer(), origin: SOL_USDC, check: OPTS });
    refused("receiver_id", () => R.checkIdTransferIntent(transferPayload({ receiver_id: to }), q, ictx()));
  }
  // the ft_withdraw's typed account
  refused("receiver_id", () => R.checkIdFtWithdrawIntent(ft({ receiver_id: VAULT }), VAULT, fctx()));
});

const SOL_TOKEN = SOL_USDC.slice("nep141:".length);
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_TOKEN = BASE_USDC.slice("nep141:".length);

test("ft_withdraw out of intents.near: every USDC the deposit path takes, each to its own pinned code hash", () => {
  // the list is the deposit path's, in its order: a new deposit asset fails here until its code hash is pinned
  assert.deepEqual(Object.keys(R.FT_WITHDRAW_TOKENS).map((t) => `nep141:${t}`), DEPOSIT_ASSET_CHAINS.map((a) => a.id));
  assert.ok(Object.isFrozen(R.FT_WITHDRAW_TOKENS));
  // the pins as read (view_account at final, rpc.mainnet.near.org and free.rpc.fastnear.com, 2026-11-07T08:00Z, equal)
  assert.deepEqual({ ...R.FT_WITHDRAW_TOKENS }, {
    [USDC]: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q", // gitleaks:allow (a public code hash)
    [SOL_TOKEN]: "Ba6uZKxsuRPW5X7XVQrSnYEYScEjFLJLMqMWvZ1aS3tC", // gitleaks:allow (a public code hash)
    [BASE_TOKEN]: "2VUeqHTx9sk2AjDrs88HazLqS6LUgVQorjWcacotNCDP", // gitleaks:allow (a public code hash)
  });
  assert.equal(R.FT_WITHDRAW_TOKENS[USDC], VAULT_TOKEN_CODE_HASH);
  for (const [asset, token] of [[NEAR_USDC, USDC], [SOL_USDC, SOL_TOKEN], [BASE_USDC, BASE_TOKEN]] as const) {
    const hash = R.FT_WITHDRAW_TOKENS[token]!;
    const it = R.checkIdFtWithdrawIntent(ft({ token }), "alice.near", fctx({ asset, codeHash: [hash, hash] }));
    assert.equal(R.signIdIntent(ID_SECRET, it).payload, ft({ token }));
  }
  const solHash = R.FT_WITHDRAW_TOKENS[SOL_TOKEN]!, baseHash = R.FT_WITHDRAW_TOKENS[BASE_TOKEN]!;
  const bad = (rule: string, payload: string, o: Partial<FtWithdrawReads>, typed = "alice.near") => refused(rule, () => R.checkIdFtWithdrawIntent(payload, typed, fctx(o)));
  // another listed token's hash, or the vault token's, on an omft token
  bad("code_hash", ft({ token: SOL_TOKEN }), { asset: SOL_USDC, codeHash: [baseHash, baseHash] });
  bad("code_hash", ft({ token: SOL_TOKEN }), { asset: SOL_USDC, codeHash: [VAULT_TOKEN_CODE_HASH, VAULT_TOKEN_CODE_HASH] });
  bad("reads", ft({ token: SOL_TOKEN }), { asset: SOL_USDC, codeHash: [solHash, baseHash] });
  // a token the id's balance was not read on: Base USDC while the reads are of Solana USDC
  bad("token", ft({ token: BASE_TOKEN }), { asset: SOL_USDC, codeHash: [baseHash, baseHash] });
  // an omft token the deposit path does not take
  bad("token", ft({ token: "sol.omft.near" }), { asset: "nep141:sol.omft.near" });
  // a listed token as the receiver
  for (const t of [SOL_TOKEN, BASE_TOKEN]) bad("receiver_id", ft({ token: SOL_TOKEN, receiver_id: t }), { asset: SOL_USDC, codeHash: [solHash, solHash] }, t);
});

test("one ask, one signature: a checked quote passes one intent or send, a checked payload signs once, and priorDeadline is always said", () => {
  // two intents for one checked quote, with the money for both
  const rich = ictx({ reads: reads({ held: 2n * AMOUNT }, { held: 2n * AMOUNT }) });
  const q = refundQuote();
  const first = R.checkIdTransferIntent(transferPayload(), q, rich);
  const salt = base64.decode(nonceOf(DEADLINE));
  salt[31] = 7; // another salt: another intent for the same money
  refused("unchecked", () => R.checkIdTransferIntent(transferPayload({}, { nonce: base64.encode(salt) }), q, rich));
  R.signIdIntent(ID_SECRET, first);
  refused("unchecked", () => R.signIdIntent(ID_SECRET, first));
  // a second intent for the same id: a fresh quote, and the caller must say the first one's deadline
  const { priorDeadline: _, ...said } = rich;
  refused("prior_deadline", () => R.checkIdTransferIntent(transferPayload(), refundQuote(), said as IdIntentContext));
  refused("prior_deadline", () => R.checkIdTransferIntent(transferPayload(), refundQuote(), { ...rich, priorDeadline: undefined as unknown as null }));
  refused("prior_deadline", () => R.checkIdTransferIntent(transferPayload(), refundQuote(), { ...rich, priorDeadline: DEADLINE }));
  // the ft_withdraw too
  const { priorDeadline: __, ...ftSaid } = fctx();
  refused("prior_deadline", () => R.checkIdFtWithdrawIntent(ft(), "alice.near", ftSaid as ReturnType<typeof fctx>));
  // a return quote passes one send: Solana, then EVM
  const sq = returnQuote();
  R.checkReturnSolana(wireOf(solMessage()), sq, solReads());
  refused("unchecked", () => R.checkReturnSolana(wireOf(solMessage()), sq, solReads()));
  const eq = returnQuote("base");
  const tx = evmTx();
  R.checkReturnEvm(tx, eq, evmReads());
  refused("unchecked", () => R.checkReturnEvm(evmTx(), eq, evmReads()));
  R.signReturnEvm(EVM_SECRET, tx);
  refused("unchecked", () => R.signReturnEvm(EVM_SECRET, tx));
  const wire = wireOf(solMessage());
  R.checkReturnSolana(wire, returnQuote(), solReads());
  R.signReturnSolana(W_SECRET, wire);
  refused("unchecked", () => R.signReturnSolana(W_SECRET, wire));
});

test("no rule reads a field from our servers: refund.ts imports no helper module and fetches nothing", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/rules/refund.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /apps\/helper|kit\/src\/helper|fetch\(|XMLHttpRequest|WebSocket/);
});
