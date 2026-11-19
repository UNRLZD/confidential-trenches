// node --test apps/helper/src/data/evm/vendor-tape-from-our-reads.test.ts (card helper-vendor-tapes-refresh-inside-15s):
// a Base or Robinhood coin whose tape is the vendor's rows (swaps.ts noneTrades) keeps renewing inside BEHIND_MAX's ms
// while a page holds it when the vendor refuses every call: the vendor named its pool once, and each refresh after it
// reads that pool on our own providers (runRound), its new rows exact from their receipts. Red at ec662fe86: a held
// tape's refresh was a vendor call only, and with the key's background day spent (the deployed helper 19 Nov, every
// held refresh refused from 10:43Z) its rows aged to STALE_MS, then were read again on the callers' share.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fakeChain, REC, URLS } from "../../../test/evm-swaps/robinhood.ts";
import { CG_ONCHAIN, coingeckoPace, createKeyed } from "../coingecko.ts";
import { geckoBudget } from "../gecko.ts";
import { providerHolds } from "../../limits/limits.ts";
import { GT_BASE } from "./lists.ts";
import { BEHIND_MAX, createSwaps, heldFilters, poolTrades, parseLogs, provenHooks, TOPIC, type HeldPool } from "./swaps.ts";

const KEY = ["CG", "planted", "evm", "tape", "key"].join("-");
const VENDOR_READ = /(?:^|,)\s*evm-vendor-read;desc="rows read (\d+) ms ago"/;
const PRICE_READ = /evm-vendor-price;desc="usd read (\d+) ms ago"/;
const TRANSFER = TOPIC.transfer;
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((ok) => setImmediate(ok));
};

type R = { coin: string; pool: string; trades: (Record<string, unknown> & { id: string; tx_hash: string; legs: { from: [string, string]; to: [string, string] } })[] };
const SOGNI = JSON.parse(readFileSync(new URL("./fixtures/gt-pool-trades-sogni-base.json", import.meta.url), "utf8")) as R;
const RECEIPTS = (JSON.parse(readFileSync(new URL("./fixtures/vendor-rows-receipts.json", import.meta.url), "utf8")) as { sogni: Record<string, { blockNumber: string; logs: Record<string, string | string[]>[] }> }).sogni;

/** The recorded SOGNI pool (Base's Aerodrome SOGNI/USDT pair 0xcc68cb8b, fixtures/gt-pool-trades-sogni-base.json) held
 *  on `chain` (its reads answered by the recorded Robinhood providers, test/evm-swaps/robinhood.ts, whose other reads
 *  find SOGNI no pool on either chain, so it is a vendor coin on both): the vendor's first answer holds every row but the newest, then the vendor refuses every call (429), and
 *  the newest trade is on chain: its receipt's logs, at the head, are the answer of our reads of the pool. */
function harness(chain: "base" | "robinhood", o: { vendorRows?: number } = {}) {
  const c = fakeChain();
  const head = REC.lastHead;
  c.st.head = head;
  // Base's swap reads ask 1,000 blocks a log read (VENUES step): its providers take them
  if (chain === "base") for (const u of URLS) c.st.faults.set(u, { span: 1_000 });
  const clock = { t: Date.parse("2026-11-14T17:27:00Z") };
  const [newest, ...rest] = SOGNI.trades;
  // the vendor's first answer: every row but the newest, or its oldest `vendorRows`
  const older = o.vendorRows === undefined ? rest : SOGNI.trades.slice(-o.vendorRows);
  const answer = (rows: R["trades"]) => ({ data: rows.map(({ id, legs, ...a }) => ({ id, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) });
  let refuse = false;
  let top = SOGNI.pool;
  const vendorCalls: string[] = [];
  const logReads: unknown[] = [];
  // a trade's logs touching the pool, logged at `block` with their block's time; the newest at the head unless placed
  const newLogs: Record<string, unknown>[] = [];
  const place = (t: R["trades"][number], block: number) => newLogs.push(...RECEIPTS[t.tx_hash]!.logs.map((l) => ({ ...l, transactionHash: t.tx_hash, blockNumber: `0x${block.toString(16)}`, blockTimestamp: `0x${Math.floor(Date.parse(String(t.block_timestamp)) / 1000).toString(16)}`, removed: false })));
  if (o.vendorRows === undefined) place(newest!, head);
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (url.startsWith(CG_ONCHAIN) || url.startsWith(GT_BASE)) {
      vendorCalls.push(url);
      if (refuse) return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
      if (url.includes(`/tokens/${SOGNI.coin}/pools?page=1`)) return new Response(JSON.stringify({ data: [{ id: `${chain}_${top}`, attributes: { address: top } }] }), { status: 200 });
      if (url.includes(`/pools/${top}/trades?token=${SOGNI.coin}`)) return new Response(JSON.stringify(answer(older)), { status: 200 });
      return new Response("{}", { status: 404 });
    }
    const reqs = JSON.parse(String(init.body ?? "null")) as { id: number; method: string; params: Record<string, unknown>[] }[] | null;
    if (Array.isArray(reqs) && reqs.every((r) => r.method === "eth_getTransactionReceipt"))
      return new Response(JSON.stringify(reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: RECEIPTS[r.params[0] as unknown as string] ?? null }))), { status: 200 });
    // our reads of the held pools (heldFilters): each answered from the newest trade's logs in its range and topics
    const held = (r: { method: string; params: Record<string, unknown>[] }) => r.method === "eth_getLogs" && Array.isArray(r.params[0]?.topics) && (r.params[0]!.topics as unknown[])[0] === TRANSFER && Array.isArray(r.params[0]!.address);
    if (Array.isArray(reqs) && reqs.length > 0 && reqs.every(held)) {
      logReads.push(reqs.map((r) => r.params[0]));
      return new Response(
        JSON.stringify(
          reqs.map((r) => {
            const f = r.params[0]!;
            const [lo, hi] = [parseInt(String(f.fromBlock), 16), parseInt(String(f.toBlock), 16)];
            const t = f.topics as (string | string[] | null)[];
            const at = (v: unknown, x: string) => v == null || (Array.isArray(v) ? v.includes(x) : v === x);
            return { jsonrpc: "2.0", id: r.id, result: newLogs.filter((l) => parseInt(String(l.blockNumber), 16) >= lo && parseInt(String(l.blockNumber), 16) <= hi && (f.address as string[]).includes(String(l.address)) && (l.topics as string[]).length === 3 && (l.topics as string[]).every((x, i) => i >= t.length || at(t[i], x))) };
          }),
        ),
        { status: 200 },
      );
    }
    return c.fetch(url, init);
  };
  const env = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" };
  const holds = providerHolds(() => clock.t, coingeckoPace(env));
  const keyed = createKeyed(env, holds, { fetch: fetch as never })!;
  const gecko = geckoBudget(() => clock.t);
  const s = createSwaps(chain, { fetch, now: () => clock.t, listed: async () => true, rpcs: URLS, pools: new Map(), tickMs: 0, gecko, keyed, sleep: async (ms: number) => void (clock.t += ms) });
  after(() => s.stop());
  const tape = async () => {
    const a = await s.trades(SOGNI.coin, 50);
    const named = VENDOR_READ.exec(a.timing ?? "")?.[1];
    return { ...a, j: JSON.parse(a.body) as { trades: { tx: string; side: string; amt: string; usd: string; trader: string | null; t_ms: number }[]; src: string; whole_ms?: number }, age: named === undefined ? NaN : Number(named), price: PRICE_READ.exec(a.timing ?? "")?.[1] };
  };
  return { clock, tape, newest: newest!, refuse: () => void (refuse = true), moveTo: (p: string) => void (top = p), vendorCalls, logReads, head, place, setHead: (n: number) => void (c.st.head = n) };
}

for (const chain of ["base", "robinhood"] as const)
  test(`${chain}: a held vendor tape with the vendor refusing every call is read every 2 s for 2 minutes: every answer names its rows read inside BEHIND_MAX's ms, the newest trade on chain is served exact, and no vendor call is made (red at ec662fe86: each refresh was a vendor call, refused, and the rows aged to STALE_MS)`, async () => {
    const h = harness(chain);
    const first = await h.tape();
    assert.equal(first.status, 200, first.body.slice(0, 160));
    await settle();
    const cold = await h.tape();
    assert.equal(cold.j.trades.length, 5, "the vendor's first answer: every row but the newest");
    h.refuse();
    const calls = h.vendorCalls.length;
    const ages: number[] = [];
    let last = cold;
    for (const end = h.clock.t + 120_000; h.clock.t < end; ) {
      h.clock.t += 2_000;
      await settle();
      last = await h.tape();
      assert.equal(last.status, 200);
      ages.push(last.age);
    }
    assert.ok(ages.every(Number.isFinite), "every answer names its rows' age");
    const max = Math.max(...ages);
    assert.ok(max <= BEHIND_MAX[chain].ms, `oldest rows served ${max} ms after their read (bound ${BEHIND_MAX[chain].ms}): ${ages.join(",")}`);
    // none but the list of the quote token's pools (USDT, a third token), which its route is picked from: once a STALE_MS
    // while the vendor refuses it, on the key and keyless (card evm-quote-token-priced-from-our-reads)
    const quoteList = `/tokens/0xfde4c96c8593536e31f229ea8f37b2ada2699bb2/pools?page=1`;
    const held = h.vendorCalls.slice(calls);
    assert.deepEqual(held.filter((u) => !u.endsWith(quoteList)), [], `no vendor call while held but the quote's pools: ${held.join(" ")}`);
    assert.ok(held.length <= 2 * Math.ceil(120_000 / 60_000 + 1), `the quote's pools asked ${held.length} times in 2 minutes`);
    // the newest trade, made exact from its receipt as the vendor's row is (its amount and its trader)
    const top = last.j.trades[0]!;
    assert.deepEqual([top.tx, top.side, top.amt, top.trader], [h.newest.tx_hash, "s", "49434.974158618859129157", h.newest.tx_from_address], "the receipt's exact amount the vendor printed as 49434.9741586189");
    // its USD: the quote's 86.710609 USDT at the USD per unit the vendor's own rows paid (USDT is no USD token of ours)
    assert.ok(Math.abs(Number(top.usd) - Number(h.newest.volume_in_usd)) / Number(h.newest.volume_in_usd) < 0.01, `usd ${top.usd} vs the vendor's ${String(h.newest.volume_in_usd)}`);
    assert.ok(last.price !== undefined, "a row priced at the vendor's rate names that price's age");
    assert.equal(last.j.trades.length, 6);
    // one log read a round, at most three filters (two per five pairs, one for the v4 pools)
    for (const r of h.logReads as unknown[][]) assert.ok(r.length <= 3, `a round's post asked ${r.length} filters`);
  });

for (const chain of ["base", "robinhood"] as const)
  test(`${chain}: a burst our round cannot read in one (the head 3,000 blocks on, past a round's ROUND_MS of blocks; trades at its far end, middle and newest) is served with no whole_ms until every block since the held newest is read, newest first, then whole and in order (red at d8b68dcb0: a round read the newest FIRST_BACK_MS of blocks only, the blocks before skipped and the list claimed whole)`, async () => {
    const h = harness(chain, { vendorRows: 3 });
    await h.tape();
    await settle();
    const cold = await h.tape();
    assert.deepEqual(cold.j.trades.map((t) => t.tx), SOGNI.trades.slice(-3).map((t) => t.tx_hash), "the vendor's first answer: its three oldest rows");
    h.refuse();
    // the coin's first round of our reads, to the head
    for (let i = 0; i < 10 && h.logReads.length === 0; i++) {
      h.clock.t += 2_000;
      await settle();
      await h.tape();
    }
    assert.ok(h.logReads.length > 0, "our round read the pool");
    h.clock.t += 2_000;
    await settle();
    assert.ok((await h.tape()).j.whole_ms !== undefined, "read to the head: whole");
    // the burst: three trades the vendor never named, spread over 3,000 blocks the head moves on at once
    const [t0, t1, t2] = SOGNI.trades;
    h.place(t2!, h.head + 50);
    h.place(t1!, h.head + 1_500);
    h.place(t0!, h.head + 2_990);
    h.setHead(h.head + 3_000);
    const seen: { txs: string[]; whole: boolean }[] = [];
    for (let i = 0; i < 40; i++) {
      h.clock.t += 2_000;
      await settle();
      const a = await h.tape();
      assert.equal(a.status, 200);
      seen.push({ txs: a.j.trades.map((t) => t.tx), whole: a.j.whole_ms !== undefined });
      if (a.j.trades.length === 6 && a.j.whole_ms !== undefined) break;
    }
    const all = SOGNI.trades.map((t) => t.tx_hash);
    const runs = JSON.stringify(seen.map((y) => [y.txs.length, y.whole]));
    // the answers before a round reads the moved head hold the last read's rows (whole to that read, its age named);
    // from the first round after it, never whole while a burst trade is missing
    const first = seen.findIndex((x) => x.txs.length > 3);
    assert.ok(first >= 0, `a round read the burst's newest: ${runs}`);
    assert.deepEqual(seen[first]!.txs[0], t0!.tx_hash, "the newest blocks read first");
    for (const x of seen.slice(first)) if (x.whole) assert.deepEqual(x.txs, all, `whole_ms claimed with ${x.txs.length} of 6 rows: ${runs}`);
    assert.equal(seen[first]!.whole, false, `the first answer after the burst is not whole: ${runs}`);
    assert.deepEqual(seen.at(-1), { txs: all, whole: true }, `every row read, newest first, then whole: ${JSON.stringify(seen.map((y) => [y.txs.length, y.whole]))}`);
  });

test("a held coin's pool name is asked again once GT_POOL_FRESH_MS (10 min) old, never more often: 21 minutes held, the vendor answering, 2 pool calls and no trades call; a top pool that moved is named at the next period and its rows read once from the vendor, the tape kept fresh on the last pool until the new one's rows place it", async () => {
  const h = harness("base");
  await h.tape();
  await settle();
  await h.tape();
  const from = h.vendorCalls.length;
  const ages: number[] = [];
  for (const end = h.clock.t + 21 * 60_000; h.clock.t < end; ) {
    h.clock.t += 2_000;
    await settle();
    ages.push((await h.tape()).age);
  }
  const held = h.vendorCalls.slice(from);
  assert.equal(held.filter((u) => u.includes(`/tokens/${SOGNI.coin}/pools?page=1`)).length, 2, held.join(" "));
  assert.equal(held.filter((u) => u.includes("/trades")).length, 0, "no vendor trades call while our reads renew the tape");
  assert.ok(Math.max(...ages) <= BEHIND_MAX.base.ms, `max age ${Math.max(...ages)}`);
  // the vendor's top pool moves: its name is read at the next period and the new pool's rows once
  const moved = `0x${"9a".repeat(20)}`;
  h.moveTo(moved);
  const at = h.vendorCalls.length;
  for (const end = h.clock.t + 10 * 60_000 + 30_000; h.clock.t < end; ) {
    h.clock.t += 2_000;
    await settle();
    const a = await h.tape();
    assert.ok(a.age <= BEHIND_MAX.base.ms, `age ${a.age} after the move`);
  }
  const after = h.vendorCalls.slice(at);
  assert.equal(after.filter((u) => u.includes(`/tokens/${SOGNI.coin}/pools?page=1`)).length, 1, after.join(" "));
  assert.equal(after.filter((u) => u.includes(`/pools/${moved}/trades`)).length, 1, "the new pool's rows read once from the vendor");
});

test("poolTrades: a pair's trade is its net Transfers of the coin and the quote at the pool (a sell: coin in, quote out); liquidity (both in) is no trade; a v4 pool's is its Swap log's two amounts, the swapper's side", () => {
  const coin = SOGNI.coin;
  const quote = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
  const held: HeldPool[] = [{ token: coin, pool: SOGNI.pool, v4: false, quote }];
  const newest = SOGNI.trades[0]!;
  const logs = parseLogs(RECEIPTS[newest.tx_hash]!.logs.map((l) => ({ ...l, transactionHash: newest.tx_hash, blockNumber: "0x1", removed: false })))!;
  const got = poolTrades(logs, held, "0x0000000000000000000000000000000000000001");
  assert.equal(got.length, 1);
  assert.deepEqual([got[0]!.side, got[0]!.quote], ["s", 86_710_609n]);
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const w = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
  const lp = "0x00000000000000000000000000000000000000aa";
  const add = [coin, quote].map((a, i) => ({ block: 1, index: i, tx: `0x${"ab".repeat(32)}`, address: a, topics: [TRANSFER, pad(lp), pad(SOGNI.pool)], data: w(10n) }));
  assert.deepEqual(poolTrades(add, held, "0x0000000000000000000000000000000000000001"), [], "both legs into the pool: liquidity");
  const pm = "0x00000000000000000000000000000000000000f4";
  const id = `0x${"cd".repeat(32)}`;
  const neg = (v: bigint) => w((1n << 256n) + v);
  const swap = { block: 2, index: 0, tx: `0x${"ef".repeat(32)}`, address: pm, topics: [TOPIC.swap4, id, pad(lp)], data: [neg(-500n), w(7n), w(0n), w(0n), w(0n), w(3000n)].map((x) => x.slice(2)).join("").replace(/^/, "0x") };
  assert.deepEqual(poolTrades([swap], [{ token: coin, pool: id, v4: true, coinLeg: 1 }], pm).map((t) => [t.side, t.coin, t.quote]), [["b", 7n, 500n]], "the swapper got 7 of the coin (leg 1) and paid 500");
  assert.deepEqual(poolTrades([swap], [{ token: coin, pool: id, v4: true, coinLeg: 0 }], pm).map((t) => [t.side, t.coin, t.quote]), [["s", 500n, 7n]]);
  // heldFilters: two filters per five pairs (ten addresses at most), one for every v4 id
  const many: HeldPool[] = Array.from({ length: 6 }, (_, i) => ({ token: `0x${String(i).repeat(40)}`, pool: `0x${String(i + 1).repeat(40)}`, v4: false, quote }));
  const fs = heldFilters([...many, { token: coin, pool: id, v4: true, coinLeg: 0 }], 1, 2, pm);
  assert.equal(fs.length, 5);
  assert.ok(fs.every((f) => !Array.isArray(f.address) || (f.address as string[]).length <= 10));
});

test("provenHooks: a shared v4 swap is checked against its pool's own key, asked of keyOf once a swap (createSwaps reads it once a pool, poolKeyOf), and no candidate key is hashed (red at ec662fe86: every tick spacing to 400, 30,800 keys a swap, 52 slices of 1,000 for two)", async () => {
  const token = `0x${"11".repeat(20)}`;
  const currencies = Array.from({ length: 12 }, (_, i) => `0x${(i + 32).toString(16).padStart(2, "0").repeat(20)}`);
  const pool = `0x${"ab".repeat(32)}`;
  const f = { traders: { from: token }, moves: [], swaps: [{ index: 1, sender: `0x${"22".repeat(20)}`, pool, fee: 3000 }, { index: 2, sender: `0x${"33".repeat(20)}`, pool, fee: 3000 }], currencies } as unknown as Parameters<typeof provenHooks>[0];
  const asked: string[] = [];
  const turns = { n: 0 };
  const real = globalThis.setImmediate;
  globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...a: unknown[]) => (turns.n++, real(fn, ...a))) as typeof setImmediate;
  let got: Awaited<ReturnType<typeof provenHooks>>;
  try {
    got = await provenHooks(f, token, async (id) => (asked.push(id), null));
  } finally {
    globalThis.setImmediate = real;
  }
  assert.deepEqual(asked, [pool, pool], "the pool's key asked for each shared swap");
  assert.equal(turns.n, 0, "no key hashed by the slice");
  assert.ok((got.swaps ?? []).every((s) => s.hook === undefined), "no key: neither is the hook's");
});

test("provenHooks: a hook pool on an uncommon tick spacing (333): its hook's own swap is marked, never a trade; the router's is not (red at d8b68dcb0: the common spacings alone left it unproven and served)", async () => {
  const token = `0x${"11".repeat(20)}`;
  const zora = `0x${"77".repeat(20)}`;
  const hook = `0x${"44".repeat(19)}c0`;
  const router = `0x${"55".repeat(20)}`;
  const w = (n: bigint) => n.toString(16).padStart(64, "0");
  const a = (x: string) => x.slice(2).padStart(64, "0");
  const [c0, c1] = token < zora ? [token, zora] : [zora, token];
  const key = `0x${a(c0)}${a(c1)}${w(3000n)}${w(333n)}${a(hook)}`;
  const id = `0x${Buffer.from(keccak_256(Buffer.from(key.slice(2), "hex"))).toString("hex")}`;
  const f = { traders: { from: router }, moves: [], swaps: [{ index: 1, sender: router, pool: id, fee: 3000 }, { index: 4, sender: hook, pool: id, fee: 3000 }], currencies: [zora] } as unknown as Parameters<typeof provenHooks>[0];
  const got = await provenHooks(f, token, async (x) => (x === id ? key : null));
  assert.deepEqual((got.swaps ?? []).filter((s) => s.hook).map((s) => s.index), [4], "the hook's own swap is marked");
  // a key that does not hash to the id is no key
  const forged = await provenHooks(f, token, async () => `0x${a(c0)}${a(c1)}${w(3000n)}${w(334n)}${a(hook)}`);
  assert.equal((forged.swaps ?? []).some((s) => s.hook), false);
});
