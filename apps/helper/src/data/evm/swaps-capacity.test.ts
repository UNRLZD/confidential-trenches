// node --test apps/helper/src/data/evm/swaps-capacity.test.ts: Robinhood's swap reads fit a dozen cold tokens at once
// (card helper-robinhood-capacity). The wide providers (swaps.ts WIDE_SPAN) read a 3,000-block cold window in 3
// `eth_getLogs`, not 30, and take turns at being asked first; one hold per provider is kept by the swap reads, the maker
// reads and /v1/rpc/robinhood alike; and one rule says what a refusal is, never a limit on a read's size. Read live
// 2026-11-04: at c7e6f12 12 cold tokens at once took up to 36 s (drpc asked 539 times); with the wide providers first,
// up to 28 s; spread over them, 12 of 12 within 10.6 s. Fold 2 paces each provider under its limit (swaps-pace.test.ts),
// so the two tests of a 1 s hold waited out (HOLD_WAIT_S, gone) are replaced there: no provider refuses to begin with.
// With pocket and the chain's own RPC refusing, the wide providers left are daybreak and blockmachine, whose own header
// says 60 calls a minute: the first test's bound of 200 reads spread over the two (cd22743) held only while blockmachine
// was asked past that, so it now holds each provider left to its pace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
import { PROVIDER_PACE, providerHolds } from "../../limits/limits.ts";
import { HEADER_TIMED, INFLIGHT_MAX, SWAP_RPCS } from "./swaps.ts";

const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
const BLOCKVECTRA = "https://api.blockvectra.com/v1/robinhood_mainnet/public";
const POCKET = "https://robinhood.api.pocket.network";
const WIDE = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", POCKET, CHAIN_RPC];
const http429 = (s = 30) => new Response("{}", { status: 429, headers: { "retry-after": String(s) } });
/** Eleven tokens no recorded pool has (each walks the whole cold window and answers 200 empty) and the recorded curve. */
const TOKENS = [...Array.from({ length: 11 }, (_, i) => `0x${(0xabc00 + i).toString(16).padStart(40, "0")}`), CURVE_TOKEN];

/** The fake chain behind the real Robinhood provider list: the wide providers take 1,000 blocks; `refusing` answer 429
 *  every time. Counts each provider's `eth_getLogs` calls (a batch counts each) and every request sent. */
function rig(refusing: string[]) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  for (const u of WIDE) chain.st.faults.set(u, { span: 1_000 });
  for (const u of refusing) chain.st.faults.set(u, { ...chain.st.faults.get(u), refuse: () => http429() });
  const logs = new Map<string, number>();
  const sends = new Map<string, number>();
  const calls = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sends.set(url, (sends.get(url) ?? 0) + 1);
    const reqs = JSON.parse(String(init.body)) as { method: string }[];
    calls.set(url, (calls.get(url) ?? 0) + reqs.length);
    logs.set(url, (logs.get(url) ?? 0) + reqs.filter((r) => r.method === "eth_getLogs").length);
    await new Promise((r) => setTimeout(r, 1));
    return chain.fetch(url, init);
  };
  return { chain, logs, sends, calls, fetch };
}

test("card helper-robinhood-capacity: 12 cold tokens at once, the chain's own RPC, blockvectra and pocket refusing every read: all 12 answer 200, each refusing provider sent no more than were out at once before its first refusal, and each provider left is asked within its pace", async () => {
  const r = rig([CHAIN_RPC, BLOCKVECTRA, POCKET]);
  // the helper's clock runs with real time, so the providers' paces (limits.ts PROVIDER_PACE) refill
  const t0 = performance.now();
  const clock = { get t() { return 9_000_000 + Math.round(performance.now() - t0); } };
  const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
  const got = await Promise.all(TOKENS.map((t) => s.trades(t, 50)));
  s.stop();
  assert.deepEqual(got.map((a) => a.status), TOKENS.map(() => 200), got.map((a) => a.body.slice(0, 60)).join("\n"));
  assert.ok(JSON.parse(got.at(-1)!.body).trades.length > 0, "the recorded curve's tape is read");
  const s_ = (performance.now() - t0) / 1000;
  for (const u of [CHAIN_RPC, BLOCKVECTRA, POCKET]) assert.ok((r.sends.get(u) ?? 0) <= INFLIGHT_MAX, `${u}: ${r.sends.get(u)} sends, more than INFLIGHT_MAX out before its first 429`);
  // each provider left within its pace: a bucket's burst and its refill over the run
  for (const [u, p] of Object.entries(PROVIDER_PACE)) {
    if ([CHAIN_RPC, POCKET].includes(u)) continue;
    const sent = p.unit === "post" ? (r.sends.get(u) ?? 0) : (r.calls.get(u) ?? 0);
    assert.ok(sent <= p.burst + p.perS * s_, `${new URL(u).host}: ${sent} ${p.unit}s in ${s_.toFixed(1)} s, past its pace (${[...r.logs].map(([v, k]) => `${new URL(v).host} ${k}`).join(", ")})`);
  }
});

test("card helper-robinhood-capacity: a block range limit is no refusal: the provider that answered it is asked again at once (before the card its 'limit exceeded' held it)", async () => {
  const r = rig([]);
  let ranged = 0;
  // pocket, asked in the first pair: the provider is incidental to the rule, and by expected wait (fold 4) daybreak, one
  // request a post, is asked a cold window's spans after the batching ones, which agree first
  r.chain.st.faults.set(POCKET, { span: 1_000, refuse: () => (ranged++ === 0 ? Response.json([{ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "block range limit exceeded" } }]) : null) });
  const clock = { t: 7_000_000 };
  const holds = providerHolds(() => clock.t);
  const s = open(r.chain, clock, { pools: new Map(), rpcs: WIDE.slice(0, 3), fetch: r.fetch as never, holds });
  assert.equal((await s.trades(CURVE_TOKEN, 50)).status, 200);
  s.stop();
  assert.equal(ranged > 0, true);
  assert.equal(holds.heldFor(POCKET), 0, "held after a range error");
  assert.ok((r.sends.get(POCKET) ?? 0) > 1, `asked ${r.sends.get(POCKET)} times: held after a range error`);
});
