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
import { EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolFee, evmPoolGas, evmPoolVenues } from "@blindfill/kit";
import { throttleOf } from "../limits/limits.ts";
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

test("a side whose every provider fails the read: the fee route still fails (503 upstream, no throttle), and that answer writes one log line naming the read, each host and its status, never a key", async (t) => {
  let down = true;
  const calls = stub(t, (host, method) => (down && (host === "robinhood.drpc.org" || host === "lb.drpc.live") && method === "eth_call" ? UNKNOWN_STATE : null));
  const lines: string[] = [];
  const s = evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l)).get(PIN)!;
  await assert.rejects(s.fee(EPOCH + 1), (e: Error) => throttleOf(e) === 0);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /^evm robinhood: fee upstream: .*eth_call 0x4a2b75c8 .*robinhood\.drpc\.org: HTTP 400: RPC error 27[^;]*; drpc\.live \(ROBINHOOD_RPC_URL_DRPC_1\): HTTP 400: RPC error 27/);
  assert.ok(!lines[0]!.includes(FAKE), lines[0]);
  assert.ok(!calls.some((c) => c.host.endsWith("quiknode.pro")), "a spare of side B's never answers for side A");
  // the failed read is not held: the next caller reads again, and once the provider answers, gets the fee
  down = false;
  assert.equal((await s.fee(EPOCH + 1))?.fee, FEE.toString());
});

test("the start's check reads the configured pair alone: a first provider that cannot answer the fee's state reads is refused though a spare could", async (t) => {
  stub(t, (host, method) => (host === "robinhood.drpc.org" && method === "eth_call" ? UNKNOWN_STATE : null));
  await assert.rejects(evm.evmPoolSendersFromEnv(ENV, evmPoolVenues(), undefined, undefined, () => {}).get(PIN)!.ready(async () => {}), (e: Error) => /^POOL_EVM_RPCS_ROBINHOOD: robinhood\.drpc\.org: no answer to 0x4a2b75c8 .*RPC error 27/.test(e.message));
});

test("the two sides never share an operator: a spare of a side's operator stays on that side, another company's goes to the side with fewer, the pair's own URL is not a spare", () => {
  const sides = (pair: [string, string], spares: string[]) => evm.evmPoolSides(pair, spares.map((url, i) => ({ url, name: `s${i}` }))).map((side) => side.map((p) => p.url));
  const drpc = [1, 2, 3].map((k) => `https://lb.drpc.live/robinhood/${FAKE}${k}`);
  // Robinhood: dRPC's keys go with dRPC's public endpoint, QuickNode with Robinhood's own
  assert.deepEqual(sides([DRPC!, OWN!], [SPARE_QN, ...drpc]), [[DRPC, ...drpc], [OWN, SPARE_QN]]);
  // Base: neither of the kit's pair has a keyed spare of its company; QuickNode first, to the first side, then dRPC's three to the second
  const [baseA, baseB] = evmPoolVenues().base.feeProviders!;
  const baseDrpc = drpc.map((u) => u.replace("robinhood", "base"));
  const baseQn = SPARE_QN.replace("robinhood", "base");
  assert.deepEqual(sides([baseA!, baseB!], [baseQn, ...baseDrpc]), [[baseA, baseQn], [baseB, ...baseDrpc]]);
  // the pair's own URL set again as a key is no second provider
  assert.deepEqual(sides([DRPC!, OWN!], [`${DRPC}/`, OWN!]), [[DRPC], [OWN]]);
  for (const [a, b] of [sides([DRPC!, OWN!], [SPARE_QN, ...drpc]), sides([baseA!, baseB!], [baseQn, ...baseDrpc])]) {
    const ops = (side: string[]) => new Set(side.map((u) => new URL(u).hostname.split(".").slice(-2).join(".").replace("drpc.live", "drpc.org")));
    assert.equal([...ops(a!)].filter((o) => ops(b!).has(o)).length, 0);
  }
});

test("a read tries its side's next provider only within its budget, never on the chain's own answer, never on a held spare; all failed, it throws the first provider's words first", async () => {
  const lines: string[] = [];
  const asked: string[] = [];
  const p = (name: string, answer: () => Promise<unknown>, skip?: () => boolean) => ({ name, url: `https://${name}.example/${FAKE}`, rpc: async () => (asked.push(name), answer()), ...(skip ? { skip } : {}) });
  const fail = (m: string) => () => Promise.reject(new Error(m));
  const never = () => new Promise<never>(() => {});
  // a spare that hangs: the read ends at its budget, and the spare after it is not asked
  const r1 = evm.evmFailoverRpc([p("a", fail("HTTP 503")), p("hang", never), p("late", async () => "0x1")], { log: (l) => void lines.push(l), budgetMs: 50 });
  const t0 = performance.now();
  await assert.rejects(r1("eth_blockNumber", []), (e: Error) => /^HTTP 503 \(eth_blockNumber/.test(e.message) && e.message.includes("hang: no answer in the read's 50 ms"));
  assert.ok(performance.now() - t0 < 1_000);
  assert.deepEqual(asked, ["a", "hang"]);
  // the chain's own answer (a revert) is the same on any provider: thrown at once
  asked.length = 0;
  const r2 = evm.evmFailoverRpc([p("a", fail("RPC error 3: execution reverted")), p("b", async () => "0x1")], { log: (l) => void lines.push(l) });
  await assert.rejects(r2("eth_estimateGas", [{}, "pending"]), (e: Error) => e.message === "RPC error 3: execution reverted");
  assert.deepEqual(asked, ["a"]);
  // a held spare is passed over
  asked.length = 0;
  const r3 = evm.evmFailoverRpc([p("a", fail("HTTP 502")), p("held", async () => "0x2", () => true), p("c", async () => "0x3")], { log: (l) => void lines.push(l) });
  assert.equal(await r3("eth_blockNumber", []), "0x3");
  assert.deepEqual(asked, ["a", "c"]);
  // a throttled first provider whose spares fail too stays a throttle (429 with its wait), as it was with no spare
  const r4 = evm.evmFailoverRpc([p("a", fail("HTTP 429")), p("b", fail("HTTP 502"))], { log: () => {} });
  await assert.rejects(r4("eth_blockNumber", []), (e: Error) => throttleOf(e, true) > 0);
  assert.ok(lines.every((l) => !l.includes(FAKE)), lines.join("\n"));
});
