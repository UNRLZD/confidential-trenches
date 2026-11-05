// node --test apps/helper/src/pool/evm-attacks.test.ts: the review's attacks on the EVM pool sender (M356), each held
// as the fixed behaviour. B1-B5 are the reviewer's attacks inverted; E6 and E12 kill the two mutants that survived
// evm.test.ts. The request is evm.test.ts's (the kit's relayed fixture for pool 0x...b1f1f001 on chain 31337); the
// sender key is the same test key: sha256("helper-pool-senders/test-key/EVM_SENDER").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as evm from "./evm.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { evmPoolFee, evmPoolGas } from "@blindfill/kit";
import { EVM_FEE_STEP, evmPoolSender, POOL_LIFE_MAX_MS, WITHDRAW_SELECTOR, type EvmRpc } from "./evm.ts";
import { oncePerNullifier } from "./once.ts";

const KEY = new Uint8Array(createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest());
const POOL = "0x00000000000000000000000000000000b1f1f001";
const FEE_TO = "0x000000000000000000000000000000000000fee1";
const RECIPIENT = "0x0000000000000000000000000000000000000a11";
const DEADLINE = 2_000_000_000_000;
const NOW = DEADLINE - 100_000;
const EPOCH = 1_999_999_860_000;
const T0 = 1_999_999_000n;
const GWEI = 1_000_000_000n;
const FEE = evmPoolFee({ gas: evmPoolGas(2), gasPrice: GWEI, chainFee: 7_917n });
/** The fee's reads at a block's hash (EIP-1898): the pool's tree depth, 2, and the chain fee oracle, Base Sepolia's L1
 *  fee for 2,600 bytes (7,917 wei, 4 Nov) and no operator fee, as the kit's evmPoolChainFeeReads ask. */
const feeRead = (to: string, data: string): string => `0x${(to === "0x420000000000000000000000000000000000000f" ? (data.startsWith("0xf1c7a58b") ? 7_917n : 0n) : data === DEPTH_DATA ? 2n : 0n).toString(16).padStart(64, "0")}`;
const DEPTH_DATA = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;

const PROOF = Array.from({ length: 16 }, (_, i) => BigInt(1000 + i));

const w32 = (n: bigint) => n.toString(16).padStart(64, "0");
const a32 = (a: string) => a.slice(2).padStart(64, "0");
/** withdraw's calldata as solc's abi.encode writes it; `relayLen` and `feeToWord` replace one word each. */
function calldata(o: { nullifier?: bigint; deadlineMs?: bigint; relayLen?: bigint; feeToWord?: string } = {}): string {
  const relay = [a32(RECIPIENT), o.feeToWord ?? a32(FEE_TO), w32(10n ** 16n), w32(o.deadlineMs ?? BigInt(DEADLINE)), w32(5n), "c9ebb52422ed595de60e051c69edee1a".padEnd(64, "0")];
  const proof = PROOF.map((v, i) => (i === 9 && o.nullifier !== undefined ? o.nullifier : v));
  return `0x${WITHDRAW_SELECTOR}${w32(18n * 32n)}${proof.map(w32).join("")}${w32(FEE)}${a32(POOL)}${w32(64n)}${w32(o.relayLen ?? 192n)}${relay.join("")}`;
}

type Calls = { method: string; params: readonly unknown[] }[];
type Opts = {
  latest?: bigint;
  spike?: bigint;
  reverted?: boolean;
  code?: (tag: string) => string;
  /** eth_call reverts when the call carries fee fields (a GASPRICE-dependent revert). */
  revertWithFee?: boolean;
  /** a method's error; "eth_call" is the simulation's (at pending), "fee read" an eth_call of the fee at a block hash */
  fail?: Partial<Record<string, string>>;
  hang?: string;
};
function rpc(calls: Calls, o: Opts = {}): EvmRpc {
  const latest = o.latest ?? 600n;
  const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + 2n * n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: `0x${GWEI.toString(16)}` });
  return async (method, params) => {
    calls.push({ method, params });
    if (o.hang === method) return new Promise(() => {});
    const feeRead_ = method === "eth_call" && typeof params[1] === "object" && params[1] !== null;
    const key = feeRead_ ? "fee read" : method;
    if (o.fail?.[key]) throw new Error(o.fail[key]);
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_getCode": return o.code ? o.code(params[1] as string) : "0x";
      case "eth_call": {
        const [{ to, data }, at] = params as [{ to: string; data: string }, unknown];
        if (typeof at === "object" && at !== null && "blockHash" in at) return feeRead(to, data);
        if (o.revertWithFee && (params[0] as { maxFeePerGas?: string }).maxFeePerGas !== undefined) throw new Error("RPC error 3: execution reverted");
        return "0x";
      }
      case "eth_estimateGas": return `0x${(611_391n).toString(16)}`;
      case "eth_getBlockByNumber": {
        if (params[0] === "latest") return { ...block(latest), ...(o.spike ? { baseFeePerGas: `0x${o.spike.toString(16)}` } : {}) };
        const n = BigInt(params[0] as string);
        return n <= latest ? block(n) : null;
      }
      case "eth_maxPriorityFeePerGas": return "0x5f5e100";
      case "eth_getTransactionCount": return "0x7";
      case "eth_sendRawTransaction": return "0x";
      case "eth_getTransactionReceipt": return { status: o.reverted ? "0x0" : "0x1" };
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
const make = (a: Calls, o: Opts = {}, b: Calls = [], now: number | (() => number) = NOW, ob: Opts = o) =>
  evmPoolSender({ network: "base-sepolia", pool: POOL, senderKey: KEY, feeRecipient: FEE_TO }, [rpc(a, o), rpc(b, ob)], typeof now === "number" ? () => now : now);
// read through the namespace, so a missing constant fails its own test, not the file's import
const MARGIN = 60_000;
const QUEUE_MAX = 64;
const code = (x: { body: unknown }) => ((x.body as { error?: { code: string } }).error?.code ?? "ok");
const req = (data = calldata(), epoch = EPOCH) => ({ pool: POOL, data, epoch });
const sends = (c: Calls) => c.filter((x) => x.method === "eth_sendRawTransaction");

test("B2 a send that reverted on chain is never sent again in its epoch: one send, then 422 reverted with no RPC send", async () => {
  const a: Calls = [];
  const b: Calls = [];
  let t = NOW;
  const s = make(a, { reverted: true }, b, () => t);
  assert.equal(code(await s.carry(req())), "ok");
  assert.equal(code(await s.carry(req())), "reverted", "the repeat reads the receipt, finds the revert");
  const before = a.length + b.length;
  for (let i = 0; i < 8; i++) assert.equal(code(await s.carry(req())), "reverted");
  assert.equal(a.length + b.length, before, "known reverted: no RPC call at all");
  assert.equal(sends(a).length + sends(b).length, 2, "one send, broadcast once on each provider");
  // a new proof in a later epoch is its own send; the reverted epoch stays refused
  t = EPOCH + 70_000; // in the next epoch, still 70 s before the deadline
  assert.equal(code(await s.carry(req(calldata(), EPOCH + 60_000))), "ok");
  assert.equal(code(await s.carry(req())), "reverted");
  assert.equal(sends(a).length, 2);
});

test("a revert first seen by a later epoch's proof is held against the epoch that reverted: the new proof is sent", async () => {
  const a: Calls = [];
  let t = NOW;
  const s = make(a, { reverted: true }, [], () => t);
  assert.equal(code(await s.carry(req())), "ok");
  t = EPOCH + 70_000;
  assert.equal(code(await s.carry(req(calldata(), EPOCH + 60_000))), "ok", "the re-proved release in the next epoch");
  const before = a.length;
  assert.equal(code(await s.carry(req())), "reverted", "the first epoch's proof: refused");
  assert.equal(a.length, before, "with no RPC call");
  assert.equal(sends(a).length, 2);
});

test("B4 two repeats racing after a revert: both answer reverted, the nullifier is sent once", async () => {
  const a: Calls = [];
  const s = make(a, { reverted: true });
  await s.carry(req());
  const [x, y] = await Promise.all([s.carry(req()), s.carry(req())]);
  assert.deepEqual([code(x), code(y)], ["reverted", "reverted"]);
  assert.equal(sends(a).length, 1);
});

test("once.forget(nf, entry) frees the nullifier only while that entry is the one stored", async () => {
  const once = oncePerNullifier<{ status: number }>();
  const first = once.run("n", async () => ({ status: 200 }));
  await first;
  const stale = Promise.resolve({ status: 200 });
  once.forget("n", stale);
  assert.equal(once.get("n"), first, "another entry: kept");
  once.forget("n", first);
  assert.equal(once.get("n"), undefined, "the same entry: freed");
});

test("B5 a deadline under now + 60 s is refused deadline_near before any RPC call", async () => {
  for (const now of [DEADLINE + 1_000, DEADLINE - 1_000, DEADLINE - MARGIN + 1]) {
    const a: Calls = [];
    const b: Calls = [];
    const epoch = Math.floor(now / 60_000) * 60_000;
    assert.equal(code(await make(a, {}, b, now).carry(req(calldata(), epoch))), "deadline_near", `now ${now}`);
    assert.equal(a.length + b.length, 0, `now ${now}: no RPC call`);
  }
  assert.equal(code(await make([], {}, [], DEADLINE - MARGIN).carry(req())), "ok", "exactly the margin: sent");
  assert.equal(evm.EVM_POOL_SEND_MARGIN_MS, MARGIN);
});

test("a recipient with code on either provider, at pending or latest, is refused recipient_code (an EIP-7702 delegation too)", async () => {
  const delegation = `0xef0100${"ab".repeat(20)}`;
  const cases: [Opts, Opts][] = [
    [{ code: () => delegation }, {}],
    [{}, { code: () => "0x6000" }],
    [{ code: (t) => (t === "pending" ? "0x00" : "0x") }, {}],
    [{}, { code: (t) => (t === "latest" ? delegation : "0x") }],
  ];
  for (const [oa, ob] of cases) {
    const a: Calls = [];
    const b: Calls = [];
    assert.equal(code(await make(a, oa, b, NOW, ob).carry(req())), "recipient_code");
    assert.equal(sends(a).length + sends(b).length, 0);
  }
  const a: Calls = [];
  const b: Calls = [];
  assert.equal(code(await make(a, {}, b).carry(req())), "ok");
  for (const c of [a, b]) {
    const reads = c.filter((x) => x.method === "eth_getCode").map((x) => `${x.params[0]}@${x.params[1]}`).sort();
    assert.deepEqual(reads, [`${RECIPIENT}@latest`, `${RECIPIENT}@pending`]);
  }
});

test("the simulation is eth_call at pending with the real from, gas and fee fields, and the send uses exactly those", async () => {
  const a: Calls = [];
  assert.equal(code(await make(a, { revertWithFee: true }).carry(req())), "simulation_failed", "a revert only at a real gas price is caught");
  assert.equal(sends(a).length, 0);
  const ok: Calls = [];
  assert.equal(code(await make(ok).carry(req())), "ok");
  const call = ok.find((x) => x.method === "eth_call" && x.params[1] === "pending")!;
  assert.equal(call.params[1], "pending");
  const f = call.params[0] as Record<string, string>;
  assert.deepEqual(Object.keys(f).sort(), ["data", "from", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "to", "value"]);
  const gas = (611_391n * 12n) / 10n;
  const cap = FEE / gas;
  const maxFee = 2n * GWEI + 100_000_000n < cap ? 2n * GWEI + 100_000_000n : cap;
  assert.deepEqual([BigInt(f.gas!), BigInt(f.maxFeePerGas!), BigInt(f.maxPriorityFeePerGas!)], [gas, maxFee, 100_000_000n]);
  // the signed transaction's fields (rlp: 0x02, list, chainId, nonce, tip, maxFee, gas): read back from the raw bytes
  const raw = Buffer.from((sends(ok)[0]!.params[0] as string).slice(2), "hex");
  const items: bigint[] = [];
  let at = raw[1]! > 0xf7 ? 2 + (raw[1]! - 0xf7) : 2;
  for (let i = 0; i < 5; i++) {
    const x = raw[at]!;
    if (x < 0x80) (items.push(BigInt(x)), (at += 1));
    else {
      const n = x - 0x80;
      items.push(n === 0 ? 0n : BigInt(`0x${raw.subarray(at + 1, at + 1 + n).toString("hex")}`));
      at += 1 + n;
    }
  }
  assert.deepEqual(items.slice(2), [100_000_000n, maxFee, gas], "tip, maxFeePerGas and gas as simulated");
});

test("B3 a fee cap (fee / gas limit) under the current base fee is refused fee_stale before signing", async () => {
  const a: Calls = [];
  const s = make(a, { spike: 5n * GWEI });
  assert.equal(code(await s.carry(req())), "fee_stale");
  assert.equal(code(await s.carry(req(calldata({ nullifier: 77n })))), "fee_stale");
  assert.equal(sends(a).length, 0, "nothing signed or sent");
  assert.equal(a.filter((x) => x.method === "eth_call" && x.params[1] === "pending").length, 0, "refused before the simulation");
});

test("B1 an epoch outside [now - life, now] or a past deadline is refused before any block read; fee() outside it is null with no read", async () => {
  const far = Number(T0 + 2n * 50_000_000n) * 1000;
  const old = Number(T0 + 180n) * 1000 - ((Number(T0 + 180n) * 1000) % 60_000);
  const a: Calls = [];
  const b: Calls = [];
  const s = make(a, { latest: 50_000_000n }, b, far);
  assert.equal(code(await s.carry(req(calldata({ deadlineMs: BigInt(old + 1_000) }), old))), "epoch_off");
  assert.equal(code(await s.carry(req(calldata({ deadlineMs: BigInt(old + POOL_LIFE_MAX_MS) }), old))), "epoch_off");
  assert.equal(await s.fee(old), null);
  assert.equal(await s.fee(far + 120_000), null, "a future epoch");
  assert.equal(await s.fee(far - POOL_LIFE_MAX_MS - 60_000), null, "older than a proof's life");
  assert.equal(a.length + b.length, 0, "zero RPC reads");
  assert.notEqual(await s.fee(far), null, "the epoch now is read");
});

test("the send queue holds at most EVM_QUEUE_MAX waiting; past it 429 rate_limited with a wait (card helper-abuse-limits: the helper's own budget is never a 503)", async () => {
  const a: Calls = [];
  const s = make(a, { hang: "eth_chainId" });
  // one running (its chain id read never answers), then QUEUE_MAX waiting behind it
  void s.carry(req(calldata({ nullifier: 4999n })));
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < QUEUE_MAX; i++) void s.carry(req(calldata({ nullifier: BigInt(5000 + i) })));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.filter((x) => x.method === "eth_chainId").length, 1, "only the first is running");
  const hung = { status: 0, body: { error: { code: "hung" } } };
  const over = await Promise.race([s.carry(req(calldata({ nullifier: 9999n }))), new Promise<typeof hung>((r) => setTimeout(() => r(hung), 500))]);
  assert.equal(code(over), "rate_limited");
  assert.equal(over.status, 429);
  assert.equal((over as { retryAfterS?: number }).retryAfterS, evm.EVM_BUSY_RETRY_S);
  assert.equal(evm.EVM_QUEUE_MAX, QUEUE_MAX);
});

test("a provider's transport error is 503 upstream; its HTTP 429 or rate-limit error is 429 rate_limited with a wait (card helper-abuse-limits), on every read and the send; an execution revert stays 422 simulation_failed", async () => {
  for (const [method, msg, want] of [
    ["eth_estimateGas", "HTTP 429", "rate_limited"],
    ["eth_estimateGas", "fetch failed", "upstream"],
    ["eth_call", "HTTP 429", "rate_limited"],
    ["eth_call", "RPC error -32016: rate limit exceeded", "rate_limited"],
    ["eth_getCode", "HTTP 429", "rate_limited"],
    ["eth_chainId", "HTTP 429", "rate_limited"],
    ["eth_getBlockByNumber", "HTTP 429", "rate_limited"],
    ["eth_sendRawTransaction", "HTTP 429", "rate_limited"],
    ["eth_call", "The operation was aborted due to timeout", "upstream"],
    ["eth_call", "RPC error -32005: project ID request rate exceeded", "rate_limited"], // EIP-1474 limit exceeded
    ["eth_estimateGas", "RPC error -32005: daily request count exceeded, request rate limited", "rate_limited"],
    ["eth_call", "RPC error -32002: resource unavailable", "upstream"], // any other -320xx stays a failure
    ["eth_estimateGas", "RPC error -32004: method not supported", "upstream"],
    ["eth_call", "RPC error -320050: not the code", "upstream"],
    ["eth_getCode", "HTTP 503", "upstream"],
    ["eth_call", "RPC error 3: execution reverted: 0x8b1c4b0b", "simulation_failed"],
    ["eth_estimateGas", "RPC error 3: execution reverted", "simulation_failed"],
    ["eth_estimateGas", "RPC error -32000: insufficient funds for gas * price + value", "simulation_failed"],
    ["eth_call", "RPC error -32003: EVM error InvalidFEOpcode", "simulation_failed"], // anvil 1.8.6's halt
    ["eth_call", "RPC error -32603: internal error", "upstream"],
    // a fee read (the pool's depth, the chain fee) that fails is never the request's: no fee, so no send
    ["fee read", "RPC error 3: execution reverted", "upstream"],
    ["fee read", "fetch failed", "upstream"],
    ["fee read", "HTTP 429", "rate_limited"],
  ] as const) {
    const a: Calls = [];
    const x = await make(a, { fail: { [method]: msg } }).carry(req());
    assert.equal(code(x), want, `${method} ${msg}`);
    assert.equal(x.status, want === "upstream" ? 503 : want === "rate_limited" ? 429 : 422);
    assert.equal(x.retryAfterS, want === "rate_limited" ? 1 : undefined, "a throttle names its wait");
    if (method !== "eth_sendRawTransaction") assert.equal(sends(a).length, 0);
  }
});

test("E6 the feeRecipient relay word with non-zero high padding is bad_shape, before any RPC call", async () => {
  const a: Calls = [];
  const b: Calls = [];
  const word = `01${a32(FEE_TO).slice(2)}`;
  assert.equal(code(await make(a, {}, b).carry(req(calldata({ feeToWord: word })))), "bad_shape");
  assert.equal(a.length + b.length, 0);
});

test("E12 the relay bytes' length word changed is bad_shape, before any RPC call", async () => {
  for (const len of [160n, 224n, 191n, 193n]) {
    const a: Calls = [];
    const b: Calls = [];
    assert.equal(code(await make(a, {}, b).carry(req(calldata({ relayLen: len })))), "bad_shape", `length ${len}`);
    assert.equal(a.length + b.length, 0);
  }
  assert.equal(EVM_FEE_STEP, 10n ** 13n);
});

// card helper-abuse-limits, M374 (5) on this route too: the queue is shared by every caller, so one client holds at
// most EVM_IN_FLIGHT_MAX requests open in it (at be4b353 one client could fill all EVM_QUEUE_MAX places)
test("one client holds at most EVM_IN_FLIGHT_MAX requests open, repeats included; the next is 429 in_flight with a wait; another client still queues", async () => {
  const a: Calls = [];
  const s = make(a, { hang: "eth_chainId" });
  const x = (n: bigint) => s.carry(req(calldata({ nullifier: n })), "x");
  void x(7001n);
  void x(7002n);
  await new Promise((r) => setTimeout(r, 20));
  const hung = { status: 0, body: { error: { code: "hung" } } };
  const third = await Promise.race([x(7001n), new Promise<typeof hung>((r) => setTimeout(() => r(hung), 300))]);
  assert.deepEqual([third.status, code(third), (third as { retryAfterS?: number }).retryAfterS], [429, "in_flight", evm.EVM_BUSY_RETRY_S]);
  const other = await Promise.race([s.carry(req(calldata({ nullifier: 7003n })), "y"), new Promise<typeof hung>((r) => setTimeout(() => r(hung), 100))]);
  assert.equal(code(other), "hung", "another client's request is held in the queue, not refused");
  assert.equal(evm.EVM_IN_FLIGHT_MAX, 2);
});
