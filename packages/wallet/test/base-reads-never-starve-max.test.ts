// Card base-reads-never-starve-max: a read a screen shows on the helper's EVM route (the positions pass's W balances:
// Portfolio's rows, the sell box's Max) never waits behind a backlog of background reads (a restore's Transfer logs, the
// holdings rebuild's and the carry's reads). The route's queue is first come, first served at HOLDINGS_RPC_LIMIT (3
// calls a 1,667 ms); background calls hold at most EVM_PASS_IN_QUEUE places in it, and a shown read goes behind those
// alone. Judged by the order of the sends, never the machine's clock (scripts/ci/no-wall-clock-asserts.mjs): the shown
// read goes out behind at most EVM_PASS_IN_QUEUE background calls. Red at 6c13015c8: behind all 18 booked ahead, 6 of
// the queue's windows, 10 s (a timed run there: 10,050 ms; 42 ms with the bound).
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

test("card base-reads-never-starve-max: on Base and Robinhood a shown read goes out behind at most EVM_PASS_IN_QUEUE background reads while they fill the route's queue, and every background read still answers", async () => {
  resetHostLanes();
  const real = globalThis.fetch;
  const sent: { url: string; method: string; shown: boolean }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: [{ shown?: true }] };
    sent.push({ url: String(url), method: body.method, shown: body.params[0]?.shown === true });
    await new Promise((r) => setTimeout(r, ANSWER_MS));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x01" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const one = async (chain: "base" | "robinhood") => {
      const origin = `https://helper-${chain}-starve.test`;
      const pass = wallets.evmHelperRpc(origin, chain) as Rpc;
      // a restore's Transfer logs and a holdings rebuild's balance reads, booked at once, as a pass of 9 Ws asks them
      const background = Array.from({ length: BACKGROUND }, (_, i) => pass(i % 2 === 0 ? "eth_getLogs" : "eth_call", [{ i }]));
      // the positions pass's balance of one W, asked a tick later: what the sell box's Max and Portfolio show
      await new Promise((r) => setTimeout(r, 5));
      await shownOf(origin, chain)("eth_call", [{ shown: true }]);
      const mine = sent.filter((s) => s.url.includes(`helper-${chain}-starve`));
      const ahead = mine.findIndex((s) => s.shown);
      const done = await Promise.all(background);
      return { ahead, done };
    };
    const [base, robinhood] = await Promise.all([one("base"), one("robinhood")]);
    const bound = (wallets as unknown as { EVM_PASS_IN_QUEUE?: number }).EVM_PASS_IN_QUEUE ?? 2;
    for (const [chain, r] of [["base", base], ["robinhood", robinhood]] as const) {
      const windows = Math.floor(r.ahead / wallets.HOLDINGS_RPC_LIMIT.total);
      console.log(`${chain}: the shown read went out behind ${r.ahead} of ${BACKGROUND} background reads (${windows} of the queue's ${wallets.HOLDINGS_RPC_LIMIT.windowMs} ms windows)`);
      assert.ok(r.ahead >= 0, `${chain}: the shown read was sent`);
      assert.ok(r.ahead <= bound, `${chain}: the shown read went out behind ${r.ahead} background reads, more than ${bound}`);
      assert.equal(r.done.length, BACKGROUND, `${chain}: every background read answered`);
    }
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
});
