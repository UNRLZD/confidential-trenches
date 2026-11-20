// node --test apps/helper/src/data/evm/swaps-parse-slot.test.ts: card helper-parse-turn-outside-the-slot. A provider's
// answer waits its parse turn (limits/turn.ts, card helper-loop-never-held-by-a-read) out of `out`, so latencyOf and
// hedged never read an answer in hand as one a provider is late with; before, past HEDGE_MS a herd's parse turns sent
// the read to a third provider while the answers sat waiting to be parsed. Its in-flight place (slot, INFLIGHT_MAX) is
// held to the parse: the cap on posts out is also the cap on answers read and waiting (freed at the answer, the burst's
// answers landed together: helper-answers-through-a-burst on a mainnet copy, p99 4597 and 5106 ms, FAIL).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { onVirtualTime } from "../../../test/evm-swaps/virtual-time.ts";
import { providerHolds } from "../../limits/limits.ts";
import { HEDGE_MS, INFLIGHT_MAX } from "./swaps.ts";

/** A provider that takes one request a post (swaps.ts BATCH_SIZE: api.blockvectra.com), so a walk's spans are posts. */
const ONE = "https://api.blockvectra.com/v1/robinhood_mainnet/public";
const RPCS = ["https://a.test", ONE, "https://c.test"];

/**
 * A cold open whose parse turns are shut from the first eth_getLogs post on: every answer from then waits for its turn
 * until `open()`. `closed` counts, per provider, the eth_getLogs posts sent while shut; `asked`, for each eth_getLogs span
 * (its filter and blocks), the providers it was sent to while shut, in order; `out` and `peak` the posts out to ONE
 * (sent, unanswered) now and at most. `garble`: ONE answers every eth_getLogs post 200 with a body that is no JSON,
 * so its parse throws.
 */
function rig(garble = false) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead; // the discovery walks the cold window for transfers: a step of spans, a post each to ONE
  const gate = { shut: false, opened: false, waiting: [] as (() => void)[] };
  const pass = (): Promise<void> | null => (gate.shut && !gate.opened ? new Promise<void>((go) => gate.waiting.push(go)) : null);
  const st = { closed: new Map<string, number>(), asked: new Map<string, string[]>(), out: 0, peak: 0 };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const reqs = JSON.parse(String(init.body)) as { method: string; params: unknown[] }[];
    const logs = reqs.some((r) => r.method === "eth_getLogs");
    if (logs && !gate.opened) gate.shut = true;
    if (logs && gate.shut && !gate.opened) {
      st.closed.set(url, (st.closed.get(url) ?? 0) + 1);
      for (const r of reqs.filter((x) => x.method === "eth_getLogs")) {
        const span = JSON.stringify(r.params[0]);
        const by = st.asked.get(span) ?? [];
        if (!by.includes(url)) by.push(url);
        st.asked.set(span, by);
      }
    }
    if (url === ONE) st.peak = Math.max(st.peak, ++st.out);
    try {
      await new Promise((r) => setTimeout(r, 3));
      if (garble && logs && url === ONE) return new Response(`[{"jsonrpc":"2.0","id":0,"result":[`, { status: 200, headers: { "content-type": "application/json" } });
      return await chain.fetch(url, init);
    } finally {
      if (url === ONE) st.out--;
    }
  };
  const clock = { t: 5_000_000 };
  // ONE has the most free budget, so a walk asks it first and its spans queue behind INFLIGHT_MAX (swaps-hold.test.ts)
  const holds = providerHolds(() => clock.t, { [ONE]: { perS: 1_000, burst: 1_000, unit: "post" } });
  const s = open(chain, clock, { pools: new Map(), rpcs: RPCS, fetch: fetch as never, holds, pass });
  const openGate = (): void => {
    gate.opened = true;
    for (const go of gate.waiting.splice(0)) go();
  };
  return { s, st, gate, openGate };
}

test(`a post answered while parse turns queue is counted answered, its place held to the parse: with every turn shut ${HEDGE_MS * 2} ms, no span of the walk goes to a provider beyond the two it was first asked of (no hedge), and ONE is sent no more than INFLIGHT_MAX of the walk's posts (red at 2d1c955f9: past HEDGE_MS the answered posts read as late, and c.test was sent the spans as a third provider)`, async () => {
  const { s, st, gate, openGate } = rig();
  try {
    const { value } = await onVirtualTime(1_793_918_000_000, async () => {
      const read = s.trades(CURVE_TOKEN, 50);
      while (!gate.shut) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, HEDGE_MS * 2));
      const shut = Object.fromEntries(st.closed);
      // a span's first round is two providers (agreed: order.slice(0, 2)); a third is asked only when a read out reads as
      // late (hedged) or the two disagree, and while every answer waits its parse none can disagree
      const hedged = [...st.asked].filter(([, by]) => by.length > 2).map(([span, by]) => `${span} to ${by.join(", ")}`);
      openGate();
      const r = await read;
      return { shut, hedged, spans: st.asked.size, r };
    });
    console.log(`eth_getLogs posts sent while the parse turns were shut: ${JSON.stringify(value.shut)}; spans ${value.spans}, sent past their first two providers: ${value.hedged.length}; most out to ONE at once ${st.peak}`);
    assert.equal(value.r.status, 200, value.r.body);
    assert.ok((value.shut[ONE] ?? 0) <= INFLIGHT_MAX, `${value.shut[ONE] ?? 0} of the walk's posts reached ONE while its answers waited to parse: the cap on answers read and waiting`);
    assert.ok(st.peak <= INFLIGHT_MAX, `${st.peak} out to ONE at once`);
    assert.ok(value.spans > 0, "the walk's spans were sent while the parse turns were shut");
    assert.deepEqual(value.hedged, [], "a span sent to a third provider while its answers waited to parse: a hedge on answered posts");
  } finally {
    s.stop();
  }
});

/** A cold open of the curve token on the rig, the parse turns shut HEDGE_MS * 2 from the walk's first post. */
async function shutOpen(garble: boolean) {
  const { s, st, gate, openGate } = rig(garble);
  try {
    const { value } = await onVirtualTime(1_793_918_000_000, async () => {
      const read = s.trades(CURVE_TOKEN, 50);
      while (!gate.shut) await new Promise((r) => setTimeout(r, 1));
      await new Promise((r) => setTimeout(r, HEDGE_MS * 2));
      openGate();
      return await read;
    });
    return { r: value, st };
  } finally {
    s.stop();
  }
}

test("an answer whose parse throws after its turn is still that provider's failed read: ONE's every eth_getLogs answer no JSON, the tape is the other providers' agreed one, the same as when ONE answers right", async () => {
  const good = await shutOpen(false);
  const bad = await shutOpen(true);
  assert.equal(good.r.status, 200, good.r.body);
  assert.equal(bad.r.status, 200, bad.r.body);
  const txs = (r: { body: string }) => (JSON.parse(r.body) as { trades: { tx: string }[] }).trades.map((t) => t.tx);
  assert.ok(txs(good.r).length > 0, "the tape holds trades");
  assert.deepEqual(txs(bad.r), txs(good.r), "the tape a provider that answers no JSON leaves");
  assert.ok((bad.st.closed.get("https://c.test") ?? 0) + (bad.st.closed.get("https://a.test") ?? 0) > 0, "the reads went to the other providers");
});
