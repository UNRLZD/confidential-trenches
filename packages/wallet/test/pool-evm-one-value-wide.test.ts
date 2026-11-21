// Card firefox-restore-fast: the pool's log read on rpc.mainnet.chain.robinhood.com is one call a topic over the whole
// range, since that provider refuses the pool's filter (three topics in one position) past 100,000 blocks but answers
// any span with one value a position (markets, card evm-reads-paced, 15 Nov 02:20Z: the pool's 6.19M blocks in one call,
// 292 ms; 62 pages on main, which drew its 429s). Any refusal of a wide call and the read pages as before. Base's
// publicnode, which caps one topic too, and every other provider page as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EVM_POOL_EVENTS, evmAgreedLogs, evmPair, evmPoolLogPager, oneValueFilters, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

const topicOf = (sig: string): string => `0x${bytesToHex(keccak_256(new TextEncoder().encode(sig)))}`;

const POOL = "0x9306359433127c4f3be426f6faeb00a3c41f66db";
const TOPICS = [topicOf(EVM_POOL_EVENTS.Deposited), topicOf(EVM_POOL_EVENTS.Withdrawn), topicOf(EVM_POOL_EVENTS.Bought)];
const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
type Row = EvmLogRow & { topic: string };
// one log every 97,003 blocks, the three events in turn, two at one block now and then
const planted = (from: bigint, to: bigint): Row[] => {
  const out: Row[] = [];
  let n = 0;
  for (let b = from + 11n; b < to; b += 97_003n, n++) {
    out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b} 0`, topic: TOPICS[n % 3]! });
    if (n % 5 === 0) out.push({ block: b, blockHash: hash(b), logIndex: 3n, bytes: `log ${b} 3`, topic: TOPICS[(n + 1) % 3]! });
  }
  return out;
};

type Call = { span: bigint; values: number };
type Fake = EvmRpc & { calls: Call[] };
/** A provider: `refuse` sees each call's span and how many values its topic position holds. */
function provider(url: string, logs: Row[], refuse: (c: Call) => string | null): Fake {
  const f = Object.assign(
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") throw new Error(`no ${method} here`);
      const p = params[0] as { fromBlock: string; toBlock: string; address: string; topics: (string | string[])[] };
      assert.equal(p.address, POOL);
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      const t = p.topics[0]!;
      const values = Array.isArray(t) ? t : [t];
      const c = { span: to - from + 1n, values: values.length };
      f.calls.push(c);
      const why = refuse(c);
      if (why !== null) throw new Error(why);
      return logs.filter((l) => l.block >= from && l.block <= to && values.includes(l.topic)).map(({ topic: _t, ...l }) => ({ ...l }));
    },
    { url, calls: [] as Call[] },
  ) as Fake;
  return f;
}

const FROM = 108_420_674n;
const TO = FROM + 6_190_000n;
const LOGS = planted(FROM, TO);
const WANT = LOGS.map(({ topic: _t, ...l }) => l);
const read = (a: Fake, b: Fake): Promise<EvmLogRow[]> => {
  const anchor = { number: TO, hash: hash(TO), timestamp: 0n, baseFeePerGas: null };
  return evmAgreedLogs(evmPair([a, b]), { address: POOL, topics: [TOPICS] }, (raw) => raw as EvmLogRow, FROM, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {});
};
// Robinhood's own: three values in one position past 100,000 blocks refused in its words, one value any span
const robinhood = (oneValue: (c: Call) => string | null = () => null): Fake =>
  provider("https://rpc.mainnet.chain.robinhood.com", LOGS, (c) =>
    c.values > 1 && c.span > 100_000n ? `RPC error -32602: query spans ${c.span} blocks, but only 100000 are allowed for this request; reduce the range or send one value per position` : c.values === 1 ? oneValue(c) : null,
  );
const pocket = (): Fake => provider("https://robinhood.api.pocket.network", LOGS, (c) => (c.span > 800_000n ? "block range exceeds maximum 800000" : null));

test("Robinhood's own RPC: the pool's whole range in one call a topic (3 calls, not 62 pages), the same logs in block order", async () => {
  const own = robinhood();
  const other = pocket();
  assert.deepEqual(await read(own, other), WANT);
  assert.deepEqual(own.calls, [{ span: TO - FROM + 1n, values: 1 }, { span: TO - FROM + 1n, values: 1 }, { span: TO - FROM + 1n, values: 1 }]);
  // the other provider pages as before (three values a call)
  assert.ok(other.calls.length > 1 && other.calls.every((c) => c.values === 3));
});

test("a wide call refused (a result cap, a throttle): the read pages Robinhood's own as before, and finds the same logs", async () => {
  for (const words of ["query returned more than 10000 results", "HTTP 429 Too Many Requests"]) {
    const own = robinhood((c) => (c.span > 100_000n ? words : null));
    assert.deepEqual(await read(own, pocket()), WANT, words);
    const paged = own.calls.filter((c) => c.values === 3);
    assert.ok(paged.length >= 62, `${words}: ${paged.length} pages`);
    assert.ok(paged.every((c) => c.span <= 100_000n || c.span === 200_000n || c.span === 800_000n));
  }
});

test("only Robinhood's own RPC, and only a filter with one position of several values, is read one value a call", () => {
  const f = { address: POOL, topics: [TOPICS] };
  const at = (url: string): EvmRpc => Object.assign(async () => [], { url }) as unknown as EvmRpc;
  assert.equal(oneValueFilters(at("https://base-rpc.publicnode.com"), f), null);
  assert.equal(oneValueFilters(at("https://robinhood.api.pocket.network"), f), null);
  assert.equal(oneValueFilters(at("https://rpc.mainnet.chain.robinhood.com"), { address: POOL, topics: [TOPICS[0]!] }), null);
  assert.equal(oneValueFilters(at("https://rpc.mainnet.chain.robinhood.com"), { address: POOL, topics: [TOPICS, [TOPICS[0]!, TOPICS[1]!]] }), null);
  assert.equal(oneValueFilters(at("not a url"), f), null);
  assert.deepEqual(oneValueFilters(at("https://rpc.mainnet.chain.robinhood.com"), f), TOPICS.map((t) => ({ address: POOL, topics: [t] })));
});

// Card robinhood-reads-past-ten-million-blocks: the pool's deploy block is now more than 10,000,000 blocks back, and
// Robinhood's own RPC refuses a one-value read past that span (live run 44930704040, 21 Nov: the pool's whole history,
// 11,625,840 blocks, "-32602: query spans 11625818 blocks (108420674 to 120046491), but only 10000000 are allowed"). The
// read is asked in spans of its cap, one call a value each, and returns every log: never the whole read refused and the
// pool paged at 100,000 to 800,000 blocks.
const CAP = 10_000_000n;
const LONG_TO = FROM + 11_625_839n;
const LONG = planted(FROM, LONG_TO);
const capped = (cap: bigint) => (c: Call) => (c.span > cap ? `RPC error -32602: query spans ${c.span - 1n} blocks (${FROM} to ${FROM + c.span - 1n}), but only ${cap} are allowed for this request; reduce the range or send one value per position` : null);
const longRead = (a: Fake, b: Fake): Promise<EvmLogRow[]> => {
  const anchor = { number: LONG_TO, hash: hash(LONG_TO), timestamp: 0n, baseFeePerGas: null };
  return evmAgreedLogs(evmPair([a, b]), { address: POOL, topics: [TOPICS] }, (raw) => raw as EvmLogRow, FROM, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {});
};
const longRobinhood = (oneValueCap: bigint): Fake =>
  provider("https://rpc.mainnet.chain.robinhood.com", LONG, (c) =>
    c.values > 1 && c.span > 100_000n ? `RPC error -32602: query spans ${c.span} blocks, but only 100000 are allowed for this request; reduce the range or send one value per position` : c.values === 1 ? capped(oneValueCap)(c) : null,
  );
const longPocket = (): Fake => provider("https://robinhood.api.pocket.network", LONG, (c) => (c.span > 800_000n ? "block range exceeds maximum 800000" : null));

test("Robinhood's own past its 10,000,000-block cap: the pool's 11,625,840 blocks in two spans of the cap, one call a topic each (6 calls), every log in block order", async () => {
  const own = longRobinhood(CAP);
  assert.deepEqual(await longRead(own, longPocket()), LONG.map(({ topic: _t, ...l }) => l));
  const spans = own.calls.map((c) => c.span);
  assert.ok(spans.every((s) => s <= CAP), `a call past the cap: ${spans.filter((s) => s > CAP)}`);
  assert.equal(own.calls.length, 6, `${own.calls.length} calls on Robinhood's own`);
  assert.ok(own.calls.every((c) => c.values === 1));
});

test("a cap Robinhood's own names under the read's span (its words, read from the refusal): the read is asked again in spans of that cap, every log", async () => {
  const own = longRobinhood(4_000_000n);
  assert.deepEqual(await longRead(own, longPocket()), LONG.map(({ topic: _t, ...l }) => l));
  const answered = own.calls.filter((c) => c.span <= 4_000_000n);
  assert.equal(answered.length, 9, "three spans of the cap named, a topic each");
  assert.ok(own.calls.every((c) => c.values === 1), "never paged at three values a call");
});
