// node --test apps/helper/src/data/solana/failover.test.ts (card helper-solana-failover): the trade reads' keyed provider
// (SOLANA_TRADES_RPC_URL) and the stream's (SOLANA_STREAM_WS_URL) fall back to the public endpoint when the key stops
// serving us, and take the key back when it answers its retry 5 min later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableTimers, resetTimers } from "../../../test/mock-timers.ts";
import { createSlot, SLOT_RETRY_MS } from "../../rpc/slot.ts";
import { createSolanaTrades, PYTH_RECEIVER, PYTH_SOL_USD, STREAM_WS, wsSource, type SourceEvents } from "./trades.ts";

const KEYED = "https://keyed.test/?api-key=11111111-2222-3333-4444-555555555555";
const KEYED_WS = "wss://keyed.test/?api-key=11111111-2222-3333-4444-555555555555";
const PUBLIC = "https://public.test";
const MINT = "4Tdj8MDuQ7Nx1drP1fkf1H4FVvUDrgZ3kbgQpHWXpump";
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The public provider: no signatures, the mint account, no Pyth (none needed for an empty tape). */
const publicAnswer = (init: RequestInit): Response => {
  const req = JSON.parse(String(init.body)) as { method: string; params: [string] };
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  if (req.method === "getSignaturesForAddress") return ok([]);
  if (req.method === "getAccountInfo" && req.params[0] === PYTH_SOL_USD) return ok({ context: { slot: 1 }, value: { owner: PYTH_RECEIVER, data: ["", "base64"] } });
  if (req.method === "getAccountInfo" && req.params[0] === MINT) {
    const b = Buffer.alloc(82);
    b[44] = 6; // decimals
    b[45] = 1; // initialized
    return ok({ context: { slot: 1 }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [b.toString("base64"), "base64"] } });
  }
  return ok({ context: { slot: 1 }, value: null });
};

for (const [what, keyed] of [
  ["401", () => new Response("Unauthorized", { status: 401 })],
  ["403", () => new Response("Forbidden", { status: 403 })],
  ["a spent plan", () => new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" } }), { status: 429 })],
  ["no answer", () => Promise.reject(new DOMException("timeout", "TimeoutError"))],
] as const) {
  test(`the trade reads: a key that answers ${what} is left for the public endpoint until its retry, and the tape answers`, async () => {
    let t = 1_800_000_000_000;
    const calls: string[] = [];
    const logs: string[] = [];
    const slot = createSlot("trades", true, { now: () => t, log: (l) => logs.push(l) });
    const fetch = async (u: string, init: RequestInit) => {
      calls.push(u === KEYED ? "keyed" : "public");
      if (u === KEYED) {
        if (what === "no answer") t += 10_000; // each read's timeout
        return keyed();
      }
      return publicAnswer(init);
    };
    const tr = createSolanaTrades({ fetch: fetch as never, now: () => t, listed: async () => true, rpcs: [KEYED, PUBLIC], slot, source: () => ({ watch: async () => undefined, unwatch: () => undefined, close: () => undefined }), tickMs: 0 });
    for (let i = 0; i < 4; i++) assert.equal((await tr.trades(MINT, 10)).status, 200, `read ${i}`);
    await settle();
    assert.equal(slot.state(), "fallback");
    const keyedCalls = calls.filter((c) => c === "keyed").length;
    assert.equal(keyedCalls, what === "no answer" ? 3 : 1, "the key is left once fallen back: at once, or after 30 s of 10 s timeouts");
    assert.ok(calls.filter((c) => c === "public").length >= 2, "the public endpoint answered the reads");
    const before = calls.length;
    await tr.trades(MINT, 10);
    await settle();
    assert.ok(calls.slice(before).every((c) => c === "public"), "inside the retry, only the public endpoint");
    assert.ok(logs.some((l) => l.startsWith("solana trades fallback")) && logs.every((l) => !l.includes("api-key")), logs.join("\n"));
  });
}

type Fake = { url: string; sent: string[]; onopen: (() => void) | null; onmessage: ((m: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send(s: string): void; close(): void };

test("the stream: a key refused before the socket opens reconnects to the public stream (not the key again); 5 min later a probe that hears from the key moves it back", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "setInterval"] });
  t.after(() => resetTimers(t.mock.timers));
  let now = 1_800_000_000_000;
  const logs: string[] = [];
  const slot = createSlot("stream", true, { now: () => now, log: (l) => logs.push(l) });
  const sockets: Fake[] = [];
  const events: string[] = [];
  const on: SourceEvents = { note: () => undefined, down: () => events.push("down"), up: () => events.push("up") };
  const src = wsSource(KEYED_WS, on, {
    now: () => now,
    fallback: { url: STREAM_WS, slot },
    ws: (url: string) => {
      const f: Fake = { url, sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => void f.sent.push(s), close: () => undefined };
      sockets.push(f);
      return f;
    },
  } as never);
  void src.watch(MINT).catch(() => undefined);
  assert.equal(sockets[0]!.url, KEYED_WS);
  sockets[0]!.onerror!(); // a websocket shows a refused key (HTTP 401 at the upgrade) as an error before open
  assert.equal(slot.state(), "fallback");
  t.mock.timers.tick(500);
  assert.equal(sockets[1]?.url, STREAM_WS, "the reconnect goes to the public stream");
  sockets[1]!.onopen!();
  sockets[1]!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(sockets[1]!.sent[1]!).id, result: 4 }) });
  assert.equal(events.at(-1), "up");
  // the retry: a probe to the key, its first message moves the stream back
  now += SLOT_RETRY_MS;
  sockets[1]!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: {} }) }); // the public stream is alive
  t.mock.timers.tick(5_000);
  const probe = sockets[2]!;
  assert.equal(probe.url, KEYED_WS, "a probe to the key");
  probe.onopen!();
  probe.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 0, result: 1 }) });
  assert.equal(slot.state(), "keyed");
  t.mock.timers.tick(500);
  assert.equal(sockets[3]?.url, KEYED_WS, "the stream is the key's again");
  assert.ok(logs.some((l) => l.startsWith("solana stream fallback")) && logs.some((l) => l.startsWith("solana stream keyed")), logs.join("\n"));
  assert.ok(logs.every((l) => !l.includes("api-key")));
  src.close();
});

test("the stream: a key that goes silent for 30 s falls back to the public stream", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "setInterval"] });
  t.after(() => resetTimers(t.mock.timers));
  let now = 1_800_000_000_000;
  const slot = createSlot("stream", true, { now: () => now, log: () => undefined });
  const sockets: Fake[] = [];
  const src = wsSource(KEYED_WS, { note: () => undefined, down: () => undefined, up: () => undefined }, {
    now: () => now,
    fallback: { url: STREAM_WS, slot },
    ws: (url: string) => {
      const f: Fake = { url, sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, send: (s) => void f.sent.push(s), close: () => undefined };
      sockets.push(f);
      return f;
    },
  } as never);
  void src.watch(MINT).catch(() => undefined);
  sockets[0]!.onopen!();
  sockets[0]!.onmessage!({ data: JSON.stringify({ jsonrpc: "2.0", id: 0, result: 1 }) });
  now += 31_000;
  t.mock.timers.tick(5_000);
  assert.equal(slot.state(), "fallback");
  t.mock.timers.tick(500);
  assert.equal(sockets.at(-1)!.url, STREAM_WS);
  src.close();
});

test("the stream: a keyed slot that has not failed is never probed (no probe socket, the slot stays keyed)", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout", "setInterval"] });
  t.after(() => resetTimers(t.mock.timers));
  const slot = createSlot("stream", true, { log: () => undefined });
  const sockets: string[] = [];
  const src = wsSource(KEYED_WS, { note: () => undefined, down: () => undefined, up: () => undefined }, {
    fallback: { url: STREAM_WS, slot },
    ws: (url: string) => (sockets.push(url), { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null }),
  } as never);
  t.mock.timers.tick(15_000);
  assert.deepEqual(sockets, [], "nothing opened with no token watched");
  assert.equal(slot.state(), "keyed");
  src.close();
});

test("card app-console-429: a crowd opening one token at once shares its first read: a caller that comes while the stream is still being joined waits for it, never a 503 (the deployed helper answered 4 of 25 such reads 503 at 11:19Z)", async () => {
  let joined!: () => void;
  const watching = new Promise<void>((r) => (joined = r));
  const t = createSolanaTrades({
    fetch: (async (_u: string, init: RequestInit) => publicAnswer(init)) as never,
    now: () => Date.now(),
    listed: async () => true,
    rpcs: [PUBLIC],
    source: () => ({ watch: () => watching, unwatch: () => undefined, close: () => undefined }),
    tickMs: 0,
  });
  const first = t.trades(MINT, 10);
  await settle(); // the first read has the mint and is joining the stream
  const crowd = Array.from({ length: 24 }, () => t.trades(MINT, 10));
  const candles = Array.from({ length: 24 }, () => t.candles(MINT, "1s", null, 10));
  joined();
  const all = await Promise.all([first, ...crowd, ...candles]);
  assert.deepEqual(all.map((a) => a.status), all.map(() => 200));
  t.stop();
});
