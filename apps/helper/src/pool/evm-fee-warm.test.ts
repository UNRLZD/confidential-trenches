// node --test apps/helper/src/pool/evm-fee-warm.test.ts (card helper-evm-fee-at-epoch-start): each pool's fee is read at
// its period's start, while every provider still holds the period's first block's state, and a request answers it from
// memory. Read 10 Nov 05:45-05:50Z: Robinhood's public operators but its own and dRPC keep a block's state about 14 s
// (refused at 24 s), dRPC at times under 45 s; read on demand up to a minute after that block, the fee had one operator
// left whenever dRPC refused, and the route answered 503 for the rest of the period.
// Every provider is a stub of fetch on a chain of 1 s blocks whose clock is the test's own (T), never the machine's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_POOL_TX_BYTES, evmPoolChainFee, evmPoolChainFeeReads, evmPoolFee, evmPoolGas, evmPoolVenues } from "@blindfill/kit";
import * as evm from "./evm.ts";
import * as fee from "./fee.ts";

const KEY = "0x" + createHash("sha256").update("helper-pool-senders/test-key/EVM_SENDER").digest("hex");
const RH = evmPoolVenues().robinhood.pool!.toLowerCase();
const BASE = evmPoolVenues().base.pool!.toLowerCase();
const DEPTH = `0x${Buffer.from(keccak_256(new TextEncoder().encode("currentTreeDepth()"))).subarray(0, 4).toString("hex")}`;
const ARB_L1 = "0xf5d6ded7";
const GWEI = 1_000_000_000n;
const S = 1_800_000_000; // block n's timestamp is S + n
const E = (Math.ceil((S * 1000) / 60_000) + 100) * 60_000; // a period's start, ms
const OWN = "rpc.mainnet.chain.robinhood.com";
const block = (n: number) => ({ number: `0x${n.toString(16)}`, timestamp: `0x${(S + n).toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, baseFeePerGas: `0x${GWEI.toString(16)}` });
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const feeOf = (network: string) => evmPoolFee({ gas: evmPoolGas(2), gasPrice: GWEI, chainFee: evmPoolChainFee(network, EVM_POOL_TX_BYTES, evmPoolChainFeeReads(network, evmPoolGas(2)).map((r) => (r.data === ARB_L1 ? 3n : 0n))) });

type Call = { host: string; method: string; at: number };
type Refuse = (host: string, method: string, ageS: number, at: number) => { status: number; body: object } | null;
/**
 * The chain at the test's clock: the newest block is the one of the clock's second (or `stalled`'s), a block past it is
 * null, and a state read at a block `refuse` names for its host and age is refused as the pruned providers refuse it.
 */
function chain(t: TestContext, refuse: Refuse, at: { T: number; stalled?: number }): Call[] {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => {
    globalThis.fetch = real;
    Date.now = realNow;
  });
  Date.now = () => at.T;
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    const host = new URL(String(u)).host;
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    calls.push({ host, method, at: at.T });
    const answer = (status: number, o: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id, ...o }), { status, headers: { "content-type": "application/json" } });
    const head = at.stalled ?? Math.floor(at.T / 1000) - S;
    let ageS = 0;
    if (method === "eth_call") ageS = at.T / 1000 - (S + Number(BigInt((params[1] as { blockHash: string }).blockHash)));
    const r = refuse(host, method, ageS, at.T);
    if (r !== null) return answer(r.status, { error: r.body });
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? head : Number(BigInt(params[0] as string));
      return answer(200, { result: n > head ? null : block(n) });
    }
    if (method === "eth_call") {
      const [{ to, data }] = params as [{ to: string; data: string }];
      return answer(200, { result: word(to.toLowerCase() === RH || to.toLowerCase() === BASE ? (data === DEPTH ? 2n : 0n) : data === ARB_L1 ? 3n : 0n) });
    }
    return answer(200, { error: { code: -32601, message: "no" } });
  }) as typeof fetch;
  return calls;
}
const PRUNED = (ageS: number) => ({ status: 200, body: { code: -32000, message: `historical state ${"ab".repeat(32)} is not available (${ageS} s)` } });
/** A fake timer on the test's clock: `fire()` runs every timer due by the clock, in order. */
function timerOn(at: { T: number }) {
  let due: { at: number; run: () => void; off: boolean }[] = [];
  const timer: fee.EpochTimer = {
    now: () => at.T,
    after: (ms, run) => {
      const x = { at: at.T + ms, run, off: false };
      due.push(x);
      return () => void (x.off = true);
    },
  };
  return {
    timer,
    pending: () => due.filter((x) => !x.off).map((x) => x.at),
    fire: () => {
      const now = due.filter((x) => !x.off && x.at <= at.T);
      due = due.filter((x) => !now.includes(x));
      for (const x of now) x.run();
    },
  };
}
/** Each sender's warm() as the timer calls it, its promise kept so the test awaits the read it made. */
const kept = (senders: Iterable<evm.EvmPoolSender>, made: Promise<void>[]) => [...senders].map((s) => ({ warm: (e: number, sleep?: (ms: number) => Promise<void>) => { const p = s.warm(e, sleep); made.push(p); return p; } }));
const ENV_RH = { POOL_EVM_ADDRESS_ROBINHOOD: RH, POOL_EVM_SENDER_KEY_ROBINHOOD: KEY };
const sendersOf = (env: Record<string, string>, lines: string[]) => evm.evmPoolSendersFromEnv(env, evmPoolVenues(), undefined, undefined, (l: string) => void lines.push(l));

test("every Robinhood operator but its own refuses a block's state from second 12 on: read on demand at second 30 the fee fails, read ahead at second 1 it answers 200 all period from memory, its reads made by second 3", async (t) => {
  const at = { T: E - 30_000 };
  const calls = chain(t, (host, method, ageS) => (method === "eth_call" && host !== OWN && ageS >= 12 ? PRUNED(ageS) : null), at);
  const lines: string[] = [];
  // on demand only, as before: one operator holds the state at second 30, and one is never enough
  const cold = sendersOf(ENV_RH, lines).get(RH)!;
  at.T = E + 30_000;
  await assert.rejects(cold.fee(at.T), /historical state/);
  // read ahead: the timer, started mid-period, runs at the next period's start plus EVM_FEE_WARM_DELAY_MS
  at.T = E - 30_000;
  const s = sendersOf(ENV_RH, lines).get(RH)!;
  const { timer, fire, pending } = timerOn(at);
  const made: Promise<void>[] = [];
  const stop = evm.evmFeeWarm(kept([s], made), timer, async (ms) => void (at.T += ms));
  t.after(stop);
  assert.deepEqual(pending(), [E + evm.EVM_FEE_WARM_DELAY_MS]);
  at.T = E + evm.EVM_FEE_WARM_DELAY_MS;
  const before = calls.length;
  fire();
  await Promise.all(made);
  const ahead = calls.slice(before);
  assert.ok(ahead.length > 0 && ahead.every((c) => c.at <= E + 3_000), `read ahead by second 3: ${ahead.map((c) => c.at - E).join(",")}`);
  // the cost: one fee read is the first-block search on one side, then the block, the depth and the chain fee on two
  // operators each (written down in evm.ts evmFeeWarm)
  assert.ok(ahead.length <= 24, `${ahead.length} reads`);
  for (const sec of [12, 30, 59]) {
    at.T = E + sec * 1000;
    const n = calls.length;
    const f = await s.fee(at.T);
    assert.equal(f?.fee, feeOf("robinhood").toString(), `second ${sec}`);
    assert.equal(f?.block, block(E / 1000 - S).number);
    assert.equal(calls.length, n, `second ${sec} answered from memory`);
  }
  // the next period's timer is set, one a period
  assert.deepEqual(pending(), [E + 60_000 + evm.EVM_FEE_WARM_DELAY_MS]);
});

test("a read ahead that fails is tried again inside the window; failing all of it, it writes one line and the request still reads on demand; a quiet period stays quiet with no line", async (t) => {
  const at: { T: number; stalled?: number } = { T: E };
  let down = (T: number) => T < E + 3_000;
  const calls = chain(t, (_host, method, _age, T) => (method === "eth_call" && down(T) ? { status: 502, body: { code: -32603, message: "bad gateway" } } : null), at);
  const lines: string[] = [];
  const sleep = async (ms: number) => void (at.T += ms);
  // fails at second 1, read at second 3
  let s = sendersOf(ENV_RH, lines).get(RH)!;
  at.T = E + evm.EVM_FEE_WARM_DELAY_MS;
  await s.warm(E, sleep);
  assert.equal(at.T, E + evm.EVM_FEE_WARM_DELAY_MS + evm.EVM_FEE_WARM_EVERY_MS);
  let n = calls.length;
  assert.equal((await s.fee(at.T + 20_000))?.fee, feeOf("robinhood").toString());
  assert.equal(calls.length, n, "read ahead on the second try");
  assert.equal(lines.filter((l) => l.includes("read ahead")).length, 0, lines.join("\n"));
  // fails all through the window: tried at 1, 3, 5, 7 and 9 s, one line, then the request reads on demand
  down = (T) => T < E + 12_000;
  s = sendersOf(ENV_RH, lines).get(RH)!;
  at.T = E + evm.EVM_FEE_WARM_DELAY_MS;
  const tries: number[] = [];
  await s.warm(E, async (ms) => void (tries.push(at.T), (at.T += ms)));
  assert.equal(tries.length, 4, tries.map((x) => x - E).join(","));
  assert.ok(at.T <= E + evm.EVM_FEE_WARM_WINDOW_MS);
  const said = lines.filter((l) => l.includes("read ahead"));
  assert.equal(said.length, 1, lines.join("\n"));
  assert.match(said[0]!, /^evm robinhood: fee read ahead failed \(read on demand\): .*(HTTP 502|bad gateway)/);
  at.T = E + 13_000;
  n = calls.length;
  assert.equal((await s.fee(at.T))?.fee, feeOf("robinhood").toString());
  assert.ok(calls.length > n, "read on demand");
  // a quiet period: no block in it through the window, no line; the request then finds none as before (null)
  down = () => false;
  at.stalled = E / 1000 - S - 1;
  s = sendersOf(ENV_RH, lines).get(RH)!;
  at.T = E + evm.EVM_FEE_WARM_DELAY_MS;
  const before = lines.length;
  await s.warm(E, sleep);
  assert.equal(lines.slice(before).filter((l) => l.includes("read ahead")).length, 0);
  at.T = E + 20_000;
  assert.equal(await s.fee(at.T), null);
});

test("two pools on two networks: one timer reads both, each from its own providers, and each answers from memory", async (t) => {
  const at = { T: E - 1_000 };
  const calls = chain(t, () => null, at);
  const lines: string[] = [];
  const senders = sendersOf({ ...ENV_RH, POOL_EVM_ADDRESS_BASE: BASE, POOL_EVM_SENDER_KEY_BASE: KEY }, lines);
  assert.deepEqual([...senders.keys()].sort(), [BASE, RH].sort());
  const { timer, fire } = timerOn(at);
  const made: Promise<void>[] = [];
  t.after(evm.evmFeeWarm(kept(senders.values(), made), timer, async (ms) => void (at.T += ms)));
  at.T = E + evm.EVM_FEE_WARM_DELAY_MS;
  fire();
  await Promise.all(made);
  assert.equal(made.length, 2);
  const hosts = new Set(calls.map((c) => c.host));
  assert.ok(hosts.has(OWN) && [...hosts].some((h) => h.includes("base")), [...hosts].join(","));
  const n = calls.length;
  at.T = E + 40_000;
  assert.equal((await senders.get(RH)!.fee(at.T))?.fee, feeOf("robinhood").toString());
  assert.equal((await senders.get(BASE)!.fee(at.T))?.fee, feeOf("base").toString());
  assert.equal(calls.length, n);
});

test("the timer reads each period once: a timer that fires early runs no period twice, a second warm of a period reads nothing, a start mid-period begins at the next, and a stop ends it", async (t) => {
  // the timer alone: fires half a second early each time
  const runs: number[] = [];
  const at = { T: E + 30_000 };
  let due: { at: number; run: () => void } | null = null;
  const early: fee.EpochTimer = { now: () => at.T, after: (ms, run) => ((due = { at: at.T + ms - 500, run }), () => void (due = null)) };
  const stop = fee.everyEpoch((s) => void runs.push(s), 1_000, early);
  for (let i = 0; i < 4; i++) {
    const d = due as { at: number; run: () => void } | null;
    assert.ok(d !== null);
    at.T = d.at;
    d.run();
  }
  assert.deepEqual(runs, [E + 60_000, E + 120_000, E + 180_000, E + 240_000]);
  stop();
  assert.equal(due, null, "stop cancels the next timer");
  // the sender: a period warmed twice is read once
  const clock = { T: E + evm.EVM_FEE_WARM_DELAY_MS };
  const calls = chain(t, () => null, clock);
  const s = sendersOf(ENV_RH, []).get(RH)!;
  await s.warm(E, async (ms) => void (clock.T += ms));
  const n = calls.length;
  await s.warm(E, async (ms) => void (clock.T += ms));
  assert.equal(calls.length, n);
});
