// An EVM pool release's send and its read-back on the device (card signpage-evm-pool-buy, src/evm-send.ts): the
// helper's send and each of its answers (busy, refused, no answer), the buy's calldata signature length, the head read,
// the pool's release read on one RPC (what it asks and what it keeps), and the verdict on two RPCs' reads.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HELPER_FETCH_INIT, HELPER_V1_PATHS } from "../../kit/src/helper/v1.ts";
import type { EvmPoolBuy } from "../../kit/src/trade/evm/buy-unpinned.ts";
import { entropyToWords, freshWallet, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
import { EVM_POOL_EVENTS, type EvmRelayData, type EvmRpc } from "../../wallet/src/pool/evm.ts";
import {
  evmBuyCalldata,
  evmBuyVerdict,
  evmHeadNumber,
  evmPoolSend,
  evmReleaseRead,
  EvmSendBusy,
  EvmSendNoAnswer,
  EvmSendRefused,
  EVM_SEND_RETRY_MAX_S,
  EVM_SEND_TIMEOUT_MS,
  type EvmBuyWant,
  type EvmRelease,
  type EvmReleaseRead,
} from "../src/evm-send.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const HELPER = "https://helper.ct.test";
// the pool, in mixed case: every request and comparison lowercases it
const POOL = "0x00000000000000000000000000000000000F0011";
const POOL_LOWER = POOL.toLowerCase();
const OTHER_POOL = "0x00000000000000000000000000000000000f0012";
const FEE_TO = "0x0000000000000000000000000000000000000fee";
const OTHER_FEE_TO = "0x0000000000000000000000000000000000000bad";
const ADAPTER = "0x000000000000000000000000000000000000ad03";
const TOKEN = "0x00000000000000000000000000000000000000c0";
const OTHER_TOKEN = "0x00000000000000000000000000000000000000aa";
// the all-zero seed's W for (l, j) = (5, 0): the published test vector's words (packages/wallet/test/vectors/a8.json)
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const W = freshWallet(SEED, "evm", 5n, 0).address;
const W_LOWER = W.toLowerCase();
const OTHER_W = "0x0000000000000000000000000000000000000077";
const NULLIFIER = 777n;
const VALUE = 10n ** 16n;
const FEE = 10n ** 13n;
const MIN_OUT = 39_000_000n;
const TX = "0x" + "ab".repeat(32);
const TX_UPPER = "0x" + "AB".repeat(32);
const OTHER_TX = "0x" + "cd".repeat(32);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const topic = (s: string) => "0x" + hex(keccak_256(new TextEncoder().encode(s)));
const TOPIC_BOUGHT = topic(EVM_POOL_EVENTS.Bought);
const TOPIC_WITHDRAWN = topic(EVM_POOL_EVENTS.Withdrawn);
const TOPIC_DEPOSITED = topic(EVM_POOL_EVENTS.Deposited);
const w32 = (v: bigint) => v.toString(16).padStart(64, "0");
const SEND_LIMIT = HELPER_V1_PATHS.find((p) => p.method === "POST" && p.path === "/v1/pool/evm/send")!.limitBytes!;

// ---- evmPoolSend ----

type Sent = { url: string; init: RequestInit };
const BODY = { pool: POOL, data: Uint8Array.from([0x01, 0x02, 0xff]), epoch: 1_234n };
function helper(answer: () => Response | Promise<Response>): { fetchFn: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const empty = (status: number, headers: Record<string, string> = {}) => () => new Response(null, { status, headers });
const send = (answer: () => Response | Promise<Response>) => evmPoolSend(HELPER, BODY, helper(answer).fetchFn);
const noAnswer = (status: number | null) => (e: unknown) => {
  assert.ok(e instanceof EvmSendNoAnswer, `not EvmSendNoAnswer: ${String(e)}`);
  assert.ok(!(e instanceof EvmSendRefused));
  assert.equal(e.status, status);
  return true;
};

test("send: a 200 naming a hash returns it lowercased", async () => {
  assert.equal(await send(json(200, { hash: TX_UPPER })), TX);
});

test("send: the request is a POST of {pool, data, epoch} to the route, redirect error, the kit's helper init and JSON", async () => {
  const { fetchFn, sent } = helper(json(200, { hash: TX }));
  await evmPoolSend(HELPER, BODY, fetchFn);
  assert.equal(sent.length, 1);
  const { url, init } = sent[0]!;
  assert.equal(url, `${HELPER}/v1/pool/evm/send`);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  for (const [k, v] of Object.entries(HELPER_FETCH_INIT)) assert.equal((init as Record<string, unknown>)[k], v, `HELPER_FETCH_INIT.${k}`);
  assert.deepEqual(init.headers, { "content-type": "application/json" });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body as string), { pool: POOL_LOWER, data: "0x0102ff", epoch: 1234 });
});

test("send: a 429 is busy for its Retry-After in ms", async () => {
  await assert.rejects(send(json(429, {}, { "retry-after": "7" })), (e) => e instanceof EvmSendBusy && e.retryAfterMs === 7_000);
});

test("send: a 429 with no Retry-After, or one that is not a number, is busy for 1 s", async () => {
  await assert.rejects(send(empty(429)), (e) => e instanceof EvmSendBusy && e.retryAfterMs === 1_000);
  await assert.rejects(send(empty(429, { "retry-after": "x" })), (e) => e instanceof EvmSendBusy && e.retryAfterMs === 1_000);
});

test("send: a 429's long Retry-After is capped at EVM_SEND_RETRY_MAX_S", async () => {
  await assert.rejects(send(empty(429, { "retry-after": "999999" })), (e) => e instanceof EvmSendBusy && e.retryAfterMs === EVM_SEND_RETRY_MAX_S * 1_000);
});

test("send: a 400 or 422 naming its code is the helper's refusal, with that status and code", async () => {
  for (const status of [400, 422]) {
    await assert.rejects(send(json(status, { error: { code: "simulation_failed" } })), (e) => e instanceof EvmSendRefused && e.status === status && e.code === "simulation_failed");
  }
});

test("send: a 4xx with no body, a malformed code or a code that is not a string is no answer, never a refusal", async () => {
  await assert.rejects(send(empty(400)), noAnswer(400));
  await assert.rejects(send(json(422, { error: { code: "Bad-Code" } })), noAnswer(422));
  await assert.rejects(send(json(400, { error: { code: "x".repeat(41) } })), noAnswer(400));
  await assert.rejects(send(json(400, { error: { code: 5 } })), noAnswer(400));
});

test("send: a 5xx, with or without a code, is no answer", async () => {
  for (const status of [500, 502, 503, 504]) {
    await assert.rejects(send(empty(status)), noAnswer(status));
    await assert.rejects(send(json(status, { error: { code: "simulation_failed" } })), noAnswer(status));
  }
});

test("send: a 200 with no hash, a short hash, or a body over the route's limit is no answer", async () => {
  await assert.rejects(send(json(200, {})), noAnswer(200));
  await assert.rejects(send(json(200, { hash: "0x12" })), noAnswer(200));
  const big = { hash: TX, pad: "x".repeat(SEND_LIMIT) };
  assert.ok(JSON.stringify(big).length > SEND_LIMIT);
  await assert.rejects(send(json(200, big)), noAnswer(200));
});

test("send: a fetch that rejects is no answer", async () => {
  await assert.rejects(
    send(() => Promise.reject(new TypeError("fetch failed"))),
    noAnswer(null),
  );
});

test("send: a helper that never answers is no answer at EVM_SEND_TIMEOUT_MS", async () => {
  enableTimers(mock.timers, { apis: ["setTimeout"] });
  try {
    // a fetch that settles only when its signal aborts, as fetch does
    const hang = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    let settled = false;
    const p = evmPoolSend(HELPER, BODY, hang).finally(() => (settled = true));
    p.catch(() => {});
    mock.timers.tick(EVM_SEND_TIMEOUT_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, "still waiting 1 ms before the bound");
    mock.timers.tick(1);
    // settled within a few turns of the event loop (setImmediate is not mocked), never left waiting
    const stuck = new Promise<never>((_, reject) => {
      let n = 0;
      const turn = () => (++n > 20 ? reject(new Error("still waiting past EVM_SEND_TIMEOUT_MS")) : setImmediate(turn));
      setImmediate(turn);
    });
    await assert.rejects(Promise.race([p, stuck]), (e) => noAnswer(null)(e) && /timeout/.test((e as Error).message));
  } finally {
    resetTimers(mock.timers);
  }
});

// ---- evmBuyCalldata ----

test("calldata: a signature of 64 or 66 bytes is refused; 65 encodes", () => {
  const relay: EvmRelayData = { recipient: W, feeRecipient: FEE_TO, feeCap: FEE, deadlineMs: 1_000n, refundPrecommitment: 9n, salt: "0x" + "ab".repeat(16) };
  const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] } as never;
  const signals = ["11", "12", "13", "14", "15", "16", "17", "18"] as never;
  const built = { chain: "base", adapter: ADAPTER, data: "0x1234", minOut: MIN_OUT, token: TOKEN } as EvmPoolBuy;
  assert.ok(evmBuyCalldata(POOL, relay, proof, signals, FEE, built, new Uint8Array(65)).length > 4);
  for (const n of [64, 66]) assert.throws(() => evmBuyCalldata(POOL, relay, proof, signals, FEE, built, new Uint8Array(n)), /65-byte signature/);
});

// ---- evmHeadNumber ----

test("head: eth_blockNumber's hex is the number; anything else throws", async () => {
  const calls: [string, readonly unknown[]][] = [];
  const rpc = (answer: unknown): EvmRpc => async (method, params) => (calls.push([method, params]), answer);
  assert.equal(await evmHeadNumber(rpc("0x10")), 16n);
  assert.deepEqual(calls, [["eth_blockNumber", []]]);
  for (const bad of ["16", "0x", "0xzz", 16, null]) await assert.rejects(evmHeadNumber(rpc(bad)), /not a block number/);
});

// ---- evmReleaseRead ----

const FROM = 0x10n;
const HEAD = 0x20n;
const HEAD_TIME = 1_700_000_000n;
type Log = Record<string, unknown>;
/** The pool's Bought as eth_getLogs carries it: topics[1] the recipient, seven data words. */
const boughtLog = (o: { block?: bigint; index?: bigint; tx?: string; recipient?: string; out?: bigint; token?: bigint } = {}): Log => ({
  address: POOL_LOWER,
  topics: [TOPIC_BOUGHT, "0x" + w32(BigInt(o.recipient ?? W))],
  data: "0x" + [BigInt(FEE_TO), VALUE, FEE, NULLIFIER, 99n, o.token ?? BigInt(TOKEN), o.out ?? 40_000_000n].map(w32).join(""),
  blockNumber: "0x" + (o.block ?? 0x18n).toString(16),
  transactionHash: o.tx ?? TX,
  logIndex: "0x" + (o.index ?? 3n).toString(16),
  removed: false,
});
/** The pool's Withdrawn: five data words. */
const withdrawnLog = (): Log => ({
  ...boughtLog({ tx: OTHER_TX, index: 4n }),
  topics: [TOPIC_WITHDRAWN, "0x" + w32(BigInt(W))],
  data: "0x" + [BigInt(FEE_TO), VALUE, FEE, NULLIFIER + 1n, 98n].map(w32).join(""),
});
const BOUGHT: EvmRelease = { kind: "bought", block: 0x18n, tx: TX, index: 3n, recipient: W_LOWER, feeRecipient: FEE_TO, value: VALUE, fee: FEE, nullifier: NULLIFIER, token: TOKEN, out: 40_000_000n };
const WITHDRAWN: EvmRelease = { kind: "withdrawn", block: 0x18n, tx: OTHER_TX, index: 4n, recipient: W_LOWER, feeRecipient: FEE_TO, value: VALUE, fee: FEE, nullifier: NULLIFIER + 1n };

function chain(o: { block?: unknown; logs?: unknown } = {}): { rpc: EvmRpc; calls: [string, readonly unknown[]][] } {
  const calls: [string, readonly unknown[]][] = [];
  const rpc: EvmRpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_getBlockByNumber") return "block" in o ? o.block : { number: "0x" + HEAD.toString(16), timestamp: "0x" + HEAD_TIME.toString(16) };
    if (method === "eth_getLogs") return "logs" in o ? o.logs : [];
    throw new Error(`no ${method}`);
  };
  return { rpc, calls };
}

test("release read: asks the newest block, then the pool's Bought and Withdrawn logs by address and topics from `from` to that block", async () => {
  const { rpc, calls } = chain();
  await evmReleaseRead(rpc, POOL, FROM);
  assert.deepEqual(calls, [
    ["eth_getBlockByNumber", ["latest", false]],
    ["eth_getLogs", [{ address: POOL_LOWER, topics: [[TOPIC_BOUGHT, TOPIC_WITHDRAWN]], fromBlock: "0x10", toBlock: "0x20" }]],
  ]);
});

test("release read: no request names W, a nullifier or a transaction", async () => {
  const { rpc, calls } = chain({ logs: [boughtLog()] });
  await evmReleaseRead(rpc, POOL, FROM);
  const asked = JSON.stringify(calls.map(([, p]) => p)).toLowerCase();
  for (const secret of [W_LOWER.slice(2), w32(NULLIFIER), NULLIFIER.toString(16), TX.slice(2)]) assert.ok(!asked.includes(secret), `a request carries ${secret}`);
});

test("release read: parses a Bought (seven words, topics[1] the recipient) and a Withdrawn (five words)", async () => {
  const { rpc } = chain({ logs: [boughtLog(), withdrawnLog()] });
  const got = await evmReleaseRead(rpc, POOL, FROM);
  assert.deepEqual(got.releases, [BOUGHT, WITHDRAWN]);
});

test("release read: head.timeMs is the newest block's timestamp in ms", async () => {
  const { rpc } = chain();
  assert.deepEqual((await evmReleaseRead(rpc, POOL, FROM)).head, { number: HEAD, timeMs: HEAD_TIME * 1_000n });
});

test("release read: logs at `from` and at the head are kept", async () => {
  const { rpc } = chain({ logs: [boughtLog({ block: FROM }), boughtLog({ block: HEAD, index: 9n })] });
  const got = await evmReleaseRead(rpc, POOL, FROM);
  assert.deepEqual(got.releases.map((r) => r.block), [FROM, HEAD]);
});

const words = (n: number) => "0x" + Array.from({ length: n }, (_, i) => w32(BigInt(i + 1))).join("");
const DROPPED: [string, Log][] = [
  ["another address", { ...boughtLog(), address: OTHER_POOL }],
  ["removed", { ...boughtLog(), removed: true }],
  ["another topic0", { ...boughtLog(), topics: [TOPIC_DEPOSITED, "0x" + w32(BigInt(W))] }],
  ["a Bought of six words", { ...boughtLog(), data: words(6) }],
  ["a Bought of eight words", { ...boughtLog(), data: words(8) }],
  ["a Bought of five words", { ...boughtLog(), data: words(5) }],
  ["a Withdrawn of four words", { ...withdrawnLog(), data: words(4) }],
  ["a Withdrawn of six words", { ...withdrawnLog(), data: words(6) }],
  ["a Withdrawn of seven words", { ...withdrawnLog(), data: words(7) }],
  ["a block before `from`", boughtLog({ block: FROM - 1n })],
  ["a block past the head", boughtLog({ block: HEAD + 1n })],
  ["no transactionHash", (({ transactionHash: _t, ...l }) => l)(boughtLog())],
  ["a short transactionHash", { ...boughtLog(), transactionHash: "0x12" }],
  ["no logIndex", (({ logIndex: _i, ...l }) => l)(boughtLog())],
  ["a logIndex that is not hex", { ...boughtLog(), logIndex: "3" }],
  ["a token word of 2^160", boughtLog({ token: 1n << 160n })],
];
for (const [why, log] of DROPPED) {
  test(`release read: drops ${why}`, async () => {
    const { rpc } = chain({ logs: [log, boughtLog({ index: 7n })] });
    const got = await evmReleaseRead(rpc, POOL, FROM);
    assert.deepEqual(got.releases, [{ ...BOUGHT, index: 7n }], why);
  });
}

test("release read: a head before `from` asks no logs", async () => {
  const { rpc, calls } = chain({ block: { number: "0x0f", timestamp: "0x1" } });
  assert.deepEqual(await evmReleaseRead(rpc, POOL, FROM), { head: { number: 15n, timeMs: 1_000n }, releases: [] });
  assert.deepEqual(calls.map(([m]) => m), ["eth_getBlockByNumber"]);
});

test("release read: a log answer that is not a list, or a block with no number, throws", async () => {
  for (const logs of [null, {}, "0x"]) await assert.rejects(evmReleaseRead(chain({ logs }).rpc, POOL, FROM), /not a log list/);
  for (const block of [null, { timestamp: "0x1" }, { number: "0x20" }]) await assert.rejects(evmReleaseRead(chain({ block }).rpc, POOL, FROM), /not a block/);
});

// ---- evmBuyVerdict ----

const DEADLINE = 1_700_000_000_000n;
const WANT: EvmBuyWant = { nullifier: NULLIFIER, w: W, feeRecipient: FEE_TO, token: TOKEN, minOut: MIN_OUT, value: VALUE, feeCap: FEE, deadlineMs: DEADLINE };
const readOf = (releases: EvmRelease[], timeMs = DEADLINE - 1n): EvmReleaseRead => ({ head: { number: HEAD, timeMs }, releases });
const both = (a: EvmRelease[], b: EvmRelease[] = a, ta?: bigint, tb?: bigint) => evmBuyVerdict([readOf(a, ta), readOf(b, tb)], WANT);

test("verdict: one Bought the same on both, to W, the fee recipient, the token, the value and fee, out at least min out: filled", () => {
  assert.deepEqual(both([BOUGHT]), { end: "filled", release: BOUGHT });
});

test("verdict: the two reads differing in any one field of the release: null", () => {
  const changed: Partial<EvmRelease>[] = [{ block: BOUGHT.block + 1n }, { tx: OTHER_TX }, { index: BOUGHT.index + 1n }, { recipient: OTHER_W }, { feeRecipient: OTHER_FEE_TO }, { value: VALUE + 1n }, { fee: FEE + 1n }, { token: OTHER_TOKEN }, { out: BOUGHT.out! + 1n }];
  for (const c of changed) assert.equal(both([BOUGHT], [{ ...BOUGHT, ...c }]), null, JSON.stringify(c, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
});

test("verdict: a Bought on both that pays anyone else, another token or value, or a fee over the cap: not_landed with the release", () => {
  const changed: Partial<EvmRelease>[] = [{ recipient: OTHER_W }, { feeRecipient: OTHER_FEE_TO }, { token: OTHER_TOKEN }, { value: VALUE + 1n }, { fee: FEE + 1n }];
  for (const c of changed) {
    const x = { ...BOUGHT, ...c };
    assert.deepEqual(both([x]), { end: "not_landed", release: x }, Object.keys(c)[0]);
  }
});

test("verdict: the sender's fee is its pick up to the cap: the cap, less, or none is filled", () => {
  for (const fee of [FEE, FEE - 1n, 0n]) {
    const x = { ...BOUGHT, fee };
    assert.deepEqual(both([x]), { end: "filled", release: x }, String(fee));
  }
});

test("verdict: out equal to min out is filled; one below it is not_landed", () => {
  const at = { ...BOUGHT, out: MIN_OUT };
  assert.deepEqual(both([at]), { end: "filled", release: at });
  const under = { ...BOUGHT, out: MIN_OUT - 1n };
  assert.deepEqual(both([under]), { end: "not_landed", release: under });
});

test("verdict: a matching Withdrawn on both: withdrawn", () => {
  const x = { ...WITHDRAWN, nullifier: NULLIFIER };
  assert.deepEqual(both([x]), { end: "withdrawn", release: x });
});

test("verdict: a Withdrawn of the nullifier to anyone else: not_landed with the release", () => {
  const x = { ...WITHDRAWN, nullifier: NULLIFIER, recipient: OTHER_W };
  assert.deepEqual(both([x]), { end: "not_landed", release: x });
});

test("verdict: two releases of the nullifier on one side: null", () => {
  const second = { ...BOUGHT, tx: OTHER_TX };
  assert.equal(both([BOUGHT, second], [BOUGHT]), null);
  assert.equal(both([BOUGHT], [BOUGHT, second]), null);
});

test("verdict: the release on one side only: null", () => {
  assert.equal(both([BOUGHT], [], DEADLINE + 1n, DEADLINE + 1n), null);
  assert.equal(both([], [BOUGHT], DEADLINE + 1n, DEADLINE + 1n), null);
});

test("verdict: none on both is not_landed only once both heads are past the deadline", () => {
  assert.deepEqual(both([], [], DEADLINE + 1n, DEADLINE + 1n), { end: "not_landed", release: null });
  assert.equal(both([], [], DEADLINE, DEADLINE), null, "at the deadline is not past it");
  assert.equal(both([], [], DEADLINE + 1n, DEADLINE), null, "one side past");
  assert.equal(both([], [], DEADLINE, DEADLINE + 1n), null, "the other side past");
});

test("verdict: releases of other nullifiers are left out", () => {
  const other = { ...BOUGHT, nullifier: NULLIFIER + 5n, tx: OTHER_TX };
  assert.deepEqual(both([other, BOUGHT], [BOUGHT, other]), { end: "filled", release: BOUGHT });
  assert.deepEqual(both([other], [other], DEADLINE + 1n, DEADLINE + 1n), { end: "not_landed", release: null });
  assert.deepEqual(both([other], [], DEADLINE + 1n, DEADLINE + 1n), { end: "not_landed", release: null }, "on one side only, it holds nothing up");
  assert.deepEqual(both([BOUGHT, other], [BOUGHT]), { end: "filled", release: BOUGHT }, "nor counts as a second release");
});
