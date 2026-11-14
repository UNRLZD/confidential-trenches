// Card first-sign-in-reads-fast: a provider whose backends answer one range under different caps is paged at its wide
// backends' width, never at the cap one narrow backend named. Live run 43580687640 (14 Nov) read Base 16.9 s after
// Solana (median of 3) against the 12 s bar. Read 14 Nov 10:2xZ from this Mac, the page's sign-in on an empty store, the
// Base pool's reads on base.api.pocket.network (one URL, 153 eth_getLogs in the slow run): its backends answered pages of
// 80,008 and 100,000 blocks and refused "invalid argument 0: block range exceeds maximum 500" (44 of 153 calls, at
// every size from 2,500 up), "eth_getLogs block range too large (max 10001 blocks)" (2, the first call among them) and
// "query exceeds max block range 100000" past 100,000 (4). The first call's "max 10001" was taken as the read's cap, and
// each later "maximum 500" refused three times in a row halved it: 98-153 pages, Base 15-35 s after Solana, where
// base-rpc.publicnode.com (a true 50,000 cap) paged the same blocks in 65 calls. No wall clock here: each provider
// answers every call open to it once a round, so the rounds are the read's time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVM_POOL_LOG_PAGES_IN_FLIGHT, evmAgreedLogs, evmPair, evmPoolLogPager, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
const planted = (from: bigint, to: bigint, every: bigint): EvmLogRow[] => {
  const out: EvmLogRow[] = [];
  for (let b = from + 11n; b < to; b += every) out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b}` });
  return out;
};

type Fake = EvmRpc & { calls: number; spans: bigint[] };
/** A provider answered at each round's end; `refuse(span, n)` its words for its n-th call (null: an answer). */
function provider(url: string, logs: EvmLogRow[], refuse: (span: bigint, n: number) => string | null, queue: (() => void)[]): Fake {
  const f = Object.assign(
    (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") return Promise.reject(new Error(`no ${method} here`));
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      const n = ++f.calls;
      f.spans.push(to - from + 1n);
      return new Promise((ok, no) =>
        queue.push(() => {
          const why = refuse(to - from + 1n, n);
          if (why !== null) return no(new Error(why));
          ok(logs.filter((l) => l.block >= from && l.block <= to).map((l) => ({ ...l })));
        }),
      );
    },
    { url, calls: 0, spans: [] as bigint[] },
  ) as Fake;
  return f;
}

async function read(list: Fake[], pair: readonly EvmRpc[], from: bigint, to: bigint, queue: (() => void)[]): Promise<{ logs: EvmLogRow[]; rounds: number }> {
  const anchor = { number: to, hash: hash(to), timestamp: 0n, baseFeePerGas: null };
  let done = false;
  const r = evmAgreedLogs(pair as [EvmRpc, EvmRpc], { address: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf", topics: [] }, (raw) => raw as EvmLogRow, from, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async () => {}).finally(() => void (done = true));
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

// the Base pool's deploy block and about the finalized head the slow runs read to (14 Nov)
const FROM = 54_325_671n;
const TO = FROM + 3_600_000n;
const PUBLICNODE = "https://base-rpc.publicnode.com";
const POCKET = "https://base.api.pocket.network";
const publicnodeWords = (span: bigint): string | null => (span > 50_000n ? "RPC error -32701: exceed maximum block range: 50000" : null);
const MAX_500 = "RPC error -32602: invalid argument 0: block range exceeds maximum 500";
const MAX_10001 = "RPC error -32602: eth_getLogs block range too large (max 10001 blocks)";
const MAX_100000 = "RPC error -32602: query exceeds max block range 100000";
/** Pocket's backend for its n-th call, drawn as the reads above found them: about three calls in ten reach one capped at
 *  500, one in twenty one capped at 10,001, the rest one that answers up to 100,000; `first` the first call's. */
const pocketWords = (first: string | null) => (span: bigint, n: number): string | null => {
  const draw = n === 1 ? first : (n * 2_654_435_761) % 1_000 < 300 ? MAX_500 : (n * 2_654_435_761) % 1_000 < 350 ? MAX_10001 : null;
  if (draw === MAX_500 && span > 500n) return MAX_500;
  if (draw === MAX_10001 && span > 10_001n) return MAX_10001;
  return span > 100_000n ? MAX_100000 : null;
};

// publicnode's 72 pages of 50,000, four in flight once its cap holds, and a few more for the first pages and the probes
const BOUND = Math.ceil(Number((TO - FROM) / 50_000n + 1n) / EVM_POOL_LOG_PAGES_IN_FLIGHT) + 8;

for (const [name, first] of [
  ["its first call reaches the 10,001 backend", MAX_10001],
  ["its first call reaches the 500 backend", MAX_500],
  ["its first call reaches a wide backend", null],
] as const) {
  test(`card first-sign-in-reads-fast: Pocket's mixed backends beside publicnode's 50,000 cap (${name}): Pocket pages at 100,000 and ends with publicnode`, async (t) => {
    const queue: (() => void)[] = [];
    const logs = planted(FROM, TO, 37_000n);
    const a = provider(PUBLICNODE, logs, publicnodeWords, queue);
    const b = provider(POCKET, logs, pocketWords(first), queue);
    const pair = evmPair([a, b]);
    const got = await read([a, b], pair, FROM, TO, queue);
    assert.deepEqual(got.logs.map((l) => l.block), logs.map((l) => l.block), "every log once, in order");
    const narrow = b.spans.filter((s) => s < 50_000n).length;
    const calls = `${got.rounds} rounds (bound ${BOUND}); publicnode ${a.calls} calls; Pocket ${b.calls} calls, ${narrow} under 50,000 blocks`;
    t.diagnostic(calls);
    assert.ok(got.rounds <= BOUND, calls);
    // Pocket's pages: its 36 of 100,000 asked again past each narrow backend's refusal, and the tails of its parts
    assert.ok(narrow <= EVM_POOL_LOG_PAGES_IN_FLIGHT * 2, calls);
  });
}

test("card first-sign-in-reads-fast: a provider whose every backend caps at 10,001 is still paged at 10,001 (its named cap, after its first page is asked again)", async () => {
  const queue: (() => void)[] = [];
  const to = FROM + 400_000n;
  const logs = planted(FROM, to, 37_000n);
  const a = provider(PUBLICNODE, logs, publicnodeWords, queue);
  const b = provider(POCKET, logs, (span) => (span > 10_001n ? MAX_10001 : null), queue);
  const got = await read([a, b], evmPair([a, b]), FROM, to, queue);
  assert.deepEqual(got.logs.map((l) => l.block), logs.map((l) => l.block));
  // the first page of 100,000 asked three times in all, then every page at the named 10,001 (and its probes past it)
  const refused = b.spans.filter((s) => s > 10_001n).length;
  assert.ok(refused <= 8, `Pocket: ${b.calls} calls, ${refused} past its cap: ${b.spans.join(",")}`);
  assert.ok(b.calls <= Number(400_000n / 10_001n) + 1 + refused, `Pocket: ${b.calls} calls: ${b.spans.join(",")}`);
});
