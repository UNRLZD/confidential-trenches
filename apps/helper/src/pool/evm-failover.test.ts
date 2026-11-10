// node --test apps/helper/src/pool/evm-failover.test.ts (card helper-pool-fee-one-read-fails): one provider's failed
// read never stops a Base or Robinhood pool route while another of the helper's providers for that side can answer it.
// On 9 Nov 23:04Z the live helper answered GET /v1/pool/fee for the Robinhood mainnet pool 503 upstream, then 200 three
// times, with no log line. The cause, read from the Mac 9 Nov 23:2xZ on the kit's fee pair: robinhood.drpc.org (dRPC's
// public endpoint, the pair's first) answered the pool's currentTreeDepth() at the epoch block's hash HTTP 400
// {"code":27,"message":"Unknown state. First available state is 1"} in bursts (9 of 30 fee reads, then 29 of 30, then
// none of 24), each in about 70 ms, so one failed read ended the whole fee read.
// Every provider here is a stub of fetch; the keyed URLs carry a made-up path, never a real key.
import assert from "node:assert/strict";
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
  const lines: string[] = [];
  const s = evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l)).get(PIN)!;
  await assert.rejects(s.fee(EPOCH + 1), (e: Error) => throttleOf(e) === 0);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^evm robinhood: fee upstream: .*eth_call 0x4a2b75c8 .*robinhood\.drpc\.org: HTTP 400: RPC error 27[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\): HTTP 400: RPC error 27[^;]*; quiknode\.pro \(ROBINHOOD_RPC_URL_QUICKNODE\): HTTP 400[^;]*; robinhood-rpc\.publicnode\.com: HTTP 400[^;]*; robinhood\.rpc\.blxrbdn\.com: HTTP 400[^;]*; rpc-robinhood\.globalstake\.io: HTTP 400/);
  assert.ok(!lines[0]!.includes("rpc.mainnet.chain.robinhood.com"), "the other side's operator is never asked for the first side");
  assert.ok(!lines[0]!.includes(FAKE), lines[0]);
  // the failed read is not held: the next caller reads again, and once the provider answers, gets the fee
  down = false;
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
});

test("the start's check reads the configured pair alone: a first provider that cannot answer the fee's state reads is refused though a spare could", async (t) => {
  stub(t, (host, method) => (host === "robinhood.drpc.org" && method === "eth_call" ? UNKNOWN_STATE : null));
  await assert.rejects(evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, () => {}).get(PIN)!.ready(async () => {}), (e: Error) => /^POOL_EVM_RPCS_ROBINHOOD: robinhood\.drpc\.org: no answer to 0x4a2b75c8 .*RPC error 27/.test(e.message));
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
    if (method === "eth_chainId") return answer(200, { result: "0x1237" });
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
const DRPC_BEHIND = (host: string, method: string, params: unknown[]): Plant => (DRPC_HOSTS.has(host) && method === "eth_getBlockByNumber" && params[0] !== "latest" ? { result: null } : null);
test("F1: a seat naming the period's first block's true hash with a base fee 1000 times the chain's is refused (two operators agree on the hash, number, time and base fee), never published", async (t) => {
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber") return { result: { ...block(params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string))), baseFeePerGas: `0x${(1000n * GWEI).toString(16)}` } };
    return DRPC_BEHIND(host, method, params);
  });
  const lines: string[] = [];
  await assert.rejects(sendersOf(ENV, lines).get(PIN)!.fee(EPOCH + 1), /different blocks/);
});
test("F1b: a seat naming an earlier real block with a time 7 s late is refused: the block before the one named must be before the period on two operators", async (t) => {
  chainStub(t, (host, method, params) => {
    if (host === "robinhood-rpc.publicnode.com" && method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? HEAD : Number(BigInt(params[0] as string));
      return { result: { ...block(n), timestamp: `0x${(S + n + 7).toString(16)}` } };
    }
    return DRPC_BEHIND(host, method, params);
  });
  await assert.rejects(sendersOf(ENV, []).get(PIN)!.fee(EPOCH + 1), /different blocks/);
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
  assert.ok(p2.ok && p2.operator === "x");
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
