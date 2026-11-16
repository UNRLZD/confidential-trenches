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
/** A provider of the planted logs; `answer` says what a page of `span` blocks gets: the logs (null), an error to throw. */
function provider(url: string, answer: (span: bigint) => Error | null): Fake {
  const logs = planted();
  const f = Object.assign(
    async (method: string, params: readonly unknown[]): Promise<unknown> => {
      if (method !== "eth_getLogs") throw new Error(`no ${method} here`);
      f.calls++;
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock);
      const to = BigInt(p.toBlock);
      const e = answer(to - from + 1n);
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
