// node --test apps/helper/src/data/solana/trades-behind-head.test.ts: card every-tape-and-chart-says-filling-behind-the-
// head. A Solana tape is served complete (no `filling`, its `whole_ms`) and a live chart current only while the stream
// that carries the token is heard within SOL_BEHIND_MS and no dropped stream's gap is being walked; otherwise both say
// filling, with what they hold, and name the slot they hold (Server-Timing sol-read-to). Before the card a stream
// silent up to SILENT_MS (30 s) and a whole refill were served as current, the Base and Robinhood rule
// (../evm/swaps.ts BEHIND_MAX) the same rule here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSolanaTrades, PYTH_RECEIVER, PYTH_SOL_USD, SOL_BEHIND_MS, type SourceEvents } from "./trades.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(readFileSync(path.join(HERE, "fixtures/sol-trades-txs.json"), "utf8")) as { txs: Record<string, { signature: string; result: { slot: number; meta: { logMessages: string[] } } }> };
const BUY = F.txs["pump-buy"]!;
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const TS = 1793739241;
const FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

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
function mintData(decimals: number): Buffer {
  const b = Buffer.alloc(82);
  b[44] = decimals;
  b[45] = 1;
  return b;
}
/** Five signatures, the mint's whole list (reach 0), each the recorded pump.fun buy. */
const SIGS = Array.from({ length: 5 }, (_, i) => ({ signature: `s${i}`, slot: 465_000_100 - i, err: null, blockTime: TS - 100 - i }));
const rpc = async (_url: string, init: RequestInit): Promise<Response> => {
  const req = JSON.parse(String(init.body)) as { method: string; params: [string, Record<string, unknown>] };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  const acct = (owner: string, data: Buffer) => ok({ context: { slot: 100 }, value: { owner, data: [data.toString("base64"), "base64"] } });
  if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return acct(PYTH_RECEIVER, pyth(9_342_267_796n, TS));
  if (req.method === "getAccountInfo" && req.params[0] === MINT) return acct("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mintData(6));
  if (req.method === "getSignaturesForAddress") return ok(req.params[1].until === undefined ? SIGS : []);
  if (req.method === "getTransaction") {
    const s = SIGS.find((x) => x.signature === req.params[0]);
    return ok(s === undefined ? null : { ...BUY.result, slot: s.slot, blockTime: s.blockTime });
  }
  throw new Error(`unexpected ${req.method}`);
};
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The trades on a stream the test hears (`heard`: its last message and slot, null while it is down). */
function setup() {
  const clock = { ms: TS * 1000 };
  const st: { heard: { at: number; slot: number | null } | null } = { heard: { at: clock.ms, slot: 465_000_200 } };
  let on: SourceEvents | null = null;
  const t = createSolanaTrades({
    fetch: rpc as never,
    now: () => clock.ms,
    listed: async (m) => m === MINT,
    rpcs: ["https://rpc.test"],
    source: (o) => ((on = o), { watch: async () => undefined, unwatch: () => undefined, close: () => undefined, heard: () => st.heard }),
    tickMs: 0,
  });
  return { t, clock, st, on: () => on! };
}
type Ans = { tape: { trades: { tx: string }[]; filling?: true; whole_ms?: number; as_of_ms: number }; chart: { candles: unknown[]; filling?: true }; page: { filling?: true }; timing: string };
async function read(t: ReturnType<typeof createSolanaTrades>): Promise<Ans> {
  const a = await t.trades(MINT, 50);
  const c = await t.candles(MINT, "1s", null, 2);
  const p = await t.candles(MINT, "1s", TS, 2);
  return { tape: JSON.parse(a.body), chart: JSON.parse(c.body), page: JSON.parse(p.body), timing: a.timing ?? "" };
}

test(`a Solana tape and live chart whose stream is unheard past ${SOL_BEHIND_MS} ms say filling, never current: at the bound current, past it filling with what they hold; heard again, current`, async () => {
  const s = setup();
  try {
    await s.t.trades(MINT, 50);
    await settle();
    const first = await read(s.t);
    assert.equal(first.tape.filling, undefined, `heard now: complete ${JSON.stringify(first.tape).slice(0, 160)}`);
    assert.equal(first.tape.whole_ms, 0, "with its reach");
    assert.equal(first.chart.filling, undefined, "the live chart current");
    assert.ok(first.chart.candles.length > 0);
    assert.match(first.timing, /sol-read-to;desc="slot \d+ of head 465000200, heard 0 s ago"/, first.timing);

    s.clock.ms += SOL_BEHIND_MS;
    const edge = await read(s.t);
    assert.equal(edge.tape.filling, undefined, `${SOL_BEHIND_MS} ms unheard: complete`);
    assert.equal(edge.chart.filling, undefined);

    s.clock.ms += 1;
    const late = await read(s.t);
    assert.equal(late.tape.filling, true, `${SOL_BEHIND_MS + 1} ms unheard: filling, never complete`);
    assert.equal(late.tape.whole_ms, undefined, "no reach");
    assert.deepEqual(late.tape.trades, first.tape.trades, "the rows it holds");
    assert.equal(late.tape.as_of_ms, first.tape.as_of_ms, "dated by its last read");
    assert.equal(late.chart.filling, true, "the live chart not current");
    assert.deepEqual(late.chart.candles, first.chart.candles, "the bars it holds");
    assert.equal(late.page.filling, undefined, "a page of bars before `to` is history");
    assert.match(late.timing, /heard 5 s ago"/, late.timing);

    s.st.heard = { at: s.clock.ms, slot: 465_000_300 };
    const back = await read(s.t);
    assert.equal(back.tape.filling, undefined, "heard again: complete");
    assert.equal(back.tape.whole_ms, 0);
    assert.equal(back.chart.filling, undefined);
  } finally {
    s.t.stop();
  }
});

test("a Solana tape and live chart say filling while the stream is down and while its gap is walked; once walked, current", async () => {
  const s = setup();
  try {
    await s.t.trades(MINT, 50);
    await settle();
    assert.equal((await read(s.t)).tape.filling, undefined);
    // the stream drops: not connected, every token walks its gap once it is back
    s.st.heard = null;
    s.on().down();
    const down = await read(s.t);
    assert.equal(down.tape.filling, true, "down: filling");
    assert.equal(down.tape.whole_ms, undefined);
    assert.equal(down.chart.filling, true);
    assert.match(down.timing, /heard never, refilling"/, down.timing);
    // connected and heard again, the gap not yet walked: still filling
    s.st.heard = { at: s.clock.ms, slot: 465_000_400 };
    assert.equal((await read(s.t)).tape.filling, true, "refilling: filling");
    s.on().up();
    await settle();
    const walked = await read(s.t);
    assert.equal(walked.tape.filling, undefined, `the gap walked: complete ${JSON.stringify(walked.tape).slice(0, 160)}`);
    assert.equal(walked.chart.filling, undefined);
  } finally {
    s.t.stop();
  }
});
