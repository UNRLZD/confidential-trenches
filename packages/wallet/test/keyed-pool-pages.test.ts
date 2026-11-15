// Card robinhood-walk-inside-12s-with-the-pace. A fresh sign-in on SIGN_HOST (2026-11-15 14:2xZ, the Mac, request by
// request) walked Robinhood 15.9 s after Solana: its second seat, the helper's keyed-only route, paged the pool's life
// (100,000 to 800,000 blocks, 11 pages, each answered in about 210 ms) two pages per 1,667 ms, HOLDINGS_RPC_LIMIT's
// perMethod 2, five waits of 1.2 to 1.45 s inside the scan (8.7 s for 2.3 s of answers). The helper draws no caller
// share for those pages (apps/helper/src/rpc/rpc.ts LOG_CACHE_MS, POOL_LOGS_CLIENT: a cached page draws nothing, a first
// ask draws the pool-logs allowance, 30 per 10 s), so the device paces them at that allowance, apart from the other reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onTestClock } from "../../kit/test/test-clock.ts";
import * as bw from "../src/pool/buy-wallets.ts";
import { evmHelperKeyedRpc, HOLDINGS_RPC_LIMIT } from "../src/pool/buy-wallets.ts";
import { EVM_POOLS } from "../src/pool/evm.ts";
import { hostLane } from "../src/throttle.ts";

const ORIGIN = "https://keyed-pages.example";
const POOL = EVM_POOLS.robinhood!.pool;
const hex = (n: bigint): string => `0x${n.toString(16)}`;
// the restore's pages of the pool's life, as the recorded walk sent them (from its deploy block, 100,000 doubling to 800,000)
const PAGES = ((): [bigint, bigint][] => {
  const out: [bigint, bigint][] = [];
  for (let at = EVM_POOLS.robinhood!.fromBlock, w = 100_000n; out.length < 11; at += w, w = w < 800_000n ? w * 2n : w) out.push([at, at + w - 1n]);
  return out;
})();

// each request's send and answer time on the test clock, as the fetch saw them
type Sent = { t: number; end: number; method: string; host: string };
const onHelper = async (run: (sent: Sent[]) => Promise<void>): Promise<void> => {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const q = JSON.parse(String(init?.body)) as { id: number; method: string };
    const s: Sent = { t: Date.now(), end: 0, method: q.method, host: new URL(String(u)).host };
    sent.push(s);
    await new Promise((ok) => setTimeout(ok, 210));
    s.end = Date.now();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: q.method === "eth_getLogs" ? [] : "0x1" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run(sent);
  } finally {
    globalThis.fetch = real;
  }
};

test("the keyed-only route pages the pool's own logs at the helper's pool-logs allowance: the walk's 11 pages go back to back, inside one window", () => onTestClock(async () => {
  await onHelper(async (sent) => {
    const rpc = evmHelperKeyedRpc(ORIGIN, "robinhood");
    for (const [a, b] of PAGES) await rpc("eth_getLogs", [{ address: POOL, topics: [], fromBlock: hex(a), toBlock: hex(b) }]);
    assert.equal(sent.length, PAGES.length);
    // from the first page's send to the last one's answer
    const ms = sent.at(-1)!.end - sent[0]!.t;
    // the allowance (read through the module, so the red run at the base reads the pace, not a missing name)
    assert.ok(PAGES.length <= ((bw as { EVM_POOL_PAGES_LIMIT?: { total: number } }).EVM_POOL_PAGES_LIMIT?.total ?? 30));
    // each page its own 210 ms and no wait for a turn (at HOLDINGS_RPC_LIMIT: 5 waits of the window, about 10.6 s)
    assert.ok(ms < PAGES.length * 210 + 100, `the 11 pages took ${ms} ms`);
    assert.equal(hostLane(ORIGIN).inWindow() >= PAGES.length, true, "each page counted on the helper's lane");
  });
}));

test("every other read of the keyed-only route keeps HOLDINGS_RPC_LIMIT: eth_call, a log read of another address, a log read by block hash", () => onTestClock(async () => {
  await onHelper(async (sent) => {
    const rpc = evmHelperKeyedRpc(ORIGIN, "base");
    const other = "0x00000000000000000000000000000000000000aa";
    const calls: [string, unknown[]][] = [
      ["eth_call", [{ to: POOL, data: "0x" }, "latest"]],
      ["eth_getLogs", [{ address: other, fromBlock: "0x1", toBlock: "0x2" }]],
      ["eth_getLogs", [{ address: EVM_POOLS.base!.pool, blockHash: `0x${"1".repeat(64)}` }]],
      ["eth_getLogs", [{ address: EVM_POOLS.base!.pool, fromBlock: "0x1", toBlock: "latest" }]],
    ];
    await Promise.all(calls.map(([m, p]) => rpc(m, p)));
    const starts = sent.map((s) => s.t - sent[0]!.t);
    assert.equal(sent.length, 4);
    // at most `total` in one window: the fourth waits for the next
    assert.ok(starts.filter((t) => t < HOLDINGS_RPC_LIMIT.windowMs).length <= HOLDINGS_RPC_LIMIT.total, `starts ${starts.join(", ")}`);
    assert.ok(Math.max(...starts) >= HOLDINGS_RPC_LIMIT.windowMs, `the fourth waited for the window: ${starts.join(", ")}`);
  });
}));
