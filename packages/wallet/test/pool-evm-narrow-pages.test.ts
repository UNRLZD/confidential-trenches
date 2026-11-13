// Card restore-walks-every-pool-on-129: the pool sync's agreed read on a seat whose provider pages narrow keeps several
// pages in flight there, so a cold restore's walk is not one narrow page after another over the pool's whole history.
// Release 129's live run 43449697702 (job 131968626761, 13 Nov 15:10Z) never walked every pool within 120 s: its 507
// calls to robinhood.api.pocket.network are the Robinhood pool's 5,039,892 blocks from its deploy block 108,420,674 to
// the head (113,460,566, read 15:3xZ on rpc.mainnet.chain.robinhood.com) at Pocket's "max 10001 blocks" backends, one
// at a time at about 250 ms a call; the rerun at the same build (job 131974257966) paged it in 108 and walked in 67 s.
// No wall clock here: each provider answers every call open to it once a round, so the rounds are the read's time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmAgreedLogs, evmPair, evmPoolLogPager, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

// the pages in flight on a narrow provider: robinhood.api.pocket.network answered 4 at once in every round (kit
// buy-unpinned.ts robinhood scan spares, 5 Nov 19:48Z) and limits 1,200 a minute (x-ratelimit-limit, 7 Nov)
const IN_FLIGHT = 4;
const FROM = 108_420_674n;
const TO = 113_460_566n;
const EVERY = 37_000n;
const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
// one log every EVERY blocks, the same on both providers
const planted = (): EvmLogRow[] => {
  const out: EvmLogRow[] = [];
  for (let b = FROM + 11n; b < TO; b += EVERY) out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b}` });
  return out;
};

type Fake = EvmRpc & { calls: number; most: number };
function provider(url: string, refuse: (span: bigint) => string | null, queue: (() => void)[]): Fake {
  const logs = planted();
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

test("card restore-walks-every-pool-on-129: a cold sync over 5.04M blocks on a pair where one provider pages at 10,001 blocks ends in a fraction of its pages' rounds, every log once and in order, and the wide provider still asks one page at a time", async () => {
  const queue: (() => void)[] = [];
  // Robinhood's own: 100,000 blocks a call on the pool's filter (its three topics in one position)
  const own = provider("https://rpc.mainnet.chain.robinhood.com", (span) => (span > 100_000n ? `RPC error -32602: query spans ${span} blocks, but only 100000 are allowed for this request` : null), queue);
  // Pocket with every backend at 10,001 blocks, as at the failed run
  const pocket = provider("https://robinhood.api.pocket.network", (span) => (span > 10_001n ? "RPC error -32602: eth_getLogs block range too large (max 10001 blocks)" : null), queue);
  const anchor = { number: TO, hash: hash(TO), timestamp: 0n, baseFeePerGas: null };
  let done = false;
  const read = evmAgreedLogs(evmPair([own, pocket]), { address: "0x9306359433127c4f3be426f6faeb00a3c41f66db", topics: [] }, (raw) => raw as EvmLogRow, FROM, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {}).finally(() => void (done = true));
  let rounds = 0;
  while (!done) {
    await new Promise((r) => setImmediate(r));
    const now = queue.splice(0);
    if (now.length > 0) rounds++;
    for (const answer of now) answer();
    assert.ok(rounds < 5_000, "the read never ends");
  }
  const logs = await read;
  assert.deepEqual(logs.map((l) => l.block), planted().map((l) => l.block), "every log once, in order");
  // one 10,001-block page after another is 504 rounds; with IN_FLIGHT on the narrow side about a
  // quarter of that, plus its first halvings from 100,000 (red at the card's base: 509 rounds)
  const bound = Number((TO - FROM + 1n) / 10_001n) / IN_FLIGHT + 40;
  assert.ok(rounds <= bound, `${rounds} rounds for ${pocket.calls} calls on the 10,001-block side (bound ${bound})`);
  assert.ok(pocket.most <= IN_FLIGHT, `${pocket.most} calls at once on the narrow side`);
  // Robinhood's own answers 429 to 4 at once (kit buy-unpinned.ts robinhood scan, read 3 Nov 20:27Z): its 100,000-block
  // pages go one at a time
  assert.equal(own.most, 1, `${own.most} calls at once on the wide side`);
});
