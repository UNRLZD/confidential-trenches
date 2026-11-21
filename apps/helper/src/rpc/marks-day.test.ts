// node --test src/rpc/marks-day.test.ts (card solana-marks-route-answers): the helper's background reads (the trade
// walks, rpc.background; the pool fill; the EVM lists and index) never spend the part of a keyed account's day that
// callers' reads alone draw (limits.ts CALLER_DAY_ROOM), so a restore's mark scan on POST /v1/rpc/solana-marks is
// answered while its provider has a caller's day left.
// Live 16 Nov 23:37Z (release 177, ad9337504): route B answered 503 upstream at 0 ms, sending nothing ("rpc;dur=0;
// desc=none"). Its one provider is SOLANA_RPC_URL_QUICKNODE (the box's SOLANA_RPC_URL_DRPC_1..3 are empty: dRPC's free
// plan has no Solana, merge note M359), and the box's day files summed 319,710 of quicknode-solana's 322,580 credits,
// past the 319,370 every draw but a probe may reach: the day was out until 00:00Z, spent mostly by the walks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, keyedPaces } from "./rpc.ts";
import { providerHolds } from "../limits/limits.ts";

const PROGRAM = "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF";
// made-up hosts and test-only keys: nothing here reaches a network
const A = "https://mainnet.helius-rpc.example/?api-key=test-key-a-not-a-secret";
const QN = "https://x.solana-mainnet.quiknode.example/test-key-qn-not-a-secret/";
const DRPC = "https://lb.drpc.example/solana/test-key-drpc-not-a-secret";
const BASE_DRPC = "https://lb.drpc.example/base/test-key-drpc-not-a-secret";
const SCAN = { jsonrpc: "2.0", id: 5, method: "getProgramAccounts", params: [PROGRAM, { commitment: "finalized", encoding: "base64", withContext: true, dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] }] };

const clock = () => {
  const t = { v: Math.ceil((performance.timeOrigin + performance.now()) / 86_400_000) * 86_400_000 + 1_000 }; // 00:00:01Z: one UTC day
  return { t, now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};
function fakeFetch() {
  const sent: string[] = [];
  const f = async (url: string, init: RequestInit) => {
    sent.push(url);
    const p = JSON.parse(String(init.body)) as { id: unknown };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: p.id, result: { context: { slot: 470318358 }, value: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, f };
}

test("the trade walks spend quicknode-solana's day as far as they may, and the mark scan on route B is still answered by it", async () => {
  // 3,000 credits: 100 Solana calls at 30; the probe's 1% keeps 1, callers' quarter 25 more, the walks stop at 74
  const env = { SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM, RPC_DAY_QUICKNODE: "3000" };
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces(env));
  const { sent, f } = fakeFetch();
  const r = createRpc(env, { fetch: f as never, holds, now: c.now, sleep: c.sleep, log: () => undefined });
  // the walks (data/solana/trades.ts) draw QuickNode as a keyed spare, one call each, as fast as its pace lets them
  let walks = 0;
  for (let i = 0; i < 400; i++) {
    c.t.v += 1_000;
    if (r.background("solana", QN, "getTransaction") === 0) walks++;
  }
  assert.ok(walks < 99, `the walks drew ${walks} calls of the day's 99 a caller may reach`);
  c.t.v += 2_000;
  const a = await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9");
  assert.equal(a.status, 200, `route B: ${a.status} ${a.body}`);
  assert.deepEqual(sent, [QN]);
  // callers draw the day's last part the walks left them, down to the probe's share, and no further: past it every scan
  // is still answered, by route B's keyless providers (card solana-marks-route-answers, reopened)
  for (let i = 0; i < 100; i++) {
    c.t.v += 1_000;
    assert.equal((await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9")).status, 200);
  }
  const callers = sent.filter((u) => u === QN).length;
  assert.equal(walks + callers, 99, `walks ${walks} + callers ${callers}: every call a caller may reach, never the probe's`);
});

test("a day spent to its end by callers sends QuickNode nothing more, and the scans go on being answered past it", async () => {
  const env = { SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM, RPC_DAY_QUICKNODE: "300" };
  const c = clock();
  const { sent, f } = fakeFetch();
  const r = createRpc(env, { fetch: f as never, holds: providerHolds(c.now, keyedPaces(env)), now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 12; i++) {
    c.t.v += 1_000;
    assert.equal((await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9")).status, 200);
  }
  // 300 credits at 30 a call: 10 calls, the probe's share a whole call short of one (none kept)
  assert.equal(sent.filter((u) => u === QN).length, 10);
  assert.deepEqual(sent.slice(10), ["https://api.mainnet-beta.solana.com", "https://api.mainnet-beta.solana.com"]);
});

test("ruled out: Base's background reads on a dRPC key hold its pace, and a mark scan on that key is still served", async () => {
  // were route B's dRPC names set (they are empty on the box), each dRPC key is one account across chains (rpc.ts
  // keyedAccountOf) on one per-IP bucket (limits.ts DRPC_IP_PACE): background leaves CALLER_ROOM of it, so a caller waits
  // at most one refill, never a 503
  const env = { SOLANA_RPC_URL: A, SOLANA_RPC_URL_DRPC_1: DRPC, BASE_RPC_URL_DRPC_1: BASE_DRPC, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM };
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces(env));
  const { sent, f } = fakeFetch();
  const r = createRpc(env, { fetch: f as never, holds, now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 50; i++) holds.take(BASE_DRPC, 1, true);
  const a = await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9");
  assert.equal(a.status, 200, `route B: ${a.status} ${a.body}`);
  assert.deepEqual(sent, [DRPC]);
});

// card solana-marks-route-answers, reopened: live 20 Nov 18:45Z (helper 486d73262, run 44789835818) route B answered
// every scan 503 at 0 ms again: the box's day files summed quicknode-solana's day to 321,150 of the 319,370 a caller may
// reach (232,410 of it by a helper whose plain reads fell onto QuickNode while SOLANA_RPC_URL's plan was spent), while
// QuickNode itself answered the same scan 200. Two keyless companies answered the restore's exact scan from the box then
// (api.mainnet-beta.solana.com and public.rpc.solanavibestation.com, 14 and 26 accounts, as QuickNode and Helius), so
// route B walks on to them (rpc.ts MARKS_KEYLESS), each off route A's company as its keyed names are.
const FOUNDATION = "https://api.mainnet-beta.solana.com";
const SVS = "https://public.rpc.solanavibestation.com";
const timingName = (t: string[] | undefined) => /rpc;[^,]*desc="([^"]+)"/.exec((t ?? []).join(", "))?.[1];

test("QuickNode's day spent by callers: route B's next scan is answered by a keyless company off route A's, named (red at e8ea676e3: 503 at 0 ms)", async () => {
  const env = { SOLANA_RPC_URL: A, SOLANA_RPC_URL_QUICKNODE: QN, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM, RPC_DAY_QUICKNODE: "300" };
  const c = clock();
  const { sent, f } = fakeFetch();
  const r = createRpc(env, { fetch: f as never, holds: providerHolds(c.now, keyedPaces(env)), now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 12; i++) {
    c.t.v += 1_000;
    await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9");
  }
  sent.length = 0;
  c.t.v += 1_000;
  const a = await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9");
  assert.equal(a.status, 200, `route B: ${a.status} ${a.body}`);
  assert.deepEqual(sent, [FOUNDATION], "QuickNode's day out: no send to it, the Solana Foundation's keyless endpoint asked");
  assert.equal(timingName(a.timing), "SOLANA_MARKS_FOUNDATION");
});

test("route B's keyless providers walk in turn: a 429 or a JSON-RPC error from one asks the next; all refusing is 503, never route A", async () => {
  const env = { SOLANA_RPC_URL: A, POOL_SOLANA_PROGRAM_MAINNET: PROGRAM };
  const c = clock();
  for (const refusal of [() => new Response("{}", { status: 429, headers: { "retry-after": "10", "content-type": "application/json" } }), (id: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32010, message: "excluded from account secondary indexes" } }), { status: 200, headers: { "content-type": "application/json" } })]) {
    const sent: string[] = [];
    const f = async (url: string, init: RequestInit) => {
      sent.push(url);
      const p = JSON.parse(String(init.body)) as { id: unknown };
      return url === FOUNDATION ? refusal(p.id) : new Response(JSON.stringify({ jsonrpc: "2.0", id: p.id, result: { context: { slot: 470318358 }, value: [] } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = createRpc(env, { fetch: f as never, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9");
    assert.equal(a.status, 200, `${a.status} ${a.body}`);
    assert.deepEqual(sent, [FOUNDATION, SVS]);
    assert.equal(timingName(a.timing), "SOLANA_MARKS_SVS");
  }
  const sent: string[] = [];
  const down = async (url: string) => (sent.push(url), new Response("busy", { status: 503 }));
  const r = createRpc(env, { fetch: down as never, now: c.now, sleep: c.sleep, log: () => undefined });
  assert.equal((await r.handle("solana-marks", "application/json", JSON.stringify(SCAN), "198.51.100.9")).status, 503);
  assert.deepEqual(sent, [FOUNDATION, SVS], "never route A's provider");
});
