// node --test apps/helper/src/pool/evm-release.test.ts (card helper-evm-sender-2): the helper sends a pool withdraw or
// buy only when W signed exactly those bytes (M354, M357): the calldata read in its one canonical encoding, a buy's
// included, and W's EIP-712 signature recovered to the request's recipient under the pool's domain on the network's
// pinned chain id (M356 (6)), before any RPC call. The digests are held to cast's EIP-712 of the pool's own type strings
// (fixtures/release-cast.json, test/pool-evm/make-release-cast.mjs) and to every withdraw and buy that landed on both
// testnets (fixtures/release-landed.json, test/pool-evm/record-release-landed.mjs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_TX_BYTES, evmPoolRouteData, evmPoolVenues } from "@blindfill/kit";
import { signRelease, W } from "../../test/pool-evm/release-sign.ts";
import { BOUGHT_TOPIC, BUY_SELECTOR, BUY_SIGNATURE, EVM_BODY_DATA_MAX, evmAddressOf, evmPoolSender, evmReadBuy, evmReadRelease, evmReleaseDigest, evmReleaseSigner, rlp, type EvmRpc } from "./evm.ts";

const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const CAST = JSON.parse(readFileSync(new URL("./fixtures/release-cast.json", import.meta.url), "utf8")) as {
  w: string; withdrawType: string; buyType: string;
  cases: Record<string, { method: string; chainId: number; pool: string; nullifier: string; context: string; value: string; adapter?: string; data?: string; minOut?: string; coin?: string; digest: string; signature: string; callData: string; other: Record<string, string> }>;
};
const LANDED = JSON.parse(readFileSync(new URL("./fixtures/release-landed.json", import.meta.url), "utf8")) as { txs: { network: string; kind: string; hash: string; pool: string; w: string; input: string }[] };
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const N = secp256k1.Point.CURVE().n;
const bytes = (h: string) => new Uint8Array(Buffer.from(h.slice(2), "hex"));
const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
/** `data` with its 65 signature bytes replaced by `sig` (0x hex, 65 bytes), the rest of the last word zero. */
const withSig = (data: string, sig: string) => `${data.slice(0, -192)}${sig.slice(2).padEnd(192, "0")}`;
/** `data` with word `i` after the selector replaced by `w` (64 hex). */
const setWord = (data: string, i: number, w: string) => `${data.slice(0, 10 + 64 * i)}${w}${data.slice(10 + 64 * (i + 1))}`;
const w32 = (n: bigint) => n.toString(16).padStart(64, "0");

// ---- a chain as evm.test.ts's: block n at 1,999,999,000 + 2n s, 1 gwei, the pool's depth 2, Base Sepolia's L1 fee ----
const T0 = 1_999_999_000n;
const NOW = 2_000_000_000_000 - 100_000;
const EPOCH = 1_999_999_860_000;
const DEPTH_DATA = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;
type Calls = { method: string; params: readonly unknown[] }[];
function rpc(calls: Calls, chain = "0x14a34", receipt: unknown = { status: "0x1" }): EvmRpc {
  const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + 2n * n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: "0x3b9aca00" });
  return async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return chain;
      case "eth_getCode": return "0x";
      case "eth_call": {
        const [{ to, data }, at] = params as [{ to: string; data: string }, unknown];
        if (typeof at === "object" && at !== null && "blockHash" in at) return `0x${(to === "0x420000000000000000000000000000000000000f" ? (data.startsWith("0xf1c7a58b") ? 7_917n : 0n) : data === DEPTH_DATA ? 2n : 0n).toString(16).padStart(64, "0")}`;
        return "0x";
      }
      case "eth_estimateGas": return "0x95433"; // 611,391
      case "eth_getBlockByNumber": return params[0] === "latest" ? block(600n) : BigInt(params[0] as string) <= 600n ? block(BigInt(params[0] as string)) : null;
      case "eth_maxPriorityFeePerGas": return "0x5f5e100";
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": return "0x";
      case "eth_getTransactionReceipt": return receipt;
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
const senderOf = (calls: Calls, network = "base-sepolia", chain = "0x14a34", venues?: Parameters<typeof evmPoolSender>[0]["venues"], receipts?: [unknown, unknown]) =>
  evmPoolSender({ network, pool: POOL, senderKey: KEY, feeRecipient: FEE_TO, receiptPollMs: 1, ...(venues ? { venues } : {}) }, [rpc(calls, chain, receipts?.[0]), rpc([], chain, receipts?.[1])], () => NOW);
const code = (a: { body: unknown }) => ((a.body as { error?: { code: string } }).error?.code ?? "ok");
const sends = (calls: Calls) => calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0] as string);

test("the helper's release digest is the pool's: cast's EIP-712 of the pool's Withdraw and Buy types, and W recovers from cast's signature", () => {
  assert.equal(CAST.withdrawType, "Withdraw(uint256 nullifier,uint256 context,uint256 value)");
  assert.equal(CAST.buyType, "Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)");
  assert.equal(BUY_SELECTOR, Buffer.from(keccak_256(new TextEncoder().encode(BUY_SIGNATURE))).subarray(0, 4).toString("hex"));
  assert.equal(BUY_SELECTOR, "3edadd79");
  for (const [name, c] of Object.entries(CAST.cases)) {
    const r = evmReadRelease(bytes(c.callData));
    assert.equal(r.method, c.method === "Buy" ? "buy" : "withdraw", name);
    assert.deepEqual([BigInt(`0x${r.nullifier}`), r.context, r.value], [BigInt(c.nullifier), BigInt(c.context), BigInt(c.value)], `${name}: the proof's nullifier, context and value`);
    if (c.method === "Buy") assert.deepEqual({ ...r.buy, data: hexOf(r.buy!.data) }, { adapter: c.adapter, data: c.data, minOut: BigInt(c.minOut!), token: c.coin }, `${name}: the Buy`);
    assert.equal(r.recipient, CAST.w, `${name}: W is the recipient`);
    assert.equal(hexOf(evmReleaseDigest(BigInt(c.chainId), c.pool, r)), c.digest, `${name}: the digest`);
    assert.equal(hexOf(r.signature), c.signature, `${name}: the signature read`);
    assert.equal(evmReleaseSigner(BigInt(c.chainId), c.pool, r), CAST.w, `${name}: W recovered`);
  }
});

test("every withdraw and buy that landed on Base Sepolia and Robinhood testnet recovers to the W its run named, under the kit's pinned chain id and pool", () => {
  assert.deepEqual(LANDED.txs.map((t) => t.kind).sort(), ["buy", "buy", "buy", "withdraw", "withdraw", "withdraw", "withdraw", "withdraw"]);
  for (const t of LANDED.txs) {
    const v = evmPoolVenues()[t.network as "base-sepolia"];
    assert.equal(t.pool, v.pool, `${t.hash}: the kit's pinned pool`);
    const r = evmReadRelease(bytes(t.input));
    assert.equal(r.method, t.kind, t.hash);
    assert.equal(r.processooor, t.pool, t.hash);
    assert.equal(r.recipient, t.w, `${t.hash}: the run's W is the recipient`);
    assert.equal(evmReleaseSigner(BigInt(v.chainId), t.pool, r), t.w, `${t.hash}: W's signature recovers to W`);
    assert.notEqual(evmReleaseSigner(BigInt(v.chainId) + 1n, t.pool, r), t.w, `${t.hash}: not on another chain`);
  }
});

test("a good withdraw and a good buy W signed go out exactly as received; W's signature for another value, nullifier, context, chain, pool, method, adapter, data, minOut or token: each bad_signature, before any RPC call", async () => {
  for (const name of ["withdrawBaseSepolia", "buyBaseSepolia"]) {
    const c = CAST.cases[name]!;
    const calls: Calls = [];
    const a = await senderOf(calls).carry({ pool: POOL, data: c.callData, epoch: EPOCH });
    assert.equal(a.status, 200, `${name}: ${JSON.stringify(a.body)}`);
    assert.equal(sends(calls).length, 1, name);
    assert.ok(sends(calls)[0]!.includes(c.callData.slice(2)), `${name}: the calldata sent is the calldata received`);
    const planted = Object.keys(c.other).sort();
    assert.deepEqual(planted, c.method === "Buy" ? ["adapter", "chain", "coin", "context", "data", "method", "minOut", "nullifier", "pool", "value"] : ["chain", "context", "method", "nullifier", "pool", "value"], name);
    for (const field of planted) {
      const x: Calls = [];
      const r = await senderOf(x).carry({ pool: POOL, data: withSig(c.callData, c.other[field]!), epoch: EPOCH });
      assert.deepEqual([r.status, code(r)], [422, "bad_signature"], `${name}: W's signature for another ${field}`);
      assert.equal(x.length, 0, `${name}, another ${field}: no RPC call`);
    }
  }
  // Robinhood testnet: the sender checks under its own pinned chain id, 46630; Base Sepolia's signature is refused there
  const r = CAST.cases.withdrawRobinhoodTestnet!;
  const x: Calls = [];
  assert.notEqual(code(await senderOf(x, "robinhood-testnet", "0xb626").carry({ pool: POOL, data: r.callData, epoch: EPOCH })), "bad_signature", "W's Robinhood testnet signature passes there");
  assert.equal(code(await senderOf([], "robinhood-testnet", "0xb626").carry({ pool: POOL, data: CAST.cases.withdrawBaseSepolia!.callData, epoch: EPOCH })), "bad_signature", "Base Sepolia's signature on Robinhood testnet");
  for (const field of Object.keys(r.other)) assert.equal(code(await senderOf([], "robinhood-testnet", "0xb626").carry({ pool: POOL, data: withSig(r.callData, r.other[field]!), epoch: EPOCH })), "bad_signature", `Robinhood testnet, another ${field}`);
  // a release signed by any key but the recipient's
  const other = new Uint8Array(createHash("sha256").update("helper-evm-sender-2/test-key/not-W").digest());
  const c = CAST.cases.withdrawBaseSepolia!;
  const rec = secp256k1.sign(evmReleaseDigest(84_532n, POOL, evmReadRelease(bytes(c.callData))), other, { prehash: false, lowS: true, format: "recovered" });
  assert.equal(code(await senderOf([]).carry({ pool: POOL, data: withSig(c.callData, hexOf(Uint8Array.from([...rec.subarray(1), 27 + rec[0]!]))), epoch: EPOCH })), "bad_signature", "another key");
});

test("W's signature only in its one form: v 27 or 28, r and s in range, s low (the high twin of W's own signature too): else bad_signature, before any RPC call", async () => {
  const c = CAST.cases.withdrawBaseSepolia!;
  const sig = c.signature.slice(2);
  const r = BigInt(`0x${sig.slice(0, 64)}`), s = BigInt(`0x${sig.slice(64, 128)}`), v = Number.parseInt(sig.slice(128), 16);
  const form = (rr: bigint, ss: bigint, vv: number) => `0x${w32(rr)}${w32(ss)}${vv.toString(16).padStart(2, "0")}`;
  // the twin (r, n - s, the other v) is W's signature to ecrecover; the pool refuses it (s > HALF_N), so the helper does
  const twin = form(r, N - s, v === 27 ? 28 : 27);
  const twinSig = secp256k1.Signature.fromBytes(bytes(twin).subarray(0, 64), "compact").addRecoveryBit(v === 27 ? 1 : 0);
  const pub = twinSig.recoverPublicKey(bytes(c.digest)).toBytes(false);
  assert.equal(`0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString("hex")}`, CAST.w, "the high twin recovers to W");
  const cases: [string, string][] = [
    ["the high twin", twin], ["v 26", form(r, s, 26)], ["v 29", form(r, s, 29)], ["v 0", form(r, s, v - 27)], ["v 1", form(r, s, v - 26)],
    ["r 0", form(0n, s, v)], ["r n", form(N, s, v)], ["s 0", form(r, 0n, v)], ["the other v", form(r, s, v === 27 ? 28 : 27)],
  ];
  for (const [what, bad] of cases) {
    const x: Calls = [];
    const a = await senderOf(x).carry({ pool: POOL, data: withSig(c.callData, bad), epoch: EPOCH });
    assert.deepEqual([a.status, code(a)], [422, "bad_signature"], what);
    assert.equal(x.length, 0, `${what}: no RPC call`);
  }
});

test("buy's calldata is read in its one canonical encoding: every offset, length and padding as solc writes them, a 65-byte signature, nothing after; else bad_shape before any RPC call", async () => {
  const good = CAST.cases.buyBaseSepolia!.callData; // the Buy's tail at word 29, its data (320 bytes: abi.encode of a one-hop v4 route) at word 34, the signature's length at word 44
  assert.doesNotThrow(() => evmReadBuy(bytes(good)));
  const bad: [string, string, RegExp][] = [
    ["a word after", `${good}${"00".repeat(32)}`, /the buy's length/],
    ["a word short", good.slice(0, -64), /the buy's length|signature's layout/],
    ["a byte after", `${good}00`, /not buy's calldata/],
    ["the Withdrawal's offset", setWord(good, 0, w32(19n * 32n)), /withdrawal's offset/],
    ["the Buy's offset", setWord(good, 18, w32(30n * 32n)), /the buy's offset/],
    ["the signature's offset", setWord(good, 19, w32(45n * 32n)), /signature's offset/],
    ["the buy data's offset", setWord(good, 30, w32(5n * 32n)), /buy data's offset/],
    ["the buy data's length, a word more", setWord(good, 33, w32(352n)), /the buy's length/],
    ["the buy data's length, a byte more", setWord(good, 33, w32(321n)), /the buy's length/],
    ["the buy data's length past the calldata", setWord(good, 33, w32(1n << 64n)), /buy data's length/],
    ["the adapter's padding", setWord(good, 29, `01${good.slice(10 + 64 * 29 + 2, 10 + 64 * 30)}`), /address's padding/],
    ["the token's padding", setWord(good, 32, `01${good.slice(10 + 64 * 32 + 2, 10 + 64 * 33)}`), /address's padding/],
    ["the buy data's padding: a byte less, the byte past it not zero", setWord(setWord(good, 33, w32(319n)), 43, w32(1n)), /buy data's padding/],
    ["a 64-byte signature", setWord(good, 44, w32(64n)), /signature's layout/],
    ["a 66-byte signature", setWord(good, 44, w32(66n)), /signature's layout/],
    ["the signature's padding", `${good.slice(0, -2)}01`, /signature's layout/],
    ["the relay data's length", setWord(good, 22, w32(224n)), /withdrawal's layout/],
    ["the selector", `0x94374b2b${good.slice(10)}`, /not withdraw's calldata/],
  ];
  for (const [what, data, why] of bad) {
    assert.throws(() => evmReadRelease(bytes(data)), why, what);
    const x: Calls = [];
    const a = await senderOf(x).carry({ pool: POOL, data, epoch: EPOCH });
    assert.deepEqual([a.status, code(a)], [400, "bad_shape"], what);
    assert.equal(x.length, 0, `${what}: no RPC call`);
  }
});

test("a release's calldata is at most EVM_BODY_DATA_MAX, the most whose signed transaction at every field's longest fits the kit's EVM_POOL_TX_BYTES; a longer buy is bad_shape", async () => {
  const max = (1n << 256n) - 1n;
  const big = (n: bigint) => new Uint8Array(Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0"), "hex"));
  const signedLength = (dataLen: number) => 1 + rlp([big((1n << 64n) - 1n), big((1n << 64n) - 1n), big(max), big(max), big((1n << 64n) - 1n), new Uint8Array(20), new Uint8Array(), new Uint8Array(dataLen), [], big(1n), big(max), big(max)]).length;
  assert.equal(EVM_BODY_DATA_MAX, 2_404);
  assert.ok(signedLength(EVM_BODY_DATA_MAX) <= Number(EVM_POOL_TX_BYTES), `${signedLength(EVM_BODY_DATA_MAX)} bytes`);
  assert.ok(signedLength(EVM_BODY_DATA_MAX + 32) > Number(EVM_POOL_TX_BYTES), "a word more does not fit");
  // a buy whose data makes its calldata a word over the bound, else canonical
  const good = CAST.cases.buyBaseSepolia!.callData;
  const extra = (EVM_BODY_DATA_MAX + 32 - (good.length - 2) / 2) / 32 + 0; // words of data to add
  const dataWords = 10 + Math.ceil(extra);
  const len = BigInt(32 * dataWords);
  const long = `${setWord(setWord(good.slice(0, 10 + 64 * 34), 19, w32(BigInt(32 * (34 + dataWords)))), 33, w32(len))}${"ab".repeat(32 * dataWords)}${good.slice(10 + 64 * 44)}`;
  assert.ok((long.length - 2) / 2 > EVM_BODY_DATA_MAX, `${(long.length - 2) / 2} bytes`);
  assert.throws(() => evmReadBuy(bytes(long)), /not buy's calldata/);
  assert.equal(code(await senderOf([]).carry({ pool: POOL, data: long, epoch: EPOCH })), "bad_shape");
});

test("the chain id is the kit's pin: providers naming another chain are upstream and nothing is sent; a network the kit does not list refuses every release", async () => {
  const c = CAST.cases.withdrawBaseSepolia!;
  const calls: Calls = [];
  const a = await senderOf(calls, "base-sepolia", "0x7a69").carry({ pool: POOL, data: c.callData, epoch: EPOCH });
  assert.deepEqual([a.status, code(a)], [503, "upstream"], JSON.stringify(a.body));
  assert.equal(sends(calls).length, 0);
  const x: Calls = [];
  const b = await senderOf(x, "base-sepolia", "0x14a34", {}).carry({ pool: POOL, data: c.callData, epoch: EPOCH });
  assert.deepEqual([b.status, code(b)], [503, "not_configured"], JSON.stringify(b.body));
  assert.equal(x.length, 0);
});

// ---- review a2ff5521 L1: every relay word and the processooor in their one encoding, a dirty high or low bit refused ----
test("a dirty processooor, recipient or feeRecipient high bit, deadlineMs over 64 bits or salt's low 16 bytes: bad_shape before any RPC call, withdraw and buy alike", async () => {
  // the Withdrawal's tail: processooor at the head's end (withdraw 19, buy 20), then 64, 192 and the six relay words
  for (const [name, head] of [["withdrawBaseSepolia", 19], ["buyBaseSepolia", 20]] as const) {
    const good = CAST.cases[name]!.callData;
    const at = (i: number) => BigInt(`0x${good.slice(10 + 64 * i, 10 + 64 * (i + 1))}`);
    const rows: [string, number, bigint, RegExp][] = [
      ["the processooor's high bits", head, 1n << 160n, /withdrawal's layout/],
      ["the processooor's top bit", head, 1n << 255n, /withdrawal's layout/],
      ["the recipient's high bits", head + 3, 1n << 160n, /relay data's padding/],
      ["the feeRecipient's high bits", head + 4, 1n << 200n, /relay data's padding/],
      ["deadlineMs over 64 bits", head + 6, 1n << 64n, /relay data's padding/],
      ["deadlineMs's top bit", head + 6, 1n << 255n, /relay data's padding/],
      ["salt's lowest bit", head + 8, 1n, /relay data's padding/],
      ["salt's low 16 bytes' top bit", head + 8, 1n << 127n, /relay data's padding/],
    ];
    for (const [what, i, bit, why] of rows) {
      const data = setWord(good, i, w32(at(i) | bit));
      assert.throws(() => evmReadRelease(bytes(data)), why, `${name}: ${what}`);
      const x: Calls = [];
      const a = await senderOf(x).carry({ pool: POOL, data, epoch: EPOCH });
      assert.deepEqual([a.status, code(a)], [400, "bad_shape"], `${name}: ${what}`);
      assert.equal(x.length, 0, `${name}: ${what}: no RPC call`);
    }
  }
});

// ---- review a2ff5521 H1: a buy runs only a pinned adapter's builder route, and its gas is held until it lands ----
/** The cast buy's calldata with recipient W (the test key's), its Buy's adapter and data replaced, the nullifier plus
 *  `n`, signed by W: every check but the one a test plants passes. */
function buyAs(o: { adapter?: string; data?: string; n?: bigint; key?: Uint8Array<ArrayBuffer>; coin?: string } = {}): string {
  const good = CAST.cases.buyBaseSepolia!.callData;
  const word = (i: number) => (i === 32 && o.coin !== undefined ? o.coin.slice(2).padStart(64, "0") : good.slice(10 + 64 * i, 10 + 64 * (i + 1)));
  // another coin: the builder's one-hop v4 route to it
  const coinData = o.coin === undefined ? undefined : hexOf(evmPoolRouteData("base-sepolia", { venue: "uniswap-v4", currencyIn: "0x0000000000000000000000000000000000000000", hops: [{ currency: o.coin, fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000", hookData: "0x" }] }).data);
  const d = (o.data ?? coinData ?? CAST.cases.buyBaseSepolia!.data!).slice(2);
  const words = Math.ceil(d.length / 64);
  const tail = `${w32(BigInt(o.adapter ?? CAST.cases.buyBaseSepolia!.adapter!))}${w32(128n)}${word(31)}${word(32)}${w32(BigInt(d.length / 2))}${d.padEnd(64 * words, "0")}${good.slice(-64 * 4)}`;
  let data = `${good.slice(0, 10 + 64 * 29)}${tail}`;
  data = setWord(data, 19, w32(BigInt(32 * (34 + words))));
  data = setWord(data, 23, (o.key === undefined ? W : evmAddressOf(o.key)).slice(2).padStart(64, "0"));
  data = setWord(data, 10, w32(BigInt(`0x${word(10)}`) + (o.n ?? 0n)));
  return o.key === undefined ? signRelease(data, POOL) : signRelease(data, POOL, 84_532n, o.key);
}
/** A receipt of `data`'s buy: `status`, its gas at 2.1 gwei, and the pool's Bought log of it when `bought`. */
function receiptOf(data: string, status: "0x1" | "0x0", bought: boolean, gasUsed = "0x95433") {
  const r = evmReadRelease(bytes(data));
  const pad = (a: string) => a.slice(2).padStart(64, "0");
  const log = { address: POOL, topics: [BOUGHT_TOPIC, `0x${pad(r.recipient)}`], data: `0x${pad(r.feeRecipient)}${w32(r.value)}${w32(r.fee)}${r.nullifier}${w32(7n)}${pad(r.buy!.token)}${w32(2_360_180n)}` };
  return { status, gasUsed, effectiveGasPrice: "0x7d2b7500", logs: bought ? [log] : [] };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("a buy through any adapter but the kit's pinned two, or data not the kit's builder's bytes for its route: bad_route, signed by W, with no RPC call", async () => {
  const BS = evmPoolVenues()["base-sepolia"];
  const good = buyAs();
  assert.equal(code(await senderOf([]).carry({ pool: POOL, data: good, epoch: EPOCH })), "ok", "the builder's route through the pinned v4 adapter");
  const cases: [string, string][] = [
    ["a foreign adapter", buyAs({ adapter: "0x5b6ee2e1c3ec4c6e5bb1d1b4b0f4b8b9d8c2a1f0" })],
    ["the pool as the adapter", buyAs({ adapter: POOL })],
    ["Robinhood testnet's pinned adapter", buyAs({ adapter: evmPoolVenues()["robinhood-testnet"].adapters!.v4! })],
    ["the v3 adapter with v4 data", buyAs({ adapter: BS.adapters!.v3! })],
    ["the data with a word after it", buyAs({ data: `${CAST.cases.buyBaseSepolia!.data!}${"00".repeat(32)}` })],
    ["the data a byte short", buyAs({ data: CAST.cases.buyBaseSepolia!.data!.slice(0, -2) })],
    ["the path's offset moved", buyAs({ data: `0x${CAST.cases.buyBaseSepolia!.data!.slice(2, 66)}${w32(0x60n)}${"00".repeat(32)}${CAST.cases.buyBaseSepolia!.data!.slice(130)}` })],
    ["hook data the device never makes", buyAs({ data: `${CAST.cases.buyBaseSepolia!.data!.slice(0, -128)}${w32(1n)}${"ab".padEnd(64, "0")}` })],
    ["junk", buyAs({ data: `0x${"ab".repeat(70)}` })],
  ];
  for (const [what, data] of cases) {
    const x: Calls = [];
    const a = await senderOf(x).carry({ pool: POOL, data, epoch: EPOCH });
    assert.deepEqual([a.status, code(a)], [422, "bad_route"], `${what}: ${JSON.stringify(a.body)}`);
    assert.equal(x.length, 0, `${what}: no RPC call`);
  }
});

test("a buy's worst gas is held against W, the client and the token until it lands: one that reverts on chain is charged and the next over the cap is 429 with Retry-After; one with the pool's Bought log on both providers clears its hold", async () => {
  // reverted on chain (its minOut not met after the sim passed): its whole cost, 611,391 gas at 2.1 gwei, over W's cap
  const first = buyAs();
  const rc: Calls = [];
  const reverted = senderOf(rc, "base-sepolia", "0x14a34", undefined, [receiptOf(first, "0x0", false), receiptOf(first, "0x0", false)]);
  assert.equal(code(await reverted.carry({ pool: POOL, data: first, epoch: EPOCH }, "203.0.113.7")), "ok");
  await settle();
  const before = rc.length;
  const next = await reverted.carry({ pool: POOL, data: buyAs({ n: 1n }), epoch: EPOCH }, "203.0.113.7");
  assert.deepEqual([next.status, code(next)], [429, "rate_limited"], JSON.stringify(next.body));
  assert.match(JSON.stringify(next.body), /unpaid buy gas \d+ wei for W, cap 1000000000000000/);
  assert.ok(next.retryAfterS !== undefined && next.retryAfterS > 0 && next.retryAfterS <= 3600, `Retry-After ${next.retryAfterS}`);
  assert.equal(rc.length, before, "no RPC call");
  // another W from another client, the same token: held by the token's cap; another W and token from the same client:
  // held by the client's
  const W2 = new Uint8Array(createHash("sha256").update("helper-evm-sender-2/test-key/W2").digest());
  assert.match(JSON.stringify((await reverted.carry({ pool: POOL, data: buyAs({ n: 2n, key: W2 }), epoch: EPOCH }, "198.51.100.9")).body), /unpaid buy gas \d+ wei for this token/);
  assert.match(JSON.stringify((await reverted.carry({ pool: POOL, data: buyAs({ n: 3n, key: W2, coin: "0x0000000000000000000000000000000000007070" }), epoch: EPOCH }, "203.0.113.7")).body), /unpaid buy gas \d+ wei for this client/);
  assert.equal(code(await reverted.carry({ pool: POOL, data: buyAs({ n: 4n, key: W2, coin: "0x0000000000000000000000000000000000007070" }), epoch: EPOCH }, "198.51.100.9")), "ok", "another W, token and client: only the budget holds it");
  // a withdraw is never held by the buys' caps, and the reverted buy's proof still withdraws in its epoch (review a2ff5521
  // L2: the reverted set is keyed by method); the reverted buy itself is never sent again in its epoch
  assert.equal(code(await reverted.carry({ pool: POOL, data: CAST.cases.withdrawBaseSepolia!.callData, epoch: EPOCH }, "203.0.113.7")), "ok", "the same proof's withdraw, from the same client");
  assert.equal(code(await reverted.carry({ pool: POOL, data: first, epoch: EPOCH }, "198.51.100.200")), "reverted", "the reverted buy again");
  // a cheap revert held, then a buy whose worst would pass W's cap: refused at the worst's check, after the reads
  const cheap = senderOf([], "base-sepolia", "0x14a34", undefined, [receiptOf(first, "0x0", false, "0x5208"), receiptOf(first, "0x0", false, "0x5208")]);
  assert.equal(code(await cheap.carry({ pool: POOL, data: first, epoch: EPOCH })), "ok");
  await settle();
  const worst = await cheap.carry({ pool: POOL, data: buyAs({ n: 1n }), epoch: EPOCH });
  assert.match(JSON.stringify(worst.body), /unpaid buy gas 39500909133000 wei for W/, "21,000 gas at its maxFeePerGas (fee / gas) held: 1 wei more passes, the next buy's worst does not");
  // proven only by status 1 and the pool's Bought log of this buy on both providers; anything less stays charged
  for (const [what, ra, rb, held] of [
    ["status 1 and Bought on both", receiptOf(first, "0x1", true), receiptOf(first, "0x1", true), false],
    ["status 1, Bought on one provider only", receiptOf(first, "0x1", true), receiptOf(first, "0x1", false), true],
    ["status 1 and no Bought log", receiptOf(first, "0x1", false), receiptOf(first, "0x1", false), true],
    ["a Bought log for another nullifier", receiptOf(first, "0x1", true), receiptOf(buyAs({ n: 9n }), "0x1", true), true],
  ] as const) {
    const s = senderOf([], "base-sepolia", "0x14a34", undefined, [ra, rb]);
    assert.equal(code(await s.carry({ pool: POOL, data: first, epoch: EPOCH })), "ok", what);
    await settle();
    const a = await s.carry({ pool: POOL, data: buyAs({ n: 1n }), epoch: EPOCH });
    assert.equal(code(a), held ? "rate_limited" : "ok", `${what}: ${JSON.stringify(a.body)}`);
  }
});
