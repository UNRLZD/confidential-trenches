// node --test apps/helper/src/data/evm/swaps-company.test.ts (card rpc-keyed-lists, review M1 of 424dce1e): the swap
// reads' "two providers agree" is two companies. With dRPC's three keys in the swap list, two keys of one company
// answering alike are one operator checking itself, so their agreement never settles a log or a head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC } from "../../../test/evm-swaps/base.ts";
import { keyedPaces } from "../../rpc/rpc.ts";
import { evmSwapRpcs } from "../../server.ts";
import { PROVIDER_PACE, providerHolds } from "../../limits/limits.ts";

const env = {
  BASE_RPC_URL_DRPC_1: "https://lb.drpc.live/base/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkey1",
  BASE_RPC_URL_DRPC_2: "https://lb.drpc.live/base/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBkey2",
  BASE_RPC_URL_DRPC_3: "https://lb.drpc.live/base/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCkey3",
};

/** The tape of ICNT with `down` (a host part) answering 503, and every log read that answered, by host. */
async function tape(down: (url: string) => boolean) {
  const chain = fakeChain();
  chain.st.head = REC.firstHead + 200;
  const asked: { url: string; methods: string[] }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, methods: (JSON.parse(String(init.body)) as { method: string }[]).map((r) => r.method) });
    if (down(url)) return new Response("down", { status: 503 });
    return chain.fetch(url, init);
  };
  const holds = providerHolds(() => performance.timeOrigin + performance.now(), { ...PROVIDER_PACE, ...keyedPaces(env) });
  const s = open(chain, { t: 5_000_000 }, { rpcs: evmSwapRpcs(env, "base"), fetch: fetch as never, holds });
  try {
    const r = await s.trades(ICNT, 50);
    const logHosts = asked.filter((a) => a.methods.includes("eth_getLogs") && !down(a.url)).map((a) => new URL(a.url).host);
    return { r, logHosts };
  } finally {
    s.stop();
  }
}

test("review M1: nodies down, dRPC's three keys first in rank: the logs a tape takes are agreed by two companies, never two dRPC keys", async () => {
  const { r, logHosts } = await tape((u) => u.includes("nodies"));
  assert.equal(r.status, 200);
  assert.ok(new Set(logHosts).size >= 2, `every eth_getLogs that answered went to one company (${[...new Set(logHosts)].join(",")})`);
});

test("review M1: with dRPC the only company left that answers logs (the public spares down, mainnet.base.org refusing logs), no log is agreed: dRPC's keys never agree with each other", async () => {
  const { r, logHosts } = await tape((u) => !u.includes("drpc") && !u.includes("mainnet.base.org"));
  assert.ok(logHosts.length > 0 && logHosts.every((h) => h === "lb.drpc.live"), "only dRPC answered logs");
  const trades = r.status === 200 ? ((JSON.parse(r.body) as { trades?: unknown[] }).trades ?? []) : [];
  assert.equal(trades.length, 0, `${trades.length} trades taken on dRPC's word alone (${r.status})`);
});
