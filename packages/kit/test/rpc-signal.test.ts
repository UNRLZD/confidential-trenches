// Card kit-rpc-client-takes-a-signal: a read the caller gave up on is ended at the provider too, so a hung provider holds
// no connection past the read's own bound. Each of the kit's JSON-RPC clients takes the caller's signal (solanaJsonRpc,
// the SolanaRpc shape the device's EVM reads use too, and evmJsonRpc), and the kit's own timed read (solanaTimedRpc)
// ends its request at its bound. Every fetch here hangs until its signal aborts, and counts the aborts it sees. Each test
// is bounded by its own { timeout }: a client that drops the signal hangs, and fails there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { enableTimers, resetTimers } from "./mock-timers.ts";
import { evmJsonRpc } from "../src/checks/evm/quote.ts";
import { solanaJsonRpc, solanaTimedRpc } from "../src/trade/solana/send.ts";

/** A provider that never answers: each request is held until its signal aborts, then rejects with the signal's reason. */
function hung() {
  let asked = 0;
  const aborted: unknown[] = [];
  const fetch = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    asked++;
    const s = init!.signal!;
    return new Promise((_, rej) => {
      const end = () => (aborted.push(s.reason), rej(s.reason));
      if (s.aborted) end();
      else s.addEventListener("abort", end, { once: true });
    });
  };
  return { fetch, asked: () => asked, aborted };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

for (const retry of [undefined, { deadlineMs: 60_000, backoffMs: 10 }]) {
  test(`solanaJsonRpc${retry ? " with retry" : ""}: the caller's abort ends the hung request at the provider, and the call rejects with its reason, never asked again`, { timeout: 2_000 }, async () => {
    const p = hung();
    const ac = new AbortController();
    const call = solanaJsonRpc("https://rpc.example", { fetch: p.fetch, ...(retry ? { retry } : {}) })("getSlot", [], ac.signal);
    call.catch(() => {});
    await flush();
    assert.equal(p.asked(), 1);
    assert.equal(p.aborted.length, 0, "nothing aborted before the caller gave up");
    const why = new Error("the read's bound");
    ac.abort(why);
    await assert.rejects(call, (e: unknown) => e === why);
    assert.deepEqual(p.aborted, [why], "the fetch saw the caller's abort");
    await flush();
    assert.equal(p.asked(), 1, "an abort is never a fault the retry asks again");
  });
}

test("solanaJsonRpc: a signal already aborted sends nothing", { timeout: 2_000 }, async () => {
  const p = hung();
  const why = new Error("gone");
  await assert.rejects(solanaJsonRpc("https://rpc.example", { fetch: p.fetch })("getSlot", [], AbortSignal.abort(why)), (e: unknown) => e === why);
  assert.equal(p.asked(), 0);
});

test("solanaJsonRpc with retry: an abort during the wait between tries ends it at once, and no try follows", { timeout: 2_000 }, async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  let asked = 0;
  const fetch = (): Promise<Response> => (asked++, Promise.resolve(new Response("", { status: 503 })));
  const ac = new AbortController();
  const call = solanaJsonRpc("https://rpc.example", { fetch, retry: { deadlineMs: 60_000, backoffMs: 1_000 } })("getSlot", [], ac.signal);
  call.catch(() => {});
  await flush();
  assert.equal(asked, 1, "the first try answered 503: the call waits its backoff");
  const why = new Error("stopped");
  ac.abort(why);
  await assert.rejects(call, (e: unknown) => e === why);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(asked, 1, "no try after the abort");
});

test("solanaTimedRpc: its bound ends the hung request at the provider, not only the wait for it", { timeout: 2_000 }, async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const p = hung();
  const call = solanaTimedRpc(solanaJsonRpc("https://rpc.example", { fetch: p.fetch }), 500)("getSlot", []);
  call.catch(() => {});
  await flush();
  t.mock.timers.tick(499);
  await flush();
  assert.equal(p.aborted.length, 0, "inside the bound the request stands");
  t.mock.timers.tick(1);
  await assert.rejects(call, /no answer in 500 ms/);
  await flush();
  assert.equal(p.aborted.length, 1, "the fetch saw the bound's abort");
  assert.match(String((p.aborted[0] as Error).message), /no answer in 500 ms/);
});

test("solanaTimedRpc: the caller's own signal reaches the provider too", { timeout: 2_000 }, async () => {
  const p = hung();
  const ac = new AbortController();
  const call = solanaTimedRpc(solanaJsonRpc("https://rpc.example", { fetch: p.fetch }), 60_000)("getSlot", [], ac.signal);
  call.catch(() => {});
  await flush();
  const why = new Error("the caller's bound");
  ac.abort(why);
  await assert.rejects(call, (e: unknown) => e === why);
  assert.deepEqual(p.aborted, [why]);
});

test("evmJsonRpc: the caller's abort ends the hung request at the provider, and the call rejects with its reason", { timeout: 2_000 }, async () => {
  const p = hung();
  const ac = new AbortController();
  const call = evmJsonRpc("https://evm.example", p.fetch as typeof fetch)([{ method: "eth_blockNumber", params: [] }], ac.signal);
  call.catch(() => {});
  await flush();
  assert.equal(p.asked(), 1);
  assert.equal(p.aborted.length, 0);
  const why = new Error("the scan's bound");
  ac.abort(why);
  await assert.rejects(call, (e: unknown) => e === why);
  assert.deepEqual(p.aborted, [why], "the fetch saw the caller's abort");
});
