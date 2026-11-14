// Card first-sign-in-reads-fast: a seat whose provider's backends page narrow under the widest page it already answered
// walks to a free spare that is not known to be narrow, and a read on a list with a spare still keeps several pages in
// flight. Box runs of the page's sign-in on an empty store, 14 Nov 04:38-04:40Z (--local --net, n=3): in run 1
// robinhood.api.pocket.network answered 513 calls (Robinhood walked 41.1 s after Solana), in run 2 base.api.pocket.network
// 291 (Base 24.5 s after Solana): one URL whose backends answer 100,000 blocks or more and also refuse at "max 10001"
// or 500. Read 14 Nov 05:01-05:02Z, the Robinhood pool's 5,498,193 blocks from its deploy block: rpc-robinhood.
// globalstake.io answered the whole span at once (3 logs, 353 ms); rpc.mainnet.chain.robinhood.com refuses past 100,000.
// No wall clock here: each provider answers every call open to it once a round, so the rounds are the read's time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_POOL_LOG_PAGE_MAX_BLOCKS, EVM_POOL_LOG_PAGES_IN_FLIGHT, evmAgreedLogs, evmPair, evmPoolLogPager, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
// one log every `every` blocks, the same on every provider
const planted = (from: bigint, to: bigint, every: bigint): EvmLogRow[] => {
  const out: EvmLogRow[] = [];
  for (let b = from + 11n; b < to; b += every) out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b}` });
  return out;
};

type Fake = EvmRpc & { calls: number; most: number; sides: Set<number> };
/** A provider answered at each round's end; `refuse(span, n)` its words for its n-th call (null: an answer). Each call
 *  records the seat that asked it: the seat whose provider it is at the ask (evmPair moves a seat before it asks). */
function provider(url: string, logs: EvmLogRow[], refuse: (span: bigint, n: number) => string | null, queue: (() => void)[], seats: () => readonly EvmRpc[]): Fake {
  let open = 0;
  const f = Object.assign(
    (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") return Promise.reject(new Error(`no ${method} here`));
      const on = seats().flatMap((s, k) => (s.url === url ? [k] : []));
      assert.equal(on.length, 1, `${url} asked while seated on ${on.length} seats`);
      f.sides.add(on[0]!);
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      const n = ++f.calls;
      f.most = Math.max(f.most, ++open);
      return new Promise((ok, no) =>
        queue.push(() => {
          open--;
          const why = refuse(to - from + 1n, n);
          if (why !== null) return no(new Error(why));
          ok(logs.filter((l) => l.block >= from && l.block <= to).map((l) => ({ ...l })));
        }),
      );
    },
    { url, calls: 0, most: 0, sides: new Set<number>() },
  ) as Fake;
  return f;
}

/** One agreed read over from..to on the list's pair, answered round by round: its logs and its rounds. */
async function read(list: Fake[], pair: readonly EvmRpc[], from: bigint, to: bigint, queue: (() => void)[]): Promise<{ logs: EvmLogRow[]; rounds: number }> {
  const anchor = { number: to, hash: hash(to), timestamp: 0n, baseFeePerGas: null };
  let done = false;
  const r = evmAgreedLogs(pair as [EvmRpc, EvmRpc], { address: "0x9306359433127c4f3be426f6faeb00a3c41f66db", topics: [] }, (raw) => raw as EvmLogRow, from, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {}).finally(() => void (done = true));
  let rounds = 0;
  while (!done) {
    await new Promise((ok) => setImmediate(ok));
    const now = queue.splice(0);
    if (now.length > 0) rounds++;
    for (const answer of now) answer();
    assert.ok(rounds < 5_000, `the read never ends (${list.map((p) => `${p.url} ${p.calls}`).join(", ")})`);
  }
  return { logs: await r, rounds };
}

const FROM = 108_420_674n;
const TO = 113_875_896n;
const OWN = "https://rpc.mainnet.chain.robinhood.com";
const POCKET = "https://robinhood.api.pocket.network";
const GLOBALSTAKE = "https://rpc-robinhood.globalstake.io";
// Pocket's backends: the first call reaches one that answers wide, then four calls in five reach one capped at 10,001
const pocketWords = (span: bigint, n: number): string | null => (n > 1 && n % 5 !== 0 && span > 10_001n ? "RPC error -32602: eth_getLogs block range too large (max 10001 blocks)" : null);
const ownWords = (cap: bigint) => (span: bigint) => (span > cap ? `RPC error -32602: query spans ${span} blocks, but only ${cap} are allowed for this request` : null);

const CASES = [
  {
    // seat 0 wide, so only the narrow seat can set the rounds (red at febe1807b: Pocket paged at 10,001, one page a
    // round); the walk alone takes it to the spare
    name: "Pocket narrow beside a wide seat walks to GlobalStake: the rounds are the wide pages'",
    own: ownWords(EVM_POOL_LOG_PAGE_MAX_BLOCKS),
    // its pages at the sync's widest, the first ones doubling up to it, and a few more
    bound: Number((TO - FROM) / EVM_POOL_LOG_PAGE_MAX_BLOCKS) + 1 + 8,
  },
  {
    // the pool as read: Robinhood's own at 100,000, so its 55 pages are the read's bound unless they are in flight
    // together on a list with a spare (red after the walk alone: 57 rounds)
    name: "Robinhood's own at its 100,000 cap and Pocket narrow, GlobalStake spare: about a quarter of the capped side's pages",
    own: ownWords(100_000n),
    bound: Math.ceil(Number((TO - FROM) / 100_000n + 1n) / EVM_POOL_LOG_PAGES_IN_FLIGHT) + 8,
  },
];

for (const c of CASES) {
  test(`card first-sign-in-reads-fast: ${c.name}; every log once and in order, no provider on both sides of the read`, async (t) => {
    const queue: (() => void)[] = [];
    const logs = planted(FROM, TO, 37_000n);
    let pair: readonly EvmRpc[] = [];
    const own = provider(OWN, logs, c.own, queue, () => pair);
    const pocket = provider(POCKET, logs, pocketWords, queue, () => pair);
    const spare = provider(GLOBALSTAKE, logs, () => null, queue, () => pair);
    const list = [own, pocket, spare];
    pair = evmPair(list);
    const got = await read(list, pair, FROM, TO, queue);
    assert.deepEqual(got.logs.map((l) => l.block), logs.map((l) => l.block), "every log once, in order");
    const calls = list.map((p) => `${new URL(p.url!).host} ${p.calls} calls, ${p.most} at once, seats ${[...p.sides].join("+")}`).join("; ");
    t.diagnostic(`${got.rounds} rounds (bound ${c.bound}): ${calls}`);
    assert.ok(got.rounds <= c.bound, `${got.rounds} rounds (bound ${c.bound}): ${calls}`);
    for (const p of list) {
      assert.ok(p.sides.size <= 1, `${p.url} answered on both sides of one agreed read: ${calls}`);
      assert.ok(p.most <= EVM_POOL_LOG_PAGES_IN_FLIGHT, `${p.url}: ${p.most} calls at once`);
    }
  });
}

test("card first-sign-in-reads-fast: with no spare free, a narrow backend's refusal is asked again on its own provider, never the other seat's", async () => {
  const queue: (() => void)[] = [];
  const logs = planted(FROM, FROM + 2_000_000n, 37_000n);
  let pair: readonly EvmRpc[] = [];
  const own = provider(OWN, logs, ownWords(EVM_POOL_LOG_PAGE_MAX_BLOCKS), queue, () => pair);
  const pocket = provider(POCKET, logs, pocketWords, queue, () => pair);
  pair = evmPair([own, pocket]);
  const got = await read([own, pocket], pair, FROM, FROM + 2_000_000n, queue);
  assert.deepEqual(got.logs.map((l) => l.block), logs.map((l) => l.block));
  assert.deepEqual([...own.sides], [0]);
  assert.deepEqual([...pocket.sides], [1]);
});
