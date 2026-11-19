// node --test apps/helper/src/data/solana/tape-from-our-reads.test.ts (card sol-vendor-tape-refresh-from-our-reads): a
// Solana coin whose tape the vendor names a pool for (trades.ts poolTape over token.ts tape) is renewed from our own
// reads of that pool while a page holds it, the vendor called once: its signatures since the newest row, each new
// transaction, and a row from the pool vaults' balance changes (poolLeg). Measured on the deployed helper 19 Nov: the
// CoinGecko background share was spent at about 10:2xZ, every held-tape refresh refused since, and JUP's rows were
// served 39.8 s old (live job 135508383528). Red at ec662fe86: the held tape's refresh is the vendor's, refused, its
// rows aging past SOL_VENDOR_REACH_MS.
// The chain answers are recorded (fixtures/sol-pool-reads-nearkat.json, api.mainnet-beta.solana.com, 19 Nov): the
// NEARKAT Raydium CPMM pool's account, its three signatures after the vendor row 37A3xnWr, those transactions and the
// quote coin's mint; the vendor's rows are fixtures/sol-pool-trades-nearkat.json (GeckoTerminal, 14 Nov).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSolanaToken, type TapeRow } from "./token.ts";
import { createSolanaTrades, FOLLOW_MS, poolLeg, SOL_VENDOR_REACH_MS, TRADES_MAX } from "./trades.ts";

const VENDOR_READ = /(?:^|,)\s*sol-vendor-read;desc="rows read (\d+) ms ago"/;
const ageOf = (timing: string | undefined) => Number(VENDOR_READ.exec(timing ?? "")?.[1] ?? NaN);
type Vendor = { mint: string; pool: string; trades: (Record<string, unknown> & { tx_hash: string; tx_from_address: string; kind: string; block_timestamp: string; volume_in_usd: string; legs: { from: [string, string]; to: [string, string] } })[] };
const V = JSON.parse(readFileSync(new URL("./fixtures/sol-pool-trades-nearkat.json", import.meta.url), "utf8")) as Vendor;
type Chain = { pool: { value: { data: [string, string] } }; quoteMint: unknown; sigs: { signature: string }[]; txs: Record<string, unknown> };
const C = JSON.parse(readFileSync(new URL("./fixtures/sol-pool-reads-nearkat.json", import.meta.url), "utf8")) as Chain;
const QUOTE = "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG";
/** The quote coin's USD price the vendor's rows were priced at (16.270808697 of it for 50.1655 USD, row C4c5gcJq). */
const QUOTE_USD = "3.0832";
/** The vendor's first answer: its rows from 37A3xnWr back (the three newer ones are the chain's to find). */
const SEEDED = 3;
const poolData = Buffer.from(C.pool.value.data[0], "base64");
type Tape = { trades: TapeRow[]; whole_ms?: number; src: string; as_of_ms: number };

/** The vendor (GeckoTerminal): the coin's top pool, and its trades once; then, with `up` false, every call refused. */
function vendor() {
  const answer = { data: V.trades.slice(SEEDED).map(({ legs, ...a }) => ({ id: a.tx_hash, type: "trade", attributes: { ...a, from_token_address: legs.from[0], from_token_amount: legs.from[1], to_token_address: legs.to[0], to_token_amount: legs.to[1] } })) };
  const gt = { up: true, calls: 0 };
  const fetch = async (url: string): Promise<Response> => {
    gt.calls++;
    if (!gt.up) return new Response("{}", { status: 500 });
    if (url.endsWith(`/networks/solana/tokens/${V.mint}`)) return new Response(JSON.stringify({ data: { relationships: { top_pools: { data: [{ id: `solana_${V.pool}`, type: "pool" }] } } } }), { status: 200 });
    if (url.includes(`/networks/solana/pools/${V.pool}/trades`)) return new Response(JSON.stringify(answer), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  return { fetch, gt };
}

/** Our RPC: the recorded answers, each call counted by method; `pool` replaces the pool account's data. */
function chain(pool: Buffer = poolData) {
  const calls: string[] = [];
  const net = { up: true };
  /** Transactions the provider does not serve yet (null), each once. */
  const lag = new Set<string>();
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>?] };
    calls.push(method);
    if (!net.up) return new Response("{}", { status: 503 });
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    if (method === "getAccountInfo" && params[0] === V.pool) return ok({ context: { slot: 1 }, value: { ...C.pool.value, data: [pool.toString("base64"), "base64"] } });
    if (method === "getAccountInfo" && params[0] === QUOTE) return ok(C.quoteMint);
    if (method === "getSignaturesForAddress" && params[0] === V.pool) {
      // the recorded signatures newer than the vendor's newest row; none newer than the chain's newest
      const until = params[1]?.until;
      const at = C.sigs.findIndex((s) => s.signature === until);
      return ok(until === V.trades[SEEDED]!.tx_hash ? C.sigs : at >= 0 ? C.sigs.slice(0, at) : C.sigs);
    }
    if (method === "getTransaction") return ok(lag.delete(params[0]) ? null : (C.txs[params[0]] ?? null));
    return new Response("{}", { status: 404 });
  };
  return { fetch, calls, net, lag };
}

const down = { handle: async () => ({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' }) };
/** The event loop's turn between two page reads: a round behind the held rows lands in it. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};

function harness(pool?: Buffer) {
  const v = vendor();
  const c = chain(pool);
  const clock = { t: Date.parse("2026-11-14T17:22:20Z") };
  const token = createSolanaToken(down as never, down as never, { now: () => clock.t, fetch: v.fetch as never, sleep: async () => undefined });
  const trades = createSolanaTrades({ now: () => clock.t, listed: async () => false, rpcs: ["https://rpc.test"], fetch: c.fetch as never, source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape: (m) => token.tape(m), quoteUsd: async () => QUOTE_USD });
  const read = async () => {
    const a = await trades.trades(V.mint, 50);
    return { a, j: JSON.parse(a.body) as Tape, age: ageOf(a.timing) };
  };
  return { v, c, clock, trades, read };
}

test("the pool's vaults show each vendor row's trade: its side, its trader, its block, and a buy's amounts to the base unit", () => {
  for (const s of C.sigs) {
    const leg = poolLeg(C.txs[s.signature], V.mint, poolData);
    const row = V.trades.find((t) => t.tx_hash === s.signature)!;
    assert.ok(leg !== null, s.signature);
    assert.deepEqual([leg.side, leg.trader, leg.ts * 1_000, leg.quoteMint], [row.kind === "buy" ? "b" : "s", row.tx_from_address, Date.parse(row.block_timestamp), QUOTE]);
  }
  // C4c5gcJq, a buy: the pool gave 71,415.746499 NEARKAT and took 16.270808697 of the quote, the vendor's legs exactly
  const buy = poolLeg(C.txs[C.sigs[1]!.signature], V.mint, poolData)!;
  assert.deepEqual([buy.amt, buy.decimals, buy.quote, buy.quoteDecimals], [71415746499n, 6, 16270808697n, 9]);
  // a sell's NEARKAT is what reached the pool's vault, net of the coin's transfer fee (the vendor names what was sent)
  const sell = poolLeg(C.txs[C.sigs[2]!.signature], V.mint, poolData)!;
  assert.deepEqual([sell.amt, sell.quote], [11145799402n, 2474433824n]);
});

test("no trade is read from what is not one: no vault named by the pool, a failed transaction, both vaults moving one way, hostile amounts", () => {
  const tx = C.txs[C.sigs[1]!.signature] as { meta: Record<string, unknown> };
  const clone = () => JSON.parse(JSON.stringify(tx)) as { meta: { err: unknown; postTokenBalances: { uiTokenAmount: { amount: string } }[]; preTokenBalances: { accountIndex: number; uiTokenAmount: { amount: string } }[] } };
  assert.equal(poolLeg(tx, V.mint, new Uint8Array(637)), null, "a pool whose data names no vault");
  const failed = clone();
  failed.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(poolLeg(failed, V.mint, poolData), null);
  // both vaults rise: a deposit, no trade
  const deposit = clone();
  for (const b of deposit.meta.preTokenBalances) b.uiTokenAmount.amount = "0";
  assert.equal(poolLeg(deposit, V.mint, poolData), null);
  for (const bad of ["-1", "1e9", "1".repeat(31), ""]) {
    const h = clone();
    for (const b of h.meta.postTokenBalances) b.uiTokenAmount.amount = bad;
    assert.equal(poolLeg(h, V.mint, poolData), null, bad);
  }
  assert.equal(poolLeg(null, V.mint, poolData), null);
  assert.equal(poolLeg({ meta: { err: null } }, V.mint, poolData), null);
});

test("with the vendor refusing every call after its first answer, a held tape is renewed from our reads of its pool: every answer's rows read within SOL_VENDOR_REACH_MS, a page's 2 s reads and a page opening it 17 s after the last", async () => {
  const h = harness();
  try {
    const first = await h.read();
    assert.deepEqual([first.a.status, first.j.src, first.j.trades.length, first.age], [200, "geckoterminal", V.trades.length - SEEDED, 0]);
    // from here the vendor refuses every call
    h.v.gt.up = false;
    const vendorCalls = h.v.gt.calls;
    const ages: number[] = [];
    const srcs = new Set<string>();
    let last = first;
    for (let held = 0; held < 45_000; held += 2_000) {
      h.clock.t += 2_000;
      last = await h.read();
      assert.equal(last.a.status, 200);
      ages.push(last.age);
      srcs.add(last.j.src);
      await settle();
    }
    assert.ok(Math.max(...ages) <= SOL_VENDOR_REACH_MS, `rows read at most ${Math.max(...ages)} ms before (at most ${SOL_VENDOR_REACH_MS}): ${ages.join(",")}`);
    assert.ok(Math.max(...ages) < FOLLOW_MS + 2_000 + 1, `renewed every FOLLOW_MS and a page's read: ${ages.join(",")}`);
    assert.equal(h.v.gt.calls, vendorCalls, "no vendor call while our reads renew the tape");
    assert.deepEqual([...srcs].at(-1), "chain,geckoterminal");
    // the three trades after the vendor's rows are on top, newest first, then the vendor's, each once
    const txs = last.j.trades.map((r) => r.tx);
    assert.deepEqual(txs, V.trades.map((t) => t.tx_hash));
    const buy = last.j.trades[1]!;
    const row = V.trades[1]!;
    assert.deepEqual([buy.side, buy.amt, buy.trader, buy.t_ms], ["b", row.legs.from[1], row.tx_from_address, Date.parse(row.block_timestamp)]);
    assert.ok(Math.abs(Number(buy.usd) / Number(row.volume_in_usd) - 1) < 0.001, `${buy.usd} against the vendor's ${row.volume_in_usd}`);
    // every trade after the oldest row is held: claimed while the rows are within the reach
    assert.equal(last.j.whole_ms, Date.parse(V.trades.at(-1)!.block_timestamp) + 1_000);

    // a page opening the coin GAP_MS after the last reader: it waits for the round, never served rows past the reach
    for (let i = 0; i < 3; i++) {
      h.clock.t += 17_000;
      const gap = await h.read();
      assert.equal(gap.a.status, 200);
      assert.ok(gap.age <= SOL_VENDOR_REACH_MS, `gap read ${i}: rows read ${gap.age} ms before`);
    }
    assert.equal(h.v.gt.calls, vendorCalls, "no vendor call after a gap either");

    // the calls: the pool account and the quote's mint once, then one signature list a round and one transaction a trade
    const count = (m: string) => h.c.calls.filter((x) => x === m).length;
    assert.deepEqual([count("getAccountInfo"), count("getTransaction")], [2, C.sigs.length]);
    const rounds = count("getSignaturesForAddress");
    assert.ok(rounds >= 45_000 / (FOLLOW_MS + 2_000) && rounds <= 45_000 / FOLLOW_MS + 3, `${rounds} rounds`);
    console.log(`rounds ${rounds}, calls ${h.c.calls.length}: ${["getAccountInfo", "getSignaturesForAddress", "getTransaction"].map((m) => `${m} ${count(m)}`).join(", ")}`);
  } finally {
    h.trades.stop();
  }
});

test("a pool our reads cannot place stays the vendor's: its tape refreshed from the vendor as before, its age named, no whole list claimed past the reach", async () => {
  // the pool's account names no vault: no transaction shows a trade we can read
  const h = harness(Buffer.alloc(poolData.length));
  try {
    const first = await h.read();
    assert.equal(first.j.src, "geckoterminal");
    for (let i = 0; i < 4; i++) {
      h.clock.t += FOLLOW_MS;
      await h.read();
      await settle();
    }
    const calls = h.c.calls.length;
    h.v.gt.up = false;
    h.clock.t += SOL_VENDOR_REACH_MS + 1;
    const late = await h.read();
    await settle();
    assert.equal(h.c.calls.length, calls, "no further round of a pool we cannot place");
    assert.deepEqual([late.a.status, late.j.src, late.j.trades.length, late.j.whole_ms], [200, "geckoterminal", V.trades.length - SEEDED, undefined]);
    assert.ok(late.age > SOL_VENDOR_REACH_MS);
  } finally {
    h.trades.stop();
  }
});

test("a round that fails (our RPC down) refreshes from the vendor, its rows served when newer, and our reads renew it once they answer again", async () => {
  const h = harness();
  try {
    await h.read();
    h.c.net.up = false;
    const vendorCalls = h.v.gt.calls;
    h.clock.t += SOL_VENDOR_REACH_MS + 1;
    const a = await h.read();
    assert.ok(h.v.gt.calls > vendorCalls, "the vendor is asked when our reads fail");
    assert.deepEqual([a.a.status, a.j.src, a.age], [200, "geckoterminal", 0], "the vendor's newer rows");
    // our RPC back: the next round renews from it
    h.c.net.up = true;
    h.clock.t += FOLLOW_MS;
    await h.read();
    await settle();
    const b = await h.read();
    assert.deepEqual([b.j.src, b.j.trades.length, b.j.trades[0]!.tx], ["chain,geckoterminal", Math.min(TRADES_MAX, V.trades.length), V.trades[0]!.tx_hash]);
  } finally {
    h.trades.stop();
  }
});

test("a transaction the provider does not serve yet: the round holds the trades below it, dated by its block, and the next round reads it", async () => {
  const h = harness();
  try {
    const seeded = (await h.read()).j.as_of_ms;
    h.v.gt.up = false;
    // the newest of the three, My1mjXoq, answers null once
    h.c.lag.add(C.sigs[0]!.signature);
    h.clock.t += FOLLOW_MS;
    await h.read();
    await settle();
    const a = await h.read();
    assert.deepEqual(a.j.trades.slice(0, 2).map((r) => r.tx), [C.sigs[1]!.signature, C.sigs[2]!.signature], "the two below it, on top of the vendor's");
    assert.ok(!a.j.trades.some((r) => r.tx === C.sigs[0]!.signature));
    // complete only up to the unread one's block (17:22:05Z), here before the vendor's read (17:22:20Z), which stands
    assert.ok((C.txs[C.sigs[0]!.signature] as { blockTime: number }).blockTime * 1_000 < seeded);
    assert.equal(a.j.as_of_ms, seeded, "never dated past the unread transaction");
    h.clock.t += FOLLOW_MS;
    await h.read();
    await settle();
    const b = await h.read();
    assert.deepEqual(b.j.trades.map((r) => r.tx), V.trades.map((t) => t.tx_hash), "read on the next round, each trade once");
    assert.equal(h.c.calls.filter((m) => m === "getTransaction").length, C.sigs.length + 1);
  } finally {
    h.trades.stop();
  }
});
