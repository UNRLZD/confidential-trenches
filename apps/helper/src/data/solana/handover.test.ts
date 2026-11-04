// node --test apps/helper/src/data/solana/handover.test.ts (card app-console-429): a deploy swaps the helper, and the new
// one starts cold: GeckoTerminal's keyless window spent by the old one (data/gecko.ts, seeded from the warm file) and its
// chain provider holding its first reads. Before this card every shared answer the old helper held was dropped at the
// swap, so a crowd's first loads all went upstream at once and met those limits: app live run 41816576115 (10:48Z, right
// after a swap) read the candles 429 for 45 s and four page loads logged a 429; at 11:05Z the first holders read after a
// swap answered 429 in 0.08 s. The old helper now hands its token page's answers over in the warm file
// (token.ts state/restore, data/warm.ts), and the new one answers them under the same freshness rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { handler } from "../../server.ts";
import { refusalLog } from "../../limits/limits.ts";
import { geckoBudget, GT_LIMIT_PER_MIN, GT_SERVE_MS, PAGE_RESERVE, REFRESH_SLOT, REFRESH_URGENT_MS } from "../gecko.ts";
import { pumpCurveAddress } from "./lists.ts";
import { createSolanaToken, TOKEN_2022_PROGRAM } from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const NOW = Date.parse("2026-11-02T13:53:00Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://confidential.unrealized.trade";
const CROWD = 35;

const ok = (result: unknown) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }) });
const ACCT = ["8hT1Yhd8x3xKMtV9Ue4BoGpvdsxVrz5V6V8Brp7NbB7B", "6t8nGMxjKCFbBf4KQ6YsgpAvWdzfPUSSa8UpKQfr5Ft5"];
const OWNER = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
/** The chain as recorded for PUMP (token-page.json), holders in getTokenLargestAccounts' documented shape; `held`: every
 *  read answered as the helper's RPC path answers a held provider (429, Retry-After 5), the new helper's first reads. */
function chain(held: () => boolean) {
  const calls: string[] = [];
  return {
    calls,
    async handle(_c: string, _ct: string | undefined, body: string) {
      const r = JSON.parse(body) as { method: string; params: unknown[] };
      calls.push(r.method);
      if (held()) return { status: 429, headers: { "Retry-After": "5" }, body: '{"error":{"code":"rate_limited"}}', why: "solana held" };
      if (r.method === "getTokenLargestAccounts") return ok({ context: { slot: 1 }, value: [{ address: ACCT[0], amount: "500000" }, { address: ACCT[1], amount: "300000" }] });
      const keys = r.params[0] as string[];
      if ((r.params[1] as { encoding?: string }).encoding === "base64") return ok({ context: { slot: 1 }, value: keys.map(() => null) });
      if (keys.length === 2 && keys[1] === pumpCurveAddress(keys[0]!)) return { status: 200, body: JSON.stringify(FX.tokens[PUMP].accounts) };
      if (keys[0] === PUMP) return { status: 200, body: JSON.stringify({ ...FX.tokens[PUMP].accounts, result: { ...FX.tokens[PUMP].accounts.result, value: [FX.tokens[PUMP].accounts.result.value[0]] } }) };
      return ok({ context: { slot: 1 }, value: keys.map(() => ({ owner: TOKEN_2022_PROGRAM, data: { parsed: { type: "account", info: { owner: OWNER } } } })) });
    },
  };
}
function jupiter(held: () => boolean) {
  return {
    async handle(_v: string, _p: string, q: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
      if (held()) return { status: 429, headers: { "Retry-After": "5" }, body: '{"error":{"code":"rate_limited"}}' };
      const mints = new URLSearchParams(q).get("query")!.split(",");
      return { status: 200, headers: { "X-Fetched-At": FX.tokens[PUMP].fetched_at }, body: JSON.stringify(mints.flatMap((m) => FX.tokens[m]?.search ?? [])) };
    },
  };
}
function gecko() {
  const urls: string[] = [];
  const fetch = async (url: string) => (urls.push(url), new Response(JSON.stringify(url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token), { status: 200, headers: { "content-type": "application/json" } }));
  return { urls, fetch };
}
function get(port: number, path: string, ip: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { origin: APP, "x-forwarded-for": ip }, agent: false }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => done({ status: res.statusCode!, body: b }));
    });
    r.on("error", fail).end();
  });
}
type Handover = { state?: () => unknown; restore?: (st: unknown) => void };

/** The old helper serves PUMP's page, holders and 15m chart; its state goes through the warm file (JSON); 20 s later the
 *  new one starts with GeckoTerminal's window spent and its providers held, takes the state over, and a crowd opens. */
async function swapThenCrowd(handOver = true) {
  let t = NOW;
  const now = () => t;
  const oldGt = gecko();
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: oldGt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  assert.equal((await old.page(PUMP)).status, 200);
  assert.equal((await old.holders(PUMP)).status, 200);
  assert.equal((await old.candles(PUMP, "15m", null, 500)).status, 200);
  const file = JSON.parse(JSON.stringify({ solana: (old as Handover).state?.() }));

  t += 20_000; // the swap: the old helper's last write, then the new one listens
  const spent = geckoBudget(now);
  spent.seed(Array.from({ length: GT_LIMIT_PER_MIN }, (_, i) => t - 5_000 + i * 1_000)); // the old helper's window
  const newGt = gecko();
  const rpc = chain(() => true);
  const holdersRpc = chain(() => true);
  const fresh = createSolanaToken(jupiter(() => true), rpc, { now, fetch: newGt.fetch as never, gecko: spent, holdersRpc });
  if (handOver) (fresh as Handover).restore?.(file.solana);
  const lines: string[] = [];
  const refusals = refusalLog((l) => lines.push(l));
  const h = createServer(handler(COMMIT, undefined, undefined, undefined, undefined, undefined, undefined, fresh as never, undefined, null, new Map(), new Map(), now, {}, {}, () => true, Promise.resolve(), () => ({}), refusals));
  await new Promise<void>((r) => h.listen(0, "127.0.0.1", () => r()));
  const port = (h.address() as AddressInfo).port;
  try {
    const paths = [`/v1/market/token?chain=solana&token=${PUMP}`, `/v1/market/holders?chain=solana&token=${PUMP}`, `/v1/market/candles?chain=solana&token=${PUMP}&tf=15m&limit=500`];
    const answers = await Promise.all(Array.from({ length: CROWD }, (_, i) => Promise.all(paths.map((p) => get(port, p, `198.18.0.${i + 1}`).then((a) => ({ route: p.split("?")[0]!, ...a }))))));
    refusals.flush();
    return { answers: answers.flat(), lines, gtCalls: newGt.urls.length, rpcCalls: rpc.calls.length + holdersRpc.calls.length };
  } finally {
    h.closeAllConnections();
    await new Promise<void>((r) => h.close(() => r()));
  }
}

test(`a crowd of ${CROWD} first loads right after a swap (GeckoTerminal's window spent, the chain provider held): the token page, holders and candles all answer 200 from what the old helper handed over, with no upstream call`, async () => {
  const r = await swapThenCrowd();
  const by: Record<string, number> = {};
  for (const a of r.answers) by[`${a.route} ${a.status}`] = (by[`${a.route} ${a.status}`] ?? 0) + 1;
  assert.deepEqual(by, { "/v1/market/token 200": CROWD, "/v1/market/holders 200": CROWD, "/v1/market/candles 200": CROWD }, JSON.stringify(by));
  assert.deepEqual(r.lines, [], "no caller refused");
  assert.equal(r.gtCalls, 0, "no GeckoTerminal call into a window the old helper spent");
  const c = JSON.parse(r.answers.find((a) => a.route.endsWith("candles"))!.body);
  assert.ok(c.candles.length > 0 && c.src === "geckoterminal", "the old helper's last good bars, with their read time");
  const page = JSON.parse(r.answers.find((a) => a.route.endsWith("token"))!.body);
  assert.equal(page.row.token, PUMP);
});

test("without the handover (as before this card) the same crowd meets the cold helper's limits, and the refusal log names each route and reason once with its count", async () => {
  const r = await swapThenCrowd(false);
  assert.ok(r.answers.every((a) => a.status === 429), JSON.stringify(r.answers.map((a) => a.status)));
  assert.deepEqual(r.lines.sort(), [
    `refused /v1/market/candles geckoterminal budget ${CROWD} in 10 s`,
    `refused /v1/market/holders solana held ${CROWD} in 10 s`,
    `refused /v1/market/token solana held ${CROWD} in 10 s`,
  ]);
  assert.ok(r.lines.every((l) => !l.includes("198.18.")), "never the caller");
});

test("the handover is hostile input: a key that is no mint, a body that is not an answer, a time ahead of now or past its staleness, bad bars and odd sources are all dropped", async () => {
  const t = NOW;
  const now = () => t;
  const rpc = chain(() => true);
  const fresh = createSolanaToken(jupiter(() => true), rpc, { now, fetch: gecko().fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => true) }) as ReturnType<typeof createSolanaToken> & Handover;
  const page = { at: t - 1_000, asOfMs: t - 1_000, body: JSON.stringify({ row: { token: PUMP } }), src: "jupiter" };
  fresh.restore!({
    page: [["not-a-mint", page], [PUMP, { ...page, body: "[1]" }], [PUMP, { ...page, at: t + 1 }], [PUMP, { ...page, asOfMs: t - 61_000 }], [PUMP, { ...page, src: "<script>" }], [PUMP, { ...page, body: 7 }], "junk", [PUMP]],
    holders: { [PUMP]: page },
    pools: [[PUMP, { ...page, body: "not an address" }]],
    kept: [[`${PUMP}:15m`, { bars: [[1, "x", "1", "1", "1", "1"]], at: t - 1_000 }], [`${PUMP}:7m`, { bars: [[1_790_000_000, "1", "1", "1", "1", "1"]], at: t - 1_000 }], [`${PUMP}:15m`, { bars: [[1_790_000_000, "1", "1", "1", "1", "1"]], at: t - 3_600_001 }]],
  });
  assert.equal((await fresh.page(PUMP)).status, 429, "nothing restored: the held provider's 429");
  assert.equal((await fresh.holders(PUMP)).status, 429);
  assert.equal((await fresh.candles(PUMP, "15m", null, 500)).status, 200, "GeckoTerminal still has room: a real read");
  const good = createSolanaToken(jupiter(() => true), rpc, { now, fetch: gecko().fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => true) }) as ReturnType<typeof createSolanaToken> & Handover;
  good.restore!({ page: [[PUMP, page]] });
  assert.equal((await good.page(PUMP)).body, page.body, "a good entry is served as it was");
});

test("the handover is bounded: newest first within HANDOVER_MAX bytes, and only answers under their staleness", async () => {
  const { HANDOVER_MAX } = await import("./token.ts");
  let t = NOW;
  const now = () => t;
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gecko().fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) }) as ReturnType<typeof createSolanaToken> & Handover;
  await old.page(PUMP);
  const st = old.state!() as { page: unknown[] };
  assert.equal(st.page.length, 1);
  assert.ok(JSON.stringify(st).length <= HANDOVER_MAX);
  t += 61_000 + (Date.parse(FX.tokens[PUMP].fetched_at) < NOW ? NOW - Date.parse(FX.tokens[PUMP].fetched_at) : 0);
  assert.equal((old.state!() as { page: unknown[] }).page.length, 0, "a page past its staleness is not handed over");
});

test("history before a time is kept an hour: a second read of the same mint:tf:before within the hour makes no GeckoTerminal call; the newest range is still read again after 60 s", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const tok = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  const before = Math.floor(NOW / 1000) - 3_600; // the first own bar an hour back, as trades.ts asks it
  assert.equal((await tok.candles(PUMP, "15m", before, 500)).status, 200);
  const ohlcv = () => gt.urls.filter((u) => u.includes("/ohlcv/")).length;
  assert.equal(ohlcv(), 1);
  t += 30 * 60_000;
  assert.equal((await tok.candles(PUMP, "15m", before, 500)).status, 200);
  assert.equal(ohlcv(), 1, "30 min later: no call");
  t += 31 * 60_000;
  await tok.candles(PUMP, "15m", before, 500);
  assert.equal(ohlcv(), 2, "past the hour: read again");
  await tok.candles(PUMP, "15m", null, 500);
  assert.equal(ohlcv(), 3);
  t += 76_000; // past 60 s, and past the budget's window, so the refresh lane has room (../gecko.ts COLD_RESERVE)
  await tok.candles(PUMP, "15m", null, 500);
  assert.equal(ohlcv(), 4, "the newest range moves with every trade: 60 s");
});

test("under a spent budget a held token's refresh yields to a cold token's first read: the cold candles answer 200, the held ones are served from what was held, dated by their read (live suite at 567a181: candles 429 under parallel load)", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const budget = geckoBudget(now);
  const tok = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: budget, holdersRpc: chain(() => false) });
  const COLD = "Q1vecEMQEgDyrw1txmBgFwUrkeQurqkEe1bGMzFpump";
  const first = await tok.candles(PUMP, "1m", null, 24);
  assert.equal(first.status, 200);
  const readAt = first.asOfMs;
  // 3 minutes on: PUMP's bars are past their 60 s, still under REFRESH_URGENT_MS (../gecko.ts; past it the re-read is a
  // page read, card helper-chart-fresh, gecko-share.test.ts); the lists and one other held read keep the window at the refresh lane's room
  t += 3 * 60_000;
  assert.ok(t - readAt! < REFRESH_URGENT_MS);
  for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE - REFRESH_SLOT; i++) assert.equal(budget.take("lists"), true);
  assert.equal(budget.take("refresh"), true, "and one other held read: the window at the refresh lane's room");
  // PUMP's page is open and re-read first, then a token nobody holds is opened
  const held = await tok.candles(PUMP, "1m", null, 24);
  const cold = await tok.candles(COLD, "1m", null, 24);
  assert.equal(cold.status, 200, `the cold token's first read is served (${cold.body.slice(0, 80)})`);
  assert.equal(held.status, 200, "the held token is served");
  assert.equal(held.asOfMs, readAt, "from what it held, dated by its own read");
  assert.equal(JSON.parse(held.body).as_of_ms, readAt);
});

test("the last good bars are handed over across a swap for a day, not an hour: history before their read is served from them on a spent budget", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  const st = JSON.parse(JSON.stringify(old.state()));
  t += 6 * 3_600_000; // the old helper's bars are six hours old at the swap
  const spent = geckoBudget(now);
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) spent.take("pages");
  const next = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: spent, holdersRpc: chain(() => false) });
  next.restore(st);
  const before = Math.floor(NOW / 1000) - 600; // bars before the old helper's read: history that never changes
  const a = await next.candles(PUMP, "1m", before, 24);
  assert.deepEqual([a.status, a.asOfMs], [200, NOW], "served from the handover, dated by its read");
});

test("card helper-restart-fresh: the newest bars kept over a swap past GT_SERVE_MS are never served: on a spent budget the first read answers 429 with its wait (live run 41871356171 at 6832227: PUMP's 1h bars from 16:33:56Z served as a 200 at 16:50:11Z)", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  const st = JSON.parse(JSON.stringify(old.state()));
  t += 16 * 60_000 + 15_000; // the old helper last read PUMP's chart 16 min before the swap (the fixture's bars are minute bars)
  const spent = geckoBudget(now);
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) assert.equal(spent.take("pages"), true);
  const next = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: spent, holdersRpc: chain(() => false) });
  next.restore(st);
  const a = await next.candles(PUMP, "1m", null, 24);
  assert.notEqual(a.status, 200, `never a 200 with bars ${Math.round((t - (a.asOfMs ?? t)) / 60_000)} min old`);
  assert.equal(a.status, 429, a.body);
  assert.equal(JSON.parse(a.body).error.code, "rate_limited");
  assert.ok((a.retryAfterS ?? 0) >= 1, "with the wait to the next call");
  // inside the bound the kept bars still serve, dated: a swap's first loads 5 min after the old helper's read
  t = NOW + GT_SERVE_MS - 1_000;
  const spent2 = geckoBudget(now);
  for (let i = 0; i < GT_LIMIT_PER_MIN; i++) assert.equal(spent2.take("pages"), true);
  const near = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: spent2, holdersRpc: chain(() => false) });
  near.restore(st);
  const b = await near.candles(PUMP, "1m", null, 24);
  assert.deepEqual([b.status, b.asOfMs], [200, NOW], "inside GT_SERVE_MS: the handed-over bars, dated by their read");
});

test("card helper-restart-fresh: with a call free, the newest bars kept over a swap past GT_SERVE_MS are read again before they are served", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  const st = JSON.parse(JSON.stringify(old.state()));
  t += 16 * 60_000 + 15_000;
  const next = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  next.restore(st);
  const a = await next.candles(PUMP, "1m", null, 24);
  assert.deepEqual([a.status, a.asOfMs], [200, t], "read now, not the old helper's bars");
});

test("card helper-restart-fresh: the top pools the old helper would still serve are handed over, so a chart read straight after a swap costs one GeckoTerminal call, not two", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const old = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: geckoBudget(now), holdersRpc: chain(() => false) });
  assert.equal((await old.candles(PUMP, "1m", null, 24)).status, 200);
  t += 16 * 60_000 + 15_000; // past the pool's 10 minutes: the old helper re-reads it as a refresh and serves it held when refused
  const st = JSON.parse(JSON.stringify(old.state()));
  assert.equal(st.pools.length, 1, "PUMP's top pool is handed over");
  const one = geckoBudget(now);
  for (let i = 0; i < GT_LIMIT_PER_MIN - 1; i++) assert.equal(one.take("pages"), true); // one call left in the window
  const next = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: one, holdersRpc: chain(() => false) });
  next.restore(st);
  const n = gt.urls.length;
  const a = await next.candles(PUMP, "1m", null, 24);
  assert.deepEqual([a.status, a.asOfMs], [200, t], `read now with the window's last call (${a.body.slice(0, 80)})`);
  assert.deepEqual(gt.urls.slice(n).map((u) => (u.includes("/ohlcv/") ? "ohlcv" : "pool")), ["ohlcv"], "the bars alone: the pool came over");
});

test("card helper-chart-fresh: history before a time held past its hour stays a refresh, whatever its age: with the window at the refresh lane's room it is served as held and a cold token's first read finds its calls", async () => {
  let t = NOW;
  const now = () => t;
  const gt = gecko();
  const budget = geckoBudget(now);
  const tok = createSolanaToken(jupiter(() => false), chain(() => false), { now, fetch: gt.fetch as never, gecko: budget, holdersRpc: chain(() => false) });
  const COLD = "Q1vecEMQEgDyrw1txmBgFwUrkeQurqkEe1bGMzFpump";
  const before = Math.floor(NOW / 1000) - 600; // the minute bars before our first, ten minutes back
  const first = await tok.candles(PUMP, "1m", before, 500);
  assert.equal(first.status, 200);
  assert.ok(JSON.parse(first.body).candles.length > 0);
  t += 2 * 3_600_000; // past HISTORY_FRESH_MS and REFRESH_URGENT_MS
  for (let i = 0; i < GT_LIMIT_PER_MIN - PAGE_RESERVE - REFRESH_SLOT; i++) assert.equal(budget.take("lists"), true);
  assert.equal(budget.take("refresh"), true, "and one other held read: the window at the refresh lane's room");
  const ohlcv = () => gt.urls.filter((u) => u.includes("/ohlcv/")).length;
  const n = ohlcv();
  const held = await tok.candles(PUMP, "1m", before, 500);
  assert.equal(held.status, 200, held.body);
  assert.equal(ohlcv(), n, "the history held is not read again past the refresh lane's room");
  const cold = await tok.candles(COLD, "1m", null, 24);
  assert.equal(cold.status, 200, `the cold token's first read is served (${cold.body.slice(0, 80)})`);
});
