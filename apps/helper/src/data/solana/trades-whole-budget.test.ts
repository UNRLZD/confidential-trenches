// Card sol-meteora-tape-inside-rpc-budget: a Meteora stream transaction is read whole (its events are in its inner
// instructions only, card index-sol-trades-2) only inside the whole reads' budget, on their own providers, never the
// trades list the callers' providers lead (at c775de255 every one was read, on the main key first: a burst of busy
// Meteora coins took the Solana budget the sell routes draw). Past the budget the coin's tape names its reach and is
// served its top pool's trades, as a venue not decoded is.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as T from "./trades.ts";
import type { SourceEvents } from "./trades.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MT = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-meteora-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: Record<string, unknown> & { slot: number; meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
const TS = 1795011900;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
// dlmm-buy's token (the pool's X): its route crosses Meteora DLMM, so its log names a venue whose events are inner only
const TTW = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";
const TX = MT.txs["dlmm-buy"]!;
const MAIN = "https://main.test";
const WHOLE = "https://whole.test";
const settle = () => new Promise((r) => setTimeout(r, 20));

function pyth(price: bigint, pub: number): Buffer {
  const b = Buffer.alloc(134);
  Buffer.from("22f123639d7ef4cd", "hex").copy(b, 0);
  b[40] = 1;
  Buffer.from(FEED, "hex").copy(b, 41);
  b.writeBigInt64LE(price, 73);
  b.writeInt32LE(-8, 89);
  b.writeBigInt64LE(BigInt(pub), 93);
  return b;
}

/** A helper's Solana trades over a recorded chain: every coin in `coins` is TTW's twin (each answers as a mint), every
 *  getTransaction answers dlmm-buy whatever its signature; each request kept as "<url> <method>". */
function chain(coins: string[], opts: { tape?: (m: string) => Promise<{ status: number; body: string; src?: string; asOfMs?: number }>; sigsHeld?: () => Promise<void> | null; poolsDown?: boolean } = {}) {
  let ms = TS * 1000;
  const sent: string[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    sent.push(`${url} ${req.method}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    const acct = (owner: string, data: Buffer) => ok({ context: { slot: 100 }, value: { owner, data: [data.toString("base64"), "base64"] } });
    if (req.method === "getAccountInfo" && req.params[0] === T.PYTH_SOL_USD) return acct(T.PYTH_RECEIVER, pyth(9_342_267_796n, TS));
    if (req.method === "getAccountInfo" && coins.includes(req.params[0])) {
      const b = Buffer.alloc(82);
      b[44] = 6;
      b[45] = 1;
      return acct(TOKEN_PROGRAM, b);
    }
    const p = MT.pools[req.params[0]];
    if (req.method === "getAccountInfo" && p !== undefined) return opts.poolsDown === true ? new Response("busy", { status: 429 }) : acct(p.owner, Buffer.from(p.data, "base64"));
    if (req.method === "getAccountInfo") return ok({ context: { slot: 100 }, value: null });
    if (req.method === "getSignaturesForAddress") {
      await opts.sigsHeld?.();
      return ok([]);
    }
    if (req.method === "getTransaction") return ok(TX.result);
    throw new Error(`unexpected ${req.method}`);
  };
  let on: SourceEvents | null = null;
  const t = T.createSolanaTrades({
    fetch: fetchFn,
    now: () => ms,
    listed: async (m) => coins.includes(m),
    rpcs: [MAIN],
    wholeRpcs: [WHOLE],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    coldWait: () => settle(),
    ...(opts.tape === undefined ? {} : { tape: opts.tape }),
  } as Parameters<typeof T.createSolanaTrades>[0]);
  let n = 0;
  const stream = (m: string) => on!.note(m, { sig: `S${++n}`, slot: TX.result.slot, err: false, logs: TX.result.meta.logMessages });
  const reads = (url?: string) => sent.filter((s) => s.endsWith(" getTransaction") && (url === undefined || s.startsWith(`${url} `))).length;
  return { t, stream, reads, step: (d: number) => void (ms += d), now: () => ms };
}

test("card sol-meteora-tape-inside-rpc-budget: a burst of Meteora stream trades sends at most the budget's whole reads, on their own providers only", async () => {
  const coins = [TTW, "8HuYsEpBS2WZACBCbAKcoh8XmbNYYqRjoJrCqC3Cmoon", "467cTkm8GXBA96QDGG5Spm1WbpVHp2LnPA1VAcrMctem"];
  const c = chain(coins);
  for (const m of coins) assert.equal((await c.t.trades(m, 50)).status, 200);
  // one second: 20 trades of each of 3 coins
  for (let i = 0; i < 20; i++) for (const m of coins) c.stream(m);
  await settle();
  assert.ok(c.reads() <= T.WHOLE_PER_S, `${c.reads()} whole reads in one second, the budget ${T.WHOLE_PER_S}`);
  assert.equal(c.reads(MAIN), 0, "no whole read on the trades list's providers (the main key first)");
  // ten more seconds of the same: each second's reads at most the budget, one coin's at most its own
  for (let s = 0; s < 10; s++) {
    c.step(1_000);
    const before = c.reads();
    for (let i = 0; i < 20; i++) c.stream(TTW);
    await settle();
    assert.ok(c.reads() - before <= T.WHOLE_PER_S, `second ${s}: ${c.reads() - before} reads`);
  }
  // TTW's reads over its ten seconds: its own cap (the first second's included, inside the window)
  assert.ok(c.reads() <= T.WHOLE_PER_S + T.WHOLE_COIN_MAX, `${c.reads()} whole reads over 11 s, at most ${T.WHOLE_PER_S} + ${T.WHOLE_COIN_MAX}`);
  assert.equal(c.reads(MAIN), 0);
  c.t.stop();
});

test("card sol-meteora-tape-inside-rpc-budget: past the budget a coin's tape names its reach and is served its top pool's trades while the vendor answers", async () => {
  const vendor = { status: 200, body: JSON.stringify([{ t_ms: TS * 1000, side: "b", usd: "1", amt: "1", trader: null, tx: "V1" }]), src: "geckoterminal", asOfMs: TS * 1000 };
  let answers = true;
  const c = chain([TTW], { tape: async () => (answers ? vendor : { status: 503, body: "{}" }) });
  assert.equal((await c.t.trades(TTW, 50)).status, 200);
  for (let i = 0; i < 40; i++) c.stream(TTW);
  await settle();
  const va = await c.t.trades(TTW, 50);
  const a = JSON.parse(va.body) as { src: string; trades: { tx: string }[] };
  assert.equal(a.src, "geckoterminal", "a coin past the budget is served its top pool's trades");
  assert.deepEqual(a.trades.map((r) => r.tx), ["V1"]);
  assert.match(va.timing ?? "", /sol-whole-cut;desc="a Meteora trade unread 0 s ago"/, "the answer names why");
  // the vendor down: its own rows, whole only from the second after the newest transaction not read
  answers = false;
  c.step(31_000);
  const b = JSON.parse((await c.t.trades(TTW, 50)).body) as { src: string; whole_ms?: number; trades: unknown[] };
  assert.equal(b.src, "chain");
  assert.ok(b.trades.length > 0);
  assert.equal(b.whole_ms, (TS + 1) * 1000, "the tape's reach starts after the cut");
  // a minute past the cut with every read inside the budget: its own tape again
  answers = true;
  c.step(T.CUT_KEEP_MS);
  assert.equal((JSON.parse((await c.t.trades(TTW, 50)).body) as { src: string }).src, "chain");
  c.t.stop();
});

test("card sol-meteora-tape-inside-rpc-budget: a coin with no rows of its own whose Meteora trade went past the budget names the cut too", async () => {
  // a live read (index-sol-trades against a local helper at a54a41709, 18 Nov 18:55Z): a fresh DBC coin, every trade
  // past the budget, was served the vendor's rows with no sol-whole-cut, as a coin with no trade to decode is
  const vendor = { status: 200, body: JSON.stringify([{ t_ms: TS * 1000, side: "b", usd: "1", amt: "1", trader: null, tx: "V1" }]), src: "geckoterminal", asOfMs: TS * 1000 };
  const B = "8HuYsEpBS2WZACBCbAKcoh8XmbNYYqRjoJrCqC3Cmoon";
  const c = chain([TTW, B], { tape: async () => vendor });
  for (const m of [TTW, B]) assert.equal((await c.t.trades(m, 50)).status, 200);
  // the second's budget taken by B, then TTW's one trade: past it, TTW holds no row of its own
  for (let i = 0; i < T.WHOLE_PER_S; i++) c.stream(B);
  c.stream(TTW);
  await settle();
  const va = await c.t.trades(TTW, 50);
  assert.equal((JSON.parse(va.body) as { src: string }).src, "geckoterminal");
  assert.match(va.timing ?? "", /sol-whole-cut;desc="a Meteora trade unread 0 s ago"/, "the vendor's rows name the cut");
  c.t.stop();
});

// card helper-sol-tape-checks-hold: a coin past the budget whose vendor rows are not served is answered its own chain
// tape, which lacks the unread trade. A live tape names its reach after the cut (whole_ms, above); one whose walk still
// reads (cold) or that is behind names no reach, so before this card nothing in its answer told it from a whole chain
// tape: a local helper at 321baac8c on mainnet, 20 Nov 05:36Z, answered CARDSccU's tape src chain, cold, filling, 14
// rows, no whole_ms, no sol-whole-cut, its DLMM trade 4vEPr51yjSyE unread (the whole reads 1,023 past the budget in a
// minute), and index-sol-trades judged it ("not in its 14 rows"; the deployed helper's 19 Nov run: "not in its 8 rows").
test("card helper-sol-tape-checks-hold: past the budget, a chain tape that names no reach (its walk still reading) names the cut (red at c6f82f3bc: no sol-whole-cut)", async () => {
  let release = () => undefined as void;
  let gate: Promise<void> | null = new Promise<void>((r) => (release = r));
  const c = chain([TTW], { tape: async () => ({ status: 503, body: "{}" }), sigsHeld: () => gate });
  assert.equal((await c.t.trades(TTW, 50)).status, 200);
  for (let i = 0; i < 40; i++) c.stream(TTW);
  await settle();
  // past the vendor's wait: the vendor down, so the coin's own rows
  c.step(31_000);
  const va = await c.t.trades(TTW, 50);
  const a = JSON.parse(va.body) as { src: string; whole_ms?: number; filling?: boolean; trades: unknown[] };
  assert.equal(a.src, "chain");
  assert.ok(a.trades.length > 0);
  assert.equal(a.filling, true, "its first walk still reads");
  assert.equal(a.whole_ms, undefined, "no reach named");
  assert.match(va.timing ?? "", /sol-whole-cut;desc="a Meteora trade unread 31 s ago"/, "the cut named");
  // its walk done: live, its reach after the cut names it, as before
  gate = null;
  release();
  await settle();
  c.t.tick();
  const vb = await c.t.trades(TTW, 50);
  assert.equal((JSON.parse(vb.body) as { whole_ms?: number }).whole_ms, (TS + 1) * 1000);
  c.t.stop();
});

// card helper-sol-tape-checks-hold: a stream transaction read whole whose trade cannot be read on (its pool account
// unanswered: every provider held, as a local helper at f1a80d8bf on mainnet logged "rpc hold solana background 10 s"
// 156 times) was dropped while the tape went on naming every trade from its reach on: pumpCmXq's tape, live, whole_ms
// 1795153718000, lacked its DLMM trade 5KvXhNM11J91 at 1795153746 (index-sol-trades, 20 Nov 05:49Z). An unread stream
// transaction is a cut as one past the budget is: the tape's reach starts after it.
test("card helper-sol-tape-checks-hold: a stream transaction whose trade cannot be read on (its pool unanswered) is a cut: the tape names its reach after it, never every trade (red at c6f82f3bc: whole from the walk's)", async () => {
  const c = chain([TTW], { poolsDown: true });
  assert.equal((await c.t.trades(TTW, 50)).status, 200);
  await settle();
  c.t.tick();
  assert.equal((JSON.parse((await c.t.trades(TTW, 50)).body) as { whole_ms?: number }).whole_ms, 0, "whole from the mint's first signature before it");
  c.stream(TTW);
  await settle();
  const a = JSON.parse((await c.t.trades(TTW, 50)).body) as { whole_ms?: number; trades: unknown[] };
  assert.deepEqual(a.trades, [], "the trade not read");
  assert.equal(a.whole_ms, (TS + 1) * 1000, "the reach starts the second after the unread transaction");
  c.t.stop();
});
