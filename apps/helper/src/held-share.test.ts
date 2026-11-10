// Card market-token-reads: a device's held read never spends its own share of the Solana RPC budget (rpc/rpc.ts
// RPC_CLIENT_MAX a 10 s window), so a user with many positions never throttles their own trade screen. Run through the
// helper as deployed: the real RPC path and its limiter, the real proxy and the real token page, on a stub of the public
// Solana endpoint (100 a 10 s, 40 a method) and a Jupiter search that names every mint it is asked for.
//   node --test apps/helper/src/held-share.test.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { geckoBudget } from "./data/gecko.ts";
import { HELD_MAX } from "./data/held.ts";
import { b58encode, createSolanaLists } from "./data/solana/lists.ts";
import { createProxy } from "./proxy/proxy.ts";
import { createRpc } from "./rpc/rpc.ts";
import { handler, heldFrom, solanaTokenFromEnv } from "./server.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const KEYS = { JUPITER_API_KEY: "test-jupiter-0001", RELAY_API_KEY: "test-relay-0001", LIFI_API_KEY: "test-lifi-0001", ONECLICK_JWT: "test-oneclick-0001" };
const USER = "198.51.100.77";

function send(port: number, method: string, path: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((ok, fail) => {
    const headers: Record<string, string | number> = { "x-forwarded-for": USER };
    if (body !== undefined) Object.assign(headers, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    const r = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, text }));
    });
    r.on("error", fail);
    r.end(body);
  });
}
const mint = () => b58encode(randomBytes(32));

test("30 held Solana mints, cold and again: the same address's RPC read, token page and lists still answer, never 429", async () => {
  const realFetch = globalThis.fetch;
  const all: number[] = [];
  const per = new Map<string, number[]>();
  let rpcCalls = 0;
  const stub = (async (u: string | URL | Request, i?: RequestInit) => {
    const url = String(u);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/tokens/v2/search")) {
      const q = new URL(url).searchParams.get("query") ?? "";
      return json(q.split(",").filter(Boolean).map((id) => ({ id, name: `Name ${id.slice(0, 4)}`, symbol: id.slice(0, 4), usdPrice: 0.5, decimals: 6 })));
    }
    if (!url.includes("api.mainnet-beta.solana.com")) return json([]);
    rpcCalls++;
    const t = Date.now();
    const b = JSON.parse(String(i?.body));
    const reqs: { id: unknown; method: string }[] = Array.isArray(b) ? b : [b];
    const roll = (a: number[]) => {
      while (a.length && t - a[0]! >= 10_000) a.shift();
    };
    roll(all);
    for (const r of reqs) {
      const a = per.get(r.method) ?? [];
      roll(a);
      per.set(r.method, a);
    }
    if (all.length + reqs.length > 100 || reqs.some((r) => per.get(r.method)!.length + 1 > 40)) return new Response("slow", { status: 429, headers: { "retry-after": "10" } });
    for (const r of reqs) (all.push(t), per.get(r.method)!.push(t));
    const one = (r: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "getMultipleAccounts" ? { context: { slot: 1 }, value: [null, null] } : 1 });
    return json(Array.isArray(b) ? reqs.map(one) : one(reqs[0]!));
  }) as typeof fetch;
  // the share is a fixed 10 s window: start early in one, so the run stays inside it
  while (Date.now() % 10_000 > 2_000) await new Promise((r) => setTimeout(r, 50));
  globalThis.fetch = stub;
  const proxy = createProxy(KEYS, { fetch: stub });
  const rpc = createRpc({}, { fetch: stub });
  const lists = createSolanaLists(proxy, rpc);
  const token = solanaTokenFromEnv({}, proxy, lists, rpc);
  const held = heldFrom(token, {}, geckoBudget(Date.now));
  const h = createServer(handler(COMMIT, proxy, rpc, undefined, lists, undefined, undefined, token, undefined, null, new Map(), new Map(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, held));
  try {
    await new Promise<void>((r) => h.listen(0, "127.0.0.1", () => r()));
    const port = (h.address() as AddressInfo).port;
    const mints = Array.from({ length: HELD_MAX }, mint);
    const q = mints.map((m) => `token=${m}`).join("&");
    const before = rpcCalls;
    const cold = await send(port, "GET", `/v1/market/held?chain=solana&${q}`);
    const again = await send(port, "GET", `/v1/market/held?chain=solana&${q}`);
    const heldRpc = rpcCalls - before;
    // the same address, right after: its own trade screen's reads
    const gma = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [[mint()]] });
    const own = await send(port, "POST", "/v1/rpc/solana", gma);
    const page = await send(port, "GET", `/v1/market/token?chain=solana&token=${mint()}`);
    const lst = await send(port, "GET", "/v1/market/lists?chain=solana");
    console.log(`held cold ${cold.status}, again ${again.status}, RPC calls by the held reads ${heldRpc}; then the same address: rpc ${own.status}, token page ${page.status}, lists ${lst.status}`);
    assert.equal(cold.status, 200);
    const named = (JSON.parse(cold.text) as { tokens: { symbol: string | null; price_usd: string | null }[] }).tokens;
    assert.equal(named.filter((e) => e.symbol !== null && e.price_usd === "0.5").length, HELD_MAX, "every held mint named with its price");
    assert.equal(again.status, 200);
    assert.equal(own.status, 200, "the address's own RPC read is served");
    assert.notEqual(page.status, 429, "the address's own token page is not throttled");
    assert.notEqual(lst.status, 429, "the address's lists read is not throttled");
  } finally {
    globalThis.fetch = realFetch;
    h.closeAllConnections();
    await new Promise<void>((r) => h.close(() => r()));
  }
});
