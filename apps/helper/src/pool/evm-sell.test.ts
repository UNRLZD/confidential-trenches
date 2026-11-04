// node --test apps/helper/src/pool/evm-sell.test.ts: the EVM pool sender carries W's sell (POST /v1/pool/evm/sell) as
// one EIP-7702 type-4 transaction to W, with W's one authorization of the kit's pinned SellDelegate and exactly the
// calldata received, or refuses it. The reference is the device's sell that landed on both testnets
// (contracts/pool-evm/script/testnet-run.mjs sellOf, testnet-run-lib.mjs signTx7702 and authJson). The chain is
// base-sepolia with the kit's own pins (evmPoolVenues()); the keys are test keys, each sha256 of a label.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
import { EVM_7702_AUTH_GAS, EVM_POOL_SELL_GAS, evmPoolChainFee, evmPoolSellTip, evmPoolSignSellAuthorization, evmPoolVenues } from "@blindfill/kit";
import { EVM_SELL_UNPAID_BUDGET_WEI, EVM_SELL_UNPAID_CAP_WEI, EVM_SELL_UNPAID_WINDOW_MS, WITHDRAW_SELECTOR, evmAddressOf, evmTx4MaxLength, evmEpochFee, evmPoolSender, evmReadSell, evmSellDigest, type EvmRpc } from "./evm.ts";
import * as evmModule from "./evm.ts";

// read by name, so a build without the ceiling fails only the tests that use it
const EVM_SELL_MAX_FEE_PER_GAS = (evmModule as Record<string, unknown>).EVM_SELL_MAX_FEE_PER_GAS as bigint;
const key = (label: string) => new Uint8Array(createHash("sha256").update(`helper-evm-sender/test-key/${label}`).digest());
const KEY = key("EVM_SENDER");
/** The sell sender's own key, apart from the withdraw sender's (card helper-evm-sender: sells never use KEY). */
const SELL_KEY = key("EVM_SELL_SENDER");
const W_KEY = key("W");
const OTHER_KEY = key("OTHER");
const W = evmAddressOf(W_KEY);
const SENDER = evmAddressOf(SELL_KEY);
const V = evmPoolVenues()["base-sepolia"];
const CHAIN_ID = BigInt(V.chainId); // 84532
const DELEGATE = V.sellDelegate!;
const POOL = V.pool!;
const ORACLE = "0x420000000000000000000000000000000000000f";
/** Arbitrum's ArbGasInfo precompile (Robinhood Chain), getL1BaseFeeEstimate() (the kit's pool-fee.ts reads it) */
const ARB_GAS_INFO = "0x000000000000000000000000000000000000006c";
const NATIVE = "0x0000000000000000000000000000000000000000";
const N = secp256k1.Point.CURVE().n;

const NOW = 1_800_000_000_000;
const NOW_S = BigInt(NOW / 1000);
const BASE = 10_000_000n; // 0.01 gwei
const TIP = evmPoolSellTip("base-sepolia");
const L1 = 5_000_000_000_000n;
const W_NONCE = 3n;
const NEED = EVM_POOL_SELL_GAS * (BASE + TIP) + L1;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));
const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const SELL_SELECTOR = hex(keccak_256(utf8("sell((address,uint256,address,bytes,uint256,address,uint256,uint256,uint256,uint256),uint256,bytes)")).subarray(0, 4));
const selector = (sig: string) => hex(keccak_256(utf8(sig)).subarray(0, 4));
/** SellDelegate's v4 data as the kit's sell builder writes it: abi.encode(PathKey[]), one hop to `to`, no hook, no hook
 *  data (`hooks` and `fee` to plant another). */
const v4Path = (to = NATIVE, hooks = NATIVE, fee = 3000n) => `0x${w32(0x20n)}${w32(1n)}${w32(0x20n)}${a32(to)}${w32(fee)}${w32(60n)}${a32(hooks)}${w32(0xa0n)}${w32(0n)}`;

type Sell = { w: string; token: string; amount: bigint; target: string; data: string; minOut: bigint; pool: string; precommitment: bigint; feeCap: bigint; deadline: bigint; nonce: bigint };
const SELL: Sell = {
  w: W,
  token: "0x0000000000000000000000000000000000007070",
  amount: 10n ** 18n,
  target: V.poolManager!,
  data: v4Path(), // the kit's one-hop v4 sell of the token for the native asset
  minOut: 10n ** 15n,
  pool: POOL,
  precommitment: 12_345n,
  feeCap: 3n * 10n ** 13n,
  deadline: NOW_S + 300n,
  nonce: 0n,
};
const FEE = 3n * 10n ** 13n; // (fee - L1) / gas = 25,000,000 wei, over 2 x base + tip

/** SellDelegate._sellDigest written out here (SellDelegate.sol), held equal to the helper's and to cast's below. */
function digestOf(s: Sell, chainId = CHAIN_ID): Uint8Array {
  const k = (t: string) => keccak_256(utf8(t));
  const domain = keccak_256(cat(k("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), k("Blindfill"), k("1"), unhex(w32(chainId)), unhex(a32(s.w))));
  const type = k("Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,uint256 deadline,uint256 nonce)");
  const struct = keccak_256(cat(type, unhex(a32(s.token)), unhex(w32(s.amount)), unhex(a32(s.target)), keccak_256(unhex(s.data)), unhex(w32(s.minOut)), unhex(a32(s.pool)), unhex(w32(s.precommitment)), unhex(w32(s.feeCap)), unhex(w32(s.deadline)), unhex(w32(s.nonce))));
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}
/** r ‖ s ‖ v, s low, v 27 or 28 (the kit's signDigest). */
function sign65(k: Uint8Array, digest: Uint8Array): Uint8Array {
  const rec = secp256k1.sign(digest, k, { prehash: false, lowS: true, format: "recovered" });
  return cat(rec.subarray(1, 65), Uint8Array.of(27 + rec[0]!));
}
/** sell(Sell, fee, signature) as solc's abi.encode writes it. */
function sellData(s: Sell, fee: bigint, sig: Uint8Array): string {
  const d = unhex(s.data);
  const pad = (b: Uint8Array) => hex(b).padEnd(Math.ceil(b.length / 32) * 64, "0");
  const tuple = `${a32(s.token)}${w32(s.amount)}${a32(s.target)}${w32(0x140n)}${w32(s.minOut)}${a32(s.pool)}${w32(s.precommitment)}${w32(s.feeCap)}${w32(s.deadline)}${w32(s.nonce)}${w32(BigInt(d.length))}${pad(d)}`;
  return `0x${SELL_SELECTOR}${w32(0x60n)}${w32(fee)}${w32(BigInt(0x60 + tuple.length / 2))}${tuple}${w32(65n)}${pad(sig)}`;
}

// ---- RLP: an encoder for the authorization's digest, a decoder for the sent transaction ----
type Rlp = Uint8Array | Rlp[];
const int = (n: bigint) => (n === 0n ? new Uint8Array() : unhex(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0")));
function enc(x: Rlp): Uint8Array {
  const len = (n: number, short: number) => (n < 56 ? Uint8Array.of(short + n) : cat(Uint8Array.of(short + 55 + int(BigInt(n)).length), int(BigInt(n))));
  if (x instanceof Uint8Array) return x.length === 1 && x[0]! < 0x80 ? x : cat(len(x.length, 0x80), x);
  const body = cat(...x.map(enc));
  return cat(len(body.length, 0xc0), body);
}
function dec(b: Uint8Array): Rlp {
  const one = (at: number): [Rlp, number] => {
    const x = b[at]!;
    const long = (short: number) => {
      const n = x - short - 55;
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + b[at + 1 + i]!;
      return [1 + n, v] as const;
    };
    if (x < 0x80) return [b.subarray(at, at + 1), at + 1];
    if (x < 0xb8) return [b.subarray(at + 1, at + 1 + x - 0x80), at + 1 + x - 0x80];
    if (x < 0xc0) {
      const [h, n] = long(0x80);
      return [b.subarray(at + h, at + h + n), at + h + n];
    }
    const [h, n] = x < 0xf8 ? [1, x - 0xc0] : long(0xc0);
    const out: Rlp[] = [];
    let p = at + h;
    while (p < at + h + n) {
      const [v, q] = one(p);
      out.push(v);
      p = q;
    }
    return [out, p];
  };
  const [v, end] = one(0);
  assert.equal(end, b.length, "nothing after the transaction");
  return v;
}
const num = (u: Rlp) => (u instanceof Uint8Array ? (u.length === 0 ? 0n : BigInt(`0x${hex(u)}`)) : assert.fail("a list"));

type Auth = { chainId: string; address: string; nonce: string; yParity: string; r: string; s: string };
/** An EIP-7702 authorization signed here: keccak256(0x05 ‖ rlp([chainId, address, nonce])), as authJson writes it. */
function authOf(k: Uint8Array, chainId: bigint, address: string, nonce: bigint): Auth {
  const digest = keccak_256(cat(Uint8Array.of(5), enc([int(chainId), unhex(address), int(nonce)])));
  const rec = secp256k1.sign(digest, k, { prehash: false, lowS: true, format: "recovered" });
  return { chainId: `0x${chainId.toString(16)}`, address, nonce: `0x${nonce.toString(16)}`, yParity: `0x${rec[0]!.toString(16)}`, r: `0x${hex(rec.subarray(1, 33))}`, s: `0x${hex(rec.subarray(33, 65))}` };
}
const AUTH = authOf(W_KEY, CHAIN_ID, DELEGATE, W_NONCE);

type Calls = { method: string; params: readonly unknown[] }[];
type Opts = {
  chain?: string; base?: bigint; wNonce?: bigint; l1?: bigint; revert?: boolean;
  /** OP Stack: GasPriceOracle getOperatorFee(gas) (0 unless given); Arbitrum: ArbGasInfo getL1BaseFeeEstimate() (0) */
  opFee?: bigint; arbL1?: bigint;
  /** each sent hash's receipt and transaction as this provider answers them (none given: the method is unexpected) */
  receipt?: (hash: string) => unknown; tx?: (hash: string) => unknown;
  /** this provider refuses eth_sendRawTransaction */
  sendFails?: boolean;
  /** the sender's transaction count at "pending" or "latest" (7 at both unless given; W's is wNonce) */
  count?: (at: string, address: string) => bigint;
  /** eth_maxPriorityFeePerGas (1 unless given) */
  maxTip?: bigint;
  /** this provider refuses each method it names */
  refuse?: (method: string) => boolean;
};
function rpc(calls: Calls, o: Opts = {}): EvmRpc {
  return async (method, params) => {
    calls.push({ method, params });
    if (o.refuse?.(method)) throw new Error("RPC error -32000: refused");
    switch (method) {
      case "eth_chainId": return o.chain ?? `0x${CHAIN_ID.toString(16)}`;
      case "eth_getBlockByNumber": {
        // latest is block 100 at now; block n is 2 s per block before it (a withdraw's epoch search reads them)
        const n = params[0] === "latest" ? 100n : BigInt(params[0] as string);
        return { number: `0x${n.toString(16)}`, timestamp: `0x${(NOW_S - 2n * (100n - n)).toString(16)}`, hash: n === 100n ? `0x${"11".repeat(32)}` : `0x${w32(n)}`, baseFeePerGas: `0x${(o.base ?? BASE).toString(16)}` };
      }
      // a withdraw's reads (a sale reads none of these)
      case "eth_getCode": return "0x";
      case "eth_maxPriorityFeePerGas": return `0x${(o.maxTip ?? 1n).toString(16)}`;
      case "eth_estimateGas": return `0x${(611_391).toString(16)}`;
      case "eth_getTransactionCount": return (params[0] as string) === W ? `0x${(o.wNonce ?? W_NONCE).toString(16)}` : `0x${(o.count?.(params[1] as string, params[0] as string) ?? 7n).toString(16)}`;
      case "eth_call": {
        const c = params[0] as { to: string; data: string };
        if (c.to === ORACLE) return c.data.startsWith(`0x${selector("getOperatorFee(uint256)")}`) ? `0x${w32(o.opFee ?? 0n)}` : `0x${w32(o.l1 ?? L1)}`;
        if (c.to === ARB_GAS_INFO) return `0x${w32(o.arbL1 ?? 0n)}`;
        if (o.revert) throw new Error("RPC error 3: execution reverted: 0xd6d39ee2"); // the kit client's wording
        return `0x${w32(1n)}`;
      }
      case "eth_sendRawTransaction":
        if (o.sendFails) throw new Error("RPC error -32000: already known");
        return `0x${hex(keccak_256(unhex(params[0] as string)))}`;
      case "eth_getTransactionReceipt": if (o.receipt) return o.receipt(params[0] as string); break;
      case "eth_getTransactionByHash": if (o.tx) return o.tx(params[0] as string); break;
    }
    throw new Error(`unexpected ${method}`);
  };
}
const senderOf = (calls: Calls = [], o: Opts = {}, b: Calls = [], ob: Opts = o, network = "base-sepolia", pool = POOL) =>
  evmPoolSender({ network, pool, senderKey: KEY, sellKey: SELL_KEY, floor: 10n ** 12n }, [rpc(calls, o), rpc(b, ob)], () => NOW);
const code = (a: { body: unknown }) => ((a.body as { error?: { code: string } }).error?.code ?? "ok");
const detail = (a: { body: unknown }) => (a.body as { error?: { detail?: string } }).error?.detail ?? "";
const sends = (calls: Calls) => calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0] as string);
/** The body the device sends: W's Sell signed with `signer`, at `fee`, with `auth`. */
const body = (o: { sell?: Partial<Sell>; fee?: bigint; signer?: Uint8Array; sig?: Uint8Array; auth?: Partial<Auth> | Record<string, unknown>; data?: string } = {}) => {
  const s = { ...SELL, ...o.sell };
  const data = o.data ?? sellData(s, o.fee ?? FEE, o.sig ?? sign65(o.signer ?? W_KEY, digestOf(s)));
  return { pool: POOL, w: W, data, authorization: { ...AUTH, ...o.auth } };
};

test("the helper's sell digest is SellDelegate's: cast's signed sells recover to their W over it; the kit's authorization is the one written out here", () => {
  // the kit's cast vectors (fixtures/sell-cast.json, copied from packages/kit/test/evm-pool-sell.cast.json): each Sell
  // signed by anvil's account 0 with cast, as SellDelegate checks it; the helper's digest of the Sell read back from its
  // calldata recovers that signer
  const CAST = JSON.parse(readFileSync(new URL("./fixtures/sell-cast.json", import.meta.url), "utf8")) as { sells: Record<string, Record<string, string>> };
  const ANVIL_0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  assert.deepEqual(Object.keys(CAST.sells), ["baseOneHop", "robinhoodTwoHop"]);
  for (const [name, c] of Object.entries(CAST.sells)) {
    const sell: Sell = { w: ANVIL_0, token: c.sells!.toLowerCase(), amount: BigInt(c.amount!), target: c.target!.toLowerCase(), data: c.data!.toLowerCase(), minOut: BigInt(c.minOut!), pool: c.pool!, precommitment: BigInt(c.precommitment!), feeCap: BigInt(c.feeCap!), deadline: BigInt(c.deadline!), nonce: BigInt(c.nonce!) };
    const sig = unhex(c.sellSignature!);
    const read = evmReadSell(unhex(sellData(sell, 0n, sig)));
    const digest = evmSellDigest(BigInt(c.chainId as unknown as number), ANVIL_0, read);
    assert.equal(hex(digest), hex(digestOf(sell, BigInt(c.chainId as unknown as number))), name);
    const rec = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(digest).toBytes(false);
    assert.equal(`0x${hex(keccak_256(rec.subarray(1)).subarray(12))}`, ANVIL_0, `${name}: cast's signature recovers to W`);
  }
  const kit = evmPoolSignSellAuthorization(W_KEY, "base-sepolia", W_NONCE);
  assert.deepEqual({ chainId: `0x${kit.chainId.toString(16)}`, address: kit.address, nonce: `0x${kit.nonce.toString(16)}`, yParity: `0x${kit.yParity.toString(16)}`, r: kit.r, s: kit.s }, AUTH);
  assert.equal(EVM_POOL_SELL_GAS, 1_000_000n);
  assert.equal(TIP, 1_000_000n);
});

test("a good sell: one type-4 transaction to W, gas 1,000,000, the pinned tip, value 0, the calldata received, the one authorization byte-equal to the body's, signed by the sender", async () => {
  const calls: Calls = [];
  const b: Calls = [];
  const s = senderOf(calls, {}, b);
  const a = await s.sell(body());
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const raws = [...sends(calls), ...sends(b)];
  assert.equal(raws.length, 2, "the one transaction, to both providers");
  assert.equal(raws[0], raws[1]);
  const raw = unhex(raws[0]!);
  assert.equal((a.body as { hash: string }).hash, `0x${hex(keccak_256(raw))}`);
  assert.equal(raw[0], 4, "type 4");
  const f = dec(raw.subarray(1)) as Rlp[];
  assert.equal(f.length, 13);
  const [chainId, nonce, tip, maxFee, gas, to, value, data, access, auths] = f;
  assert.equal(num(chainId!), CHAIN_ID);
  assert.equal(num(nonce!), 7n, "the sender's pending nonce");
  assert.equal(num(tip!), TIP, "maxPriorityFeePerGas: the kit's pinned tip");
  assert.equal(num(gas!), EVM_POOL_SELL_GAS, "gas: exactly the kit's EVM_POOL_SELL_GAS");
  assert.equal(num(maxFee!), 2n * BASE + TIP, "2 x base + tip, under (fee - L1) / gas");
  assert.equal(`0x${hex(to as Uint8Array)}`, W);
  assert.equal(num(value!), 0n);
  assert.equal(`0x${hex(data as Uint8Array)}`, body().data, "the data is the calldata received");
  assert.deepEqual(access, []);
  const want: Rlp[] = [[int(CHAIN_ID), unhex(DELEGATE), int(W_NONCE), int(BigInt(AUTH.yParity)), int(BigInt(AUTH.r)), int(BigInt(AUTH.s))]];
  assert.equal(hex(enc(auths!)), hex(enc(want)), "the authorization list is the body's one authorization, byte for byte");
  // the transaction's signature recovers to the sender
  const digest = keccak_256(cat(Uint8Array.of(4), enc(f.slice(0, 10))));
  const sig = cat(Uint8Array.of(Number(num(f[10]!))), unhex(w32(num(f[11]!))), unhex(w32(num(f[12]!))));
  assert.equal(hex(secp256k1.recoverPublicKey(sig, digest, { prehash: false })), hex(secp256k1.getPublicKey(SELL_KEY, true)), "signed by the sell key, never the withdraw sender's");
  // never an estimate and never the node's tip
  const methods = [...calls, ...b].map((c) => c.method);
  assert.ok(!methods.includes("eth_estimateGas") && !methods.includes("eth_maxPriorityFeePerGas"), methods.join(","));
  // the simulation: at pending, from the sender, to W, gas less the authorization's intrinsic gas, the signed fee
  // fields, and W's code as the delegation designator
  const sim = calls.find((c) => c.method === "eth_call" && (c.params[0] as { to: string }).to === W)!;
  assert.deepEqual(sim.params, [
    { from: SENDER, to: W, data: body().data, gas: `0x${(EVM_POOL_SELL_GAS - EVM_7702_AUTH_GAS).toString(16)}`, maxFeePerGas: `0x${(2n * BASE + TIP).toString(16)}`, maxPriorityFeePerGas: `0x${TIP.toString(16)}` },
    "pending",
    { [W]: { code: `0xef0100${DELEGATE.slice(2)}` } },
  ]);
  // the L1 bound is read for at least the sent transaction's length, on both providers
  for (const c of [calls, b]) {
    const o = c.find((x) => x.method === "eth_call" && (x.params[0] as { to: string }).to === ORACLE)!;
    const d = (o.params[0] as { data: string }).data;
    assert.equal(d.slice(0, 10), `0x${hex(keccak_256(utf8("getL1FeeUpperBound(uint256)")).subarray(0, 4))}`);
    assert.ok(BigInt(`0x${d.slice(10)}`) >= BigInt(raw.length), `bound length ${BigInt(`0x${d.slice(10)}`)} under ${raw.length}`);
  }
  // W's pending nonce read on both providers
  for (const c of [calls, b]) assert.ok(c.some((x) => x.method === "eth_getTransactionCount" && x.params[0] === W && x.params[1] === "pending"));
});

test("the fee is bounded: at the bound it sends and the sender's worst cost is within the fee; one wei under is fee_low; a cap at (fee - L1) / gas", async () => {
  {
    const calls: Calls = [];
    const a = await senderOf(calls).sell(body({ fee: NEED, sell: { feeCap: NEED } }));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const f = dec(unhex(sends(calls)[0]!).subarray(1)) as Rlp[];
    assert.equal(num(f[3]!), (NEED - L1) / EVM_POOL_SELL_GAS, "maxFeePerGas: (fee - L1) / gas, under 2 x base + tip");
    assert.ok(num(f[3]!) * num(f[4]!) + L1 <= NEED);
  }
  const calls: Calls = [];
  const a = await senderOf(calls).sell(body({ fee: NEED - 1n, sell: { feeCap: NEED } }));
  assert.equal(code(a), "fee_low", detail(a));
  assert.equal(sends(calls).length, 0);
  // Robinhood: no tip and no L1 oracle (its L1 cost is in its gas)
  const r: Calls = [];
  const rn = evmPoolVenues()["robinhood-testnet"];
  const rs = { ...SELL, pool: rn.pool!, target: rn.poolManager!, feeCap: EVM_POOL_SELL_GAS * BASE };
  const rid = BigInt(rn.chainId);
  const rd = (x: Sell, k = W_KEY) => sellData(x, x.feeCap, sign65(k, digestOf(x, rid)));
  const robin = evmPoolSender({ network: "robinhood-testnet", pool: rn.pool!, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(r, { chain: `0x${rid.toString(16)}` }), rpc([], { chain: `0x${rid.toString(16)}` })], () => NOW);
  const ra = authOf(W_KEY, rid, rn.sellDelegate!, W_NONCE);
  const ok = await robin.sell({ pool: rn.pool!, w: W, data: rd(rs), authorization: ra });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rf = dec(unhex(sends(r)[0]!).subarray(1)) as Rlp[];
  assert.equal(num(rf[2]!), 0n, "Robinhood's tip is 0");
  assert.equal(num(rf[3]!), BASE, "(fee - 0) / gas = base");
  assert.ok(!r.some((c) => c.method === "eth_call" && (c.params[0] as { to: string }).to === ORACLE), "no L1 oracle read on Robinhood");
  const low = await evmPoolSender({ network: "robinhood-testnet", pool: rn.pool!, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc([], { chain: `0x${rid.toString(16)}` }), rpc([], { chain: `0x${rid.toString(16)}` })], () => NOW)
    .sell({ pool: rn.pool!, w: W, data: rd({ ...rs, feeCap: EVM_POOL_SELL_GAS * BASE - 1n }), authorization: ra });
  assert.equal(code(low), "fee_low");
});

test("the operator fee is in the bound: the kit's chain fee reads, getOperatorFee(1,000,000) on both providers, the higher; at the bound with it the sale goes, one wei under is fee_low", async () => {
  const OP = 7_000_000_000n;
  const need = NEED + OP;
  for (const c of [[{ opFee: OP }, { opFee: OP }], [{}, { opFee: OP }], [{ opFee: OP }, {}]] as [Opts, Opts][]) {
    const x: Calls = [];
    const y: Calls = [];
    const label = `operator fee on A ${c[0].opFee ?? 0n}, on B ${c[1].opFee ?? 0n}`;
    assert.equal(code(await senderOf(x, c[0], y, c[1]).sell(body({ fee: need - 1n, sell: { feeCap: need } }))), "fee_low", label);
    assert.equal(sends(x).length, 0);
    for (const q of [x, y]) assert.ok(q.some((m) => m.method === "eth_call" && (m.params[0] as { to: string; data: string }).to === ORACLE && (m.params[0] as { data: string }).data === `0x${selector("getOperatorFee(uint256)")}${w32(EVM_POOL_SELL_GAS)}`), "getOperatorFee(gas) read on both providers");
  }
  const x: Calls = [];
  const a = await senderOf(x, { opFee: OP }, [], { opFee: OP }).sell(body({ fee: need, sell: { feeCap: need } }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const f = dec(unhex(sends(x)[0]!).subarray(1)) as Rlp[];
  assert.ok(num(f[3]!) * num(f[4]!) + L1 + OP <= need, "the worst cost, the chain fee with it, within the fee");
});

test("Robinhood's L1 poster fee: ArbGasInfo's estimate on both providers; the bound holds 16 x the transaction's bytes x the higher estimate; the sim's gas is the limit less the authorization's 25,000 and the poster's gas at the lower base fee; a poster's gas that leaves no room is simulation_failed", async () => {
  const rn = evmPoolVenues()["robinhood-testnet"];
  const rid = BigInt(rn.chainId);
  const ch = `0x${rid.toString(16)}`;
  const ra = authOf(W_KEY, rid, rn.sellDelegate!, W_NONCE);
  const sale = (feeCap: bigint) => {
    const x = { ...SELL, pool: rn.pool!, target: rn.poolManager!, feeCap };
    return { pool: rn.pool!, w: W, data: sellData(x, feeCap, sign65(W_KEY, digestOf(x, rid))), authorization: ra };
  };
  const robin = (a: Calls, oa: Opts, b: Calls, ob: Opts) => evmPoolSender({ network: "robinhood-testnet", pool: rn.pool!, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(a, { chain: ch, ...oa }), rpc(b, { chain: ch, ...ob })], () => NOW);
  const EST = 1_000_001n;
  // a fee that covers the gas and any poster fee this test sets: the sale goes, the sim's gas less the poster's gas
  const x: Calls = [];
  const y: Calls = [];
  const ok = await robin(x, { arbL1: EST }, y, { arbL1: EST / 2n, base: 2n * BASE }).sell(sale(3n * 10n ** 13n));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const q of [x, y]) assert.ok(q.some((m) => m.method === "eth_call" && (m.params[0] as { to: string; data: string }).to === ARB_GAS_INFO && (m.params[0] as { data: string }).data === `0x${selector("getL1BaseFeeEstimate()")}`), "the estimate read on both providers");
  const rawLen = BigInt(unhex(sends(x)[0]!).length);
  const sim = x.find((m) => m.method === "eth_call" && (m.params[0] as { to: string }).to === W)!;
  const simGas = BigInt((sim.params[0] as { gas: string }).gas);
  // the poster's gas: the poster fee over the lower base fee, rounded up. The poster fee the helper read for this sale's
  // longest form is in a fee_low answer's detail at a fee whose fee / gas is as long (2.9e7 and 3e7 wei, 4 bytes each)
  const probe = await robin([], { arbL1: EST }, [], { arbL1: EST, base: 3n * BASE }).sell(sale(29n * 10n ** 12n));
  assert.equal(code(probe), "fee_low", JSON.stringify(probe.body));
  const posterFee = BigInt(/ \+ (\d+) = /.exec(detail(probe))![1]!);
  assert.ok(posterFee >= 16n * rawLen * EST && posterFee <= 16n * (rawLen + 16n) * EST, `poster fee ${posterFee} for ${rawLen} bytes`);
  assert.equal(posterFee % 16n, 0n);
  assert.notEqual(posterFee % BASE, 0n, "a poster gas that rounds");
  assert.equal(simGas, EVM_POOL_SELL_GAS - EVM_7702_AUTH_GAS - (posterFee + BASE - 1n) / BASE, `sim gas ${simGas}`);
  // the bound: gas x the base fee + the poster fee (its bytes within 16 of this sale's, whose fee field is shorter):
  // a fee under it by the poster fee of 16 bytes is fee_low, one over it by that much goes
  const chainFee = (bytes: bigint) => 16n * bytes * EST;
  const z: Calls = [];
  const low = await robin(z, { arbL1: EST }, [], { arbL1: EST }).sell(sale(EVM_POOL_SELL_GAS * BASE + chainFee(rawLen - 16n) - 1n));
  assert.equal(code(low), "fee_low", `${JSON.stringify(low.body)} raw ${rawLen}`);
  assert.equal(sends(z).length, 0);
  const enough = await robin([], { arbL1: EST }, [], { arbL1: EST }).sell(sale(EVM_POOL_SELL_GAS * BASE + chainFee(rawLen + 16n)));
  assert.equal(enough.status, 200, JSON.stringify(enough.body));
  // a poster's gas past the limit less the authorization's: nothing to run the sale with, refused, nothing sent
  const BIG = 10n ** 9n; // 16 x ~800 bytes x 1e9 / 1e7 = ~1.3M gas
  const w: Calls = [];
  const none = await robin(w, { arbL1: BIG }, [], { arbL1: BIG }).sell(sale(9n * 10n ** 13n));
  assert.deepEqual([none.status, code(none)], [422, "simulation_failed"], JSON.stringify(none.body));
  assert.equal(sends(w).length, 0);
});

test("the base fee and the L1 bound are each the higher of the two providers' answers", async () => {
  const calls: Calls = [];
  assert.equal(code(await senderOf(calls, {}, [], { base: 2n * BASE }).sell(body({ fee: NEED, sell: { feeCap: NEED } }))), "fee_low", "provider B's base fee doubles the bound");
  assert.equal(code(await senderOf(calls, {}, [], { l1: L1 + 1n }).sell(body({ fee: NEED, sell: { feeCap: NEED } }))), "fee_low", "provider B's L1 bound one wei more");
  assert.equal(code(await senderOf(calls, { l1: L1 + 1n }, [], {}).sell(body({ fee: NEED, sell: { feeCap: NEED } }))), "fee_low", "provider A's L1 bound one wei more");
  assert.equal(sends(calls).length, 0);
});

test("a sell is held with the withdraws: one client holds at most EVM_IN_FLIGHT_MAX open, the next is in_flight", async () => {
  const hang: EvmRpc = async (m, p) => (m === "eth_chainId" ? new Promise(() => {}) : rpc([])(m, p));
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [hang, hang], () => NOW);
  void s.sell(body({ sell: { nonce: 0n } }), "203.0.113.7");
  void s.sell(body({ sell: { nonce: 1n } }), "203.0.113.7");
  // the refusal is at once; a sell let through would wait on the hung reads, so the wait is bounded here
  const late = new Promise<{ status: number; body: unknown; retryAfterS?: number }>((ok) => setTimeout(() => ok({ status: 0, body: { error: { code: "still waiting" } } }), 1_000));
  const third = await Promise.race([s.sell(body({ sell: { nonce: 2n } }), "203.0.113.7"), late]);
  assert.deepEqual([third.status, code(third), third.retryAfterS], [429, "in_flight", 2]);
  assert.deepEqual(code(await Promise.race([s.carry({ pool: POOL, data: "0x00", epoch: 60_000 }, "203.0.113.7"), late])), "in_flight", "a withdraw from the same client too");
});

test("the authorization: chainId 0, another chain's id, another delegate, another signer, a high s, yParity 2, a nonce at 2^64 - 1, no pinned delegate: bad_authorization, nothing read", async () => {
  const high = { ...AUTH, s: `0x${w32(N - BigInt(AUTH.s))}`, yParity: AUTH.yParity === "0x0" ? "0x1" : "0x0" };
  // each with the words its detail names
  const cases: [string, Record<string, unknown>, string][] = [
    ["chainId 0", authOf(W_KEY, 0n, DELEGATE, W_NONCE), "chainId 0"],
    ["another chain's id", authOf(W_KEY, 8453n, DELEGATE, W_NONCE), "chainId 8453"],
    ["another delegate", authOf(W_KEY, CHAIN_ID, "0x000000000000000000000000000000000000dead", W_NONCE), "not the pinned delegate"],
    ["another signer", authOf(OTHER_KEY, CHAIN_ID, DELEGATE, W_NONCE), `signed by ${evmAddressOf(OTHER_KEY)}`],
    ["a high s (the same signer's other form)", high, "s high"],
    ["yParity 2", { ...AUTH, yParity: "0x2" }, "yParity 2"],
    ["a nonce at 2^64 - 1", authOf(W_KEY, CHAIN_ID, DELEGATE, 2n ** 64n - 1n), "under 2^64 - 1"],
    ["r 0", { ...AUTH, r: `0x${w32(0n)}` }, "r or s"],
    ["s 0", { ...AUTH, s: `0x${w32(0n)}` }, "r or s"],
    ["r at n", { ...AUTH, r: `0x${w32(N)}` }, "r or s"],
  ];
  for (const [name, auth, says] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls, {}, calls).sell(body({ auth }));
    assert.equal(a.status, 422, name);
    assert.equal(code(a), "bad_authorization", `${name}: ${JSON.stringify(a.body)}`);
    assert.ok(detail(a).includes(says), `${name}: ${detail(a)}`);
    assert.equal(calls.length, 0, `${name}: no RPC call`);
  }
  // the recovered signer of high s is W itself: only the s rule refuses it
  const digest = keccak_256(cat(Uint8Array.of(5), enc([int(CHAIN_ID), unhex(DELEGATE), int(W_NONCE)])));
  const flipped = secp256k1.Signature.fromBytes(unhex(`${high.r}${high.s.slice(2)}`), "compact").addRecoveryBit(Number(BigInt(high.yParity)));
  assert.equal(hex(flipped.recoverPublicKey(digest).toBytes(true)), hex(secp256k1.getPublicKey(W_KEY, true)));
  // base (mainnet) pins no sell delegate yet: every sell there is refused, fail closed
  const calls: Calls = [];
  const m = evmPoolSender({ network: "base", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(calls), rpc(calls)], () => NOW);
  assert.equal(Object.hasOwn(evmPoolVenues().base, "sellDelegate"), false);
  const a = await m.sell(body({ auth: authOf(W_KEY, 8453n, DELEGATE, W_NONCE) }));
  assert.equal(code(a), "bad_authorization", detail(a));
  assert.equal(calls.length, 0);
  // a network the kit does not list: refused too
  assert.equal(code(await senderOf([], {}, [], {}, "anvil").sell(body())), "bad_authorization");
});

test("auth_nonce: W's pending nonce on either provider is not the authorization's, so the chain would skip it", async () => {
  for (const [oa, ob] of [[{ wNonce: W_NONCE + 1n }, {}], [{}, { wNonce: W_NONCE - 1n }]] as [Opts, Opts][]) {
    const calls: Calls = [];
    const b: Calls = [];
    const a = await senderOf(calls, oa, b, ob).sell(body());
    assert.equal(code(a), "auth_nonce", `${oa.wNonce} ${ob.wNonce}: ${detail(a)}`);
    assert.equal(sends(calls).length + sends(b).length, 0);
  }
});

test("the Sell: another pool is not_pool; fee over feeCap and a feeCap not under minOut are fee_over_cap; nothing read", async () => {
  const cases: [string, Parameters<typeof body>[0], string][] = [
    ["another pool", { sell: { pool: "0x000000000000000000000000000000000000beef" } }, "not_pool"],
    ["fee over feeCap", { fee: SELL.feeCap + 1n }, "fee_over_cap"],
    ["feeCap at minOut", { sell: { feeCap: SELL.minOut }, fee: FEE }, "fee_over_cap"],
  ];
  for (const [name, o, want] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls, {}, calls).sell(body(o));
    assert.equal(code(a), want, `${name}: ${JSON.stringify(a.body)}`);
    assert.equal(calls.length, 0, name);
  }
});

test("W's Sell signature: by another key, a high s, v 29, or over another Sell is bad_signature; nothing read", async () => {
  const good = sign65(W_KEY, digestOf(SELL));
  const s = BigInt(`0x${hex(good.subarray(32, 64))}`);
  const high = cat(good.subarray(0, 32), unhex(w32(N - s)), Uint8Array.of(good[64] === 27 ? 28 : 27));
  const cases: [string, Parameters<typeof body>[0], string][] = [
    ["another key", { signer: OTHER_KEY }, `signed by ${evmAddressOf(OTHER_KEY)}`],
    ["a high s", { sig: high }, "s high"],
    ["v 29", { sig: cat(good.subarray(0, 64), Uint8Array.of(29)) }, "v not 27 or 28"],
    ["v 0", { sig: cat(good.subarray(0, 64), Uint8Array.of(good[64]! - 27)) }, "v not 27 or 28"],
    ["over another Sell", { data: sellData({ ...SELL, amount: SELL.amount + 1n }, FEE, good) }, "not W"],
  ];
  for (const [name, o, says] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls, {}, calls).sell(body(o));
    assert.equal(code(a), "bad_signature", `${name}: ${JSON.stringify(a.body)}`);
    assert.ok(detail(a).includes(says), `${name}: ${detail(a)}`);
    assert.equal(calls.length, 0, name);
  }
});

test("the deadline is unix seconds: 59 s away is deadline_near, 60 s is fine, 600 s is fine, 601 s and one written in ms are deadline_far; nothing read", async () => {
  const cases: [string, bigint, string][] = [
    ["59 s away", NOW_S + 59n, "deadline_near"],
    ["60 s away", NOW_S + 60n, "ok"],
    ["600 s away", NOW_S + 600n, "ok"],
    ["601 s away", NOW_S + 601n, "deadline_far"],
    ["in milliseconds", BigInt(NOW) + 300_000n, "deadline_far"],
  ];
  for (const [name, deadline, want] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls).sell(body({ sell: { deadline } }));
    assert.equal(code(a), want, `${name}: ${JSON.stringify(a.body)}`);
    if (want !== "ok") assert.equal(calls.length, 0, name);
  }
  // a Sell 59 s from its deadline at a (W, nonce) already sent is refused before the repeat's lookup, never answered
  // with the first hash
  const calls: Calls = [];
  const s = senderOf(calls);
  assert.equal((await s.sell(body())).status, 200);
  const near = await s.sell(body({ sell: { deadline: NOW_S + 59n } }));
  assert.equal(code(near), "deadline_near", JSON.stringify(near.body));
});

test("bad_shape: one trailing byte, a byte short, another selector, a changed offset, length or padding, a 64-byte signature, too long, any other key; nothing read", async () => {
  const good = body().data;
  const at = (i: number) => 2 + 8 + 64 * i; // the hex index of calldata word i
  const flip = (i: number, ch: string) => `${good.slice(0, i)}${ch}${good.slice(i + 1)}`;
  const words = (good.length - 10) / 64;
  const sig64 = (() => {
    // the signature's length word 64, its padding the same 96 bytes
    const lenAt = at(words - 4);
    return `${good.slice(0, lenAt)}${w32(64n)}${good.slice(lenAt + 64)}`;
  })();
  const cases: [string, unknown][] = [
    ["one trailing byte", { ...body(), data: `${good}00` }],
    ["a byte short", { ...body(), data: good.slice(0, -2) }],
    ["a word more", { ...body(), data: `${good}${w32(0n)}` }],
    ["another selector", { ...body(), data: flip(2, good[2] === "0" ? "1" : "0") }],
    ["the tuple's offset", { ...body(), data: flip(at(0) + 63, "1") }],
    ["the signature's offset", { ...body(), data: flip(at(2) + 62, "f") }],
    ["the data's offset", { ...body(), data: flip(at(3 + 3) + 63, "1") }],
    ["an address's high bytes", { ...body(), data: flip(at(3) + 2, "1") }],
    // swap data of 100 bytes, padded to 128: its last padding byte set (the decoder refuses it before the route check)
    ["the data's padding", (() => { const b = body({ sell: { data: `0x${"ab".repeat(100)}` } }); return { ...b, data: `${b.data.slice(0, at(3 + 11) + 64 * 4 - 1)}1${b.data.slice(at(3 + 11) + 64 * 4)}` }; })()],
    ["the signature's padding", { ...body(), data: flip(good.length - 1, "1") }],
    ["a 64-byte signature", { ...body(), data: sig64 }],
    ["too long", body({ sell: { data: `0x${"ab".repeat(2_000)}` } })],
    ["an extra key", { ...body(), extra: 1 }],
    ["no authorization", { pool: POOL, w: W, data: good }],
    ["an extra authorization key", { ...body(), authorization: { ...AUTH, v: "0x1b" } }],
    ["an authorization as a list", { ...body(), authorization: [AUTH] }],
    ["a nonce as a number", { ...body(), authorization: { ...AUTH, nonce: 3 } }],
    ["a nonce written 0x03", { ...body(), authorization: { ...AUTH, nonce: "0x03" } }],
    ["r of 31 bytes", { ...body(), authorization: { ...AUTH, r: AUTH.r.slice(0, -2) } }],
    ["another pool in the body", { ...body(), pool: "0x000000000000000000000000000000000000beef" }],
    ["W not an address", { ...body(), w: "0x1234" }],
    ["W not the Sell's signer field", { ...body(), w: "0x000000000000000000000000000000000000beef" }],
  ];
  for (const [name, b] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls, {}, calls).sell(b);
    assert.ok(["bad_shape", "bad_authorization", "bad_signature"].includes(code(a)), `${name}: ${JSON.stringify(a.body)}`);
    if (name !== "W not the Sell's signer field") assert.equal(code(a), "bad_shape", `${name}: ${JSON.stringify(a.body)}`);
    assert.equal(calls.length, 0, `${name}: no RPC call`);
  }
});

test("a sim that reverts is simulation_failed and sends nothing; a provider's other error is upstream", async () => {
  const calls: Calls = [];
  const a = await senderOf(calls, { revert: true }).sell(body());
  assert.equal(code(a), "simulation_failed", JSON.stringify(a.body));
  assert.equal(sends(calls).length, 0);
  const down: EvmRpc = async (m, p) => (m === "eth_call" && (p[0] as { to: string }).to === W ? Promise.reject(new Error("HTTP 502")) : rpc([])(m, p));
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [down, rpc([])], () => NOW);
  assert.equal(code(await s.sell(body())), "upstream");
});

test("the chain: the providers on different chains, or both on a chain that is not the venue's, is upstream; nothing sent", async () => {
  for (const [oa, ob] of [[{ chain: "0x2105" }, {}], [{ chain: "0x2105" }, { chain: "0x2105" }]] as [Opts, Opts][]) {
    const calls: Calls = [];
    const b: Calls = [];
    assert.equal(code(await senderOf(calls, oa, b, ob).sell(body())), "upstream", JSON.stringify([oa, ob]));
    assert.equal(sends(calls).length + sends(b).length, 0);
  }
});

test("once per (W, Sell nonce): a repeat in flight or after, even as other bytes, gets the first hash and sends nothing; another nonce is the next send on the same nonce lane", async () => {
  const calls: Calls = [];
  const s = senderOf(calls);
  const [a, b] = await Promise.all([s.sell(body()), s.sell(body())]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(b, a);
  const copy = await s.sell(body({ fee: FEE - 1n }));
  assert.deepEqual(copy, a, "the same (W, nonce) in other bytes");
  assert.equal(sends(calls).length, 1);
  const next = await s.sell(body({ sell: { nonce: 1n } }));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.notDeepEqual(next, a);
  const raws = sends(calls).map((r) => dec(unhex(r).subarray(1)) as Rlp[]);
  assert.equal(raws.length, 2);
  assert.equal(num(raws[1]![1]!), num(raws[0]![1]!) + 1n, "the next sender nonce");
  // a refused sell frees its (W, nonce): it is checked again
  const r: Calls = [];
  const t = senderOf(r, { revert: true });
  assert.equal(code(await t.sell(body())), "simulation_failed");
  assert.equal(code(await t.sell(body())), "simulation_failed");
  assert.equal(r.filter((c) => c.method === "eth_call" && (c.params[0] as { to: string }).to === W).length, 2);
});

test("the fee answer names the sell sender's address as sell_sender (null with no sell key), so the kit can pin and check it", async () => {
  const s = senderOf();
  assert.equal(s.sellSender, SENDER);
  assert.equal(s.sender, evmAddressOf(KEY), "the withdraw sender is its own key");
  const calls: Calls = [];
  const chain = rpc(calls);
  // the fee reads the epoch's first block: a chain whose blocks are 2 s apart up to now
  const blocks: EvmRpc = async (m, p) => {
    if (m !== "eth_getBlockByNumber") return chain(m, p);
    const latest = 1000n;
    const n = p[0] === "latest" ? latest : BigInt(p[0] as string);
    return { number: `0x${n.toString(16)}`, timestamp: `0x${(NOW_S - 2n * (latest - n)).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: "0x3b9aca00" };
  };
  const f = await evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [blocks, blocks], () => NOW).fee(NOW);
  assert.equal(f?.sell_sender, SENDER);
  assert.equal(Object.hasOwn(f!, "sender"), false, "the field is sell_sender, never the withdraw sender's address");
  const none = await evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, floor: 1n }, [blocks, blocks], () => NOW).fee(NOW);
  assert.equal(none?.sell_sender, null);
});

// ---- The sell sender's own costs (card helper-evm-sender, fold 1): a sale that did not land frees its (W, nonce), a
// bounded number of times; only the kit builder's routes are sent; every sale's unpaid gas is held to caps; sells have
// their own key; Base reads its L1 bound; one provider's failed send still advances the nonce lane; the deadline is
// checked again after the queue.

const tick = () => new Promise((ok) => setTimeout(ok, 5));
/** A receipt as a node answers one: status, the gas used, its price and (OP chains) the L1 fee. */
const receiptOf = (status: "0x0" | "0x1", o: { gasUsed?: bigint; price?: bigint; l1Fee?: bigint } = {}) => ({
  status, gasUsed: `0x${(o.gasUsed ?? 1_000_000n).toString(16)}`, effectiveGasPrice: `0x${(o.price ?? 2n * BASE + TIP).toString(16)}`, ...(o.l1Fee === undefined ? {} : { l1Fee: `0x${o.l1Fee.toString(16)}` }),
});
const reads = (calls: Calls, m: string) => calls.filter((c) => c.method === m).length;
/** A sale from a fresh W of `label`, its authorization at W's pending nonce (the mock answers 7 for any but W). */
const freshBody = (label: string, o: { sell?: Partial<Sell>; fee?: bigint } = {}) => {
  const k = key(label);
  const s = { ...SELL, w: evmAddressOf(k), ...o.sell };
  return { pool: POOL, w: s.w, data: sellData(s, o.fee ?? FEE, sign65(k, digestOf(s))), authorization: authOf(k, CHAIN_ID, DELEGATE, 7n) };
};

test("a sale that reverted or was dropped frees its (W, Sell nonce): a receipt with status 0 on either provider, or no transaction on either past the deadline; a success or a sale still waiting keeps the first hash; no count of frees, only W's unpaid cap", async () => {
  // reverted: the repeat reads the first hash's receipt on both providers and sends a new Sell at the same nonce
  {
    const x: Calls = [];
    const y: Calls = [];
    const s = senderOf(x, { receipt: () => null, tx: () => ({}) }, y, { receipt: () => receiptOf("0x0") });
    const first = await s.sell(body());
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await s.sell(body({ sell: { deadline: NOW_S + 500n, minOut: SELL.minOut / 2n } }));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.notDeepEqual(again, first, "a new send, not the dead hash");
    assert.equal(sends(x).length, 2);
    assert.ok(reads(x, "eth_getTransactionReceipt") >= 1 && reads(y, "eth_getTransactionReceipt") >= 1, "the receipt read on both providers");
  }
  // landed (status 1 on either), or still waiting (no receipt, a transaction known): the first hash, nothing sent
  for (const [name, oa, ob] of [
    ["landed", { receipt: () => receiptOf("0x1") }, { receipt: () => null, tx: () => ({}) }],
    ["landed on one, reverted on the other", { receipt: () => receiptOf("0x1") }, { receipt: () => receiptOf("0x0") }],
    ["waiting", { receipt: () => null, tx: () => ({}) }, { receipt: () => null, tx: () => ({}) }],
    ["no receipt, before the deadline", { receipt: () => null, tx: () => null }, { receipt: () => null, tx: () => null }],
  ] as [string, Opts, Opts][]) {
    const x: Calls = [];
    const s = senderOf(x, oa, [], ob);
    const first = await s.sell(body());
    assert.deepEqual(await s.sell(body({ sell: { deadline: NOW_S + 500n } })), first, name);
    assert.equal(sends(x).length, 1, name);
  }
  // dropped: no receipt and no transaction on either provider once now is past the first Sell's deadline frees it;
  // a transaction still on one provider does not
  for (const [onB, want] of [[null, 2], [{}, 1]] as [unknown, number][]) {
    let clock = NOW;
    const x: Calls = [];
    const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(x, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => onB })], () => clock);
    assert.equal((await s.sell(body())).status, 200);
    clock = NOW + 361_000; // past the first deadline (NOW_S + 300) and its 60 s margin
    const later = await s.sell(body({ sell: { deadline: NOW_S + 600n } }));
    assert.equal(sends(x).length, want, `the transaction on provider B: ${JSON.stringify(onB)}: ${JSON.stringify(later.body)}`);
    if (want === 1) assert.equal(reads(x, "eth_getTransactionByHash"), 1);
  }
  // no count of frees: a device retries a reverted sale as often as it needs; each retry's worst cost is held against
  // W, so W's unpaid cap (EVM_SELL_UNPAID_CAP_WEI) is what stops it, with the wait
  {
    const worst = EVM_POOL_SELL_GAS * (2n * BASE + TIP) + L1;
    const x: Calls = [];
    const s = senderOf(x, { receipt: () => receiptOf("0x0") });
    let sent = 0;
    let last: Awaited<ReturnType<typeof s.sell>> | undefined;
    for (let i = 0; i < 60; i++) {
      last = await s.sell(body());
      if (last.status === 200) sent++;
    }
    assert.equal(BigInt(sent), EVM_SELL_UNPAID_CAP_WEI / worst, `${sent} sent: every free up to W's cap is a new send`);
    assert.equal(sends(x).length, sent);
    assert.deepEqual([last!.status, code(last!)], [429, "rate_limited"], JSON.stringify(last!.body));
    assert.ok(detail(last!).includes("for W"), detail(last!));
  }
});

// A dropped sale is freed only once our clock is past its deadline plus 60 s (EVM_SELL_DROP_MARGIN_MS): a helper whose clock
// runs up to 60 s ahead of the chain's would otherwise free (W, nonce) while the first sale can still land, and send a
// second tx at that nonce. The first Sell's deadline is NOW_S + 300; neither provider holds a receipt or the tx.
const droppedAt = async (pastMs: readonly number[]) => {
  let clock = NOW;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(x, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => null })], () => clock);
  const first = await s.sell(body());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const seen: { past: number; sends: number; txReads: number; same: boolean }[] = [];
  for (const past of pastMs) {
    clock = NOW + 300_000 + past;
    const again = await s.sell(body({ sell: { deadline: BigInt(Math.floor(clock / 1000)) + 300n } }));
    seen.push({ past, sends: sends(x).length, txReads: reads(x, "eth_getTransactionByHash"), same: JSON.stringify(again) === JSON.stringify(first) });
  }
  return seen;
};

test("a dropped sale with our clock 59 s ahead of the chain's deadline keeps its (W, Sell nonce) held: the first hash, no second tx, no tx read", async () => {
  assert.deepEqual(await droppedAt([59_000]), [{ past: 59_000, sends: 1, txReads: 0, same: true }]);
});

test("a dropped sale is freed at 61 s past its deadline, never at or before 60 s: held at 1 s, 59 s and 60 s, a new send at 61 s", async () => {
  assert.deepEqual(await droppedAt([1_000, 59_000, 60_000, 61_000]), [
    { past: 1_000, sends: 1, txReads: 0, same: true },
    { past: 59_000, sends: 1, txReads: 0, same: true },
    { past: 60_000, sends: 1, txReads: 0, same: true },
    { past: 61_000, sends: 2, txReads: 2, same: false }, // the drop's read, then the new send's hole check of that hash
  ]);
});

test("bad_route: a sale to any target but the PoolManager or a listed router, or swap data the kit's builder would not make, is refused before any read", async () => {
  const cases: [string, Partial<Sell>][] = [
    ["any target, any token (0x…dead, 0x…deadbeef)", { target: "0x000000000000000000000000000000000000dead", token: "0x00000000000000000000000000000000deadbeef", data: `0x${"ff".repeat(32)}` }],
    ["the PoolManager with data that is no path", { data: `0x${"ff".repeat(32)}` }],
    ["an unlisted hook", { data: v4Path(NATIVE, "0x00000000000000000000000000000000000000cc") }],
    ["a path that ends at another token", { data: v4Path("0x0000000000000000000000000000000000007071") }],
    ["a listed router with v4 data", { target: V.routers[0]!.toLowerCase() }],
  ];
  for (const [name, sell] of cases) {
    const calls: Calls = [];
    const a = await senderOf(calls, {}, calls).sell(body({ sell }));
    assert.deepEqual([a.status, code(a)], [422, "bad_route"], `${name}: ${JSON.stringify(a.body)}`);
    assert.equal(calls.length, 0, `${name}: nothing read`);
  }
});

test("unpaid sell gas: reverting sales are held against the client, the token, W and the sender's budget; past a cap 429 rate_limited with the wait", async () => {
  // 50 sales from one client, 50 fresh Ws, each its own token, every landed transaction reverting: the client's cap
  const worst = EVM_POOL_SELL_GAS * (2n * BASE + TIP) + L1;
  const tokenOf = (i: number) => `0x${(0x7000 + i).toString(16).padStart(40, "0")}`;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, { receipt: () => receiptOf("0x0", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  let sent = 0;
  let last: Awaited<ReturnType<typeof s.sell>> | undefined;
  for (let i = 0; i < 50; i++) {
    last = await s.sell(freshBody(`W-fresh-${i}`, { sell: { token: tokenOf(i) } }), "203.0.113.9");
    if (last.status === 200) sent++;
    await tick();
  }
  assert.equal(BigInt(sent), EVM_SELL_UNPAID_CAP_WEI / worst, `${sent} sent`);
  assert.deepEqual([last!.status, code(last!)], [429, "rate_limited"]);
  assert.ok(last!.retryAfterS! >= 1 && last!.retryAfterS! <= EVM_SELL_UNPAID_WINDOW_MS / 1000);
  assert.ok(BigInt(sent) * worst <= EVM_SELL_UNPAID_CAP_WEI);
  assert.equal(sends(x).length, sent);
  assert.ok(detail(last!).includes("this client"), detail(last!));
  // one W, many Sell nonces, each its own token, no client: W's cap
  const v: Calls = [];
  const u = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(v, { receipt: () => receiptOf("0x0", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  let byW = 0;
  for (let i = 0; i < 50; i++) {
    last = await u.sell(body({ sell: { nonce: BigInt(i), token: tokenOf(i) } }));
    if (last.status === 200) byW++;
    await tick();
  }
  assert.equal(BigInt(byW), EVM_SELL_UNPAID_CAP_WEI / worst, `${byW} sent`);
  assert.ok(detail(last!).includes("for W"), detail(last!));
  // a burst with no client and no receipt yet: each sale's worst cost is held from its send, so the token's cap stops it
  const y: Calls = [];
  const t = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(y, { receipt: () => null }), rpc([], { receipt: () => null })], () => NOW);
  const all = await Promise.all(Array.from({ length: 50 }, (_, i) => t.sell(freshBody(`W-burst-${i}`))));
  assert.equal(BigInt(all.filter((a) => a.status === 200).length), EVM_SELL_UNPAID_CAP_WEI / worst);
  assert.ok(all.filter((a) => a.status !== 200).every((a) => code(a) === "rate_limited"));
  // a sale that landed and paid its fee holds nothing: 60 in a row from one client all go
  const z: Calls = [];
  const paid = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(z, { receipt: () => receiptOf("0x1", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  for (let i = 0; i < 60; i++) {
    assert.equal((await paid.sell(freshBody(`W-paid-${i}`), "203.0.113.10")).status, 200, `sale ${i}`);
    await tick();
  }
});

/** withdraw's calldata as solc's abi.encode writes it, for this test's pool and fee recipient (the proof's words are
 *  not read by the helper; the pool checks them, and the fake providers' simulation passes). */
const FEE_TO = "0x000000000000000000000000000000000000fee1";
function withdrawData(fee: bigint, nullifier: bigint, deadlineMs = NOW + 300_000): string {
  const relay = [a32("0x0000000000000000000000000000000000000a11"), a32(FEE_TO), w32(10n ** 16n), w32(BigInt(deadlineMs)), w32(1n), "c9".padEnd(64, "0")];
  const proof = Array.from({ length: 16 }, (_, i) => (i === 9 ? nullifier : BigInt(i + 1)));
  return `0x${WITHDRAW_SELECTOR}${w32(18n * 32n)}${proof.map(w32).join("")}${w32(fee)}${a32(POOL)}${w32(64n)}${w32(192n)}${relay.join("")}`;
}

test("withdraws still go while sales answer 429: the sell sender's whole budget spent refuses every sale, a client's included, and that client's withdraw is still sent from the withdraw sender", async () => {
  const worst = EVM_POOL_SELL_GAS * (2n * BASE + TIP) + L1;
  const tokenOf = (i: number) => `0x${(0x9000 + i).toString(16).padStart(40, "0")}`;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, feeRecipient: FEE_TO, receiptPollMs: 1 }, [rpc(x, { receipt: () => receiptOf("0x0", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  // the sender's whole budget: fresh Ws, each its own token, no client, every landed sale reverting
  let sent = 0;
  let last: Awaited<ReturnType<typeof s.sell>> | undefined;
  const most = Number(EVM_SELL_UNPAID_BUDGET_WEI / worst) + 3;
  for (let i = 0; i < most; i++) {
    last = await s.sell(freshBody(`W-budget-${i}`, { sell: { token: tokenOf(i) } }));
    if (last.status === 200) sent++;
    await tick();
  }
  assert.equal(BigInt(sent), EVM_SELL_UNPAID_BUDGET_WEI / worst, `${sent} sent`);
  assert.deepEqual([last!.status, code(last!)], [429, "rate_limited"]);
  assert.ok(detail(last!).includes("this sender"), detail(last!));
  assert.ok(last!.retryAfterS! >= 1 && last!.retryAfterS! <= EVM_SELL_UNPAID_WINDOW_MS / 1000);
  // a client's sale is refused too, and nothing more is sent
  const c = await s.sell(freshBody("W-budget-client", { sell: { token: tokenOf(most) } }), "203.0.113.9");
  assert.deepEqual([c.status, code(c)], [429, "rate_limited"]);
  assert.equal(sends(x).length, sent);
  // the same client's withdraw: sent to the pool, its nonce read for the withdraw sender
  const fee = evmEpochFee(1n, BASE);
  const wd = await s.carry({ pool: POOL, data: withdrawData(fee, 0x77n), epoch: NOW }, "203.0.113.9");
  assert.equal(wd.status, 200, JSON.stringify(wd.body));
  const raws = sends(x);
  assert.equal(raws.length, sent + 1);
  const last1 = unhex(raws.at(-1)!);
  assert.equal(last1[0], 2, "an EIP-1559 transaction");
  const f = dec(last1.subarray(1)) as Rlp[];
  assert.equal(`0x${hex(f[5] as Uint8Array)}`, POOL);
  const counted = x.filter((q) => q.method === "eth_getTransactionCount").map((q) => q.params[0]);
  assert.ok(counted.includes(evmAddressOf(KEY)), counted.join(","));
});

test("the sell sender: its own key and nonce lane, never the withdraw sender's; no sell key is 503 not_configured with nothing read", async () => {
  const calls: Calls = [];
  const none = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, floor: 1n }, [rpc(calls), rpc(calls)], () => NOW);
  assert.equal(none.sellSender, null);
  const a = await none.sell(body());
  assert.deepEqual([a.status, code(a)], [503, "not_configured"]);
  assert.equal(calls.length, 0);
  assert.throws(() => evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: KEY, floor: 1n }, [rpc([]), rpc([])], () => NOW), /sell key/);
  // the sale's pending nonce is read for the sell sender's address and its sim runs from it
  const x: Calls = [];
  assert.equal((await senderOf(x).sell(body())).status, 200);
  const counted = x.filter((c) => c.method === "eth_getTransactionCount").map((c) => c.params[0]);
  assert.ok(counted.includes(SENDER) && !counted.includes(evmAddressOf(KEY)), counted.join(","));
  assert.equal((x.find((c) => c.method === "eth_call" && (c.params[0] as { to: string }).to === W)!.params[0] as { from: string }).from, SENDER);
});

test("on Base, a pinned delegate's sale reads the L1 oracle on both providers", async () => {
  const kit = evmPoolVenues();
  const venues = { ...kit, base: { ...kit.base, pool: POOL, sellDelegate: DELEGATE } };
  const x: Calls = [];
    const y: Calls = [];
  const s = evmPoolSender({ network: "base", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, venues }, [rpc(x, { chain: "0x2105" }), rpc(y, { chain: "0x2105" })], () => NOW);
  const bs = { ...SELL, target: kit.base.poolManager!.toLowerCase() };
  const a = await s.sell({ pool: POOL, w: W, data: sellData(bs, FEE, sign65(W_KEY, digestOf(bs, 8453n))), authorization: authOf(W_KEY, 8453n, DELEGATE, W_NONCE) });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  for (const c of [x, y]) assert.ok(c.some((q) => q.method === "eth_call" && (q.params[0] as { to: string; data: string }).to === ORACLE && (q.params[0] as { data: string }).data.startsWith(`0x${selector("getL1FeeUpperBound(uint256)")}`)));
});

test("one provider refusing the send: the sale is sent on the other, and the next sale takes the sell sender's nonce + 1", async () => {
  const x: Calls = [];
  const s = senderOf(x, { sendFails: true }, [], {});
  const first = await s.sell(body());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const next = await s.sell(body({ sell: { nonce: 1n } }));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const raws = sends(x).map((r) => dec(unhex(r).subarray(1)) as Rlp[]);
  assert.deepEqual(raws.map((f) => num(f[1]!)), [7n, 8n]);
});

test("the deadline again after the queue's wait: a sale whose deadline came within the margin while it waited is deadline_near, nothing sent", async () => {
  let clock = NOW;
  let open: () => void = () => {};
  const gate = new Promise<void>((ok) => (open = ok));
  const x: Calls = [];
  const inner = rpc(x);
  const slow: EvmRpc = async (m, p) => (m === "eth_chainId" ? gate.then(() => inner(m, p)) : inner(m, p));
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [slow, rpc([])], () => clock);
  const first = s.sell(body({ sell: { deadline: NOW_S + 600n } }));
  const second = s.sell(body({ sell: { nonce: 1n, deadline: NOW_S + 100n } }));
  await tick();
  clock = NOW + 41_000; // the second's deadline now 59 s away
  open();
  assert.equal((await first).status, 200);
  const late = await second;
  assert.equal(code(late), "deadline_near", JSON.stringify(late.body));
  assert.equal(sends(x).length, 1);
});

// ---- Fold 2 (card helper-evm-sender): neither lane leaves a nonce no transaction holds; the shared caps hold only
// callers with no paid landing; the receipt watch backs off.

/** The nonce, recipient, fee fields, gas, value and data of a sent transaction, either type. */
const fieldsOf = (raw: string) => {
  const b = unhex(raw);
  const f = dec(b.subarray(1)) as Rlp[];
  return { type: b[0]!, nonce: num(f[1]!), tip: num(f[2]!), maxFee: num(f[3]!), gas: num(f[4]!), to: `0x${hex(f[5] as Uint8Array)}`, value: num(f[6]!), data: hex(f[7] as Uint8Array) };
};
const settle = async (until: () => boolean, most = 400) => {
  for (let i = 0; i < most && !until(); i++) await tick();
};

test("a nonce hole on the sell lane (N2): a sale dropped from both providers, the sell sender's pending count 7 throughout, is followed past the 60 s margin by the next sale at 7; within the margin the next nonce", async () => {
  let clock = NOW;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(x, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => null })], () => clock);
  const at = (label: string) => freshBody(label, { sell: { deadline: BigInt(Math.floor(clock / 1000)) + 300n } });
  assert.equal((await s.sell(at("W-n2-a"))).status, 200);
  clock = NOW + 59_000; // within the margin: the first sale may still reach a provider, so the next nonce
  assert.equal((await s.sell(at("W-n2-b"))).status, 200);
  clock = NOW + 60_000; // at the margin itself: still the next nonce
  assert.equal((await s.sell(at("W-n2-b2"))).status, 200);
  clock = NOW + 301_000; // the count has stayed at 7 past the margin and neither provider returns it: the next sale takes 7
  assert.equal((await s.sell(at("W-n2-c"))).status, 200);
  assert.equal((await s.sell(at("W-n2-d"))).status, 200); // 7 was just sent: the next nonce again
  assert.deepEqual(sends(x).map((r) => fieldsOf(r).nonce), [7n, 8n, 9n, 7n, 10n]);
  assert.ok(x.some((c) => c.method === "eth_getTransactionCount" && c.params[0] === SENDER), "the count read on A");
});

test("the sell sender's pending count is read on both providers: one provider counting the tx at 7 keeps 7 held, even with neither returning it by hash (a hole is only where both counts are below it)", async () => {
  let clock = NOW;
  const x: Calls = [];
  const y: Calls = [];
  let heldOnB = 7n;
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(x, { receipt: () => null, tx: () => null }), rpc(y, { receipt: () => null, tx: () => null, count: (t, who) => (t === "pending" && who === SENDER ? heldOnB : 7n) })], () => clock);
  assert.equal((await s.sell(freshBody("W-both-a"))).status, 200);
  heldOnB = 8n;
  clock = NOW + 120_000;
  assert.equal((await s.sell(freshBody("W-both-b", { sell: { deadline: NOW_S + 400n } }))).status, 200);
  assert.deepEqual(sends(x).map((r) => fieldsOf(r).nonce), [7n, 8n]);
  assert.ok(y.some((c) => c.method === "eth_getTransactionCount" && c.params[0] === SENDER && c.params[1] === "pending"), "the count read on B");
  // the withdraw lane alike: B holds the withdraw at 7, so the next withdraw takes 8
  clock = NOW;
  const u: Calls = [];
  const WD = evmAddressOf(KEY);
  let wdOnB = 7n;
  const t = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, floor: 1n, feeRecipient: FEE_TO }, [rpc(u, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => null, count: (at, who) => (at === "pending" && who === WD ? wdOnB : 7n) })], () => clock);
  const fee = evmEpochFee(1n, BASE);
  assert.equal((await t.carry({ pool: POOL, data: withdrawData(fee, 0x91n), epoch: NOW })).status, 200);
  wdOnB = 8n;
  clock = NOW + 120_000;
  assert.equal((await t.carry({ pool: POOL, data: withdrawData(fee, 0x92n), epoch: NOW })).status, 200);
  assert.deepEqual(sends(u).map((r) => fieldsOf(r).nonce), [7n, 8n]);
});

test("an idle hole on the sell lane: a sale dropped from both providers with no sale waiting is filled past the margin by a 0-value self-transfer at its nonce", async () => {
  let clock = NOW;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => null })], () => clock);
  assert.equal((await s.sell(body())).status, 200);
  clock = NOW + 59_000;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(sends(x).length, 1, "within the margin: nothing");
  clock = NOW + 61_000;
  await settle(() => sends(x).length > 1);
  const raws = sends(x).map(fieldsOf);
  assert.equal(raws.length, 2);
  assert.deepEqual([raws[1]!.type, raws[1]!.nonce, raws[1]!.to, raws[1]!.value, raws[1]!.data], [2, 7n, SENDER, 0n, ""]);
});

/** A lane's send stuck at 7: pending on both providers (the count at pending 8 once it is sent), never mined (latest 7,
 *  or `mined` once given or set). Past its deadline plus the 60 s margin, the watch's next read finds it still unmined;
 *  the base fee, tip and refusals are `base`, `tip` and `refuse` from then, and each of `then` moves the clock (and those)
 *  on again. `network` and `arbL1` (ArbGasInfo's estimate) for Robinhood. */
type Step = { atMs: number; base?: bigint; tip?: bigint };
const stuck = async (send: (s: ReturnType<typeof evmPoolSender>) => Promise<{ status: number; body: unknown }>, deadlineMs: number, o2: { mined?: bigint; base?: bigint; tip?: bigint; refuse?: (m: string) => boolean; network?: string; arbL1?: bigint; then?: Step[] } = {}) => {
  let clock = NOW;
  let pending = 7n;
  let mined = o2.mined ?? 7n;
  const lanes = new Set([SENDER, evmAddressOf(KEY)]); // a W's own count stays at 7: its authorization's nonce
  const count = (t: string, who: string) => (!lanes.has(who) ? 7n : t === "pending" ? pending : mined);
  const x: Calls = [];
  const o: Opts = { receipt: () => null, tx: () => ({}), count, ...(o2.arbL1 === undefined ? {} : { arbL1: o2.arbL1 }) };
  const lines: string[] = [];
  const s = evmPoolSender({ network: o2.network ?? "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, feeRecipient: FEE_TO, receiptPollMs: 1, log: (l: string) => lines.push(l) }, [rpc(x, o), rpc([], o)], () => clock);
  const first = await send(s);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const hash = (first.body as { hash: string }).hash;
  pending = 8n;
  clock = deadlineMs + 59_000; // within the margin: nothing replaced
  for (let i = 0; i < 30; i++) await tick();
  const early = sends(x).length;
  if (o2.base !== undefined) o.base = o2.base;
  if (o2.tip !== undefined) o.maxTip = o2.tip;
  if (o2.refuse !== undefined) o.refuse = o2.refuse;
  clock = deadlineMs + 60_001;
  await settle(() => sends(x).length > 1);
  const replaced = sends(x).length;
  const step = async (st: Step) => {
    if (st.base !== undefined) o.base = st.base;
    if (st.tip !== undefined) o.maxTip = st.tip;
    clock = st.atMs;
    await settle(() => false, 80);
  };
  for (const st of o2.then ?? []) await step(st);
  return { s, x, hash, early, replaced, raws: sends(x).map(fieldsOf), lines, step, setMined: (n: bigint) => (mined = n), at: () => clock, opts: o };
};
/** The tip and maxFeePerGas a replacement takes over `old`: each over the old by more than a tenth, the tip at least the
 *  providers' eth_maxPriorityFeePerGas (the mock's 1), maxFeePerGas at least 2 x the base fee + that tip. */
const raised = (old: { tip: bigint; maxFee: bigint }, base: bigint) => {
  const tip = (old.tip * 11n) / 10n + 1n > 1n ? (old.tip * 11n) / 10n + 1n : 1n;
  const floor = 2n * base + tip;
  const up = (old.maxFee * 11n) / 10n + 1n;
  return { tip, maxFee: up > floor ? up : floor };
};

test("a stuck sale on the sell lane: still pending past its deadline plus the margin with the base fee doubled, it is replaced at its own nonce by a 0-value self-transfer at 2 x the new base + tip; the base steady after, it is raised no more; one mined meanwhile is not", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  const { early, replaced, raws } = await stuck((s) => s.sell(body()), deadlineMs, { base: 2n * BASE, then: [{ atMs: deadlineMs + 200_000 }, { atMs: deadlineMs + 400_000 }] });
  assert.equal(early, 1, "nothing replaced within the margin");
  assert.equal(replaced, 2, "one replacement");
  assert.equal(raws.length, 2, "the base steady after: never raised again");
  const [sale, repl] = raws as [ReturnType<typeof fieldsOf>, ReturnType<typeof fieldsOf>];
  assert.deepEqual([sale.type, sale.nonce], [4, 7n]);
  assert.deepEqual([repl.type, repl.nonce, repl.to, repl.value, repl.data], [2, 7n, SENDER, 0n, ""], "a 0-value self-transfer at the sale's nonce");
  assert.deepEqual({ tip: repl.tip, maxFee: repl.maxFee }, raised(sale, 2n * BASE));
  assert.equal(repl.maxFee, 2n * (2n * BASE) + repl.tip, "2 x the new base + tip");
  assert.equal(repl.gas, 21_000n, "a 0-value transfer's gas on Base");
  const mined = await stuck((s) => s.sell(body()), deadlineMs, { mined: 8n, base: 2n * BASE });
  assert.equal(mined.raws.length, 1, "a sale whose nonce was mined is not replaced");
});

test("at a steady base fee, a stuck sale priced under 2 x base + tip is replaced once, at 2 x base + tip, and never raised again", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  // fee - L1 = 1.6 x 10^13: maxFeePerGas 16,000,000, over base + tip (11,000,000) but under 2 x base + tip
  const r = await stuck((s) => s.sell(body({ fee: L1 + 16n * 10n ** 12n })), deadlineMs, { then: [{ atMs: deadlineMs + 200_000 }] });
  const saleReads = () => r.x.filter((c) => c.method === "eth_getTransactionReceipt" && c.params[0] === r.hash).length;
  const readsThen = saleReads();
  await r.step({ atMs: deadlineMs + 400_000 });
  assert.equal(saleReads(), readsThen, "the sale's watch ended when the replacement took its nonce");
  const [sale, repl] = r.raws as [ReturnType<typeof fieldsOf>, ReturnType<typeof fieldsOf>];
  // the providers' tip now the replacement's own: 2 x base + tip is exactly its maxFeePerGas, which it covers
  await r.step({ atMs: deadlineMs + 500_000, tip: repl.tip });
  assert.equal(r.replaced, 2, "one replacement");
  assert.equal(sends(r.x).length, 2, "never raised again at the same base fee, nor at a price it covers exactly");
  assert.equal(sale.maxFee, 16_000_000n);
  assert.deepEqual({ tip: repl.tip, maxFee: repl.maxFee }, raised(sale, BASE));
  assert.equal(repl.maxFee, 2n * BASE + repl.tip);
});

test("a base fee whose 2 x base + tip is over EVM_SELL_MAX_FEE_PER_GAS replaces nothing, and the lane logs it once", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  const ceiling = EVM_SELL_UNPAID_CAP_WEI / EVM_POOL_SELL_GAS; // 1 gwei: one sale's worst gas at it is a whole W's unpaid cap
  const { replaced, raws, lines } = await stuck((s) => s.sell(body()), deadlineMs, { base: ceiling / 2n + 1n, then: [{ atMs: deadlineMs + 200_000 }] });
  assert.equal(replaced, 1, "nothing replaced over the ceiling");
  assert.equal(raws.length, 1);
  assert.equal(EVM_SELL_MAX_FEE_PER_GAS, ceiling);
  const said = lines.filter((l) => l.includes("EVM_SELL_MAX_FEE_PER_GAS"));
  assert.equal(said.length, 1, `logged once: ${lines.join(" | ")}`);
});

test("a nonce hole on the withdraw lane: a withdraw dropped from both providers, the withdraw sender's pending count 7 throughout, is followed past the margin by the next withdraw at 7", async () => {
  let clock = NOW;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, feeRecipient: FEE_TO }, [rpc(x, { receipt: () => null, tx: () => null }), rpc([], { receipt: () => null, tx: () => null })], () => clock);
  const fee = evmEpochFee(1n, BASE);
  const carry = (nf: bigint) => s.carry({ pool: POOL, data: withdrawData(fee, nf), epoch: NOW });
  assert.equal((await carry(0x71n)).status, 200);
  clock = NOW + 59_000;
  assert.equal((await carry(0x72n)).status, 200);
  clock = NOW + 61_000;
  assert.equal((await carry(0x73n)).status, 200);
  assert.deepEqual(sends(x).map((r) => fieldsOf(r).nonce), [7n, 8n, 7n]);
});

test("a stuck withdraw on the withdraw lane: still pending past its deadline plus the margin with the base fee doubled, it is replaced at its own nonce by a 0-value self-transfer from the withdraw sender at 2 x the new base + tip, raised no more after; one mined meanwhile is not", async () => {
  const fee = evmEpochFee(1n, BASE);
  const deadlineMs = NOW + 300_000; // withdrawData's
  const { early, replaced, raws } = await stuck((s) => s.carry({ pool: POOL, data: withdrawData(fee, 0x81n), epoch: NOW }), deadlineMs, { base: 2n * BASE, then: [{ atMs: deadlineMs + 200_000 }] });
  assert.equal(early, 1, "nothing replaced within the margin");
  assert.equal(replaced, 2, "one replacement");
  assert.equal(raws.length, 2, "the base steady after: never raised again");
  const [wd, repl] = raws as [ReturnType<typeof fieldsOf>, ReturnType<typeof fieldsOf>];
  assert.deepEqual([wd.type, wd.nonce, wd.to], [2, 7n, POOL]);
  assert.deepEqual([repl.type, repl.nonce, repl.to, repl.value, repl.data], [2, 7n, evmAddressOf(KEY), 0n, ""]);
  assert.deepEqual({ tip: repl.tip, maxFee: repl.maxFee }, raised(wd, 2n * BASE));
  assert.equal(repl.maxFee, 2n * (2n * BASE) + repl.tip, "2 x the new base + tip");
  const mined = await stuck((s) => s.carry({ pool: POOL, data: withdrawData(fee, 0x82n), epoch: NOW }), deadlineMs, { mined: 8n, base: 2n * BASE });
  assert.equal(mined.raws.length, 1);
});

test("a stuck sale that covers 2 x base + tip is still replaced once past its deadline plus the margin; its replacement is raised again only once the base fee rises past it", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  const { replaced, raws } = await stuck((s) => s.sell(body()), deadlineMs, { then: [{ atMs: deadlineMs + 200_000 }, { atMs: deadlineMs + 400_000, base: 2n * BASE }] });
  assert.equal(replaced, 2, "replaced once whatever its price");
  assert.equal(raws.length, 3, "raised once the base rose past the replacement");
  assert.equal(raws[2]!.maxFee, 2n * (2n * BASE) + raws[2]!.tip);
  assert.deepEqual(raws.map((t) => t.nonce), [7n, 7n, 7n]);
});

test("at exactly EVM_SELL_MAX_FEE_PER_GAS a replacement goes (the withdraw lane: tip 2, 2 x 499,999,999 + 2 = 1 gwei)", async () => {
  const fee = evmEpochFee(1n, BASE);
  const { replaced, raws } = await stuck((s) => s.carry({ pool: POOL, data: withdrawData(fee, 0x83n), epoch: NOW }), NOW + 300_000, { base: 499_999_999n });
  assert.equal(replaced, 2);
  assert.deepEqual([raws[1]!.tip, raws[1]!.maxFee], [2n, EVM_SELL_UNPAID_CAP_WEI / EVM_POOL_SELL_GAS]);
});

test("a lane's watch ends at its bound with one log line; while the lowest unmined send is past it, new sends answer 503 with Retry-After; once both providers' latest counts pass it, sends go again", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  const ceiling = EVM_SELL_UNPAID_CAP_WEI / EVM_POOL_SELL_GAS;
  const r = await stuck((s) => s.sell(body()), deadlineMs, { base: ceiling / 2n + 1n }); // nothing can replace it
  assert.equal(r.replaced, 1);
  await r.step({ atMs: deadlineMs + 60_000 + 600_001, base: BASE + 0n });
  assert.equal(r.lines.filter((l) => l.includes("unmined past its watch")).length, 1, `one line: ${r.lines.join(" | ")}`);
  await r.step({ atMs: deadlineMs + 60_000 + 700_000 });
  assert.equal(r.lines.filter((l) => l.includes("unmined past its watch")).length, 1, "the watch has ended");
  const sent = sends(r.x).length;
  const held = await r.s.sell(freshBody("W-behind", { sell: { deadline: BigInt(Math.floor(r.at() / 1000)) + 300n } }));
  assert.deepEqual([held.status, code(held), held.retryAfterS], [503, "upstream", 60], JSON.stringify(held.body));
  assert.equal(sends(r.x).length, sent, "nothing sent behind it");
  r.setMined(8n); // both providers' latest counts pass 7
  const next = await r.s.sell(freshBody("W-after", { sell: { deadline: BigInt(Math.floor(r.at() / 1000)) + 300n } }));
  assert.equal(next.status, 200, JSON.stringify(next.body));
});

test("a tend that fails logs once and sends nothing: a provider refusing eth_maxPriorityFeePerGas, or both refusing the replacement; a refused replacement is never recorded as sent, and goes once the providers answer", async () => {
  const deadlineMs = Number(SELL.deadline) * 1000;
  for (const [name, refuse] of [["a refused read", (m: string) => m === "eth_maxPriorityFeePerGas"], ["a refused replacement", (m: string) => m === "eth_sendRawTransaction"]] as const) {
    const r = await stuck((s) => s.sell(body()), deadlineMs, { base: 2n * BASE, refuse, then: [{ atMs: deadlineMs + 200_000 }] });
    assert.equal(r.lines.filter((l) => l.includes("tend failed")).length, 1, `${name}: one line: ${r.lines.join(" | ")}`);
    const sale = fieldsOf(sends(r.x)[0]!);
    r.opts.refuse = undefined;
    await r.step({ atMs: deadlineMs + 300_000 });
    // every raw a provider was asked to take: the refused ones too
    const raws = sends(r.x).map(fieldsOf);
    const went = raws.slice(1).at(-1)!;
    assert.deepEqual([went.type, went.nonce], [2, 7n], `${name}: the replacement goes once the providers answer`);
    assert.deepEqual({ tip: went.tip, maxFee: went.maxFee }, raised(sale, 2n * BASE), `${name}: raised over the sale, not over a refused replacement`);
  }
});

test("the replacement's gas on Robinhood: 21,000 + the L1 poster's gas (the kit's ArbGasInfo chain fee, the higher, over the lower base fee) + a fifth", async () => {
  const fee = evmEpochFee(1n, BASE);
  const E = 2_000_000n; // ArbGasInfo's L1 base fee estimate
  const r = await stuck((s) => s.carry({ pool: POOL, data: withdrawData(fee, 0x84n), epoch: NOW }), NOW + 300_000, { network: "robinhood-testnet", arbL1: E, base: 2n * BASE });
  const repl = r.raws[1]!;
  const txBytes = BigInt(evmTx4MaxLength({ chainId: CHAIN_ID, nonce: 7n, maxPriorityFeePerGas: repl.tip, maxFeePerGas: repl.maxFee, gas: 1n << 32n, to: evmAddressOf(KEY), data: new Uint8Array(), authorizations: [] }));
  const l1 = evmPoolChainFee("robinhood-testnet", txBytes, [E]);
  const poster = (l1 + 2n * BASE - 1n) / (2n * BASE);
  assert.ok(poster > 0n);
  assert.equal(repl.gas, 21_000n + poster + (poster + 4n) / 5n);
});

test("one provider's count never moves a lane (Q2-A): B answering the sell sender's counts 1,000 high, sales go at 7, 8, 9 and the one replacement at 7, none at 1007; one high answer then honest, the next sale is 8", async () => {
  let clock = NOW;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, { receipt: () => null, tx: () => ({}), count: (t, who) => (who === SENDER && t === "pending" ? 7n + BigInt(sends(x).length) : 7n) }), rpc([], { receipt: () => null, tx: () => ({}), count: (_t, who) => (who === SENDER ? 1007n : 7n) })], () => clock);
  for (let i = 0; i < 3; i++) assert.equal((await s.sell(freshBody(`W-q2a-${i}`))).status, 200);
  clock = Number(SELL.deadline) * 1000 + 60_001;
  await settle(() => sends(x).length > 3);
  for (const at of [200_000, 400_000]) {
    clock = Number(SELL.deadline) * 1000 + at;
    await settle(() => false, 60);
  }
  assert.deepEqual(sends(x).map(fieldsOf).map((f) => [f.type, f.nonce]), [[4, 7n], [4, 8n], [4, 9n], [2, 7n]]);
  // Q2-B: one high answer, then honest
  const y: Calls = [];
  let high = true;
  const pendingY = (t: string, who: string, lie: boolean) => (who === SENDER && t === "pending" ? (lie && high ? 1007n : 7n + BigInt(sends(y).length)) : 7n);
  const u = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n }, [rpc(y, { receipt: () => null, tx: () => ({}), count: (t, who) => pendingY(t, who, false) }), rpc([], { receipt: () => null, tx: () => ({}), count: (t, who) => pendingY(t, who, true) })], () => NOW);
  assert.equal((await u.sell(freshBody("W-q2b-0"))).status, 200);
  high = false;
  assert.equal((await u.sell(freshBody("W-q2b-1"))).status, 200);
  assert.deepEqual(sends(y).map((r) => fieldsOf(r).nonce), [7n, 8n]);
});

test("a sale one provider's stale pool still counts (Q5): its fee covers 2 x base + tip, yet past its deadline plus the margin it is replaced once at 7, and the sales behind it are left to mine", async () => {
  let clock = NOW;
  const x: Calls = [];
  const fee5 = 5n * 10n ** 13n;
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, { receipt: () => null, tx: () => ({}), count: (t, who) => (who === SENDER && t === "pending" ? 7n + BigInt(sends(x).length) : 7n) }), rpc([], { receipt: () => null, tx: () => null })], () => clock);
  for (let i = 0; i < 3; i++) assert.equal((await s.sell(freshBody(`W-q5-${i}`, { sell: { feeCap: fee5 }, fee: fee5 }))).status, 200);
  clock = Number(SELL.deadline) * 1000 + 60_001;
  await settle(() => sends(x).length > 3);
  for (const at of [200_000, 400_000, 600_000]) {
    clock = Number(SELL.deadline) * 1000 + at;
    await settle(() => false, 60);
  }
  const t = sends(x).map(fieldsOf);
  assert.deepEqual(t.map((f) => [f.type, f.nonce]), [[4, 7n], [4, 8n], [4, 9n], [2, 7n]]);
  assert.ok(t[0]!.maxFee >= 2n * BASE + 1n, "the sale covered 2 x base + tip");
});

test("a hole is only where neither provider returns the lane's send by hash (Q1): both counts missing a live sale at 61 s, no self-transfer goes, and the next sale takes 8", async () => {
  let clock = NOW;
  const x: Calls = [];
  const live: Opts = { receipt: () => null, tx: () => ({}) };
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, live), rpc([], live)], () => clock);
  assert.equal((await s.sell(body())).status, 200);
  clock = NOW + 61_000;
  await settle(() => false, 60);
  assert.equal(sends(x).length, 1, "Q1-A: no self-transfer at the live sale's nonce");
  assert.equal((await s.sell(freshBody("W-q1b", { sell: { deadline: NOW_S + 361n } }))).status, 200);
  assert.deepEqual(sends(x).map((r) => fieldsOf(r).nonce), [7n, 8n], "Q1-B");
});

test("a withdraw repeat after its first send was dropped (no receipt and no tx on either provider past its deadline plus the margin) is sent again; until then it gets the first hash", async () => {
  let clock = NOW;
  const x: Calls = [];
  const gone: Opts = { receipt: () => null, tx: () => null };
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, floor: 1n, feeRecipient: FEE_TO }, [rpc(x, gone), rpc([], gone)], () => clock);
  const fee = evmEpochFee(1n, BASE);
  const first = await s.carry({ pool: POOL, data: withdrawData(fee, 0x85n), epoch: NOW });
  assert.equal(first.status, 200);
  clock = NOW + 300_000 + 60_000; // at the deadline plus the margin: still the first hash
  assert.deepEqual(await s.carry({ pool: POOL, data: withdrawData(fee, 0x85n, NOW + 500_000), epoch: NOW }), first);
  clock = NOW + 300_000 + 60_001;
  const again = await s.carry({ pool: POOL, data: withdrawData(fee, 0x85n, NOW + 500_000), epoch: NOW });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notDeepEqual(again, first);
  assert.equal(sends(x).length, 2);
});

test("a withdraw repeat whose first send the lane's replacement took the nonce of is sent again, though both providers still return that send; a repeat before it gets the first hash", async () => {
  const fee = evmEpochFee(1n, BASE);
  const deadlineMs = NOW + 300_000; // withdrawData's
  const data = withdrawData(fee, 0x86n, NOW + 500_000);
  let before: Awaited<ReturnType<ReturnType<typeof evmPoolSender>["carry"]>> | undefined;
  const r = await stuck(async (s) => {
    const first = await s.carry({ pool: POOL, data: withdrawData(fee, 0x86n), epoch: NOW });
    before = await s.carry({ pool: POOL, data, epoch: NOW }); // in flight: the first hash
    return first;
  }, deadlineMs, { base: 2n * BASE });
  assert.equal((before!.body as { hash: string }).hash, r.hash);
  assert.equal(r.replaced, 2, "the lane's replacement at 7");
  const again = await r.s.carry({ pool: POOL, data, epoch: NOW });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.notEqual((again.body as { hash: string }).hash, r.hash);
  assert.equal(sends(r.x).length, 3, "the withdraw sent again");
});

test("the sender's whole budget holds every sale (H1): 20 clients, each with one paid landing, then their reverting sales from fresh Ws and tokens stop at EVM_SELL_UNPAID_BUDGET_WEI with 429 and its wait", async () => {
  let landing = true;
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc([], { receipt: () => receiptOf(landing ? "0x1" : "0x0", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  const K = 20;
  for (let c = 0; c < K; c++) {
    assert.equal((await s.sell(freshBody(`W-h1-paid-${c}`, { sell: { token: `0x${(0xc000 + c).toString(16).padStart(40, "0")}` } }), `198.51.100.${c + 1}`)).status, 200);
    await tick();
  }
  await settle(() => false, 4);
  landing = false;
  const cost = EVM_POOL_SELL_GAS * (2n * BASE + TIP) + L1;
  let reverts = 0n;
  let last: Awaited<ReturnType<typeof s.sell>> | undefined;
  for (let c = 0; c < K; c++) {
    let streak = 0;
    for (let i = 0; i < 200 && streak < 3; i++) {
      last = await s.sell(freshBody(`W-h1-r-${c}-${i}`, { sell: { token: `0x${(0x200000 + c * 1000 + i).toString(16).padStart(40, "0")}` } }), `198.51.100.${c + 1}`);
      if (last.status === 200) reverts++;
      streak = last.status === 200 ? 0 : streak + 1;
      await tick();
    }
  }
  assert.ok(reverts * cost <= EVM_SELL_UNPAID_BUDGET_WEI, `${reverts} reverting sales, ${reverts * cost} wei unpaid, over the budget ${EVM_SELL_UNPAID_BUDGET_WEI}`);
  assert.deepEqual([last!.status, code(last!)], [429, "rate_limited"]);
  assert.ok(detail(last!).includes("this sender"), detail(last!));
  assert.ok(last!.retryAfterS! >= 1 && last!.retryAfterS! <= EVM_SELL_UNPAID_WINDOW_MS / 1000);
});

test("a paid landing is one in the window that paid its cost: one older than the window, or one whose cost passed its fee, never frees a caller of the token's cap", async () => {
  for (const [name, later, gasUsed] of [["older than the window", EVM_SELL_UNPAID_WINDOW_MS + 1_000, 1_000_000n], ["its cost over its fee", 0, 2_000_000n]] as const) {
    let clock = NOW;
    let landing = true;
    const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc([], { receipt: () => (landing ? receiptOf("0x1", { l1Fee: L1, gasUsed }) : receiptOf("0x0", { l1Fee: L1 })) }), rpc([], { receipt: () => null })], () => clock);
    assert.equal((await s.sell(freshBody("W-pl-0", { sell: { token: "0x00000000000000000000000000000000000d0d00" } }), "192.0.2.5")).status, 200);
    await settle(() => false, 4);
    landing = false;
    clock = NOW + later;
    const T = "0x00000000000000000000000000000000000d0d01";
    const dl = () => BigInt(Math.floor(clock / 1000)) + 300n;
    for (let i = 0; i < 60; i++) {
      await s.sell(freshBody(`W-pl-t-${i}`, { sell: { token: T, deadline: dl() } }), `198.51.100.${i}`);
      await tick();
    }
    const again = await s.sell(freshBody("W-pl-1", { sell: { token: T, deadline: dl() } }), "192.0.2.5");
    assert.deepEqual([again.status, code(again)], [429, "rate_limited"], `${name}: ${JSON.stringify(again.body)}`);
    assert.ok(detail(again).includes("this token"), `${name}: ${detail(again)}`);
  }
});

test("a paid landing frees its caller of the token's cap only: strangers' reverting sales spend a token's cap; a W or client whose sale landed and paid still sells that token, a new caller is refused, and the caller's own cap still holds", async () => {
  const tokenOf = (i: number) => `0x${(0xb000 + i).toString(16).padStart(40, "0")}`;
  let landing = true;
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 1 }, [rpc(x, { receipt: () => receiptOf(landing ? "0x1" : "0x0", { l1Fee: L1 }) }), rpc([], { receipt: () => null })], () => NOW);
  // the honest client and W: one sale that landed and paid
  const W0 = "W-honest-0";
  assert.equal((await s.sell(freshBody(W0, { sell: { token: tokenOf(9999) } }), "192.0.2.1")).status, 200);
  await settle(() => false, 4);
  landing = false;
  // a token's cap: strangers, each their own client and W, all on token T, every sale reverting
  const T = tokenOf(5000);
  for (let i = 0; i < 60; i++) {
    await s.sell(freshBody(`W-t-${i}`, { sell: { token: T } }), `198.51.100.${i}`);
    await tick();
  }
  const newOnT = await s.sell(freshBody("W-t-new", { sell: { token: T } }), "198.51.100.250");
  assert.deepEqual([newOnT.status, code(newOnT)], [429, "rate_limited"]);
  assert.ok(detail(newOnT).includes("this token"), detail(newOnT));
  const honestOnT = await s.sell(freshBody("W-honest-1", { sell: { token: T } }), "192.0.2.1");
  assert.equal(honestOnT.status, 200, `the client with a paid landing, on the spent token: ${JSON.stringify(honestOnT.body)}`);
  await tick();
  // W itself with a paid landing, from a new client, on the spent token
  const byW = await s.sell(freshBody(W0, { sell: { token: T, nonce: 1n } }), "192.0.2.88");
  assert.equal(byW.status, 200, `the W with a paid landing, a new client: ${JSON.stringify(byW.body)}`);
  await tick();
  // a paid landing never lifts the caller's own cap: the honest client's reverting sales stop at its own
  let own: Awaited<ReturnType<typeof s.sell>> | undefined;
  for (let i = 0; i < 60 && own?.status !== 429; i++) {
    own = await s.sell(freshBody(`W-honest-r-${i}`, { sell: { token: tokenOf(6000 + i) } }), "192.0.2.1");
    await tick();
  }
  assert.deepEqual([own!.status, code(own!)], [429, "rate_limited"]);
  assert.ok(detail(own!).includes("this client"), detail(own!));
});

test("the receipt watch backs off: from the poll interval, doubling, to 15 times it (2 s to 30 s), not a read every interval", async () => {
  const x: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, sellKey: SELL_KEY, floor: 1n, receiptPollMs: 4 }, [rpc(x, { receipt: () => null, tx: () => ({}) }), rpc([], { receipt: () => null })], () => NOW);
  assert.equal((await s.sell(body())).status, 200);
  await new Promise((ok) => setTimeout(ok, 400));
  // 4, 8, 16, 32, then 60 each: about 9 reads in 400 ms; one read every 4 ms would be about 100
  const n = reads(x, "eth_getTransactionReceipt");
  assert.ok(n >= 4 && n <= 14, `${n} receipt reads in 400 ms`);
});
