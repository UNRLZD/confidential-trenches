// The held head (src/checks/evm/quote.ts evmHeadWatch; card evm-quote-head-watch) on the answers Base mainnet gave the
// two pinned providers (fixtures/evm-quote.json, recorded by test/evm-quote-record.ts): a quote reads at the block both
// providers agreed on and confirmed by number while it is under EVM_HEAD_REUSE_MS old, so a tap runs only the read
// round; past it, or unconfirmed, the quote agrees on its own block; the 30 s rule refuses as before.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { EvmQuoteError, type EvmPoolBuyQuoteRequest } from "../src/index.ts";
import { EVM_HEAD_REUSE_MS, evmHeadWatch, evmPoolBuyQuoteWith, evmReadsPerCall, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import { gasRoundAnswers } from "./evm-quote-gas-fx.ts";
// the recordings (fixtures/evm-quote.json) were made at 6 reads an aggregate3 call, and their exchanges are matched call
// for call: these replays send 6 a call (the kit sends 64, card evm-buy-quote-in-window: QE9)
evmReadsPerCall(6);

type Answer = { result?: Record<string, unknown> | string } & Record<string, unknown>;
type Exchange = { calls: EvmRpcCall[]; answers: Answer[] };
type Case = { request: Record<string, unknown>; now: number; outcome: { code: string }; exchanges: [Exchange[], Exchange[]] };
const F: Record<string, Case> = JSON.parse(readFileSync(new URL("./fixtures/evm-quote.json", import.meta.url), "utf8"));
const C = F["base-ok"]!;
const request = (): EvmPoolBuyQuoteRequest => {
  const { buys, amountIn, ...rest } = C.request;
  return { ...(rest as Omit<EvmPoolBuyQuoteRequest, "token" | "amountIn">), token: buys as string, amountIn: BigInt(amountIn as string) };
};
const MAX_LAG = 5n; // Base's (trade/evm/buy-unpinned.ts)

/** A provider answering from the recording, counting each method it is asked; `lie` answers another hash to the
 *  by-number confirmation. */
function provider(ex: Exchange[], seen: string[], lie: { on: boolean }): EvmRpc {
  return async (calls) => {
    for (const c of calls) seen.push(c.method === "eth_getBlockByNumber" ? `head:${c.params[0] === "latest" ? "latest" : "number"}` : c.method);
    const e = ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls));
    const gas = e === undefined ? gasRoundAnswers(ex, calls) : undefined;
    if (gas !== undefined) return gas;
    if (e === undefined) throw new Error("no recorded answer for these calls");
    const a = structuredClone(e.answers);
    if (lie.on && calls[0]!.method === "eth_getBlockByNumber" && calls[0]!.params[0] !== "latest") (a[0]!.result as Record<string, unknown>).hash = "0x" + "ab".repeat(32);
    return a;
  };
}
function chain() {
  const seen: [string[], string[]] = [[], []];
  const lie = { on: false };
  const rpcs = [provider(C.exchanges[0], seen[0], lie), provider(C.exchanges[1], seen[1], lie)] as const;
  const heads = () => [...seen[0], ...seen[1]].filter((m) => m.startsWith("head:")).length;
  const reads = () => [...seen[0], ...seen[1]].filter((m) => m === "eth_call").length;
  return { rpcs, lie, heads, reads };
}
const blockMs = () => {
  const h = C.exchanges[0][0]!.answers[0]!.result as { timestamp: string };
  return Number(BigInt(h.timestamp)) * 1000;
};

test("held head: a second quote under EVM_HEAD_REUSE_MS reads at the held block with no head read and no confirmation, only the read round", async () => {
  assert.equal(C.outcome.code, "ok");
  const c = chain();
  let now = C.now;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => now);
  const a = await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  assert.equal(c.heads(), 3, "two heads and the by-number confirmation");
  const reads = c.reads();
  now += 500;
  const b = await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  assert.equal(c.heads(), 3, "the held head: no head read, no confirmation");
  assert.equal(c.reads(), 2 * reads, "the same read round");
  assert.equal(b.block.hash, a.block.hash);
  assert.equal(b.amountOut, a.amountOut);
  assert.equal(b.minOut, a.minOut);
});

test("held head: read more than EVM_HEAD_REUSE_MS ago on the device's clock, the quote agrees on a block again, both heads and the by-number check", async () => {
  const c = chain();
  let now = C.now;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => now);
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  now = C.now + EVM_HEAD_REUSE_MS + 1;
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  assert.equal(c.heads(), 6);
});

test("held head: a block the other provider does not confirm by number is never held; the next quote agrees on its own", async () => {
  const c = chain();
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => C.now, false, () => C.now);
  c.lie.on = true;
  await assert.rejects(evmPoolBuyQuoteWith(request(), c.rpcs, C.now, undefined, watch), (e: unknown) => e instanceof EvmQuoteError && e.code === "rpc_disagree");
  c.lie.on = false;
  const before = c.heads();
  await evmPoolBuyQuoteWith(request(), c.rpcs, C.now, undefined, watch);
  assert.equal(c.heads() - before, 3, "heads and confirmation read again");
});

test("held head: the kit still refuses a block more than 30 s behind the device's clock (stale_quote)", async () => {
  const c = chain();
  let now = C.now;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => now);
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  now = blockMs() + 30_001;
  await assert.rejects(evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
});

test("held head: the watch itself refuses a block more than 30 s behind the device's clock before its confirmation, so it never hands on or holds one (it has no quote's deadline)", async () => {
  const c = chain();
  const now = blockMs() + 30_001;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => now);
  await assert.rejects(watch.head(now), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
  assert.equal(c.heads(), 2, "the two heads, no by-number confirmation");
  // under 30 s it is the block (the watch's age runs on its own never-stepped-back clock from the call, a few ms here)
  const at = blockMs() + 29_900;
  const ok = evmHeadWatch(c.rpcs, MAX_LAG, () => at, false, () => at);
  assert.equal(Number((await ok.head(at)).block.timestamp) * 1000, blockMs());
});

test("held head: the watch counts the time its head reads took in the block's age (a block 29.6 s old when asked, its heads answered 600 ms later, refuses)", async () => {
  const c = chain();
  const slow = c.rpcs.map((rpc): EvmRpc => async (calls) => {
    if (calls[0]!.method === "eth_getBlockByNumber" && calls[0]!.params[0] === "latest") await new Promise((r) => setTimeout(r, 600));
    return rpc(calls);
  });
  const now = blockMs() + 29_600;
  const watch = evmHeadWatch(slow, MAX_LAG, () => now, false, () => now);
  await assert.rejects(watch.head(now), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
});

test("held head: kept in the background, the first quote after it reads no head", async () => {
  const c = chain();
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => C.now);
  watch.keep();
  for (let i = 0; i < 100 && c.heads() < 3; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  const before = c.heads();
  assert.equal(before, 3, "the background read: two heads and the confirmation");
  await evmPoolBuyQuoteWith(request(), c.rpcs, C.now, undefined, watch);
  assert.equal(c.heads(), before, "the quote reads at the held head");
});

test("held head (review of 4830f1f, L): timed on a clock that never steps back, so a device clock stepped back an hour cannot stretch the 5 s", async () => {
  const c = chain();
  let now = C.now;
  let mono = 0;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => mono);
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  now -= 3_600_000; // the device's clock stepped back
  mono += EVM_HEAD_REUSE_MS + 1;
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  assert.equal(c.heads(), 6, "heads read again: the hold is past 5 s on the clock that never steps back");
});

test("held head: under 5 s since it was read but past 30 s by its age then plus that time, the quote agrees on a block again", async () => {
  const c = chain();
  const now = blockMs() + 27_000; // the device's clock stays (stepped back by what passed), so only the age bound reads again
  let mono = 0;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => mono);
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  mono += 4_000;
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  assert.equal(c.heads(), 6, "heads read again: 27 s old when read, 31 s now");
});

test("held head: a device asleep (its never-stepped-back clock paused) wakes past 30 s on its own clock, and the quote reads the heads again instead of reusing or refusing the held one", async () => {
  const c = chain();
  let now = C.now;
  let mono = 0;
  const watch = evmHeadWatch(c.rpcs, MAX_LAG, () => now, false, () => mono);
  await evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch);
  now = blockMs() + 30_001;
  mono += 1_000;
  // the recording holds only that block, so the new read is refused too, but only after the heads are read again
  await assert.rejects(evmPoolBuyQuoteWith(request(), c.rpcs, now, undefined, watch), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
  assert.equal(c.heads(), 5, "both heads read again (the stale block is refused before its confirmation)");
});
