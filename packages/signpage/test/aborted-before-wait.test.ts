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
