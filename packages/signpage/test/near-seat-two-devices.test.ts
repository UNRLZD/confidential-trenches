// Two devices buying at one moment on the helper's FastNEAR seat (card near-quote-under-the-pace): each device paces
// its seat at the key's 5 a second (the wallet's nearSeatRpc, its own pace per page: here two copies of the pace
// module), and their reads interleave on one key that the helper holds at 5 a second, 5 at once, answering 429 with
// Retry-After 1 past it. Each device reads its swap's pair (the kit's readNearSwapPair: one final height on both seats,
// then W, the quote and the baseline at that block) on its seat and dRPC, on the test clock (onTestClock: every wait set
// and ended in its turn, the idle time skipped); the chain moves a block
// every 600 ms. Both pairs complete, each of one block, within the signer's NEAR_SWAP_READ_AGE_MAX, and no read falls
// to the keyless seat: the 429s are waited out.
//   node --test test/near-seat-two-devices.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { NEAR_NETWORKS, type NearRpc } from "../../kit/src/near/networks.ts";
import { readNearSwapPair } from "../../kit/src/trade/near/wallet.ts";
import { NEAR_SWAP_READ_AGE_MAX } from "../../wallet/src/near/swap-delegate.ts";
import type * as Pace from "../../wallet/src/pace.ts";
import { AMOUNT, chain, TOKEN } from "./near-chain-fake.ts";

const NET = NEAR_NETWORKS.mainnet;
// one copy of the pace module per device: a page's paces are its own
const device = async (n: number) => (await import(new URL(`../../wallet/src/pace.ts?device=${n}`, import.meta.url).href)) as typeof Pace;

test("two devices' pairs interleaved on one 5/s key: both complete at one block, within the signer's age, none on the keyless seat", { timeout: 60_000 }, () => onTestClock(async () => {
  const k = chain();
  k.c.exists = true;
  const t0 = performance.now();
  const H0 = k.c.height;
  const at = () => (k.c.height = H0 + Math.floor((performance.now() - t0) / 600));
  // the helper's pace for the key: GCRA, 5 a second, 5 at once
  let tat = 0;
  const take = () => {
    const now = performance.now();
    const t = Math.max(tat, now);
    if (t - now > 4 * 200 + 2) return false;
    tat = t + 200;
    return true;
  };
  const asked = { seat: 0, refused: 0, keyless: 0, drpc: 0 };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    at();
    const params = JSON.parse(String(init!.body)).params as Record<string, unknown>;
    const ok = () => new Response(JSON.stringify(k.answer(params)), { status: 200 });
    if (url === NET.seat) {
      asked.seat++;
      if (!take()) return asked.refused++, new Response(JSON.stringify({ error: { code: "rate_limited" } }), { status: 429, headers: { "retry-after": "1" } });
      return ok();
    }
    if (url === NET.drpc) return asked.drpc++, ok();
    asked.keyless++;
    return ok();
  }) as typeof fetch;
  const pairOf = async (n: number) => {
    const P = await device(n);
    const rpcs = [P.nearSeatRpc("mainnet", fetchFn), P.pacedNearRpc(NET.drpc, fetchFn)] as readonly [NearRpc, NearRpc];
    // the fake chain's one W (its key is the fake's one key); each device reads it on its own seats
    const wallet = "0".repeat(64);
    const p = await readNearSwapPair({ network: "mainnet", rpcs, wallet, side: "buy", token: TOKEN, amountIn: AMOUNT, pools: [9, 4512], baseline: TOKEN });
    return { p, head: at() };
  };
  const [a, b] = await Promise.all([pairOf(1), pairOf(2)]);
  for (const { p, head } of [a, b]) {
    assert.equal(p.quote.height, p.state.height, "one block");
    assert.equal(p.quote.blockHash, p.state.blockHash);
    assert.ok(p.quote.height - p.state.height >= 0 && p.quote.height - p.state.height <= NEAR_SWAP_READ_AGE_MAX);
    assert.equal(typeof p.baseline, "bigint");
    assert.ok(head - p.state.height <= NEAR_SWAP_READ_AGE_MAX, `the pair is ${head - p.state.height} blocks old when it comes back`);
  }
  assert.ok(asked.refused > 0, `the two devices met the key's pace (${JSON.stringify(asked)})`);
  assert.equal(asked.keyless, 0, JSON.stringify(asked));
  console.log("two devices:", JSON.stringify(asked), `${Math.round(performance.now() - t0)} ms`);
}));
