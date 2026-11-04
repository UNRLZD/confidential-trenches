// node --test apps/helper/src/data/evm/swaps-capacity.test.ts: Robinhood's swap reads fit a dozen cold tokens at once
// (card helper-robinhood-capacity). The wide providers (swaps.ts WIDE_SPAN) read a 3,000-block cold window in 3
// `eth_getLogs`, not 30, and take turns at being asked first; one hold per provider is kept by the swap reads, the maker
// reads and /v1/rpc/robinhood alike; and one rule says what a refusal is, never a limit on a read's size. Read live
// 2026-11-04: at c7e6f12 12 cold tokens at once took up to 36 s (drpc asked 539 times); with the wide providers first,
// up to 28 s; spread over them, 12 of 12 within 10.6 s.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../../test/evm-swaps/robinhood.ts";
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
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sends.set(url, (sends.get(url) ?? 0) + 1);
    const reqs = JSON.parse(String(init.body)) as { method: string }[];
    logs.set(url, (logs.get(url) ?? 0) + reqs.filter((r) => r.method === "eth_getLogs").length);
    await new Promise((r) => setTimeout(r, 1));
    return chain.fetch(url, init);
  };
  return { chain, logs, sends, fetch };
}
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

test("card helper-robinhood-capacity: 12 cold tokens at once, the chain's own RPC, blockvectra and pocket refusing every read: all 12 answer 200, in a tenth of the 100-block reads, each refusing provider sent no more than were out at once before its first refusal", async () => {
  const r = rig([CHAIN_RPC, BLOCKVECTRA, POCKET]);
  const s = open(r.chain, undefined, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
  const got = await Promise.all(TOKENS.map((t) => s.trades(t, 50)));
  s.stop();
  assert.deepEqual(got.map((a) => a.status), TOKENS.map(() => 200), got.map((a) => a.body.slice(0, 60)).join("\n"));
  assert.ok(JSON.parse(got.at(-1)!.body).trades.length > 0, "the recorded curve's tape is read");
  // a cold window is 30 spans of 100 blocks: 12 tokens' walks on two providers are 720 reads at 100 blocks a read
  const n = total(r.logs);
  assert.ok(n <= 200, `${n} eth_getLogs for 12 cold tokens (${[...r.logs].map(([u, k]) => `${new URL(u).host} ${k}`).join(", ")})`);
  for (const u of [CHAIN_RPC, BLOCKVECTRA, POCKET]) assert.ok((r.sends.get(u) ?? 0) <= INFLIGHT_MAX, `${u}: ${r.sends.get(u)} sends, more than INFLIGHT_MAX out before its first 429`);
  // the reads are spread over the wide providers left: neither takes nearly all of them
  const wide = WIDE.slice(0, 2).map((u) => r.logs.get(u) ?? 0);
  assert.ok(Math.max(...wide) < 0.8 * wide.reduce((a, b) => a + b, 0), `reads by provider ${wide.join(", ")}`);
});

test("card helper-robinhood-capacity: a block range limit is no refusal: the provider that answered it is asked again at once (before the card its 'limit exceeded' held it)", async () => {
  const r = rig([]);
  let ranged = 0;
  r.chain.st.faults.set(WIDE[0]!, { span: 1_000, refuse: () => (ranged++ === 0 ? Response.json([{ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "block range limit exceeded" } }]) : null) });
  const clock = { t: 7_000_000 };
  const s = open(r.chain, clock, { pools: new Map(), rpcs: WIDE.slice(0, 3), fetch: r.fetch as never });
  assert.equal((await s.trades(CURVE_TOKEN, 50)).status, 200);
  s.stop();
  assert.equal(ranged > 0, true);
  assert.ok((r.sends.get(WIDE[0]!) ?? 0) > 1, `asked ${r.sends.get(WIDE[0]!)} times: held after a range error`);
});

test("card helper-robinhood-capacity: a wide provider held a second is waited for, not passed over: daybreak and blockmachine each refusing their first read with a 1 s wait, 12 cold tokens' walks still go to the wide providers, not 100 blocks at a time to drpc (the local helper at 7c0e504, 2026-11-04 20:00Z: both held 1 s as the walks began, drpc then took 486 reads in 166 batches and tapes up to 30 s)", async () => {
  const r = rig([]);
  const once = () => {
    let n = 0;
    return () => (n++ === 0 ? Response.json([{ jsonrpc: "2.0", id: 0, error: { code: -32005, message: "rate limited" } }]) : null);
  };
  for (const u of WIDE.slice(0, 2)) r.chain.st.faults.set(u, { span: 1_000, refuse: once() });
  // the helper's clock runs with real time here, so a 1 s hold ends
  const t0 = performance.now();
  const clock = { get t() { return 9_000_000 + Math.round(performance.now() - t0); } };
  const s = open(r.chain, clock, { pools: new Map(), rpcs: SWAP_RPCS.robinhood, headerTimed: HEADER_TIMED, fetch: r.fetch as never });
  const got = await Promise.all(TOKENS.map((t) => s.trades(t, 50)));
  s.stop();
  assert.deepEqual(got.map((a) => a.status), TOKENS.map(() => 200));
  const drpc = r.logs.get("https://robinhood.drpc.org") ?? 0;
  assert.ok(drpc <= 30, `drpc asked ${drpc} eth_getLogs (${[...r.logs].map(([u, k]) => `${new URL(u).host} ${k}`).join(", ")})`);
});

test("card helper-robinhood-capacity: a wide provider refused mid-walk with a 1 s wait is asked again for what it missed, before a 100-block provider (the local helper at 95730cb, 2026-11-04 20:10Z: daybreak's one -32005 'rate limited' sent the walks it was in to drpc, 71 reads in 2 s)", async () => {
  const r = rig([]);
  let n = 0;
  r.chain.st.faults.set(WIDE[0]!, { span: 1_000, refuse: () => (n++ === 1 ? Response.json([{ jsonrpc: "2.0", id: 0, error: { code: -32005, message: "rate limited" } }]) : null) });
  r.chain.st.faults.set(POCKET, { span: 1_000 });
  const t0 = performance.now();
  const clock = { get t() { return 9_000_000 + Math.round(performance.now() - t0); } };
  const s = open(r.chain, clock, { pools: new Map(), rpcs: [WIDE[0]!, POCKET, "https://robinhood.drpc.org"], fetch: r.fetch as never });
  assert.equal((await s.trades(CURVE_TOKEN, 50)).status, 200);
  s.stop();
  assert.ok(n > 1, "daybreak refused once");
  assert.equal(r.logs.get("https://robinhood.drpc.org") ?? 0, 0, `${[...r.logs].map(([u, k]) => `${new URL(u).host} ${k}`).join(", ")}`);
});
