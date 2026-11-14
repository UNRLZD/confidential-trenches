// Card first-sign-in-reads-fast: a cold restore's pool read on a provider held at its own range cap above the narrow
// line keeps several pages in flight there, so the first restore on a new device is not one capped page after
// another over the pool's whole history. Read 14 Nov 03:4xZ from this Mac (evmTreeSync + evmLatestHigh on the page's
// mainnet lists, every call timed): the Robinhood pool's 5,455,222 blocks from its deploy block 108,420,674 to the
// head 113,875,896 took 22.0 s, of which rpc.mainnet.chain.robinhood.com's 100,000-block cap paged 55 pages one after
// another at about 280 ms (4.3 s to 21.2 s), while robinhood.api.pocket.network's 800,000-block pages ended at 5.3 s;
// on Base, base-rpc.publicnode.com's 50,000-block cap is 58 pages over the pool's 2,862,671 blocks
// (54,325,671..57,188,342). The page's sign-in measured the same (Robinhood walked at p50 24.5 s, Base at 25.9 s).
// No wall clock here: each provider answers every call open to it once a round, so the rounds are the read's time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_POOL_LOG_PAGES_IN_FLIGHT, evmAgreedLogs, evmPair, evmPoolLogPager, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
// one log every `every` blocks, the same on both providers
const planted = (from: bigint, to: bigint, every: bigint): EvmLogRow[] => {
  const out: EvmLogRow[] = [];
  for (let b = from + 11n; b < to; b += every) out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b}` });
  return out;
};

type Fake = EvmRpc & { calls: number; most: number };
function provider(url: string, logs: EvmLogRow[], refuse: (span: bigint) => string | null, queue: (() => void)[]): Fake {
  let open = 0;
  const f = Object.assign(
    (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") return Promise.reject(new Error(`no ${method} here`));
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      f.calls++;
      f.most = Math.max(f.most, ++open);
      // answered at the round's end, with every other call open now
      return new Promise((ok, no) =>
        queue.push(() => {
          open--;
          const why = refuse(to - from + 1n);
          if (why !== null) return no(new Error(why));
          ok(logs.filter((l) => l.block >= from && l.block <= to).map((l) => ({ ...l })));
        }),
      );
    },
    { url, calls: 0, most: 0 },
  ) as Fake;
  return f;
}

/** The agreed read over from..to on the pair, answered round by round: its logs and its rounds. */
async function read(capped: Fake, wide: Fake, from: bigint, to: bigint, queue: (() => void)[]): Promise<{ logs: EvmLogRow[]; rounds: number }> {
  const anchor = { number: to, hash: hash(to), timestamp: 0n, baseFeePerGas: null };
  let done = false;
  const r = evmAgreedLogs(evmPair([capped, wide]), { address: "0x9306359433127c4f3be426f6faeb00a3c41f66db", topics: [] }, (raw) => raw as EvmLogRow, from, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {}).finally(() => void (done = true));
  let rounds = 0;
  while (!done) {
    await new Promise((ok) => setImmediate(ok));
    const now = queue.splice(0);
    if (now.length > 0) rounds++;
    for (const answer of now) answer();
    assert.ok(rounds < 5_000, "the read never ends");
  }
  return { logs: await r, rounds };
}

const CASES = [
  {
    name: "Robinhood: rpc.mainnet.chain.robinhood.com at its 100,000-block cap, Pocket at 800,000",
    from: 108_420_674n,
    to: 113_875_896n,
    cap: 100_000n,
    capped: "https://rpc.mainnet.chain.robinhood.com",
    words: (span: bigint) => `RPC error -32602: query spans ${span} blocks, but only 100000 are allowed for this request`,
    wide: "https://robinhood.api.pocket.network",
  },
  {
    name: "Base: base-rpc.publicnode.com at its 50,000-block cap, Pocket at 800,000",
    from: 54_325_671n,
    to: 57_188_342n,
    cap: 50_000n,
    capped: "https://base-rpc.publicnode.com",
    words: () => "RPC error -32701: exceed maximum block range: 50000",
    wide: "https://base.api.pocket.network",
  },
  {
    // the pool as it ages: no cap under the sync's widest page on either side, 20M blocks (Base at 5 blocks a second,
    // about 46 days), one EVM_POOL_LOG_PAGE_MAX_BLOCKS page after another before the card
    name: "an aged pool: both providers at the sync's widest page, 800,000 blocks",
    from: 54_325_671n,
    to: 74_325_670n,
    cap: 800_000n,
    capped: "https://base-rpc.publicnode.com",
    words: () => "RPC error -32701: exceed maximum block range: 800000",
    wide: "https://base.api.pocket.network",
  },
];

for (const c of CASES) {
  test(`card first-sign-in-reads-fast: ${c.name}: the cold read takes about a quarter of the capped side's pages in rounds, every log once and in order, at most ${EVM_POOL_LOG_PAGES_IN_FLIGHT} calls at once a provider`, async () => {
    const queue: (() => void)[] = [];
    const logs = planted(c.from, c.to, 37_000n);
    const capped = provider(c.capped, logs, (span) => (span > c.cap ? c.words(span) : null), queue);
    const wide = provider(c.wide, logs, () => null, queue);
    const got = await read(capped, wide, c.from, c.to, queue);
    assert.deepEqual(got.logs.map((l) => l.block), logs.map((l) => l.block), "every log once, in order");
    // N pages at the cap: one after another they are N rounds (red at 606fc443c: 58, 62 and 28); with
    // EVM_POOL_LOG_PAGES_IN_FLIGHT in flight a quarter of them, plus the first pages that find the cap and each part's
    // one probe past it
    const pages = Number((c.to - c.from + c.cap) / c.cap);
    const bound = Math.ceil(pages / EVM_POOL_LOG_PAGES_IN_FLIGHT) + 8;
    assert.ok(got.rounds <= bound, `${got.rounds} rounds for ${capped.calls} calls on the capped side, ${pages} pages at its cap (bound ${bound})`);
    assert.ok(capped.most <= EVM_POOL_LOG_PAGES_IN_FLIGHT, `${capped.most} calls at once on the capped side`);
    assert.ok(wide.most <= EVM_POOL_LOG_PAGES_IN_FLIGHT, `${wide.most} calls at once on the wide side`);
  });
}
