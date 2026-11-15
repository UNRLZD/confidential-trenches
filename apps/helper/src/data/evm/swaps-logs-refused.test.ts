// node --test apps/helper/src/data/evm/swaps-logs-refused.test.ts: a provider that refuses every eth_getLogs and answers
// the other reads (limits.ts LOGS_REFUSED: mainnet.base.org, card helper-ready-page-warm) is sent no log read by any path
// (the swap reads, a /v1/rpc/base caller's), so a log read never holds it for the reads it answers; the swap reads ask
// it the rest (heads, calls, the traders' lookups).
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOGS_REFUSED, providerHolds } from "../../limits/limits.ts";
import { createRpc } from "../../rpc/rpc.ts";
import { fakeChain, ICNT, open, REC, URLS } from "../../../test/evm-swaps/base.ts";
import { SWAP_RPCS } from "./swaps.ts";

const BASE_OWN = "https://mainnet.base.org";

test("mainnet.base.org refuses every log read and is one of Base's providers: LOGS_REFUSED names it", () => {
  assert.ok(LOGS_REFUSED.has(BASE_OWN));
  assert.ok(SWAP_RPCS.base.includes(BASE_OWN), "asked the heads, calls and lookups");
});

test("the swap reads send a logs-refusing provider no eth_getLogs and ask it the rest", async () => {
  const chain = fakeChain();
  // no pace for any (the fake's), so the rank alone would ask it as often as the others
  const s = open(chain, undefined, { rpcs: [BASE_OWN, ...URLS], holds: providerHolds(() => 1_000_000, {}) });
  chain.st.head = REC.firstHead + 100;
  const t = await s.trades(ICNT, 50);
  s.stop();
  assert.equal(t.status, 200, t.body);
  assert.equal(chain.st.methods.get(`${BASE_OWN} eth_getLogs`) ?? 0, 0, "no log read");
  const rest = [...chain.st.methods].filter(([k]) => k.startsWith(`${BASE_OWN} `)).reduce((n, [, v]) => n + v, 0);
  assert.ok(rest > 0, "asked the other reads");
});

test("a /v1/rpc/base caller's eth_getLogs goes to the pinned providers, never to mainnet.base.org; its other reads go there first", async () => {
  const holds = providerHolds();
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return Response.json({ jsonrpc: "2.0", id: 1, result: [] });
  };
  const rpc = createRpc({}, { holds, fetch: fetch as never, pinned: SWAP_RPCS, log: () => {} });
  const body = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const logs = await rpc.handle("base", "application/json", body("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]), "198.51.100.7");
  assert.equal(logs.status, 200, logs.body);
  assert.deepEqual(asked, [SWAP_RPCS.base[0]], "the first pinned provider");
  asked.length = 0;
  const head = await rpc.handle("base", "application/json", body("eth_blockNumber", []), "198.51.100.7");
  assert.equal(head.status, 200, head.body);
  assert.deepEqual(asked, [BASE_OWN], "the chain's own endpoint first");
});
