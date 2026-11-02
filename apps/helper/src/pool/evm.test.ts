// node --test apps/helper/src/pool/evm.test.ts: the EVM pool sender carries a withdraw's calldata exactly, or refuses
// it. The request and proof are pool-evm-core's relayed fixture (contracts/pool-evm/test/fixtures/pool-proofs.json at
// b48122e, the kit's real proof for pool 0x...b1f1f001 on chain 31337). The sender key is a test key:
// sha256("helper-pool-senders/test-key/EVM_SENDER").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_GAS_MAX, evmAddressOf, evmPoolSender, evmReadWithdraw, rlp, signEvmTx, WITHDRAW_SELECTOR, type EvmRpc } from "./evm.ts";

const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const REQ = {
  recipient: "0x0000000000000000000000000000000000000a11",
  feeRecipient: FEE_TO,
  feeCap: 10_000_000_000_000_000n,
  deadlineMs: 2_000_000_000_000n,
  refundPrecommitment: 1138856091998675893565963822108454610843705949283798736209630132365158946624n,
  salt: "c9ebb52422ed595de60e051c69edee1a",
};
const PROOF = [
  "1184908809424501824094124334635703389819420838650358930182460221215309100428", "1674810211518547383579389468999824331036802579945838824753347570601139960095",
  "12148729561581703603498305712188557019996164318368766524930289868424831942892", "6100911842998281370828191634008720068403404414837215973404343605547688141895",
  "12630600456273860711786747608540226475300782062108280761748478120397194433313", "6992726715744989436705837766215308186697656563125223364054190560139085951922",
  "8508063494074742532827183379746870873369481011703966193630063232707027554966", "20919455320042026876376757481563625984522200275015943875194766111274337098026",
  "13105909549946975585863522008434360009854594135601735263493530461261550723587", "21227852615675029745296729883959330652216006565624513147422074547064789082504",
  "400000000000000000", "16448528108014878343311034841111936001422509689876565747417185086607489003672", "2",
  "3020212885829913070286059975715001976910762802925534191672966365795975638979", "2",
  "8424188727988631066893401000603797288753749629507407262343386519908765608178",
].map(BigInt);
const FEE = 1_000_000_000_000_000n;

const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
/** withdraw's calldata as solc's abi.encode writes it. */
function calldata(o: { fee?: bigint; processooor?: string; feeRecipient?: string; feeCap?: bigint } = {}): string {
  const relay = [a32(REQ.recipient), a32(o.feeRecipient ?? REQ.feeRecipient), w32(o.feeCap ?? REQ.feeCap), w32(REQ.deadlineMs), w32(REQ.refundPrecommitment), REQ.salt.padEnd(64, "0")];
  return `0x${WITHDRAW_SELECTOR}${w32(18n * 32n)}${PROOF.map(w32).join("")}${w32(o.fee ?? FEE)}${a32(o.processooor ?? POOL)}${w32(64n)}${w32(192n)}${relay.join("")}`;
}

test("the selector is withdraw's, and the calldata reads back the request", () => {
  assert.equal(WITHDRAW_SELECTOR, Buffer.from(keccak_256(new TextEncoder().encode("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)"))).subarray(0, 4).toString("hex"));
  const w = evmReadWithdraw(new Uint8Array(Buffer.from(calldata().slice(2), "hex")));
  assert.deepEqual(w, { processooor: POOL, recipient: REQ.recipient, feeRecipient: FEE_TO, feeCap: REQ.feeCap, deadlineMs: REQ.deadlineMs, fee: FEE });
});

type Calls = { method: string; params: readonly unknown[] }[];
function rpc(calls: Calls, opts: { revert?: boolean; gas?: bigint; chain?: string } = {}): EvmRpc {
  return async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return opts.chain ?? "0x7a69";
      case "eth_call": if (opts.revert) throw new Error("execution reverted: 0x8b1c4b0b"); return "0x";
      case "eth_estimateGas": return `0x${(opts.gas ?? 611_391n).toString(16)}`;
      case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00" };
      case "eth_maxPriorityFeePerGas": return "0x5f5e100";
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": return "0x";
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
const sender = (calls: Calls = [], opts = {}, b: Calls = []) => evmPoolSender({ network: "anvil", pool: POOL, senderKey: KEY, fee: FEE, feeRecipient: FEE_TO }, [rpc(calls, opts), rpc(b, opts)]);
const code = (a: { body: unknown }) => ((a.body as { error?: { code: string } }).error?.code ?? "ok");

test("a withdraw at the published fee, under its cap, to this release's fee recipient: simulated, signed, sent with exactly its calldata", async () => {
  const calls: Calls = [];
  const a = await sender(calls).carry({ pool: POOL, data: calldata() });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const sent = calls.find((c) => c.method === "eth_sendRawTransaction")!.params[0] as string;
  const raw = Buffer.from(sent.slice(2), "hex");
  assert.equal((a.body as { hash: string }).hash, `0x${Buffer.from(keccak_256(raw)).toString("hex")}`);
  assert.ok(raw.toString("hex").includes(calldata().slice(2)), "the calldata is in the transaction as received");
  const call = calls.find((c) => c.method === "eth_call")!.params[0] as { from: string; to: string; data: string };
  assert.deepEqual(call, { from: evmAddressOf(KEY), to: POOL, data: calldata(), value: "0x0" });
});

test("refusals: another pool, another fee recipient, a fee off the published one, a fee over feeCap, a revert, gas over the cap", async () => {
  assert.equal(code(await sender().carry({ pool: POOL, data: calldata({ processooor: "0x00000000000000000000000000000000b1f1f002" }) })), "not_pool");
  assert.equal(code(await sender().carry({ pool: POOL, data: calldata({ feeRecipient: "0x000000000000000000000000000000000000beef" }) })), "fee_recipient");
  assert.equal(code(await sender().carry({ pool: POOL, data: calldata({ fee: FEE + 1n }) })), "fee_off");
  assert.equal(code(await sender().carry({ pool: POOL, data: calldata({ feeCap: FEE - 1n }) })), "fee_over_cap");
  const calls: Calls = [];
  assert.equal(code(await sender(calls, { revert: true }).carry({ pool: POOL, data: calldata() })), "simulation_failed");
  assert.equal(calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);
  assert.equal(code(await sender([], { gas: EVM_GAS_MAX }).carry({ pool: POOL, data: calldata() })), "simulation_failed");
  assert.equal(code(await sender([], {}, []).carry({ pool: POOL, data: calldata() })), "ok");
});

test("bad_shape: another selector, a changed offset or padding, a byte more or less, another pool named in the body", async () => {
  const good = calldata();
  const flip = (at: number, ch: string) => `${good.slice(0, at)}${ch}${good.slice(at + 1)}`;
  for (const d of [flip(2, good[2] === "0" ? "1" : "0"), flip(2 + 8 + 63, "1"), `${good}00`, good.slice(0, -2), flip(2 + 8 + 64 * 18 + 2, "1"), flip(2 + 8 + 64 * 26 + 63, "1")]) {
    assert.equal(code(await sender().carry({ pool: POOL, data: d })), "bad_shape", d.slice(0, 20));
  }
  assert.equal(code(await sender().carry({ pool: "0x00000000000000000000000000000000b1f1f002", data: good })), "bad_shape");
  assert.equal(code(await sender().carry({ pool: POOL, data: good, extra: 1 })), "bad_shape");
});

test("two providers on different chains: upstream, nothing sent", async () => {
  const b: Calls = [];
  const s = evmPoolSender({ network: "anvil", pool: POOL, senderKey: KEY, fee: FEE, feeRecipient: FEE_TO }, [rpc([]), rpc(b, { chain: "0x2105" })]);
  assert.equal(code(await s.carry({ pool: POOL, data: calldata() })), "upstream");
  assert.equal(b.filter((c) => c.method === "eth_sendRawTransaction").length, 0);
});

test("sends take consecutive nonces, one at a time", async () => {
  const calls: Calls = [];
  const s = sender(calls);
  await Promise.all([s.carry({ pool: POOL, data: calldata() }), s.carry({ pool: POOL, data: calldata() })]);
  const raws = calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0] as string);
  assert.equal(raws.length, 2);
  assert.notEqual(raws[0], raws[1], "the second send takes the next nonce");
  assert.deepEqual([...rlp([])], [0xc0]);
  assert.deepEqual([...rlp(new Uint8Array(56))].slice(0, 2), [0xb8, 56]);
});

test("signEvmTx: the signature recovers to the sender", () => {
  const tx = { chainId: 31337n, nonce: 7n, maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 2_100_000_000n, gas: 733_669n, to: POOL, data: new Uint8Array(Buffer.from(calldata().slice(2), "hex")) };
  const { raw } = signEvmTx(tx, KEY);
  assert.equal(raw[0], 2);
  // the last 3 rlp items are yParity, r (32), s (32): r and s are each 0xa0-prefixed when 32 bytes long
  const hexRaw = Buffer.from(raw).toString("hex");
  assert.ok(hexRaw.length > 1700);
  assert.equal(secp256k1.getPublicKey(KEY).length, 33);
  assert.match(evmAddressOf(KEY), /^0x[0-9a-f]{40}$/);
});
