// The kit's reads past their bound (READ_TIMEOUT_MS: a provider that answers nothing in 5 s, or a page client still
// retrying its throttle then) end as the provider's transport fault, "timeout", so a sale or a buy counts it as the
// provider's ("down"), never a bare failure (card pool-sell-legs-side-by-side)
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSolanaPoolBuyVenue, readSolanaPoolTableVenue, readSolanaRent } from "../src/trade/solana/pool-buy.ts";
import { SolanaRpcTransportError, type SolanaRpc } from "../src/trade/solana/send.ts";
import { enableTimers, resetTimers } from "./mock-timers.ts";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
test("the Rent read and the venue reads with no answer in their bound throw the kit's timeout fault", async (t) => {
  enableTimers(t.mock.timers, { apis: ["setTimeout"] });
  t.after(() => resetTimers(t.mock.timers));
  const silent = (): SolanaRpc => (() => new Promise(() => {})) as unknown as SolanaRpc;
  for (const [what, read] of [
    ["the Rent", () => readSolanaRent([silent(), silent()])],
    ["the curve venue", () => readSolanaPoolBuyVenue([silent(), silent()], "pump-curve", MINT)],
    ["the venue table", () => readSolanaPoolTableVenue([silent(), silent()], "pumpswap")],
  ] as const) {
    const p = read().then(() => null, (e: unknown) => e);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    t.mock.timers.tick(5_000);
    const e = await p;
    assert.ok(e instanceof SolanaRpcTransportError, `${what}: ${String(e)}`);
    assert.equal((e as SolanaRpcTransportError).fault, "timeout", what);
  }
});
