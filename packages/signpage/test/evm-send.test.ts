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
  EVM_BUY_LOG_SPAN,
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

test("send: a 2xx other than 200, or a 3xx, is no answer even with a hash", async () => {
  for (const status of [201, 202, 204, 302]) {
    const f = async () => new Response(status === 204 ? null : JSON.stringify({ hash: "0x" + "ab".repeat(32) }), { status });
    await assert.rejects(evmPoolSend(HELPER, { pool: POOL, data: new Uint8Array([1]), epoch: 1n }, f as typeof fetch), (e) => e instanceof EvmSendNoAnswer, String(status));
  }
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
/** The safe block: 8 blocks and 16 s under the head. */
const SAFE = 0x18n;
const SAFE_TIME = HEAD_TIME - 16n;
const BLOCK_HASH = "0x" + "be".repeat(32);
/** A read with the proof's deadline past neither block (no stop yet), the stop it was asked with null. */
const READ_DEADLINE = SAFE_TIME * 1_000n;
const read = (rpc: EvmRpc, deadlineMs = READ_DEADLINE, stop: bigint | null = null, from = FROM) => evmReleaseRead(rpc, POOL, from, deadlineMs, stop);
type Log = Record<string, unknown>;
/** The pool's Bought as eth_getLogs carries it: topics[1] the recipient, seven data words. */
const boughtLog = (o: { block?: bigint; index?: bigint; tx?: string; recipient?: string; out?: bigint; token?: bigint } = {}): Log => ({
  address: POOL_LOWER,
  topics: [TOPIC_BOUGHT, "0x" + w32(BigInt(o.recipient ?? W))],
  data: "0x" + [BigInt(FEE_TO), VALUE, FEE, NULLIFIER, 99n, o.token ?? BigInt(TOKEN), o.out ?? 40_000_000n].map(w32).join(""),
  blockNumber: "0x" + (o.block ?? 0x18n).toString(16),
  transactionHash: o.tx ?? TX,
  logIndex: "0x" + (o.index ?? 3n).toString(16),
  blockHash: BLOCK_HASH,
  removed: false,
});
/** The pool's Withdrawn: five data words. */
const withdrawnLog = (): Log => ({
  ...boughtLog({ tx: OTHER_TX, index: 4n }),
  topics: [TOPIC_WITHDRAWN, "0x" + w32(BigInt(W))],
  data: "0x" + [BigInt(FEE_TO), VALUE, FEE, NULLIFIER + 1n, 98n].map(w32).join(""),
});
const BOUGHT: EvmRelease = { kind: "bought", block: 0x18n, blockHash: BLOCK_HASH, tx: TX, index: 3n, recipient: W_LOWER, feeRecipient: FEE_TO, value: VALUE, fee: FEE, nullifier: NULLIFIER, token: TOKEN, out: 40_000_000n };
const WITHDRAWN: EvmRelease = { kind: "withdrawn", block: 0x18n, blockHash: BLOCK_HASH, tx: OTHER_TX, index: 4n, recipient: W_LOWER, feeRecipient: FEE_TO, value: VALUE, fee: FEE, nullifier: NULLIFIER + 1n };

function chain(o: { block?: unknown; safe?: unknown; logs?: unknown; at?: (n: bigint) => bigint } = {}): { rpc: EvmRpc; calls: [string, readonly unknown[]][] } {
  const calls: [string, readonly unknown[]][] = [];
  const rpc: EvmRpc = async (method, params) => {
    calls.push([method, params]);
    // a block asked by number: that number, at the time `at` gives it (seconds)
    if (method === "eth_getBlockByNumber" && /^0x[0-9a-f]+$/.test(String(params[0]))) {
      const n = BigInt(String(params[0]));
      return { number: "0x" + n.toString(16), timestamp: "0x" + (o.at?.(n) ?? HEAD_TIME).toString(16) };
    }
    if (method === "eth_getBlockByNumber" && params[0] === "safe") return "safe" in o ? o.safe : { number: "0x" + SAFE.toString(16), timestamp: "0x" + SAFE_TIME.toString(16) };
    if (method === "eth_getBlockByNumber") return "block" in o ? o.block : { number: "0x" + HEAD.toString(16), timestamp: "0x" + HEAD_TIME.toString(16) };
    if (method === "eth_getLogs") return "logs" in o ? o.logs : [];
    throw new Error(`no ${method}`);
  };
  return { rpc, calls };
}

test("release read: asks the newest and the safe block, then the pool's Bought and Withdrawn logs by address and topics from `from` to the newest block while the safe one is not past the deadline", async () => {
  const { rpc, calls } = chain();
  const got = await read(rpc);
  assert.deepEqual([got.stop, got.to, got.ended], [null, HEAD, false]);
  assert.deepEqual(calls, [
    ["eth_getBlockByNumber", ["latest", false]],
    ["eth_getBlockByNumber", ["safe", false]],
    ["eth_getLogs", [{ address: POOL_LOWER, topics: [[TOPIC_BOUGHT, TOPIC_WITHDRAWN]], fromBlock: "0x10", toBlock: "0x20" }]],
  ]);
});

test("release read: no request names W, a nullifier or a transaction", async () => {
  const { rpc, calls } = chain({ logs: [boughtLog()] });
  await read(rpc);
  const asked = JSON.stringify(calls.map(([, p]) => p)).toLowerCase();
  for (const secret of [W_LOWER.slice(2), w32(NULLIFIER), NULLIFIER.toString(16), TX.slice(2)]) assert.ok(!asked.includes(secret), `a request carries ${secret}`);
});

test("release read: parses a Bought (seven words, topics[1] the recipient) and a Withdrawn (five words)", async () => {
  const { rpc } = chain({ logs: [boughtLog(), withdrawnLog()] });
  const got = await read(rpc);
  assert.deepEqual(got.releases, [BOUGHT, WITHDRAWN]);
});

test("release read: head and safe are the newest and safe blocks, their timestamps in ms", async () => {
  const { rpc } = chain();
  const got = await read(rpc);
  assert.deepEqual([got.head, got.safe], [{ number: HEAD, timeMs: HEAD_TIME * 1_000n }, { number: SAFE, timeMs: SAFE_TIME * 1_000n }]);
});

test("release read: the safe block past the deadline is the stop, the range ends there and the read is ended (review P2-1 b, P3-4)", async () => {
  const { rpc, calls } = chain({ logs: [boughtLog({ block: SAFE })] });
  const got = await read(rpc, SAFE_TIME * 1_000n - 1n);
  assert.deepEqual([got.stop, got.to, got.ended], [SAFE, SAFE, true]);
  assert.equal((calls[2]![1][0] as { toBlock: string }).toBlock, "0x18");
  assert.equal(got.releases.length, 1);
});

test("release read: the newest block past the deadline while the safe one is not: no stop, never ended (review P2-1 b)", async () => {
  const got = await read(chain().rpc, HEAD_TIME * 1_000n - 1n);
  assert.deepEqual([got.stop, got.to, got.ended], [null, HEAD, false]);
});

test("release read: a stop an earlier read set holds, the range never grows past it; a lower safe block past the deadline lowers it", async () => {
  const kept = await read(chain().rpc, 0n, SAFE - 3n);
  assert.deepEqual([kept.stop, kept.to, kept.ended], [SAFE - 3n, SAFE - 3n, true]);
  const lowered = await read(chain().rpc, 0n, SAFE + 3n);
  assert.deepEqual([lowered.stop, lowered.to, lowered.ended], [SAFE, SAFE, true]);
});

test("release read: a range is never wider than EVM_BUY_LOG_SPAN blocks; a read it cuts ends only when its last block, read by number, is past the deadline (review P3-4, P1-A)", async () => {
  const far = 1n;
  const head = far + EVM_BUY_LOG_SPAN + 10n;
  const last = far + EVM_BUY_LOG_SPAN - 1n;
  const deadlineMs = HEAD_TIME * 1000n - 5_000n;
  const blocks = { block: { number: "0x" + head.toString(16), timestamp: "0x" + HEAD_TIME.toString(16) }, safe: { number: "0x" + (head - 1n).toString(16), timestamp: "0x" + HEAD_TIME.toString(16) } };
  // the last block of the cut range not past the deadline: not ended, `stop` the safe block
  const before = chain({ ...blocks, at: () => HEAD_TIME - 10n });
  const got = await read(before.rpc, deadlineMs, null, far);
  assert.deepEqual([got.stop, got.to, got.ended], [head - 1n, last, false]);
  assert.deepEqual(before.calls[2], ["eth_getBlockByNumber", ["0x" + last.toString(16), false]], "the cut range's last block, by number");
  const asked = before.calls[3]![1][0] as { fromBlock: string; toBlock: string };
  assert.equal(BigInt(asked.toBlock) - BigInt(asked.fromBlock) + 1n, EVM_BUY_LOG_SPAN);
  assert.ok(EVM_BUY_LOG_SPAN < 50_000n, "under robinhood-sepolia-rpc.publicnode.com's 50,000-block cap");
  // past it: the range stops there and the read is ended, so a record read again 20,000+ blocks later can end
  const after = chain({ ...blocks, at: () => HEAD_TIME });
  const ends = await read(after.rpc, deadlineMs, null, far);
  assert.deepEqual([ends.stop, ends.to, ends.ended], [last, last, true]);
  // a range not cut: no read by number
  const plain = chain();
  await read(plain.rpc);
  assert.equal(plain.calls.filter(([m, p]) => m === "eth_getBlockByNumber" && p[0] !== "latest" && p[0] !== "safe").length, 0);
  // a block answered with another number is no block
  const liar = chain({ ...blocks, at: () => HEAD_TIME });
  const lying: EvmRpc = async (m, p) => (m === "eth_getBlockByNumber" && /^0x/.test(String(p[0])) && p[0] !== "latest" ? { number: "0x1", timestamp: "0x" + HEAD_TIME.toString(16) } : liar.rpc(m, p));
  await assert.rejects(read(lying, deadlineMs, null, far), /not a block/);
});

test("release read: a range the head cut, under a stop kept from an earlier round while this read's safe is before the deadline, is not ended and reads no block by number (review P3-2)", async () => {
  const stopWas = FROM + 4_000n;
  const head = FROM + 3_000n;
  const deadlineMs = HEAD_TIME * 1000n - 5_000n;
  const { rpc, calls } = chain({ block: { number: "0x" + head.toString(16), timestamp: "0x" + HEAD_TIME.toString(16) }, safe: { number: "0x" + (FROM + 2_000n).toString(16), timestamp: "0x" + (HEAD_TIME - 100n).toString(16) }, at: () => HEAD_TIME });
  const got = await read(rpc, deadlineMs, stopWas);
  assert.deepEqual([got.stop, got.to, got.ended], [stopWas, head, false]);
  assert.equal(calls.filter(([m, p]) => m === "eth_getBlockByNumber" && p[0] !== "latest" && p[0] !== "safe").length, 0);
});

test("release read: an RPC whose newest block is under `from` (a node gone back) covers nothing, so its read is never ended, even with its safe block past the deadline", async () => {
  const back = FROM - 5n;
  const { rpc, calls } = chain({ block: { number: "0x" + back.toString(16), timestamp: "0x" + HEAD_TIME.toString(16) }, safe: { number: "0x" + (back - 1n).toString(16), timestamp: "0x" + HEAD_TIME.toString(16) } });
  const got = await read(rpc, 0n);
  assert.deepEqual([got.to < FROM, got.ended, got.releases.length], [true, false, 0]);
  assert.equal(calls.filter(([m]) => m === "eth_getLogs").length, 0);
});

test("release read: logs at `from` and at the head are kept", async () => {
  const { rpc } = chain({ logs: [boughtLog({ block: FROM }), boughtLog({ block: HEAD, index: 9n })] });
  const got = await read(rpc);
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
  ["no blockHash", (({ blockHash: _h, ...l }) => l)(boughtLog())],
  ["a short blockHash", { ...boughtLog(), blockHash: "0x12" }],
  ["a token word of 2^160", boughtLog({ token: 1n << 160n })],
];
for (const [why, log] of DROPPED) {
  test(`release read: drops ${why}`, async () => {
    const { rpc } = chain({ logs: [log, boughtLog({ index: 7n })] });
    const got = await read(rpc);
    assert.deepEqual(got.releases, [{ ...BOUGHT, index: 7n }], why);
  });
}

test("release read: a head before `from` asks no logs", async () => {
  const { rpc, calls } = chain({ block: { number: "0x0f", timestamp: "0x1" } });
  const got = await read(rpc);
  assert.deepEqual([got.head, got.to, got.releases], [{ number: 15n, timeMs: 1_000n }, 15n, []]);
  assert.deepEqual(calls.map(([m]) => m), ["eth_getBlockByNumber", "eth_getBlockByNumber"]);
});

test("release read: a log answer that is not a list, or a block with no number, throws", async () => {
  for (const logs of [null, {}, "0x"]) await assert.rejects(read(chain({ logs }).rpc), /not a log list/);
  for (const block of [null, { timestamp: "0x1" }, { number: "0x20" }]) await assert.rejects(read(chain({ block }).rpc), /not a block/);
  for (const safe of [null, { timestamp: "0x1" }, { number: "0x20" }]) await assert.rejects(read(chain({ safe }).rpc), /not a block/);
});

// ---- evmBuyVerdict ----

const DEADLINE = 1_700_000_000_000n;
const WANT: EvmBuyWant = { nullifier: NULLIFIER, w: W, feeRecipient: FEE_TO, token: TOKEN, minOut: MIN_OUT, value: VALUE, feeCap: FEE, deadlineMs: DEADLINE };
/** A read whose safe block is at `timeMs`: ended once that is past the deadline. */
const readOf = (releases: EvmRelease[], timeMs = DEADLINE - 1n): EvmReleaseRead => {
  const ended = timeMs > DEADLINE;
  return { head: { number: HEAD, timeMs }, safe: { number: SAFE, timeMs }, stop: ended ? SAFE : null, to: ended ? SAFE : HEAD, ended, releases };
};
const both = (a: EvmRelease[], b: EvmRelease[] = a, ta?: bigint, tb?: bigint) => evmBuyVerdict([readOf(a, ta), readOf(b, tb)], WANT);

test("verdict: one Bought the same on both, to W, the fee recipient, the token, the value and fee, out at least min out: filled", () => {
  assert.deepEqual(both([BOUGHT]), { end: "filled", release: BOUGHT });
});

test("verdict: the two reads differing in any one field of the release: null", () => {
  const changed: Partial<EvmRelease>[] = [{ block: BOUGHT.block + 1n }, { blockHash: "0x" + "11".repeat(32) }, { tx: OTHER_TX }, { index: BOUGHT.index + 1n }, { recipient: OTHER_W }, { feeRecipient: OTHER_FEE_TO }, { value: VALUE + 1n }, { fee: FEE + 1n }, { token: OTHER_TOKEN }, { out: BOUGHT.out! + 1n }];
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

test("verdict: none on both is not_landed only once both reads are ended (each covered to a safe block past the deadline)", () => {
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
