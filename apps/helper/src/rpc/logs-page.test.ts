// node --test apps/helper/src/rpc/logs-page.test.ts (card helper-base-logs-page): the keyed-only route of an EVM chain
// (POST /v1/rpc/{base,robinhood}?keyed=only) answers an eth_getLogs over a range wider than any of its keyed providers
// serves by paging it inside the widest provider's span and joining the pages in order, as one eth_getLogs would answer,
// a page's error included; past LOGS_PAGES_MAX pages it refuses with a range cap the page walks on. The provider fakes
// answer as the deployed Base list read live on 15 Nov 02:37Z: QuickNode's trial caps at 5 blocks (its cap words,
// quicknode.com/docs/base/eth_getLogs), dRPC's free keys answer 100 blocks and refuse more with HTTP 400 code 35. The
// URLs are made up; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { DRPC_IP_PACE } from "../limits/limits.ts";
import { createPacer, createRpc, evmRangeCap, PACE_MAX_MS, RPC_ANSWER_MAX } from "./rpc.ts";

/** A still clock: a caller's share and a provider's budget are fixed windows on the helper's clock (limits.ts
 *  clientWindow, upstreamBudget; card helper-share-tests-on-a-still-clock), so on the machine's clock a window's turn
 *  inside a test clears the share its counts and 429s assert (PR 979's merge queue run 44243609488). */
const STILL = (): number => 1_800_000_000_000;
/** A test clock for one helper: its pages wait out dRPC's pace and the providers' holds, so the helper's waits move it
 *  (each to its own wake time, as timers end) and its pacer reads it, never the machine's clock; it starts on a share
 *  window's first ms (STILL is a multiple of 10 s). */
function testClock() {
  let t = STILL();
  return {
    now: (): number => t,
    pacer: createPacer(() => t),
    sleep: async (ms: number): Promise<void> => {
      const wake = t + ms;
      await null;
      t = Math.max(t, wake);
    },
  };
}
// read off the module, so this file loads at a base without them and fails on the behaviour (red runs)
const { LOGS_PAGES_MAX } = rpcModule as unknown as { LOGS_PAGES_MAX?: number };
const PAGES_MAX = LOGS_PAGES_MAX ?? 100;

const QN = "https://name-two.base-mainnet.quiknode.test/plantedBASEqn00key123456789abcd/";
const DR = [1, 2, 3].map((n) => `https://lb.drpc.test/base/plantedBASEdr${n}key123456789abcd`);
/** The deployed Base keyed list (/v1/health 15 Nov 02:30Z: quiknode.pro, drpc.live key1, key2, key3). */
// the paging and the store at a paid dRPC plan's pace (RPC_PACE_DRPC, rpc.ts keyedPaceOf): the free plan's minute budget,
// about a call a second, is drpc-ip.test's (card base-reads-never-throttled)
const PAID_DRPC = "20,60";
const BASE_ENV: Record<string, string> = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]!, RPC_PACE_DRPC: PAID_DRPC };
const RH_OWN = "https://robinhood-mainnet.alchemy.test/v2/plantedRHown000key123456789abcd";
const RH_DR = "https://lb.drpc.test/robinhood/plantedRHdr1key123456789abcd";
const POOL = "0xaa080e74ec99cf5c684548c77ca145edfcf899cf";
const TOPICS = [["0x1111111111111111111111111111111111111111111111111111111111111111"]];
const FINAL = 57_600_000;
const QN_SPAN = 5;
const DR_SPAN = 100;
const hex = (n: number): string => `0x${n.toString(16)}`;
const logsBody = (id: number | string, from: number, to: number): string => JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ address: POOL, topics: TOPICS, fromBlock: hex(from), toBlock: hex(to) }] });
const CALLER = "203.0.113.9";
type Log = { address: string; blockNumber: string; logIndex: string; data: string; topics: string[] };
/** The logs a range holds: one at each block divisible by 37, two logs in it, in block and index order. */
function logsIn(from: number, to: number, pad = 0): Log[] {
  const out: Log[] = [];
  for (let b = Math.ceil(from / 37) * 37; b <= to; b += 37) for (const i of [0, 1]) out.push({ address: POOL, blockNumber: hex(b), logIndex: hex(i), data: `0x${"00".repeat(pad)}`, topics: [TOPICS[0]![0]!] });
  return out;
}

type Sent = { url: string; method: string; from?: number; to?: number };
/** The providers: each URL's own span; `override` answers a log read first (a page's planted fault). */
function providers(spans: Record<string, number>, override?: (url: string, from: number, to: number, id: unknown) => Response | undefined, pad = 0) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init.body)) as { id: unknown; method: string; params: unknown[] };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (req.method === "eth_getBlockByNumber") {
      sent.push({ url, method: req.method });
      return json({ jsonrpc: "2.0", id: req.id, result: { number: hex(FINAL), hash: `0x${"ab".repeat(32)}` } });
    }
    if (req.method !== "eth_getLogs") {
      sent.push({ url, method: req.method });
      return json({ jsonrpc: "2.0", id: req.id, result: "0x1" });
    }
    const f = req.params[0] as { fromBlock: string; toBlock: string; address: string; topics: unknown };
    assert.equal(f.address, POOL, "the caller's filter kept");
    const from = Number(BigInt(f.fromBlock));
    const to = Number(BigInt(f.toBlock));
    // card helper-keyed-logs-serve-a-whole-pool-range: the pool store's fill asks the pool's address alone (pool-logs.ts)
    if (f.topics === undefined) {
      sent.push({ url, method: "fill", from, to });
      return json({ jsonrpc: "2.0", id: req.id, result: [] });
    }
    assert.deepEqual(f.topics, TOPICS, "the caller's topics kept");
    sent.push({ url, method: req.method, from, to });
    const o = override?.(url, from, to, req.id);
    if (o !== undefined) return o;
    const span = spans[url] ?? Infinity;
    if (to - from + 1 > span) {
      if (url === QN) return json({ jsonrpc: "2.0", id: req.id, error: { code: -32615, message: `eth_getLogs is limited to a ${QN_SPAN} range` } });
      return json({ jsonrpc: "2.0", id: req.id, error: { code: 35, message: "ranges over 10000 blocks are not supported on freetier" } }, 400);
    }
    return json({ jsonrpc: "2.0", id: req.id, result: logsIn(from, to, pad) });
  };
  const logs = () => sent.filter((s) => s.method === "eth_getLogs");
  return { sent, fetch, logs };
}
const BASE_SPANS = { [QN]: QN_SPAN, ...Object.fromEntries(DR.map((u) => [u, DR_SPAN])) };
const read = (r: ReturnType<typeof createRpc>, body: string, chain = "base") => r.handle(chain, "application/json", body, CALLER, false, true);

test("a 10,000-block eth_getLogs on Base's keyed list (QuickNode at 5, dRPC at 100) answers 200: its logs in order, the caller's id, every page inside dRPC's 100", async () => {
  const p = providers(BASE_SPANS);
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const from = FINAL - 30_000;
  const to = from + 9_999;
  const a = await read(r, logsBody("w-1", from, to));
  assert.equal(a.status, 200, `answered: ${a.body.slice(0, 200)}`);
  const body = JSON.parse(a.body) as { jsonrpc: string; id: unknown; result: Log[] };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "w-1", "the caller's own id");
  assert.deepEqual(body.result, logsIn(from, to), "every log of the range, in block and index order, none twice");
  const logs = p.logs();
  assert.ok(logs.length > 0);
  for (const s of logs) assert.ok(s.to! - s.from! + 1 <= DR_SPAN, `a page of ${s.to! - s.from! + 1} blocks sent`);
  assert.ok(!logs.some((s) => s.url === QN), "QuickNode, whose span is 5, never asked a page of 100");
  assert.equal(logs.length, 100, "100 pages of 100 blocks, each asked once");
  // the pages tile the range: no block left out, none read twice
  const covered = logs.map((s) => [s.from!, s.to!] as const).sort((x, y) => x[0] - y[0]);
  assert.equal(covered[0]![0], from);
  assert.equal(covered.at(-1)![1], to);
  for (let i = 1; i < covered.length; i++) assert.equal(covered[i]![0], covered[i - 1]![1] + 1, "pages back to back");
});

test("a log read inside dRPC's span goes to dRPC alone, never to QuickNode, whose 5-block cap would refuse it", async () => {
  const p = providers(BASE_SPANS);
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const a = await read(r, logsBody(4, FINAL - 500, FINAL - 451));
  assert.equal(a.status, 200);
  assert.deepEqual((JSON.parse(a.body) as { result: Log[] }).result, logsIn(FINAL - 500, FINAL - 451));
  assert.deepEqual(p.logs().map((s) => s.url), [DR[0]], "one send, to dRPC");
  // and a read QuickNode does serve still goes to it first, as the list orders it
  const q = providers(BASE_SPANS);
  const r2 = createRpc(BASE_ENV, { ...testClock(), fetch: q.fetch as never, log: () => undefined });
  assert.equal((await read(r2, logsBody(5, FINAL - 500, FINAL - 496))).status, 200);
  assert.deepEqual(q.logs().map((s) => s.url), [QN]);
});

test(`past ${PAGES_MAX} pages a read is refused before any send with a JSON-RPC range cap naming the widest span served, in words the page and the helper read`, async () => {
  const p = providers(BASE_SPANS);
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const max = PAGES_MAX * DR_SPAN;
  const a = await read(r, logsBody(11, FINAL - 50_000, FINAL - 50_000 + max));
  assert.equal(a.status, 200, a.body);
  const body = JSON.parse(a.body) as { id: unknown; error: { code: number; message: string } };
  assert.equal(body.id, 11);
  assert.equal(body.error.code, -32602);
  assert.equal(evmRangeCap(body.error), BigInt(max), "the helper's own cap reader names the span");
  // the page's (packages/wallet/src/pool/evm.ts capSpanOf, CAP_SPANS): the same forms
  assert.equal(/max(?:imum)? block range:? (\d{1,12})/i.exec(body.error.message)?.[1], String(max));
  assert.equal(p.logs().length, 0, "no log read of the caller's sent");
  // card helper-keyed-logs-serve-a-whole-pool-range: a pool range past the pages' reach starts the pool store's fill
  for (let i = 0; i < 1_000 && !p.sent.some((s) => s.method === "fill"); i++) await new Promise((ok) => setImmediate(ok));
  assert.ok(p.sent.some((s) => s.method === "fill"), "the pool store's fill started");
  // exactly the cap is served
  const ok = await read(r, logsBody(12, FINAL - 50_000, FINAL - 50_000 + max - 1));
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((JSON.parse(ok.body) as { result?: unknown }).result));
});

// card base-reads-never-throttled: live 16 Nov 17:33Z, on the free plan's pace (one bucket of 12 for the three keys, 0.8
// a second), a pool read 16 min of Base past the store paged 13-39 pages, spent the bucket and answered 503
test("on dRPC's free pace a read is paged only as far as the keys' bucket serves inside a send's pace wait: past it, the range cap before any send", async () => {
  const p = providers(BASE_SPANS);
  const { BASE_RPC_URL_QUICKNODE, BASE_RPC_URL_DRPC_1, BASE_RPC_URL_DRPC_2, BASE_RPC_URL_DRPC_3 } = BASE_ENV;
  const r = createRpc({ BASE_RPC_URL_QUICKNODE, BASE_RPC_URL_DRPC_1, BASE_RPC_URL_DRPC_2, BASE_RPC_URL_DRPC_3 } as Record<string, string>, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  // the bucket (12) and what refills it inside PACE_MAX_MS (0.8 x 2 s): 13 pages of 100
  const served = (DRPC_IP_PACE.burst + Math.floor((DRPC_IP_PACE.perS * PACE_MAX_MS) / 1000)) * DR_SPAN;
  const a = await read(r, logsBody(21, FINAL - 50_000, FINAL - 50_000 + 1_999));
  assert.equal(a.status, 200, a.body.slice(0, 200));
  const body = JSON.parse(a.body) as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32602, a.body.slice(0, 200));
  assert.equal(evmRangeCap(body.error), BigInt(served), "the cap names the pages the bucket serves");
  assert.equal(p.logs().length, 0, "no page sent: the bucket stays the callers'");
  const ok = await read(r, logsBody(22, FINAL - 50_000, FINAL - 50_000 + served - 1));
  assert.equal(ok.status, 200);
  assert.deepEqual((JSON.parse(ok.body) as { result?: Log[] }).result, logsIn(FINAL - 50_000, FINAL - 50_000 + served - 1), "the cap's own span is answered whole");
});

test("a page's JSON-RPC error is the read's answer, with the caller's id; a page no provider answers fails the read", async () => {
  const from = FINAL - 20_000;
  const bad = from + 3_700; // page 37
  const p = providers(BASE_SPANS, (_url, f, _t, id) =>
    f === bad ? new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "query returned more than 10000 results" } }), { status: 200, headers: { "content-type": "application/json" } }) : undefined,
  );
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const a = await read(r, logsBody(21, from, from + 4_999));
  assert.equal(a.status, 200);
  // the pinned pool's read (card helper-keyed-logs-serve-a-whole-pool-range): its words and code kept, with how far the
  // pool's store is (it names no span, so none is put in its mouth)
  assert.deepEqual(JSON.parse(a.body), { jsonrpc: "2.0", id: 21, error: { code: -32005, message: "query returned more than 10000 results", data: "pool logs kept to block 54325670" } });

  const q = providers(BASE_SPANS, (_url, f) => (f === bad ? new Response("bad gateway", { status: 502 }) : undefined));
  const r2 = createRpc(BASE_ENV, { ...testClock(), fetch: q.fetch as never, log: () => undefined });
  const b = await read(r2, logsBody(22, from, from + 4_999));
  // its own provider down for it, the page is asked of the others, whose seconds the other pages hold: 503 when none of
  // them was free to ask, else the helper's 429 (the device rests the seat on either); never a partial list
  assert.ok(b.status === 503 || b.status === 429, `refused: ${b.status} ${b.body}`);
  assert.deepEqual(JSON.parse(b.body), { error: { code: b.status === 503 ? "upstream" : "rate_limited" } });
});

test("pages whose logs together pass the answer cap are refused with a range cap naming the pages that fit", async () => {
  // each log 20 KB of data: a 100-block page holds 6 logs, about 120 KB, so about 34 pages fit RPC_ANSWER_MAX
  const p = providers(BASE_SPANS, undefined, 10_000);
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const from = FINAL - 20_000;
  const a = await read(r, logsBody(31, from, from + 9_999));
  assert.equal(a.status, 200);
  const e = (JSON.parse(a.body) as { error: { code: number; message: string } }).error;
  assert.equal(e.code, -32602);
  const span = evmRangeCap(e);
  assert.ok(span !== null && span >= BigInt(DR_SPAN) && span < 10_000n && span % BigInt(DR_SPAN) === 0n, `named ${span}`);
  // a read of that span fits (a helper of its own: the refused read drew its 100 pages of the caller's window)
  const r2 = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const ok = await read(r2, logsBody(32, from, from + Number(span) - 1));
  assert.equal(ok.status, 200);
  assert.ok(Buffer.byteLength(ok.body) <= RPC_ANSWER_MAX + 64);
  assert.ok(Array.isArray((JSON.parse(ok.body) as { result?: unknown }).result));
});

test("a finalized paged read is kept whole: asked again, it is answered with no send", async () => {
  const p = providers(BASE_SPANS);
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const from = FINAL - 40_000;
  const first = await read(r, logsBody(41, from, from + 999));
  assert.equal(first.status, 200);
  const n = p.logs().length;
  assert.equal(n, 10);
  const again = await read(r, logsBody(42, from, from + 999));
  assert.equal(again.status, 200);
  assert.equal(p.logs().length, n, "no send");
  assert.equal((JSON.parse(again.body) as { id: unknown }).id, 42);
  assert.deepEqual((JSON.parse(again.body) as { result: Log[] }).result, logsIn(from, from + 999));
});

test("Robinhood: its first keyed URL, of no known span (Alchemy's Pay As You Go), answers a wide read whole; down, the read is paged on dRPC", async () => {
  const env = { ROBINHOOD_RPC_URL: RH_OWN, ROBINHOOD_RPC_URL_DRPC_1: RH_DR, RPC_PACE_DRPC: PAID_DRPC };
  const from = FINAL - 30_000;
  const p = providers({ [RH_DR]: DR_SPAN });
  const r = createRpc(env, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const a = await read(r, logsBody(51, from, from + 1_999), "robinhood");
  assert.equal(a.status, 200);
  assert.deepEqual((JSON.parse(a.body) as { result: Log[] }).result, logsIn(from, from + 1_999));
  assert.deepEqual(p.logs().map((s) => s.url), [RH_OWN], "one send, whole, to the wide provider");

  const q = providers({ [RH_DR]: DR_SPAN }, (url) => (url === RH_OWN ? new Response("down", { status: 500 }) : undefined));
  const r2 = createRpc(env, { ...testClock(), fetch: q.fetch as never, log: () => undefined });
  const b = await read(r2, logsBody(52, from, from + 1_999), "robinhood");
  assert.equal(b.status, 200, b.body);
  assert.deepEqual((JSON.parse(b.body) as { result: Log[] }).result, logsIn(from, from + 1_999));
  const dr = q.logs().filter((s) => s.url === RH_DR);
  assert.equal(dr.length, 20, "20 pages of 100 on dRPC");
});

test(`a caller's paged reads draw ${PAGES_MAX} pages a window of their own: a second wide read in the window is a 429, and the caller's other reads still go`, async () => {
  const p = providers(BASE_SPANS);
  // the budget's clock from the start of a 10 s share window, so both reads fall in one window
  const r = createRpc(BASE_ENV, { ...testClock(), fetch: p.fetch as never, log: () => undefined });
  const from = FINAL - 30_000;
  const span = PAGES_MAX * DR_SPAN;
  assert.equal((await read(r, logsBody(71, from, from + span - 1))).status, 200);
  const second = await read(r, logsBody(72, from - span, from - 1));
  assert.equal(second.status, 429);
  const other = await read(r, JSON.stringify({ jsonrpc: "2.0", id: 73, method: "eth_blockNumber", params: [] }));
  assert.equal(other.status, 200, "the caller's own share untouched by the pages");
});

test("card helper-base-trade-reads-429: on the deployed lists (the pinned public list too), callers' reads that spend the keys' part of Base's total never refuse a paged read's pages, which draw their own logs allowance as before", async () => {
  const { SWAP_RPCS } = await import("../data/evm/swaps.ts");
  const { PROVIDER_PACE, providerHolds } = await import("../limits/limits.ts");
  const { keyedPaces } = rpcModule as unknown as { keyedPaces: (e: Record<string, string>) => Record<string, unknown> };
  const env = { BASE_RPC_URL_QUICKNODE: QN, BASE_RPC_URL_DRPC_1: DR[0]!, BASE_RPC_URL_DRPC_2: DR[1]!, BASE_RPC_URL_DRPC_3: DR[2]! };
  const clock = testClock();
  const p = providers(BASE_SPANS);
  const holds = providerHolds(clock.now, { ...PROVIDER_PACE, ...keyedPaces(env) } as never);
  const r = createRpc(env, { ...clock, fetch: p.fetch as never, log: () => undefined, holds, pinned: SWAP_RPCS } as never);
  // three other callers, 15 plain reads each over 6 s: 45, past the keys' 39 (the rest to the public list)
  const t0 = clock.now();
  const plain = await Promise.all([1, 2, 3].map((n) => (async () => {
    let s = 0;
    for (let i = 0; i < 15; i++) {
      const left = t0 + i * 400 - clock.now();
      if (left > 0) await clock.sleep(left);
      if ((await r.handle("base", "application/json", JSON.stringify({ jsonrpc: "2.0", id: n * 100 + i, method: "eth_blockNumber", params: [] }), `198.51.100.${n}`)).status === 200) s++;
    }
    return s;
  })()));
  assert.deepEqual(plain, [15, 15, 15]);
  // a paged read of 3 pages on the keyed-only route, in the same window
  const from = FINAL - 30_000;
  const a = await read(r, logsBody("pg", from, from + 299));
  assert.equal(a.status, 200, `answered: ${a.body.slice(0, 200)}`);
  assert.deepEqual((JSON.parse(a.body) as { result: Log[] }).result, logsIn(from, from + 299));
  assert.ok(clock.now() - t0 < 10_000, `inside one 10 s window (${clock.now() - t0} ms)`);
});
