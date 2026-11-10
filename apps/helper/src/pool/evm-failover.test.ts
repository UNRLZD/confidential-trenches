// node --test apps/helper/src/pool/evm-failover.test.ts (card helper-pool-fee-one-read-fails): one provider's failed
// read never stops a Base or Robinhood pool route while another of the helper's providers for that side can answer it.
// On 9 Nov 23:04Z the live helper answered GET /v1/pool/fee for the Robinhood mainnet pool 503 upstream, then 200 three
// times, with no log line. The cause, read from the Mac 9 Nov 23:2xZ on the kit's fee pair: robinhood.drpc.org (dRPC's
// public endpoint, the pair's first) answered the pool's currentTreeDepth() at the epoch block's hash HTTP 400
// {"code":27,"message":"Unknown state. First available state is 1"} in bursts (9 of 30 fee reads, then 29 of 30, then
// none of 24), each in about 70 ms, so one failed read ended the whole fee read.
// Every provider here is a stub of fetch; the keyed URLs carry a made-up path, never a real key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads, evmPoolFee, evmPoolGas, evmPoolVenues } from "@blindfill/kit";
import { providerHolds, throttleOf } from "../limits/limits.ts";
import * as evm from "./evm.ts";

const KEY = "0x" + createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest("hex");
const PIN = evmPoolVenues().robinhood.pool!;
const [DRPC, OWN] = evmPoolVenues().robinhood.feeProviders!; // https://robinhood.drpc.org, https://rpc.mainnet.chain.robinhood.com
const FAKE = "not-a-key-0000000000000000"; // a path segment of 16 characters or more: where a provider puts its key
const SPARE_DRPC = `https://lb.drpc.live/robinhood/${FAKE}`;
const SPARE_QN = `https://made-up.robinhood-mainnet.quiknode.pro/${FAKE}/`;
const DEPTH = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;
const ARB_L1 = "0xf5d6ded7"; // ArbGasInfo getL1BaseFeeEstimate(), the kit's Robinhood chain fee read
const GWEI = 1_000_000_000n;
// a chain of 1 s blocks whose head, block HEAD, is now
const S = 1_800_000_000;
const HEAD = 100_000;
const NOW_MS = (S + HEAD) * 1000;
const block = (n: number) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(S + n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: `0x${GWEI.toString(16)}` });
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
/** dRPC's public endpoint's answer, as read 9 Nov 23:2xZ. */
const UNKNOWN_STATE = { status: 400, body: { code: 27, message: "Unknown state. First available state is 1" } };

type Call = { host: string; method: string; params: unknown[] };
/** Stubs fetch for the test: each host answers a chain read as the chain does, unless `fails` names it for eth_call. */
function stub(t: TestContext, fails: (host: string, method: string) => typeof UNKNOWN_STATE | null): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => {
    globalThis.fetch = real;
    Date.now = realNow;
  });
  Date.now = () => NOW_MS;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const host = new URL(String(u)).host;
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    calls.push({ host, method, params });
    const answer = (status: number, o: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...o }), { status, headers: { "content-type": "application/json" } });
    const f = fails(host, method);
    if (f !== null) return answer(f.status, { error: f.body });
    if (method === "eth_getBlockByNumber") return answer(200, { result: block(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))) });
    if (method === "eth_call") {
      const [{ to, data }] = params as [{ to: string; data: string }];
      return answer(200, { result: word(to === PIN && data === DEPTH ? 2n : data === ARB_L1 ? 3n : 0n) });
    }
    if (method === "eth_chainId") return answer(200, { result: "0x1237" });
    return answer(200, { error: { code: -32601, message: "no" } });
  }) as typeof fetch;
  return calls;
}
const ENV = { POOL_EVM_ADDRESS_ROBINHOOD: PIN, POOL_EVM_SENDER_KEY_ROBINHOOD: KEY, ROBINHOOD_RPC_URL_DRPC_1: SPARE_DRPC, ROBINHOOD_RPC_URL_QUICKNODE: SPARE_QN };
// the epoch a minute back: its first block is the first at or after its start
const EPOCH = NOW_MS - 60_000 - (NOW_MS % 60_000);
const FIRST = EPOCH / 1000 - S;
const FEE = evmPoolFee({ gas: evmPoolGas(2), gasPrice: GWEI, chainFee: evmPoolChainFee("robinhood", EVM_POOL_TX_BYTES, [3n]) });
const hashesOf = (calls: Call[]) => new Set(calls.filter((c) => c.method === "eth_call").map((c) => (c.params[1] as { blockHash: string }).blockHash));

test("one failed read on dRPC's public endpoint: the fee is read again on that side's keyed dRPC, at the same block hash, answers the epoch's fee, and one log line names the read, the host and its status", async (t) => {
  const calls = stub(t, (host, method) => (host === "robinhood.drpc.org" && method === "eth_call" ? UNKNOWN_STATE : null));
  const lines: string[] = [];
  const s = evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l)).get(PIN)!;
  const f = await s.fee(EPOCH + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.equal(f?.block, `0x${FIRST.toString(16)}`);
  // one block at one hash on two providers: every state read, on every provider, at the epoch's first block
  assert.deepEqual([...hashesOf(calls)], [block(FIRST).hash]);
  assert.ok(calls.some((c) => c.host === "lb.drpc.live" && c.method === "eth_call"), "side A's spare answered");
  assert.ok(calls.some((c) => c.host === "rpc.mainnet.chain.robinhood.com" && c.method === "eth_call"), "side B read it too");
  assert.ok(!calls.some((c) => c.host.endsWith("quiknode.pro")), "side B answered: its spare is never asked");
  // the epoch's fee, once read, answers every caller: a second ask reads nothing
  const n = calls.length;
  assert.equal((await s.fee(EPOCH + 2))?.fee, FEE.toString());
  assert.equal(calls.length, n);
  assert.equal(lines.length, 2, lines.join("\n")); // the depth and the chain fee read, each saved by the spare
  for (const l of lines) {
    assert.match(l, /^evm robinhood: eth_call 0x[0-9a-f]{8} .*failed at robinhood\.drpc\.org: HTTP 400: RPC error 27: Unknown state\. First available state is 1; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\) answered$/);
    assert.ok(!l.includes(FAKE), l);
  }
  assert.ok(lines[0]!.includes(DEPTH), lines[0]);
});

test("a read only one operator can answer: the fee route still fails (503 upstream, no throttle), and that answer writes one log line naming the read, each host and its status, never a key", async (t) => {
  let down = true;
  stub(t, (host, method) => (down && host !== "rpc.mainnet.chain.robinhood.com" && method === "eth_call" ? UNKNOWN_STATE : null));
  let at = NOW_MS;
  Date.now = () => at;
  const lines: string[] = [];
  const s = evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l)).get(PIN)!;
  await assert.rejects(s.fee(EPOCH + 1), (e: Error) => throttleOf(e) === 0);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^evm robinhood: fee upstream: .*eth_call 0x4a2b75c8 .*robinhood\.drpc\.org: HTTP 400: RPC error 27[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\): HTTP 400: RPC error 27[^;]*; quiknode\.pro \(ROBINHOOD_RPC_URL_QUICKNODE\): HTTP 400[^;]*; robinhood-rpc\.publicnode\.com: HTTP 400[^;]*; robinhood\.rpc\.blxrbdn\.com: HTTP 400[^;]*; rpc-robinhood\.globalstake\.io: HTTP 400/);
  assert.ok(!lines[0]!.includes("rpc.mainnet.chain.robinhood.com"), "the other side's operator is never asked for the first side");
  assert.ok(!lines[0]!.includes(FAKE), lines[0]);
  // the failed read answers its period's callers for EVM_FEE_MISS_MS (review of d190f62f, A-4), then the next caller
  // reads again, and once the provider answers, gets the fee
  down = false;
  await assert.rejects(s.fee(EPOCH + 1), (e: Error) => throttleOf(e) === 0);
  at += evm.EVM_FEE_MISS_MS;
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
});

// card helper-evm-ready-holds-a-fee: the start's check reads the seat list as the fee does. Before, it read the
// configured pair alone, so a start in one of dRPC's "Unknown state" periods (3 of 7 measured, 10 Nov) exited 2 and
// stopped the whole helper, though other operators held the state.
/** The block the start's check reads at: a proof's life back from now, on this chain of 1 s blocks. */
const OLD = block(HEAD - evm.POOL_LIFE_MAX_MS / 1000).hash;
const atOld = (calls: Call[]) => calls.filter((c) => c.method === "eth_call" && (c.params[1] as { blockHash: string }).blockHash === OLD);
test("(1) the configured pair's first operator refuses the state a proof's life back: the start passes on two other operators at once, with no wait", async (t) => {
  const DRPC_HOSTS = new Set(["robinhood.drpc.org", "lb.drpc.live"]);
  const calls = stub(t, (host, method) => (DRPC_HOSTS.has(host) && method === "eth_call" ? UNKNOWN_STATE : null));
  const waits: number[] = [];
  for (const env of [ENV, { POOL_EVM_ADDRESS_ROBINHOOD: PIN, POOL_EVM_SENDER_KEY_ROBINHOOD: KEY }]) {
    const n = calls.length;
    await evm.evmPoolSendersFromEnv(env, evmPoolVenues(), undefined, undefined, () => {}).get(PIN)!.ready(async (ms) => void waits.push(ms));
    const answered = new Set(atOld(calls.slice(n)).map((c) => c.host).filter((h) => !DRPC_HOSTS.has(h)));
    // each of the depth and the chain fee read on side B's own operator and on one past dRPC on side A
    assert.ok(answered.has("rpc.mainnet.chain.robinhood.com") && answered.size === 2, [...answered].join(", "));
  }
  assert.deepEqual(waits, []);
});

test("(3) one operator alone holds the state a proof's life back: the start asks again for its bound, then is refused, naming the variable, every seat and its answer, never a key", async (t) => {
  stub(t, (host, method) => (host !== "rpc.mainnet.chain.robinhood.com" && method === "eth_call" ? UNKNOWN_STATE : null));
  const waits: number[] = [];
  await assert.rejects(evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, () => {}).get(PIN)!.ready(async (ms) => void waits.push(ms)), (e: Error) => {
    assert.match(e.message, /^POOL_EVM_RPCS_ROBINHOOD: the fee's state at block 99400, 600 s old \(a proof's fee is read up to 600 s back\), 14 tries over 87 s: HTTP 400: RPC error 27: Unknown state\. First available state is 1 \(eth_call 0x4a2b75c8 .*robinhood\.drpc\.org: HTTP 400: RPC error 27[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\): HTTP 400[^;]*; quiknode\.pro \(ROBINHOOD_RPC_URL_QUICKNODE\): HTTP 400[^;]*; robinhood-rpc\.publicnode\.com: HTTP 400[^;]*; robinhood\.rpc\.blxrbdn\.com: HTTP 400[^;]*; rpc-robinhood\.globalstake\.io: HTTP 400/);
    assert.ok(!e.message.includes(FAKE), e.message);
    return true;
  });
  assert.equal(waits.reduce((x, y) => x + y), 87_000);
  assert.ok(waits.length === 13 && waits.every((w, i) => w === Math.min(1_000 * 2 ** i, 8_000)), waits.join(","));
});

test("one list of seats, each with its operator: the pair, the keyed URLs, the kit's quote providers, a URL listed before dropped; dRPC's keyed seats are dRPC's", () => {
  const seats = (pair: [string, string], keyed: string[], listed: readonly string[]) => evm.evmPoolSeats(pair, keyed.map((url, i) => ({ url, name: `s${i}` })), listed).map((p) => `${new URL(p.url).host} ${p.operator}`);
  const drpc = [1, 2, 3].map((k) => `https://lb.drpc.live/robinhood/${FAKE}${k}`);
  assert.deepEqual(seats([DRPC!, OWN!], [SPARE_QN, ...drpc], evmPoolVenues().robinhood.providers!), [
    "robinhood.drpc.org drpc.org", "rpc.mainnet.chain.robinhood.com robinhood.com", "made-up.robinhood-mainnet.quiknode.pro quiknode.pro",
    "lb.drpc.live drpc.org", "lb.drpc.live drpc.org", "lb.drpc.live drpc.org",
    "robinhood-rpc.publicnode.com publicnode.com", "robinhood.rpc.blxrbdn.com blxrbdn.com", "rpc-robinhood.globalstake.io globalstake.io",
  ]);
  // the pair's own URL set again as a key is no second seat
  assert.deepEqual(seats([DRPC!, OWN!], [`${DRPC}/`, OWN!], []), ["robinhood.drpc.org drpc.org", "rpc.mainnet.chain.robinhood.com robinhood.com"]);
});

test("a read on both sides never asks one operator for both: each side claims an operator before it asks it, and a side with none left fails", async () => {
  const seat = (name: string, operator: string, answer: () => Promise<unknown>): evm.EvmSeat => ({ name, url: `https://${name}.example`, operator, rpc: async () => answer() });
  const run = async (fails: ReadonlySet<string>) => {
    const seats = ["x", "y", "z"].map((op) => seat(op, op, async () => {
      if (fails.has(op)) throw new Error("HTTP 502");
      return `0x${op.charCodeAt(0).toString(16)}`;
    }));
    const pair = evm.evmReadPair(seats, ["x", "y"], { log: () => {} });
    return pair.both("eth_blockNumber", []);
  };
  // x fails: side 0 goes past y (side 1's) to z
  let [p, q] = await run(new Set(["x"]));
  assert.deepEqual([p.ok && p.operator, q.ok && q.operator], ["z", "y"]);
  // x and y fail: both go for z, one gets it, the other has none left
  [p, q] = await run(new Set(["x", "y"]));
  assert.equal([p, q].filter((r) => r.ok).length, 1);
  assert.equal([p, q].filter((r) => r.ok && r.operator === "z").length, 1);
  // a side's own read goes past its operator to the list's next, the other side's first last: x failing, z answers;
  // z failing too, y (side 1's) answers, as no claim of the other side's holds a read one side makes alone
  const down = (op: string, fails: ReadonlySet<string>) => seat(op, op, async () => (fails.has(op) ? Promise.reject(new Error("HTTP 502")) : `0x${op.charCodeAt(0).toString(16)}`));
  const alone = (fails: ReadonlySet<string>) => evm.evmReadPair(["x", "y", "z"].map((op) => down(op, fails)), ["x", "y"], { log: () => {} }).one(0, "eth_blockNumber", []);
  assert.equal(await alone(new Set(["x"])), "0x7a");
  assert.equal(await alone(new Set(["x", "z"])), "0x79");
});

// A read past its budget would wait on the hung spare forever: the test's own timeout is the bound, and the refusal names
// the 50 ms budget it ended on, not a clock read.
test("a read tries its side's next provider only within its budget, never on the chain's own answer, never on a held spare; all failed, it throws the first provider's words first", { timeout: 10_000 }, async () => {
  const lines: string[] = [];
  const asked: string[] = [];
  const p = (name: string, answer: () => Promise<unknown>, skip?: () => boolean) => ({ name, url: `https://${name}.example/${FAKE}`, operator: name, rpc: async () => (asked.push(name), answer()), ...(skip ? { skip } : {}) });
  const side = (seats: evm.EvmSeat[], o: { log: (l: string) => void; budgetMs?: number }): evm.EvmRpc => (method, params) => evm.evmReadPair(seats, [seats[0]!.operator, "none"], o).one(0, method, params);
  const fail = (m: string) => () => Promise.reject(new Error(m));
  const never = () => new Promise<never>(() => {});
  // a spare that hangs: the read ends at its budget, and the spare after it is not asked
  const r1 = side([p("a", fail("HTTP 503")), p("hang", never), p("late", async () => "0x1")], { log: (l) => void lines.push(l), budgetMs: 50 });
  await assert.rejects(r1("eth_blockNumber", []), (e: Error) => /^HTTP 503 \(eth_blockNumber/.test(e.message) && e.message.includes("hang: no answer in the read's 50 ms"));
  assert.deepEqual(asked, ["a", "hang"]);
  // the chain's own answer (a revert) is the same on any provider: thrown at once
  asked.length = 0;
  const r2 = side([p("a", fail("RPC error 3: execution reverted")), p("b", async () => "0x1")], { log: (l) => void lines.push(l) });
  await assert.rejects(r2("eth_estimateGas", [{}, "pending"]), (e: Error) => e.message === "RPC error 3: execution reverted");
  assert.deepEqual(asked, ["a"]);
  // a -32000 revert stays the chain's answer whatever its reason says (a contract's words may name a missing block)
  asked.length = 0;
  const r2b = side([p("a", fail("RPC error -32000: execution reverted: header not found")), p("b", async () => "0x1")], { log: (l) => void lines.push(l) });
  await assert.rejects(r2b("eth_call", [{}, "pending"]), (e: Error) => /^RPC error -32000: execution reverted/.test(e.message));
  assert.deepEqual(asked, ["a"]);
  // a held spare is passed over
  asked.length = 0;
  const r3 = side([p("a", fail("HTTP 502")), p("held", async () => "0x2", () => true), p("c", async () => "0x3")], { log: (l) => void lines.push(l) });
  assert.equal(await r3("eth_blockNumber", []), "0x3");
  assert.deepEqual(asked, ["a", "c"]);
  // a throttled first provider whose spares fail too stays a throttle (429 with its wait), as it was with no spare
  const r4 = side([p("a", fail("HTTP 429")), p("b", fail("HTTP 502"))], { log: () => {} });
  await assert.rejects(r4("eth_blockNumber", []), (e: Error) => throttleOf(e, true) > 0);
  assert.ok(lines.every((l) => !l.includes(FAKE)), lines.join("\n"));
});

// card helper-evm-read-two-operators: a pool read needs two different operators that agree, taken from the network's
// whole provider list (the kit's fee pair, the helper's keyed URLs, the kit's quote providers). On 10 Nov 04:2xZ the live
// helper answered GET /v1/pool/fee for the Robinhood mainnet pool 503 upstream for about 40 s on end: its first side was
// dRPC alone (robinhood.drpc.org and its three keyed lb.drpc.live seats), every seat refusing the same state, while
// QuickNode sat on the other side unasked. Each test below plants an operator's answers by host.
type Plant = { status: number; body: object } | { result: unknown } | null;
/** Stubs fetch: every host answers a 1 s chain as `block` makes it, unless `plant` answers for it. */
function chainStub(t: TestContext, plant: (host: string, method: string, params: unknown[]) => Plant): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => {
    globalThis.fetch = real;
    Date.now = realNow;
  });
  Date.now = () => NOW_MS;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const host = new URL(String(u)).host;
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    calls.push({ host, method, params });
    const answer = (status: number, o: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...o }), { status, headers: { "content-type": "application/json" } });
    const p = plant(host, method, params);
    if (p !== null) return "result" in p ? answer(200, { result: p.result }) : answer(p.status, { error: p.body });
    if (method === "eth_getBlockByNumber") return answer(200, { result: block(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))) });
    if (method === "eth_call") {
      const [{ to, data }] = params as [{ to: string; data: string }];
      return answer(200, { result: word(to.toLowerCase() === PIN || to.toLowerCase() === BASE_PIN || to.toLowerCase() === SEPOLIA_PIN ? (data === DEPTH ? 2n : 0n) : data === ARB_L1 ? 3n : 0n) });
    }
    // each chain's id, the kit's pin: Base Sepolia 84532, Base 8453, Robinhood 4663
    if (method === "eth_chainId") return answer(200, { result: /sepolia|testnet/.test(String(u)) ? "0x14a34" : /base/.test(String(u)) ? "0x2105" : "0x1237" });
    return answer(200, { error: { code: -32601, message: "no" } });
  }) as typeof fetch;
  return calls;
}
const BASE_PIN = evmPoolVenues().base.pool!.toLowerCase();
const SEPOLIA_PIN = evmPoolVenues()["base-sepolia"].pool!.toLowerCase();
const DRPC_HOSTS = new Set(["robinhood.drpc.org", "lb.drpc.live"]);
const ENV3 = { ...ENV, ROBINHOOD_RPC_URL_DRPC_2: `https://lb.drpc.live/robinhood/${FAKE}2`, ROBINHOOD_RPC_URL_DRPC_3: `https://lb.drpc.live/robinhood/${FAKE}3` };
const opFee = (network: string) => evmPoolFee({ gas: evmPoolGas(2), gasPrice: GWEI, chainFee: evmPoolChainFee(network, EVM_POOL_TX_BYTES, evmPoolChainFeeReads(network, evmPoolGas(2)).map((r) => (r.data === ARB_L1 ? 3n : 0n))) });
const stateReads = (calls: Call[], host: string) => calls.filter((c) => c.host === host && c.method === "eth_call").length;
const sendersOf = (env: Record<string, string>, lines: string[]) => evm.evmPoolSendersFromEnv(env, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l));

test("every seat of one operator refuses the state at the epoch block's hash: the read goes on to another operator the other side has not used, and the fee is answered by two operators, Robinhood's own and QuickNode, each named", async (t) => {
  const calls = chainStub(t, (host, method) => (DRPC_HOSTS.has(host) && method === "eth_call" ? UNKNOWN_STATE : null));
  const lines: string[] = [];
  const f = await sendersOf(ENV3, lines).get(PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.ok(stateReads(calls, "rpc.mainnet.chain.robinhood.com") > 0 && calls.some((c) => c.host.endsWith("quiknode.pro") && c.method === "eth_call"), "Robinhood's own and QuickNode answered the state reads");
  assert.deepEqual([...hashesOf(calls)], [block(FIRST).hash]);
  assert.equal(lines.length, 2, lines.join("\n"));
  for (const l of lines) {
    assert.match(l, /^evm robinhood: eth_call 0x[0-9a-f]{8} .*failed at robinhood\.drpc\.org: HTTP 400: RPC error 27[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\): HTTP 400[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_2\): HTTP 400[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_3\): HTTP 400[^;]*; quiknode\.pro \(ROBINHOOD_RPC_URL_QUICKNODE\) answered$/);
    assert.ok(!l.includes(FAKE), l);
  }
});

test("one operator answers a block by number null (its node behind): the first-block search and the block's check go on to another operator, and the fee is answered", async (t) => {
  const calls = chainStub(t, (host, method, params) => (DRPC_HOSTS.has(host) && method === "eth_getBlockByNumber" && params[0] !== "latest" ? { result: null } : null));
  const lines: string[] = [];
  const f = await sendersOf(ENV3, lines).get(PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.equal(f?.block, `0x${FIRST.toString(16)}`);
  assert.ok(calls.some((c) => c.host.endsWith("quiknode.pro") && c.method === "eth_getBlockByNumber"), "the block's check on the first side went on to QuickNode");
  assert.ok(lines.length > 0 && lines.every((l) => /^evm robinhood: eth_getBlockByNumber failed at robinhood\.drpc\.org: [^;]*null[^;]*;.* answered$/.test(l)), lines.join("\n"));
});

test("two operators that both answered and differ on the block's hash are a refusal, never settled by a third that agrees with one", async (t) => {
  // dRPC and QuickNode name one hash for every block, Robinhood's own another
  const other = (n: number) => ({ ...block(n), hash: `0x${(n + 7).toString(16).padStart(64, "0")}` });
  chainStub(t, (host, method, params) => (host === "rpc.mainnet.chain.robinhood.com" && method === "eth_getBlockByNumber" ? { result: other(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))) } : null));
  const lines: string[] = [];
  await assert.rejects(sendersOf(ENV3, lines).get(PIN)!.fee(EPOCH + 1), (e: Error) => /different blocks/.test(e.message) && throttleOf(e) === 0);
});

test("two operators that both answered and differ on a state word at the block's hash are a refusal: dRPC refusing the state, QuickNode reads the depth 3 where Robinhood's own reads 2", async (t) => {
  chainStub(t, (host, method, params) => {
    if (DRPC_HOSTS.has(host) && method === "eth_call") return UNKNOWN_STATE;
    const [c] = params as [{ data?: string }];
    return host.endsWith("quiknode.pro") && method === "eth_call" && c?.data === DEPTH ? { result: word(3n) } : null;
  });
  await assert.rejects(sendersOf(ENV3, []).get(PIN)!.fee(EPOCH + 1), (e: Error) => /differ on 0x4a2b75c8/.test(e.message) && throttleOf(e) === 0);
});

test("only one operator alive: every read is refused 503 upstream (no throttle), never answered on that operator's word alone", async (t) => {
  const down = { status: 503, body: { code: -32603, message: "down" } };
  const calls = chainStub(t, (host) => (host === "rpc.mainnet.chain.robinhood.com" ? null : down));
  const lines: string[] = [];
  await assert.rejects(sendersOf(ENV3, lines).get(PIN)!.fee(EPOCH + 1), (e: Error) => throttleOf(e) === 0);
  const up = lines.filter((l) => /^evm robinhood: fee upstream: /.test(l));
  assert.equal(up.length, 1, lines.join("\n"));
  assert.ok(lines.every((l) => l === up[0] || / answered$/.test(l)), lines.join("\n"));
  assert.ok(!up[0]!.includes(FAKE), up[0]);
  assert.ok(!calls.some((c) => c.method === "eth_call"), "no state read once the block could not be read on two operators");
});

test("Base: a provider's -32000 'historical state … is not available' is that provider's miss, not the chain's answer: the side goes on to another operator", async (t) => {
  const pruned = { status: 200, body: { code: -32000, message: "historical state 39472d03baeb94e12253378cd8b493da681edf67f51e92bf826e24fec1b0a137 is not available" } };
  const calls = chainStub(t, (host, method) => (host === "base-rpc.publicnode.com" && method === "eth_call" ? pruned : null));
  const lines: string[] = [];
  const env = { POOL_EVM_ADDRESS_BASE: evmPoolVenues().base.pool!, POOL_EVM_SENDER_KEY_BASE: KEY, BASE_RPC_URL_DRPC_1: `https://lb.drpc.live/base/${FAKE}` };
  const f = await sendersOf(env, lines).get(BASE_PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, opFee("base").toString());
  assert.ok(stateReads(calls, "lb.drpc.live") > 0, "another operator answered the state reads");
  assert.ok(lines.length > 0 && lines.every((l) => /failed at base-rpc\.publicnode\.com: RPC error -32000: historical state [0-9a-f]+ is not available.* answered$/.test(l)), lines.join("\n"));
});

test("a test network reads past its pair too: Base Sepolia's first provider refusing the state, the fee is answered by publicnode and Pocket", async (t) => {
  const calls = chainStub(t, (host, method) => (host === "sepolia.base.org" && method === "eth_call" ? UNKNOWN_STATE : null));
  const lines: string[] = [];
  const env = { POOL_EVM_ADDRESS_BASE_SEPOLIA: evmPoolVenues()["base-sepolia"].pool!, POOL_EVM_SENDER_KEY_BASE_SEPOLIA: KEY };
  const f = await sendersOf(env, lines).get(SEPOLIA_PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, opFee("base-sepolia").toString());
  assert.ok(stateReads(calls, "base-sepolia-rpc.publicnode.com") > 0 && stateReads(calls, "base-testnet.api.pocket.network") > 0, "publicnode and Pocket answered");
});

test("a read each side fails, one side on a throttle: the answer stays a throttle (429 with its wait), never the other side's 503", async (t) => {
  chainStub(t, (host, method) => (method !== "eth_call" ? null : host === "rpc.mainnet.chain.robinhood.com" ? { status: 429, body: { code: -32005, message: "too many requests" } } : { status: 502, body: { code: -32603, message: "bad gateway" } }));
  await assert.rejects(sendersOf(ENV3, []).get(PIN)!.fee(EPOCH + 1), (e: Error) => throttleOf(e) > 0);
});

// review of 686dda50 (F1): which block is the period's first, and its base fee, are never one operator's word. Each
// plant answers through a public quote seat (publicnode) while dRPC's node is behind (its block reads null), so the
// search walks to publicnode
const PUBLIC = { POOL_EVM_ADDRESS_ROBINHOOD: PIN, POOL_EVM_SENDER_KEY_ROBINHOOD: KEY }; // no keyed seat: the public operators alone
// dRPC's node behind: its newest block 20 blocks before the period's first, every block after it unknown (null)
const DRPC_HEAD = FIRST - 20;
const DRPC_BEHIND = (host: string, method: string, params: unknown[]): Plant => {
  if (!DRPC_HOSTS.has(host) || method !== "eth_getBlockByNumber") return null;
  if (params[0] === "latest") return { result: block(DRPC_HEAD) };
  return Number(BigInt(params[0] as string)) > DRPC_HEAD ? { result: null } : null;
};
test("F1: a seat naming the period's first block's true hash with a base fee 1000 times the chain's is refused (two operators agree on the hash, number, time and base fee), never published", async (t) => {
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber") return { result: { ...block(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))), baseFeePerGas: `0x${(1000n * GWEI).toString(16)}` } };
    return DRPC_BEHIND(host, method, params);
  });
  await assert.rejects(sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
});
test("F1b: a seat naming an earlier real block with a time 7 s late is refused: the block before the one named must be before the period on two operators", async (t) => {
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string));
      return { result: { ...block(n), timestamp: `0x${(S + n + 7).toString(16)}` } };
    }
    return DRPC_BEHIND(host, method, params);
  });
  await assert.rejects(sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
});
test("F1c: every operator honest, the fee reads the period's first block on two operators, the one before it on two as well", async (t) => {
  const calls = chainStub(t, () => null);
  const f = await sendersOf(ENV, []).get(PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.equal(f?.block, `0x${FIRST.toString(16)}`);
  for (const n of [FIRST, FIRST - 1]) {
    const by = new Set(calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] === `0x${n.toString(16)}`).map((c) => c.host));
    assert.ok(by.size >= 2, `block ${n} on ${[...by].join(",")}`);
  }
});

// review of 686dda50 (F2): a revert is the chain's answer whatever its reason says: never a walk, never a hold
test("F2: a code-3 revert or a -32000 'execution reverted' whose reason names a limit or a rate is the chain's answer: asked on one seat, no provider held; a real throttle still holds", async () => {
  const holds = providerHolds(() => 0, {});
  for (const err of ["RPC error 3: execution reverted: Max wallet limit exceeded", "RPC error 3: execution reverted: rate limit", "RPC error -32000: execution reverted: too many requests"]) {
    const asked: string[] = [];
    const names = [["a1", "a"], ["b1", "b"], ["c1", "c"], ["a2", "a"], ["d1", "d"]] as const;
    const seats: evm.EvmSeat[] = names.map(([name, operator]) => {
      const url = `https://${name}-${err.length}.example`;
      return { name, url, operator, rpc: evm.pacedEvmRpc(url, async () => (asked.push(name), Promise.reject(new Error(err))), holds, async () => {}) };
    });
    const e = await evm.evmReadPair(seats, ["a", "b"], { log: () => {} }).one(0, "eth_call", [{}, "pending"]).then(() => null, (x: Error) => x);
    assert.equal(e?.message, err);
    assert.deepEqual(asked, ["a1"], err);
    assert.deepEqual(seats.filter((s) => holds.heldMs(s.url) > 0).map((s) => s.name), [], err);
  }
  // a provider's throttle, HTTP 429 or -32005 with no revert: held, and the walk goes on
  for (const err of ["HTTP 429: Too Many Requests", "RPC error -32005: project ID request rate exceeded"]) {
    const asked: string[] = [];
    const url = `https://t-${err.length}.example`;
    const seats: evm.EvmSeat[] = [
      { name: "t", url, operator: "a", rpc: evm.pacedEvmRpc(url, async () => (asked.push("t"), Promise.reject(new Error(err))), holds, async () => {}) },
      { name: "u", url: "https://u.example", operator: "c", rpc: async () => (asked.push("u"), "0x1") },
    ];
    assert.equal(await evm.evmReadPair(seats, ["a", "b"], { log: () => {} }).one(0, "eth_blockNumber", []), "0x1");
    assert.deepEqual(asked, ["t", "u"]);
    assert.ok(holds.heldMs(url) > 0, err);
  }
});
test("F2 at the route: a sale's simulation reverting 'Max wallet limit exceeded' is the chain's answer, failedInExecution, never the provider's", () => {
  assert.equal(evm.evmChainAnswered(new Error("RPC error 3: execution reverted: Max wallet limit exceeded")), true);
  assert.equal(evm.evmChainAnswered(new Error("RPC error -32000: execution reverted: rate limit")), true);
  assert.equal(evm.evmChainAnswered(new Error("RPC error -32000: header not found")), false);
  assert.equal(evm.evmChainAnswered(new Error("RPC error -32005: limit exceeded")), false);
  assert.equal(evm.evmChainAnswered(new Error("RPC error -32000: rate limit exceeded")), false);
});

// review of 686dda50 (F3): a held seat, the first included, is passed over while another unclaimed operator can answer
test("F3: a first seat held 8 s is passed over: the side asks the next operator at once, and asks the held seat only when no other answered", async () => {
  let t = 0;
  const now = () => t;
  const holds = providerHolds(now, {});
  const PAIR = "https://pair.example";
  holds.hold(PAIR, 8);
  const asked: string[] = [];
  const skip = () => holds.heldMs(PAIR) > 0;
  const pairRpc = evm.pacedEvmRpc(PAIR, async () => (asked.push("pair"), "0x9"), holds, async (ms) => void (t += ms));
  const seats = (third: boolean): evm.EvmSeat[] => [
    { name: "pair", url: PAIR, operator: "x", rpc: pairRpc, skip },
    { name: "other", url: "https://other.example", operator: "y", rpc: async () => "0x0" },
    ...(third ? [{ name: "keyed", url: "https://keyed.example", operator: "z", rpc: async () => (asked.push("keyed"), "0x1") }] : []),
  ];
  const [p, q] = await evm.evmReadPair(seats(true), ["x", "y"], { log: () => {}, now }).both("eth_blockNumber", []);
  assert.ok(p.ok && p.operator === "z" && q.ok && q.operator === "y");
  assert.deepEqual(asked, ["keyed"]);
  assert.equal(t, 0, "no hold waited out");
  // no other operator: the held seat is asked last, its hold waited out
  asked.length = 0;
  const [p2] = await evm.evmReadPair(seats(false), ["x", "y"], { log: () => {}, now }).both("eth_blockNumber", []);
  assert.ok(p2.ok && p2.operator === "x", p2.ok ? p2.operator : String(p2.error));
  assert.deepEqual(asked, ["pair"]);
});
test("F3: a side's read is bounded at EVM_READ_BUDGET_MS from its start, checked before each next seat; the first seat is never cut", async () => {
  let t = 0;
  const now = () => t;
  const slow = (name: string, ms: number, asked: string[]): evm.EvmSeat => ({ name, url: `https://${name}.example`, operator: name, rpc: async () => (asked.push(name), (t += ms), Promise.reject(new Error("HTTP 502"))) });
  // each seat fails 4 s in: the first (0-4 s) and the second (4-8 s, started inside the 6 s) are asked, never the third
  const asked: string[] = [];
  const pair = evm.evmReadPair([slow("a", 4_000, asked), slow("c", 4_000, asked), slow("d", 4_000, asked), slow("b", 0, [])], ["a", "b"], { log: () => {}, now });
  await assert.rejects(pair.one(0, "eth_blockNumber", []));
  assert.deepEqual(asked, ["a", "c"]);
  // the first seat answering after the budget's time is never cut: its answer stands
  const late: evm.EvmSeat = { name: "l", url: "https://l.example", operator: "l", rpc: () => new Promise((ok) => setTimeout(() => ok("0x5"), 40)) };
  assert.equal(await evm.evmReadPair([late, slow("m", 0, [])], ["l", "m"], { log: () => {}, budgetMs: 5 }).one(0, "eth_blockNumber", []), "0x5");
});

// review of 686dda50: "already known" on a send is the send accepted (the node holds the transaction: a first seat that
// timed out after it passed it on, or the other side's), never a refusal
test("a send every seat answers 'already known' is the send accepted: the caller gets 200 and its hash", async () => {
  const send = (await import("./evm.ts")).evmSendAccepted;
  assert.equal(send({ status: "rejected", reason: new Error("RPC error -32000: already known") }), true);
  assert.equal(send({ status: "rejected", reason: new Error("RPC error -32010: Transaction with the same hash was already imported.") }), true);
  assert.equal(send({ status: "rejected", reason: new Error("RPC error -32000: nonce too low") }), false);
  assert.equal(send({ status: "rejected", reason: new Error("HTTP 502") }), false);
  assert.equal(send({ status: "fulfilled", value: "0xab" }), true);
});
test("F1d: the confirm reads both sides: a seat that names the true block to the search and another base fee when the block is read again is refused", async (t) => {
  let asked = 0;
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber" && params[0] === `0x${FIRST.toString(16)}` && asked++ > 0) return { result: { ...block(FIRST), baseFeePerGas: `0x${(7n * GWEI).toString(16)}` } };
    return DRPC_BEHIND(host, method, params);
  });
  await assert.rejects(sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
});

// review of 686dda50, the survivors: each wording of a missing block or state walks on (geth's "header not found" is
// Robinhood's live wording); a revert never does, in any case of its words; in code 3 or -32003 nothing is a miss
test("each wording of a block or state the node lacks walks to the next operator; the same words in a revert, a code 3 or a -32003 answer are the chain's", async () => {
  const run = async (err: string) => {
    const asked: string[] = [];
    const seats: evm.EvmSeat[] = [
      { name: "a1", url: "https://a1.example", operator: "a", rpc: async () => (asked.push("a1"), Promise.reject(new Error(err))) },
      { name: "c1", url: "https://c1.example", operator: "c", rpc: async () => (asked.push("c1"), "0x1") },
    ];
    const v = await evm.evmReadPair(seats, ["a", "b"], { log: () => {} }).one(0, "eth_call", [{}, { blockHash: "0x01" }]).then((x) => x, () => "thrown");
    return { v, asked };
  };
  for (const words of ["header not found", "missing trie node 0b1e (path )", "unknown block", "unknown state", "archive requests require a paid plan", "block 0x5 not found", "historical state ab is not available"]) {
    assert.deepEqual(await run(`RPC error -32000: ${words}`), { v: "0x1", asked: ["a1", "c1"] }, words);
  }
  for (const err of ["RPC error -32000: execution reverted: header not found", "RPC error -32000: Execution reverted: unknown block", "RPC error 3: header not found", "RPC error -32003: missing trie node"]) {
    assert.deepEqual(await run(err), { v: "thrown", asked: ["a1"] }, err);
  }
});

test("a null receipt or transaction is an answer (not mined, not known), never a walk; a block read answered null or not an object walks on; a side with no operator left says so", async () => {
  const asked: string[] = [];
  const seat = (name: string, op: string, v: unknown): evm.EvmSeat => ({ name, url: `https://${name}.example`, operator: op, rpc: async () => (asked.push(name), v) });
  const pair = evm.evmReadPair([seat("a1", "a", null), seat("c1", "c", { hash: "0x" })], ["a", "b"], { log: () => {} });
  for (const m of ["eth_getTransactionReceipt", "eth_getTransactionByHash"]) {
    asked.length = 0;
    assert.equal(await pair.one(0, m, ["0x01"]), null, m);
    assert.deepEqual(asked, ["a1"], m);
  }
  for (const v of [null, "0x5", 7]) {
    asked.length = 0;
    const p2 = evm.evmReadPair([seat("a1", "a", v), seat("c1", "c", { hash: "0x" })], ["a", "b"], { log: () => {} });
    assert.deepEqual(await p2.one(0, "eth_getBlockByNumber", ["0x1", false]), { hash: "0x" }, String(v));
    assert.deepEqual(asked, ["a1", "c1"]);
  }
  const lone = evm.evmReadPair([seat("b1", "b", "0x1")], ["a", "b"], { log: () => {} });
  const [x] = await lone.both("eth_blockNumber", []);
  assert.ok(!x.ok && /no operator left apart from the other side's/.test(String((x.error as Error).message)));
});

test("the env's seats: the pair and the keyed URLs draw on the sender's reserve, the kit's quote providers do not; every seat, the pair's included, is passed over while held", async (t) => {
  chainStub(t, () => null);
  const real = providerHolds(() => 0, {});
  const reserved: string[] = [];
  const holds = { ...real, reserve: (u: string) => (reserved.push(u), real.reserve(u)) };
  const waits: number[] = [];
  const s = evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), holds, async (ms) => void waits.push(ms), () => {}).get(PIN)!;
  assert.deepEqual(reserved.map((u) => new URL(u).host).sort(), ["lb.drpc.live", "made-up.robinhood-mainnet.quiknode.pro", "robinhood.drpc.org", "rpc.mainnet.chain.robinhood.com"]);
  real.hold(DRPC!, 30);
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
  assert.deepEqual(waits.filter((w) => w >= 1_000), [], "no hold waited out");
});

test("a seat's words are cleared of every URL's secret part before a log line or an error holds them, though the provider echoes its URL", async (t) => {
  chainStub(t, (host, method) => (method === "eth_call" && DRPC_HOSTS.has(host) ? { status: 400, body: { code: -32602, message: `bad request to ${SPARE_DRPC} (key ${FAKE})` } } : null));
  const lines: string[] = [];
  assert.equal((await sendersOf(ENV, lines).get(PIN)!.fee(EPOCH + 1))?.fee, FEE.toString());
  assert.ok(lines.length > 0);
  for (const l of lines) {
    assert.ok(!l.includes(FAKE) && l.includes("<key>"), l);
  }
});
test("F1e: a search that lands past the period's first block (a seat naming the three blocks before it with a time before the period, their true hashes) is refused: the block before the one named is in the period on the other operator", async (t) => {
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber" && params[0] !== "latest") {
      const n = Number(BigInt(params[0] as string));
      if (n >= FIRST && n <= FIRST + 2) return { result: { ...block(n), timestamp: `0x${(S + FIRST - 1).toString(16)}` } };
    }
    return DRPC_BEHIND(host, method, params);
  });
  await assert.rejects(sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
});

// review of d190f62f (A-1): the search starts from the newer of two operators' newest blocks. On the live chain
// robinhood.drpc.org, side a's first seat, ran up to 20 s behind; its "latest" alone put the period's first block in the
// future, and the fee was answered "no fee yet" though every other operator held it
test("A-1: dRPC 20 s behind (its newest block 10 s before the period's start) and every other operator at the head: the fee is read on the first try", async (t) => {
  const CUR = EPOCH + 60_000; // the period now running, its first block HEAD - 40
  const top = HEAD - 30; // the chain's head, 10 s into the period
  const lag = top - 20;
  chainStub(t, (host, method, params) => {
    if (method !== "eth_getBlockByNumber") return null;
    const head = DRPC_HOSTS.has(host) ? lag : top;
    if (params[0] === "latest") return { result: block(head) };
    return Number(BigInt(params[0] as string)) > head ? { result: null } : null;
  });
  const f = await sendersOf(PUBLIC, []).get(PIN)!.fee(CUR + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.equal(f?.block, `0x${(CUR / 1000 - S).toString(16)}`);
});

// review of d190f62f (A-3): "known transaction" is a node's word for one it holds; "unknown transaction type" is a refusal
test("A-3: a send refused 'unknown transaction type' is a refusal, never the send accepted; 'known transaction' is", async () => {
  assert.equal(evm.evmSendAccepted({ status: "rejected", reason: new Error("RPC error -32000: unknown transaction type") }), false);
  assert.equal(evm.evmSendAccepted({ status: "rejected", reason: new Error("RPC error -32000: Unknown Transaction Type 0x7f") }), false);
  assert.equal(evm.evmSendAccepted({ status: "rejected", reason: new Error("RPC error -32000: known transaction: 0xab") }), true);
});

// review of d190f62f (A-2): a search on side a that names a block the two operators do not agree on (a node of dRPC's
// balancer on a short fork, once) runs once more on side b, whose block the two then agree on: the fee is answered
test("A-2: the first search names a block of a fork dRPC answered once; the search runs again on the other side and the fee is answered", async (t) => {
  const seen = new Set<number>();
  chainStub(t, (host, method, params) => {
    if (host !== "robinhood.drpc.org" || method !== "eth_getBlockByNumber" || params[0] === "latest") return null;
    const n = Number(BigInt(params[0] as string));
    if (n < FIRST || seen.has(n)) return null;
    seen.add(n);
    return { result: { ...block(n), hash: `0x${(n + 7).toString(16).padStart(64, "f")}` } };
  });
  const f = await sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1);
  assert.equal(f?.fee, FEE.toString());
  assert.equal(f?.block, `0x${FIRST.toString(16)}`);
});
test("A-2: the search on the other side meets the same disagreement: refused; the newest blocks read once, on two operators", async (t) => {
  const calls = chainStub(t, (host, method, params) => (host === "rpc.mainnet.chain.robinhood.com" && method === "eth_getBlockByNumber" ? { result: { ...block(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))), hash: `0x${"e".repeat(64)}` } } : null));
  await assert.rejects(sendersOf(PUBLIC, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
  assert.equal(calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest").length, 2, "the newest block read once, on two operators");
});

// review of d190f62f (A-4): a fee read that failed is kept EVM_FEE_MISS_MS before it is read again, so one caller asking
// for every unreadable period of a proof's life over and over makes one read per period, not one per request
test("A-4: 30 requests for 10 unreadable periods within 2 s read each period once; 2 s later a request reads again", async (t) => {
  const calls = chainStub(t, (_host, method) => (method === "eth_call" ? UNKNOWN_STATE : null));
  let at = NOW_MS;
  Date.now = () => at;
  const s = sendersOf(PUBLIC, []).get(PIN)!;
  await assert.rejects(s.fee(EPOCH + 1));
  const one = calls.length;
  assert.ok(one > 0);
  calls.length = 0;
  for (let i = 0; i < 30; i++) {
    at = NOW_MS + i * 60;
    await assert.rejects(s.fee(EPOCH + 60_000 - (i % 10) * 60_000 + 1));
  }
  assert.ok(calls.length <= 10 * one, `${calls.length} provider calls for 30 requests (one read: ${one})`);
  calls.length = 0;
  at = NOW_MS + 30 * 60 + evm.EVM_FEE_MISS_MS;
  await assert.rejects(s.fee(EPOCH + 1));
  assert.ok(calls.length > 0, "read again once the miss is 2 s old");
});

// ---- card helper-evm-ready-holds-a-fee, review of 2bcfd4e0: seats that are wrong, hang, lag or fill their words with
// their own URL. Each provider is a stub of fetch on the chain above, its clock the test's own (`at.T`); `plant` answers
// in a provider's place when it returns anything ----
type Planted = Response | { error: object; status?: number } | { result: unknown } | null;
function planted(t: TestContext, plant: (host: string, method: string, params: unknown[], url: string) => Planted, at: { T: number }, lag: ReadonlyMap<string, number> = new Map()): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => {
    globalThis.fetch = real;
    Date.now = realNow;
  });
  Date.now = () => at.T;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const host = new URL(String(u)).host;
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    calls.push({ host, method, params });
    const answer = (status: number, o: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...o }), { status, headers: { "content-type": "application/json" } });
    const p = plant(host, method, params, String(u));
    if (p instanceof Response) return p;
    if (p !== null) return "result" in p ? answer(200, { result: p.result }) : answer(p.status ?? 200, { error: p.error });
    const head = Math.floor(at.T / 1000) - S - (lag.get(host) ?? 0);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? head : Number(BigInt(params[0] as string));
      return answer(200, { result: n > head ? null : block(n) });
    }
    if (method === "eth_call") {
      const [{ to, data }] = params as [{ to: string; data: string }];
      return answer(200, { result: word(to.toLowerCase() === PIN.toLowerCase() && data === DEPTH ? 2n : data === ARB_L1 ? 3n : 0n) });
    }
    if (method === "eth_chainId") return answer(200, { result: "0x1237" }); // Robinhood, 4663, the kit's pin
    return answer(200, { error: { code: -32601, message: "no" } });
  }) as typeof fetch;
  return calls;
}
const ENV_RH = { POOL_EVM_ADDRESS_ROBINHOOD: PIN, POOL_EVM_SENDER_KEY_ROBINHOOD: KEY };
/** ready() on the test's clock, each wait moving it: "ready" or the refusal's words, the waits, and the whole text. */
async function readyOn(s: evm.EvmPoolSender, at: { T: number }): Promise<{ out: string; waits: number[] }> {
  const waits: number[] = [];
  const out = await s.ready(async (ms) => void (waits.push(ms), (at.T += ms))).then(() => "ready", (e: Error) => e.message);
  return { out, waits };
}
const sendersWith = (env: Record<string, string>, lines: string[] = []) => evm.evmPoolSendersFromEnv(env, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l));
/** Another chain's node (Ethereum's id), its own blocks, newest `head`; a block hash of ours is unknown to it. */
const otherChain = (head: number) => (method: string, params: unknown[]): Planted => {
  if (method === "eth_chainId") return { result: "0x1" };
  if (method === "eth_getBlockByNumber") {
    const n = params[0] === "latest" ? head : Number(BigInt(params[0] as string));
    return { result: n > head ? null : { ...block(n), hash: `0xee${n.toString(16).padStart(62, "0")}` } };
  }
  if (method === "eth_call") return { error: { code: -32000, message: "header not found" } };
  return null;
};

test("review P2-1: a pair seat on another chain, either side, its newest block under or over ours, refuses the start at once naming both seats and both chains, before any block read", async (t) => {
  const at = { T: NOW_MS };
  let bad: { host: string; f: ReturnType<typeof otherChain> } | null = null;
  const calls = planted(t, (host, method, params) => (bad !== null && host === bad.host ? bad.f(method, params) : null), at);
  for (const host of ["robinhood.drpc.org", "rpc.mainnet.chain.robinhood.com"]) {
    for (const head of [5_000, 900_000_000]) {
      bad = { host, f: otherChain(head) };
      at.T = NOW_MS;
      calls.length = 0;
      const r = await readyOn(sendersWith(ENV_RH).get(PIN)!, at);
      assert.match(r.out, /^POOL_EVM_RPCS_ROBINHOOD: the fee's state, 1 try over 0 s: two chains: (robinhood\.drpc\.org names chain 1, rpc\.mainnet\.chain\.robinhood\.com chain 4663|robinhood\.drpc\.org names chain 4663, rpc\.mainnet\.chain\.robinhood\.com chain 1)$/, `${host} ${head}`);
      assert.deepEqual([r.waits, calls.map((c) => c.method)], [[], ["eth_chainId", "eth_chainId"]], `${host} ${head}`);
    }
  }
});

test("review P3-6: a refusal and every log line hold no part of a seat's key, whatever branch built them: a 40-character key in a path and in a query, each echoed by its seat whole, cut, upper-cased, encoded or in a revert's data", async (t) => {
  const K_PATH = "pathKEY-0123456789abcdef0123456789abcdef";
  const K_QUERY = "queryKEY-fedcba9876543210fedcba9876543210";
  const ENV_KEYS = { ...ENV_RH, POOL_EVM_RPCS_ROBINHOOD: `https://a.example/v2/${K_PATH},https://b.example/rpc?apikey=${K_QUERY}` };
  const QUOTE = new Set(evmPoolVenues().robinhood.providers!.map((u) => new URL(u).host));
  const at = { T: NOW_MS };
  let how: (host: string, method: string, params: unknown[], url: string) => Planted = () => null;
  planted(t, (...a) => how(...a), at);
  const mine = (host: string) => host === "a.example" || host === "b.example";
  // no third operator holds the state, so each case's answer is the one its seat gave
  const onState = (f: (url: string) => Planted) => (host: string, method: string, _p: unknown[], url: string): Planted =>
    QUOTE.has(host) && method === "eth_call" ? { error: { code: -32000, message: "header not found" } } : mine(host) && method === "eth_call" ? f(url) : null;
  const keyOf = (url: string) => (url.includes("?") ? K_QUERY : K_PATH);
  const cases: [string, typeof how][] = [
    ["HTTP 400, the URL in the message", onState((url) => ({ status: 400, error: { code: -32602, message: `bad request to ${url}` } }))],
    ["-32000 that is no state miss, the URL in the message", onState((url) => ({ error: { code: -32000, message: `upstream ${url} failed` } }))],
    ["a revert, the URL in its data", onState((url) => ({ error: { code: 3, message: "execution reverted", data: url } }))],
    ["a message the client's 120-character cut ends inside the key", onState((url) => ({ status: 400, error: { code: -32603, message: `${"x".repeat(Math.max(0, 120 - url.length + 14))}${url}` } }))],
    ["the URL percent-encoded", onState((url) => ({ status: 400, error: { code: -32603, message: `no route for ${encodeURIComponent(url)}` } }))],
    ["the key alone, upper-cased", onState((url) => ({ status: 400, error: { code: -32603, message: `key ${keyOf(url).toUpperCase()} is over its plan` } }))],
    ["the key alone, cut", onState((url) => ({ status: 400, error: { code: -32603, message: `${"y".repeat(100)} key ${keyOf(url)}` } }))],
    ["a block read answered with the URL", (host, method, _p, url) => (mine(host) && method === "eth_getBlockByNumber" ? { result: { hash: url, number: url, timestamp: url } } : QUOTE.has(host) && method === "eth_getBlockByNumber" ? { result: null } : null)],
    ["the transport failing with the URL in its words", (host, method, _p, url) => {
      if (mine(host)) throw new TypeError(`request to ${url} failed, reason: connect ECONNREFUSED`);
      return QUOTE.has(host) && method !== "eth_chainId" ? { error: { code: -32000, message: "header not found" } } : null;
    }],
  ];
  for (const [name, f] of cases) {
    how = f;
    at.T = NOW_MS;
    const lines: string[] = [];
    const r = await readyOn(sendersWith(ENV_KEYS, lines).get(PIN)!, at);
    assert.notEqual(r.out, "ready", name);
    for (const text of [r.out, ...lines]) {
      const low = text.toLowerCase();
      for (const k of [K_PATH, K_QUERY]) assert.ok(!low.includes(k.slice(0, 8).toLowerCase()) && !text.includes(encodeURIComponent(k).slice(0, 8)), `${name}: ${text}`);
      assert.ok(!/https?:\/\//i.test(text), `${name}: a URL left in ${text}`);
    }
  }
});

test("review P2-2: a seat that hangs to its client's timeout is asked once and passed over after it, one line naming it; the start is ready on two other operators, and a later fee read never waits on it", async (t) => {
  const at = { T: NOW_MS };
  const hang = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const calls = planted(t, (host) => {
    if (host === "robinhood.drpc.org") throw hang; // the kit client's AbortSignal.timeout, as it ends
    return null;
  }, at);
  const lines: string[] = [];
  const s = sendersWith(ENV_RH, lines).get(PIN)!;
  const r = await readyOn(s, at);
  assert.deepEqual([r.out, r.waits], ["ready", []]);
  // asked once for a read, and once for its chain id with every seat's at the start (review of f86e1c27, P3-4)
  assert.deepEqual(calls.filter((c) => c.host === "robinhood.drpc.org").map((c) => c.method), ["eth_chainId"], "asked once, then passed over (review of 41c6c371, P3-1: the start's read of every seat's chain passes over a held one)");
  const said = lines.filter((l) => l.includes("passed over"));
  assert.equal(said.length, 1, lines.join("\n"));
  assert.match(said[0]!, /^evm robinhood: robinhood\.drpc\.org passed over 30 s at a time from now: The operation was aborted due to timeout$/);
  // a send's fee read of an earlier period, after the start: never asks it
  const n = calls.length;
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
  assert.ok(calls.length > n && calls.slice(n).every((c) => c.host !== "robinhood.drpc.org"));
});

test("review P2-2: a held seat never lets one operator count twice: dRPC's public seat hangs, its keyed seats alone hold the state, every other operator pruned: refused at the bound", async (t) => {
  const at = { T: NOW_MS };
  const hang = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  planted(t, (host, method) => {
    if (host === "robinhood.drpc.org") throw hang;
    if (method === "eth_call" && host !== "lb.drpc.live") return { error: { code: -32000, message: `historical state ${"ab".repeat(32)} is not available` } };
    return null;
  }, at);
  const r = await readyOn(sendersWith(ENV).get(PIN)!, at);
  assert.match(r.out, /^POOL_EVM_RPCS_ROBINHOOD: the fee's state at block \d+, 600 s old .*, 14 tries over 87 s: /);
});

test("review P3-1: one odd answer on a seat reached on a failover ('0x' or null to one state read) is asked again, never the start's end", async (t) => {
  const at = { T: NOW_MS };
  let odd: unknown = "0x";
  let n = 0;
  planted(t, (host, method) => {
    if (method !== "eth_call") return null;
    if (host === "robinhood.drpc.org") return { status: 400, error: UNKNOWN_STATE.body };
    if (host === "robinhood-rpc.publicnode.com" && n++ === 0) return { result: odd };
    return null;
  }, at);
  for (const v of ["0x", null]) {
    odd = v;
    n = 0;
    at.T = NOW_MS;
    const r = await readyOn(sendersWith(ENV_RH).get(PIN)!, at);
    assert.deepEqual([r.out, r.waits], ["ready", [1_000]], String(v));
  }
});

test("review P3-4: side A's first operator's newest block 700 s old, every other at the head: the check searches from the newer head and is ready at once", async (t) => {
  const at = { T: NOW_MS };
  planted(t, () => null, at, new Map([["robinhood.drpc.org", 700]]));
  const r = await readyOn(sendersWith(ENV_RH).get(PIN)!, at);
  assert.deepEqual([r.out, r.waits], ["ready", []]);
});

test("review item 8: a pair seat that answers HTML, 401 or 403 never refuses the start; one line names it, and it is passed over, not asked at every read", async (t) => {
  const at = { T: NOW_MS };
  const WRONG: [string, () => Response][] = [
    ["HTML", () => new Response("<html><body>Welcome to nginx</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["401", () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })],
    ["403", () => new Response("Forbidden", { status: 403 })],
  ];
  let bad: (() => Response) | null = null;
  const calls = planted(t, (host) => (bad !== null && host === "rpc.mainnet.chain.robinhood.com" ? bad() : null), at);
  let ahead = 0;
  const perfNow = performance.now.bind(performance);
  performance.now = () => perfNow() + ahead;
  t.after(() => void (performance.now = perfNow));
  for (const [name, f] of WRONG) {
    bad = f;
    at.T = NOW_MS;
    calls.length = 0;
    const lines: string[] = [];
    const s = sendersWith(ENV_RH, lines).get(PIN)!;
    const r = await readyOn(s, at);
    assert.deepEqual([r.out, r.waits], ["ready", []], name);
    assert.deepEqual(calls.filter((c) => c.host === "rpc.mainnet.chain.robinhood.com").map((c) => c.method), ["eth_chainId"], `${name}: asked once`);
    const said = lines.filter((l) => l.includes("passed over"));
    assert.equal(said.length, 1, `${name}: ${lines.join("\n")}`);
    assert.match(said[0]!, /^evm robinhood: rpc\.mainnet\.chain\.robinhood\.com passed over 30 s at a time from now: /, name);
    const n = calls.length;
    await s.fee(EPOCH + 1);
    assert.ok(calls.slice(n).every((c) => c.host !== "rpc.mainnet.chain.robinhood.com"), `${name}: not asked at the next read`);
    // past its hold (on the read pair's clock, performance.now) it is asked again, answers the same, and is held again
    // with no second line
    at.T += 31_000;
    ahead += 31_000;
    const m = calls.length;
    await s.fee(EPOCH - 60_000 + 1);
    assert.ok(calls.slice(m).some((c) => c.host === "rpc.mainnet.chain.robinhood.com"), `${name}: asked again past its hold`);
    assert.equal(lines.filter((l) => l.includes("passed over")).length, 1, `${name}: one line, at the first hold`);
  }
});

test("review timing note: the check's bound holds its reads' time with its waits: every post takes 1 s (Robinhood's own pace), the state gone on every seat: refused within 90 s and one try, never 14 tries", async (t) => {
  const at = { T: NOW_MS };
  let posts = 0;
  planted(t, (_host, method) => {
    posts++;
    at.T += 1_000;
    return method === "eth_call" ? { error: { code: -32000, message: "header not found" } } : null;
  }, at);
  const r = await readyOn(sendersWith(ENV_RH).get(PIN)!, at);
  const tries = Number(/, (\d+) tr(?:y|ies) over (\d+) s: /.exec(r.out)?.[1]);
  const over = Number(/, \d+ tr(?:y|ies) over (\d+) s: /.exec(r.out)?.[1]);
  assert.match(r.out, /^POOL_EVM_RPCS_ROBINHOOD: the fee's state at block \d+, \d+ s old .*, \d+ tries over \d+ s: /);
  // the last try starts within the bound and finishes: at most the bound and one try's posts
  const perTry = Math.ceil(posts / tries);
  assert.ok(tries < 14 && over <= 90 + perTry && over === (at.T - NOW_MS) / 1000, `${tries} tries over ${over} s, ${posts} posts`);
  t.diagnostic(`${tries} tries, ${posts} posts, ${(at.T - NOW_MS) / 1000} s`);
});

test("review P3-6: a revert whose data holds a seat's URL leaves no part of its key in the error a send's fee read rejects with", async (t) => {
  const K = "pathKEY-0123456789abcdef0123456789abcdef";
  const at = { T: NOW_MS };
  let revert = false;
  planted(t, (host, method, _p, url) => (revert && method === "eth_call" && host === "a.example" ? { error: { code: 3, message: "execution reverted", data: url } } : null), at);
  const s = sendersWith({ ...ENV_RH, POOL_EVM_RPCS_ROBINHOOD: `https://a.example/v2/${K},https://b.example/rpc` }).get(PIN)!;
  assert.equal((await readyOn(s, at)).out, "ready");
  revert = true;
  const e = await s.fee(EPOCH - 60_000 + 1).then(() => assert.fail("a revert is no fee"), (x: Error) => x);
  assert.match(e.message, /^RPC error 3: execution reverted: a\.example$/);
});

test("review P3-2: a pool's fee read of the start's period that comes back after the period ended is not a fee for the running period: ready only once the next period's fee is held", async (t) => {
  const at = { T: EPOCH + 60_000 + 59_500 };
  const E = EPOCH + 60_000;
  const first = block(E / 1000 - S).hash;
  let moved = false;
  const calls = planted(t, (_host, method, params) => {
    // the fee's read at E's first block answers half a second after E ends
    if (!moved && method === "eth_call" && (params[1] as { blockHash?: string } | undefined)?.blockHash === first) {
      moved = true;
      at.T = E + 60_500;
    }
    return null;
  }, at, new Map());
  const s = sendersWith(ENV_RH).get(PIN)!;
  assert.equal((await readyOn(s, at)).out, "ready");
  assert.ok(moved);
  // the next period's fee is already in memory: no read
  const n = calls.length;
  assert.equal(await s.held(E + 60_000), true);
  assert.equal(calls.length, n, "ready came before the running period's fee was read");
});

// ---- review of f86e1c27 ----
const K40 = "pathKEY-0123456789abcdef0123456789abcdef";
const KEYED = `https://a.example/v2/${K40}`;
/** Does `out` hold 8 or more characters of the key's start, in any ASCII case, as the scrub reads it? */
const holdsKey = (out: string, k = K40) => out.toUpperCase().includes(k.slice(0, 8).toUpperCase());

// The scrub runs in a child process with a bound of its own: a scrub that never ends holds its event loop, which no
// test timeout in this process could end (review of f86e1c27, P2, the probe's N=8 and N=60 never settled)
const scrubbed = (code: string): unknown => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const evm = await import(${JSON.stringify(new URL("./evm.ts", import.meta.url).href)});\n${code}`], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.signal, null, `the scrub did not settle in 20 s or its process aborted (${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("review of f86e1c27 P2: words of U+0130 (two characters lower-cased) and then the seat's own key settle, whatever their count, the key gone, as the scrub and as a failed seat's line", () => {
  const out = scrubbed(`
    const K = ${JSON.stringify(K40)};
    const scrub = evm.evmScrubber([${JSON.stringify(KEYED)}]);
    const lines = [];
    const words = (n) => "\u0130".repeat(n) + K;
    const pair = evm.evmReadPair([{ name: "a.example", url: ${JSON.stringify(KEYED)}, operator: "A", rpc: async () => { throw new Error("HTTP 400: RPC error -32602: " + words(n)); } }, { name: "c.example", url: "https://c.example/", operator: "C", rpc: async () => "0x1" }, { name: "b.example", url: "https://b.example/", operator: "B", rpc: async () => "0x1" }], ["A", "B"], { log: (l) => lines.push(l) });
    let n = 0;
    const direct = [];
    for (n of [0, 7, 8, 60]) { direct.push(scrub(words(n))); await pair.one(0, "eth_blockNumber", []); }
    console.log(JSON.stringify({ direct, lines }));
  `) as { direct: string[]; lines: string[] };
  assert.deepEqual(out.direct, [0, 7, 8, 60].map((n) => `${"\u0130".repeat(n)}<key>`));
  assert.equal(out.lines.length, 4, out.lines.join("\n"));
  for (const [i, n] of [0, 7, 8, 60].entries()) assert.ok(out.lines[i]!.includes(`a.example: HTTP 400: RPC error -32602: ${"\u0130".repeat(n)}`) && !holdsKey(out.lines[i]!), out.lines[i]);
});

test("review of f86e1c27 P2: 500 strings of the key, its starts and cases, U+0130, U+212A, surrogate pairs and 64 KB of text are each scrubbed in one bounded pass, none left holding 8 characters of the key", () => {
  const QK = "queryKEY-fedcba9876543210fedcba9876543210";
  const outs = scrubbed(`
    const [K, QK] = [${JSON.stringify(K40)}, ${JSON.stringify(QK)}];
    const scrub = evm.evmScrubber([${JSON.stringify(KEYED)}, "https://b.example/rpc?apikey=" + QK]);
    let seed = 0x5eed;
    const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
    const pieces = (k) => [k, k.toUpperCase(), k.slice(0, 8 + rnd(k.length - 7)), encodeURIComponent(k), "\u0130", "\u212a", "\ud83d\ude00", "\ud800", "x".repeat(rnd(40)), " ", "https://a.example/v2/" + k.slice(0, 8 + rnd(20))];
    const out = [];
    for (let i = 0; i < 500; i++) {
      let s = "";
      for (let j = 0, m = 1 + rnd(30); j < m; j++) { const ps = pieces(rnd(2) === 0 ? K : QK); s += ps[rnd(ps.length)]; }
      if (i % 50 === 0) s = "y".repeat(64 * 1024) + s; // long words: cut first, the key past the cut never read
      if (i % 50 === 1) s += "z".repeat(64 * 1024);
      out.push([s.length, scrub(s)]);
    }
    console.log(JSON.stringify(out));
  `) as [number, string][];
  assert.equal(outs.length, 500);
  for (const [i, [inLength, out]] of outs.entries()) {
    assert.ok(out.length <= evm.EVM_SCRUB_MAX + 1, `${i}: ${out.length} characters`);
    assert.ok(inLength <= evm.EVM_SCRUB_MAX || out.endsWith("…"), `${i}: the cut is marked`);
    assert.ok(!holdsKey(out) && !holdsKey(out, QK), `${i}: ${JSON.stringify(out.slice(0, 300))}`);
  }
});

test("review of f86e1c27 P3-3: a seat slower than what the read had left is cut, never held: the next read asks it in its place again", async () => {
  const lines: string[] = [];
  let slow = true;
  const seat = (name: string, operator: string, rpc: evm.EvmRpc): evm.EvmSeat => ({ name, url: `https://${name}/rpc`, operator, rpc });
  const seats = [
    seat("a1.example", "A", async () => Promise.reject(new Error("RPC error -32603: internal"))),
    seat("c1.example", "C", () => (slow ? new Promise((r) => setTimeout(() => r("c"), 200)) : Promise.resolve("c"))),
    seat("d1.example", "D", async () => "d"),
    seat("b1.example", "B", async () => "b"),
  ];
  const pair = evm.evmReadPair(seats, ["A", "B"], { log: (l) => void lines.push(l), budgetMs: 50 });
  await assert.rejects(pair.one(0, "eth_blockNumber", []), /no answer in the read's 50 ms/);
  slow = false;
  assert.equal(await pair.one(0, "eth_blockNumber", []), "c", "asked in its place, not passed over");
  assert.ok(!lines.some((l) => l.includes("passed over")), lines.join("\n"));
});

test("review of f86e1c27 P3-5: every post takes 5 s, so each fee read outlasts its period: the start never says ready on a fee whose period has gone", { timeout: 20_000 }, async (t) => {
  const at = { T: NOW_MS };
  const LIMIT = NOW_MS + 900_000; // fifteen periods, five times the 180 s a start took with the period check removed
  // past the limit every post fails at once and every wait never ends, so nothing is left running
  planted(t, () => {
    if (at.T >= LIMIT) throw new TypeError("fetch failed");
    at.T += 5_000;
    return null;
  }, at);
  let state = "waiting";
  void sendersWith(ENV_RH).get(PIN)!.ready((ms) => (at.T >= LIMIT ? new Promise<void>(() => {}) : ((at.T += ms), Promise.resolve()))).then(() => void (state = "ready"), (e: Error) => void (state = e.message));
  for (let i = 0; i < 200_000 && at.T < LIMIT && state === "waiting"; i++) await new Promise((r) => setImmediate(r));
  assert.equal(state, "waiting", `at second ${(at.T - NOW_MS) / 1000}`);
  assert.ok(at.T >= LIMIT);
});

test("review of f86e1c27 P3-4: a pair seat on another chain that throttles its first chain id read is still read for its chain at the start and refused by name; one that throttles it every time is never used", async (t) => {
  const at = { T: NOW_MS };
  let throttles = 1;
  const other = otherChain(900_000_000);
  const calls = planted(t, (host, method, params) => {
    if (host !== "robinhood.drpc.org") return null;
    if (method === "eth_chainId" && throttles-- > 0) return { status: 429, error: { code: -32005, message: "rate limit" } };
    return other(method, params);
  }, at);
  const r = await readyOn(sendersWith(ENV_RH).get(PIN)!, at);
  assert.match(r.out, /^POOL_EVM_RPCS_ROBINHOOD: the fee's state, 1 try over 0 s: robinhood\.drpc\.org names chain 1, not robinhood's 4663$/);
  throttles = Infinity;
  at.T = NOW_MS;
  calls.length = 0;
  const s = sendersWith(ENV_RH).get(PIN)!;
  assert.deepEqual(await readyOn(s, at), { out: "ready", waits: [] });
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
  assert.deepEqual([...new Set(calls.filter((c) => c.host === "robinhood.drpc.org").map((c) => c.method))], ["eth_chainId"], "asked for its chain only");
});

// ---- review of 41c6c371 ----
/** ready() on the test's clock with hung seats: a hung seat's call ends at its client's 5 s timeout, every other takes
 *  `ms`; the clock moves by each call's time, one after another (no two calls overlap: the slowest case). */
async function hungStart(t: TestContext, hung: readonly string[], ms: number, other?: (method: string, params: unknown[]) => Planted) {
  const at = { T: NOW_MS };
  const calls = planted(t, (host, method, params) => {
    if (hung.includes(host)) {
      at.T += 5_000;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }
    at.T += ms;
    return null;
  }, at);
  const s = sendersWith(ENV).get(PIN)!;
  const r = await readyOn(s, at);
  return { r, s, at, calls, other };
}

test("review of 41c6c371 P3-1: two hung dRPC seats and every other call 1.5 s: ready inside 60 s, each hung seat's chain id asked once", async (t) => {
  const { r, at, calls } = await hungStart(t, ["robinhood.drpc.org", "lb.drpc.live"], 1_500);
  assert.equal(r.out, "ready");
  assert.ok(at.T - NOW_MS <= 60_000, `${(at.T - NOW_MS) / 1000} s`);
  t.diagnostic(`ready after ${(at.T - NOW_MS) / 1000} s`);
  for (const h of ["robinhood.drpc.org", "lb.drpc.live"]) assert.ok(calls.filter((c) => c.host === h && c.method === "eth_chainId").length <= 2, h);
});

test("review of 41c6c371 P3-1: four hung seats and every other call 1.2 s: ready, never refused", async (t) => {
  const { r, at } = await hungStart(t, ["robinhood.drpc.org", "lb.drpc.live", "robinhood-rpc.publicnode.com", "robinhood.rpc.blxrbdn.com"], 1_200);
  assert.equal(r.out, "ready", `${(at.T - NOW_MS) / 1000} s`);
  t.diagnostic(`ready after ${(at.T - NOW_MS) / 1000} s`);
});

test("review of 41c6c371 P3-1: a seat held at the start whose chain is another is read for its chain at its first use and never used", async (t) => {
  const at = { T: NOW_MS };
  let hang = true;
  const other = otherChain(900_000_000);
  const calls = planted(t, (host, method, params) => {
    if (host !== "rpc.mainnet.chain.robinhood.com") return null;
    if (hang) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return other(method, params);
  }, at);
  let ahead = 0;
  const perfNow = performance.now.bind(performance);
  performance.now = () => perfNow() + ahead;
  t.after(() => void (performance.now = perfNow));
  const s = sendersWith(ENV_RH).get(PIN)!;
  assert.deepEqual(await readyOn(s, at), { out: "ready", waits: [] });
  // past its hold it answers, as another chain's node
  hang = false;
  ahead += 31_000;
  at.T += 31_000;
  const n = calls.length;
  assert.equal((await s.fee(EPOCH - 60_000 + 1))?.fee, FEE.toString());
  assert.deepEqual([...new Set(calls.slice(n).filter((c) => c.host === "rpc.mainnet.chain.robinhood.com").map((c) => c.method))], ["eth_chainId"], "read for its chain, never used");
});

test("review of 41c6c371 P3-2: a secret of 4,000 or 20,000 characters in a seat URL builds and scrubs: removed whole, and a start of 8 or more of it", () => {
  const out = scrubbed(`
    const res = [];
    for (const n of [4000, 20000]) {
      const k = "LONGkey-" + "0123456789abcdef".repeat(Math.ceil(n / 16)).slice(0, n - 8);
      const scrub = evm.evmScrubber(["https://a.example/v2/" + k]);
      // cut within its first 256 characters (EVM_SCRUB_KEY_MAX), the start the patterns read
      res.push([scrub("whole " + k + " end"), scrub("cut " + k.slice(0, 200)), scrub("upper " + k.slice(0, 100).toUpperCase())]);
    }
    console.log(JSON.stringify(res));
  `) as string[][];
  for (const r of out) assert.deepEqual(r, ["whole <key> end", "cut <key>", "upper <key>"]);
});

test("review of 41c6c371 P3-3: a key holding an apostrophe, echoed inside its URL, leaves no part of it", () => {
  const k = "abcd'efghijklmnopqrstuvwxyz";
  const scrub = evm.evmScrubber([`https://a.example/rpc?key=${k}`]);
  const out = scrub(`bad key at https://a.example/rpc?key=${k}: over its plan`);
  // the URL's run passes over the <key> and takes the ":" after it, a URL character (review of e52fa55f)
  assert.equal(out, "bad key at a.example over its plan");
});

// ---- review of e52fa55f ----
test("review of e52fa55f P3: a URL echoed with its key is its host alone: a query key holding a raw '+', the URL's path past its key, and a key holding an apostrophe", () => {
  const QK = "queryKEY+76543210fedcba9876543210"; // a raw "+" in a query: URLSearchParams reads it as a space
  const PK = "pathKEY-0123456789abcdef0123456789abcdef";
  const AK = "abcd'efghijklmnopqrstuvwxyz";
  const scrub = evm.evmScrubber([`https://b.example/rpc?apikey=${QK}`, `https://a.example/v2/${PK}`, `https://c.example/rpc?key=${AK}`]);
  assert.equal(scrub(`limit at https://b.example/rpc?apikey=${QK} reached`), "limit at b.example reached");
  assert.equal(scrub(`moved: https://a.example/v2/${PK}/acct/9912345/x?uid=4471&s=abc now`), "moved: a.example now");
  assert.equal(scrub(`bad key at https://c.example/rpc?key=${AK}: over its plan`), "bad key at c.example over its plan");
});
