// node --test apps/helper/src/data/solana/trades-cold-paced.test.ts: card helper-fresh-tapes-whole-from-the-first-minute.
// helper-25's live run 45032297159 (ee5c7dac4, 22 Nov 14:39:3xZ) read two listed Solana tapes (DMrHhifZ...AEfZL and
// HhgVYyNA...NqyFh) "still filling 45944 ms after its first read (21 reads)": each a coin whose trades no venue here
// decodes, served the vendor's rows, filling while its own walk stays cold (trades: reading). The helper's saved log
// names what the walks read on: the trades key answered spent at boot ("solana trades fallback (credits)", as on every
// helper since 10:57Z), so the walks drew the remaining providers' background budget, a borrowed key's share of a second
// and the public endpoint's, held 10 s at a time in the minutes the check ran ("rpc hold solana-public background 10 s",
// 104 in the log). A cold walk reads its newest COLD_SIGS transactions TX_PARALLEL at once, and one read our own budget
// kept from every provider failed the whole walk, which began again from its first page after 1, 2, 4, 8, 16, then 30 s.
// A fresh helper opens every tape cold; a warm one's are live and walk only what the stream misses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { COLD_SIGS, COLD_WAIT_MS, createSolanaTrades, PYTH_RECEIVER, PYTH_SOL_USD } from "./trades.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: { slot: number; meta: { logMessages: string[] } } }> };
const BUY = F.txs["pump-buy"]!;
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const TS = 1793739241;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** The live checks' bound (scripts/live-checks/tape-read.mjs FILLED_MS). */
const FILLED_MS = 45_000;
/** The background reads our budget lets go a second, every provider together. */
const PER_S = 3;

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

test(`a cold walk of ${COLD_SIGS} transactions on a background budget of ${PER_S} reads a second: a read the budget holds waits its turn, never failing the walk, and the tape is no longer filling inside 45 s (red at ee5c7dac4: still filling)`, async () => {
  const start = TS * 1000;
  const sigs = Array.from({ length: COLD_SIGS }, (_, i) => ({ signature: `${BUY.signature.slice(0, 80)}${String(i).padStart(8, "1")}`, slot: BUY.result.slot - i, err: null, blockTime: TS - i }));
  const { value } = await onVirtualTime(start, async () => {
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    let sent = 0;
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      sent++;
      const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      const acct = (owner: string, data: Buffer) => ok({ context: { slot: BUY.result.slot }, value: { owner, data: [data.toString("base64"), "base64"] } });
      if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, Math.floor(Date.now() / 1000)));
      if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct(TOKEN_PROGRAM, mintData);
      // the mint's COLD_SIGS signatures and one more page with none: the list ran out
      if (req.method === "getSignaturesForAddress") return ok(req.params[1]?.before === undefined ? sigs : []);
      if (req.method === "getTransaction") {
        const s = sigs.find((x) => x.signature === req.params[0]);
        return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime, transaction: { signatures: [s.signature] } });
      }
      throw new Error(`unexpected ${req.method}`);
    };
    // the reads let go in the last second, every provider together (rpc.ts background draws one budget a chain)
    const drawn: number[] = [];
    const budget = (): number => {
      const t = Date.now();
      while (drawn.length > 0 && t - drawn[0]! >= 1_000) drawn.shift();
      if (drawn.length >= PER_S) return 1;
      drawn.push(t);
      return 0;
    };
    const t = createSolanaTrades({
      fetch: fetch as never,
      now: () => Date.now(),
      listed: async (m) => m === MINT,
      rpcs: ["https://keyed.test", "https://public.test"],
      budget,
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      tickMs: 0,
    });
    // the page's reads, 3 s apart (as the live check reads), until the tape is no longer filling; at FILLED_MS of the
    // virtual clock the latest answer is the verdict (no clock read: no-wall-clock-asserts)
    const reads: { filling: boolean; n: number }[] = [];
    let over = false;
    const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));
    const by = sleep(FILLED_MS).then(() => ((over = true), reads.at(-1)));
    const poll = (async () => {
      while (!over) {
        const a = JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[]; filling?: boolean };
        reads.push({ filling: a.filling === true, n: a.trades.length });
        if (a.filling !== true) return;
        await sleep(3_000);
      }
    })();
    const latest = await by;
    await poll;
    t.stop();
    return { latest, reads, sent };
  });
  const line = `${value.reads.map((r) => `${r.filling ? "filling" : "done"} n${r.n}`).join(", ")}; ${value.sent} sent`;
  console.log(line);
  assert.equal(value.latest?.filling, false, `still filling at ${FILLED_MS} ms: ${line}`);
});

// card helper-fresh-tapes-whole-from-the-first-minute: helper-26's live run 45050809291 (136b51565, 22 Nov 17:42Z),
// solana-tape-rows-at-first-answer: v4GK8f24...pump's first answer "listed 0, account unread" at 3191 ms, 7R4MP6VX...pump's
// "answer by bound after 0 rounds" at 2536 ms, both 0 rows, while the public endpoint's background budget was held (169
// holds in the helper's log, the trades key spent at boot). The reads a first answer waits on drew the helper's
// background share; they are the opening page's, drawn on its own share, as a pool round a page waits on is.
test("the background share held, a page's first read of a cold coin draws its own share for the reads its answer waits on and answers the coin's trades at once (red at c5992a9be: account unread, 0 rows)", async () => {
  const start = TS * 1000;
  const sigs = Array.from({ length: COLD_SIGS }, (_, i) => ({ signature: `${BUY.signature.slice(0, 80)}${String(i).padStart(8, "1")}`, slot: BUY.result.slot - i, err: null, blockTime: TS - i }));
  const { value } = await onVirtualTime(start, async () => {
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    const drew: (string | undefined)[] = [];
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      const acct = (owner: string, data: Buffer) => ok({ context: { slot: BUY.result.slot }, value: { owner, data: [data.toString("base64"), "base64"] } });
      if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, Math.floor(Date.now() / 1000)));
      if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct(TOKEN_PROGRAM, mintData);
      if (req.method === "getSignaturesForAddress") return ok(req.params[1]?.before === undefined ? sigs : []);
      if (req.method === "getTransaction") {
        const s = sigs.find((x) => x.signature === req.params[0]);
        return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime, transaction: { signatures: [s.signature] } });
      }
      throw new Error(`unexpected ${req.method}`);
    };
    const t = createSolanaTrades({
      fetch: fetch as never,
      now: () => Date.now(),
      listed: async (m) => m === MINT,
      rpcs: ["https://keyed.test", "https://public.test"],
      // the helper's background share held for good; a page's own share open
      budget: (_u, _m, client) => (drew.push(client), client === undefined ? 10 : 0),
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      tickMs: 0,
    });
    const a = await t.trades(MINT, 50, "page");
    t.stop();
    return { status: a.status, body: a.status === 200 ? (JSON.parse(a.body) as { trades: unknown[]; src?: string }) : null, timing: a.timing, drew };
  });
  const line = `${value.status} ${value.body?.trades.length ?? "-"} rows src ${value.body?.src} ${value.timing ?? ""}`;
  console.log(line);
  assert.equal(value.status, 200, line);
  assert.ok((value.body?.trades.length ?? 0) > 0, `the first answer holds the coin's trades: ${line}`);
  assert.ok(value.drew.includes("page"), `the reads it waited on drew the page's share: ${line}`);
});

// card sol-first-read-rides-a-providers-hold: helper 70328a60c's live run 45591016872 (25 Nov 10:03Z),
// solana-tape-rows-at-first-answer: two flooded pump.fun coins' first tapes were CoinGecko's rows, their first reads
// "listed 0, account unread 0", while publicnode held every Solana caller a second (the box's log at 10:03:24.96Z, "rpc
// hold solana publicnode.com market 1 s", 30 times) and the trades key was spent. The mint account's read found every
// provider held and failed at once, inside a first answer whose bound is COLD_WAIT_MS.

/** A coin's first read (the page's, or its chart's: `read`) on `budget`, its fetch answering the mint, the price, the
 *  coin's COLD_SIGS pump.fun buys and their transactions, on virtual time from TS. */
async function firstRead(budget: (url: string, method: string, client?: string) => number, read: (t: ReturnType<typeof createSolanaTrades>) => Promise<{ status: number; body: string; timing?: string }>) {
  const start = TS * 1000;
  const sigs = Array.from({ length: COLD_SIGS }, (_, i) => ({ signature: `${BUY.signature.slice(0, 80)}${String(i).padStart(8, "1")}`, slot: BUY.result.slot - i, err: null, blockTime: TS - i }));
  const { value } = await onVirtualTime(start, async () => {
    const mintData = Buffer.alloc(82);
    mintData[44] = 6;
    mintData[45] = 1;
    const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
      const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
      const acct = (owner: string, data: Buffer) => ok({ context: { slot: BUY.result.slot }, value: { owner, data: [data.toString("base64"), "base64"] } });
      if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, Math.floor(Date.now() / 1000)));
      if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct(TOKEN_PROGRAM, mintData);
      if (req.method === "getSignaturesForAddress") return ok(req.params[1]?.before === undefined ? sigs : []);
      if (req.method === "getTransaction") {
        const s = sigs.find((x) => x.signature === req.params[0]);
        return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime, transaction: { signatures: [s.signature] } });
      }
      throw new Error(`unexpected ${req.method}`);
    };
    const t = createSolanaTrades({
      fetch: fetch as never,
      now: () => Date.now(),
      listed: async (m) => m === MINT,
      rpcs: ["https://keyed.test", "https://public.test"],
      budget,
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      tickMs: 0,
    });
    const a = await read(t);
    t.stop();
    return a;
  });
  return value;
}

test("card sol-first-read-rides-a-providers-hold: every Solana provider held a second (a provider's 429 hold, every caller) as a coin's first read begins: its mint and price reads wait the hold inside COLD_WAIT_MS and the first answer holds the coin's own trades (red at 70328a60c: 'account unread 0')", async () => {
  const until = TS * 1000 + 1_000;
  const a = await firstRead(() => (Date.now() < until ? 1 : 0), (t) => t.trades(MINT, 50, "page"));
  const body = a.status === 200 ? (JSON.parse(a.body) as { trades: unknown[]; src?: string }) : null;
  const line = `${a.status} ${body?.trades.length ?? "-"} rows src ${body?.src} ${a.timing ?? ""}`;
  console.log(line);
  assert.equal(a.status, 200, line);
  assert.ok((body?.trades.length ?? 0) > 0, `the first answer holds the coin's trades: ${line}`);
  assert.doesNotMatch(a.timing ?? "", /account unread/, line);
});

test("card sol-first-read-rides-a-providers-hold: a second hold as the SOL price is read, after the mint's: the price read waits it inside COLD_WAIT_MS too", async () => {
  // the first second held; then the mint's read goes; then every provider is held half a second as the price is asked
  let h = TS * 1000 + 1_000;
  let phase = 0;
  const budget = (): number => {
    const t = Date.now();
    if (t < h) return (h - t) / 1_000;
    if (phase === 0) return (phase = 1), 0;
    if (phase === 1) return (phase = 2), (h = t + 500), 0.5;
    return 0;
  };
  const a = await firstRead(budget, (t) => t.trades(MINT, 50, "page"));
  console.log(`${a.status} ${a.timing ?? ""}`);
  assert.equal(phase, 2, "the price read was held");
  assert.match(a.timing ?? "", /account \d+, price \d+/, `the mint and the price read: ${a.timing}`);
  assert.ok(((JSON.parse(a.body) as { trades?: unknown[] }).trades?.length ?? 0) > 0, `the first answer holds the coin's trades: ${a.timing}`);
});

test(`card sol-first-read-rides-a-providers-hold: a hold that ends past the first answer's bound (COLD_WAIT_MS, ${COLD_WAIT_MS} ms) is not waited: the read fails at once, as before, and the next caller's read is not held behind it`, async () => {
  const a = await firstRead(() => 5, (t) => t.trades(MINT, 50, "page"));
  console.log(`${a.status} ${a.timing ?? ""}`);
  assert.match(a.timing ?? "", /listed 0, account unread 0/, `failed at its first read, 0 ms in: ${a.timing}`);
});

test("card sol-first-read-rides-a-providers-hold: a coin whose chart is opened first draws the page's share for its first read, as its tape does (red at 70328a60c: candles opened the tape on the background share, held, 'account unread')", async () => {
  const drew: (string | undefined)[] = [];
  // the helper's background share held for good; a page's own share open (the first test's above)
  const a = await firstRead((_u, _m, client) => (drew.push(client), client === undefined ? 10 : 0), (t) => t.candles(MINT, "1m", null, 50, "page"));
  console.log(`${a.status} ${a.timing ?? ""} drew ${[...new Set(drew)].join(", ")}`);
  assert.ok(drew.includes("page"), `the chart's first read drew the page's share: ${[...new Set(drew)].join(", ")}`);
  assert.equal(a.status, 200, `${a.status} ${a.body.slice(0, 200)}`);
});
