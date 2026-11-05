// node --test apps/helper/src/limits/holds.test.ts: one hold per provider and one rule for a refusal (limits.ts
// providerHolds, evmThrottleS; card helper-robinhood-capacity), kept alike by the swap reads (data/evm/swaps.ts), the
// maker reads (data/evm/lists.ts heldFetch) and /v1/rpc/robinhood (rpc/rpc.ts), which all read
// rpc.mainnet.chain.robinhood.com from the helper's one address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CURVE_TOKEN, fakeChain, open, REC } from "../../test/evm-swaps/robinhood.ts";
import { heldFetch } from "../data/evm/lists.ts";
import { HEADER_TIMED } from "../data/evm/swaps.ts";
import { createRpc } from "../rpc/rpc.ts";
import { evmThrottleS, providerHolds } from "./limits.ts";

const CHAIN_RPC = "https://rpc.mainnet.chain.robinhood.com";
const WIDE = ["https://robinhood.daybreak-rpc.network", "https://rpc-robinhood.blockmachine.io", "https://robinhood.api.pocket.network"];
const http429 = (s = 30) => new Response("{}", { status: 429, headers: { "retry-after": String(s) } });
function rig(refusing: string[]) {
  const chain = fakeChain();
  chain.st.head = REC.lastHead;
  for (const u of [...WIDE, CHAIN_RPC]) chain.st.faults.set(u, { span: 1_000 });
  for (const u of refusing) chain.st.faults.set(u, { ...chain.st.faults.get(u), refuse: () => http429() });
  const sends = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (sends.set(url, (sends.get(url) ?? 0) + 1), chain.fetch(url, init));
  return { chain, sends, fetch };
}
const blockNumber = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

test("card helper-robinhood-capacity: one hold per provider: a 429 the swap reads met holds /v1/rpc/robinhood and the maker reads, and a 429 /v1/rpc/robinhood met holds the swap reads", async () => {
  const clock = { t: 9_000_000 };
  const holds = providerHolds(() => clock.t);
  // the swap reads meet the chain's own RPC's 429 (it is asked first here)
  const r = rig([CHAIN_RPC]);
  const s = open(r.chain, clock, { pools: new Map(), rpcs: [CHAIN_RPC, ...WIDE], headerTimed: HEADER_TIMED, fetch: r.fetch as never, holds });
  assert.equal((await s.trades(CURVE_TOKEN, 50)).status, 200);
  s.stop();
  assert.ok(holds.heldFor(CHAIN_RPC) >= 29, `held ${holds.heldFor(CHAIN_RPC)} s`);
  let rpcSends = 0;
  const rpc = createRpc({}, { now: () => clock.t, holds, fetch: (async () => (rpcSends++, Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" }))) as never });
  const a = await rpc.handle("robinhood", "application/json", blockNumber, "198.51.100.1");
  assert.equal(a.status, 429, a.body);
  assert.ok(Number(a.headers?.["Retry-After"]) >= 29, `Retry-After ${a.headers?.["Retry-After"]}`);
  assert.equal(rpcSends, 0, "a caller's read went to the held provider");
  let makerSends = 0;
  const maker = heldFetch((async () => (makerSends++, Response.json([]))) as never, holds, () => clock.t);
  assert.equal((await maker(CHAIN_RPC, { method: "POST", body: "[]" })).status, 429);
  assert.equal(makerSends, 0, "a maker read went to the held provider");

  // the other way: /v1/rpc/robinhood meets the 429, and the swap reads send it nothing
  const clock2 = { t: 9_000_000 };
  const holds2 = providerHolds(() => clock2.t);
  const rpc2 = createRpc({}, { now: () => clock2.t, holds: holds2, fetch: (async () => http429(20)) as never });
  assert.equal((await rpc2.handle("robinhood", "application/json", blockNumber, "198.51.100.2")).status, 429);
  const r2 = rig([]);
  const s2 = open(r2.chain, clock2, { pools: new Map(), rpcs: [CHAIN_RPC, ...WIDE], headerTimed: HEADER_TIMED, fetch: r2.fetch as never, holds: holds2 });
  assert.equal((await s2.trades(CURVE_TOKEN, 50)).status, 200);
  s2.stop();
  assert.equal(r2.sends.get(CHAIN_RPC) ?? 0, 0, "the swap reads asked the provider /v1/rpc/robinhood was told to wait for");
});

test("card helper-robinhood-capacity: one rule for a refusal: -32005 or a rate or request limit message, in rpc.ts as in the swap and maker reads; a limit on a read's size never", async () => {
  const cases: [string, unknown, number][] = [
    ["-32005 with backoff_seconds 7", { code: -32005, message: "limit exceeded", data: { backoff_seconds: 7 } }, 7],
    ["mainnet.base.org's request limit (no code we know)", { code: -32016, message: "over rate limit" }, 1],
    ["a request limit message", { code: -32000, message: "request limit reached" }, 1],
    ["daybreak's -32005", { code: -32005, message: "too many concurrent requests" }, 1],
    ["blockmachine's -32029", { code: -32029, message: "rate limit exceeded" }, 1],
    ["a block range limit", { code: -32000, message: "block range limit exceeded" }, 0],
    ["daybreak's range cap", { code: -32602, message: "query exceeds max block range 2000" }, 0],
    ["drpc's free-tier range", { code: 35, message: "ranges over 10000 blocks are not supported on freetier" }, 0],
    ["Infura's result-size -32005", { code: -32005, message: "query returned more than 10000 results" }, 0],
    ["a revert", { code: 3, message: "execution reverted" }, 0],
  ];
  for (const [name, e, s] of cases) assert.equal(evmThrottleS(e), s, name);

  // rpc.ts holds the chain for a limit message as for -32005 (before the card: -32005 only); the second read, inside
  // the 1 s hold, is sent only once it is over (a short hold is waited out: rpc.ts holdOver, HOLD_WAIT_MS)
  const holds = providerHolds();
  const sent: number[] = [];
  const limitAnswer = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "request limit reached" } };
  const rpc = createRpc({}, { holds, fetch: (async () => (sent.push(Date.now()), Response.json(limitAnswer))) as never });
  const body = blockNumber;
  assert.equal((await rpc.handle("robinhood", "application/json", body, "198.51.100.3")).status, 429);
  assert.ok(holds.heldFor(CHAIN_RPC) >= 1);
  assert.equal((await rpc.handle("robinhood", "application/json", body, "198.51.100.4")).status, 429);
  assert.equal(sent.length, 2);
  assert.ok(sent[1]! - sent[0]! >= 950, `the second read went to a provider that asked us to wait (${sent[1]! - sent[0]!} ms after)`);

  // a block range limit is passed through and holds nothing
  const rangeAnswer = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "block range limit exceeded" } };
  const holds2 = providerHolds();
  const rpc2 = createRpc({}, { holds: holds2, fetch: (async () => Response.json(rangeAnswer)) as never });
  const a = await rpc2.handle("robinhood", "application/json", body, "198.51.100.5");
  assert.equal(a.status, 200);
  assert.equal(holds2.heldFor(CHAIN_RPC), 0);
});
