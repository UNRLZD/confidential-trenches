// node --test apps/helper/src/rpc/pacer-clock.test.ts (card helper-pacer-on-the-clients-clock): createRpc builds its
// pacer on the client's own clock (`now`), so a test's clock moves the pace's waits as it moves the holds and the
// shares, and no paced test waits on the machine's clock. Before, createRpc's own pacer read the process's monotonic
// clock whatever `now` it was given: a burst past a key's second on a test clock slept on the test clock while the
// pacer's second turned only in real time, so its wait was asked again and again until the machine's second passed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRpc, PACE_SECOND_MS } from "./rpc.ts";

/** A still clock, a multiple of 10 s (a share window's first ms). */
const STILL = (): number => 1_800_000_000_000;
// a planted key-like path segment (16 characters or more: rpc.ts readUpstreams takes it as a key's place)
const MAIN = `https://solana-main.keyed.example/ctproof-main-${"0".repeat(20)}`;
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] });

test("a paced burst on a test clock: the key's sixth send waits for its next second on that clock, in one wait, and none waits on the machine's", async () => {
  // 50 a 10 s: 5 sends a second on the first key (rpc.ts pacedOf); the share at least one page's (RPC_PAGE_NEED 42)
  let clock = STILL();
  const sleeps: number[] = [];
  const sent: number[] = [];
  const rpc = createRpc(
    { SOLANA_RPC_URL: MAIN, RPC_BUDGET_SOLANA: "50,45" },
    {
      now: () => clock,
      // the waits side by side end at their own wake time, as timers do; the pacer is createRpc's own
      sleep: async (ms: number) => {
        sleeps.push(ms);
        const wake = clock + ms;
        await null;
        clock = Math.max(clock, wake);
      },
      fetch: async (_u, i) => {
        sent.push(clock - STILL());
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(i!.body)).id, result: { context: { slot: 1 }, value: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      },
      log: () => undefined,
    },
  );
  const all = await Promise.all(Array.from({ length: 6 }, (_, k) => rpc.handle("solana", "application/json", BODY, `203.0.113.${10 + k}`)));
  assert.deepEqual(all.map((a) => a.status), [200, 200, 200, 200, 200, 200]);
  // the first five at once, the sixth a pace second (PACE_SECOND_MS, the second with its margin) on the test clock later
  assert.deepEqual(sent.slice(0, 5), [0, 0, 0, 0, 0], `the first sends: ${sent.join(" ")}`);
  assert.equal(sent[5], PACE_SECOND_MS, `the sixth send left ${sent[5]} ms on the test clock (its next pace second: ${PACE_SECOND_MS})`);
  // one wait, that second's: a pacer on another clock is asked again after every wait the test clock ends
  assert.deepEqual(sleeps, [PACE_SECOND_MS], `the burst asked ${sleeps.length} waits: ${sleeps.slice(0, 8).map(Math.round).join(" ")}`);
});
