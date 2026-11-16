// Card sign-in-restore-never-stalls: a seat whose provider gives no answer in time to a pool-log page walks to a free
// provider at once, as on a throttle, instead of asking the silent one again with growing waits. Release 167's sign live
// run 43854843328 held a sign-in's restore at "reading" past 240 s; the same build and release 166's, run from the Mac
// with base.api.pocket.network answering nothing (16 Nov 11:58Z, a live check's copy with its requests logged), walked
// Base at 137 s: Base's pool list seats publicnode (a 50,000-block cap, named inside its answer) and bloXroute, the
// capped seat walked to Pocket, and the read asked Pocket's first page 7 times over 86 s (EVM_LOG_THROTTLE_TRIES, the
// waits doubling from 1 s to 30 s) with the helper's keyed route free in the list behind it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpcTransportError } from "@blindfill/kit";
import { evmAgreedLogs, evmPair, evmPoolLogPager, type EvmLogRow, type EvmRpc } from "../src/pool/evm.ts";

// Base's pool from its deploy block (kit buy-unpinned.ts, block 54,325,671) to a head of 16 Nov
const FROM = 54_325_671n;
const TO = 58_192_313n;
const EVERY = 41_000n;
const hash = (b: bigint): string => `0x${b.toString(16).padStart(64, "0")}`;
const planted = (): EvmLogRow[] => {
  const out: EvmLogRow[] = [];
  for (let b = FROM + 7n; b < TO; b += EVERY) out.push({ block: b, blockHash: hash(b), logIndex: 0n, bytes: `log ${b}` });
  return out;
};

type Fake = EvmRpc & { calls: number };
// every provider's calls together: a read past this many is a loop, refused so the test ends
let total = 0;
const LOOP = 3000;
/** A provider of the planted logs; `answer` says what the `n`th page, `span` blocks ending at `to`, gets: the logs (null), an error to throw. */
function provider(url: string, answer: (span: bigint, to: bigint, n: number) => Error | null): Fake {
  const logs = planted();
  const f = Object.assign(
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") throw new Error(`no ${method} here`);
      if (++total > LOOP) throw new Error(`a loop: past ${LOOP} calls`);
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      const e = answer(to - from + 1n, to, f.calls++);
      if (e !== null) throw e;
      return logs.filter((l) => l.block >= from && l.block <= to).map((l) => ({ ...l }));
    },
    { url, calls: 0 },
  ) as Fake;
  return f;
}

const anchor = { number: TO, hash: hash(TO), timestamp: 0n, baseFeePerGas: null };
const read = (list: readonly EvmRpc[], waits: number[]) =>
  evmAgreedLogs(evmPair(list), { address: "0xae97f5a6e0ae2ce0bb2c2d8a0c62e1b1f0b9f3a4", topics: [] }, (raw) => raw as EvmLogRow, FROM, { fin: anchor, anchor }, evmPoolLogPager(), 0, undefined, async (ms) => void waits.push(ms));

test("card sign-in-restore-never-stalls: a seat whose provider answers no pool-log page in time walks to the list's free provider at once, never waiting on the silent one", async () => {
  // publicnode: 50,000 blocks a call, its cap named inside its answer (-32701)
  const publicnode = provider("https://base-rpc.publicnode.com", (span) => (span > 50_000n ? new Error("RPC error -32701: exceed maximum block range: 50000") : null));
  const bloxroute = provider("https://base.rpc.blxrbdn.com", () => null);
  // Pocket: no answer within the client's 3.5 s, every call (the kit's client names it a timeout)
  const pocket = provider("https://base.api.pocket.network", () => new SolanaRpcTransportError("timeout", "no answer in 3500 ms", 1, "base.api.pocket.network"));
  const helper = Object.assign(provider("https://ct-api.unrealized.trade/v1/rpc/base?keyed=only", () => null), { operator: "helper" });
  const waits: number[] = [];
  const logs = await read([publicnode, bloxroute, pocket, helper], waits);
  assert.deepEqual(logs.map((l) => l.block), planted().map((l) => l.block), "every log once, in order");
  // red at 7f8a8094e: Pocket asked 7 times, the read waiting 1+2+4+8+16+30 s between, then refused
  assert.ok(pocket.calls <= 1, `the silent provider asked ${pocket.calls} times`);
  assert.deepEqual(waits, [], `the read waited ${waits.join(", ")} ms`);
  assert.ok(helper.calls > 0, "the free provider behind it paged the seat");
});

test("card sign-in-restore-never-stalls: a page wider than its provider answered in full that gets no answer in time still goes back to that width on the same provider (the pager's rule), never a walk", async () => {
  // one provider answers 100,000 blocks and stalls past it; the other answers everything; no third to walk to
  const narrowing = provider("https://base.rpc.blxrbdn.com", (span) => (span > 100_000n ? new SolanaRpcTransportError("timeout", "no answer in 3500 ms", 1, "base.rpc.blxrbdn.com") : null));
  const wide = provider("https://base-rpc.publicnode.com", () => null);
  const waits: number[] = [];
  const logs = await read([narrowing, wide], waits);
  assert.deepEqual(logs.map((l) => l.block), planted().map((l) => l.block), "every log once, in order");
  assert.deepEqual(waits, [], `the read waited ${waits.join(", ")} ms`);
});

test("card sign-in-restore-never-stalls: a log page refused by the helper never walks its seat onto a member that pages no logs, so the read ends", async () => {
  // release 166's and 167's builds, run from the Mac on 16 Nov 11:47Z with no fault, held the restore at "reading" past
  // 240 s as CI's run 43854843328 did: the helper's keyed route kept Base pool logs only to block 57,497,470 (it answers
  // a wider page past it with -32602 "maximum block range: 10000", read 11:59Z), and the seat walked off its refusal onto
  // mainnet.base.org (logs: false), so each next page went to the helper at mainnet.base.org's page size, 800,000 and
  // 400,000 blocks in turn, 3 a second without end
  const KEPT = 57_497_470n;
  total = 0;
  const publicnode = provider("https://base-rpc.publicnode.com", (span) => (span > 50_000n ? new Error("RPC error -32701: exceed maximum block range: 50000") : null));
  const bloxroute = provider("https://base.rpc.blxrbdn.com", () => null);
  const pocket = provider("https://base.api.pocket.network", (_s, _t, n) => (n === 0 ? null : new Error("HTTP 429")));
  const logless = Object.assign(provider("https://mainnet.base.org", () => new Error("HTTP 429: RPC error -32011: request limit reached")), { logs: false });
  const helper = Object.assign(
    provider("https://ct-api.unrealized.trade/v1/rpc/base?keyed=only", (span, to) => (to > KEPT && span > 10_000n ? new Error("RPC error -32602: eth_getLogs range too wide, maximum block range: 10000") : null)),
    { operator: "helper" },
  );
  const waits: number[] = [];
  const logs = await read([publicnode, bloxroute, pocket, logless, helper], waits);
  assert.deepEqual(logs.map((l) => l.block), planted().map((l) => l.block), "every log once, in order");
  assert.equal(logless.calls, 0, "the member that pages no logs is never asked for a page");
  assert.ok(total <= 200, `the read took ${total} calls`);
});
