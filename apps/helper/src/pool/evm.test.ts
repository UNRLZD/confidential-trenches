// node --test apps/helper/src/pool/evm.test.ts: the EVM pool sender carries a withdraw's calldata exactly, or refuses
// it. The request and proof are pool-evm-core's relayed fixture (contracts/pool-evm/test/fixtures/pool-proofs.json at
// b48122e, the kit's real proof for pool 0x...b1f1f001 on chain 31337). The sender key is a test key:
// sha256("helper-pool-senders/test-key/EVM_SENDER").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createServer } from "node:http";
import { evmPoolFee, evmPoolGas, evmPoolVenues } from "@blindfill/kit";
import { EVM_FEE_STEP, EVM_GAS_MAX, evmAddressOf, evmFirstBlockAtOrAfter, evmPoolSender, evmPoolSendersFromEnv, evmReadWithdraw, POOL_LIFE_MAX_MS, rlp, signEvmTx, WITHDRAW_SELECTOR, type EvmRpc } from "./evm.ts";

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

// ---- a chain: block n at 1,999,999,000 + 2n seconds, 1 gwei base fee unless `base` says otherwise ----
const T0 = 1_999_999_000n;
const DEADLINE = Number(REQ.deadlineMs); // 2,000,000,000,000
const NOW = DEADLINE - 100_000; // the epoch now starts at 1,999,999,860,000
const EPOCH = 1_999_999_860_000;
const GWEI = 1_000_000_000n;
/** The kit's EVM_POOL_FEE_FLOOR, one step (packages/kit/test/evm-pool-fee.test.ts holds it). */
const EVM_POOL_FEE_FLOOR = 10n ** 13n;
type Chain = { latest: bigint; base: (n: bigint) => bigint; hash?: (n: bigint) => string };
const chainOf = (o: Partial<Chain> = {}): Chain => ({ latest: 600n, base: () => GWEI, ...o });
/** The epoch's fee at `gasPrice`: the kit's rule at the pool's depth (2) and the chain fee (7,917 wei) the mock answers. */
const feeAt = (gasPrice: bigint) => evmPoolFee({ gas: evmPoolGas(2), gasPrice, chainFee: 7_917n });
const FEE = feeAt(GWEI);
/** The fee's reads at a block's hash (EIP-1898): the pool's tree depth, 2, and the chain fee oracle, Base Sepolia's L1
 *  fee for 2,600 bytes (7,917 wei, 4 Nov) and no operator fee, as the kit's evmPoolChainFeeReads ask. */
const feeRead = (to: string, data: string): string => `0x${(to === "0x420000000000000000000000000000000000000f" ? (data.startsWith("0xf1c7a58b") ? 7_917n : 0n) : data === DEPTH_DATA ? 2n : 0n).toString(16).padStart(64, "0")}`;
const DEPTH_DATA = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;


const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
/** withdraw's calldata as solc's abi.encode writes it. */
function calldata(o: { fee?: bigint; processooor?: string; feeRecipient?: string; feeCap?: bigint; nullifier?: bigint; refund?: bigint } = {}): string {
  const relay = [a32(REQ.recipient), a32(o.feeRecipient ?? REQ.feeRecipient), w32(o.feeCap ?? REQ.feeCap), w32(REQ.deadlineMs), w32(o.refund ?? REQ.refundPrecommitment), REQ.salt.padEnd(64, "0")];
  const proof = PROOF.map((v, i) => (i === 9 && o.nullifier !== undefined ? o.nullifier : v));
  return `0x${WITHDRAW_SELECTOR}${w32(18n * 32n)}${proof.map(w32).join("")}${w32(o.fee ?? FEE)}${a32(o.processooor ?? POOL)}${w32(64n)}${w32(192n)}${relay.join("")}`;
}

type Calls = { method: string; params: readonly unknown[] }[];
function rpc(calls: Calls, opts: { revert?: boolean; gas?: bigint; chain?: string; spike?: bigint; reverted?: boolean } = {}, c: Chain = chainOf()): EvmRpc {
  const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + 2n * n).toString(16)}`, hash: c.hash ? c.hash(n) : `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: `0x${c.base(n).toString(16)}` });
  return async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId": return opts.chain ?? "0x7a69";
      case "eth_getCode": return "0x";
      case "eth_call": {
        const [{ to, data }, at] = params as [{ to: string; data: string }, unknown];
        if (typeof at === "object" && at !== null && "blockHash" in at) return feeRead(to, data);
        if (opts.revert) throw new Error("RPC error 3: execution reverted: 0x8b1c4b0b"); // the kit client's wording
        return "0x";
      }
      case "eth_estimateGas": return `0x${(opts.gas ?? 611_391n).toString(16)}`;
      case "eth_getBlockByNumber": {
        if (params[0] === "latest") return { ...block(c.latest), ...(opts.spike ? { baseFeePerGas: `0x${opts.spike.toString(16)}` } : {}) };
        const n = BigInt(params[0] as string);
        return n <= c.latest ? block(n) : null;
      }
      case "eth_maxPriorityFeePerGas": return "0x5f5e100";
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": return "0x";
      case "eth_getTransactionReceipt": return { status: opts.reverted ? "0x0" : "0x1" };
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
const sender = (calls: Calls = [], opts = {}, b: Calls = [], c: Chain = chainOf(), now = NOW) =>
  evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [rpc(calls, opts, c), rpc(b, opts, c)], () => now);
const code = (a: { body: unknown }) => ((a.body as { error?: { code: string } }).error?.code ?? "ok");
const req = (data = calldata(), epoch = EPOCH) => ({ pool: POOL, data, epoch });
const sends = (calls: Calls) => calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => c.params[0] as string);

/** A type-2 transaction's fields: rlp([chainId, nonce, tip, maxFee, gas, to, value, data, accessList, v, r, s]). */
function decodeTx(raw: string): Uint8Array[] {
  const b = Buffer.from(raw.slice(2), "hex");
  assert.equal(b[0], 2);
  let at = 1;
  const len = (short: number) => {
    const x = b[at++]!;
    if (x < short + 56) return x - short;
    const n = x - short - 55;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + b[at++]!;
    return v;
  };
  assert.ok(b[at]! >= 0xc0);
  const end = len(0xc0) + at;
  const out: Uint8Array[] = [];
  while (at < end) {
    if (b[at]! < 0x80) out.push(b.subarray(at, ++at));
    else if (b[at]! >= 0xc0) out.push(b.subarray(at, (at += 1 + len(0xc0)) ));
    else {
      const n = len(0x80);
      out.push(b.subarray(at, (at += n)));
    }
  }
  return out;
}
const num = (u: Uint8Array) => (u.length === 0 ? 0n : BigInt(`0x${Buffer.from(u).toString("hex")}`));

test("the selector is withdraw's, and the calldata reads back the request and its nullifier", () => {
  assert.equal(WITHDRAW_SELECTOR, Buffer.from(keccak_256(new TextEncoder().encode("withdraw((address,bytes),(uint256[2],uint256[2][2],uint256[2],uint256[8]),uint256)"))).subarray(0, 4).toString("hex"));
  const w = evmReadWithdraw(new Uint8Array(Buffer.from(calldata().slice(2), "hex")));
  assert.deepEqual(w, { processooor: POOL, recipient: REQ.recipient, feeRecipient: FEE_TO, feeCap: REQ.feeCap, deadlineMs: REQ.deadlineMs, fee: FEE, nullifier: PROOF[9]!.toString(16).padStart(64, "0") });
});

test("the epoch fee is the kit's evmPoolFee: G at the pool's tree depth at the epoch's first block, its base fee and the chain fee there, or the floor", async () => {
  assert.equal(FEE, 1_380_000_000_000_000n, "2 x (686,816 x 1 gwei + 7,917 wei) = 1,373,632,000,015,834 wei, up to the 10,000 gwei step");
  assert.equal(EVM_FEE_STEP, 10n ** 13n);
  // no base fee: 2 x 7,917 wei rounds to one step, the kit's one floor (fold 2 LOW-A; no sender takes another)
  const free = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [rpc([], {}, chainOf({ base: () => 0n })), rpc([], {}, chainOf({ base: () => 0n }))], () => NOW);
  assert.equal((await free.fee(EPOCH))!.fee, EVM_POOL_FEE_FLOOR.toString(), "the floor when gas is cheaper");
  // every read at the epoch's first block's hash, on both providers
  const ca: Calls = [], cb: Calls = [];
  await sender(ca, {}, cb).fee(EPOCH);
  for (const calls of [ca, cb]) {
    const reads = calls.filter((c) => c.method === "eth_call").map((c) => JSON.stringify(c.params));
    assert.equal(reads.length, 3, "the depth, the L1 fee bound and the operator fee");
    assert.ok(reads.every((r) => r.includes(`"blockHash":"0x${(430n).toString(16).padStart(64, "0")}"`)), reads.join(" "));
  }
  // the first block at or after the epoch: 1,999,999,860 s is block 430 exactly; 1,999,999,861 s is block 431
  const r = rpc([]);
  assert.equal((await evmFirstBlockAtOrAfter(r, 1_999_999_860n))!.number, 430n);
  assert.equal((await evmFirstBlockAtOrAfter(r, 1_999_999_861n))!.number, 431n);
  assert.equal((await evmFirstBlockAtOrAfter(r, 1_000n))!.number, 0n);
  assert.equal(await evmFirstBlockAtOrAfter(r, 2_000_000_201n), null, "after the newest block: none yet");
});

test("two callers and a restart get the same epoch fee; another epoch's base fee gives its own", async () => {
  const c = chainOf({ base: (n) => (n >= 460n ? 3n * GWEI : GWEI) });
  const s = sender([], {}, [], c);
  const a = await s.fee(EPOCH + 1_234);
  const b = await s.fee(EPOCH + 59_999);
  const restarted = await sender([], {}, [], c).fee(EPOCH);
  assert.deepEqual(a, b);
  assert.deepEqual(restarted, a);
  assert.deepEqual(a, { chain: "evm", network: "base-sepolia", pool: POOL, fee_recipient: FEE_TO, sell_sender: null, fee_collector: null, epoch_ms: 60_000, epoch_start_ms: EPOCH, block: "0x1ae", fee: FEE.toString(), step: EVM_FEE_STEP.toString() });
  const next = await sender([], {}, [], c, EPOCH + 61_000).fee(EPOCH + 60_000); // 1,999,999,920 s: block 460, 3 gwei
  assert.equal(next!.fee, feeAt(3n * GWEI).toString());
  assert.equal(await s.fee(DEADLINE + 600_000), null, "no block in that epoch yet");
});

test("a withdraw at its epoch's fee, under its cap, to this release's fee recipient: simulated, signed, sent with exactly its calldata", async () => {
  const calls: Calls = [];
  const a = await sender(calls).carry(req());
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const raw = sends(calls)[0]!;
  assert.equal((a.body as { hash: string }).hash, `0x${Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex")}`);
  const f = decodeTx(raw);
  assert.equal(`0x${Buffer.from(f[7]!).toString("hex")}`, calldata(), "the data is the calldata received");
  assert.equal(`0x${Buffer.from(f[5]!).toString("hex")}`, POOL);
  assert.equal(num(f[6]!), 0n, "value 0");
  const sim = calls.find((c) => c.method === "eth_call" && c.params[1] === "pending")!;
  const call = sim.params[0] as Record<string, string>;
  assert.equal(sim.params[1], "pending");
  const hexq = (u: Uint8Array) => `0x${num(u).toString(16)}`;
  assert.deepEqual(call, { from: evmAddressOf(KEY), to: POOL, data: calldata(), value: "0x0", gas: hexq(f[4]!), maxFeePerGas: hexq(f[3]!), maxPriorityFeePerGas: hexq(f[2]!) }, "simulated as signed");
});

test("a base fee spike past the fee's cap never overpays: maxFeePerGas x gas limit stays within the fee, and a cap under the base fee is fee_stale", async () => {
  for (const spike of [1_000n * GWEI, 10n ** 15n, 1_880_957_217n]) {
    const calls: Calls = [];
    assert.equal(code(await sender(calls, { spike }).carry(req())), "fee_stale", `spike ${spike}`);
    assert.equal(sends(calls).length, 0);
  }
  for (const spike of [GWEI / 2n, GWEI, 1_880_957_216n]) {
    const calls: Calls = [];
    const a = await sender(calls, { spike }).carry(req());
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const f = decodeTx(sends(calls)[0]!);
    const [tip, maxFee, gas] = [num(f[2]!), num(f[3]!), num(f[4]!)];
    assert.ok(maxFee * gas <= FEE, `spike ${spike}: ${maxFee} x ${gas} = ${maxFee * gas} over the fee ${FEE}`);
    assert.ok(tip <= maxFee);
    // the fee is 1,380,000 gwei (feeAt(1 gwei)); the limit is the estimate x 1.2, so the cap is fee / 733,669 = 1,880,957,216 wei
    if (spike === GWEI / 2n) assert.equal(maxFee, GWEI + 100_000_000n, "under the cap: 2 x base + tip");
    else assert.equal(maxFee, FEE / gas, "past it: the cap");
  }
});

test("refusals: another pool, another fee recipient, a fee off its epoch's, a fee over feeCap, a revert, gas over the cap", async () => {
  assert.equal(code(await sender().carry(req(calldata({ processooor: "0x00000000000000000000000000000000b1f1f002" })))), "not_pool");
  assert.equal(code(await sender().carry(req(calldata({ feeRecipient: "0x000000000000000000000000000000000000beef" })))), "fee_recipient");
  assert.equal(code(await sender().carry(req(calldata({ fee: FEE + EVM_FEE_STEP })))), "fee_off");
  assert.equal(code(await sender().carry(req(calldata({ fee: FEE - EVM_FEE_STEP })))), "fee_off");
  assert.equal(code(await sender().carry(req(calldata({ feeCap: FEE - 1n })))), "fee_over_cap");
  const calls: Calls = [];
  assert.equal(code(await sender(calls, { revert: true }).carry(req())), "simulation_failed");
  assert.equal(sends(calls).length, 0);
  assert.equal(code(await sender([], { gas: EVM_GAS_MAX }).carry(req())), "simulation_failed");
});

test("epoch_off: an epoch later than now's, at or past the deadline, before the proof's life, or with no block yet", async () => {
  assert.equal(code(await sender().carry(req(calldata(), EPOCH + 60_000))), "epoch_off", "later than the epoch now");
  assert.equal(code(await sender([], {}, [], chainOf(), DEADLINE + 60_000).carry(req(calldata(), DEADLINE + 40_000))), "epoch_off", "the first epoch past the deadline");
  // the life starts at deadline - 600,000 = 1,999,999,400,000; the grid's epochs either side of it
  assert.equal(DEADLINE - POOL_LIFE_MAX_MS, 1_999_999_400_000);
  assert.equal(code(await sender().carry(req(calldata(), 1_999_999_380_000))), "epoch_off", "before the life");
  assert.equal(code(await sender().carry(req(calldata(), 1_999_999_440_000))), "ok", "the life's first epoch");
  assert.equal(code(await sender([], {}, [], chainOf({ latest: 400n })).carry(req())), "epoch_off", "no block in it yet");
  assert.equal(code(await sender().carry(req(calldata(), EPOCH + 1))), "bad_shape", "off the grid");
});

test("bad_shape: another selector, a changed offset or padding, a byte more or less, another pool, a missing epoch", async () => {
  const good = calldata();
  const flip = (at: number, ch: string) => `${good.slice(0, at)}${ch}${good.slice(at + 1)}`;
  for (const d of [flip(2, good[2] === "0" ? "1" : "0"), flip(2 + 8 + 63, "1"), `${good}00`, good.slice(0, -2), flip(2 + 8 + 64 * 18 + 2, "1"), flip(2 + 8 + 64 * 26 + 63, "1")]) {
    assert.equal(code(await sender().carry(req(d))), "bad_shape", d.slice(0, 20));
  }
  assert.equal(code(await sender().carry({ ...req(), pool: "0x00000000000000000000000000000000b1f1f002" })), "bad_shape");
  assert.equal(code(await sender().carry({ pool: POOL, data: good })), "bad_shape");
  assert.equal(code(await sender().carry({ ...req(), extra: 1 })), "bad_shape");
});

test("upstream: two providers on different chains, or holding different blocks; nothing sent", async () => {
  const b: Calls = [];
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [rpc([]), rpc(b, { chain: "0x2105" })], () => NOW);
  assert.equal(code(await s.carry(req())), "upstream");
  const other = chainOf({ hash: (n) => `0x${(n + 1n).toString(16).padStart(64, "0")}` });
  const t = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [rpc([]), rpc(b, {}, other)], () => NOW);
  assert.equal(code(await t.carry(req())), "upstream");
  assert.equal(sends(b).length, 0);
});

test("one send per nullifier: a repeat in flight or landed, even as other bytes, gets the first hash and sends nothing", async () => {
  const calls: Calls = [];
  const s = sender(calls);
  const [a, b] = await Promise.all([s.carry(req()), s.carry(req())]);
  const copy = await s.carry(req(calldata({ refund: 7n })));
  assert.equal(a.status, 200);
  assert.deepEqual(b, a);
  assert.deepEqual(copy, a, "the same nullifier in other bytes");
  assert.equal(sends(calls).length, 1);
  const other = await s.carry(req(calldata({ nullifier: 5n })));
  assert.notDeepEqual(other, a);
  assert.equal(sends(calls).length, 2, "another nullifier is its own send, at the next nonce");
  const f = sends(calls).map(decodeTx);
  assert.equal(num(f[1]![1]!), num(f[0]![1]!) + 1n);
});

test("a first send that reverted on chain is never sent again in its epoch; a refused carry frees the nullifier", async () => {
  const calls: Calls = [];
  const s = sender(calls, { reverted: true });
  await s.carry(req());
  assert.equal(code(await s.carry(req())), "reverted");
  assert.equal(sends(calls).length, 1, "the first reverted: the repeat is refused, not sent");
  const calls2: Calls = [];
  const r = sender(calls2, { revert: true });
  assert.equal(code(await r.carry(req())), "simulation_failed");
  assert.equal(code(await r.carry(req())), "simulation_failed");
  assert.equal(calls2.filter((c) => c.method === "eth_call" && c.params[1] === "pending").length, 2, "refused, so simulated again");
});

test("signEvmTx: the signature recovers to the sender; rlp's short and long forms", () => {
  const tx = { chainId: 31337n, nonce: 7n, maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 2_100_000_000n, gas: 733_669n, to: POOL, data: new Uint8Array(Buffer.from(calldata().slice(2), "hex")) };
  const { raw } = signEvmTx(tx, KEY);
  const f = decodeTx(`0x${Buffer.from(raw).toString("hex")}`);
  const digest = keccak_256(Uint8Array.from([2, ...rlp([...f.slice(0, 8), []])]));
  const sig = Uint8Array.from([Number(num(f[9]!)), ...Buffer.from(num(f[10]!).toString(16).padStart(64, "0"), "hex"), ...Buffer.from(num(f[11]!).toString(16).padStart(64, "0"), "hex")]);
  const pub = secp256k1.recoverPublicKey(sig, digest, { prehash: false });
  assert.deepEqual(Buffer.from(pub).toString("hex"), Buffer.from(secp256k1.getPublicKey(KEY, true)).toString("hex"));
  assert.deepEqual([...rlp([])], [0xc0]);
  assert.deepEqual([...rlp(new Uint8Array(56))].slice(0, 2), [0xb8, 56]);
});

// card helper-rpc-hex-case: robinhood-testnet.drpc.org answers eth_chainId "0xB626" where Robinhood's own RPC and
// publicnode answer "0xb626" (read 3 Nov 23:07Z, card wallet-rpc-hex-case); viem and ethers read hex in either case
/** `r` with every hex string it answers in upper case (a quantity, a hash, the code), as such a provider writes it. */
const upper = (r: EvmRpc): EvmRpc => {
  const up = (v: unknown): unknown =>
    typeof v === "string" && /^0x[0-9a-f]+$/.test(v) ? `0x${v.slice(2).toUpperCase()}` : v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, up(x)])) : v;
  return async (method, params) => up(await r(method, params));
};
const LETTERS = chainOf({ hash: (n) => `0x${"ab".repeat(30)}${n.toString(16).padStart(4, "0")}` }); // hashes with hex letters

test("a provider that writes hex in upper case: drpc's 0xB626 reads as 46630, and its fee and send are the lower-case provider's", async () => {
  const pair = (calls: Calls, b: Calls, chainA: string, chainB: string, c = LETTERS) =>
    evmPoolSender({ network: "robinhood-testnet", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [upper(rpc(calls, { chain: chainA }, c)), rpc(b, { chain: chainB }, c)], () => NOW);
  const calls: Calls = [];
  const s = pair(calls, [], "0xb626", "0xb626");
  const fee = await s.fee(EPOCH);
  assert.deepEqual(fee, await pair([], [], "0xb626", "0xb626", LETTERS).fee(EPOCH).then((f) => f), "read twice alike");
  assert.equal(fee?.block, "0x1ae");
  assert.equal(fee?.fee, FEE.toString());
  const a = await s.carry(req());
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(num(decodeTx(sends(calls)[0]!)[0]!), 46_630n, "signed for chain 0xB626 = 46630");
  // a case-only difference never fails agreement; any other difference still does
  assert.equal(code(await pair([], [], "0xB626", "0xb626").carry(req())), "ok");
  const b: Calls = [];
  assert.equal(code(await pair([], b, "0xB626", "0x2105").carry(req())), "upstream", "another chain");
  const moved = chainOf({ hash: (n) => `0x${"ab".repeat(30)}${(n + 1n).toString(16).padStart(4, "0")}` });
  const t = evmPoolSender({ network: "robinhood-testnet", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [upper(rpc([], {}, LETTERS)), rpc(b, {}, moved)], () => NOW);
  assert.equal(code(await t.carry(req())), "upstream", "another block");
  assert.equal(sends(b).length, 0);
  // not hex at all is still no quantity
  const junk: EvmRpc = async (m, p) => (m === "eth_chainId" ? "0xG626" : rpc([])(m, p));
  const j = evmPoolSender({ network: "robinhood-testnet", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [junk, rpc([])], () => NOW);
  assert.equal(code(await j.carry(req())), "upstream");
});

// card evm-quote-exec-sim (review of the exec sim, HIGH 1): the device sims each sale as sent from the kit's pinned sell
// sender, so the helper starts a network's sell sender only with the key of that pin, where the kit pins one; card
// helper-evm-sender: the sell sender has its own key (POOL_EVM_SELL_KEY_<NETWORK>), never the withdraw sender's
test("the EVM pool sell sender's address is the kit's pinned sell sender for its chain, or the helper does not start; a chain with no pin starts with sales off; its key is its own", async () => {
  const SELL_KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SELL_SENDER").digest());
  const env = {
    POOL_EVM_ADDRESS_BASE_SEPOLIA: POOL,
    POOL_EVM_SENDER_KEY_BASE_SEPOLIA: "0x" + Buffer.from(KEY).toString("hex"),
    POOL_EVM_SELL_KEY_BASE_SEPOLIA: "0x" + Buffer.from(SELL_KEY).toString("hex"),
    POOL_EVM_FEE_BASE_SEPOLIA: EVM_POOL_FEE_FLOOR.toString(),
    POOL_EVM_RPCS_BASE_SEPOLIA: "https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com",
  };
  const kit = evmPoolVenues();
  const pinned = (sellSender: string) => ({ ...kit, "base-sepolia": { ...kit["base-sepolia"], sellSender } });
  // the pin is the sell key's own address: it starts, in either case of hex
  const own = evmAddressOf(SELL_KEY);
  assert.equal(evmPoolSendersFromEnv(env, pinned(own)).get(POOL)!.sellSender, own);
  assert.equal(evmPoolSendersFromEnv(env, pinned(own.toUpperCase().replace("0X", "0x"))).get(POOL)!.sellSender, own);
  assert.equal(evmPoolSendersFromEnv(env, pinned(own)).get(POOL)!.sender, evmAddressOf(KEY), "the withdraw sender keeps its own key");
  // the withdraw sender's address pinned, or another: refused at start, naming the name and the pin, never a key
  for (const other of [evmAddressOf(KEY), "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"]) {
    assert.throws(() => evmPoolSendersFromEnv(env, pinned(other)), (e: Error) => e.message.includes("POOL_EVM_SELL_KEY_BASE_SEPOLIA") && e.message.includes(other) && !e.message.includes(Buffer.from(KEY).toString("hex")) && !e.message.includes(Buffer.from(SELL_KEY).toString("hex")));
  }
  // the sell key equal to the withdraw key, not a key, or set on a network whose pool is not: refused at start
  assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_SELL_KEY_BASE_SEPOLIA: env.POOL_EVM_SENDER_KEY_BASE_SEPOLIA }), /POOL_EVM_SELL_KEY_BASE_SEPOLIA must not be POOL_EVM_SENDER_KEY_BASE_SEPOLIA/);
  assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_SELL_KEY_BASE_SEPOLIA: "0x1234" }), /POOL_EVM_SELL_KEY_BASE_SEPOLIA must be 0x and 64 lowercase hex/);
  assert.throws(() => evmPoolSendersFromEnv({ POOL_EVM_SELL_KEY_BASE: env.POOL_EVM_SELL_KEY_BASE_SEPOLIA }), /POOL_EVM_SELL_KEY_BASE is set but base's pool is not/);
  // card helper-sender-fee-proof: the fee collector a Sell must pay (POOL_EVM_FEE_COLLECTOR_<NETWORK>), named in the fee
  // answer; unset, every sell is refused; not an address, the pool's or a sender's, or set on a network whose pool is
  // not: refused at start
  // the kit's pin (review M1: the env value is held to it, as the sell key is to its sender pin)
  const C = kit["base-sepolia"]!.feeCollector!;
  assert.equal(C, "0x9cc4788af51677aaa7770d78277c41fb864b35e1", "the deployed Base Sepolia FeeCollector");
  const withC = evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: C }, pinned(own)).get(POOL)!;
  assert.equal(((await withC.sell({ nonsense: 1 })).body as { error: { code: string } }).error.code, "bad_shape", "a collector set: sells are read");
  assert.equal(((await evmPoolSendersFromEnv(env, pinned(own)).get(POOL)!.sell({ nonsense: 1 })).body as { error: { code: string } }).error.code, "not_configured");
  assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: "0x1234" }, pinned(own)), /POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA must be an address/);
  for (const bad of [POOL, own, evmAddressOf(KEY)]) assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: bad }, pinned(own)), /fee collector/, bad);
  assert.throws(() => evmPoolSendersFromEnv({ POOL_EVM_FEE_COLLECTOR_BASE: C }), /POOL_EVM_FEE_COLLECTOR_BASE is set but base's pool is not/);
  // review M1: a collector that is not the kit's pin (another address, a stand-in, the other testnet's collector) is
  // refused at start, naming the variable and the pin; the pin in upper case starts; a chain whose venue pins no
  // collector (the mainnets until theirs deploy) takes none
  assert.equal(evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: C.toUpperCase().replace("0X", "0x") }, pinned(own)).get(POOL)!.pool, POOL);
  for (const other of ["0x00000000000000000000000000000000c011ec70", kit["robinhood-testnet"]!.feeCollector!, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"]) {
    assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: other }, pinned(own)), (e: Error) => e.message.includes("POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA is not the kit's pinned fee collector") && e.message.includes(C), other);
  }
  const noCollector = { ...pinned(own), "base-sepolia": Object.fromEntries(Object.entries(pinned(own)["base-sepolia"]).filter(([k]) => k !== "feeCollector")) } as typeof kit;
  assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA: C }, noCollector), /POOL_EVM_FEE_COLLECTOR_BASE_SEPOLIA is not the kit's pinned fee collector for base-sepolia \(none pinned\)/);
  assert.equal(((await evmPoolSendersFromEnv(env, noCollector).get(POOL)!.sell({ nonsense: 1 })).body as { error: { code: string } }).error.code, "not_configured", "no pin, no collector: sells off");
  // no sell key: the network starts (withdraws go) and its sells are refused not_configured
  const noSell: Record<string, string> = { ...env };
  delete noSell.POOL_EVM_SELL_KEY_BASE_SEPOLIA;
  assert.equal(evmPoolSendersFromEnv(noSell, pinned(own)).get(POOL)!.sellSender, null);
  // the kit's own list pins each testnet's sell sender (the helper box's key) and no mainnet's yet: a test key on Base
  // Sepolia is refused at start against the kit's own pin; a chain with no pin starts with sales off, never with an
  // unpinned key (the device sims each sale from the pin, so there is nothing to sim a sale from)
  assert.equal(kit["base-sepolia"].sellSender, "0xd378cda68babba6a9dc1d52335bb76ca9e6a7553");
  assert.equal(kit["robinhood-testnet"].sellSender, "0xd12d83097671d731df2db731e973ad9a07673607");
  for (const c of ["base", "robinhood"] as const) assert.equal(Object.hasOwn(kit[c], "sellSender"), false, c);
  assert.throws(() => evmPoolSendersFromEnv(env), (e: Error) => e.message.includes("POOL_EVM_SELL_KEY_BASE_SEPOLIA") && e.message.includes(kit["base-sepolia"].sellSender!));
  const unpinned = { ...kit, "base-sepolia": Object.fromEntries(Object.entries(kit["base-sepolia"]).filter(([k]) => k !== "sellSender")) as typeof kit["base-sepolia"] };
  const off = evmPoolSendersFromEnv(env, unpinned).get(POOL)!;
  assert.equal(off.sellSender, null, "no pin: no sell sender");
  assert.equal(off.sender, evmAddressOf(KEY), "the withdraws still go");
  const refused = await off.sell({});
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [503, "not_configured"]);
});

test("the withdraw's deadline again after the queue's wait: a carry whose deadline came within the margin while it waited is deadline_near, nothing sent", async () => {
  let clock = NOW;
  let open: () => void = () => {};
  const gate = new Promise<void>((ok) => (open = ok));
  const calls: Calls = [];
  const inner = rpc(calls);
  const slow: EvmRpc = async (m, p) => (m === "eth_chainId" ? gate.then(() => inner(m, p)) : inner(m, p));
  const s = evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [slow, rpc([])], () => clock);
  const first = s.carry(req());
  const second = s.carry(req(calldata({ nullifier: 77n })));
  await new Promise((ok) => setTimeout(ok, 5));
  clock = NOW + 41_000; // the deadline is now 59 s away
  open();
  const done = await first;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const late = await second;
  assert.equal(code(late), "deadline_near", JSON.stringify(late.body));
  assert.equal(sends(calls).length, 1);
});

// card evm-buy-hookdata-fee, review fold 2 LOW-A: one floor, the kit's; the env may only repeat it
test("LOW-A the helper refuses an env floor other than the kit's EVM_POOL_FEE_FLOOR, and an unset one is the kit's", () => {
  const env = {
    POOL_EVM_ADDRESS_BASE_SEPOLIA: POOL,
    POOL_EVM_SENDER_KEY_BASE_SEPOLIA: "0x" + Buffer.from(KEY).toString("hex"),
    POOL_EVM_RPCS_BASE_SEPOLIA: "https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com",
  };
  assert.ok(evmPoolSendersFromEnv(env).get(POOL));
  assert.ok(evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_BASE_SEPOLIA: "10000000000000" }).get(POOL));
  for (const fee of ["1000", "20000000000000", "9999999999999", "1e13", "010000000000000", " 10000000000000"])
    assert.throws(() => evmPoolSendersFromEnv({ ...env, POOL_EVM_FEE_BASE_SEPOLIA: fee }), /POOL_EVM_FEE_BASE_SEPOLIA must be unset or the kit's floor, 10000000000000 wei/, fee);
});

// card evm-buy-hookdata-fee, review fold 2 MEDIUM-A: the fee reads state at the epoch's first block up to a proof's
// life (POOL_LIFE_MAX_MS) old; robinhood-sepolia-rpc.publicnode.com keeps about 15 s ("historical state <root> is not
// available" at 20 s, read 2026-11-04 20:10Z). The start reads that state 600 s back on each provider.
/** Two JSON-RPC servers on loopback: blocks 0 to 600, 2 s apart from T0; the second answers state calls only for
 *  blocks at or above `keepFrom` (a pruning node), the first for every block. */
async function nodes(keepFrom: bigint, http429 = 0): Promise<{ urls: [string, string]; calls: { url: number; method: string; params: unknown[] }[]; close(): void }> {
  const calls: { url: number; method: string; params: unknown[] }[] = [];
  const servers = [0n, keepFrom].map((keep, i) =>
    createServer((q, r) => {
      let body = "";
      q.on("data", (d) => (body += d));
      q.on("end", () => {
        const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
        calls.push({ url: i, method, params });
        if (i === 1 && method === "eth_call" && http429-- > 0) return void r.writeHead(429).end("Too Many Requests");
        const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + 2n * n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: "0x3b9aca00" });
        let out: object;
        if (method === "eth_getBlockByNumber") out = { result: block(params[0] === "latest" ? 600n : BigInt(params[0] as string)) };
        else if (method === "eth_call") {
          const at = BigInt((params[1] as { blockHash: string }).blockHash);
          out = at < keep ? { error: { code: -32000, message: `historical state ${"ab".repeat(32)} is not available` } } : { result: `0x${"0".repeat(63)}2` };
        } else out = { error: { code: -32601, message: "no" } };
        r.setHeader("content-type", "application/json");
        r.end(JSON.stringify({ jsonrpc: "2.0", id, ...out }));
      });
    }).listen(0, "127.0.0.1"),
  );
  await Promise.all(servers.map((s) => new Promise((ok) => (s.listening ? ok(null) : s.once("listening", ok)))));
  const urls = servers.map((s) => `http://127.0.0.1:${(s.address() as { port: number }).port}`) as [string, string];
  return { urls, calls, close: () => servers.forEach((s) => s.close()) };
}

test("MEDIUM-A the start refuses an env RPC that cannot answer the fee's state reads at the block POOL_LIFE_MAX_MS old, naming the variable and the host", async (t) => {
  const realNow = Date.now;
  t.after(() => void (Date.now = realNow));
  Date.now = () => Number(T0 + 1_200n) * 1000; // block 600's time, the newest
  const envOf = (urls: [string, string]) => ({
    POOL_EVM_ADDRESS_BASE_SEPOLIA: POOL,
    POOL_EVM_SENDER_KEY_BASE_SEPOLIA: "0x" + Buffer.from(KEY).toString("hex"),
    POOL_EVM_RPCS_BASE_SEPOLIA: urls.join(","),
  });
  // both keep every block: ready, every read at block 300 (600 s old), on both
  const good = await nodes(0n);
  try {
    await evmPoolSendersFromEnv(envOf(good.urls)).get(POOL)!.ready();
    for (const u of [0, 1]) {
      const at = good.calls.filter((c) => c.url === u && c.method === "eth_call").map((c) => (c.params[1] as { blockHash: string }).blockHash);
      assert.deepEqual(at, Array(3).fill(`0x${(300n).toString(16).padStart(64, "0")}`), `rpc ${u + 1}: the depth and the two chain fee reads at block 300`);
    }
  } finally {
    good.close();
  }
  // the second keeps the last 15 s (blocks 593 on): refused at once (no wait: a missing state is never asked again),
  // naming the variable and the second provider's host only, never its URL's path or query (a key may sit there)
  const pruned = await nodes(593n);
  try {
    const keyed = pruned.urls.map((u) => `${u}/v2/s3cr3tKEY?apikey=s3cr3tKEY`) as [string, string];
    const waits: number[] = [];
    await assert.rejects(evmPoolSendersFromEnv(envOf(keyed)).get(POOL)!.ready(async (ms) => void waits.push(ms)), (e: Error) => {
      assert.match(e.message, /^POOL_EVM_RPCS_BASE_SEPOLIA: 127\.0\.0\.1:\d+: no answer to 0x[0-9a-f]{8} at 0x[0-9a-f]{40} at block 300, 600 s old \(a proof's fee is read up to 600 s back\): .*historical state/);
      assert.ok(e.message.includes(new URL(pruned.urls[1]).host) && !e.message.includes(new URL(pruned.urls[0]).host), e.message);
      assert.ok(!e.message.includes("s3cr3tKEY") && !e.message.includes("/v2/"), e.message);
      return true;
    });
    assert.deepEqual(waits, [], "a missing state is not asked again");
  } finally {
    pruned.close();
  }
  // the second answers HTTP 429 to its first two state reads: asked again through the env's own client, then ready
  const busy = await nodes(0n, 2);
  try {
    const waits: number[] = [];
    await evmPoolSendersFromEnv(envOf(busy.urls)).get(POOL)!.ready(async (ms) => void waits.push(ms));
    assert.deepEqual(waits, [1_000, 2_000]);
    assert.equal(busy.calls.filter((c) => c.url === 1 && c.method === "eth_call").length, 3 + 2);
  } finally {
    busy.close();
  }
  // one that keeps 600 s exactly (block 300 on) is ready
  const edge = await nodes(300n);
  try {
    await evmPoolSendersFromEnv(envOf(edge.urls)).get(POOL)!.ready();
  } finally {
    edge.close();
  }
  assert.equal(POOL_LIFE_MAX_MS, 600_000);
});

// card evm-buy-hookdata-fee, review of 0b18a71 (b): a 429 or a timeout at the start is asked again, bounded; a
// missing state never is
/** ready()'s bound, as evm.ts sets it (literals here, so this file links at a base without them). */
const EVM_READY_TRIES = 3;
const EVM_READY_WAIT_MS = 1_000;
test("ready() asks a throttled or timed-out call again, EVM_READY_TRIES times at most, and a missing state not at all", async () => {
  /** The test mock's provider, its eth_calls at a hash answered first by `fails` (one a call, in order). */
  const flaky = (failsIn: (() => Error)[], calls: string[] = []): EvmRpc => {
    const fails = [...failsIn];
    const inner = rpc([]);
    return async (method, params) => {
      calls.push(method);
      if (method === "eth_call") {
        const f = fails.shift();
        if (f) throw f();
      }
      return inner(method, params);
    };
  };
  const s = (b: EvmRpc) => evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY }, [rpc([]), b], () => NOW);
  const http429 = () => new Error("HTTP 429");
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const limited = () => new Error("RPC error -32005: project ID request rate exceeded");
  const missing = () => new Error("RPC error -32000: historical state ab is not available");
  // a 429, a timeout and a -32005 on one call each: each asked again after 1 s, then 2 s
  for (const [what, fail] of [["429", http429], ["timeout", timeout], ["-32005", limited]] as const) {
    const waits: number[] = [];
    await s(flaky([fail, fail])).ready(async (ms) => void waits.push(ms));
    assert.deepEqual(waits, [EVM_READY_WAIT_MS, 2 * EVM_READY_WAIT_MS], what);
  }
  // throttled on every try: refused after EVM_READY_TRIES, naming the throttle
  const calls: string[] = [];
  const waits: number[] = [];
  await assert.rejects(s(flaky(Array(9).fill(http429), calls)).ready(async (ms) => void waits.push(ms)), /^Error: rpc 2: no answer to .*HTTP 429$/);
  assert.equal(calls.filter((m) => m === "eth_call").length, EVM_READY_TRIES);
  assert.deepEqual(waits, [1_000, 2_000]);
  // a missing state: refused at once, one call, no wait, even after a throttle on the same call
  for (const fails of [[missing], [http429, missing]]) {
    const c: string[] = [];
    const w: number[] = [];
    await assert.rejects(s(flaky(fails, c)).ready(async (ms) => void w.push(ms)), /historical state ab is not available/);
    assert.equal(c.filter((m) => m === "eth_call").length, fails.length);
    assert.equal(w.length, fails.length - 1);
  }
});

// card evm-buy-hookdata-fee, review fold 4 LOW-2: one case for each of ready()'s throttle codes and refusals
test("LOW-2 ready(): each throttle code on its list is asked again and a code off it is not; an answer that is not a 32-byte word (not hex, '0x', 31 bytes) and another block at the same number are refused", async () => {
  const s = (b: EvmRpc, a: EvmRpc = rpc([])) => evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY }, [a, b], () => NOW);
  /** The mock's provider, its n-th eth_call at a hash answered by `answer(n)` (an Error is thrown, undefined: the mock). */
  const onCall = (answer: (n: number) => unknown, c: Chain = chainOf()): EvmRpc => {
    const inner = rpc([], {}, c);
    let n = 0;
    return async (method, params) => {
      if (method === "eth_call") {
        const v = answer(n++);
        if (v instanceof Error) throw v;
        if (v !== undefined) return v;
      }
      return inner(method, params);
    };
  };
  // the kit client's other throttle codes: each asked again once, then ready
  for (const c of ["-32029", "-32429", "-429", "15"]) {
    const waits: number[] = [];
    await s(onCall((n) => (n === 0 ? new Error(`RPC error ${c}: slow down`) : undefined))).ready(async (ms) => void waits.push(ms));
    assert.deepEqual(waits, [EVM_READY_WAIT_MS], c);
  }
  // a code off the list (an internal error; codes that only start like one on it): refused at once
  for (const c of ["-32603", "150", "-3202", "-42"]) {
    const waits: number[] = [];
    await assert.rejects(s(onCall((n) => (n === 0 ? new Error(`RPC error ${c}: no`) : undefined))).ready(async (ms) => void waits.push(ms)), new RegExp(`RPC error ${c}: no$`), c);
    assert.deepEqual(waits, [], c);
  }
  // not hex: refused
  for (const v of ["0xzz", 7, null]) await assert.rejects(s(onCall(() => v)).ready(), /^Error: rpc 2: no answer to 0x[0-9a-f]{8} at 0x[0-9a-f]{40} at block \d+, .*: not (hex|a word)$/, String(v));
  // hex but not a 32-byte word, which feeOf's viewAt refuses too: refused at the start, not at the first bind
  for (const v of ["0x", `0x${"0".repeat(62)}`]) await assert.rejects(s(onCall(() => v)).ready(), /: not a word$/, v);
  // a word and more (viewAt reads the first): ready
  await s(onCall(() => `0x${"0".repeat(63)}2${"f".repeat(64)}`)).ready();
  // the second provider holds another block at the number the first found: refused before any state read
  let stateReads = 0;
  const other = onCall(() => void stateReads++, chainOf({ hash: (n) => `0x${(n + 1n).toString(16).padStart(64, "0")}` }));
  await assert.rejects(s(other).ready(), /^Error: rpc 2: another block at \d+$/);
  assert.equal(stateReads, 0);
});

// card evm-quote-warm-round fold 8: every read the sender makes is at a past block, so with no RPCs set it reads the
// kit's fee pair (feeProviders, each holding state 600 s back), never the quote's providers
test("fold 8 a sender with no POOL_EVM_RPCS_* reads only the kit's feeProviders for its network, and with neither set it does not start", async () => {
  const env = {
    POOL_EVM_ADDRESS_BASE_SEPOLIA: POOL,
    POOL_EVM_SENDER_KEY_BASE_SEPOLIA: "0x" + Buffer.from(KEY).toString("hex"),
  };
  const kit = evmPoolVenues();
  const fee = ["https://fee-a.fold8.test", "https://fee-b.fold8.test"] as const;
  const venues = { ...kit, "base-sepolia": { ...kit["base-sepolia"], providers: ["https://quote-a.fold8.test", "https://quote-b.fold8.test", "https://quote-c.fold8.test"], feeProviders: fee } };
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    asked.push(new URL(String(u)).origin);
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    await assert.rejects(evmPoolSendersFromEnv(env, venues).get(POOL)!.ready(async () => {}));
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(asked.length > 0, "no read made");
  assert.deepEqual([...new Set(asked)].filter((o) => !fee.includes(o as (typeof fee)[number])), [], asked.join(", "));
  const { feeProviders: _, ...none } = kit["base-sepolia"];
  assert.throws(() => evmPoolSendersFromEnv(env, { ...kit, "base-sepolia": none }), /POOL_EVM_RPCS_BASE_SEPOLIA must be set: the kit lists no fee providers for base-sepolia/);
});
