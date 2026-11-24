// The Solana trade feed: the stream's trades reach the tape and the 1s candle, a dropped stream's gap is refilled from
// signatures before the tape moves again, and a recorded hour replays to a fixed answer. The transactions are recorded
// mainnet ones (fixtures/sol-trades-txs.json, fixtures/sol-trades-hour.json.gz).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { fromLogs } from "./decode.ts";
import { joinBars } from "../candles.ts";
import { BACK_SPAN_S, BACK_TX_MAX, COLD_SIGS, createSolanaTrades, FAILED_OPEN_MS, PYTH_RECEIVER, PYTH_SOL_USD, pythSolUsd, SHORT_PAGE, SYSVAR_CLOCK, TRADES_RPCS, wsSource, type Note, type SourceEvents } from "./trades.ts";
import { createRpc } from "../../rpc/rpc.ts";
import { b58decode, b58encode } from "./lists.ts";
import { turnSlicer } from "../../limits/turn.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as {
  txs: Record<string, { signature: string; result: { slot: number; meta: { logMessages: string[] } } }>;
};
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** A Pyth PriceUpdateV2 account body: full verification, the SOL/USD feed, `price` at exponent -8, published `pub`. */
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
/** An SPL mint account body with `decimals`, initialized. */
function mintData(decimals: number): Buffer {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return b;
}

type Chain = { sigs: (params: Record<string, unknown>) => unknown[]; txs: Record<string, unknown>; price: bigint; pub: number; slot: number };
const rpcFetch = (c: Chain, mints: Record<string, number>) => async (_url: string, init: RequestInit): Promise<Response> => {
  const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  const acct = (owner: string, data: Buffer) => ok({ context: { slot: c.slot }, value: { owner, data: [data.toString("base64"), "base64"] } });
  if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(c.price, c.pub));
  if (req.method === "getAccountInfo" && req.params[0] in mints) return acct(TOKEN_PROGRAM, mintData(mints[req.params[0]]!));
  if (req.method === "getSignaturesForAddress") return ok(c.sigs(req.params[1]));
  if (req.method === "getTransaction") return ok(c.txs[req.params[0]] ?? null);
  throw new Error(`unexpected ${req.method} ${String(req.params[0])}`);
};
const settle = () => new Promise((r) => setTimeout(r, 20));
/** The stream as the deployed one sends a note: its slot's clock first (the Clock sysvar, card sol-tape-in-order; every
 *  trade is dated by its block, card helper-sol-tape-checks-hold), here the clock its own event names, else none. */
/** A recorded transaction's block time, as getTransaction answers it: the recorded hour holds none, so its event's own clock
 *  stands for it (every trade is dated by its block, card helper-sol-tape-checks-hold); null with no clocked trade. */
const blockOf = (logs: unknown): number | null => fromLogs(logs).trades.find((x) => x.ts > 0)?.ts ?? null;
const withClock = (on: SourceEvents): SourceEvents => ({
  ...on,
  note(m, n) {
    const ts = fromLogs(n.logs).trades.find((x) => x.ts > 0)?.ts;
    if (ts !== undefined) on.clock(n.slot, ts);
    on.note(m, n);
  },
});
/** Card app-chart-check-inside-its-bound: `n` successful signatures older than `slot` whose transactions hold no trade,
 *  and their bodies: a first walk's page made full by them has not reached the mint's first signature (a page shorter
 *  than its limit says the list ran out, and its tape is then whole from the first signature). */
const noTrades = (n: number, slot: number, tag: string) => {
  const list = Array.from({ length: n }, (_, i) => ({ signature: `${tag}${String(i).padStart(4, "0")}${"1".repeat(80 - tag.length)}`.slice(0, 88), slot: slot - 1 - i, err: null }));
  return { list, txs: Object.fromEntries(list.map((x) => [x.signature, { slot: x.slot, meta: { logMessages: [] } }])) };
};

test("Pyth's SOL/USD account is taken only whole: owner, full verification, feed, exponent, price, fresh", () => {
  assert.equal(pythSolUsd(PYTH_RECEIVER, pyth(9_342_267_796n, 1_000), 1_010), 93_422_677_960_000_000_000n);
  assert.equal(pythSolUsd("SomeoneElse1111111111111111111111111111111", pyth(9_342_267_796n, 1_000), 1_010), null);
  assert.equal(pythSolUsd(PYTH_RECEIVER, pyth(9_342_267_796n, 1_000), 1_200), null); // published 200 s ago
  assert.equal(pythSolUsd(PYTH_RECEIVER, pyth(-1n, 1_000), 1_000), null);
  const partial = pyth(9_342_267_796n, 1_000);
  partial[40] = 0;
  assert.equal(pythSolUsd(PYTH_RECEIVER, partial, 1_000), null);
});

const BUY = F.txs["pump-buy"]!;
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const TS = 1793739241;

function setup(chain: Chain) {
  let on: SourceEvents | null = null;
  const watched: string[] = [];
  const t = createSolanaTrades({
    fetch: rpcFetch(chain, { [MINT]: 6 }),
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async (m) => void watched.push(m), unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  const note = (sig: string, slot: number): Note => ({ sig, slot, err: false, logs: BUY.result.meta.logMessages });
  return { t, on: () => withClock(on!), watched, note };
}
const tape = async (t: ReturnType<typeof createSolanaTrades>) => JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string; side: string; usd: string; amt: string; trader: string | null; t_ms: number }[] };

test("a trade the stream sends reaches the tape (with its trader) and the 1s candle", async () => {
  const s = setup({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 });
  assert.equal((await s.t.trades(MINT, 50)).status, 200); // opened: watched, cold read empty
  assert.deepEqual(s.watched, [MINT]);
  s.on().note(MINT, s.note(BUY.signature, 465_000_000));
  await settle();
  const rows = (await tape(s.t)).trades;
  // 98,320,987 lamports at 93.42267796 USD per SOL; 2,156,510.335886 tokens
  assert.deepEqual(rows, [{ t_ms: TS * 1000, side: "b", usd: "9.18540990521034652", amt: "2156510.335886", trader: "4ZvukwqXc2AFAHcuvW8VrKD9j3zGHuoqW4hvEQfANH2n", tx: BUY.signature }]);
  const c = JSON.parse((await s.t.candles(MINT, "1s", null, 10)).body) as { candles: [number, string, string, string, string, string][]; src: string };
  assert.equal(c.src, "chain");
  assert.equal(c.candles.length, 1);
  assert.equal(c.candles[0]![0], TS);
  assert.equal(c.candles[0]![5], "9.18540990521034652");
  // a mint that is not listed is not read
  assert.equal((await s.t.trades("So11111111111111111111111111111111111111112", 50)).status, 404);
});

test("a dropped stream: the stream's trades stay on the tape at once, the gap is walked from signatures and joins in chain order", async () => {
  const asked: Record<string, unknown>[] = [];
  const chain: Chain = {
    sigs: (p) => (asked.push(p), p.until === "SIG1" ? [{ signature: "SIG3", slot: 103, err: null }, { signature: "SIG2", slot: 102, err: null }] : []),
    txs: { SIG2: BUY.result, SIG3: BUY.result },
    price: 9_342_267_796n,
    pub: TS,
    slot: 100,
  };
  const s = setup(chain);
  await s.t.trades(MINT, 50);
  s.on().note(MINT, s.note("SIG1", 101));
  await settle();
  s.on().down();
  // while the stream is down and again up but not yet refilled, a new trade is on the tape at once
  s.on().note(MINT, s.note("SIG4", 104));
  await settle();
  assert.deepEqual((await tape(s.t)).trades.map((r) => r.tx), ["SIG4", "SIG1"]);
  s.on().up();
  await settle();
  assert.deepEqual(asked.at(-1), { limit: 100, commitment: "confirmed", until: "SIG1" });
  assert.deepEqual((await tape(s.t)).trades.map((r) => r.tx), ["SIG4", "SIG3", "SIG2", "SIG1"]);
  // the same trade from the stream and the walk is held once
  s.on().note(MINT, s.note("SIG3", 103));
  await settle();
  assert.equal((await tape(s.t)).trades.length, 4);
});

test("a recorded hour of one token replays to the fixed answer (candles 1m and 1s, the tape)", async () => {
  const H = JSON.parse(gunzipSync(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.json.gz"))).toString()) as {
    mint: string; decimals: number; end: number; pyth: { slot: number; owner: string; data: string };
    txs: { sig: string; slot: number; err: boolean; logs?: string[] }[];
  };
  const want = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.answer.json"), "utf8"));
  const p = Buffer.from(H.pyth.data, "base64");
  const pub = Number(p.readBigInt64LE(93));
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: p.readBigInt64LE(73), pub, slot: H.pyth.slot }, { [H.mint]: H.decimals }),
    now: () => pub * 1000,
    listed: async (m) => m === H.mint,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  await t.trades(H.mint, 50);
  for (const x of H.txs) withClock(on!).note(H.mint, { sig: x.sig, slot: x.slot, err: x.err, logs: x.logs ?? [] });
  await settle();
  const got = {
    m1: JSON.parse((await t.candles(H.mint, "1m", null, 500)).body).candles,
    s1: JSON.parse((await t.candles(H.mint, "1s", null, 500)).body).candles,
    tape: JSON.parse((await t.trades(H.mint, 50)).body).trades,
  };
  // worked out apart from the feed: every curve trade's SOL leg at the recorded price, the seconds that held one
  const trades = H.txs.filter((x) => !x.err).flatMap((x) => fromLogs(x.logs).trades).filter((x) => x.mint === H.mint);
  const solUsd = p.readBigInt64LE(73) * 10n ** 10n; // exponent -8 to 10^18
  const vol = trades.reduce((sum, x) => sum + (x.quote * solUsd) / 10n ** 9n, 0n);
  const scale = (v: string): bigint => BigInt(v.replace(".", "").padEnd(0)) * 10n ** BigInt(18 - (v.split(".")[1]?.length ?? 0));
  assert.equal(got.m1.reduce((sum: bigint, c: string[]) => sum + scale(c[5]!), 0n), vol);
  assert.equal(got.s1.length, Math.min(500, new Set(trades.map((x) => x.ts)).size));
  assert.equal(got.tape.length, Math.min(50, trades.length));
  assert.equal(got.tape[0].tx, H.txs.filter((x) => !x.err && fromLogs(x.logs).trades.some((y) => y.mint === H.mint)).at(-1)!.sig);
  assert.equal(got.m1.length, 6); // the recorded hour's 315 trades fell in six minutes (21:44Z to 21:49Z)
  assert.deepEqual(got, want);
});

test("card helper-loop-never-held-by-a-read: a busy coin's notes landing in one turn fold its book once, a turn's slice at a time, never once a note in that turn; a read folds what is held first, so the answer is the same (red at c6711e2c3: each of the recorded hour's notes refolded every held trade in the turn it landed, and no fold asked the slicer)", async () => {
  const H = JSON.parse(gunzipSync(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.json.gz"))).toString()) as {
    mint: string; decimals: number; end: number; pyth: { slot: number; owner: string; data: string };
    txs: { sig: string; slot: number; err: boolean; logs?: string[] }[];
  };
  const want = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.answer.json"), "utf8"));
  const p = Buffer.from(H.pyth.data, "base64");
  const pub = Number(p.readBigInt64LE(93));
  let on: SourceEvents | null = null;
  // each fold the feed runs off its notes asks the slicer once: a counting clock, a turn of 1 item
  let folds = 0;
  const slicer = turnSlicer(() => folds++, 1);
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: p.readBigInt64LE(73), pub, slot: H.pyth.slot }, { [H.mint]: H.decimals }),
    now: () => pub * 1000,
    listed: async (m) => m === H.mint,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    pass: () => slicer.pass(),
  });
  await t.trades(H.mint, 50);
  // the stream sends each note's slot clock first, as the deployed one does (card helper-sol-tape-checks-hold: a trade is
  // dated by its block, so a note with no clock waits on one)
  const note = (x: (typeof H.txs)[number]) => withClock(on!).note(H.mint, { sig: x.sig, slot: x.slot, err: x.err, logs: x.logs ?? [] });
  const half = Math.floor(H.txs.length / 2);
  // the first half: its notes' trades held in their own turn (their microtasks run), folded in a turn after, once
  const before = folds;
  for (const x of H.txs.slice(0, half)) note(x);
  for (let i = 0; i < 200; i++) await null;
  assert.equal(folds - before, 0, "no fold ran in the notes' own turn");
  await settle();
  const asked = folds - before;
  assert.ok(asked >= 1 && asked <= 3, `${half} notes in one turn asked the slicer ${asked} times`);
  // the second half read at once, before the folds' turn: the read folds what is held itself, so the answer is whole
  for (const x of H.txs.slice(half)) note(x);
  for (let i = 0; i < 200; i++) await null;
  const got = {
    m1: JSON.parse((await t.candles(H.mint, "1m", null, 500)).body).candles,
    s1: JSON.parse((await t.candles(H.mint, "1s", null, 500)).body).candles,
    tape: JSON.parse((await t.trades(H.mint, 50)).body).trades,
  };
  t.stop();
  assert.deepEqual(got, want);
});

test("the websocket source: up only once every subscription is in force; a close is a drop, then reconnect, resubscribe, up", async () => {
  type Fake = { sent: string[]; onopen: (() => void) | null; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send(s: string): void; close(): void };
  const sockets: Fake[] = [];
  const events: string[] = [];
  const src = wsSource("wss://test", { note: (m, n) => events.push(`note ${m} ${n.sig}`), down: () => events.push("down"), up: () => events.push("up"), clock: () => undefined }, {
    ws: () => {
      const f: Fake = { sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => void f.sent.push(s), close: () => undefined };
      sockets.push(f);
      return f;
    },
  });
  const subs = (f: Fake) => f.sent.filter((x) => JSON.parse(x).method === "logsSubscribe");
  const ack = (f: Fake, i: number, sub: number) => f.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(subs(f)[i]!).id, result: sub }) });
  let watched = false;
  const w = src.watch("MintA111111111111111111111111111111111111111").then(() => (watched = true));
  sockets[0]!.onopen!();
  assert.equal(JSON.parse(sockets[0]!.sent[0]!).method, "slotSubscribe"); // the heartbeat
  assert.equal(JSON.parse(subs(sockets[0]!)[0]!).params[0].mentions[0], "MintA111111111111111111111111111111111111111");
  assert.equal(JSON.parse(subs(sockets[0]!)[0]!).params[1].commitment, "confirmed");
  await settle();
  assert.equal(watched, false);
  assert.deepEqual(events, []);
  ack(sockets[0]!, 0, 7);
  await w;
  assert.deepEqual(events, ["up"]);
  sockets[0]!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 7, result: { context: { slot: 5 }, value: { signature: "S1", err: null, logs: [] } } } }) });
  // a notification for a subscription nobody holds is dropped
  sockets[0]!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 8, result: { context: { slot: 5 }, value: { signature: "S2", err: null, logs: [] } } } }) });
  assert.deepEqual(events, ["up", "note MintA111111111111111111111111111111111111111 S1"]);
  sockets[0]!.onclose!();
  assert.equal(events.at(-1), "down");
  await new Promise((r) => setTimeout(r, 600)); // the first reconnect waits 500 ms
  assert.equal(sockets.length, 2);
  sockets[1]!.onopen!();
  assert.equal(events.at(-1), "down"); // not up before the resubscription is in force
  ack(sockets[1]!, 0, 9);
  assert.equal(events.at(-1), "up");
  src.close();
});

test("a PumpSwap trade counts for the pool's base mint only, the pool read once from its own program", async () => {
  const P = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")).pools as Record<string, { owner: string; data: string }>;
  const SWAP = F.txs["pumpswap-buy"]!;
  const BASE = "7B85zY7xFXypiEZ2W4YsPQ8AP9V5TYV8Na9aoB16pump";
  const OTHER = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
  const reads: string[] = [];
  const inner = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [BASE]: 6, [OTHER]: 6 });
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    const pool = P[req.params[0]];
    if (req.method === "getAccountInfo" && pool !== undefined) {
      reads.push(req.params[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner: pool.owner, data: [pool.data, "base64"] } } }));
    }
    return inner(url, init);
  };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async () => true, rpcs: ["https://rpc.test"], source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  await t.trades(BASE, 50);
  await t.trades(OTHER, 50);
  const n = (m: string, sig: string, slot: number) => withClock(on!).note(m, { sig, slot, err: false, logs: SWAP.result.meta.logMessages });
  n(BASE, "S1", 10);
  n(OTHER, "S2", 11); // the stream may send a transaction for a mint it only mentions: not that mint's trade
  n(BASE, "S3", 12);
  await settle();
  const rows = JSON.parse((await t.trades(BASE, 50)).body).trades as { tx: string; side: string; amt: string }[];
  assert.deepEqual(rows.map((r) => [r.tx, r.side, r.amt]), [["S3", "b", "624594.981815"], ["S1", "b", "624594.981815"]]);
  assert.deepEqual(JSON.parse((await t.trades(OTHER, 50)).body).trades, []);
  assert.deepEqual(reads, ["MywAbX7A1q79NAaBdSqdsk2Ari1dCBgFmdCR6PFBp1j"]);
});

test("candles of a mint the lists do not hold are the history source's own answer, as before the stream (no 404)", async () => {
  const OTHER = "So11111111111111111111111111111111111111112";
  const asked: [string, string, number | null, number][] = [];
  const hist = { status: 200, body: JSON.stringify({ tf: "1h", candles: [[TS - (TS % 3600), "1", "1", "1", "1", "5"]], src: "geckoterminal", as_of_ms: TS * 1000 }), src: "geckoterminal", asOfMs: TS * 1000 };
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async (m, tf, to, limit) => (asked.push([m, tf, to, limit]), hist),
    tickMs: 0,
  });
  const a = await t.candles(OTHER, "1h", null, 24);
  assert.equal(a.status, 200);
  assert.equal(a.src, "geckoterminal");
  assert.equal(a.body, hist.body);
  assert.deepEqual(asked, [[OTHER, "1h", null, 24]]);
  // its trade tape is still ours only: not listed, not read
  assert.equal((await t.trades(OTHER, 50)).status, 404);
});

/** setup() with signature reads that hang while `hold()` is in force, until `release()` (a slow or limited public RPC). */
function slowSigs() {
  let release = () => undefined as void;
  let gate: Promise<void> | null = null;
  let on: SourceEvents | null = null;
  let walks = 0;
  const fast = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const t = createSolanaTrades({
    fetch: async (url, init) => {
      if (JSON.parse(String(init.body)).method === "getSignaturesForAddress") {
        walks++;
        if (gate !== null) await gate;
      }
      return fast(url, init);
    },
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  const note = (sig: string, slot: number): Note => ({ sig, slot, err: false, logs: BUY.result.meta.logMessages });
  const hold = () => (gate = new Promise<void>((r) => (release = r)));
  return { t, on: () => withClock(on!), note, hold, walks: () => walks, release: () => ((gate = null), release()) };
}

test("the tape never waits on the RPC: a stream trade is on it while a first walk's signature read hangs", async () => {
  const s = slowSigs();
  s.hold();
  assert.equal((await s.t.trades(MINT, 50)).status, 200); // served once the stream holds the token (COLD_WAIT_MS)
  s.on().note(MINT, s.note(BUY.signature, 465_000_000));
  await settle();
  assert.deepEqual((await tape(s.t)).trades.map((r) => r.tx), [BUY.signature]);
  s.release();
});

test("the tape never waits on the RPC: after a dropped stream, a stream trade is on it while the gap's walk hangs", async () => {
  const s = slowSigs();
  assert.equal((await s.t.trades(MINT, 50)).status, 200); // the first walk answers at once
  s.hold();
  s.on().down();
  s.on().up(); // the gap's walk starts, and hangs
  await settle();
  assert.equal(s.walks(), 2);
  s.on().note(MINT, s.note(BUY.signature, 465_000_000));
  await settle();
  assert.deepEqual((await tape(s.t)).trades.map((r) => r.tx), [BUY.signature]);
  s.release();
});

test("a listed token with no priced trade for over a minute answers its empty tape while the stream is live, not 503", async () => {
  // live run 4 Nov 06:23Z (run4): a quiet token the box had open answered 503 upstream on the read after its first trade
  let ms = TS * 1000;
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
    now: () => ms,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  assert.equal((await t.trades(MINT, 50)).status, 200);
  await settle();
  assert.ok(on);
  for (let s = 0; s < 61; s++) {
    ms += 1_000;
    t.tick(); // the stream is live and the token is read: nothing traded
    if (s % 20 === 0) await t.trades(MINT, 50);
  }
  const a = await t.trades(MINT, 50);
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(JSON.parse(a.body).trades, []);
  assert.equal(a.asOfMs, ms);
  t.stop();
});

test("candles of a listed token with no bars of ours: the history is asked for its newest range (one cache key), and a throttled or failed history answers its 429 or 503, never an empty 200", async () => {
  // app live run 41787804457 (4 Nov 06:49Z): wNEAR (listed, no curve trades) answered 200 "chain" with no bars; card
  // evm-chart-opens-without-a-vendor-call: helper live runs 42995547054 and 42998586210 read 200 with no bars for
  // sUSDai's and A7bdiYdS's 1h, both charted by GeckoTerminal minutes later
  const asked: (number | null)[] = [];
  let hist: { status: number; body: string; src?: string; asOfMs?: number; retryAfterS?: number } = { status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 30 };
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async (_m, _tf, to) => (asked.push(to), hist),
    tickMs: 0,
  });
  const throttled = await t.candles(MINT, "1h", null, 60);
  assert.deepEqual([throttled.status, throttled.retryAfterS], [429, 30], throttled.body);
  hist = { status: 503, body: '{"error":{"code":"upstream"}}' };
  assert.equal((await t.candles(MINT, "1h", null, 60)).status, 503);
  hist = { status: 200, body: JSON.stringify({ tf: "1h", candles: [[TS - (TS % 3600) - 3600, "1", "1", "1", "1", "5"]], src: "geckoterminal", as_of_ms: TS * 1000 }), src: "geckoterminal", asOfMs: TS * 1000 };
  const good = await t.candles(MINT, "1h", null, 60);
  assert.equal(good.status, 200);
  assert.equal(good.src, "chain,geckoterminal");
  assert.equal(JSON.parse(good.body).candles.length, 1);
  assert.deepEqual(asked, [null, null, null], "the newest range, not one keyed by the second of the read");
  // a history that knows no bars (GeckoTerminal's own empty answer) is an empty chart, truly
  hist = { status: 200, body: JSON.stringify({ tf: "1h", candles: [], src: "geckoterminal", as_of_ms: TS * 1000 }), src: "geckoterminal", asOfMs: TS * 1000 };
  assert.equal((await t.candles(MINT, "1h", null, 60)).status, 200);
  t.stop();
});

test("card helper-ready-gate: walks that would draw the whole public Solana budget leave a caller's token read its room (200), never the provider's 429", async () => {
  // one provider (the public endpoint) shared by the helper's RPC route and the walks, as on the box: 100 requests per
  // 10 s from our address, then 429 Retry-After 5 (4 Nov 06:24-06:30Z); the clock stands still, so nothing leaves its window
  const t = 1_800_000_000_000;
  const PUBLIC = TRADES_RPCS[0];
  const SECOND = "https://second.test";
  const sent: Record<string, number> = { [PUBLIC]: 0, [SECOND]: 0 };
  const provider = async (url: string, init: RequestInit): Promise<Response> => {
    sent[url] = (sent[url] ?? 0) + 1;
    if (url === PUBLIC && sent[url]! > 100) return new Response("", { status: 429, headers: { "retry-after": "5" } });
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return ok({ context: { slot: 1 }, value: { owner: PYTH_RECEIVER, data: [pyth(9_342_267_796n, t / 1000).toString("base64"), "base64"] } });
    if (req.method === "getAccountInfo") return ok({ context: { slot: 1 }, value: { owner: TOKEN_PROGRAM, data: [mintData(6).toString("base64"), "base64"] } });
    if (req.method === "getSignaturesForAddress") return ok(Array.from({ length: 30 }, (_, i) => ({ signature: `${req.params[0].slice(0, 8)}sig${i}`, slot: 100 + i, err: null })));
    if (req.method === "getTransaction") return ok(null);
    return ok(1);
  };
  const rpc = createRpc({}, { now: () => t, fetch: provider as never });
  const trades = createSolanaTrades({
    fetch: provider,
    now: () => t,
    listed: async () => true,
    rpcs: [PUBLIC, SECOND],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    budget: (u, m) => rpc.background("solana", u, m),
    throttled: (u, h) => rpc.backgroundThrottled("solana", u, h),
  });
  // five tokens opened: each a mint read, a signature page and 30 transactions, about 160 requests in all
  const mints = [MINT, "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC"];
  await Promise.all(mints.map((m) => trades.trades(m, 50)));
  await settle();
  assert.ok(sent[PUBLIC]! + sent[SECOND]! >= 150, `the walks asked ${sent[PUBLIC]! + sent[SECOND]!} requests`);
  assert.ok(sent[PUBLIC]! <= 100 - 3 - 50, `the walks drew ${sent[PUBLIC]} of the public 100: at most its total less the reserve and the callers' half`);
  // a caller opening a token page: the page's reads, at the caller's full share, each answered by the provider
  const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mints[0], { encoding: "base64" }] });
  for (let i = 0; i < 16; i++) assert.equal((await rpc.handle("solana", "application/json", read, "198.51.100.7")).status, 200, `the caller's read ${i + 1}`);
  assert.ok(sent[PUBLIC]! <= 100, "the provider never throttled us");
});

test("card app-console-429: while Discover's lists have no answer (a cold start) a listed token's tape answers 503, never 404 not_found, and its candles are the history's; a token the lists lack is still 404", async () => {
  let listed: boolean | null = null;
  const asked: string[] = [];
  const t = createSolanaTrades({ fetch: (async (u: string) => (asked.push(u), new Response("{}", { status: 503 }))) as never, now: () => Date.now(), listed: async () => listed, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, history: async () => ({ status: 200, body: JSON.stringify({ tf: "15m", candles: [], src: "geckoterminal", as_of_ms: 1 }), src: "geckoterminal", asOfMs: 1 }) } as never);
  const mint = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  assert.equal((await t.trades(mint, 10)).status, 503, "unknown is not 'not listed'");
  assert.equal((await t.candles(mint, "15m", null, 10)).status, 200, "the history answers");
  assert.deepEqual(asked, [], "no walk opened for a token not known listed");
  listed = false;
  assert.equal((await t.trades(mint, 10)).status, 404);
  t.stop();
});

test("card helper-live-bars-no-503: a held token's tape and live candles (limit 2) answer 200 with what is held, dated by its last read, while the stream is down and its walk fails, past a minute and 30 minutes on; once the stream is back the next read is fresh", async () => {
  // the Base live reads that answered 503 for a held token (6 of 100 at 12:00Z) had a Solana twin: a book not folded for
  // STALE_MS answered 503 though it held every trade; the page prints a failed load for every non-2xx answer
  let ms = TS * 1000;
  let rpcUp = true;
  let on: SourceEvents | null = null;
  const up = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const t = createSolanaTrades({
    fetch: (async (u: string, init: RequestInit) => (rpcUp ? up(u, init) : new Response("down", { status: 503 }))) as never,
    now: () => ms,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  assert.equal((await t.trades(MINT, 50)).status, 200);
  await settle();
  withClock(on!).note(MINT, { sig: BUY.signature, slot: 465_000_000, err: false, logs: BUY.result.meta.logMessages });
  await settle();
  t.tick();
  const tape0 = await t.trades(MINT, 50);
  const bars0 = await t.candles(MINT, "1m", null, 2);
  assert.equal(JSON.parse(tape0.body).trades.length, 1);
  assert.equal(JSON.parse(bars0.body).candles.length, 1);
  const readAt = tape0.asOfMs!;

  rpcUp = false;
  on!.down();
  on!.up(); // the gap's walk fails on the RPC, and again every 2 s
  await settle();
  for (const step of [61_000, 25 * 60_000]) {
    ms += step; // the page's reads keep the token open (IDLE_MS); no fold runs while the stream's gap is unread
    const a = await t.trades(MINT, 50);
    assert.equal(a.status, 200, `${ms - readAt} ms after the last read: ${a.status} ${a.body}`);
    // the held tape, as_of_ms its last read; while the gap is unread it claims no reach (card token-stats-count-every-trade)
    const { whole_ms, ...held } = JSON.parse(tape0.body) as Record<string, unknown>;
    assert.equal(whole_ms, 0, "the walk listed the mint's every signature");
    // and filling while the gap is unread: behind the chain, no complete list (card
    // every-tape-and-chart-says-filling-behind-the-head, SOL_BEHIND_MS)
    const { trades, src, as_of_ms } = held;
    assert.deepEqual(JSON.parse(a.body), { trades, filling: true, src, as_of_ms }, "the held tape, as_of_ms its last read, filling and no reach while a gap is unread");
    assert.equal(a.asOfMs, readAt);
    const c = await t.candles(MINT, "1m", null, 2);
    assert.equal(c.status, 200, c.body);
    assert.deepEqual(JSON.parse(c.body), { ...JSON.parse(bars0.body), filling: true }, "the held bars, as_of_ms their last read, filling");
  }

  rpcUp = true;
  on!.down();
  on!.up();
  await settle();
  t.tick();
  const fresh = await t.trades(MINT, 50);
  t.stop();
  assert.equal(fresh.status, 200, fresh.body);
  assert.equal(fresh.asOfMs, ms, "read again once the stream and its walk are back");
});

test("card helper-stays-fast-under-the-live-run (was helper-live-bars-no-503's control): a listed Solana token whose first read fails, with no vendor rows, answers an empty tape, filling, never a 503, its phases named; a read past FAILED_OPEN_MS opens it again (the page polls a filling tape every 3 s and backs a failed one off to 30 s)", async () => {
  let accounts = 0;
  let clock = TS * 1000;
  const t = createSolanaTrades({
    fetch: (async (_u: string, init: RequestInit) => ((JSON.parse(String(init.body)) as { method: string }).method === "getAccountInfo" && accounts++, new Response("down", { status: 503 }))) as never,
    now: () => clock,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  const a = await t.trades(MINT, 50);
  assert.equal(a.status, 200);
  assert.deepEqual(JSON.parse(a.body), { trades: [], filling: true, src: "chain", as_of_ms: TS * 1000 });
  assert.match(a.timing ?? "", /sol-open;desc="listed 0, account unread 0"/);
  clock += FAILED_OPEN_MS;
  await t.trades(MINT, 50);
  assert.equal(accounts, 2, "a read past the wait opens the token again");
  t.stop();
});

test("card helper-stays-fast-under-the-live-run: a listed coin whose first read failed is read again only after FAILED_OPEN_MS, doubled after each failure; the reads in between answer at once, filling, with no read of their own and the wait named (red at fda1267c6: every read ran the whole first read again, the page's 3 s poll of every failing coin under a spent key)", async () => {
  let accounts = 0;
  let clock = TS * 1000;
  const t = createSolanaTrades({
    fetch: (async (_u: string, init: RequestInit) => ((JSON.parse(String(init.body)) as { method: string }).method === "getAccountInfo" && accounts++, new Response("down", { status: 503 }))) as never,
    now: () => clock,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  // the reads a crowd of pages makes, at each time, ms after the first failure
  const at = async (ms: number, reads: number) => {
    clock = TS * 1000 + ms;
    const got = await Promise.all(Array.from({ length: reads }, () => t.trades(MINT, 50)));
    assert.deepEqual([...new Set(got.map((a) => a.status))], [200], `200 at +${ms} ms`);
    return got;
  };
  await at(0, 1);
  assert.equal(accounts, 1);
  const held = await at(500, 5);
  assert.equal(accounts, 1, "inside the first wait: no read of its own");
  assert.match(held[0]!.timing ?? "", /sol-open;desc="listed 0, account unread 0, read again in 500 ms"/);
  assert.deepEqual(JSON.parse(held[0]!.body), { trades: [], filling: true, src: "chain", as_of_ms: TS * 1000 }, "the failed read's own answer, kept");
  await at(FAILED_OPEN_MS, 3);
  assert.equal(accounts, 2, "past the wait: read again once for every read joined");
  await at(FAILED_OPEN_MS + 1_500, 3);
  assert.equal(accounts, 2, "the wait doubled after the second failure");
  await at(FAILED_OPEN_MS * 3, 1);
  assert.equal(accounts, 3);
  t.stop();
});

test("card helper-stays-fast-under-the-live-run, load: the live run's crowd (app-console-429's 25 reads a route at once: the tape and the bars) polling a listed coin whose first read always fails, every 3 s for 30 s, runs at most 5 first reads and 5 vendor reads, every answer 200 (red at fda1267c6: 10 first reads, one per poll, and a vendor read for every tape read, 250)", async () => {
  let accounts = 0;
  let vendor = 0;
  let clock = TS * 1000;
  const t = createSolanaTrades({
    fetch: (async (_u: string, init: RequestInit) => ((JSON.parse(String(init.body)) as { method: string }).method === "getAccountInfo" && accounts++, new Response("down", { status: 503 }))) as never,
    now: () => clock,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    tape: async () => (vendor++, { status: 200, body: JSON.stringify(POOL_ROWS), src: "coingecko", asOfMs: clock }),
    history: async () => ({ status: 200, body: JSON.stringify({ tf: "1m", candles: [] }), src: "geckoterminal", asOfMs: clock }),
  });
  const statuses = new Set<number>();
  for (let poll = 0; poll < 10; poll++) {
    clock = TS * 1000 + poll * 3_000;
    const got = await Promise.all([...Array.from({ length: 25 }, () => t.trades(MINT, 50)), ...Array.from({ length: 25 }, () => t.candles(MINT, "1m", null, 50))]);
    for (const a of got.slice(0, 25)) statuses.add(a.status);
  }
  t.stop();
  assert.deepEqual([...statuses], [200], "every tape read answered 200");
  // the first read again at +0, +3, +6, +12 and +21 s: its wait 1, 2, 4, 8 then 16 s
  assert.ok(accounts <= 5, `${accounts} first reads in 30 s`);
  assert.ok(vendor <= 5, `${vendor} vendor reads in 30 s`);
});

test("card sol-vendor-tape-refresh-lands: a failed read's kept answer names its vendor rows' age as of each read, not as of the read it was kept by (red at fd4d3d39a: a read 700 ms later still said 0 ms)", async () => {
  let clock = TS * 1000;
  const t = createSolanaTrades({
    fetch: (async () => new Response("down", { status: 503 })) as never,
    now: () => clock,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    tape: async () => ({ status: 200, body: JSON.stringify(POOL_ROWS), src: "coingecko", asOfMs: TS * 1000 }),
  });
  const first = await t.trades(MINT, 50);
  assert.match(first.timing ?? "", /sol-vendor-read;desc="rows read 0 ms ago"/);
  clock += 700;
  const kept = await t.trades(MINT, 50);
  assert.match(kept.timing ?? "", /read again in 300 ms/, "inside the wait: the kept answer");
  assert.match(kept.timing ?? "", /sol-vendor-read;desc="rows read 700 ms ago"/);
  assert.equal(JSON.parse(kept.body).as_of_ms, TS * 1000, "dated by the rows' read");
  t.stop();
});

// card token-page-data-complete-and-fast: a coin launched against another coin (BUBBLE against FRONTIER, 11 Nov) had
// an empty tape: its trades were dropped for a quote that is not SOL or USDC. They are priced at the quote coin's row.
const QC = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-quote-coin.json"), "utf8")) as { mint: string; quoteMint: string; signature: string; slot: number; logMessages: string[] };
test("a coin quoted in another coin fills the tape, priced at that coin's USD price, and moves with it", async () => {
  let on: SourceEvents | null = null;
  let price = "0.87";
  const asked: string[] = [];
  let t0 = 1794409723 * 1000;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: 1794409723, slot: QC.slot }, { [QC.mint]: 6, [QC.quoteMint]: 6 }),
    now: () => t0,
    listed: async (m) => m === QC.mint,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    quoteUsd: async (m) => (asked.push(m), price),
    tickMs: 0,
  });
  assert.equal((await t.trades(QC.mint, 50)).status, 200);
  withClock(on!).note(QC.mint, { sig: QC.signature, slot: QC.slot, err: false, logs: QC.logMessages });
  await settle();
  const rows = (JSON.parse((await t.trades(QC.mint, 50)).body) as { trades: { usd: string; amt: string; side: string; tx: string }[] }).trades;
  // 53.265791 FRONTIER at 0.87 USD; 14,716,998.471539 BUBBLE
  assert.deepEqual(rows.map((r) => [r.side, r.usd, r.amt, r.tx]), [["b", "46.34123817", "14716998.471539", QC.signature]]);
  assert.deepEqual(asked, [QC.quoteMint], "the quote coin's price read once for the first trade");
  // the quote coin's price is read again every REF_MS while the token is open
  price = "1.74";
  t0 += 5_000;
  t.tick();
  await settle();
  assert.deepEqual(asked, [QC.quoteMint, QC.quoteMint]);
});

test("a quote coin with no price keeps the tape empty and the log says why, never which token", async () => {
  let on: SourceEvents | null = null;
  const lines: string[] = [];
  let t0 = 1794409723 * 1000;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: 1794409723, slot: QC.slot }, { [QC.mint]: 6, [QC.quoteMint]: 6 }),
    now: () => t0,
    listed: async (m) => m === QC.mint,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    quoteUsd: async () => null,
    log: (l) => lines.push(l),
    tickMs: 0,
  });
  await t.trades(QC.mint, 50);
  withClock(on!).note(QC.mint, { sig: QC.signature, slot: QC.slot, err: false, logs: QC.logMessages });
  await settle();
  assert.deepEqual((JSON.parse((await t.trades(QC.mint, 50)).body) as { trades: unknown[] }).trades, []);
  t0 += 61_000;
  t.tick();
  const line = lines.find((l) => l.startsWith("solana tape:"));
  assert.equal(line, "solana tape: 1 tokens open, 1 empty: quote with no price 1, no trade of a venue read 0, quiet 0");
  assert.ok(!lines.join("\n").includes(QC.mint));
});

// card token-page-data-complete-and-fast: a cold tape waited for its whole walk (30 reads, 5 at a time, oldest first)
test("a first tape read answers after the walk's newest round, with the newest trades, before the older reads end", async () => {
  const sigs = Array.from({ length: 10 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const slow = new Set(sigs.slice(0, 5)); // the 5 oldest take 2.5 s each
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let slowOpen = 0; // older reads started and not yet answered
  const fetchSlow = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    if (req.method === "getTransaction" && slow.has(req.params[0])) {
      slowOpen++;
      await new Promise((r) => setTimeout(r, 2_500));
      slowOpen--;
    }
    return base(url, init);
  };
  const t = createSolanaTrades({ fetch: fetchSlow, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  const rows = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] }).trades;
  assert.ok(slowOpen > 0, "answered while the older reads still ran (the whole walk waited for: none open)");
  assert.deepEqual(rows.map((r) => r.tx).sort(), sigs.slice(5).sort(), "the 5 newest trades");
  // card token-page-data-complete-and-fast: an answer while the walk still reads is marked filling, and the mark goes
  // once the walk has ended
  assert.equal((JSON.parse((await t.trades(MINT, 50)).body) as { filling?: boolean }).filling, true, "filling while older reads run");
  await new Promise((r) => setTimeout(r, 2_700));
  const done = JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[]; filling?: boolean };
  assert.equal(done.filling, undefined, "the walk ended: no mark");
  assert.equal(done.trades.length, 10);
  t.stop();
});

test("card helper-live-run-green-after-122: a busy token whose newest transactions hold no trade of a venue read (failed bot buys, other venues) answers its first tape read at the first round that holds a trade, not empty at the first round", async () => {
  // live run 43250937996: ni hao cat (4CxjZy..., 260k PumpSwap trades a day) answered 0 rows at +0 and +2.4 s; read
  // locally on the public endpoints its first answer came at the first round, empty, and 18 rows a second later
  const sigs = Array.from({ length: 15 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const none = new Set(sigs.slice(10)); // the 5 newest: no trade of a venue read
  const slow = new Set(sigs.slice(0, 5)); // the 5 oldest take 2.5 s each
  const noTrade = { ...BUY.result, meta: { ...BUY.result.meta, logMessages: [] } };
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, none.has(s) ? noTrade : BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let slowOpen = 0;
  const fetchSlow = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    if (req.method === "getTransaction" && slow.has(req.params[0])) {
      slowOpen++;
      await new Promise((r) => setTimeout(r, 2_500));
      slowOpen--;
    }
    return base(url, init);
  };
  const t = createSolanaTrades({ fetch: fetchSlow, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  const rows = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] }).trades;
  assert.deepEqual(rows.map((r) => r.tx).sort(), sigs.slice(5, 10).sort(), "the first round with trades: the 5 before the newest");
  assert.ok(slowOpen > 0, "answered while the oldest reads still ran");
  await new Promise((r) => setTimeout(r, 2_700));
  t.stop();
});

test("card helper-live-run-green-after-122: a token none of whose newest transactions holds a trade answers its first read at its bound (COLD_WAIT_MS), empty and filling, not at the first round", async () => {
  const sigs = Array.from({ length: 10 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const noTrade = { ...BUY.result, meta: { ...BUY.result.meta, logMessages: [] } };
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, noTrade])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  // the 5 newer reads answer at once; the 5 older hang until the test lets them go
  let newerDone = 0;
  let olderOpen = 0;
  let letGo = () => {};
  const held = new Promise<void>((go) => (letGo = go));
  const hang = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    if (req.method === "getTransaction" && sigs.slice(0, 5).includes(req.params[0])) {
      olderOpen++;
      await held;
      olderOpen--;
    }
    const r = await base(url, init);
    if (req.method === "getTransaction" && sigs.slice(5).includes(req.params[0])) newerDone++;
    return r;
  };
  // the bound is the test's: it ends only when the test ends it
  let bound = () => {};
  const t = createSolanaTrades({ fetch: hang, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => new Promise<void>((go) => (bound = go)) });
  let answer: { trades: unknown[]; filling?: boolean } | null = null;
  const reading = t.trades(MINT, 50).then((a) => (answer = JSON.parse(a.body)));
  for (let i = 0; i < 100 && !(newerDone === 5 && olderOpen === 5); i++) await settle();
  assert.deepEqual([newerDone, olderOpen], [5, 5], "the newer round answered, the older reads still open");
  await settle();
  assert.equal(answer, null, "no answer at a first round with no trade");
  bound();
  await reading;
  assert.deepEqual([answer!.trades.length, answer!.filling, olderOpen], [0, true, 5], "at the bound: empty and filling, the older reads still open");
  letGo();
  for (let i = 0; i < 100 && olderOpen > 0; i++) await settle();
  t.stop();
});

test("card helper-stays-fast-under-the-live-run: a busy token's first tape read answers at the first trade the stream sends, while its walk's first round still reads, not at the bound", async () => {
  // the live helper at f28b6bd56, 21 Nov 21:04Z: three cold trending coins' first tapes answered at 2.5, 3.1 and 3.6 s,
  // their streams sending trades all the while, the answer waiting on the walk's first round or the bound
  const sigs = Array.from({ length: 10 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  // every transaction read of the walk hangs until the test lets it go
  let open = 0;
  let letGo = () => {};
  const held = new Promise<void>((go) => (letGo = go));
  const hang = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    if (req.method === "getTransaction") {
      open++;
      await held;
      open--;
    }
    return base(url, init);
  };
  let on: SourceEvents | null = null;
  let bound = () => {};
  const t = createSolanaTrades({ fetch: hang, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => new Promise<void>((go) => (bound = go)) });
  let answer: { trades: { tx: string }[]; filling?: boolean } | null = null;
  const reading = t.trades(MINT, 50).then((a) => (answer = JSON.parse(a.body)));
  for (let i = 0; i < 100 && open < 5; i++) await settle();
  assert.equal(open, 5, "the walk's first round is reading");
  const streamed = `${BUY.signature.slice(0, -2)}99`;
  withClock(on!).note(MINT, { sig: streamed, slot: 465_000_100, err: false, logs: BUY.result.meta.logMessages });
  for (let i = 0; i < 50 && answer === null; i++) await settle();
  assert.notEqual(answer, null, "answered at the streamed trade, the bound not reached");
  assert.deepEqual([answer!.trades.map((r) => r.tx), answer!.filling, open], [[streamed], true, 5], "the streamed row, filling, the walk's reads still open");
  bound();
  await reading;
  letGo();
  for (let i = 0; i < 100 && open > 0; i++) await settle();
  t.stop();
});

/** A flooded coin (its newest COLD_SIGS failed, the 10 before them succeeded) whose transactions are read only once let
 *  go, a vendor tape of rows, a bound and a vendor wait the test ends, and a stream the test drives: each `watch` asked
 *  is kept, to be dropped (rejected as the stream's drop does) or put in force. */
function joinedCold() {
  const okSigs = Array.from({ length: 10 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const failed = Array.from({ length: COLD_SIGS }, (_, i) => ({ signature: `${BUY.signature.slice(0, -3)}f${String(i).padStart(2, "0")}`, slot: 465_000_100 + i, err: { InstructionError: [0, "Custom"] } }));
  const list = [...failed.slice().reverse(), ...okSigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse()];
  const base = rpcFetch({ sigs: (o) => list.slice(0, Number(o.limit ?? list.length)), txs: Object.fromEntries(okSigs.map((s) => [s, BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let letGo = () => {};
  const held = new Promise<void>((go) => (letGo = go));
  const fetchFn = async (url: string, init: RequestInit) => {
    if ((JSON.parse(String(init.body)) as { method: string }).method === "getTransaction") await held;
    return base(url, init);
  };
  const asks: { ok: () => void; no: (e: Error) => void }[] = [];
  let vendorReads = 0;
  let bound = () => {};
  let vendorWait = () => {};
  const t = createSolanaTrades({
    fetch: fetchFn,
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: () => new Promise<void>((ok, no) => void asks.push({ ok, no })), unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
    tape: async () => (vendorReads++, { status: 200, body: JSON.stringify(POOL_ROWS), src: "coingecko", asOfMs: TS * 1000 }),
    coldWait: () => new Promise<void>((go) => (bound = go)),
    vendorWait: () => new Promise<void>((go) => (vendorWait = go)),
  });
  return { t, okSigs, asks, letGo, vendorReads: () => vendorReads, bound: () => bound(), vendorWait: () => vendorWait() };
}
type TapeBody = { trades: { tx: string }[]; src: string; filling?: boolean; whole_ms?: number };
/** 25 reads of the coin's tape at once (app-console-429's page opens), each answer kept as it lands. */
function joined25(t: ReturnType<typeof createSolanaTrades>) {
  const answers: ({ status: number; body: TapeBody | null; timing?: string } | null)[] = Array.from({ length: 25 }, () => null);
  const all = Promise.all(answers.map((_, i) => t.trades(MINT, 50).then((a) => (answers[i] = { status: a.status, body: a.status === 200 ? (JSON.parse(a.body) as TapeBody) : null, timing: a.timing }))));
  return { answers, all };
}

test("card helper-stays-fast-under-the-live-run: 25 reads joined on a cold coin whose stream drops before its subscription is in force all answer 200, never 503: the subscription is asked again and the walk's rows come once it is in force (red at 77bfa8030: app-console-429 on helper-20, 25 of 25 reads 503 at 3.6 s)", async () => {
  const c = joinedCold();
  const { answers, all } = joined25(c.t);
  for (let i = 0; i < 20 && c.asks.length === 0; i++) await settle();
  assert.equal(c.asks.length, 1, "one subscription for the 25 joined reads");
  // the stream drops before the subscription is in force, as wsSource's drop rejects every watch still waiting
  c.asks[0]!.no(new Error(`stream dropped before ${MINT} was subscribed`));
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(answers.filter((a) => a !== null).map((a) => a!.status), [], "no read answered on the drop");
  assert.equal(c.asks.length, 2, "the subscription asked again");
  // the stream is back and the subscription in force: the walk's transactions read, its rows answer every joined read
  c.asks[1]!.ok();
  c.letGo();
  await all;
  assert.deepEqual([...new Set(answers.map((a) => a!.status))], [200], "every joined read answered 200");
  assert.deepEqual([...new Set(answers.map((a) => a!.body!.src))], ["chain"], "the walk's rows, ours");
  assert.ok(answers.every((a) => a!.body!.trades.length > 0));
  c.bound();
  c.t.stop();
});

test("card helper-stays-fast-under-the-live-run: 25 reads joined on a flooded cold coin whose subscription is slow answer at the bound, 200, filling, with the vendor's rows read before it, the subscription still asked; once it is in force the next read is the walk's rows (red at 77bfa8030: the bound ran from the subscription, so no answer came before it, and live run 44979250087 answered a flooded coin at 5.5 s, 12 joined tapes at 3.9 s)", async () => {
  const c = joinedCold();
  const { answers, all } = joined25(c.t);
  for (let i = 0; i < 20 && c.asks.length === 0; i++) await settle();
  // half the bound in, no row held: the vendor's tape is read then, once for every joined read
  c.vendorWait();
  for (let i = 0; i < 5; i++) await settle();
  const readBefore = c.vendorReads();
  // the bound, from the read's start, with the subscription not yet in force
  c.bound();
  for (let i = 0; i < 20 && answers.some((a) => a === null); i++) await settle();
  assert.equal(answers.filter((a) => a !== null).length, 25, "every joined read answered at the bound, the subscription still asked");
  assert.equal(readBefore, 1, "the vendor read before the bound, once");
  await all;
  assert.deepEqual([...new Set(answers.map((a) => a!.status))], [200]);
  assert.deepEqual([...new Set(answers.map((a) => `${a!.body!.src} ${a!.body!.filling} ${a!.body!.whole_ms}`))], ["coingecko true undefined"], "the vendor's rows, filling, no whole tape claimed");
  assert.equal(c.vendorReads(), 1, "the answers took the vendor read made before the bound, none after");
  assert.match(answers[0]!.timing ?? "", /sol-open;desc="listed 0, account 0, price 0, answer by bound after 0 rounds 0"/);
  // the subscription in force, the walk read: the next read is our own rows
  c.asks[0]!.ok();
  c.letGo();
  for (let i = 0; i < 50; i++) await settle();
  const next = JSON.parse((await c.t.trades(MINT, 50)).body) as TapeBody;
  assert.equal(next.src, "chain");
  assert.deepEqual(next.trades.map((r) => r.tx).sort(), [...c.okSigs].sort());
  c.t.stop();
});

test("card helper-stays-fast-under-the-live-run: a first answer at its bound with no row of ours says filling and claims no whole tape, whoever's rows it carries; the next read after the walk is our own rows, every one walked", async () => {
  const sigs = Array.from({ length: 10 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let open = 0;
  let letGo = () => {};
  const held = new Promise<void>((go) => (letGo = go));
  const hang = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    if (req.method === "getTransaction") {
      open++;
      await held;
      open--;
    }
    return base(url, init);
  };
  // the vendor's tape answers fresh rows: on their own they would claim a whole tape (whole_ms)
  const vendor = async () => ({ status: 200, body: JSON.stringify(POOL_ROWS), src: "geckoterminal", asOfMs: TS * 1000 });
  const t = createSolanaTrades({ fetch: hang, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape: vendor, coldWait: () => settle() });
  const first = JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[]; src: string; filling?: boolean; whole_ms?: number };
  assert.equal(open, 5, "the walk's first round still reads");
  assert.deepEqual([first.src, first.trades.length > 0, first.filling, first.whole_ms], ["geckoterminal", true, true, undefined], "the vendor's rows, filling, no whole tape claimed");
  letGo();
  for (let i = 0; i < 100 && open > 0; i++) await settle();
  await settle();
  const next = JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[]; src: string; filling?: boolean };
  assert.equal(next.src, "chain", "our own rows once the walk holds them");
  assert.deepEqual(next.trades.map((r) => r.tx).sort(), [...sigs].sort(), "every trade walked, none missing");
  assert.equal(next.filling, undefined, "the walk ended: no mark");
  t.stop();
});

// card solana-trades-show-on-every-token: a token whose newest signatures are failed bot transactions
/** A token's signature list, newest first, as getSignaturesForAddress pages it (`limit`, `before`); `ok(i)` whether the
 *  i-th newest succeeded. Each call's `limit` is kept in `asked`. */
function botFlood(n: number, ok: (i: number) => boolean) {
  const list = Array.from({ length: n }, (_, i) => ({ signature: `${BUY.signature.slice(0, -4)}${String(i).padStart(4, "0")}`, slot: 469_645_431 - Math.floor(i / 20), err: ok(i) ? null : { InstructionError: [3, { Custom: 6003 }] } }));
  const asked: number[] = [];
  const sigs = (p: Record<string, unknown>) => {
    asked.push(p.limit as number);
    const from = p.before === undefined ? 0 : list.findIndex((s) => s.signature === p.before) + 1;
    return list.slice(from, from + (p.limit as number));
  };
  const txs = Object.fromEntries(list.filter((s) => s.err === null).map((s) => [s.signature, BUY.result]));
  return { list, asked, sigs, txs };
}
const reads = (f: ReturnType<typeof botFlood>) => {
  let tx = 0;
  const base = rpcFetch({ sigs: f.sigs, txs: f.txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const fetchCount = async (url: string, init: RequestInit) => ((JSON.parse(String(init.body)) as { method: string }).method === "getTransaction" && tx++, base(url, init));
  const t = createSolanaTrades({ fetch: fetchCount, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  return { t, tx: () => tx };
};

test("card solana-tape-rows-at-first-answer: a busy token whose newest signatures are all failed bot transactions answers its first tape read with the newest COLD_SIGS successful trades, never 0 rows (live run 43689567273: CjRGc8wH...pump 0 rows at +0 ms; at 07:27:09Z its newest 30 signatures held 0 successful, its newest 1000 held 29)", async () => {
  // as read on mainnet: the newest 30 all failed, then one in 34 succeeded
  const f = botFlood(1_030, (i) => i >= 30 && i % 34 === 0);
  const { t, tx } = reads(f);
  const first = JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] };
  const ok = f.list.filter((s) => s.err === null).map((s) => s.signature);
  assert.ok(first.trades.length > 0, `rows at the first answer: ${first.trades.length}`);
  await new Promise((r) => setTimeout(r, 50));
  const all = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] }).trades.map((r) => r.tx);
  assert.deepEqual(all.sort(), ok.slice(0, 30).sort(), "the newest successful transactions, at most COLD_SIGS");
  // card solana-flooded-coin-first-answer-holds-rows: with none successful in the first page, a SHORT_PAGE beside it
  assert.deepEqual(f.asked, [30, SHORT_PAGE, 1_000], "one more signature page, of Solana's largest size, only past a first page of failed ones");
  assert.equal(tx(), ok.slice(0, 30).length, "a transaction read for each successful one only");
  t.stop();
});

// card solana-flooded-coin-first-answer-holds-rows: helper update 22's live run 45011614034 opened 5o7AFuoN...pump cold, 1
// of its newest 30 signatures successful, and answered 0 rows at its bound: the walk read that one only after the
// COLD_PAGE before it was listed (1000 signatures, 235 KB: 1,599 ms from the Mac on api.mainnet-beta, 22 Nov 12:2xZ).
test("card solana-flooded-coin-first-answer-holds-rows: a flooded coin with 1 successful in its newest 30 answers its first read with that trade, src chain, while the COLD_PAGE is still listed; the walk then holds the newest 30 successful, each read once, in the list's order (red at ef813c927: 0 rows at the bound)", async () => {
  // as read live: the 8th newest succeeded, then one in 34 past the first page
  const f = botFlood(1_030, (i) => i === 7 || (i >= 30 && i % 34 === 0));
  let tx = 0;
  let pageGo = () => {};
  const page = new Promise<void>((go) => (pageGo = go));
  let bound = () => {};
  const base = rpcFetch({ sigs: f.sigs, txs: f.txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const fetchFn = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
    if (req.method === "getTransaction") tx++;
    // the COLD_PAGE answers only once the test lets it go, after the first answer
    if (req.method === "getSignaturesForAddress" && req.params[1].limit === 1_000) await page;
    return base(url, init);
  };
  const t = createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => new Promise<void>((go) => (bound = go)) });
  const answer = t.trades(MINT, 50);
  // the first page listed and its one successful read, the COLD_PAGE still out; then the bound
  for (let i = 0; i < 30; i++) await settle();
  bound();
  const first = JSON.parse((await answer).body) as { trades: { tx: string }[]; src: string; filling?: boolean };
  const ok = f.list.filter((s) => s.err === null).map((s) => s.signature);
  assert.deepEqual([first.src, first.trades.map((r) => r.tx)], ["chain", [ok[0]]], "the first page's one trade at the first answer, ours");
  assert.equal(first.filling, true, "more to come: filling");
  pageGo();
  for (let i = 0; i < 60; i++) await settle();
  const all = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] }).trades.map((r) => r.tx);
  assert.deepEqual(all, ok.slice(0, 30), "the newest 30 successful, newest first: the early one above every older page's");
  assert.deepEqual(f.asked, [30, 1_000]);
  assert.equal(tx, 30, "each read once");
  t.stop();
});

test("card solana-flooded-coin-first-answer-holds-rows: a flooded coin with none successful in its newest 30 lists a SHORT_PAGE beside the COLD_PAGE and answers its first read with the short page's trades, src chain, the COLD_PAGE still held; the walk then holds the newest 30 successful, each read once (red at ef813c927: 0 rows at the bound)", async () => {
  // as CjRGc8wH...pump read in live run 43689567273: the newest 30 failed, then one in 34 succeeded
  const f = botFlood(1_030, (i) => i >= 30 && i % 34 === 0);
  let tx = 0;
  let pageGo = () => {};
  const page = new Promise<void>((go) => (pageGo = go));
  let bound = () => {};
  const base = rpcFetch({ sigs: f.sigs, txs: f.txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const fetchFn = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
    if (req.method === "getTransaction") tx++;
    if (req.method === "getSignaturesForAddress" && req.params[1].limit === 1_000) await page;
    return base(url, init);
  };
  const t = createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => new Promise<void>((go) => (bound = go)) });
  const answer = t.trades(MINT, 50);
  for (let i = 0; i < 30; i++) await settle();
  bound();
  const first = JSON.parse((await answer).body) as { trades: { tx: string }[]; src: string };
  const ok = f.list.filter((s) => s.err === null).map((s) => s.signature);
  assert.deepEqual([first.src, first.trades.map((r) => r.tx)], ["chain", ok.slice(0, 3)], "the short page's three successful trades (the 35th, 69th and 103rd newest), ours, at the first answer");
  pageGo();
  for (let i = 0; i < 60; i++) await settle();
  const all = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[] }).trades.map((r) => r.tx);
  assert.deepEqual(all, ok.slice(0, 30), "the newest 30 successful, newest first");
  assert.deepEqual(f.asked, [30, SHORT_PAGE, 1_000], "the short page beside the COLD_PAGE, asked first");
  assert.equal(tx, 30, "each read once");
  t.stop();
});

test("card solana-flooded-coin-first-answer-holds-rows: a read of a cold tape another read opened (vendor rows already held for its pool) waits for our first row inside its bound and answers src chain, not the vendor's rows at once (red at ef813c927: src coingecko at once)", async () => {
  const c = joinedCold();
  const opening = c.t.trades(MINT, 50);
  for (let i = 0; i < 20 && c.asks.length === 0; i++) await settle();
  c.asks[0]!.ok();
  for (let i = 0; i < 10; i++) await settle();
  c.vendorWait();
  for (let i = 0; i < 5; i++) await settle();
  c.bound();
  const first = JSON.parse((await opening).body) as { src: string; filling?: boolean };
  assert.deepEqual([first.src, first.filling], ["coingecko", true], "the opening read at its bound: the vendor's rows, filling (as before)");
  assert.ok(c.vendorReads() > 0, "the vendor's rows held for the coin");
  // a second read while the walk's reads are still out: it waits for our first row
  let got: { src: string; trades: unknown[] } | null = null;
  const next = c.t.trades(MINT, 50).then((a) => (got = JSON.parse(a.body)));
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(got, null, "no vendor answer at once while our walk reads inside the bound");
  c.letGo();
  await next;
  assert.equal(got!.src, "chain");
  assert.ok(got!.trades.length > 0);
  c.t.stop();
});

test("card solana-tape-rows-at-first-answer, guard: a token whose newest COLD_SIGS signatures succeeded asks its one page, as before", async () => {
  const f = botFlood(1_030, (i) => i < 40 || i % 3 === 0);
  const { t, tx } = reads(f);
  await t.trades(MINT, 50);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.asked, [30]);
  assert.equal(tx(), 30);
  t.stop();
});

// card solana-trades-show-on-every-token: NEARKAT (6UtY9iTZ..., a Raydium CPMM token, 29k USD a day) and BONK answered
// {"trades":[],"src":"chain"} on the deployed helper (main 204ee6b8a, 14 Nov 17:21Z): the chain tape decodes the pump.fun
// curve and PumpSwap only, and the helper's log read "no trade of a venue read" for every such token open
const NK = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-pool-trades-nearkat.json"), "utf8")) as { mint: string; signature: string; tx: { slot: number } };
// card robinhood-trades-finish-filling: a tape says filling false only once it holds every trade back to its floor (here
// the cold walk's newest COLD_SIGS); a walk that fails is walked again, never settled short on a read that failed
test("a cold walk whose signature reads fail three times is walked again: the tape says filling until it is read, then holds its trades (red at d3ae40db4: done after three fails, 0 rows, not filling)", async () => {
  const sigs = Array.from({ length: 4 }, (_, i) => `${BUY.signature.slice(0, -2)}${String(i).padStart(2, "0")}`);
  const base = rpcFetch({ sigs: () => sigs.map((s, i) => ({ signature: s, slot: 465_000_000 + i, err: null })).reverse(), txs: Object.fromEntries(sigs.map((s) => [s, BUY.result])), price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let failing = 3;
  const flaky = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string };
    if (req.method === "getSignaturesForAddress" && failing > 0) return failing--, new Response("unavailable", { status: 503 });
    return base(url, init);
  };
  const t = createSolanaTrades({ fetch: flaky, now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => settle() });
  const read = async () => JSON.parse((await t.trades(MINT, 50)).body) as { trades: unknown[]; filling?: boolean };
  const seen: { n: number; filling?: boolean }[] = [];
  for (let i = 0; i < 40; i++) {
    const j = await read();
    seen.push({ n: j.trades.length, filling: j.filling });
    if (j.filling !== true) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  t.stop();
  for (const a of seen) assert.ok(a.filling === true || a.n === sigs.length, `settled short: ${JSON.stringify(seen)}`);
  assert.equal(seen.at(-1)!.n, sigs.length, `its trades read: ${JSON.stringify(seen)}`);
  assert.equal(failing, 0);
});

const POOL_ROWS = [
  { t_ms: Date.parse("2026-11-14T17:22:05Z"), side: "s", usd: "427.037807197591623106", amt: "648306.777831", trader: "EiSEokSBEa9iHSN3gEUKbyCriKMkzqUfr5nLazkkHZki", tx: NK.signature },
];
/** A first read's bound that a walk of one recorded transaction ends well inside: the bound runs from the read's start
 *  (card helper-stays-fast-under-the-live-run), so one settle() could end it before the walk. */
const walked = () => new Promise<void>((r) => setTimeout(r, 200));
function nearkat(tape?: () => Promise<{ status: number; body: string; src?: string; asOfMs?: number }>) {
  const chain = rpcFetch({ sigs: () => [{ signature: NK.signature, slot: NK.tx.slot, err: null }], txs: { [NK.signature]: NK.tx }, price: 9_342_267_796n, pub: TS, slot: NK.tx.slot }, { [NK.mint]: 6 });
  // the trade's pool account (4w2cysot..., read since the tape decodes Raydium CPMM) answers no account: the walk ends
  // with no trade placed, as on a venue the tape does not decode; thrown, the walk retried for good and the first read
  // answered at its bound, still reading (card helper-stays-fast-under-the-live-run)
  const fetchFn = async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    if (req.method === "getAccountInfo" && req.params[0] !== NK.mint && req.params[0] !== PYTH_SOL_USD) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: NK.tx.slot }, value: null } }), { status: 200 });
    return chain(url, init);
  };
  return createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async (m) => m === NK.mint, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: walked, ...(tape === undefined ? {} : { tape }) });
}

test("card solana-trades-show-on-every-token: a listed token on a venue the chain tape does not decode (Raydium CPMM, recorded) is served its top pool's trades, never an empty tape", async () => {
  let asked = 0;
  const t = nearkat(async () => (asked++, { status: 200, body: JSON.stringify(POOL_ROWS), src: "geckoterminal", asOfMs: TS * 1000 - 5_000 }));
  const a = await t.trades(NK.mint, 50);
  assert.equal(a.status, 200, a.body);
  const j = JSON.parse(a.body) as { trades: unknown[]; src: string; as_of_ms: number; filling?: boolean };
  assert.deepEqual(j.trades, POOL_ROWS, "the pool's trades, not the chain's empty tape");
  assert.equal(j.src, "geckoterminal");
  assert.equal(j.as_of_ms, TS * 1000 - 5_000, "dated by the pool read");
  assert.equal(j.filling, undefined);
  assert.equal(a.src, "geckoterminal");
  assert.ok(asked > 0);
  // the limit holds on the pool's rows too
  assert.equal((JSON.parse((await t.trades(NK.mint, 1)).body) as { trades: unknown[] }).trades.length, 1);
  t.stop();
});

test("card solana-trades-show-on-every-token: the pool's trades refused or down, an undecoded token's tape answers empty with filling (the page reads again), and a token with chain rows never asks the pool", async () => {
  for (const tape of [async () => ({ status: 429, body: "{}" }), async () => Promise.reject(new Error("down"))]) {
    const t = nearkat(tape);
    const a = await t.trades(NK.mint, 50);
    assert.equal(a.status, 200);
    const j = JSON.parse(a.body) as { trades: unknown[]; src: string; filling?: boolean };
    assert.deepEqual(j.trades, []);
    assert.equal(j.filling, true);
    assert.equal(j.src, "chain");
    t.stop();
  }
  let asked = 0;
  const t = createSolanaTrades({ fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: BUY.result.slot }, { [MINT]: 6 }), now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: (o) => ((pumpOn = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape: async () => (asked++, { status: 200, body: "[]" }) });
  await t.trades(MINT, 50);
  withClock(pumpOn!).note(MINT, { sig: BUY.signature, slot: BUY.result.slot, err: false, logs: BUY.result.meta.logMessages });
  await settle();
  const rows = (JSON.parse((await t.trades(MINT, 50)).body) as { trades: { tx: string }[]; src: string }).trades;
  assert.deepEqual(rows.map((r) => r.tx), [BUY.signature]);
  asked = 0;
  await t.trades(MINT, 50);
  assert.equal(asked, 0, "a pump.fun token with chain rows is served the chain's tape, no pool read");
  t.stop();
});
let pumpOn: SourceEvents | null = null;

// card solana-dropped-tape-settles: helper 178, live run 43989230034 (robinhood-listed-tape-opens, ~00:51Z): Cat
// (CoqwPnZ3...u61w), a token the lists had just dropped, answered filling 45,789 ms after its first read (21 reads). Its
// one pool, Cat / PUMP 8Ur5P74d..., was made 2026-11-17T00:50:56Z (GeckoTerminal /pools/8Ur5P74d..., read 02:5xZ): the
// vendor named no pool for it yet (404), and a listed token whose own walk holds no trade answered filling for every
// vendor answer that was not 200, so for as long as the vendor's 404 was held, and forever while it refuses.
test("card solana-dropped-tape-settles: a listed token whose walk holds no trade settles inside the live checks' 45 s whatever the vendor answers: its 404 (no pool named) at once, a refusal or a failure after VENDOR_WAIT_MS, empty, src chain, never filling past it and never claimed whole (red at 9dc3a90a0: filling at every read for 45 s)", async () => {
  const clock = { t: TS * 1000 };
  for (const [name, tape] of [
    ["404", async () => ({ status: 404, body: JSON.stringify({ error: { code: "not_found" } }) })],
    ["429", async () => ({ status: 429, body: "{}" })],
    ["down", async () => Promise.reject(new Error("down"))],
  ] as const) {
    // its walk lists no signature of a venue read: the newest are the new pool's, which no venue of ours decodes
    const fetchFn = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: NK.tx.slot }, { [NK.mint]: 6 });
    const t = createSolanaTrades({ fetch: fetchFn, now: () => clock.t, listed: async (m) => m === NK.mint, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, coldWait: () => settle(), tape });
    // the live check's reads: every FILL_POLL_MS (2 s) for FILLED_MS (45 s) from the first
    let j = JSON.parse((await t.trades(NK.mint, 50)).body) as Record<string, unknown>;
    let reads = 1;
    for (let ms = 2_000; ms <= 45_000 && j.filling === true; ms += 2_000, reads++) {
      clock.t += 2_000;
      await settle();
      const a = await t.trades(NK.mint, 50);
      assert.equal(a.status, 200, `${name}: ${a.body}`);
      j = JSON.parse(a.body) as Record<string, unknown>;
    }
    assert.equal(j.filling, undefined, `${name}: still filling after ${reads} reads over 45 s`);
    assert.deepEqual(j.trades, [], name);
    assert.equal(j.src, "chain", name);
    assert.equal(j.whole_ms, undefined, `${name}: a tape whose vendor never answered is not the token's whole`);
    if (name !== "404") assert.ok(reads > 1, `${name}: a refusal is read again inside the wait, not settled at once`);
    t.stop();
    clock.t = TS * 1000;
  }
});

test("card solana-dropped-tape-settles: a token the lists do not hold whose vendor refuses answers filling inside VENDOR_WAIT_MS and the vendor's own refusal past it, never filling for good and never an empty 200 (red at 9dc3a90a0: filling for 45 s)", async () => {
  const clock = { t: TS * 1000 };
  const t = createSolanaTrades({ fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: NK.tx.slot }, { [NK.mint]: 6 }), now: () => clock.t, listed: async () => false, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape: async () => ({ status: 429, body: JSON.stringify({ error: { code: "rate_limited" } }), retryAfterS: 5 }) });
  assert.equal(JSON.parse((await t.trades(NK.mint, 50)).body).filling, true, "filling at first");
  clock.t += 45_000;
  const a = await t.trades(NK.mint, 50);
  assert.equal(a.status, 429, a.body);
  assert.equal(a.retryAfterS, 5);
  t.stop();
});

test("card solana-trades-show-on-every-token: a token Discover's lists do not hold (a searched token, as NEARKAT and BONK were on the live helper at 837d9d810: 404 not_found) is served its top pool's trades with no walk of ours opened, never 404; a mint no pool names stays 404; the pool's trades refused, empty with filling", async () => {
  let rpcCalls = 0;
  const counted = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: NK.tx.slot }, { [NK.mint]: 6 });
  const make = (tape: () => Promise<{ status: number; body: string; src?: string; asOfMs?: number }>, listed: boolean | null = false) =>
    createSolanaTrades({ fetch: async (u, i) => (rpcCalls++, counted(u, i)), now: () => TS * 1000, listed: async () => listed, rpcs: ["https://rpc.test"], source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0, tape });
  const pool = async () => ({ status: 200, body: JSON.stringify(POOL_ROWS), src: "geckoterminal", asOfMs: TS * 1000 - 5_000 });
  for (const listed of [false, null]) {
    const t = make(pool, listed);
    const a = await t.trades(NK.mint, 50);
    assert.equal(a.status, 200, `lists ${listed}: ${a.body}`);
    const j = JSON.parse(a.body) as { trades: unknown[]; src: string; as_of_ms: number; filling?: boolean };
    assert.deepEqual(j.trades, POOL_ROWS);
    assert.equal(j.src, "geckoterminal");
    assert.equal(j.as_of_ms, TS * 1000 - 5_000);
    assert.equal(j.filling, undefined);
    assert.equal((JSON.parse((await t.trades(NK.mint, 1)).body) as { trades: unknown[] }).trades.length, 1, "the limit holds");
    t.stop();
  }
  assert.equal(rpcCalls, 0, "no walk of ours opens for a token the lists do not hold");
  const none = make(async () => ({ status: 404, body: JSON.stringify({ error: { code: "not_found" } }) }));
  assert.equal((await none.trades(NK.mint, 50)).status, 404, "a mint no pool names");
  none.stop();
  for (const tape of [async () => ({ status: 429, body: "{}" }), async () => Promise.reject(new Error("down"))]) {
    const t = make(tape);
    const a = await t.trades(NK.mint, 50);
    assert.equal(a.status, 200);
    assert.deepEqual(JSON.parse(a.body), { trades: [], filling: true, src: "chain", as_of_ms: TS * 1000 });
    t.stop();
  }
});

test("card helper-listed-charts-own-reads: a listed coin off pump.fun (SPYx, Raydium CLMM against SOL, recorded) gets its own bar and tape row from the stream, src chain, the pool read once from its own program", async () => {
  const V = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-venue-txs.json"), "utf8")) as { txs: Record<string, { result: { meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
  const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
  const reads: string[] = [];
  const inner = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [SPYX]: 8 });
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    const pool = V.pools[req.params[0]];
    if (req.method === "getAccountInfo" && pool !== undefined) {
      reads.push(req.params[0]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner: pool.owner, data: [pool.data, "base64"] } } }));
    }
    return inner(url, init);
  };
  let on: SourceEvents | null = null;
  // no history and no pool tape: the bar and the row can only be ours
  const t = createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async (m) => m === SPYX, rpcs: ["https://rpc.test"], source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  assert.equal((await t.trades(SPYX, 50)).status, 200);
  on!.clock(11, TS); // the stream's clock for the notes' slots (card sol-tape-in-order)
  on!.clock(10, TS);
  withClock(on!).note(SPYX, { sig: "C1", slot: 10, err: false, logs: V.txs["clmm-buy"]!.result.meta.logMessages });
  // a route that only mentions SPYX's neighbours (SOL into SOL/Xs3eBt, then an Orca pool for AMZN): no SPYx trade
  withClock(on!).note(SPYX, { sig: "C2", slot: 11, err: false, logs: V.txs["clmm-sol-in"]!.result.meta.logMessages });
  await settle();
  const a = JSON.parse((await t.trades(SPYX, 50)).body) as { trades: unknown[]; src: string };
  assert.equal(a.src, "chain");
  // SPYx is the pool's token 1: the trader paid 2,082,875,407 lamports of token 0 for 0.19699205 SPYx, a buy, dated by
  // its block (the event has no clock: its slot's clock the stream sent); at 93.42267796 USD per SOL
  assert.deepEqual(a.trades, [{ t_ms: TS * 1000, side: "b", usd: "194.58779837896492972", amt: "0.19699205", trader: "4GQeEya6ZTwvXre4Br6ZfDyfe2WQMkcDz2QbkJZazVqS", tx: "C1" }]);
  const c = JSON.parse((await t.candles(SPYX, "1s", null, 10)).body) as { candles: [number, string, string, string, string, string][]; src: string };
  assert.equal(c.src, "chain");
  assert.equal(c.candles.length, 1);
  assert.equal(c.candles[0]![0], TS);
  assert.equal(c.candles[0]![5], "194.58779837896492972");
  // each pool once (a pool's read is shared), from its own program: CLMM's two and the route's Orca pool
  assert.deepEqual(reads.sort(), ["Af6Rt3zE8ZCFPtSQEePvAHfqpdqzsYA6H3bzY7P3tgCt", "BS9uyGV6XmNnPkM4f3xgxCdQEaFv7RSKs6fwrpvYHxfL", "HWZk6MfN28mYqDN1igNETjN2kueEryL33oVgt92Wkv6N"]);
  t.stop();
});

test("card helper-listed-charts-own-reads: a Raydium CPMM trade names its own mints (no pool read), turned round for the token as the output, priced in its quote coin", async () => {
  const V = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-venue-txs.json"), "utf8")) as { txs: Record<string, { result: { meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
  const FCAT = "2YPWT4QK1Why57mxBZGwBAFckBC4nLwEAL2t6CcCQtvw";
  const WXMR = "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp";
  let on: SourceEvents | null = null;
  // the rpc answers the SOL price and the two mints only: a CPMM pool read would throw. The route's first hops cross
  // Meteora DLMM (card index-sol-trades-2), so the transaction is read whole, and its DLMM pool (WXMR's, another coin's)
  // answers as recorded: a pool answered with no account would leave the transaction unread (card
  // sol-tape-pool-unread-never-kept)
  const DLMM_POOL = "BFKBQT4yFZPtzyttHQayNmjDJYduvFaPXuytMgnaqexV";
  const chain = rpcFetch({ sigs: () => [], txs: { F1: V.txs["cpmm-buy-fee"]!.result }, price: 9_342_267_796n, pub: TS, slot: 100 }, { [FCAT]: 6, [WXMR]: 12 });
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    const p = V.pools[DLMM_POOL]!;
    if (req.method === "getAccountInfo" && req.params[0] === DLMM_POOL) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner: p.owner, data: [p.data, "base64"] } } }));
    return chain(url, init);
  };
  const t = createSolanaTrades({ fetch: fetchFn, now: () => TS * 1000, listed: async (m) => m === FCAT, rpcs: ["https://rpc.test"], wholeWait: () => Promise.resolve(), source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), quoteUsd: async (m) => (m === WXMR ? "300" : null), tickMs: 0 });
  assert.equal((await t.trades(FCAT, 50)).status, 200);
  withClock(on!).note(FCAT, { sig: "F1", slot: 10, err: false, logs: V.txs["cpmm-buy-fee"]!.result.meta.logMessages });
  await settle();
  const a = JSON.parse((await t.trades(FCAT, 50)).body) as { trades: unknown[]; src: string };
  assert.equal(a.src, "chain");
  // the pool paid 3,264,281.114937 FCAT for 0.114146586323 of its quote coin at 300 USD; CPMM's event names no trader;
  // dated by the transaction's block, read whole
  assert.deepEqual(a.trades, [{ t_ms: 1794785264_000, side: "b", usd: "34.2439758969", amt: "3264281.114937", trader: null, tx: "F1" }]);
  t.stop();
});

test("card helper-listed-charts-own-reads: a Raydium LaunchLab coin's buy reaches its tape and bar, the pool read from LaunchLab itself", async () => {
  const V = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-venue-txs.json"), "utf8")) as { txs: Record<string, { result: { meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
  const FLOYD = "EREcNf2Uz8E3VHxqeM5jnaCtiqbgWfWYHXXZLvjTCFQt";
  const POOL = "8rHq4DwFfgUG4m4CK4ADQZsme1byBAwVV7Bbtb3BboUW";
  const inner = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [FLOYD]: 6 });
  const answer = (owner: string) => async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    if (req.method === "getAccountInfo" && req.params[0] === POOL) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner, data: [V.pools[POOL]!.data, "base64"] } } }));
    return inner(url, init);
  };
  const run = async (owner: string) => {
    let on: SourceEvents | null = null;
    const t = createSolanaTrades({ fetch: answer(owner), now: () => TS * 1000, listed: async (m) => m === FLOYD, rpcs: ["https://rpc.test"], source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
    await t.trades(FLOYD, 50);
    on!.clock(10, TS); // the slot's clock (card sol-tape-in-order)
    withClock(on!).note(FLOYD, { sig: "L1", slot: 10, err: false, logs: V.txs["launchlab-buy"]!.result.meta.logMessages });
    await settle();
    const rows = (JSON.parse((await t.trades(FLOYD, 50)).body) as { trades: unknown[] }).trades;
    const bars = (JSON.parse((await t.candles(FLOYD, "1s", null, 10)).body) as { candles: unknown[] }).candles;
    t.stop();
    return { rows, bars };
  };
  // 6,000,000 lamports at 93.42267796 USD per SOL for 940,352.945779 FLOYD
  const ok = await run(RAY_LAUNCHLAB_ID);
  assert.deepEqual(ok.rows, [{ t_ms: TS * 1000, side: "b", usd: "0.56053606776", amt: "940352.945779", trader: null, tx: "L1" }]);
  assert.equal(ok.bars.length, 1);
  // the same bytes in an account another program owns are no pool of LaunchLab's: no trade
  const forged = await run("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
  assert.deepEqual(forged.rows, []);
  assert.equal(forged.bars.length, 0);
});
const RAY_LAUNCHLAB_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

test("card helper-listed-charts-own-reads: bars of ours with the history before them refused, failed or still filling say filling, never a short chart as the coin's whole; with the history in, not filling (one rule with the EVM chains: live run 43776130630 read Base DRB as 1 bar, src chain)", async () => {
  let hist: { status: number; body: string; src?: string; asOfMs?: number; retryAfterS?: number } = { status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 30 };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => hist,
    tickMs: 0,
  });
  assert.equal((await t.trades(MINT, 50)).status, 200);
  await settle();
  withClock(on!).note(MINT, { sig: BUY.signature, slot: 465_000_000, err: false, logs: BUY.result.meta.logMessages });
  await settle();
  t.tick();
  const refused = JSON.parse((await t.candles(MINT, "1m", null, 500)).body);
  assert.equal(refused.candles.length, 1, "our one bar");
  assert.deepEqual([refused.src, refused.filling], ["chain", true], "short: its history refused");
  hist = { status: 503, body: '{"error":{"code":"upstream"}}' };
  assert.equal(JSON.parse((await t.candles(MINT, "1m", null, 500)).body).filling, true, "failed: filling");
  hist = { status: 200, body: JSON.stringify({ tf: "1m", candles: [], filling: true, src: "geckoterminal", as_of_ms: 1 }), src: "geckoterminal", asOfMs: 1 };
  assert.equal(JSON.parse((await t.candles(MINT, "1m", null, 500)).body).filling, true, "the history's own fill: filling");
  const first = refused.candles[0][0] as number;
  hist = { status: 200, body: JSON.stringify({ tf: "1m", candles: [[first - 120, "1", "1", "1", "1", "5"], [first - 60, "1", "1", "1", "1", "5"]], src: "geckoterminal", as_of_ms: TS * 1000 }), src: "geckoterminal", asOfMs: TS * 1000 };
  const full = JSON.parse((await t.candles(MINT, "1m", null, 500)).body);
  t.stop();
  assert.deepEqual([full.candles.length, full.src, full.filling], [3, "chain,geckoterminal", undefined]);
});

// card app-chart-check-inside-its-bound: live helper 207, 19 Nov 17:26-17:30Z, EHFrCL6p...pump had 7 signatures on
// public RPC and its trades answered whole_ms 0, yet its 1m chart (limit 300) said filling for 4 min 21 s: a tape that
// holds every trade from the mint's first signature asked the history anyway (its refusal said filling) and queued a read
// back of nothing behind other coins' (filling until its turn). The same coin with its read back to the first signature
// done is whole too, whatever the history answers.
test("card app-chart-check-inside-its-bound: a chart whose tape holds every trade from the mint's first signature is the coin's whole chart: no history asked, no read back, never filling, whatever the history answers (red at 0092e5692: filling while the history refused)", async () => {
  // its whole life: 3 signatures, every one read by the first walk
  const f = botFlood(3, () => true);
  let asked = 0;
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs: f.sigs, txs: f.txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => (asked++, { status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 30 }),
    tickMs: 0,
  });
  const tape = JSON.parse((await t.trades(MINT, 50)).body);
  await settle();
  assert.equal(JSON.parse((await t.trades(MINT, 50)).body).whole_ms, 0, "the tape: every trade from the first signature");
  asked = 0;
  const a = JSON.parse((await t.candles(MINT, "1m", null, 300)).body);
  await settle();
  const b = JSON.parse((await t.candles(MINT, "1m", null, 300)).body);
  t.stop();
  assert.ok(tape.trades.length > 0);
  assert.ok(a.candles.length > 0, "its bars");
  assert.deepEqual([a.filling, a.src, b.filling, asked], [undefined, "chain", undefined, 0], "whole: not filling, src chain, no history asked");
  assert.equal(f.asked.filter((l) => l === 1_000).length, 0, "no read back page asked");
});

test("card app-chart-check-inside-its-bound: a read back that reaches the mint's first signature leaves a whole chart: not filling once done, whatever the history answers; a walk that left a transaction unread is no whole chart (filling while the history refuses)", async () => {
  for (const unread of [false, true]) {
    // 40 successful signatures: the walk reads the newest 30, the read back the 10 before them, to the first
    const f = botFlood(40, () => true);
    const missing = f.list[5]!.signature;
    const txs = unread ? { ...f.txs, [missing]: null } : f.txs;
    const t = createSolanaTrades({
      fetch: rpcFetch({ sigs: f.sigs, txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }),
      now: () => TS * 1000,
      listed: async (m) => m === MINT,
      rpcs: ["https://rpc.test"],
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      history: async () => ({ status: 429, body: '{"error":{"code":"rate_limited"}}', retryAfterS: 30 }),
      tickMs: 0,
    });
    await t.trades(MINT, 50);
    await settle();
    let a = JSON.parse((await t.candles(MINT, "1m", null, 300)).body);
    assert.equal(a.filling, true, "reading back: filling");
    for (let i = 0; i < 50 && f.asked.filter((l) => l === 1_000).length === 0; i++) await settle();
    for (let i = 0; i < 10; i++) await settle();
    a = JSON.parse((await t.candles(MINT, "1m", null, 300)).body);
    t.stop();
    assert.equal(a.filling, unread ? true : undefined, unread ? "a transaction the walk left unread: still short while the history refuses" : "read back to the first signature: whole");
  }
});

// card app-chart-check-inside-its-bound: live helper 207, 19 Nov 17:26-17:30Z, ygq5gP...pump (10 trades before the
// walk's newest 30) said filling 3 min 18 s and EHFrCL...pump (an empty page to read back) 4 min 21 s: the read backs ran
// BACK_PARALLEL at once, each to its end (up to BACK_TX_MAX transactions), the rest queued behind them. Their lanes are
// now taken a step at a time (a signature page, a TX_PARALLEL chunk), in the order asked.
test("card app-chart-check-inside-its-bound: a small read back asked behind BACK_PARALLEL large ones is done while they still read: their lanes go a step at a time, in turn (red at 0092e5692: queued until one large read back ended)", async () => {
  const remint = (body: typeof BUY.result, mint: Buffer) => {
    const m = Buffer.from(b58decode(MINT)!);
    const logMessages = body.meta.logMessages.map((l) => {
      if (!l.startsWith("Program data: ")) return l;
      const b = Buffer.from(l.slice(14), "base64");
      const i = b.indexOf(m);
      if (i >= 0) mint.copy(b, i);
      return `Program data: ${b.toString("base64")}`;
    });
    return { ...body, meta: { ...body.meta, logMessages } };
  };
  const coin = (n: number, tag: string, body: unknown) => {
    const list = Array.from({ length: n }, (_, i) => ({ signature: `${tag}${String(i).padStart(5, "0")}`, slot: 465_000_000 - i, err: null }));
    return { list, txs: Object.fromEntries(list.map((x) => [x.signature, body])) };
  };
  const big = [1, 2].map((k) => {
    const bytes = Buffer.alloc(32, k + 10);
    return { mint: b58encode(bytes), ...coin(1_030, `big${k}`, remint(BUY.result, bytes)) };
  });
  const small = { mint: MINT, ...coin(31, "small", BUY.result) };
  const coins = [...big, small];
  const by = new Map(coins.map((c) => [c.mint, c]));
  const txs = Object.assign({}, ...coins.map((c) => c.txs)) as Record<string, unknown>;
  const base = rpcFetch({ sigs: () => [], txs, price: 9_342_267_796n, pub: TS, slot: 100 }, Object.fromEntries(coins.map((c) => [c.mint, 6])));
  const t = createSolanaTrades({
    fetch: async (url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
      if (req.method === "getSignaturesForAddress") {
        const c = by.get(req.params[0])!;
        const q = req.params[1];
        const from = q.before === undefined ? 0 : c.list.findIndex((s) => s.signature === q.before) + 1;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: c.list.slice(from, from + (q.limit as number)) }), { status: 200 });
      }
      // a large coin's transaction takes a few ms, as an RPC's does
      if (req.method === "getTransaction" && String(req.params[0]).startsWith("big")) await new Promise((r) => setTimeout(r, 3));
      return base(url, init);
    },
    now: () => TS * 1000,
    listed: async (m) => by.has(m),
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => ({ status: 404, body: '{"error":{"code":"not_found"}}' }),
    tickMs: 0,
  });
  const chart = async (m: string) => JSON.parse((await t.candles(m, "1m", null, 300)).body) as { filling?: boolean };
  for (const c of coins) await t.trades(c.mint, 50);
  await settle();
  // the two large read backs asked first, then the small one
  for (const c of big) assert.equal((await chart(c.mint)).filling, true);
  await settle();
  let s = await chart(small.mint);
  for (let i = 0; i < 100 && s.filling === true; i++) {
    await settle();
    s = await chart(small.mint);
  }
  const bigs = await Promise.all(big.map((c) => chart(c.mint)));
  t.stop();
  assert.equal(s.filling, undefined, "the small read back done");
  assert.deepEqual(bigs.map((x) => x.filling), [true, true], "while both large ones still read");
});

// card helper-listed-charts-own-reads round 3: a listed coin with no vendor bars charts from its own signatures read back.
// GTA6 (2gVNeu8d...pump), read 16 Nov 00:37Z: a month old, 1,557 trades a day on PumpSwap, GeckoTerminal names no top
// pool and its pool's OHLCV is empty, and the deployed helper answered 1 bar, src chain, not filling: our walk reads the
// newest COLD_SIGS transactions only. The recorded hour (315 trades in six minutes) stands in for its day: the history
// answers 404 (no pool), the walk holds the newest 30, and the read back takes the rest.
test("card helper-listed-charts-own-reads: a listed coin whose history answers 404 (GTA6's shape) reads its own signatures back: filling while it reads, then every minute of the recorded hour, src chain", async () => {
  const H = JSON.parse(gunzipSync(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.json.gz"))).toString()) as {
    mint: string; decimals: number; pyth: { slot: number; data: string }; txs: { sig: string; slot: number; err: boolean; logs?: string[] }[];
  };
  const p = Buffer.from(H.pyth.data, "base64");
  const pub = Number(p.readBigInt64LE(93));
  const list = H.txs.slice().reverse().map((x) => ({ signature: x.sig, slot: x.slot, err: x.err ? { InstructionError: [0, { Custom: 1 }] } : null }));
  const txs = Object.fromEntries(H.txs.filter((x) => !x.err).map((x) => [x.sig, { slot: x.slot, blockTime: blockOf(x.logs), meta: { logMessages: x.logs ?? [] } }]));
  const asked: Record<string, unknown>[] = [];
  const sigs = (q: Record<string, unknown>) => {
    asked.push(q);
    const from = q.before === undefined ? 0 : list.findIndex((s) => s.signature === q.before) + 1;
    return list.slice(from, from + (q.limit as number));
  };
  const t = createSolanaTrades({
    fetch: rpcFetch({ sigs, txs, price: p.readBigInt64LE(73), pub, slot: H.pyth.slot }, { [H.mint]: H.decimals }),
    now: () => pub * 1000,
    listed: async (m) => m === H.mint,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => ({ status: 404, body: '{"error":{"code":"not_found"}}' }),
    tickMs: 0,
  });
  const all = new Set(H.txs.filter((x) => !x.err).flatMap((x) => fromLogs(x.logs).trades).filter((x) => x.mint === H.mint).map((x) => Math.floor(x.ts / 60) * 60));
  const first = JSON.parse((await t.candles(H.mint, "1m", null, 500)).body);
  assert.equal(first.src, "chain");
  assert.ok(first.candles.length < all.size, `the walk's newest ${first.candles.length} minutes of ${all.size}`);
  assert.equal(first.filling, true, "its own signatures still being read back: filling, never a short chart as the coin's whole");
  let last = first;
  for (let i = 0; i < 50 && last.filling === true; i++) {
    await settle();
    last = JSON.parse((await t.candles(H.mint, "1m", null, 500)).body);
  }
  t.stop();
  assert.deepEqual([last.src, last.filling, last.candles.length], ["chain", undefined, all.size], "every minute that held a trade, read back to the coin's first signature");
  assert.deepEqual(last.candles.map((c: number[]) => c[0]), [...all].sort((a, b) => a - b));
  assert.ok(asked.some((q) => q.limit === 1_000 && q.before !== undefined), "read back in COLD_PAGE pages before the walk's oldest");
});

test("card helper-listed-charts-own-reads: a read back is bounded: BACK_TX_MAX transactions at most, and no page past BACK_SPAN_S; one read back per open token, never asked again once done", async () => {
  // 6,000 a second apart: BACK_TX_MAX; 60 s apart, the day ends past the walk's 30 at the 1,440th: its page (the second
  // of 1,000) is the last, 2,000 read back
  for (const [n, age, wantTx] of [[6_000, 1, BACK_TX_MAX], [6_000, 60, 2_000]] as const) {
    // n successful signatures, newest first, `age` seconds apart (blockTime as getSignaturesForAddress answers it)
    const f = botFlood(n, () => true);
    const timed = f.list.map((x, i) => ({ ...x, blockTime: TS - i * age }));
    const sigs = (q: Record<string, unknown>) => (f.sigs(q), timed.slice(q.before === undefined ? 0 : timed.findIndex((x) => x.signature === q.before) + 1).slice(0, q.limit as number));
    let tx = 0;
    const base = rpcFetch({ sigs, txs: f.txs, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
    const t = createSolanaTrades({
      fetch: async (url: string, init: RequestInit) => ((JSON.parse(String(init.body)) as { method: string }).method === "getTransaction" && tx++, base(url, init)),
      now: () => TS * 1000,
      listed: async (m) => m === MINT,
      rpcs: ["https://rpc.test"],
      source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
      history: async () => ({ status: 404, body: '{"error":{"code":"not_found"}}' }),
      tickMs: 0,
    });
    let a = JSON.parse((await t.candles(MINT, "1d", null, 500)).body);
    for (let i = 0; i < 400 && a.filling === true; i++) {
      await settle();
      a = JSON.parse((await t.candles(MINT, "1d", null, 500)).body);
    }
    const after = tx;
    await t.candles(MINT, "1d", null, 500);
    await settle();
    t.stop();
    assert.equal(a.filling, undefined, "done reading back");
    assert.ok(BACK_SPAN_S / 60 < COLD_SIGS + 2_000);
    assert.equal(after - COLD_SIGS, wantTx, `${n} signatures ${age} s apart: transactions read back`);
    assert.equal(tx, after, "a read back done is not asked again");
  }
});

test("card helper-listed-charts-own-reads: bars read back join ours, one bar where a bucket holds both (its open the older's, its close ours, high, low and volume of both)", () => {
  const older: [number, string, string, string, string, string][] = [[60, "1", "2", "1", "1.5", "10"], [120, "1.5", "3", "1.2", "2", "5.5"]];
  const ours: [number, string, string, string, string, string][] = [[120, "2.1", "2.5", "0.9", "2.4", "1.25"], [180, "2.4", "2.4", "2.4", "2.4", "1"]];
  assert.deepEqual(joinBars(older, ours), [[60, "1", "2", "1", "1.5", "10"], [120, "1.5", "3", "0.9", "2.4", "6.75"], [180, "2.4", "2.4", "2.4", "2.4", "1"]]);
  assert.deepEqual(joinBars([], ours), ours);
  assert.deepEqual(joinBars(older, []), older);
  assert.deepEqual(joinBars([[60, "1", "1", "1", "1", "1"]], [[120, "2", "2", "2", "2", "2"]]), [[60, "1", "1", "1", "1", "1"], [120, "2", "2", "2", "2", "2"]]);
});

test("card helper-listed-charts-own-reads: a transaction a read back cannot read (every provider failing, three times) ends it at the newest one, its older trades dropped: the bars read back have no hole", async () => {
  const H = JSON.parse(gunzipSync(readFileSync(path.join(HERE, "fixtures/sol-trades-hour.json.gz"))).toString()) as {
    mint: string; decimals: number; pyth: { slot: number; data: string }; txs: { sig: string; slot: number; err: boolean; logs?: string[] }[];
  };
  const p = Buffer.from(H.pyth.data, "base64");
  const pub = Number(p.readBigInt64LE(93));
  const list = H.txs.slice().reverse().map((x) => ({ signature: x.sig, slot: x.slot, err: x.err ? { InstructionError: [0, { Custom: 1 }] } : null }));
  const txs = Object.fromEntries(H.txs.filter((x) => !x.err).map((x) => [x.sig, { slot: x.slot, blockTime: blockOf(x.logs), meta: { logMessages: x.logs ?? [] } }]));
  const sigs = (q: Record<string, unknown>) => list.slice(q.before === undefined ? 0 : list.findIndex((s) => s.signature === q.before) + 1).slice(0, q.limit as number);
  // the successful transaction 200th from the newest never reads
  const lost = list.filter((x) => x.err === null)[200]!;
  const base = rpcFetch({ sigs, txs, price: p.readBigInt64LE(73), pub, slot: H.pyth.slot }, { [H.mint]: H.decimals });
  const t = createSolanaTrades({
    fetch: async (url: string, init: RequestInit) => (String(init.body).includes(lost.signature) ? new Response("down", { status: 503 }) : base(url, init)),
    now: () => pub * 1000,
    listed: async (m) => m === H.mint,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => ({ status: 404, body: '{"error":{"code":"not_found"}}' }),
    tickMs: 0,
  });
  let last = JSON.parse((await t.candles(H.mint, "1m", null, 500)).body);
  assert.equal(last.filling, true);
  for (let i = 0; i < 400 && last.filling !== undefined; i++) {
    await new Promise((r) => setTimeout(r, 25));
    last = JSON.parse((await t.candles(H.mint, "1m", null, 500)).body);
  }
  const tape = JSON.parse((await t.trades(H.mint, 50)).body);
  t.stop();
  assert.equal(last.filling, undefined, "the read back ended");
  // the volume of the bars is exactly every trade newer than the unread transaction in the signature list's order
  const at = list.findIndex((x) => x.signature === lost.signature);
  const newer = new Set(list.slice(0, at).map((x) => x.signature));
  const trades = H.txs.filter((x) => !x.err && newer.has(x.sig)).flatMap((x) => fromLogs(x.logs).trades).filter((x) => x.mint === H.mint);
  const solUsd = p.readBigInt64LE(73) * 10n ** 10n;
  const vol = trades.reduce((sum, x) => sum + (x.quote * solUsd) / 10n ** 9n, 0n);
  const scale = (v: string): bigint => BigInt(v.replace(".", "")) * 10n ** BigInt(18 - (v.split(".")[1]?.length ?? 0));
  assert.equal(last.candles.reduce((sum: bigint, c: string[]) => sum + scale(c[5]!), 0n), vol, "every trade newer than the unread one, none older");
  assert.ok(tape.trades.length > 0);
});

// card helper-listed-charts-own-reads round 3: a listed coin's first chart read waits on no read while bars are held.
// The warm live run of 16 Nov 00:33Z: Solana's listed charts p50 1,528 ms, p95 4,241 ms; a first read waited for its
// walk's first round (COLD_WAIT_MS 3 s) before the history's bars, held, were served.
test("card helper-listed-charts-own-reads: a listed coin's first chart read with its walk still reading answers the history's held bars at once, filling, then ours joined once the walk is in", async () => {
  let walked = false;
  let release = () => undefined as void;
  const gate = new Promise<void>((r) => (release = r));
  // a coin older than the walk: its newest COLD_SIGS signatures, the buy and 29 with no trade, not its first
  const older = noTrades(COLD_SIGS - 1, 465_000_000, "older");
  const fast = rpcFetch({ sigs: (p) => (p.before === undefined ? [{ signature: BUY.signature, slot: 465_000_000, err: null }, ...older.list] : []), txs: { [BUY.signature]: BUY.result, ...older.txs }, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  const held = [[TS - 7_200, "1", "1", "1", "1", "5"], [TS - 3_600, "1", "1", "1", "1", "5"]];
  const t = createSolanaTrades({
    fetch: async (url, init) => {
      if (JSON.parse(String(init.body)).method === "getSignaturesForAddress") await gate, (walked = true);
      return fast(url, init);
    },
    now: () => TS * 1000,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }),
    history: async () => ({ status: 200, body: JSON.stringify({ tf: "1h", candles: held, src: "coingecko", as_of_ms: TS * 1000 - 60_000 }), src: "coingecko", asOfMs: TS * 1000 - 60_000 }),
    // the first read's bound, as COLD_WAIT_MS is, 0.5 s here
    coldWait: () => new Promise((r) => setTimeout(r, 500)),
    tickMs: 0,
  });
  const first = JSON.parse((await t.candles(MINT, "1h", null, 500)).body);
  assert.equal(walked, false, "answered before the walk read a signature");
  assert.deepEqual([first.candles, first.src, first.filling], [held, "coingecko", true], "the history's held bars, filling while our walk reads");
  release();
  await settle();
  const next = JSON.parse((await t.candles(MINT, "1h", null, 500)).body);
  t.stop();
  assert.equal(next.src, "chain,coingecko");
  assert.equal(next.candles.length, 3, "the history's two and our walk's one");
});

// card token-stats-count-every-trade: the tape's reach (whole_ms), from which the page counts a window's buys, sells and
// volume. The 16 Nov reads it answers: BUMBA, a new pump.fun coin whose first walk lists every signature it has (reach 0,
// every window the tape's), and READ GAS's tape against a Jupiter row that lagged it.
test("card token-stats-count-every-trade: the first walk's reach: 0 from the mint's first signature, else the second after its oldest read or a transaction it could not read", async () => {
  const sigsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ signature: `s${i}`, slot: 465_000_100 - i, err: null, blockTime: TS - 100 - i }));
  const txs = (n: number, missing: number[] = []) => Object.fromEntries(sigsOf(n).filter((_, i) => !missing.includes(i)).map((x) => [x.signature, { ...BUY.result, slot: x.slot, blockTime: x.blockTime }]));
  const reach = async (c: Chain) => {
    const s = setup(c);
    await s.t.trades(MINT, 50);
    await settle();
    return (JSON.parse((await s.t.trades(MINT, 50)).body) as { whole_ms?: number }).whole_ms;
  };
  // BUMBA: five signatures, the whole list: every trade since the mint's first
  assert.equal(await reach({ sigs: () => sigsOf(5), txs: txs(5), price: 9_342_267_796n, pub: TS, slot: 100 }), 0);
  // a full first page (COLD_SIGS): every trade from the second after its oldest
  assert.equal(await reach({ sigs: (p) => (p.before === undefined ? sigsOf(COLD_SIGS) : []), txs: txs(COLD_SIGS), price: 9_342_267_796n, pub: TS, slot: 100 }), (TS - 100 - (COLD_SIGS - 1)) * 1000 + 1000);
  // the whole list, one transaction not read: a trade may be missing at its second, so the reach is past it
  assert.equal(await reach({ sigs: () => sigsOf(5), txs: txs(5, [3]), price: 9_342_267_796n, pub: TS, slot: 100 }), (TS - 103) * 1000 + 1000);
});

// card sol-tape-trader-is-the-events-user: the recorded pump-buy (a router 6Vo3 calling the pump.fun curve, its
// TradeEvent at log line 31) with a second swap of the curve made by the curve's own program inside the trader's buy:
// the shape of Base tx 0xa1782de0 (a v4 pool's hook selling its fees in its own pool inside the trader's sell, card
// market-reads-hold-under-load), on the Solana venue whose real transaction the fixture copies. No decoded venue does
// this on mainnet today; the next one may.
const OWN_USER = new Uint8Array(32).fill(7); // the program's own account (a PDA in a real one)
/** The recorded buy's event, turned into a sell of a tenth of its legs by `user`. */
function ownSell(user: Uint8Array): string {
  const line = BUY.result.meta.logMessages[31]!;
  const b = Buffer.from(line.slice("Program data: ".length), "base64");
  b.writeBigUInt64LE(b.readBigUInt64LE(8 + 32) / 10n, 8 + 32); // sol_amount
  b.writeBigUInt64LE(b.readBigUInt64LE(8 + 40) / 10n, 8 + 40); // token_amount
  b[8 + 48] = 0; // is_buy: a sell
  Buffer.from(user).copy(b, 8 + 49); // user
  return `Program data: ${b.toString("base64")}`;
}
const PUMP_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** The curve's own sell, invoked by the curve at `depth`, its event sent to itself as Anchor's event CPI. */
const ownFrame = (depth: number, user: Uint8Array) => [
  `Program ${PUMP_ID} invoke [${depth}]`,
  "Program log: Instruction: Sell",
  ownSell(user),
  `Program ${PUMP_ID} invoke [${depth + 1}]`,
  `Program ${PUMP_ID} consumed 2170 of 200000 compute units`,
  `Program ${PUMP_ID} success`,
  `Program ${PUMP_ID} consumed 40000 of 250000 compute units`,
  `Program ${PUMP_ID} success`,
];

test("card sol-tape-trader-is-the-events-user: a swap the venue's own program makes inside the trader's swap is off the tape and in the bars; each row is named by its own event's user", async () => {
  const logs = BUY.result.meta.logMessages;
  // nested: the curve's own sell inside the curve's frame of the trader's buy (before the curve's own end, line 35)
  const nested = [...logs.slice(0, 35), ...ownFrame(3, OWN_USER), ...logs.slice(35)];
  assert.deepEqual(fromLogs(logs).truncated, false);
  assert.deepEqual(fromLogs(nested).truncated, false, "a well-formed invoke stack");
  // apart: the same sell as its own instruction after the router's (one transaction, two traders, as two signers make it)
  const apart = [...logs.slice(0, 39), ...ownFrame(1, OWN_USER), ...logs.slice(39)];
  const run = async (lines: string[]) => {
    const s = setup({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 });
    await s.t.trades(MINT, 50);
    s.on().note(MINT, { sig: BUY.signature, slot: 465_000_000, err: false, logs: lines });
    await settle();
    const bars = JSON.parse((await s.t.candles(MINT, "1s", null, 10)).body) as { candles: [number, string, string, string, string, string][] };
    return { rows: (await tape(s.t)).trades, bars: bars.candles };
  };
  const one = await run(nested);
  // one trade: the trader's buy, named by its event's user
  assert.deepEqual(one.rows, [{ t_ms: TS * 1000, side: "b", usd: "9.18540990521034652", amt: "2156510.335886", trader: "4ZvukwqXc2AFAHcuvW8VrKD9j3zGHuoqW4hvEQfANH2n", tx: BUY.signature }]);
  const two = await run(apart);
  // two traders' trades, each named by its own event's user, never the transaction's first
  assert.deepEqual(two.rows.map((r) => [r.side, r.trader]), [["s", b58encode(OWN_USER)], ["b", "4ZvukwqXc2AFAHcuvW8VrKD9j3zGHuoqW4hvEQfANH2n"]]);
  // the bars hold the program's own swap, price and volume both: the same bars as when it is a trader's
  assert.deepEqual(one.bars, two.bars);
  assert.notEqual(one.bars[0]![5], "9.18540990521034652", "the own swap's volume is in the bar");
});

// card index-sol-trades-2: the Meteora venues (fixtures/sol-meteora-txs.json, recorded mainnet). Their events are in the
// inner instructions only, so a stream transaction whose log names one running is read whole; a walk reads it whole
// anyway. Each pool is read from its own program (a DBC pool and its config both).
const MT = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-meteora-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: Record<string, unknown> & { slot: number; meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
const MTS = 1795011900;
function meteoraChain(mints: Record<string, number>, opts: { sigs?: (p: Record<string, unknown>) => unknown[]; pools?: Record<string, { owner: string; data: string }>; quoteUsd?: (m: string) => Promise<string | null> } = {}) {
  const pools = { ...MT.pools, ...opts.pools };
  const txs = Object.fromEntries(Object.values(MT.txs).map((x) => [x.signature, x.result]));
  const reads: string[] = [];
  const inner = rpcFetch({ sigs: opts.sigs ?? (() => []), txs, price: 9_342_267_796n, pub: MTS, slot: 100 }, mints);
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
    reads.push(`${req.method} ${req.params[0]}`);
    const p = pools[req.params[0]];
    if (req.method === "getAccountInfo" && p !== undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner: p.owner, data: [p.data, "base64"] } } }));
    // a route's other pools (dlmm-buy's PumpSwap hop) not recorded: no such account
    if (req.method === "getAccountInfo" && req.params[0] !== PYTH_SOL_USD && !(req.params[0] in mints)) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: null } }));
    return inner(url, init);
  };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({ fetch: fetchFn, now: () => MTS * 1000, listed: async (m) => m in mints, rpcs: ["https://rpc.test"], wholeWait: () => Promise.resolve(), source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), quoteUsd: opts.quoteUsd, tickMs: 0 });
  const rows = async (m: string) => (JSON.parse((await t.trades(m, 50)).body) as { trades: { t_ms: number; side: string; usd: string; amt: string; trader: string | null; tx: string }[] }).trades;
  const stream = (m: string, k: string) => withClock(on!).note(m, { sig: MT.txs[k]!.signature, slot: MT.txs[k]!.result.slot, err: false, logs: MT.txs[k]!.result.meta.logMessages });
  return { t, rows, stream, reads };
}
const TTW_MINT = "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo";
const MOON = "8HuYsEpBS2WZACBCbAKcoh8XmbNYYqRjoJrCqC3Cmoon";
const C467 = "467cTkm8GXBA96QDGG5Spm1WbpVHp2LnPA1VAcrMctem";
const C26E = "26Ekp9mYjJS3CjFMHKkuTS4uP75oysve4A4c8CPeayBG";

test("card index-sol-trades-2: a Meteora coin's stream trades (DLMM, DBC, DAMM v2) reach its tape and bars from the transaction's inner instructions, each pool read from its own program", async () => {
  const c = meteoraChain({ [TTW_MINT]: 6, [MOON]: 6, [C467]: 6 });
  for (const m of [TTW_MINT, MOON, C467]) assert.equal((await c.t.trades(m, 50)).status, 200);
  c.stream(TTW_MINT, "dlmm-buy");
  c.stream(MOON, "dbc-buy-usdc");
  c.stream(C467, "damm-sell");
  await settle();
  // DLMM: 0.8 SOL at 93.42267796 USD for 0.276952 TTW (the pool's X), dated by its block (the event has no clock)
  assert.deepEqual(await c.rows(TTW_MINT), [{ t_ms: 1795011852_000, side: "b", usd: "74.738142368", amt: "0.276952", trader: "GPCp5rTs2j6PQG51cUBRejspiQW3VMY1T4BUDY9vZBPY", tx: MT.txs["dlmm-buy"]!.signature }]);
  // DBC: 4.846455 USDC (its config's quote) for 140,195.474297 of the pool's base, dated by its block (its event's clock
  // the same second)
  assert.deepEqual(await c.rows(MOON), [{ t_ms: 1795011854_000, side: "b", usd: "4.846455", amt: "140195.474297", trader: null, tx: MT.txs["dbc-buy-usdc"]!.signature }]);
  // DAMM v2: the token is the pool's B, so the trade told as SOL (A) sees it is turned round: a sell of 2,340,517.796257
  // for 0.698738224 SOL, dated by its block 1795011891, never its event's own clock a second before (card
  // helper-sol-tape-checks-hold: the recorded event names 1795011890)
  assert.deepEqual(await c.rows(C467), [{ t_ms: 1795011891_000, side: "s", usd: "65.27799607909434304", amt: "2340517.796257", trader: null, tx: MT.txs["damm-sell"]!.signature }]);
  for (const m of [TTW_MINT, MOON, C467]) assert.equal((JSON.parse((await c.t.candles(m, "1s", null, 10)).body) as { candles: unknown[] }).candles.length, 1, m);
  // each transaction read whole once; each pool (and the DBC pool's config) read once
  for (const k of ["dlmm-buy", "dbc-buy-usdc", "damm-sell"]) assert.equal(c.reads.filter((r) => r === `getTransaction ${MT.txs[k]!.signature}`).length, 1, k);
  for (const a of ["E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN", "2vHhAP3Z2uVHvjeSgDPrckXsmYByd7hGzVuK5UQ6ucMV", "FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM", "4Fk2beWHZ3DYn8cLkRs31dP6eTw7Vwpq7kNDSNvW8dWz"]) assert.equal(c.reads.filter((r) => r === `getAccountInfo ${a}`).length, 1, a);
  c.t.stop();
});

test("card index-sol-trades-2: a Meteora coin's first walk reads its trades from each transaction's inner instructions", async () => {
  const sig = MT.txs["damm-buy"]!.signature;
  const c = meteoraChain({ [C26E]: 6 }, { sigs: () => [{ signature: sig, slot: MT.txs["damm-buy"]!.result.slot, err: null, blockTime: 1795011890 }] });
  await c.t.trades(C26E, 50);
  await settle();
  // 1.37241791 SOL for 164,412.686233 of the pool's A
  assert.deepEqual(await c.rows(C26E), [{ t_ms: 1795011890_000, side: "b", usd: "128.2149564324662636", amt: "164412.686233", trader: null, tx: sig }]);
  c.t.stop();
});

test("card index-sol-trades-2: a Meteora coin quoted in another coin is priced at that coin's USD price; a config another program owns gives no trade", async () => {
  // the recorded DLMM pool with its Y named another coin (QCOIN, 9 decimals, 2 USD)
  const QCOIN = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
  const lb = Buffer.from(MT.pools["E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN"]!.data, "base64");
  keyInto(QCOIN, lb, 120);
  const c = meteoraChain({ [TTW_MINT]: 6, [QCOIN]: 9 }, { pools: { E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN: { owner: MT.pools["E8NTyKJzdaTHSftbkEZPHQ1a32s58z2bR5jZ7WxAFnWN"]!.owner, data: lb.toString("base64") } }, quoteUsd: async (m) => (m === QCOIN ? "2" : null) });
  await c.t.trades(TTW_MINT, 50);
  c.stream(TTW_MINT, "dlmm-buy");
  await settle();
  // 0.8 QCOIN at 2 USD for 0.276952 TTW
  assert.deepEqual((await c.rows(TTW_MINT)).map((r) => [r.side, r.usd, r.amt]), [["b", "1.6", "0.276952"]]);
  c.t.stop();
  // the DBC config answered as another program's account: no pair, no trade
  const cfg = MT.pools["FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM"]!;
  const f = meteoraChain({ [MOON]: 6 }, { pools: { FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM: { owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", data: cfg.data } } });
  await f.t.trades(MOON, 50);
  f.stream(MOON, "dbc-buy-usdc");
  await settle();
  assert.deepEqual(await f.rows(MOON), []);
  f.t.stop();
});
/** Writes a base58 key's 32 bytes into `b` at `o`. */
function keyInto(k: string, b: Buffer, o: number): void {
  let n = 0n;
  for (const ch of k) n = n * 58n + BigInt("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(ch));
  Buffer.from(n.toString(16).padStart(64, "0"), "hex").copy(b, o);
}

// card sol-tape-in-order: a busy coin's tape is newest first by its blocks' times. Recorded mainnet (fixtures/sol-tape-
// order.json): TTWO's two transactions in slot 471007315 (block time 1795020581 on api.mainnet-beta and publicnode), an
// Orca buy whose event has no clock, then a DLMM sell read whole. The deployed helper c775de255 dated the Orca row by the
// second the stream sent it (1795020583) and the DLMM row by its block: "trade 29 is newer than trade 28" at 16:49:43Z.
// The DLMM transaction's two addressTableLookups are left out (gitleaks reads their accountKey field as a key; the
// decoder reads the addresses they load from meta.loadedAddresses, kept).
const TO = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-tape-order.json"), "utf8")) as { txs: Record<string, { signature: string; result: Record<string, unknown> & { slot: number; blockTime: number; meta: { logMessages: string[] } } }>; pools: Record<string, { owner: string; data: string }> };
const TO_SLOT = 471007315;
const TO_BLOCK = 1795020581;
function orderChain(opts: { sigs?: (p: Record<string, unknown>) => unknown[]; txs?: Record<string, unknown>; blockTimes?: Record<number, number>; noHistory?: boolean } = {}) {
  const txs = { ...Object.fromEntries(Object.values(TO.txs).map((x) => [x.signature, x.result])), ...opts.txs };
  const reads: string[] = [];
  let nowMs = (TO_BLOCK + 2) * 1000; // the stream's note arrives 2 s after its block, as measured from the helper
  const inner = rpcFetch({ sigs: opts.sigs ?? (() => []), txs, price: 9_342_267_796n, pub: TO_BLOCK, slot: 100 }, { [TTW_MINT]: 6 });
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { method: string; params: [string | number] };
    reads.push(`${req.method} ${req.params[0]}`);
    if (req.method === "getBlockTime") {
      const t = opts.blockTimes?.[req.params[0] as number];
      return new Response(JSON.stringify(t === undefined ? { jsonrpc: "2.0", id: 1, error: { code: -32009, message: "slot skipped" } } : { jsonrpc: "2.0", id: 1, result: t }));
    }
    const p = TO.pools[req.params[0] as string];
    if (req.method === "getAccountInfo" && p !== undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: { owner: p.owner, data: [p.data, "base64"] } } }));
    // any other account: no such account (the routes' PumpSwap pools are recorded: a pool answered with none leaves its
    // transaction unread, card sol-tape-pool-unread-never-kept)
    if (req.method === "getAccountInfo" && req.params[0] !== PYTH_SOL_USD && req.params[0] !== TTW_MINT) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 100 }, value: null } }));
    return inner(url, init);
  };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({ fetch: fetchFn, now: () => nowMs, listed: async (m) => m === TTW_MINT, rpcs: ["https://rpc.test"], wholeWait: () => Promise.resolve(), source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), ...(opts.noHistory ? { history: async () => ({ status: 404, body: '{"error":{"code":"not_found"}}' }) } : {}), tickMs: 0 });
  const rows = async () => (JSON.parse((await t.trades(TTW_MINT, 50)).body) as { trades: { t_ms: number; tx: string }[] }).trades;
  const stream = (k: string) => on!.note(TTW_MINT, { sig: TO.txs[k]!.signature, slot: TO.txs[k]!.result.slot, err: false, logs: TO.txs[k]!.result.meta.logMessages });
  return { t, rows, stream, reads, on: () => on!, at: (ms: number) => void (nowMs = ms) };
}
/** Newest first: no row dated after the row above it. */
const inOrder = (rows: { t_ms: number }[]): boolean => rows.every((r, i) => i === 0 || r.t_ms <= rows[i - 1]!.t_ms);

test("card sol-tape-in-order: a stream trade whose event has no clock is dated by its block's clock, so it merges into a held tape in order (red at c775de255: dated by its arrival, 2 s late, above a DLMM row of its own block)", async () => {
  const c = orderChain();
  await c.t.trades(TTW_MINT, 50);
  // the stream's Clock sysvar names the slot's clock (absent before this card: the note was dated by its arrival)
  c.on().clock?.(TO_SLOT, TO_BLOCK);
  c.stream("orca-older");
  c.stream("dlmm-newer");
  await settle();
  const rows = await c.rows();
  assert.deepEqual(rows.map((r) => [r.tx, r.t_ms]), [[TO.txs["dlmm-newer"]!.signature, TO_BLOCK * 1000], [TO.txs["orca-older"]!.signature, TO_BLOCK * 1000]]);
  assert.ok(inOrder(rows));
  // the Orca trade carried in the log needs no read of its transaction; the DLMM one is read whole once
  assert.equal(c.reads.filter((r) => r.startsWith("getTransaction")).length, 1);
  assert.equal(c.reads.filter((r) => r.startsWith("getBlockTime")).length, 0);
  c.t.stop();
});

test("card sol-tape-in-order: a stream trade whose slot's clock the stream did not send (a later slot's came) is dated by the slot's block time read once, never by its arrival (red at c775de255)", async () => {
  const c = orderChain({ blockTimes: { [TO_SLOT]: TO_BLOCK } });
  await c.t.trades(TTW_MINT, 50);
  c.on().clock?.(TO_SLOT + 1, TO_BLOCK);
  c.stream("orca-older");
  c.stream("dlmm-newer");
  await settle();
  const rows = await c.rows();
  assert.deepEqual(rows.map((r) => r.t_ms), [TO_BLOCK * 1000, TO_BLOCK * 1000]);
  assert.equal(c.reads.filter((r) => r === `getBlockTime ${TO_SLOT}`).length, 1, "the slot's block time read once");
  c.t.stop();
});

test("card sol-tape-in-order: a walk's transaction answered with no block time, its signature listed with none, is dated by its slot's block time, never by the walk's clock (red at c775de255: dated now)", async () => {
  const orca = TO.txs["orca-older"]!;
  const c = orderChain({
    sigs: (p) => (p.before === undefined ? [{ signature: orca.signature, slot: TO_SLOT, err: null }] : []),
    txs: { [orca.signature]: { ...orca.result, blockTime: null } },
    blockTimes: { [TO_SLOT]: TO_BLOCK },
  });
  c.on().clock?.(TO_SLOT + 1, TO_BLOCK);
  await c.t.trades(TTW_MINT, 50);
  await settle();
  assert.deepEqual((await c.rows()).map((r) => [r.tx, r.t_ms]), [[orca.signature, TO_BLOCK * 1000]]);
  c.t.stop();
});

test("card sol-tape-in-order: a read back's transaction answered with no block time, its signature listed with none, is dated by its slot's block time: its bar is its own minute, never the read's (red at c775de255: the minute it was read)", async () => {
  const orca = TO.txs["orca-older"]!;
  const dlmm = TO.txs["dlmm-newer"]!;
  // the walk holds the DLMM trade (its page full with 29 that hold no trade, so not the mint's first); the read back
  // before them finds the Orca one, answered with no block time
  const older = noTrades(COLD_SIGS - 1, TO_SLOT + 1, "quiet");
  const oldest = older.list.at(-1)!.signature;
  const c = orderChain({
    sigs: (p) => (p.before === undefined ? [{ signature: dlmm.signature, slot: TO_SLOT, err: null, blockTime: TO_BLOCK }, ...older.list.map((x) => ({ ...x, slot: TO_SLOT, blockTime: TO_BLOCK }))] : p.before === oldest ? [{ signature: orca.signature, slot: TO_SLOT, err: null }] : []),
    txs: { [orca.signature]: { ...orca.result, blockTime: null }, ...Object.fromEntries(Object.entries(older.txs).map(([k, v]) => [k, { ...v, slot: TO_SLOT }])) },
    blockTimes: { [TO_SLOT]: TO_BLOCK },
    noHistory: true,
  });
  c.at((TO_BLOCK + 90) * 1000); // read a minute and a half after the block, the Pyth price still in force
  c.on().clock?.(TO_SLOT + 300, TO_BLOCK + 90);
  const t = c.t;
  let bars = JSON.parse((await t.candles(TTW_MINT, "1m", null, 500)).body) as { candles: [number, ...string[]][]; filling?: boolean };
  for (let i = 0; i < 100 && bars.filling === true; i++) {
    await settle();
    bars = JSON.parse((await t.candles(TTW_MINT, "1m", null, 500)).body);
  }
  t.stop();
  assert.equal(bars.filling, undefined, "read back");
  // one bar, the block's minute, holding both trades: the walk's DLMM sell (1.010003 USD) and the read back's Orca buy
  // (1.158187 USD, the stream test's rows); misdated by the read's minute, the read back's bar fell after ours and was
  // not joined: 1.010003 alone
  assert.deepEqual(bars.candles.map((b) => [b[0], b[5]]), [[TO_BLOCK - (TO_BLOCK % 60), "2.16819"]], "both trades in their block's minute");
});

test("card sol-tape-in-order: the stream subscribes the Clock sysvar at confirmed and passes on each slot's clock, taken only whole: the sysvar program as owner, 40 bytes, the slot its context's", () => {
  type W = { sent: string[]; onopen: (() => void) | null; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send(s: string): void; close(): void };
  let w: W | null = null;
  const clocks: [number, number][] = [];
  const src = wsSource("wss://stream.test", { note: () => undefined, down: () => undefined, up: () => undefined, clock: (s, t) => void clocks.push([s, t]) }, {
    ws: () => (w = { sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => void w!.sent.push(s), close: () => undefined }),
  });
  void src.watch(MINT).catch(() => undefined);
  w!.onopen!();
  const sub = w!.sent.map((s) => JSON.parse(s) as { id: number; method: string; params?: unknown[] }).find((m) => m.method === "accountSubscribe")!;
  assert.deepEqual(sub.params, [SYSVAR_CLOCK, { encoding: "base64", commitment: "confirmed" }]);
  w!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: sub.id, result: 77 }) });
  /** A Clock account at `slot` with unix time `t`. */
  const body = (slot: number, t: number, len = 40) => {
    const b = Buffer.alloc(len);
    b.writeBigUInt64LE(BigInt(slot), 0);
    if (len >= 40) b.writeBigInt64LE(BigInt(t), 32);
    return b.toString("base64");
  };
  const note = (subscription: number, ctx: number, owner: string, data: string) => w!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription, result: { context: { slot: ctx }, value: { owner, data: [data, "base64"] } } } }) });
  const SYSVAR = "Sysvar1111111111111111111111111111111111111";
  note(77, TO_SLOT, SYSVAR, body(TO_SLOT, TO_BLOCK));
  note(77, TO_SLOT + 1, "SomeoneElse1111111111111111111111111111111", body(TO_SLOT + 1, TO_BLOCK + 9)); // not the sysvar's
  note(77, TO_SLOT + 2, SYSVAR, body(TO_SLOT + 2, TO_BLOCK + 9, 32)); // short
  note(77, TO_SLOT + 4, SYSVAR, body(TO_SLOT + 3, TO_BLOCK + 9)); // another slot than its context's
  note(78, TO_SLOT + 5, SYSVAR, body(TO_SLOT + 5, TO_BLOCK + 9)); // another subscription
  note(77, TO_SLOT + 6, SYSVAR, body(TO_SLOT + 6, 0)); // no time
  assert.deepEqual(clocks, [[TO_SLOT, TO_BLOCK]]);
  src.close();
});

// card helper-sol-tape-checks-hold: a trade is dated by its block, an event's own clock included. The clock a pump.fun,
// PumpSwap, DBC or DAMM v2 event carries is a second before its block in some slots (read on mainnet 20 Nov: slot
// 471386582's DAMM v2 and DBC events name 1795102226, its block time 1795102227 on api.mainnet-beta and publicnode;
// slot 471614249's PumpSwap event 1795151265, the stream's Clock sysvar and getBlockTime 1795151266), and the live
// helper f5639e5bb dated those by their event and the rest by their block: a coin's tape held a later row a second
// below an older one ("trade 31 is newer than trade 30", index-sol-trades, 20 Nov 03:15Z).
test("card helper-sol-tape-checks-hold: a stream trade whose event's clock is a second before its block is dated by its block (the slot's clock the stream sent), its row and its 1s bar (red at f5639e5bb: its event's second)", async () => {
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({ fetch: rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 }), now: () => TS * 1000, listed: async (m) => m === MINT, rpcs: ["https://rpc.test"], source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
  await t.trades(MINT, 50);
  assert.equal(fromLogs(BUY.result.meta.logMessages).trades[0]!.ts, TS, "the recorded event names TS");
  on!.clock(465_000_000, TS + 1);
  on!.note(MINT, { sig: BUY.signature, slot: 465_000_000, err: false, logs: BUY.result.meta.logMessages });
  await settle();
  assert.deepEqual((await tape(t)).trades.map((r) => [r.tx, r.t_ms]), [[BUY.signature, (TS + 1) * 1000]]);
  assert.deepEqual((JSON.parse((await t.candles(MINT, "1s", null, 10)).body) as { candles: [number][] }).candles.map((c) => c[0]), [TS + 1]);
  t.stop();
});

test("card helper-sol-tape-checks-hold: a walk's transaction whose event's clock is a second before its block time is dated by its block time (red at f5639e5bb: its event's second)", async () => {
  const s = setup({ sigs: (p) => (p.before === undefined ? [{ signature: BUY.signature, slot: 465_000_000, err: null, blockTime: TS + 1 }] : []), txs: { [BUY.signature]: { ...BUY.result, blockTime: TS + 1 } }, price: 9_342_267_796n, pub: TS, slot: 100 });
  await s.t.trades(MINT, 50);
  await settle();
  assert.deepEqual((await tape(s.t)).trades.map((r) => [r.tx, r.t_ms]), [[BUY.signature, (TS + 1) * 1000]]);
  s.t.stop();
});

// card helper-sol-tape-checks-hold: a tape's date (as_of_ms, the route's X-Fetched-At) is its last fold. A live tape is
// folded every tick; a cold one only at its walk's rounds and the stream's notes, so a quiet coin whose first walk waits
// on a slow read answered rows dated by its last round while the stream held it current (live helper f5639e5bb, 20 Nov
// 03:15Z: GM8EysYT's DLMM tape "X-Fetched-At 03:14:52.003Z", past 15 s at the read).
test("card helper-sol-tape-checks-hold: a tape whose walk waits on a read (its first, or a gap's after a drop) is dated by the tick while the stream is heard, never by its last round; with the stream silent or down, by its last fold (red at f5639e5bb: dated by its open)", async () => {
  const clock = { t: TS * 1000 };
  let gate: Promise<void> | null = null;
  let release = () => undefined as void;
  const chain = rpcFetch({ sigs: () => [], txs: {}, price: 9_342_267_796n, pub: TS, slot: 100 }, { [MINT]: 6 });
  let heard: { at: number; slot: number | null } | null = { at: clock.t, slot: 100 };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({
    fetch: async (url, init) => {
      if (String(init.body).includes("getSignaturesForAddress") && gate !== null) await gate;
      return chain(url, init);
    },
    now: () => clock.t,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined, heard: () => heard }),
    tickMs: 0,
    coldWait: () => settle(),
  });
  gate = new Promise<void>((r) => (release = r));
  const asOf = async () => (JSON.parse((await t.trades(MINT, 50)).body) as { as_of_ms: number; filling?: boolean });
  const first = await asOf();
  assert.equal(first.as_of_ms, TS * 1000);
  assert.equal(first.filling, true, "its walk still reads");
  // 20 s on, the walk's signature read still waiting, the stream heard a moment ago
  clock.t += 20_000;
  heard = { at: clock.t - 200, slot: 150 };
  t.tick();
  assert.equal((await asOf()).as_of_ms, clock.t, "dated by the tick while the stream holds it current");
  // the stream silent past SOL_BEHIND_MS: the tape is dated by its last fold, never moved on
  const held = clock.t;
  clock.t += 20_000;
  t.tick();
  assert.equal((await asOf()).as_of_ms, held, "a silent stream moves no date");
  // the walk done; then the stream drops (no date moves while it is down) and comes back, its gap's walk waiting
  gate = null;
  release();
  heard = { at: clock.t, slot: 160 };
  await settle();
  t.tick();
  assert.equal((await asOf()).filling, undefined, "the first walk done");
  gate = new Promise<void>((r) => (release = r));
  on!.down();
  heard = null;
  const down = clock.t;
  clock.t += 20_000;
  t.tick();
  assert.equal((await asOf()).as_of_ms, down, "a dropped stream moves no date");
  heard = { at: clock.t, slot: 210 };
  on!.up();
  await settle();
  clock.t += 20_000;
  heard = { at: clock.t - 100, slot: 260 };
  t.tick();
  const back = await asOf();
  assert.equal(back.filling, true, "its gap still walked");
  assert.equal(back.as_of_ms, clock.t, "dated by the tick while the stream is heard again");
  gate = null;
  release();
  t.stop();
});
