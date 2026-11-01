// U's signed deposit call (card wallet-deposit-delegate; wallet.md §2.4 step 7 and §2.8 deposit call row, W:416,
// W:898; V 2.10 (b), V:669-673; OD:262).   node --test test/deposit-delegate.test.ts   (from packages/wallet)
// The shared vector is test/vectors/deposit-delegate.json (written by test/record-deposit-delegate.mjs from the public
// test seed); its `expect` block is written from the inputs, not from the bytes. The bytes are checked three ways: the
// helper's own decoder and checks (apps/helper/src/bind/checks.ts, H4.3 checks 1-7, M:1715-1754) on the vector and on
// every hand-altered field; near-api-js 7.3.1's borsh of the helper's fixture equals ours; and the signature verifies
// under node:crypto.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HELPER_BIND_DEPOSIT_CAP, VAULT_CONSTANTS, VAULT_FIELD_P } from "@blindfill/kit";
import { base58 } from "@scure/base";
import {
  type BindConfig,
  type BindLedger,
  type BindReads,
  checkBindDeposit,
  decodeSignedDelegate,
  EXPIRY_MAX_BLOCKS,
} from "../../../apps/helper/src/bind/checks.ts";
import { type DepositAccount, type NearRpc, NEAR_NETWORKS, DepositAccountRefused } from "../src/deposit/account.ts";
import {
  BIND_MAX_BYTES,
  DEPOSIT_WINDOW,
  DEPOSIT_WINDOW_MAX,
  type DelegateFields,
  type DelegateRefusalCode,
  depositDelegate,
  DepositDelegateRefused,
  encodeDelegateAction,
  NEP366_PREFIX,
  RELEASE_BIND_URL,
  sendDepositDelegate,
  signDelegateAction,
  signDepositDelegate,
} from "../src/deposit/delegate.ts";
import { depositId } from "../src/derive/keys.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/deposit-delegate.json", import.meta.url), "utf8"));
const SEED = new Uint8Array(64).fill(0x42); // the public test seed of deposit-account.json's test_u: U_{1,0}
const S = BigInt(V.input.s);
const I = V.input.i as number;
const VAULT = V.input.vault as string;
const AMOUNT = BigInt(V.input.amount);
const P = BigInt(V.input.precommitment);
const READ: DepositAccount = {
  ...V.input.read,
  balance: BigInt(V.input.read.balance),
  codeHash: "unused here",
  halted: false,
  pendingPause: "unread",
};
const ARGS = { vault: VAULT, network: "mainnet" as const, amount: AMOUNT, precommitment: P };
const TOKEN = NEAR_NETWORKS.mainnet.token;
const sign = (over: Partial<typeof ARGS & { window: number }> = {}, read: Partial<DepositAccount> = {}) =>
  signDepositDelegate(SEED, S, I, { ...ARGS, ...over }, { ...READ, ...read });
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

function refused(f: () => unknown, code: DelegateRefusalCode, detail?: RegExp) {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof DepositDelegateRefused, `not a refusal: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (detail) assert.match(e.message, detail);
    return true;
  });
}

// The helper's checks, with reads that say the vector's U exists with its key at the read nonce, the final height is
// the read height, U holds the amount, and P and U are clear in the ledger.
const CFG: BindConfig = { vault: VAULT, token: TOKEN, marginK: 60n };
const reads = (over: Partial<BindReads> = {}): BindReads => ({
  accessKey: async (account, publicKey) =>
    account === READ.account && publicKey === READ.publicKey ? { kind: "key", permission: "FullAccess", nonce: BigInt(READ.nonce) } : { kind: "no_account" },
  finalHeight: async () => BigInt(READ.height),
  ftBalance: async (account) => (account === READ.account ? READ.balance : 0n),
  pUsed: async () => false,
  ...over,
});
const LEDGER: BindLedger = { struck: async () => false, boundTo: async () => null, openP: async () => null, inFlight: async () => false };
const helper = (b64: string, r: BindReads = reads()) => checkBindDeposit({ signed_delegate: b64 }, CFG, r, LEDGER);

test("the vector: the device's bytes equal the shared vector, and the helper's decoder reads exactly that action", () => {
  const out = sign({ window: V.input.window });
  assert.equal(out.signed_delegate, V.signed_delegate);
  assert.equal(V.input.window, DEPOSIT_WINDOW);
  const d = decodeSignedDelegate(bytesOf(out.signed_delegate));
  const e = V.expect;
  assert.equal(d.sender_id, e.sender_id);
  assert.equal(d.sender_id, depositId(SEED, S, I).id);
  assert.equal(d.receiver_id, e.receiver_id);
  assert.equal(d.receiver_id, VAULT_CONSTANTS.TOKEN);
  assert.equal(d.actions.length, 1);
  const a = d.actions[0]!;
  assert.equal(a.kind, "FunctionCall");
  if (a.kind !== "FunctionCall") return;
  assert.equal(a.method_name, e.method_name);
  assert.equal(Buffer.from(a.args).toString("utf8"), e.args);
  assert.deepEqual(JSON.parse(JSON.parse(e.args).msg), { precommitment: V.input.precommitment, depositor: e.sender_id });
  assert.equal(a.gas, BigInt(e.gas));
  assert.equal(a.gas, 180n * 10n ** 12n);
  assert.equal(a.deposit, 1n);
  assert.equal(d.nonce, BigInt(e.nonce));
  assert.equal(d.nonce, BigInt(READ.nonce) + 1n); // U's key nonce + 1
  assert.equal(d.max_block_height, BigInt(e.max_block_height));
  assert.equal(d.max_block_height, BigInt(READ.height) + 120n); // the lower read height + W
  assert.equal(`ed25519:${base58.encode(d.public_key)}`, e.public_key);
  assert.deepEqual(
    { sender_id: out.sender_id, receiver_id: out.receiver_id, nonce: out.nonce, max_block_height: out.max_block_height, public_key: out.public_key },
    { sender_id: e.sender_id, receiver_id: e.receiver_id, nonce: BigInt(e.nonce), max_block_height: BigInt(e.max_block_height), public_key: e.public_key },
  );
  // The signature verifies under node:crypto over sha256(u32le(2^30 + 366) || borsh(DelegateAction)).
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP366_PREFIX);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(d.public_key).toString("base64url") }, format: "jwk" });
  assert.ok(verify(null, createHash("sha256").update(prefix).update(d.delegate).digest(), key, d.signature));
});

test("borsh: our encoding of near-api-js 7.3.1's delegate (the helper's fixture) equals its bytes before the signature", () => {
  const fx = JSON.parse(readFileSync(new URL("../../../apps/helper/src/bind/fixtures/near-api-js-deposit.json", import.meta.url), "utf8"));
  const theirs = bytesOf(fx.signed_delegate);
  const ours = encodeDelegateAction({
    sender_id: fx.sender_id,
    receiver_id: fx.receiver_id,
    method_name: fx.method_name,
    args: new TextEncoder().encode(fx.args),
    gas: BigInt(fx.gas),
    deposit: BigInt(fx.deposit),
    nonce: BigInt(fx.nonce),
    max_block_height: BigInt(fx.max_block_height),
    public_key: base58.decode(fx.public_key.slice("ed25519:".length)),
  });
  assert.equal(theirs.length, ours.length + 65); // + ed25519's tag and 64-byte signature
  assert.deepEqual(Buffer.from(theirs.subarray(0, ours.length)), Buffer.from(ours));
});

test("H4.3 checks 1-7: the helper passes the vector, and carries what the device signed", async () => {
  const v = await helper(V.signed_delegate);
  assert.ok(v.ok, v.ok ? "" : `${v.code}: ${v.why}`);
  if (!v.ok) return;
  assert.equal(v.deposit.sender_id, READ.account);
  assert.equal(v.deposit.depositor, READ.account);
  assert.equal(v.deposit.public_key, READ.publicKey);
  assert.equal(v.deposit.amount, AMOUNT);
  assert.equal(v.deposit.precommitment, P);
  assert.equal(v.deposit.nonce, BigInt(READ.nonce) + 1n);
  assert.equal(v.deposit.max_block_height, BigInt(READ.height) + 120n);
  assert.deepEqual(Buffer.from(v.deposit.signed_delegate), Buffer.from(bytesOf(V.signed_delegate)));
  // The window at its bound, 600, passes too; the helper's 600 is the device's.
  assert.equal(BigInt(DEPOSIT_WINDOW_MAX), EXPIRY_MAX_BLOCKS);
  const v600 = await helper(sign({ window: DEPOSIT_WINDOW_MAX }).signed_delegate);
  assert.ok(v600.ok, v600.ok ? "" : `${v600.code}: ${v600.why}`);
});

// The vector's fields, so each can be altered by hand and re-encoded.
function vectorFields(): { fields: DelegateFields; signature: Uint8Array } {
  const d = decodeSignedDelegate(bytesOf(V.signed_delegate));
  const a = d.actions[0]!;
  if (a.kind !== "FunctionCall") throw new Error("not a FunctionCall");
  return {
    fields: {
      sender_id: d.sender_id,
      receiver_id: d.receiver_id,
      method_name: a.method_name,
      args: Uint8Array.from(a.args),
      gas: a.gas,
      deposit: a.deposit,
      nonce: d.nonce,
      max_block_height: d.max_block_height,
      public_key: Uint8Array.from(d.public_key),
    },
    signature: Uint8Array.from(d.signature),
  };
}
const withSignature = (delegate: Uint8Array, sig: Uint8Array) => Buffer.concat([delegate, Uint8Array.of(0), sig]).toString("base64");
const argsWith = (over: Record<string, string>) => new TextEncoder().encode(JSON.stringify({ ...JSON.parse(V.expect.args), ...over }));
const other = depositId(SEED, 1n, 1);

const ALTERED: [string, (f: DelegateFields) => void][] = [
  ["sender_id", (f) => void (f.sender_id = other.id)],
  ["receiver_id", (f) => void (f.receiver_id = "usdc.fakes.near")],
  ["method_name", (f) => void (f.method_name = "ft_transfer")],
  ["args.receiver_id", (f) => void (f.args = argsWith({ receiver_id: "evil.near" }))],
  ["args.amount", (f) => void (f.args = argsWith({ amount: "25000001" }))],
  ["args.msg", (f) => void (f.args = argsWith({ msg: JSON.stringify({ precommitment: "7", depositor: READ.account }) }))],
  ["gas", (f) => void (f.gas += 1n)],
  ["deposit", (f) => void (f.deposit = 2n)],
  ["nonce", (f) => void (f.nonce += 1n)],
  ["max_block_height", (f) => void (f.max_block_height -= 1n)],
  ["public_key", (f) => void (f.public_key = other.publicKey)],
];

test("H4.3 checks 1-7: every hand-altered field of the signed bytes is refused by the helper", async () => {
  for (const [name, alter] of ALTERED) {
    const { fields, signature } = vectorFields();
    alter(fields);
    const v = await helper(withSignature(encodeDelegateAction(fields), signature));
    assert.ok(!v.ok, `${name} altered passed`);
    assert.equal(v.code, "bad_signature", `${name}: ${v.ok ? "" : v.why}`);
  }
  // The signature itself: one bit flipped, then the signature's key tag.
  const raw = bytesOf(V.signed_delegate);
  const flipped = Uint8Array.from(raw);
  flipped[flipped.length - 1] ^= 1;
  const v1 = await helper(Buffer.from(flipped).toString("base64"));
  assert.ok(!v1.ok && v1.code === "bad_signature");
  const tag = Uint8Array.from(raw);
  tag[raw.length - 65] = 1; // secp256k1's tag
  const v2 = await helper(Buffer.from(tag).toString("base64"));
  assert.ok(!v2.ok && v2.code === "bad_shape");
  // A byte cut off or added.
  for (const b of [raw.subarray(0, raw.length - 1), Buffer.concat([raw, Uint8Array.of(0)])]) {
    const v = await helper(Buffer.from(b).toString("base64"));
    assert.ok(!v.ok && v.code === "bad_shape");
  }
});

test("H4.3: what the device refuses to sign, the helper refuses too when U's key signs it anyway", async () => {
  const u = depositId(SEED, S, I);
  const resigned = (alter: (f: DelegateFields) => void) => {
    const { fields } = vectorFields();
    alter(fields);
    return Buffer.from(signDelegateAction(fields, u.secretKey)).toString("base64");
  };
  // The same bytes re-signed pass, so each refusal below is its field's.
  assert.equal(resigned(() => {}), V.signed_delegate);
  const big = HELPER_BIND_DEPOSIT_CAP + 1n;
  const cases: [string, (f: DelegateFields) => void, string, BindReads?][] = [
    ["a window over 600", (f) => void (f.max_block_height = BigInt(READ.height) + 601n), "expired"],
    ["an amount over the cap", (f) => void (f.args = argsWith({ amount: big.toString() })), "amount_above_cap", reads({ ftBalance: async () => big })],
    ["gas under 180 Tgas", (f) => void (f.gas -= 1n), "gas_too_low"],
    ["2 yocto", (f) => void (f.deposit = 2n), "deposit_not_1_yocto"],
    ["another token", (f) => void (f.receiver_id = "usdc.fakes.near"), "token_not_accepted"],
    ["another vault", (f) => void (f.args = argsWith({ receiver_id: "evil.near" })), "bad_receiver"],
    ["the read nonce, not + 1", (f) => void (f.nonce -= 1n), "bad_nonce"],
  ];
  for (const [name, alter, code, r] of cases) {
    const v = await helper(resigned(alter), r);
    assert.ok(!v.ok, `${name} passed`);
    assert.equal(v.code, code, `${name}: ${v.why}`);
  }
});

test("the device refuses before signing: the cap, a window over 600 or not whole, P not below p, a bad vault", () => {
  const rich = { balance: HELPER_BIND_DEPOSIT_CAP * 2n };
  refused(() => sign({ amount: HELPER_BIND_DEPOSIT_CAP + 1n }, rich), "call", /HELPER_BIND_DEPOSIT_CAP/);
  assert.ok(sign({ amount: HELPER_BIND_DEPOSIT_CAP }, rich).signed_delegate.length > 0); // the cap itself is signed
  refused(() => sign({ amount: VAULT_CONSTANTS.MIN_DEPOSIT - 1n }), "call", /MIN_DEPOSIT/);
  for (const w of [DEPOSIT_WINDOW_MAX + 1, 10_000, 0, -1, 1.5, Number.NaN]) refused(() => sign({ window: w }), "window");
  assert.equal(sign({ window: 1 }).max_block_height, BigInt(READ.height) + 1n);
  refused(() => sign({ precommitment: VAULT_FIELD_P }), "call", /below p/);
  refused(() => sign({ vault: "intents.near" }), "call", /intents\.near/);
  refused(() => sign({ vault: TOKEN }), "call", /token/);
  refused(() => sign({ vault: READ.account }), "call", /mover/);
  refused(() => sign({ network: "devnet" as "mainnet" }), "input");
});

test("the device refuses before signing: a read of another account, over U's read balance, a nonce out of range", () => {
  const o = depositId(SEED, 1n, 1);
  refused(() => sign({}, { account: o.id }), "key");
  refused(() => sign({}, { publicKey: `ed25519:${base58.encode(o.publicKey)}` }), "key");
  refused(() => sign({}, { balance: AMOUNT - 1n }), "balance");
  assert.ok(sign({}, { balance: AMOUNT }).signed_delegate.length > 0);
  refused(() => sign({}, { nonce: READ.height * 1_000_000 - 1 }), "nonce"); // nonce + 1 = height x 10^6
  for (const n of [-1, 1.5, 2 ** 53]) refused(() => sign({}, { nonce: n }), "input");
  refused(() => sign({}, { height: 0 }), "input");
  refused(() => sign({}, { halted: true as false }), "input");
  refused(() => sign({}, { balance: 25 as unknown as bigint }), "input");
});

test("the signed call fits /v1/bind's 4 KB, with the longest vault id and the largest P", () => {
  assert.ok(bytesOf(sign().signed_delegate).length <= BIND_MAX_BYTES);
  const long = `${"a".repeat(56)}.testnet`;
  assert.equal(long.length, 64);
  assert.ok(bytesOf(sign({ vault: long, precommitment: VAULT_FIELD_P - 1n }).signed_delegate).length <= BIND_MAX_BYTES);
});

// U's reads on two RPCs, replayed from test/vectors/deposit-account.json with the good account's key list edited to
// U_{1,0}'s key: depositDelegate signs only once every read passed.
type Answers = Record<string, { a: { url: string; json: unknown }; b: { url: string; json: unknown } }>;
const REC = JSON.parse(readFileSync(new URL("./vectors/deposit-account.json", import.meta.url), "utf8")) as { answers: Answers };
function replay(side: "a" | "b", keys = "keys_good", sent: unknown[] = []): NearRpc {
  return {
    name: REC.answers.keys_good[side].url,
    async query(params) {
      sent.push(params);
      const pick = params.request_type === "view_access_key_list" ? keys : params.request_type === "call_function" ? "balance_good" : "code";
      const j = structuredClone(REC.answers[pick]![side].json) as any;
      if (pick === "keys_good") j.result.keys[0].public_key = READ.publicKey;
      return j;
    },
  };
}

test("depositDelegate: reads U on two RPCs, then signs at the read nonce + 1 and the lower height + W", async () => {
  const sent: unknown[] = [];
  const out = await depositDelegate(SEED, S, I, ARGS, [replay("a", "keys_good", sent), replay("b", "keys_good", sent)]);
  const d = decodeSignedDelegate(bytesOf(out.signed_delegate));
  assert.equal(d.nonce, 121445688000168n + 1n); // keys_good's recorded nonce
  assert.equal(d.max_block_height, 222541714n + 120n); // the lowest of the six recorded heights
  assert.equal(d.sender_id, READ.account);
  // No read carries a key, the words or a second id of the user.
  assert.equal(sent.length, 6);
  for (const p of sent as Record<string, unknown>[]) assert.ok(p.account_id === READ.account || p.account_id === TOKEN, JSON.stringify(p));
  assert.ok(!JSON.stringify(sent).includes(Buffer.from(depositId(SEED, S, I).secretKey).toString("hex")));
  // A U not created yet: the read stops it and nothing is signed.
  await assert.rejects(depositDelegate(SEED, S, I, ARGS, [replay("a", "keys_no_account"), replay("b", "keys_no_account")]), DepositAccountRefused);
});

test("send: only to the release's /v1/bind, the signed call alone, no cookies; the answer is checked", async () => {
  const out = sign();
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
  const hash = base58.encode(new Uint8Array(32).fill(7));
  assert.deepEqual(await sendDepositDelegate(out, answer(200, { tx_hash: hash })), { ok: true, tx_hash: hash });
  assert.equal(calls[0]!.url, RELEASE_BIND_URL);
  assert.equal(RELEASE_BIND_URL, "https://api.confidential.unrealized.trade/v1/bind");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[0]!.init.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { signed_delegate: out.signed_delegate });
  // Only the base64 field goes, whatever else the caller's object holds.
  await sendDepositDelegate({ ...out, secret: "x" } as typeof out, answer(200, { tx_hash: hash }));
  assert.deepEqual(Object.keys(JSON.parse(String(calls[1]!.init.body))), ["signed_delegate"]);
  // The relayer's codes come back as codes.
  assert.deepEqual(await sendDepositDelegate(out, answer(409, { error: { code: "prepay_open" } })), { ok: false, code: "prepay_open" });
  assert.deepEqual(await sendDepositDelegate(out, answer(400, { error: { code: "amount_above_cap" } })), { ok: false, code: "amount_above_cap" });
  // Anything else is not an answer.
  for (const [status, body] of [
    [200, { tx_hash: "not base58 0OIl" }],
    [200, { tx_hash: base58.encode(new Uint8Array(31)) }],
    [200, { error: { code: "prepay_open" } }],
    [400, { error: { code: "made_up" } }],
    [502, "<html>bad gateway</html>"],
    [200, null],
  ] as [number, unknown][]) {
    await assert.rejects(sendDepositDelegate(out, answer(status, body)), /relayer/, JSON.stringify(body));
  }
});
