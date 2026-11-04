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
import { createSolanaTrades, PYTH_RECEIVER, PYTH_SOL_USD, pythSolUsd, wsSource, type Note, type SourceEvents } from "./trades.ts";

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
  return { t, on: () => on!, watched, note };
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
  for (const x of H.txs) on!.note(H.mint, { sig: x.sig, slot: x.slot, err: x.err, logs: x.logs ?? [] });
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

test("the websocket source: up only once every subscription is in force; a close is a drop, then reconnect, resubscribe, up", async () => {
  type Fake = { sent: string[]; onopen: (() => void) | null; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send(s: string): void; close(): void };
  const sockets: Fake[] = [];
  const events: string[] = [];
  const src = wsSource("wss://test", { note: (m, n) => events.push(`note ${m} ${n.sig}`), down: () => events.push("down"), up: () => events.push("up") }, {
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
  const n = (m: string, sig: string, slot: number) => on!.note(m, { sig, slot, err: false, logs: SWAP.result.meta.logMessages });
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
  return { t, on: () => on!, note, hold, walks: () => walks, release: () => ((gate = null), release()) };
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
  // app live run 41787804457 (4 Nov 06:49Z): wNEAR (listed, no curve trades) answered 200 "chain" with no bars
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
