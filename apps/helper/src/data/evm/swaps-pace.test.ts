// node --test apps/helper/src/data/evm/swaps-pace.test.ts: one pace per provider (limits.ts PROVIDER_PACE, card
// helper-robinhood-capacity fold 2), drawn by the swap reads, the maker reads and /v1/rpc alike. A fake chain behind
// the real Robinhood providers refuses each one past the limit it was read to have (limits.ts PROVIDER_PACE's notes):
// daybreak past 4 calls at once or 60 posts in 5 s, blockmachine past 60 calls a minute, pocket past 1,200 a minute,
// drpc past 33 calls a second, the chain's own RPC past 3 posts a second. A dozen cold tokens at once, hooked v4 pools
// among them (every Pons token on Robinhood is one, so each span is two eth_getLogs), must be read with no provider
// refusing; and a caller of /v1/rpc/robinhood must not pay for the helper's own reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, POOL_CURVE, POOL_MAG, REC, URLS } from "../../../test/evm-swaps/robinhood.ts";
import { createRpc } from "../../rpc/rpc.ts";
import { CALLER_ROOM, PROVIDER_PACE, providerHolds } from "../../limits/limits.ts";
import { HEADER_TIMED, SWAP_RPCS, type Pool } from "./swaps.ts";

const [DAYBREAK, BLOCKMACHINE, POCKET, DRPC, , CHAIN_RPC] = SWAP_RPCS.robinhood as [string, string, string, string, string, string];
const WIDE = [DAYBREAK, BLOCKMACHINE, POCKET, CHAIN_RPC];
const HOOK = `0x${"5".repeat(36)}0044`; // an afterSwap hook with its return-delta flag (swaps.ts hookOf)

/** Each provider's limit as read, by sends in a window: [window ms, most units, unit, the refusal]. */
const LIMIT: Record<string, { ms: number; max: number; unit: "post" | "call"; at?: number }> = {
  [DAYBREAK]: { ms: 5_000, max: 60, unit: "post", at: 4 },
  [BLOCKMACHINE]: { ms: 60_000, max: 60, unit: "call" },
  [POCKET]: { ms: 60_000, max: 1_200, unit: "call" },
  [DRPC]: { ms: 1_000, max: 33, unit: "call" },
  [CHAIN_RPC]: { ms: 1_000, max: 3, unit: "post" },
};
function rig() {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  const sent = new Map<string, number[]>();
  const out = new Map<string, number>();
  const refused = new Map<string, number>();
  const logs = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { method: string }[];
    const calls = Array.isArray(reqs) ? reqs.length : 1;
    const l = LIMIT[url];
    const t = performance.now();
    const past = (sent.get(url) ?? []).filter((x) => x > t - (l?.ms ?? 0));
    const units = l?.unit === "post" ? 1 : calls;
    const now = (out.get(url) ?? 0) + calls;
    if (l !== undefined && (past.length + units > l.max || (l.at !== undefined && now > l.at))) {
      refused.set(url, (refused.get(url) ?? 0) + 1);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limited" } }), { status: 429, headers: { "retry-after": "10" } });
    }
    for (let k = 0; k < units; k++) past.push(t);
    sent.set(url, past);
    logs.set(url, (logs.get(url) ?? 0) + (Array.isArray(reqs) ? reqs : [reqs]).filter((r) => r.method === "eth_getLogs").length);
    out.set(url, now);
    try {
      await new Promise((go) => setTimeout(go, 40)); // a provider's answer takes a while, so posts overlap
      return await chain.fetch(url, init);
    } finally {
      out.set(url, (out.get(url) ?? 0) - calls);
    }
  };
  return { chain, fetch, refused, logs };
}
const realClock = () => {
  const t0 = performance.now();
  return { get t() { return 9_000_000 + Math.round(performance.now() - t0); } };
};
const show = (m: Map<string, number>) => [...m].map(([u, k]) => `${new URL(u).host} ${k}`).join(", ") || "none";

test("the pace: a bucket per provider, background reads leaving CALLER_ROOM of it for callers; a provider with no pace is never waited for", () => {
  const clock = { t: 1_000_000 };
  const h = providerHolds(() => clock.t);
  const p = PROVIDER_PACE[DAYBREAK]!;
  const floor = p.burst * CALLER_ROOM;
  let n = 0;
  while (h.take(DAYBREAK, 1, true) === 0) n++;
  assert.equal(n, Math.floor(p.burst - floor), "background takes down to the callers' room");
  assert.ok(h.take(DAYBREAK, 1, true) > 0);
  assert.equal(h.take(DAYBREAK, 1, false), 0, "a caller still has room");
  assert.ok(h.room(DAYBREAK) < 1);
  clock.t += 1_000;
  assert.equal(h.take(DAYBREAK, 1, true), 0, "a second later it has refilled");
  // a provider counted in calls takes a batch's calls; one that is not paced always answers 0
  const b = PROVIDER_PACE[POCKET]!;
  assert.equal(h.take(POCKET, 10, true), 0);
  assert.ok(Math.abs(h.room(POCKET) - (b.burst - 10) / b.burst) < 1e-9);
  for (let i = 0; i < 1_000; i++) assert.equal(h.take("https://unpaced.test", 10, true), 0);
  assert.equal(h.room("https://unpaced.test"), 1);
});

test("card helper-robinhood-capacity fold 2: 12 cold tokens at once, hooked v4 pools among them, against providers that refuse past their read limits: all 12 answer 200 and no provider refuses once; drpc (100 blocks a read) is the last resort", async () => {
  const r = rig();
  const clock = realClock();
  // five hooked v4 pools (two eth_getLogs a span: swaps and the hook's transfers), the curve, six tokens with no pool
  const hooked = Array.from({ length: 5 }, (_, i) => `0x${(0xb0000 + i).toString(16).padStart(40, "0")}`);
  const none = Array.from({ length: 6 }, (_, i) => `0x${(0xabc00 + i).toString(16).padStart(40, "0")}`);
  const pools = new Map<string, { pool: Pool; decimals: number }>([[CURVE_TOKEN, { pool: POOL_CURVE, decimals: 18 }], ...hooked.map((t) => [t, { pool: { ...POOL_MAG, token: t, hook: HOOK }, decimals: 18 }] as const)]);
  const holds = providerHolds(() => clock.t);
  const s = open(r.chain, clock, { pools, rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never, holds });
  const tokens = [...hooked, CURVE_TOKEN, ...none];
  const t0 = performance.now();
  const got = await Promise.all(tokens.map((t) => s.trades(t, 50)));
  const ms = performance.now() - t0;
  s.stop();
  assert.deepEqual(got.map((a) => a.status), tokens.map(() => 200), got.map((a) => a.body.slice(0, 60)).join("\n"));
  for (const t of [...hooked, CURVE_TOKEN]) assert.ok(JSON.parse(got[tokens.indexOf(t)]!.body).trades.length > 0, `${t}: a tape`);
  assert.equal(r.refused.size, 0, `refused: ${show(r.refused)} (eth_getLogs ${show(r.logs)})`);
  const drpc = r.logs.get(DRPC) ?? 0;
  const wide = WIDE.reduce((n, u) => n + (r.logs.get(u) ?? 0), 0);
  assert.ok(drpc <= wide / 4, `drpc ${drpc} eth_getLogs, the wide providers ${wide} (${show(r.logs)})`);
  assert.ok(ms < 15_000, `${Math.round(ms)} ms`);
});

test("card helper-robinhood-capacity fold 2: a caller of /v1/rpc/robinhood never pays for the helper's own reads: the chain's own RPC held by a background read sends the call to a pinned provider (200); a caller has room the background reads left; a 429 only when no provider can take it, with the soonest wait", async () => {
  const clock = { t: 5_000_000 };
  const holds = providerHolds(() => clock.t);
  const asked: string[] = [];
  let refuse = new Set<string>();
  const fetch = async (url: string) => {
    asked.push(url);
    if (refuse.has(url)) return new Response("{}", { status: 429, headers: { "retry-after": "20" } });
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x10" });
  };
  const rpc = createRpc({}, { now: () => clock.t, holds, fetch: fetch as never, pinned: SWAP_RPCS, log: () => {} });
  const call = () => rpc.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), "198.51.100.7");
  // the background reads drain the chain's own RPC down to the callers' room: the caller still goes there
  while (holds.take(CHAIN_RPC, 1, true) === 0);
  let a = await call();
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(asked, [CHAIN_RPC]);
  // a background read met the chain's own RPC's 429: the caller is answered by the next pinned provider
  holds.hold(CHAIN_RPC, 30);
  asked.length = 0;
  a = await call();
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(asked, [DAYBREAK]);
  // the provider asked refuses the caller's read: it is held for every path and the next answers, still no 429
  refuse = new Set([DAYBREAK]);
  asked.length = 0;
  a = await call();
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(asked, [DAYBREAK, BLOCKMACHINE]);
  assert.ok(holds.heldFor(DAYBREAK) >= 19);
  // every provider held: 429 with the soonest wait any names
  for (const u of SWAP_RPCS.robinhood) if (u !== CHAIN_RPC) holds.hold(u, 40);
  clock.t += 25_000; // the chain's own RPC 5 s left, every other 15 s
  asked.length = 0;
  a = await call();
  assert.equal(a.status, 429, a.body);
  assert.deepEqual(asked, [], "nothing sent to a held provider");
  assert.equal(a.headers?.["Retry-After"], "5");
});

test("card helper-robinhood-capacity fold 3: every provider's bucket spent at once (each read passed at PACE_WAIT_MAX_MS everywhere, as on the loaded box) still answers 200: a read fails on a refusal or a disagreement, never on the pace alone", async () => {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  const clock = realClock();
  const tight = { perS: 3, burst: 3, unit: "post" as const };
  const holds = providerHolds(() => clock.t, Object.fromEntries(URLS.map((u) => [u, tight])));
  const s = open(chain, clock, { pools: new Map([[CURVE_TOKEN, { pool: POOL_CURVE, decimals: 18 }]]), fetch: chain.fetch, holds });
  const got = await Promise.all([s.trades(CURVE_TOKEN, 50), s.trades(CURVE_TOKEN, 50)]);
  s.stop();
  for (const a of got) assert.equal(a.status, 200, a.body);
  assert.ok(JSON.parse(got[0]!.body).trades.length > 0);
});
