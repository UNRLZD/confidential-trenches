// Card base-reads-never-starve-max: a read a screen shows on the helper's EVM route (the positions pass's W balances:
// Portfolio's rows, the sell box's Max) never waits behind a backlog of background reads (a restore's Transfer logs, the
// holdings rebuild's and the carry's reads). The route's queue is first come, first served at HOLDINGS_RPC_LIMIT (3
// calls a 1,667 ms); background calls hold at most EVM_PASS_IN_QUEUE places in it, and a shown read goes behind those
// alone. Red at 6c13015c8: the shown read waited behind every background call booked ahead (18 here: past 5 s).
//   node --test test/base-reads-never-starve-max.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wallets from "../src/pool/buy-wallets.ts";
import { resetHostLanes } from "../src/throttle.ts";

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
// read off the module, so this file still loads at a base without the shown lane and fails on the behaviour (red runs)
const shownOf = ((wallets as unknown as { evmHelperShownRpc?: (o: string, c: "base" | "robinhood") => Rpc }).evmHelperShownRpc ?? wallets.evmHelperRpc) as (o: string, c: "base" | "robinhood") => Rpc;
const BACKGROUND = 18;
const ANSWER_MS = 40;

test("card base-reads-never-starve-max: on Base and Robinhood a shown read answers inside 5 s while background reads fill the route's queue, and every background read still answers", async () => {
  resetHostLanes();
  const real = globalThis.fetch;
  const sent: { url: string; method: string; at: number }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
    sent.push({ url: String(url), method: body.method, at: performance.now() });
    await new Promise((r) => setTimeout(r, ANSWER_MS));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x01" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const one = async (chain: "base" | "robinhood") => {
      const origin = `https://helper-${chain}-starve.test`;
      const pass = wallets.evmHelperRpc(origin, chain) as Rpc;
      const t0 = performance.now();
      // a restore's Transfer logs and a holdings rebuild's balance reads, booked at once, as a pass of 9 Ws asks them
      const background = Array.from({ length: BACKGROUND }, (_, i) => pass(i % 2 === 0 ? "eth_getLogs" : "eth_call", [{ i }]).then(() => performance.now() - t0));
      // the positions pass's balance of one W, asked a tick later: what the sell box's Max and Portfolio show
      await new Promise((r) => setTimeout(r, 5));
      const asked = performance.now();
      await shownOf(origin, chain)("eth_call", [{ shown: true }]);
      const waited = performance.now() - asked;
      const done = await Promise.all(background);
      return { waited, done };
    };
    const [base, robinhood] = await Promise.all([one("base"), one("robinhood")]);
    for (const [chain, r] of [["base", base], ["robinhood", robinhood]] as const) {
      console.log(`${chain}: shown read waited ${Math.round(r.waited)} ms behind ${BACKGROUND} background reads; the last background read answered at ${Math.round(Math.max(...r.done))} ms`);
      assert.ok(r.waited < 5_000, `${chain}: the shown read waited ${Math.round(r.waited)} ms`);
      // a whole window and the background calls in the queue ahead of it, never the backlog
      assert.ok(r.waited < 2 * wallets.HOLDINGS_RPC_LIMIT.windowMs + 500, `${chain}: ${Math.round(r.waited)} ms`);
      assert.equal(r.done.length, BACKGROUND, `${chain}: every background read answered`);
    }
    // the route's pace kept: never more than HOLDINGS_RPC_LIMIT.total sends to one route in any window
    for (const chain of ["base", "robinhood"]) {
      const at = sent.filter((s) => s.url.includes(`helper-${chain}-starve`)).map((s) => s.at);
      for (const t of at) assert.ok(at.filter((u) => u >= t && u < t + wallets.HOLDINGS_RPC_LIMIT.windowMs - 50).length <= wallets.HOLDINGS_RPC_LIMIT.total, `${chain}: past the route's pace`);
    }
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
});
