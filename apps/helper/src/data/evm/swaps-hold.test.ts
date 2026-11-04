// node --test apps/helper/src/data/evm/swaps-hold.test.ts: a provider's wait holds every read to it (swaps.ts one(),
// card helper-rpc-hold-queued). Reads queued behind INFLIGHT_MAX before the provider refused (its HTTP 429, a JSON-RPC
// -32005 or limit message) send nothing while it holds; a shorter wait never cuts a longer one; at its end the queued
// reads go again in order; the other providers' reads go on throughout. Read on the helper box 2026-11-04 18:55Z: the
// chain's own Robinhood RPC answered a batch 429 and seven more batches queued before it were sent within the next
// 190 ms, and the box's address stayed throttled (10 of 10 probes 429 at one a second; 6 of 6 from another address 200).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { INFLIGHT_MAX, VENUES } from "./swaps.ts";

/** A provider that takes one request per batch (swaps.ts BATCH_SIZE: api.blockvectra.com), so a walk queues its spans. */
const ONE = "https://api.blockvectra.com/v1/robinhood_mainnet/public";
const RPCS = ["https://a.test", ONE, "https://c.test"];

type Refusal = { status: number; headers?: Record<string, string>; body?: unknown };
const http429 = (s: number): Refusal => ({ status: 429, headers: { "retry-after": String(s) } });
const rpcError = (error: Record<string, unknown>): Refusal => ({ status: 200, body: [{ jsonrpc: "2.0", id: 0, error }] });

/**
 * The fake chain behind RPCS, with ONE answering its k-th `eth_getLogs` with `refusals[k]` (each after a few ms, so
 * INFLIGHT_MAX are out at once and the rest queue). `sendsAfter` counts ONE's sends that start after its first refusal
 * was answered; `order` is each `eth_getLogs` ONE was sent, as sent: its filter (address and pool id) and fromBlock;
 * `peak` the most out to ONE at once.
 */
function rig(refusals: Refusal[]) {
  const chain = fakeChain();
  const st = { refused: false, sendsAfter: 0, logsSeen: 0, order: [] as [string, number][], out: 0, peak: 0, peers: 0, peersAfter: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { method: string; params: { address?: string; topics?: unknown[]; fromBlock?: string }[] }[];
    if (url !== ONE) {
      st.peers++;
      if (st.refused) st.peersAfter++;
      return chain.fetch(url, init);
    }
    if (st.refused) st.sendsAfter++;
    const q = reqs[0]!.params[0]!;
    if (reqs[0]!.method === "eth_getLogs") st.order.push([`${q.address}:${String(q.topics?.[1] ?? "")}`, parseInt(q.fromBlock!, 16)]);
    st.out++;
    st.peak = Math.max(st.peak, st.out);
    try {
      await new Promise((r) => setTimeout(r, 3));
      if (reqs[0]!.method !== "eth_getLogs") return await chain.fetch(url, init);
      const k = st.logsSeen++;
      const f = refusals[k];
      if (f === undefined) return await chain.fetch(url, init);
      // the second refusal is answered after the first, while both were out before either answered
      if (k > 0) await new Promise((r) => setTimeout(r, 3));
      st.refused = true;
      return new Response(f.body === undefined ? "{}" : JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json", ...f.headers } });
    } finally {
      st.out--;
    }
  };
  chain.st.head = REC.lastHead; // the discovery walks the cold window for transfers (the fake has none): a step of spans
  const clock = { t: 5_000_000 };
  const s = open(chain, clock, { pools: new Map(), rpcs: RPCS, fetch: fetch as never });
  return { s, st, chain, clock };
}

for (const [name, refusal] of [
  ["an HTTP 429 (Retry-After 30)", http429(30)],
  ["a JSON-RPC -32005 (backoff_seconds 30)", rpcError({ code: -32005, message: "limit exceeded", data: { backoff_seconds: 30 } })],
  ["a JSON-RPC limit message (no code we know, 1 s)", rpcError({ code: -32000, message: "request limit reached" })],
] as const) {
  test(`card helper-rpc-hold-queued: after ${name}, no read queued to that provider is sent while it holds; the other providers answer the read`, async () => {
    const { s, st } = rig([refusal]);
    const r = await s.trades(CURVE_TOKEN, 50);
    s.stop();
    assert.ok(st.logsSeen >= 1 && st.refused, "the provider refused a read");
    assert.equal(st.sendsAfter, 0, `${st.sendsAfter} reads sent to the provider while it held`);
    assert.equal(r.status, 200, r.body);
    assert.ok(st.peersAfter > 0, "the other providers were asked after the refusal");
  });
}

test("card helper-rpc-hold-queued: a shorter 429 never cuts a longer hold, and at the longer one's end the provider's reads go again, in order and at most INFLIGHT_MAX at once", async () => {
  // two reads out at once, both refused: the first names 30 s, the second (answered later) 1 s
  const { s, st, chain, clock } = rig([http429(30), http429(1)]);
  const r = await s.trades(CURVE_TOKEN, 50);
  assert.equal(r.status, 200, r.body);
  assert.ok(st.logsSeen >= 2, "both refusals answered");
  assert.equal(st.sendsAfter, 0, `${st.sendsAfter} reads sent while held`);

  // 2 s on: the 1 s wait is over, the 30 s one is not; a tick with a step of new blocks asks the others only
  clock.t += 2_000;
  chain.st.head += VENUES.robinhood.step;
  const before = st.order.length;
  await s.tick();
  assert.equal(st.sendsAfter, 0, "asked inside the longer hold");

  // past 30 s: a step of new blocks is read again from the provider, its spans in the order they were queued
  clock.t += 29_000;
  chain.st.head += VENUES.robinhood.step;
  st.peak = 0;
  await s.tick();
  s.stop();
  const again = st.order.slice(before);
  assert.ok(again.length > INFLIGHT_MAX, `${again.length} spans read again: more than go at once, so some were queued`);
  // each filter's spans are queued lowest block first (agreedRange): sent in that order
  for (const f of new Set(again.map(([k]) => k))) {
    const blocks = again.filter(([k]) => k === f).map(([, b]) => b);
    assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b), `${f}: sent in the order queued`);
  }
  assert.ok(st.peak <= INFLIGHT_MAX, `${st.peak} out at once`);
});
