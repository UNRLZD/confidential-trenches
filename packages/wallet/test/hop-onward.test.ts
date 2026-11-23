// node --test packages/wallet/test/hop-onward.test.ts (card wallet-hop-onward): a hop's second leg, A_{l,j}'s one move of
// all its USDC to the 1Click deposit address of a confidential quote whose output goes to U_X, the pool's one-time wallet
// on chain X, with any refund back to A on NEAR (never into intents.near). The quotes are 1Click's own answers through
// our helper for the public test seed's A_{1,0} and U_X of (7, 0), 5 USDC to Solana and to Base, recorded 23 Nov 2026
// 11:45Z (packages/kit/test/fixtures/oneclick-hop.json; nobody pays those addresses). A fake chain answers both RPCs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { VAULT_TOKEN_CODE_HASH, type OneClickRequest } from "@blindfill/kit";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import { NEP366_PREFIX } from "../src/deposit/delegate.ts";
import type { MoveOutRpc } from "../src/deposit/moveout.ts";
import { hopQuoteRequest, POOL_DEPOSIT_MIN_OUT, type PoolDepositChain } from "../src/deposit/quote.ts";
import { armAccount, depositId, depositIdEvm, entropyToWords, wordsToSeed64 } from "../src/derive/keys.ts";
import * as onward from "../src/hop/onward.ts";
import { HopOnwardRefused, hopOnward, sendHopOnward, type HopOnwardArgs } from "../src/hop/onward.ts";

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const TOKEN = NEAR_NETWORKS.mainnet.usdc;
const FIX = JSON.parse(readFileSync(new URL("../../kit/test/fixtures/oneclick-hop.json", import.meta.url), "utf8"));
const A = armAccount(SEED, 1n, 0);
const A_ID = A.id;
const A_PUB = Uint8Array.from(A.publicKey);
A.secretKey.fill(0);
const RUNG = 5_000_000n;
const DECIMALS: Record<PoolDepositChain, number> = { solana: 9, base: 18, robinhood: 18 };
const uxOf = (chain: PoolDepositChain): string => {
  if (chain === "solana") {
    const k = depositId(SEED, 7n, 0);
    k.secretKey.fill(0);
    return base58.encode(k.publicKey);
  }
  const k = depositIdEvm(SEED, 7n, 0);
  k.secretKey.fill(0);
  return k.address;
};

// A's state on both RPCs at one block
class Chain {
  height = 180_000_000;
  nonce = 179_000_000_000_007n;
  usdc = RUNG;
  keys = 1;
  skewB: Partial<{ usdc: bigint; nonce: bigint }> = {};
  reads = 0;
  rpc(name: string, k: "a" | "b"): MoveOutRpc {
    const view = (v: unknown, h: number) => ({ result: { block_height: h, result: [...Buffer.from(JSON.stringify(v))] } });
    const sk = k === "b" ? this.skewB : {};
    return {
      name,
      block: async (p) => {
        this.reads++;
        const h = "block_id" in p ? (p.block_id as number) : this.height;
        return { result: { header: { height: h, hash: base58.encode(sha256(new TextEncoder().encode(`b${h}`))), timestamp_nanosec: "1" } } };
      },
      query: async (p) => {
        this.reads++;
        const h = (p.block_id as number | undefined) ?? this.height;
        if (p.request_type === "view_access_key_list") {
          const keys = [{ public_key: `ed25519:${base58.encode(A_PUB)}`, access_key: { nonce: Number(sk.nonce ?? this.nonce), permission: "FullAccess" } }];
          if (this.keys > 1) keys.push({ public_key: "ed25519:11111111111111111111111111111111", access_key: { nonce: 0, permission: "FullAccess" } });
          return { result: { block_height: h, keys } };
        }
        if (p.request_type === "view_account" && p.account_id === TOKEN) return { result: { block_height: h, amount: "1", locked: "0", storage_usage: 1, code_hash: VAULT_TOKEN_CODE_HASH } };
        if (p.request_type === "view_account") return { result: { block_height: h, amount: "1820000000000000000000", locked: "0", storage_usage: 182, code_hash: "11111111111111111111111111111111" } };
        if (p.method_name === "ft_balance_of") return view((sk.usdc ?? this.usdc).toString(), h);
        if (p.method_name === "storage_balance_of") return view(null, h);
        throw new Error(`unexpected ${String(p.method_name)}`);
      },
      tx: async () => {
        throw new Error("no tx read here");
      },
      call: async (method) => {
        if (method === "gas_price") return { result: { gas_price: "100000000" } };
        throw new Error(method);
      },
    };
  }
  rpcs(): readonly [MoveOutRpc, MoveOutRpc] {
    return [this.rpc(NEAR_NETWORKS.mainnet.fastnear[0], "a"), this.rpc(NEAR_NETWORKS.mainnet.drpc, "b")];
  }
}

function argsFor(chain: "solana" | "base", over: Partial<HopOnwardArgs> = {}, c = new Chain()): HopOnwardArgs {
  const r = FIX[chain];
  return {
    seed64: SEED,
    l: 1n,
    j: 0,
    chain,
    s: 7n,
    i: 0,
    request: r.request as OneClickRequest,
    answer: r.answer,
    check: { pricing: { in: [String(r.prices.in), String(r.prices.in)], out: [String(r.prices.out), String(r.prices.out)] }, decimalsIn: 6, decimalsOut: DECIMALS[chain], now: Date.parse(r.answer.timestamp) + 1_000 },
    floor: POOL_DEPOSIT_MIN_OUT[chain],
    hidden: async () => true,
    rpcs: c.rpcs(),
    ...over,
  };
}

// borsh(SignedDelegateAction) with one FunctionCall, read back by hand
function decode(b64: string) {
  const b = base64.decode(b64);
  let at = 0;
  const u32 = () => new DataView(b.buffer, b.byteOffset + (at += 4) - 4, 4).getUint32(0, true);
  const uint = (n: number) => {
    let x = 0n;
    for (let k = n - 1; k >= 0; k--) x = (x << 8n) | BigInt(b[at + k]!);
    at += n;
    return x;
  };
  const bytes = () => {
    const n = u32();
    return b.subarray((at += n) - n, at);
  };
  const str = () => new TextDecoder().decode(bytes());
  const sender = str(), receiver = str();
  const actions = u32(), tag = b[at++];
  const method = str(), args = str();
  const gas = uint(8), deposit = uint(16), nonce = uint(8), maxHeight = uint(8);
  const keyTag = b[at++];
  const key = b.subarray(at, (at += 32));
  const end = at;
  const sigTag = b[at++];
  const sig = b.subarray(at, (at += 64));
  return { sender, receiver, actions, tag, method, args, gas, deposit, nonce, maxHeight, keyTag, key, sigTag, sig, delegate: b.subarray(0, end), rest: b.length - at };
}

test("hopQuoteRequest: NEAR USDC to X's coin for U_X, A paying the deposit address and any refund back to A on NEAR, confidential", () => {
  for (const chain of ["solana", "base"] as const) {
    const q = hopQuoteRequest(chain, uxOf(chain), A_ID, RUNG, Date.parse(FIX[chain].request.deadline) - 30 * 60_000);
    assert.deepEqual(q, FIX[chain].request, "the recorded request is this builder's own");
    assert.equal(q.depositType, "ORIGIN_CHAIN");
    assert.equal(q.refundTo, A_ID);
    assert.equal(q.refundType, "ORIGIN_CHAIN");
    assert.equal(q.recipientType, "DESTINATION_CHAIN");
    assert.equal(q.confidentiality, "advanced");
  }
  const now = Date.parse("2026-11-23T11:45:00Z");
  assert.throws(() => hopQuoteRequest("near" as never, uxOf("solana"), A_ID, RUNG, now), /no pool/);
  assert.throws(() => hopQuoteRequest("solana", uxOf("base"), A_ID, RUNG, now), /Solana/);
  assert.throws(() => hopQuoteRequest("base", uxOf("base").toLowerCase(), A_ID, RUNG, now), /EIP-55/);
  assert.throws(() => hopQuoteRequest("solana", uxOf("solana"), "alice.near", RUNG, now), /64-hex/);
  assert.throws(() => hopQuoteRequest("solana", uxOf("solana"), A_ID, 0n, now), /amount/);
});

test("A signs one ft_transfer of all its USDC to the quote's signed deposit address, on the token only, 1 yocto, within the relayer's gas and window", async () => {
  for (const chain of ["solana", "base"] as const) {
    const c = new Chain();
    const s = await hopOnward(argsFor(chain, {}, c));
    const deposit = FIX[chain].answer.quote.depositAddress as string;
    assert.equal(s.deposit_address, deposit);
    assert.equal(s.amount, RUNG);
    const d = decode(s.signed_delegate);
    assert.equal(d.sender, A_ID);
    assert.equal(d.receiver, TOKEN, "the delegate's one receiver is the release's USDC");
    assert.equal(d.actions, 1);
    assert.equal(d.tag, 2, "a FunctionCall");
    assert.equal(d.method, "ft_transfer");
    assert.equal(d.args, JSON.stringify({ receiver_id: deposit, amount: RUNG.toString() }), "exactly {receiver_id, amount}: the signed address, all of A's USDC, no memo");
    assert.equal(d.deposit, 1n);
    assert.ok(d.gas > 0n && d.gas <= 100_000_000_000_000n, "within the relayer's ONWARD_GAS_CAP");
    assert.equal(d.nonce, c.nonce + 1n);
    assert.equal(d.maxHeight, BigInt(c.height) + 120n);
    assert.deepEqual([...d.key], [...A_PUB]);
    assert.equal(d.rest, 0);
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, NEP366_PREFIX, true);
    assert.ok(ed25519.verify(d.sig, sha256(new Uint8Array([...prefix, ...d.delegate])), A_PUB), "A's own key signs NEP-366's message");
    assert.equal(s.sender_id, A_ID);
    assert.equal(s.receiver_id, TOKEN);
  }
});

test("a request that is not the hop's own is refused before the quote is checked or A is read: INTENTS refund, another recipient, another refundTo, public rails", async () => {
  const r = FIX.solana.request as OneClickRequest;
  const bad: Partial<OneClickRequest>[] = [
    { refundType: "INTENTS" },
    { recipient: uxOf("solana").replace(/.$/, (x) => (x === "1" ? "2" : "1")) },
    { refundTo: "0".repeat(64) },
    { recipientType: "INTENTS" },
    { depositType: "INTENTS" },
  ];
  for (const b of bad) {
    const c = new Chain();
    await assert.rejects(hopOnward(argsFor("solana", { request: { ...r, ...b } }, c)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "request");
    assert.equal(c.reads, 0);
  }
  const { confidentiality: _c, ...open } = r;
  await assert.rejects(hopOnward(argsFor("solana", { request: open as OneClickRequest })), (e: unknown) => e instanceof HopOnwardRefused && e.code === "request");
  // U_X of another index than the one named
  await assert.rejects(hopOnward(argsFor("solana", { i: 1 })), (e: unknown) => e instanceof HopOnwardRefused && e.code === "request");
  // A of another note than the one named
  await assert.rejects(hopOnward(argsFor("solana", { j: 1 })), (e: unknown) => e instanceof HopOnwardRefused && e.code === "request");
});

test("an answer the kit's 1Click check refuses is refused: another deposit address under the same signature", async () => {
  const a = structuredClone(FIX.solana.answer);
  a.quote.depositAddress = "1".repeat(64);
  const c = new Chain();
  await assert.rejects(hopOnward(argsFor("solana", { answer: a }, c)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "quote");
  assert.equal(c.reads, 0);
});

test("a min out under the pool's floor is refused, and so is a floor under the pool ladder's least rung", async () => {
  const min = BigInt(FIX.solana.answer.quote.minAmountOut);
  await assert.rejects(hopOnward(argsFor("solana", { floor: min + 1n })), (e: unknown) => e instanceof HopOnwardRefused && e.code === "floor");
  await assert.rejects(hopOnward(argsFor("solana", { floor: POOL_DEPOSIT_MIN_OUT.solana - 1n })), (e: unknown) => e instanceof HopOnwardRefused && e.code === "floor");
  await hopOnward(argsFor("solana", { floor: min }));
});

test("an address 1Click itself knows as a public swap is refused before A is read", async () => {
  const c = new Chain();
  const seen: string[] = [];
  await assert.rejects(hopOnward(argsFor("solana", { hidden: async (x) => (seen.push(x), false) }, c)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "public");
  assert.deepEqual(seen, [FIX.solana.answer.quote.depositAddress]);
  assert.equal(c.reads, 0);
});

test("A with two keys, a pair that disagrees, or USDC other than the quote's amount signs nothing", async () => {
  const two = new Chain();
  two.keys = 2;
  await assert.rejects(hopOnward(argsFor("solana", {}, two)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "read");
  const skew = new Chain();
  skew.skewB = { usdc: RUNG - 1n };
  await assert.rejects(hopOnward(argsFor("solana", {}, skew)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "read");
  for (const usdc of [RUNG - 1n, RUNG + 1n]) {
    const c = new Chain();
    c.usdc = usdc;
    await assert.rejects(hopOnward(argsFor("solana", {}, c)), (e: unknown) => e instanceof HopOnwardRefused && e.code === "amount");
  }
});

test("no hand-made read is signed: the module exports no signer but hopOnward, which reads A first", () => {
  assert.deepEqual(Object.keys(onward).sort(), ["HopOnwardRefused", "hopOnward", "sendHopOnward"]);
});

test("sendHopOnward: the signed bytes alone to the release's relayer; a tx hash, an onward code at its status, or a throw", async () => {
  const s = await hopOnward(argsFor("solana"));
  const hash = base58.encode(new Uint8Array(32).fill(7));
  const asked: { url: string; body: string }[] = [];
  const answer = (status: number, body: unknown): typeof fetch => async (url, init) => {
    asked.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await sendHopOnward(s, answer(200, { tx_hash: hash })), { ok: true, tx_hash: hash });
  assert.deepEqual(asked[0], { url: "https://ct-api.unrealized.trade/v1/bind", body: JSON.stringify({ signed_delegate: s.signed_delegate }) });
  assert.deepEqual(await sendHopOnward(s, answer(409, { error: { code: "not_paid" } })), { ok: false, code: "not_paid" });
  assert.deepEqual(await sendHopOnward(s, answer(403, { error: { code: "id_not_ours" } })), { ok: false, code: "id_not_ours" });
  // a deposit's code is no onward answer
  await assert.rejects(sendHopOnward(s, answer(409, { error: { code: "p_used" } })), /not a bind answer/);
});
