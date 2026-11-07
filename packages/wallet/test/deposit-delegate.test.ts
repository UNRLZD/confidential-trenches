// U's signed deposit call (card wallet-deposit-delegate; wallet.md §2.4 step 7 and §2.8 deposit call row, W:416,
// W:898; V 2.10 (b), V:669-673; OD:262).   node --test test/deposit-delegate.test.ts   (from packages/wallet)
// The shared vector is test/vectors/deposit-delegate.json (written by test/record-deposit-delegate.mjs from the public
// test seed through depositDelegate, U's reads replayed by test/replay-deposit-reads.ts); its `expect` block is written
// from the inputs, not from the bytes. The bytes are checked three ways: the helper's own decoder and checks
// (apps/helper/src/bind/checks.ts, H4.3 checks 1-7, M:1715-1754) on the vector and on every hand-altered field;
// near-api-js 7.3.1's borsh of the helper's fixture equals ours; and the signature verifies under node:crypto.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HELPER_BIND_ANSWER_MS, HELPER_BIND_DEPOSIT_CAP, VAULT_CONSTANTS, VAULT_FIELD_P } from "@blindfill/kit";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import {
  type BindConfig,
  type BindLedger,
  type BindReads,
  checkBindDeposit,
  decodeSignedDelegate,
  EXPIRY_MAX_BLOCKS,
} from "../../../apps/helper/src/bind/checks.ts";
import { DepositAccountRefused, NEAR_NETWORKS } from "../src/deposit/account.ts";
import * as delegateModule from "../src/deposit/delegate.ts";
import {
  BIND_ANSWER_MAX_BYTES,
  BIND_MAX_BYTES,
  DEPOSIT_WINDOW,
  DEPOSIT_WINDOW_MAX,
  type DelegateFields,
  type DelegateRefusalCode,
  depositDelegate,
  type DepositDelegateArgs,
  DepositDelegateRefused,
  encodeDelegateAction,
  NEP366_PREFIX,
  RELEASE_BIND_URL,
  sendDepositDelegate,
} from "../src/deposit/delegate.ts";
import { depositId } from "../src/derive/keys.ts";
import { type ReadKind, replayDepositReads } from "./replay-deposit-reads.ts";
import { withSendClock } from "./send-clock.ts";

const V = JSON.parse(readFileSync(new URL("./vectors/deposit-delegate.json", import.meta.url), "utf8"));
const SEED = new Uint8Array(64).fill(0x42); // the public test seed of deposit-account.json's test_u: U_{1,0}
const S = BigInt(V.input.s);
const I = V.input.i as number;
const NET = NEAR_NETWORKS.testnet;
const AMOUNT = BigInt(V.input.amount);
const P = BigInt(V.input.precommitment);
const U = V.expect.sender_id as string;
const PUB = V.expect.public_key as string;
const NONCE = BigInt(V.input.read.nonce); // keys_good's recorded nonce
const HEIGHT = BigInt(V.input.read.height); // the lowest of the six recorded heights
const BALANCE = 323841010000n; // balance_good's recorded USDC
const ARGS: DepositDelegateArgs = { network: "testnet", amount: AMOUNT, precommitment: P };
type Replay = Parameters<typeof replayDepositReads>[2];
const sign = (over: Partial<DepositDelegateArgs> = {}, replay: Replay = {}) =>
  depositDelegate(SEED, S, I, { ...ARGS, ...over }, replayDepositReads(over.network ?? "testnet", PUB, replay));
const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

async function refused(p: Promise<unknown>, code: DelegateRefusalCode, detail?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof DepositDelegateRefused, `not a refusal: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (detail) assert.match(e.message, detail);
    return true;
  });
}

// The helper's checks, with reads that say U exists with its key at the read nonce, the final height is the read
// height, U holds the recorded USDC, and P and U are clear in the ledger.
const CFG: BindConfig = { vault: NET.vault, token: NET.usdc, marginK: 60n };
const reads = (over: Partial<BindReads> = {}): BindReads => ({
  accessKey: async (account, publicKey) => (account === U && publicKey === PUB ? { kind: "key", permission: "FullAccess", nonce: NONCE } : { kind: "no_account" }),
  finalHeight: async () => HEIGHT,
  ftBalance: async (account) => (account === U ? BALANCE : 0n),
  pUsed: async () => false,
  ...over,
});
const LEDGER: BindLedger = { struck: async () => false, boundTo: async () => null, openP: async () => null, inFlight: async () => false };
const helper = (b64: string, r: BindReads = reads()) => checkBindDeposit({ signed_delegate: b64 }, CFG, r, LEDGER);
const why = (v: Awaited<ReturnType<typeof helper>>) => (v.ok ? "" : `${v.code}: ${v.why}`);

test("the vector: the device's bytes equal the shared vector, and the helper's decoder reads exactly that action", async () => {
  const sent: unknown[] = [];
  const out = await sign({ window: V.input.window }, { sent });
  assert.equal(out.signed_delegate, V.signed_delegate);
  assert.equal(V.input.window, DEPOSIT_WINDOW);
  const d = decodeSignedDelegate(bytesOf(out.signed_delegate));
  const e = V.expect;
  assert.equal(d.sender_id, e.sender_id);
  assert.equal(d.sender_id, depositId(SEED, S, I).id);
  assert.equal(d.receiver_id, e.receiver_id);
  assert.equal(d.receiver_id, NET.usdc);
  assert.equal(d.actions.length, 1);
  const a = d.actions[0]!;
  assert.equal(a.kind, "FunctionCall");
  if (a.kind !== "FunctionCall") return;
  assert.equal(a.method_name, e.method_name);
  assert.equal(Buffer.from(a.args).toString("utf8"), e.args);
  assert.equal(JSON.parse(e.args).receiver_id, e.vault);
  assert.deepEqual(JSON.parse(JSON.parse(e.args).msg), { precommitment: V.input.precommitment, depositor: e.sender_id });
  assert.equal(a.gas, BigInt(e.gas));
  assert.equal(a.gas, 180n * 10n ** 12n);
  assert.equal(a.deposit, 1n);
  assert.equal(d.nonce, BigInt(e.nonce));
  assert.equal(d.nonce, NONCE + 1n); // U's key nonce + 1
  assert.equal(d.max_block_height, BigInt(e.max_block_height));
  assert.equal(d.max_block_height, HEIGHT + 120n); // the lower read height + W
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
  // The six reads name U or the token only, at final; none carries a key or a second id of the user.
  assert.equal(sent.length, 6);
  for (const p of sent as Record<string, unknown>[]) assert.ok(p.account_id === U || p.account_id === NET.usdc, JSON.stringify(p));
});

test("the vault is the release's: each network's from its deployment file, none on mainnet until it has one, and no argument names one", async () => {
  const deployment = (name: string) => new URL(`../../../contracts/vault/deployments/${name}.json`, import.meta.url);
  const dep = JSON.parse(readFileSync(deployment("testnet-v1"), "utf8"));
  assert.equal(dep.network, "testnet");
  assert.equal(NET.vault, dep.account_id);
  assert.equal(V.expect.vault, dep.account_id);
  // Mainnet: the vault is mainnet-v1.json's (the record the mainnet deploy writes), and null exactly while that file is
  // absent. mainnet-test.json is the test vault on mainnet, never the release's.
  const testVault = JSON.parse(readFileSync(deployment("mainnet-test"), "utf8")).account_id;
  assert.notEqual(NEAR_NETWORKS.mainnet.vault, testVault);
  if (existsSync(deployment("mainnet-v1"))) {
    const main = JSON.parse(readFileSync(deployment("mainnet-v1"), "utf8"));
    assert.equal(main.network, "mainnet");
    assert.equal(typeof main.account_id, "string");
    assert.equal(NEAR_NETWORKS.mainnet.vault, main.account_id);
  } else {
    assert.equal(NEAR_NETWORKS.mainnet.vault, null);
    // U's reads pass, then nothing is signed until the release writes a vault.
    await refused(sign({ network: "mainnet" }), "no_vault", /mainnet/);
  }
  // A vault slipped into the arguments is not read: the call still names the release's vault, byte for byte.
  const out = await sign({ vault: "attacker.near" } as Partial<DepositDelegateArgs>);
  assert.equal(out.signed_delegate, V.signed_delegate);
  // Nothing on the page can repoint a network after load.
  assert.throws(() => void ((NEAR_NETWORKS.testnet as { vault: string }).vault = "attacker.near"), TypeError);
  assert.throws(() => void ((NEAR_NETWORKS as Record<string, unknown>).testnet = { ...NET, vault: "attacker.near" }), TypeError);
  assert.throws(() => void (NEAR_NETWORKS.testnet.fastnear as unknown as string[]).push("https://evil.example"), TypeError);
  assert.equal(NET.vault, dep.account_id);
});

test("no hand-made read is signed: the module exports no signer but depositDelegate, which reads first", async () => {
  assert.deepEqual(Object.keys(delegateModule).sort(), [
    "BIND_ANSWER_MAX_BYTES",
    "BIND_MAX_BYTES",
    "DEPOSIT_WINDOW",
    "DEPOSIT_WINDOW_MAX",
    "DepositDelegateRefused",
    "NEP366_PREFIX",
    "NONCE_RANGE_MULTIPLIER",
    "RELEASE_BIND_URL",
    "SEND_TIMEOUT_MS",
    "depositDelegate",
    "encodeDelegateAction",
    "sendDepositDelegate",
  ]);
  // The read and the call are on one network: mainnet's RPCs for a testnet call are refused before anything is signed.
  await assert.rejects(depositDelegate(SEED, S, I, ARGS, replayDepositReads("mainnet", PUB)), DepositAccountRefused);
  // A U not created yet stops at the read.
  await assert.rejects(sign({}, { keys: "keys_no_account" }), DepositAccountRefused);
});

test("what is signed is what was read: args and seed64 changed while the reads are out do not reach the call", async () => {
  const signedArgs = (out: { signed_delegate: string }) => {
    const d = decodeSignedDelegate(bytesOf(out.signed_delegate));
    const a = d.actions[0]!;
    assert.equal(a.kind, "FunctionCall");
    return { d, args: JSON.parse(Buffer.from(a.kind === "FunctionCall" ? a.args : new Uint8Array()).toString()) };
  };
  const balanceOf = (v: string) => [...Buffer.from(JSON.stringify(v))];
  // The amount raised to the cap during the reads, U read at 25 USDC: the call stays at the amount that was read.
  {
    const args: DepositDelegateArgs = { ...ARGS };
    const edit = (kind: ReadKind, j: any) => {
      if (kind !== "balance") return;
      j.result.result = balanceOf("25000000");
      args.amount = HELPER_BIND_DEPOSIT_CAP;
    };
    const out = await depositDelegate(SEED, S, I, args, replayDepositReads("testnet", PUB, { edit }));
    assert.equal(args.amount, HELPER_BIND_DEPOSIT_CAP); // the change happened
    assert.equal(signedArgs(out).args.amount, "25000000");
    assert.equal(out.signed_delegate, V.signed_delegate);
  }
  // The caller's seed64 zeroed during the reads: the call is still U's, the account that was read.
  {
    const seed = Uint8Array.from(SEED);
    const edit = (kind: ReadKind) => void (kind === "code" && seed.fill(0));
    const out = await depositDelegate(seed, S, I, ARGS, replayDepositReads("testnet", PUB, { edit }));
    assert.ok(seed.every((x) => x === 0));
    assert.equal(signedArgs(out).d.sender_id, U);
    assert.equal(out.signed_delegate, V.signed_delegate);
  }
  // The network, P and the window changed during the reads: none of them reaches the call.
  {
    const args: DepositDelegateArgs = { ...ARGS, window: 120 };
    const edit = (kind: ReadKind) => {
      if (kind !== "code") return;
      args.network = "mainnet";
      args.precommitment = 8n;
      args.window = 600;
    };
    const out = await depositDelegate(SEED, S, I, args, replayDepositReads("testnet", PUB, { edit }));
    assert.equal(out.signed_delegate, V.signed_delegate);
  }
  // The caller's seed is never written: depositDelegate works on its own copy.
  const seed = Uint8Array.from(SEED);
  await sign();
  await depositDelegate(seed, S, I, ARGS, replayDepositReads("testnet", PUB));
  assert.deepEqual(seed, SEED);
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
  assert.ok(v.ok, why(v));
  if (!v.ok) return;
  assert.equal(v.deposit.sender_id, U);
  assert.equal(v.deposit.depositor, U);
  assert.equal(v.deposit.public_key, PUB);
  assert.equal(v.deposit.amount, AMOUNT);
  assert.equal(v.deposit.precommitment, P);
  assert.equal(v.deposit.nonce, NONCE + 1n);
  assert.equal(v.deposit.max_block_height, HEIGHT + 120n);
  assert.deepEqual(Buffer.from(v.deposit.signed_delegate), Buffer.from(bytesOf(V.signed_delegate)));
  // The window at its bound, 600, passes too; the helper's 600 is the device's.
  assert.equal(BigInt(DEPOSIT_WINDOW_MAX), EXPIRY_MAX_BLOCKS);
  const v600 = await helper((await sign({ window: DEPOSIT_WINDOW_MAX })).signed_delegate);
  assert.ok(v600.ok, why(v600));
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
other.secretKey.fill(0);
// U's key signing whatever fields the test gives it, as the device never would.
function testSign(fields: DelegateFields): string {
  const delegate = encodeDelegateAction(fields);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(NEP366_PREFIX);
  const k = depositId(SEED, S, I).secretKey;
  try {
    return withSignature(delegate, ed25519.sign(sha256(Buffer.concat([prefix, delegate])), k));
  } finally {
    k.fill(0);
  }
}

const ALTERED: [string, (f: DelegateFields) => void][] = [
  ["sender_id", (f) => void (f.sender_id = other.id)],
  ["receiver_id", (f) => void (f.receiver_id = "usdc.fakes.near")],
  ["method_name", (f) => void (f.method_name = "ft_transfer")],
  ["args.receiver_id", (f) => void (f.args = argsWith({ receiver_id: "evil.near" }))],
  ["args.amount", (f) => void (f.args = argsWith({ amount: "25000001" }))],
  ["args.msg", (f) => void (f.args = argsWith({ msg: JSON.stringify({ precommitment: "7", depositor: U }) }))],
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
    assert.equal(v.code, "bad_signature", `${name}: ${v.why}`);
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
  const resigned = (alter: (f: DelegateFields) => void) => {
    const { fields } = vectorFields();
    alter(fields);
    return testSign(fields);
  };
  // The same fields re-signed give the vector, so each refusal below is its field's.
  assert.equal(resigned(() => {}), V.signed_delegate);
  const big = HELPER_BIND_DEPOSIT_CAP + 1n;
  const cases: [string, (f: DelegateFields) => void, string, BindReads?][] = [
    ["a window over 600", (f) => void (f.max_block_height = HEIGHT + 601n), "expired"],
    ["an amount over the cap", (f) => void (f.args = argsWith({ amount: big.toString() })), "amount_above_cap"],
    ["gas under 180 Tgas", (f) => void (f.gas -= 1n), "gas_too_low"],
    ["2 yocto", (f) => void (f.deposit = 2n), "deposit_not_1_yocto"],
    ["another token", (f) => void (f.receiver_id = "usdc.fakes.near"), "token_not_accepted"],
    ["another vault", (f) => void (f.args = argsWith({ receiver_id: "attacker.near" })), "bad_receiver"],
    ["the read nonce, not + 1", (f) => void (f.nonce -= 1n), "bad_nonce"],
  ];
  for (const [name, alter, code, r] of cases) {
    const v = await helper(resigned(alter), r);
    assert.ok(!v.ok, `${name} passed`);
    assert.equal(v.code, code, `${name}: ${v.why}`);
  }
});

test("the device refuses before signing: the cap, a window over 600 or not whole, P outside 1..p-1 (vault review R-01)", async () => {
  await refused(sign({ amount: HELPER_BIND_DEPOSIT_CAP + 1n }), "call", /HELPER_BIND_DEPOSIT_CAP/);
  assert.ok((await sign({ amount: HELPER_BIND_DEPOSIT_CAP })).signed_delegate.length > 0); // the cap itself is signed
  await assert.rejects(sign({ amount: VAULT_CONSTANTS.MIN_DEPOSIT - 1n }), DepositAccountRefused); // the read's own floor
  for (const w of [DEPOSIT_WINDOW_MAX + 1, 10_000, 0, -1, 1.5, Number.NaN]) await refused(sign({ window: w }), "window");
  assert.equal((await sign({ window: 1 })).max_block_height, HEIGHT + 1n);
  for (const precommitment of [VAULT_FIELD_P, 0n]) await refused(sign({ precommitment }), "call", /precommitment: not in 1\.\.p-1/);
  assert.ok((await sign({ precommitment: 1n })).signed_delegate.length > 0); // 1 is the smallest P the vault takes
  await assert.rejects(depositDelegate(SEED, S, I, { ...ARGS, network: "devnet" as "testnet" }, replayDepositReads("testnet", PUB)), /unknown network devnet/);
});

test("the device refuses before signing: a read nonce + 1 at or above the read height x 1,000,000", async () => {
  const at = (n: number) => (kind: ReadKind, j: any) => {
    if (kind === "keys") j.result.keys[0].access_key.nonce = n;
  };
  const top = Number(HEIGHT) * 1_000_000;
  await refused(sign({}, { edit: at(top - 1) }), "nonce"); // nonce + 1 = height x 10^6
  assert.equal((await sign({}, { edit: at(top - 2) })).nonce, BigInt(top - 1));
});

test("the signed call fits /v1/bind's 4 KB, with the largest P and the cap", async () => {
  assert.ok(bytesOf((await sign({ precommitment: VAULT_FIELD_P - 1n, amount: HELPER_BIND_DEPOSIT_CAP })).signed_delegate).length <= BIND_MAX_BYTES);
});

// ---- The send ----

const HASH = base58.encode(new Uint8Array(32).fill(7));
type Call = { url: string; init: RequestInit };
const answer = (status: number, body: unknown, calls: Call[] = [], headers: Record<string, string> = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
const OUT = { signed_delegate: V.signed_delegate as string };

test("send: an answer with a leading byte-order mark is not a bind answer (the BOM is kept, never dropped)", async () => {
  await assert.rejects(sendDepositDelegate(OUT, answer(200, `\uFEFF${JSON.stringify({ tx_hash: HASH })}`)), /not JSON/);
});

test("send: only to the release's /v1/bind, the signed call alone, no cookies, no redirect", async () => {
  const calls: Call[] = [];
  assert.deepEqual(await sendDepositDelegate(OUT, answer(200, { tx_hash: HASH }, calls)), { ok: true, tx_hash: HASH });
  assert.equal(calls[0]!.url, RELEASE_BIND_URL);
  assert.equal(RELEASE_BIND_URL, "https://api.confidential.unrealized.trade/v1/bind");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.credentials, "omit");
  assert.equal(calls[0]!.init.referrerPolicy, "no-referrer");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { signed_delegate: OUT.signed_delegate });
  // Only the base64 field goes, whatever else the caller's object holds.
  await sendDepositDelegate({ ...OUT, secret: "x" } as typeof OUT, answer(200, { tx_hash: HASH }, calls));
  assert.deepEqual(Object.keys(JSON.parse(String(calls[1]!.init.body))), ["signed_delegate"]);
});

test("send: a 307 from the relayer is refused by the real fetch, never followed", async () => {
  let followed = 0;
  const server = createServer((req, res) => {
    if (req.url === "/v1/bind") {
      res.writeHead(307, { location: "/elsewhere" }).end();
      return;
    }
    followed++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tx_hash: HASH }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const viaLocal = ((_: unknown, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/v1/bind`, init)) as typeof fetch;
    await assert.rejects(sendDepositDelegate(OUT, viaLocal));
    assert.equal(followed, 0);
  } finally {
    server.close();
  }
});

test("send: the relayer's codes come back only with their own status", async () => {
  assert.deepEqual(await sendDepositDelegate(OUT, answer(409, { error: { code: "prepay_open" } })), { ok: false, code: "prepay_open" });
  assert.deepEqual(await sendDepositDelegate(OUT, answer(400, { error: { code: "amount_above_cap" } })), { ok: false, code: "amount_above_cap" });
  assert.deepEqual(await sendDepositDelegate(OUT, answer(403, { error: { code: "sender_struck" } })), { ok: false, code: "sender_struck" });
  for (const [status, code] of [[400, "prepay_open"], [302, "expired"], [500, "sender_struck"], [200, "prepay_open"]] as [number, string][])
    await assert.rejects(sendDepositDelegate(OUT, answer(status, { error: { code } })), /relayer/, `${status} ${code}`);
});

// The carry answers once the prepay and the delegate are read at final: a testnet deposit took 19.4 s from the signed
// call to the pages, and the device must still be waiting then.
test("send: a carry that answers at 19.5 s is heard, on the real fetch and a local helper", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tx_hash: HASH })), 19_500));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const viaLocal = ((_: unknown, init?: RequestInit) => fetch(`http://127.0.0.1:${port}/v1/bind`, init)) as typeof fetch;
    const t0 = performance.now();
    assert.deepEqual(await sendDepositDelegate(OUT, viaLocal), { ok: true, tx_hash: HASH });
    assert.ok(performance.now() - t0 >= 19_400, `answered after ${performance.now() - t0} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("send: the wait is the kit's HELPER_BIND_ANSWER_MS and the way back; past it there is no answer, and the caller reads the pages", async () => {
  await withSendClock(async (clock) => {
    // the helper answers within its bound: an answer at the bound itself is heard
    assert.deepEqual(await sendDepositDelegate(OUT, clock.late([HELPER_BIND_ANSWER_MS], answer(200, { tx_hash: HASH }))), { ok: true, tx_hash: HASH });
    assert.deepEqual(await sendDepositDelegate(OUT, clock.late([HELPER_BIND_ANSWER_MS], answer(409, { error: { code: "prepay_open" } }))), { ok: false, code: "prepay_open" });
    // the device's own wait is the bound and a few seconds for the request's way there and back, no more
    const waits = clock.timeouts.splice(0);
    assert.equal(new Set(waits).size, 1);
    assert.ok(waits[0]! > HELPER_BIND_ANSWER_MS && waits[0]! <= HELPER_BIND_ANSWER_MS + 10_000, `waits ${waits[0]} ms`);
    // an answer later than that is never taken: the send fails as a timeout, which bindDeposit reads as unsure
    await assert.rejects(sendDepositDelegate(OUT, clock.late([waits[0]! + 1], answer(200, { tx_hash: HASH }))), (e: unknown) => e instanceof DOMException && e.name === "TimeoutError");
  });
});

test("send: the caller's stop ends the wait at once, with the carry still out", async () => {
  await withSendClock(async () => {
    const stop = new AbortController();
    let asked = 0;
    // a helper that never answers: only an abort of the request's own signal ends it
    const silent = (async (_: unknown, init?: RequestInit) => {
      asked++;
      return new Promise<Response>((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)));
    }) as typeof fetch;
    const sent = sendDepositDelegate(OUT, silent, stop.signal);
    stop.abort();
    const ended = await Promise.race([sent.then(() => "answered", (e: unknown) => (e as Error).name), new Promise<string>((ok) => setTimeout(() => ok("still waiting"), 2_000))]);
    assert.equal(ended, "AbortError");
    assert.equal(asked, 1);
  });
});

test("send: the answer is hostile: capped at BIND_ANSWER_MAX_BYTES, and anything but a bind answer is refused", async () => {
  // Over the cap: a whole body, a declared length, a stream with no length.
  const pad = (n: number) => JSON.stringify({ tx_hash: HASH, pad: "x".repeat(n) });
  const fits = pad(0).length;
  await assert.rejects(sendDepositDelegate(OUT, answer(200, pad(BIND_ANSWER_MAX_BYTES - fits + 1))), /over 1024 B/);
  assert.equal(pad(BIND_ANSWER_MAX_BYTES - fits).length, BIND_ANSWER_MAX_BYTES);
  await assert.rejects(sendDepositDelegate(OUT, answer(200, { tx_hash: HASH }, [], { "content-length": "1000000" })), /over 1024 B/);
  let pulled = 0;
  const endless = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new TextEncoder().encode("[".repeat(512)));
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  await assert.rejects(sendDepositDelegate(OUT, endless), /over 1024 B/);
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
  // Not a bind answer.
  for (const [status, body] of [
    [500, { tx_hash: HASH }],
    [409, { tx_hash: HASH, error: { code: "prepay_open" } }],
    [200, { tx_hash: HASH, error: { code: "prepay_open" } }],
    [200, [HASH]],
    [200, { tx_hash: "not base58 0OIl" }],
    [200, { tx_hash: base58.encode(new Uint8Array(31)) }],
    [400, { error: { code: "__proto__" } }],
    [400, { error: { code: "toString" } }],
    [409, '{"error":{"__proto__":{"code":"prepay_open"}}}'],
    [200, `{"__proto__":{"tx_hash":"${HASH}"}}`],
    [400, { error: { code: "made_up" } }],
    [502, "<html>bad gateway</html>"],
    [200, null],
    [200, "\xff"],
  ] as [number, unknown][]) {
    await assert.rejects(sendDepositDelegate(OUT, answer(status, body)), /relayer/, JSON.stringify(body));
  }
});
