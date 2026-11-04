// node --test apps/helper/src/rpc/crowd.test.ts (card helper-crowd-429): the live suite's crowd against the keyed Solana
// provider's per-second limit, with no caller 429. Helper live run 41911437956 on b07b71a, the helper's own log:
//   20:57:47.846Z rpc hold solana background 1 s   (the trade walks, sent to the same Helius key unpaced)
//   20:57:50.951Z rpc hold solana caller 1 s       (a caller's read throttled in turn: the chain held for every caller)
//   20:58:00.340Z refused /v1/rpc solana held 3 in 10 s                 (wallet-per-buy's 3 of 66)
//   20:58:11.764Z refused /v1/market/holders solana provider 429 1 in 10 s  (market-data-solana-token's holders)
// Each test runs in real time against a provider in memory that keeps Helius free's 10 requests a second, every clock
// the monotonic one (`mono`): the box's wall clock steps back by up to 8 s under a test (traced 4 Nov 22:14Z), and a
// provider window or a hold on it measures the step, not the helper.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc } from "./rpc.ts";

const KEY = "fake-helius-key-0123456789abcdef";
const URL_KEYED = `https://mainnet.helius-rpc.invalid/?api-key=${KEY}`;
const JSON_T = "application/json";
/** A monotonic clock in epoch ms: the helper's budgets and holds on it, as the provider's window. */
const mono = (): number => performance.timeOrigin + performance.now();
const read = (id: number, method = "getBalance") => JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });

/** Helius free in memory: past `perSecond` requests in any 1 s it answers 429 with no Retry-After (Helius names none:
 *  the helper reads that as 1 s); `first429` answers the first N requests 429 whatever the count (a crowd's burst the
 *  helper did not send, or the provider's own counting). */
function provider(perSecond: number, first429 = 0) {
  const p = { calls: 0, throttled: 0, sent: [] as number[], all: [] as number[], ids: [] as unknown[] };
  const fetch = async (_u: string, init: RequestInit): Promise<Response> => {
    const t = mono();
    const body = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
    const n = Array.isArray(body) ? body.length : 1;
    p.sent = p.sent.filter((x) => x > t - 1000);
    for (let i = 0; i < n; i++) p.sent.push(t), p.all.push(t);
    p.calls += n;
    p.ids.push(Array.isArray(body) ? body.map((b) => b.id) : body.id);
    if (p.calls <= first429 || p.sent.length > perSecond) return (p.throttled++, new Response("slow down", { status: 429 }));
    const one = (r: { id: unknown }) => ({ jsonrpc: "2.0", id: r.id, result: 1 });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": JSON_T } });
  };
  return { p, fetch };
}
/** The most requests the provider saw in any 1 s. */
const peak = (sent: number[]): number => Math.max(0, ...sent.map((t) => sent.filter((x) => x >= t && x < t + 1000).length));

test("card helper-crowd-429: the trade walks' sends to the keyed provider callers use are paced with the callers' own, behind them, so a crowd of callers and walks at once never passes the provider's second and no caller gets a 429", async () => {
  const pv = provider(10);
  const lines: string[] = [];
  const r = createRpc({ SOLANA_RPC_URL: URL_KEYED, RPC_BUDGET_SOLANA: "100,16" }, { fetch: pv.fetch as never, log: (l) => lines.push(l), now: mono });
  // a walk as data/solana/trades.ts sends it: the budget's word first (a wait skips this provider for the next, the
  // public one, not counted here), then its own fetch of the same URL, its 429 told back
  const walk = async (i: number): Promise<number | "skipped"> => {
    if (r.background("solana", URL_KEYED, "getTransaction") > 0) return "skipped";
    const res = await pv.fetch(URL_KEYED, { method: "POST", body: read(1000 + i, "getTransaction") } as RequestInit);
    if (res.status === 429) r.backgroundThrottled("solana", URL_KEYED, res.headers);
    return res.status;
  };
  // a restart's cold walks (12 at once) and the live suite's callers in the same tick (10 checks' reads, each its own runner)
  const walks = Array.from({ length: 12 }, (_, i) => walk(i));
  const callers = Array.from({ length: 10 }, (_, i) => r.handle("solana", JSON_T, read(i + 1), `198.51.100.${i}`));
  const answers = await Promise.all(callers);
  const walked = await Promise.all(walks);
  const rel = pv.p.all.map((x, k) => `${Math.round(x - pv.p.all[0]!)}#${String(pv.p.ids[k])}`).join(",");
  assert.equal(pv.p.throttled, 0, `the provider never throttled (peak ${peak(pv.p.all)} in a second, ${walked.filter((w) => w === "skipped").length} walks skipped to the next provider; sends at ms ${rel})`);
  assert.ok(peak(pv.p.all) <= 10, `peak ${peak(pv.p.all)} in a second`);
  assert.deepEqual(answers.map((a) => a.status), Array(10).fill(200), `every caller served: ${answers.map((a) => `${a.status} ${a.why ?? ""}`).join(", ")}`);
  assert.deepEqual(lines.filter((l) => l.startsWith("rpc hold")), [], "no hold");
  assert.ok(walked.filter((w) => w === 200).length >= 1, "the walks still go, in the room the callers leave");
});

test("card helper-crowd-429: a provider's 1 s hold is waited out by every caller inside it, the throttled one resent, and their sends paced from its end, so the live suite's crowd (17 checks at once) gets no 429", async () => {
  // the first send is throttled (Retry-After none: 1 s), as at 20:57:50.951Z; then Helius free's 10 a second
  const pv = provider(10, 1);
  const lines: string[] = [];
  const r = createRpc({ SOLANA_RPC_URL: URL_KEYED, RPC_BUDGET_SOLANA: "100,16" }, { fetch: pv.fetch as never, log: (l) => lines.push(l), now: mono });
  const t0 = mono();
  const first = r.handle("solana", JSON_T, read(1), "198.51.100.200");
  await new Promise((ok) => setTimeout(ok, 50)); // its 429 is in: the chain is held
  // the suite's checks arriving inside the hold, each its own runner, one read each
  const crowd = Array.from({ length: 16 }, (_, i) => r.handle("solana", JSON_T, read(i + 2, i % 2 === 0 ? "getBalance" : "getTokenAccountsByOwner"), `198.51.100.${i}`));
  const answers = [await first, ...(await Promise.all(crowd))];
  const ms = mono() - t0;
  assert.deepEqual(answers.map((a) => a.status), Array(17).fill(200), `every caller served: ${answers.map((a) => `${a.status} ${a.why ?? ""}`).join(", ")}`);
  assert.equal(pv.p.throttled, 1, "only the planted 429: the sends after the hold kept the provider's second");
  assert.ok(peak(pv.p.all.slice(1)) <= 10, `peak ${peak(pv.p.all.slice(1))} in a second after the hold`);
  assert.ok(ms < 1_000 + 2_000 + 500, `${ms} ms: within the hold and PACE_MAX_MS`);
  assert.deepEqual(lines.filter((l) => l.startsWith("rpc hold")), ["rpc hold solana caller 1 s"]);
});

test("card helper-crowd-429: a hold past PACE_MAX_MS is still the caller's 429 with its seconds, never a wait past the route's time", async () => {
  const fetch = async (): Promise<Response> => new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  const r = createRpc({ SOLANA_RPC_URL: URL_KEYED, RPC_BUDGET_SOLANA: "100,16" }, { fetch: fetch as never, log: () => {}, now: mono });
  const t0 = mono();
  const a = await r.handle("solana", JSON_T, read(1), "198.51.100.1");
  const b = await r.handle("solana", JSON_T, read(2), "198.51.100.2");
  assert.ok(mono() - t0 < 500, "nothing waited");
  assert.deepEqual([a.status, a.why, b.status, b.why], [429, "solana provider 429", 429, "solana held"]);
  assert.ok(Number(b.headers?.["Retry-After"]) >= 29);
});

test("card helper-crowd-429: two RPC clients on one keyed URL (SOLANA_HOLDERS_RPC_URL set to SOLANA_RPC_URL's key) share one pacer, so together they keep its second", async () => {
  const pv = provider(10);
  const main = createRpc({ SOLANA_RPC_URL: URL_KEYED, RPC_BUDGET_SOLANA: "100,16" }, { fetch: pv.fetch as never, log: () => {}, now: mono });
  const holders = createRpc({ SOLANA_RPC_URL: URL_KEYED }, { fetch: pv.fetch as never, log: () => {}, slot: "holders", publicFallback: false, pacer: main.pacer, now: mono });
  const all = await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => main.handle("solana", JSON_T, read(i + 1), `198.51.100.${i}`)),
    ...Array.from({ length: 8 }, (_, i) => holders.handle("solana", JSON_T, read(i + 1, "getTokenLargestAccounts"), `203.0.113.${i}`)),
  ]);
  assert.equal(pv.p.throttled, 0, `peak ${peak(pv.p.all)} in a second`);
  assert.deepEqual(all.map((a) => a.status), Array(16).fill(200));
});
