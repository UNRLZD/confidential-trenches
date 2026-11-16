// node --test apps/helper/src/data/evm/swaps-company.test.ts (card rpc-keyed-lists, review M1 of 424dce1e): the swap
// reads' "two providers agree" is two companies. With dRPC's three keys in the swap list, two keys of one company
// answering alike are one operator checking itself, so their agreement never settles a log or a head.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeChain, ICNT, open, REC } from "../../../test/evm-swaps/base.ts";
import * as rpcModule from "../../rpc/rpc.ts";
import * as serverModule from "../../server.ts";
import { evmSwapRpcs } from "../../server.ts";
import { PROVIDER_PACE, providerHolds } from "../../limits/limits.ts";

// read off the module, so this file loads at a base without operatorOf and its tests fail on the behaviour (red runs)
const { keyedPaces } = rpcModule;
const operatorOf = (rpcModule as unknown as { operatorOf?: (url: string) => string }).operatorOf ?? ((u: string) => new URL(u).host);

const env = {
  BASE_RPC_URL_DRPC_1: "https://lb.drpc.live/base/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkey1",
  BASE_RPC_URL_DRPC_2: "https://lb.drpc.live/base/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBkey2",
  BASE_RPC_URL_DRPC_3: "https://lb.drpc.live/base/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCkey3",
};

// read off the module, so this file loads at a base without it and the spares test fails on the behaviour (red runs)
const { evmSwapSpares } = serverModule as unknown as { evmSwapSpares?: (env: Record<string, string>, c: string) => string[] };

/** The tape of ICNT with `down` (a host part) answering 503, and every log read that answered, by host. `spares`: the
 *  keyed URLs the server names spares (evmSwapSpares). */
async function tape(down: (url: string) => boolean, spares = false) {
  const chain = fakeChain();
  chain.st.head = REC.firstHead + 200;
  const asked: { url: string; methods: string[] }[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, methods: (JSON.parse(String(init.body)) as { method: string }[]).map((r) => r.method) });
    if (down(url)) return new Response("down", { status: 503 });
    return chain.fetch(url, init);
  };
  const holds = providerHolds(() => performance.timeOrigin + performance.now(), { ...PROVIDER_PACE, ...keyedPaces(env) });
  const s = open(chain, { t: 5_000_000 }, { rpcs: evmSwapRpcs(env, "base"), ...(spares ? { spares: evmSwapSpares?.(env, "base") ?? [] } : {}), fetch: fetch as never, holds });
  try {
    const r = await s.trades(ICNT, 50);
    const logHosts = asked.filter((a) => a.methods.includes("eth_getLogs") && !down(a.url)).map((a) => new URL(a.url).host);
    return { r, logHosts, asked };
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

test("review M1: a company is one operator under each of its domains: dRPC's keyed lb.drpc.live is drpc.org, as its keyless hosts are; two companies stay two", () => {
  assert.equal(operatorOf(env.BASE_RPC_URL_DRPC_1), "drpc.org");
  assert.equal(operatorOf("https://robinhood.drpc.org"), "drpc.org");
  assert.equal(operatorOf("https://base.drpc.org"), "drpc.org");
  assert.notEqual(operatorOf("https://base-rpc.publicnode.com"), operatorOf("https://base-pokt.nodies.app"));
});

test("review M1: the agreed head is two companies' too: dRPC's keys reporting a head ahead of every other company never set the block the logs are read to", async () => {
  const chain = fakeChain();
  chain.st.head = REC.firstHead + 200;
  // the one other company answering heads (mainnet.base.org) 100 blocks behind dRPC's keys, far past a pair's lag; the
  // rest down, so the head read reaches the keys
  const LAG = 100;
  const rpcs = evmSwapRpcs(env, "base");
  for (const u of rpcs) if (!u.includes("drpc")) chain.st.faults.set(u, u.includes("mainnet.base.org") ? { lag: LAG } : { down: true });
  const tos: number[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    for (const r of JSON.parse(String(init.body)) as { method: string; params: { toBlock?: string }[] }[]) if (r.method === "eth_getLogs" && r.params[0]?.toBlock !== undefined) tos.push(parseInt(r.params[0].toBlock, 16));
    return chain.fetch(url, init);
  };
  const holds = providerHolds(() => performance.timeOrigin + performance.now(), { ...PROVIDER_PACE, ...keyedPaces(env) });
  const s = open(chain, { t: 5_000_000 }, { rpcs, fetch: fetch as never, holds });
  try {
    await s.trades(ICNT, 50);
  } finally {
    s.stop();
  }
  assert.ok(tos.length > 0, "logs were read");
  assert.ok(Math.max(...tos) <= chain.st.head - LAG, `logs read to block ${Math.max(...tos)}, dRPC's head alone (the others' is ${chain.st.head - LAG})`);
});

// card robinhood-trades-finish-filling: a tape is display data. Live 16 Nov 17:56Z, on helper 6df1ca4e2, a keyed Base
// eth_getLogs (/v1/rpc ?keyed=only) was refused "every provider held" by our own pace, the keys' one bucket of 62 calls a
// minute (limits.ts DRPC_IP_PACE) also carrying the swap reads, which rank dRPC's keys first in the list
test("the swap reads ask Base's public providers before the keyed dRPC spares: with every provider answering, no read goes to a key", async () => {
  assert.deepEqual(evmSwapSpares?.(env, "base"), Object.values(env), "the keyed URLs of the swap list");
  const { r, asked } = await tape(() => false, true);
  assert.equal(r.status, 200, r.body.slice(0, 200));
  assert.ok(((JSON.parse(r.body) as { trades?: unknown[] }).trades ?? []).length > 0, "the tape's trades");
  const keyed = asked.filter((a) => a.url.includes("drpc.live"));
  assert.equal(keyed.length, 0, `${keyed.length} reads to dRPC's keys: ${keyed.slice(0, 3).map((a) => a.methods.join(",")).join(" | ")}`);
});
