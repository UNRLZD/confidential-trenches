// node --test apps/helper/src/rpc/drpc-hold-per-chain.test.ts (card base-reads-never-throttled, E3): a dRPC refusal on
// Base never holds another chain's dRPC URL. Live 16 Nov 12:02-12:25Z on 13a755f78 (PR 905) the helper held every dRPC
// URL it sends from its IP on one refusal: Base's code 15 ("You reached Public endpoint rate limit") held Robinhood's
// three keys and NEAR's drpc.live too, their probes were skipped and health read them "unread" (live run 43861861053:
// rpc-keyed-lists, helper-robinhood-capacity and helper-robinhood-search-ahead FAIL, all PASS on 841265f75). dRPC's code
// 15 comes per network: Robinhood's keys answered while Base's were refused. The holds are built as the helper builds
// them (rpc.ts: providerHolds over PROVIDER_PACE and keyedPaces); the URLs are made up, the keys planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_PACE, providerHolds } from "../limits/limits.ts";
import { keyedPaces } from "./rpc.ts";

const key = (c: string, n: number) => `planted${c}dr${n}key123456789abcd`;
const BASE = [1, 2, 3].map((n) => `https://lb.drpc.live/base/${key("BASE", n)}`);
const ROBINHOOD = [1, 2, 3].map((n) => `https://lb.drpc.live/robinhood/${key("RH", n)}`);
const NEAR = `https://lb.drpc.live/near/${key("NEAR", 1)}`;
const ENV: Record<string, string> = {
  ...Object.fromEntries(BASE.map((u, i) => [`BASE_RPC_URL_DRPC_${i + 1}`, u])),
  ...Object.fromEntries(ROBINHOOD.map((u, i) => [`ROBINHOOD_RPC_URL_DRPC_${i + 1}`, u])),
  NEAR_RPC_URL: NEAR,
};

test("a dRPC refusal on Base holds Base's key alone: Robinhood's three keys and NEAR's dRPC are not held and still take a call", () => {
  let clock = 1_800_000_000_000;
  const holds = providerHolds(() => clock, { ...PROVIDER_PACE, ...keyedPaces(ENV) });
  // Base's first key refuses (code 15, Retry-After 2), as the helper holds it (rpc.ts callList)
  holds.hold(BASE[0]!, 2);
  assert.ok(holds.heldMs(BASE[0]!) > 0, "the refusing key is held");
  for (const u of [...ROBINHOOD, NEAR]) {
    assert.equal(holds.heldMs(u), 0, `${new URL(u).pathname.split("/")[1]} is not held by Base's refusal`);
    assert.equal(holds.take(u, 1, false), 0, `${new URL(u).pathname.split("/")[1]} takes a call at once`);
  }
  // and a run of Base refusals (16 s, the most 905 held) still holds no other chain
  for (const u of BASE) holds.hold(u, 16);
  clock += 1_000;
  for (const u of [...ROBINHOOD, NEAR]) assert.equal(holds.heldMs(u), 0, `${u.split("/")[3]} still free while Base is held`);
});
