// Card closed-positions-after-a-restore: a device restored from the 12 words gets back every past round trip of the
// account, so Portfolio's closed positions, its calendar and How you trade read what the device that traded reads.
// The account's three Ws trade as the owner's did on 12 Nov (fixtures/trade-fill: getTransaction "json" at finalized on
// a public RPC; the Ws' addresses swapped for this test seed's): W0 bought 5Qn5Lt and sold it whole in 32CSJ1, W1
// bought 3sPawp and sold it whole in 3aUiLL, W2 bought 4HSwog (open), then sold it whole in 5o9u2h. Each sale's and
// each buy's USD comes from the SOL/USD feed write before its block (feed-before-*.json, feed-*.json).
//   node --test test/restore-trades.test.ts
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { base58 } from "@scure/base";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore } from "@blindfill/wallet/store";
import { noteCommitment, noteSecrets } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { solanaPoolOf } from "../../wallet/src/pool/solana.ts";
import { freshWallet } from "../../wallet/src/derive/keys.ts";
import { jOf } from "../../wallet/src/pool/queue.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { POOL_USD_FEEDS } from "../../kit/src/price/pool-usd.ts";
import type { Operation } from "../../kit/src/signpage/messages.ts";
import { testnetPool } from "../src/pool-testnet.ts";
import { opOf } from "../src/state.ts";
import * as records from "../src/sol-buy-records.ts";
import { closedRows, stats, tradeBook, type PortfolioData } from "../../../apps/terminal/src/screens/portfolio/model.ts";

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const PIN = { program: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", feePayer: "CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU" };
const SCOPE = solanaPoolOf(PIN.program).scope;
const FEED = POOL_USD_FEEDS.solana.account;
const DIR = new URL("./fixtures/trade-fill/", import.meta.url);
const raw = (f: string): string => readFileSync(new URL(`${f}.json`, DIR), "utf8");
const MINT = "78GaXFTJzkCWpdxkNHMSP3TXEKbhQTpb3EqMt7Uupump";
// read by name, so a build without the mark fails on what it shows, not on the import
const TRADES_READ_KEY = (records as { TRADES_READ_KEY?: string }).TRADES_READ_KEY ?? "owed/trades-sol-read";
const realFetch = globalThis.fetch;
after(() => void (globalThis.fetch = realFetch));

test("a device restored from the words reads back every round trip: two closed and one open, then the open one closed, each at the figures of its own transactions", { timeout: 600_000 }, () => onTestClock(async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  after(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  const Ws: string[] = [];
  for (let i = 0; i < 3; i++) {
    const ref = { kind: "deposit" as const, s: SCOPE, i };
    const pre = noteSecrets(SEED64, ref).precommitment;
    const label = BigInt(311 + i);
    const r = await ns.add({ ref, scope: SCOPE, precommitment: pre, state: "UNSPENT", leaf: { value: 10_000_000n, label, commitment: noteCommitment(10_000_000n, label, pre), leafIndex: BigInt(i) } });
    await ns.move(r.id, "UNSPENT", "SPENT");
    const fw = freshWallet(SEED64, "sol", label, jOf(ref));
    fw.secretKey.fill(0);
    Ws.push(fw.address);
  }
  ns.close();
  // the owner's Ws, as the fixtures name them, swapped for this seed's
  const swap: [string, string][] = [["TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX", Ws[0]!], ["8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p", Ws[1]!], ["5Emfj9RxtcjtvDDe6CP1a2RWiG6tfURaEevb7L2m25E8", Ws[2]!]];
  const tx = (f: string): { sig: string; tx: { blockTime: number } } => {
    let s = raw(f);
    for (const [a, b] of swap) s = s.split(a).join(b);
    const t = JSON.parse(s) as { blockTime: number; transaction: { signatures: string[] } };
    return { sig: t.transaction.signatures[0]!, tx: t };
  };
  const [buy0, sell0, buy1, sell1, buy2, sell2] = ["5Qn5Lt", "32CSJ1", "3sPawp", "3aUiLL", "4HSwog", "5o9u2h"].map(tx) as [ReturnType<typeof tx>, ...ReturnType<typeof tx>[]];
  const txs = new Map([buy0, sell0!, buy1!, sell1!, buy2!, sell2!].map((x) => [x.sig, x.tx] as const));
  // each W's history, newest first; W2's sale comes later
  const history = new Map<string, { sig: string }[]>([[Ws[0]!, [sell0!, buy0]], [Ws[1]!, [sell1!, buy1!]], [Ws[2]!, [buy2!]]]);
  const feedBefore = new Map([[sell0!.sig, "32CSJ1"], [sell1!.sig, "3aUiLL"], [buy0.sig, "5Qn5Lt"], [buy1!.sig, "3sPawp"], [buy2!.sig, "4HSwog"], [sell2!.sig, "5o9u2h"]]);
  let gets = 0;
  // each W's history reads, by W, with the list's `until`
  const lists: { w: string; until?: string }[] = [];
  // a route that answers a signature with a transaction not its own (review of 776d40528, P3-2)
  let lie: string | null = null;
  let lied = 0;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    const p0 = b.params[0] as string;
    if (b.method === "getSignaturesForAddress") {
      if (p0 === FEED) return ok(JSON.parse(raw(`feed-before-${feedBefore.get((b.params[1] as { before: string }).before)}`)));
      const until = (b.params[1] as { until?: string }).until;
      lists.push({ w: p0, ...(until === undefined ? {} : { until }) });
      const all = history.get(p0) ?? [];
      const to = until === undefined ? -1 : all.findIndex(({ sig }) => sig === until);
      return ok((to < 0 ? all : all.slice(0, to)).map(({ sig }) => ({ signature: sig, err: null, slot: 5, blockTime: txs.get(sig)!.blockTime })));
    }
    if (b.method === "getTransaction") {
      gets++;
      if (p0 === lie) return (lied++, ok({ ...txs.get(p0), transaction: { ...(txs.get(p0) as unknown as { transaction: object }).transaction, signatures: [buy0.sig] } }));
      if (txs.has(p0)) return ok(txs.get(p0));
      // the feed's writes recorded; its other transactions are version 1, which a "json" read at version 0 refuses
      if (existsSync(new URL(`feed-${p0.slice(0, 6)}.json`, DIR))) return ok(JSON.parse(raw(`feed-${p0.slice(0, 6)}`)));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, error: { code: -32015, message: "Transaction version (1) is not supported" } }), { status: 200 });
    }
    if (b.method === "getTokenAccountsByOwner") return ok({ context: { slot: 100 }, value: [] });
    if (b.method === "getBalance") return ok({ context: { slot: 100 }, value: 0 });
    return ok(null);
  }) as typeof fetch;
  const make = () => testnetPool({ store: async () => w, held: async () => w, seed64: async () => SEED64.slice() }, { pin: PIN, positions: { setTimer: () => 0, clearTimer: () => {} } } as never);
  const ops = async (): Promise<Operation[]> => (await Promise.all((await w.keys("ops")).map(async (k) => opOf(k, await w.get("ops", k))))).filter((o): o is Operation => o !== null);
  const filled = async (n: number) => {
    for (let i = 0; i < 2_400; i++) {
      const o = await ops();
      if (o.length === n && o.every((x) => (x as { pool_amount?: string }).pool_amount !== undefined && (x as { amount_usd?: string }).amount_usd !== undefined)) return o;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`not ${n} filled ops: ${JSON.stringify(await ops())}`);
  };
  const book = (o: Operation[]) => tradeBook(o, []);
  const rowsOf = (o: Operation[]) => closedRows({ closed: book(o).closed, market: () => null } as unknown as PortfolioData);

  // this device's own op of W0's sale (as the device that sold wrote it): the restore writes none beside it
  await w.update("ops", "own-sale", () => ({ kind: "sell", stage: "filled", txs: [{ chain: "solana", hash: sell0!.sig }], created_ms: sell0!.tx.blockTime * 1000, chain: "solana", token: MINT, pool: "sol", legs: [{ wallet: Ws[0] }] }));

  // 1. the load after the restore: three buys and two sales come back as ops
  let tp = make();
  await tp.positions();
  await tp.settle();
  const one = await filled(5);
  const b1 = book(one);
  assert.equal(b1.closed.length, 2, "both closed round trips");
  assert.deepEqual(b1.closed.map((c) => [c.token, c.bought_asset, c.sold_asset]), [[MINT, "0.001205887", "0.000574635"], [MINT, "0.001204552", "0.001174666"]], "each round trip's SOL in and out, from its own transactions");
  assert.deepEqual(b1.closed.map((c) => [c.opened_at, c.closed_at]), [[buy0.tx.blockTime * 1000, sell0!.tx.blockTime * 1000], [buy1!.tx.blockTime * 1000, sell1!.tx.blockTime * 1000]], "each at its own block's time");
  for (const c of b1.closed) assert.ok(c.bought !== null && c.sold !== null, "a USD figure on both sides");
  assert.equal(b1.open.size, 1, "the open buy");
  assert.equal(stats(rowsOf(one)).trades, 2, "How you trade: two closed trades");
  assert.ok(!(await w.keys("ops")).includes(`restored/${sell0!.sig}`), "the device's own op of a sale wins: none written beside it");
  const marks = () => w.get("meta", TRADES_READ_KEY) as Promise<Record<string, unknown>>;
  assert.deepEqual(Object.entries(await marks()).filter(([, v]) => v === true).map(([a]) => a).sort(), [Ws[0], Ws[1]].sort(), "only the sold-out Ws are read for good");
  assert.deepEqual((await marks())[Ws[2]!], { after: buy2!.sig, mint: "4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump", program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, "the open W: read on from its buy");

  // 2a. W2 sells, but the route answers the sale's signature with another transaction: not taken, so not lost
  history.set(Ws[2]!, [sell2!, buy2!]);
  lie = sell2!.sig;
  lists.length = 0;
  tp = make();
  await tp.positions();
  await tp.settle();
  // until the run has read W2's sale (the answer not its own) and written what it does after it
  for (let i = 0; i < 2_400 && lied === 0; i++) await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lists, [{ w: Ws[2]!, until: buy2!.sig }], "only the open W is read, on from its buy");
  assert.notEqual((await marks())[Ws[2]!], true, "no mark for good on a sale whose answer was not its own");
  assert.ok(!(await w.keys("ops")).includes(`restored/${sell2!.sig}`));
  lie = null;

  // 2b. the next load reads W2 on again, and its round trip closes; nothing is written twice
  const before = gets;
  tp = make();
  await tp.positions();
  await tp.settle();
  const two = await filled(6);
  const b2 = book(two);
  assert.equal(b2.closed.length, 3, "all three round trips closed");
  assert.equal(b2.open.size, 0);
  assert.equal(stats(rowsOf(two)).trades, 3);
  assert.ok(gets > before, "W2 read again");
  assert.deepEqual(Object.entries(await marks()).filter(([, v]) => v === true).map(([a]) => a).sort(), [...Ws].sort());

  // 3. every W read for good: a later load reads none of them
  lists.length = 0;
  tp = make();
  await tp.positions();
  await tp.settle();
  await new Promise((r) => setTimeout(r, 2_000));
  assert.deepEqual(lists, [], "no W's history read again");
}));

test("a restored trade op only from the signature's own transaction, with its block time; a sale only when the wallet sold the mint", async () => {
  const { restoredTradeOps } = records as unknown as { restoredTradeOps: (w: string, b: unknown) => { key: string; rec: { kind: string } }[] };
  const buy = JSON.parse(raw("5Qn5Lt")) as { transaction: { signatures: string[] }; blockTime: number };
  const sale = JSON.parse(raw("32CSJ1")) as { transaction: { signatures: string[] }; blockTime: number };
  const W = "TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX";
  const [bs, ss] = [buy.transaction.signatures[0]!, sale.transaction.signatures[0]!];
  assert.deepEqual(restoredTradeOps(W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: sale }] }).map((o) => [o.key, o.rec.kind]), [[`restored/${bs}`, "buy"], [`restored/${ss}`, "sell"]]);
  // the route answered another transaction for the sale's signature, or one with no block time: no op for it
  assert.deepEqual(restoredTradeOps(W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: buy }] }).length, 1);
  assert.deepEqual(restoredTradeOps(W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: { ...buy, blockTime: null } }] }), []);
  // another wallet's sale of the mint is no sale of W's
  assert.deepEqual(restoredTradeOps("8e8RsnpnL6Toqsa2Q1YPLvopDqPa3HFTdwEikCkqpQ7p", { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: sale }] }).map((o) => o.rec.kind), ["buy"]);
});

// Review of 776d40528 (P3-1, P3-2, P2-1 and the tests it found missing): W's sale is W's own; the mark is for good only
// when the sale in full gave its op, else a cursor the next load reads on from; a W read is read once a page load.
test("a sale W does not sign gives no op; the mark is for good only with the sale's op, else a cursor at the last answer that was its own", async () => {
  const { restoredTradeOps, writeTradeOps, tradesDone, tradesFrom } = records as unknown as Record<string, (...a: unknown[]) => unknown> & { restoredTradeOps: (w: string, b: unknown) => { rec: { kind: string } }[] };
  const buy = JSON.parse(raw("5Qn5Lt")) as { transaction: { signatures: string[]; message: { header: { numRequiredSignatures: number } } }; blockTime: number };
  const sale = JSON.parse(raw("32CSJ1")) as typeof buy;
  const W = "TcYd32AdSHY5zuqSK2a7PvkDv8FQvafyTs2uS1ztkZX";
  const [bs, ss] = [buy.transaction.signatures[0]!, sale.transaction.signatures[0]!];
  const unsigned = structuredClone(sale);
  unsigned.transaction.message.header.numRequiredSignatures = 0;
  assert.deepEqual(restoredTradeOps(W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: unsigned }] }).map((o) => o.rec.kind), ["buy"], "W does not sign it: no sale");
  // a store as the wallet store's
  const storeOf = () => {
    const m = new Map<string, unknown>();
    return {
      m,
      get: async (s: string, k: string) => m.get(`${s}/${k}`),
      keys: async (s: string) => [...m.keys()].filter((k) => k.startsWith(`${s}/`)).map((k) => k.slice(s.length + 1)),
      update: async (s: string, k: string, f: (v: unknown) => unknown) => {
        const v = f(m.get(`${s}/${k}`));
        if (v !== undefined) m.set(`${s}/${k}`, v);
      },
    };
  };
  const mark = (st: ReturnType<typeof storeOf>) => (st.m.get(`meta/${TRADES_READ_KEY}`) as Record<string, unknown>)[W];
  // the sale in full read, its answer another transaction's: its op not written, so no mark for good
  let st = storeOf();
  await writeTradeOps!(st, W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: buy }], soldOut: true });
  assert.deepEqual(mark(st), { after: bs, mint: MINT, program: "P" }, "a cursor before the answer that was not its own");
  assert.deepEqual([...((await tradesDone!(st, "owed/buy-sol")) as Set<string>)], [], "a cursor is read again");
  assert.deepEqual([...((await tradesFrom!(st)) as Map<string, unknown>)], [[W, { after: bs, mint: MINT, program: "P" }]]);
  // a signed sale in full whose figures cannot be read (a transfer with seed, tag 11): no sale op, yet W's trades end
  // there for good (review of f73ee1c82, P3-b)
  const odd = structuredClone(sale) as unknown as { meta: { innerInstructions: { instructions: { data: string; programIdIndex: number; accounts: number[] }[] }[] }; transaction: { message: { accountKeys: string[] } } };
  const oddKeys = odd.transaction.message.accountKeys;
  const tix = odd.meta.innerInstructions.flatMap((g) => g.instructions).find((i) => oddKeys[i.programIdIndex] === "11111111111111111111111111111111" && oddKeys[i.accounts[0]!] === W && base58.decode(i.data)[0] === 2)!;
  const td = base58.decode(tix.data);
  td[0] = 11;
  tix.data = base58.encode(td);
  assert.deepEqual(restoredTradeOps(W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: odd }] }).map((o) => o.rec.kind), ["buy"], "no sale op from it");
  st = storeOf();
  await writeTradeOps!(st, W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: odd }], soldOut: true });
  assert.equal(mark(st), true, "for good: never read on");
  // the sale in full with its op: for good, and a later cursor never takes it back
  st = storeOf();
  await writeTradeOps!(st, W, { mint: MINT, program: "P", txs: [{ signature: bs, tx: buy }, { signature: ss, tx: sale }], soldOut: true });
  assert.equal(mark(st), true);
  assert.deepEqual([...((await tradesDone!(st, "owed/buy-sol")) as Set<string>)], [W]);
  await writeTradeOps!(st, W, { mint: MINT, program: "P", after: ss, txs: [], soldOut: false });
  assert.equal(mark(st), true, "a mark for good stays");
  // the device's own op of the sale counts as its op: for good, and no op written beside it
  st = storeOf();
  await st.update("ops", "own", () => ({ kind: "sell", txs: [{ chain: "solana", hash: ss }] }));
  assert.equal(await writeTradeOps!(st, W, { mint: MINT, program: "P", after: bs, txs: [{ signature: ss, tx: sale }], soldOut: true }), false);
  assert.equal(mark(st), true);
  assert.deepEqual((await st.keys("ops")).sort(), ["own"]);
});

test("a W whose trades were read is read once a page load; a sign out starts afresh", async () => {
  const { solBuyRecords } = records;
  const reads: string[] = [];
  const open = { mint: MINT, program: "P", txs: [{ signature: "b", tx: {} }], soldOut: false };
  const r = solBuyRecords({
    wallets: async () => ["W1"],
    done: async () => new Set(),
    write: async () => false,
    trades: async () => false,
    reader: { read: async (w: string) => (reads.push(w), open) },
    wrote: () => {},
  });
  r.run();
  await r.idle();
  r.run();
  await r.idle();
  assert.deepEqual(reads, ["W1"], "once this load");
  r.stop();
  r.run();
  await r.idle();
  assert.deepEqual(reads, ["W1", "W1"], "again after a sign out");
});
