// Card aborted-signal-waits-end-at-once: the page's waits on a signal end at once when the signal ended before the wait
// began. An aborted signal never fires its event again, so a wait that only listens for it sleeps its whole time.
// Each wait here is asked on an ended signal and must settle within a few turns of the event loop (no timer runs:
// settledSoon races it against setImmediate turns, never the clock), and each test has its own short bound.
//   node --test test/aborted-before-wait.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readOneClickLeast } from "../src/cash-to-pool.ts";
import { solanaPoolFollowDeps } from "../src/pool-deposit-follow.ts";

const B = { timeout: 5_000 };
/** "settled" when `p` settles within 20 turns of the event loop, "pending" when only a timer could end it. */
async function settledSoon(p: Promise<unknown>): Promise<"settled" | "pending"> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let k = 0; k < 20 && !done; k++) await new Promise<void>((r) => setImmediate(r));
  return done ? "settled" : "pending";
}

test("cash-to-pool.ts readOneClickLeast: a budget that ends inside a blip's read ends the read at once, never after the backoff", B, async () => {
  const budget = new AbortController();
  // the first read is a blip (a 429), and the budget ends while it answers: the backoff that follows starts on an ended signal
  const blip = (async () => {
    budget.abort(new Error("budget"));
    return new Response(JSON.stringify({ message: "busy" }), { status: 429 });
  }) as unknown as typeof fetch;
  const read = readOneClickLeast("base", blip, 0, { signal: budget.signal });
  assert.equal(await settledSoon(read), "settled", "the read waited out its 500 ms backoff on an ended budget");
  await assert.rejects(read, /1Click gave no least within/);
});

test("pool-deposit-follow.ts the follow's wait between rounds (solanaPoolFollowDeps sleep): an ended signal ends it at once", B, async () => {
  const rpc = (async () => null) as never;
  const deps = solanaPoolFollowDeps({ rpcs: [rpc, rpc], program: "11111111111111111111111111111111", deposit: (async () => null) as never });
  const wait = deps.sleep(60_000, AbortSignal.abort(new Error("signed out")));
  assert.equal(await settledSoon(wait), "settled", "the round's 60 s wait ran on a signal already ended");
});

test("carry-cash-evm.ts the carry's wait between lag reads: a stop inside the block read ends the read at once, never after EVM_LAG_WAIT_MS", B, async () => {
  const { evmCashCarrySender } = await import("../src/carry-cash-evm.ts");
  const stop = new AbortController();
  const block = (n: number) => ({ number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: "0x1", baseFeePerGas: "0x1" });
  // the two RPCs' newest blocks are 10 and 11; the higher one is read at 10, and the sign out lands while it answers
  // that it holds no such block yet (a lag): the lag's wait starts on an ended signal
  const rpc = (top: number) => (async (method: string, params: readonly unknown[]) => {
    if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
    if (params[0] === "latest") return block(top);
    stop.abort(new Error("signed out"));
    return null;
  }) as never;
  const sender = evmCashCarrySender({ chain: "base", network: "mainnet", rpcs: [rpc(10), rpc(11)], seed64: async () => new Uint8Array(64) } as never);
  const read = sender.sendable({ chain: "base", kind: "w", address: "0x1111111111111111111111111111111111111111", l: "1", j: 0 }, stop.signal);
  assert.equal(await settledSoon(read), "settled", "the carry's read waited out its lag wait on a signal that had ended");
});

test("deposit-follow.ts a follow stopped while its note store opens lets go at once, never after its pause", B, async () => {
  const { depositFollows } = await import("../src/deposit-follow.ts");
  const op = { kind: "deposit", stage: "quote_checked", txs: [], created_ms: 1, follow: { network: "mainnet", s: "7", i: 3, u: "a".repeat(64), address: "b".repeat(64), deadline_ms: 9e12, origin: "nep141:x", min_out: "1000000" } };
  const ops = { keys: async () => ["dq-1"], get: async () => op };
  // the follow's own store open (its second ask) fails only once the sign out has landed
  let asks = 0;
  let fail!: (e: unknown) => void;
  const store = () => (++asks === 1 ? Promise.resolve(ops) : new Promise((_, no) => (fail = no)));
  // the pause itself never ends on its own: only the follow's signal can end it
  const f = depositFollows({ network: () => "mainnet", store: store as never, seed64: async () => new Uint8Array(64), locks: () => null, sleep: () => new Promise<void>(() => {}) });
  await f.settle();
  f.signedOut();
  fail(new Error("the store closed"));
  assert.equal(await settledSoon(f.idle()), "settled", "the stopped follow waited out its pause, holding U's lock");
});
