// node --test src/rpc/slots-spent.test.ts (card helper-solana-slots-off-a-spent-key): the helper's Solana slots move
// off a key whose plan is spent onto the host's next Solana slot key, with the caller budget that key sets, before
// QuickNode and the public endpoint. Live 20 Nov 11:2xZ (release 211): SOLANA_RPC_URL and SOLANA_TRADES_RPC_URL one URL
// answering 429 "max usage reached", SOLANA_HOLDERS_RPC_URL and QuickNode answering; the rpc slot fell back, so every
// plain read went to QuickNode, then the public endpoint, whose share is 16 a caller (rpc.ts RPC_CLIENT_MAX):
// helper-gives-a-trade-its-reads read "[solana] 16 of 42 served: read 17 refused 429", and QuickNode's day was spent
// (solana-marks-route-answers: route B 503 at once).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPacer, createRpc } from "./rpc.ts";
import * as server from "../server.ts";
import { createSlot } from "./slot.ts";

// read off the module, so this file loads at a commit without tradesSlotShown and its tests fail on the behaviour (red runs)
const { solanaTradesRpcs } = server;
const tradesSlotShown: typeof server.tradesSlotShown = (server as Partial<typeof server>).tradesSlotShown ?? (() => assert.fail("no tradesSlotShown at this commit"));

const T0 = 1_800_000_000_000;
const key = (n: string) => `test-key-${n}-not-a-secret`;
// made-up hosts and test-only keys: nothing here reaches a network
const A = `https://mainnet.helius-rpc.example/?api-key=${key("a")}`;
const HOLDERS = `https://mainnet.helius-rpc.example/?api-key=${key("holders")}`;
const QN = `https://x.solana-mainnet.quiknode.example/${key("qn")}/`;
const PUBLIC = "https://api.mainnet-beta.solana.com";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** The live host's shape; QuickNode's day spent (RPC_DAY_QUICKNODE under one Solana call's 30 units), as it read live. */
const HOST = { SOLANA_RPC_URL: A, SOLANA_TRADES_RPC_URL: A, SOLANA_HOLDERS_RPC_URL: HOLDERS, SOLANA_RPC_URL_QUICKNODE: QN };
const DAY_OUT = { ...HOST, RPC_DAY_QUICKNODE: "1" };
const SPENT_429 = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: "max usage reached" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });

function world(spent: readonly string[] = [A]) {
  let t = T0;
  const sent: { url: string; at: number }[] = [];
  const f = async (url: string, init: RequestInit) => {
    sent.push({ url, at: t });
    if (spent.includes(url)) return SPENT_429();
    const p = JSON.parse(String(init.body));
    const one = (q: { id: unknown; method?: string }) => ({ jsonrpc: "2.0", id: q.id, result: q.method === "getGenesisHash" ? GENESIS : 467400178 });
    return new Response(JSON.stringify(Array.isArray(p) ? p.map(one) : one(p)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, f, now: () => t, sleep: async (ms: number) => void (t += ms) };
}
const getSlot = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "getSlot" });

test("the live host's shape, QuickNode's day spent: a trade's 42 Solana reads are all served, on the holders slot's key past the spent one, never the public endpoint (main served 16, the public share)", async () => {
  const w = world();
  // the pacer on the test's clock, so a second of the provider's pace ends when the waits move it
  const r = createRpc(DAY_OUT, { now: w.now, sleep: w.sleep, fetch: w.f, log: () => {}, pacer: createPacer(w.now) });
  const statuses: number[] = [];
  for (let i = 0; i < 42; i++) statuses.push((await r.handle("solana", "application/json", getSlot(i), "page-1")).status);
  assert.equal(statuses.filter((s) => s === 200).length, 42, `served ${statuses.filter((s) => s === 200).length} of 42: ${statuses.join(",")}`);
  // the spent key once, then the holders key alone: never QuickNode (its day out), never the public endpoint
  assert.equal(w.sent.filter((s) => s.url === A).length, 1);
  assert.equal(w.sent.filter((s) => s.url === PUBLIC).length, 0);
  assert.equal(w.sent.filter((s) => s.url === HOLDERS).length, 42);
  // the slot is on a key that is not spent: keyed
  assert.equal(r.slot.state(), "keyed");
});

test("the holders slot's own reads keep their place: the rpc slot's sends to the holders key take at most half its second, the holders client's sends the rest", async () => {
  const w = world();
  const pacer = createPacer(w.now);
  const r = createRpc(DAY_OUT, { now: w.now, sleep: w.sleep, fetch: w.f, log: () => {}, pacer });
  for (let i = 0; i < 42; i++) await r.handle("solana", "application/json", getSlot(i), "page-1");
  const at = w.sent.filter((s) => s.url === HOLDERS).map((s) => s.at);
  assert.equal(at.length, 42, "the rpc slot read the holders key");
  // the plan's 10 a second (keyedBudget: Helius free's 100 per 10 s), half of it: at most 5 in any second
  const most = Math.max(...at.map((x) => at.filter((y) => y >= x && y < x + 1_000).length));
  assert.ok(most <= 5, `most in one second: ${most}`);
  // in a second the rpc slot filled, the holders client still finds room for its own reads on the same pacer
  const h = createRpc({ SOLANA_RPC_URL: HOLDERS }, { now: w.now, sleep: w.sleep, fetch: w.f, log: () => {}, pacer, slot: "holders", publicFallback: false });
  const before = w.sent.length;
  const a = await h.handle("solana", "application/json", getSlot(99), "page-2");
  assert.equal(a.status, 200);
  assert.equal(w.sent.length, before + 1);
});

test("every slot key spent: a read moves on to QuickNode in the same read, never stalls; the slot is fallback then", async () => {
  const w = world([A, HOLDERS]);
  const r = createRpc(HOST, { now: w.now, sleep: w.sleep, fetch: w.f, log: () => {} });
  const a = await r.handle("solana", "application/json", getSlot(1), "page-1");
  assert.equal(a.status, 200);
  assert.deepEqual(w.sent.map((s) => s.url), [A, HOLDERS, QN]);
  assert.equal(r.slot.state(), "fallback");
});

test("the trades walk's providers: its own key, then the host's other Solana slot keys, then QuickNode and the public ones", () => {
  assert.deepEqual(solanaTradesRpcs(HOST), [A, HOLDERS, QN, "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]);
  // no other slot key: as before
  assert.deepEqual(solanaTradesRpcs({ SOLANA_TRADES_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN }), [A, QN, "https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]);
});

test("the trades walk's background reads on another slot's key are paced to a quarter of its second (half the rpc slot's half), so the holders reads keep theirs", async () => {
  const w = world();
  const r = createRpc(HOST, { now: w.now, sleep: w.sleep, fetch: w.f, log: () => {} });
  let go = 0;
  for (let i = 0; i < 10; i++) if (r.background("solana", HOLDERS, "getSignaturesForAddress") === 0) go++;
  assert.ok(go >= 1 && go <= 3, `background sends let into one second: ${go}`);
});

test("/v1/health's solana.trades is keyed while, fallen back off its spent key, its walk's next provider is another slot's key not spent; fallback once that one is spent too", () => {
  const trades = createSlot("trades", true, { log: () => {} });
  trades.fail("credits");
  const spent = new Set([A]);
  const shown = tradesSlotShown(HOST, trades, (u) => spent.has(u));
  assert.equal(shown.state(), "keyed");
  spent.add(HOLDERS);
  assert.equal(shown.state(), "fallback");
  // with no other slot key set, the slot's own state
  assert.equal(tradesSlotShown({ SOLANA_TRADES_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN }, trades, () => false).state(), "fallback");
});
