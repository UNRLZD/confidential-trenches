// node --test apps/helper/src/rpc/keyed.test.ts (card rpc-keyed-lists): each chain's reads walk an ordered list of keyed
// providers (its existing name, QuickNode, dRPC; NEAR's FastNear first) before the public spares, so one provider's
// outage never stops a read; no key reaches a log line, an answer or /v1/health; each keyed host's identity read is
// in the health. Every URL here is made up; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";
import { providerHolds, type Pace } from "../limits/limits.ts";
import * as serverModule from "../server.ts";
import { health, PARTS } from "../health.ts";
import { HELPER_V1_PATHS } from "../../../../packages/kit/src/index.ts";
// read off the modules, so this file still loads at a base without them and its tests fail on the behaviour (red runs)
const { keyedPaces, keyedSpares } = rpcModule as unknown as { keyedPaces?: (env: Record<string, string>) => Record<string, Pace>; keyedSpares?: (env: Record<string, string>, c: string) => string[] };
const { evmSwapRpcs, solanaTradesRpcs } = serverModule as unknown as { evmSwapRpcs?: (env: Record<string, string>, c: string) => string[]; solanaTradesRpcs?: (env: Record<string, string>) => string[] };
type Rpc = ReturnType<typeof createRpc> & { keyed?: () => Record<string, { host: string; state: string }[]>; probe?: () => Promise<void> };

/** A planted key per slot: what must never leave the helper, in any form. */
const K = {
  solOwn: "plantedSOLown0key0123456789abcd",
  solQn: "plantedSOLqn00key0123456789abcd",
  solDr: "plantedSOLdr00key0123456789abcd",
  baseOwn: "plantedBASEown0key123456789abcd",
  baseQn: "plantedBASEqn00key123456789abcd",
  baseDr: "plantedBASEdr00key123456789abcd",
  rhOwn: "plantedRHown000key123456789abcd",
  rhQn: "plantedRHqn0000key123456789abcd",
  rhDr: "plantedRHdr0000key123456789abcd",
  nearFn: "plantedNEARfn00key123456789abcd",
  nearOwn: "plantedNEARown0key123456789abcd",
  nearB: "plantedNEARb000key123456789abcd",
};
/** Each chain's three keyed URLs in the order a read must ask them, in each provider's own URL shape: QuickNode's token
 *  in the path, dRPC's dkey query, FastNear's apiKey query, Helius's api-key query. */
const LISTS = {
  solana: [["SOLANA_RPC_URL", `https://mainnet.helius-rpc.test/?api-key=${K.solOwn}`], ["SOLANA_RPC_URL_QUICKNODE", `https://name-one.solana-mainnet.quiknode.test/${K.solQn}/`], ["SOLANA_RPC_URL_DRPC", `https://lb.drpc.test/ogrpc?network=solana&dkey=${K.solDr}`]],
  base: [["BASE_RPC_URL", `https://base-mainnet.alchemy.test/v2/${K.baseOwn}`], ["BASE_RPC_URL_QUICKNODE", `https://name-two.base-mainnet.quiknode.test/${K.baseQn}/`], ["BASE_RPC_URL_DRPC", `https://lb.drpc.test/ogrpc?network=base&dkey=${K.baseDr}`]],
  robinhood: [["ROBINHOOD_RPC_URL", `https://robinhood.own.test/${K.rhOwn}`], ["ROBINHOOD_RPC_URL_QUICKNODE", `https://name-three.robinhood-mainnet.quiknode.test/${K.rhQn}/`], ["ROBINHOOD_RPC_URL_DRPC", `https://lb.drpc.test/ogrpc?network=robinhood&dkey=${K.rhDr}`]],
  // FastNear's own host (scripts/ci/near-rpc-operators.mjs holds it); the other two made-up hosts no NEAR RPC scan reads
  near: [["NEAR_RPC_URL_FASTNEAR", `https://rpc.mainnet.fastnear.com?apiKey=${K.nearFn}`], ["NEAR_RPC_URL", `https://keyed-own.test/${K.nearOwn}`], ["NEAR_RPC_URL_B", `https://keyed-b.test/?key=${K.nearB}`]],
} as const;
type Chain = keyof typeof LISTS;
const ENV: Record<string, string> = Object.fromEntries(Object.values(LISTS).flatMap((l) => l.map(([n, u]) => [n, u])));
/** One read each chain's allowlist forwards. */
const READ: Record<Chain, unknown> = {
  solana: { jsonrpc: "2.0", id: 7, method: "getLatestBlockhash", params: [] },
  base: { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] },
  robinhood: { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] },
  near: { jsonrpc: "2.0", id: 7, method: "block", params: { finality: "final" } },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const clock = () => {
  const t = { v: performance.timeOrigin + performance.now() };
  return { t, now: () => t.v, sleep: async (ms: number) => void (t.v += ms) };
};

/** How a provider is down: each must move the read to the next. */
const DOWN: [string, () => Promise<Response>][] = [
  ["HTTP 503", async () => new Response("down", { status: 503 })],
  ["a refused connection", async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); }],
  ["HTTP 401 (a revoked key)", async () => new Response("unauthorized", { status: 401 })],
];

for (const chain of Object.keys(LISTS) as Chain[]) {
  for (const [what, down] of DOWN) {
    test(`card rpc-keyed-lists: ${chain} with its first two keyed URLs down (${what}) still answers from the third, and no public spare is asked`, async () => {
      const urls = LISTS[chain].map(([, u]) => u as string);
      const env = Object.fromEntries(LISTS[chain].map(([n, u]) => [n, u]));
      const asked: string[] = [];
      const fetch = async (url: string, init: RequestInit): Promise<Response> => {
        asked.push(url);
        if (url === urls[0] || url === urls[1]) return down();
        if (url === urls[2]) return json({ jsonrpc: "2.0", id: (JSON.parse(String(init.body)) as { id: unknown }).id, result: "from-the-third" });
        return json({ jsonrpc: "2.0", id: 7, result: "from-a-public-spare" });
      };
      const c = clock();
      // the helper's own wiring: one hold per provider, every keyed URL's company pace, the EVM chains' pinned spares
      const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
      const r = createRpc(env, { fetch: fetch as never, holds, pinned: { base: ["https://p1.test"], robinhood: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
      const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]));
      assert.equal(a.status, 200, a.body);
      assert.equal(JSON.parse(a.body).result, "from-the-third");
      assert.deepEqual(asked, urls, "the two down keyed URLs once each, then the third; nothing after it");
    });
  }
}

test("card rpc-keyed-lists: a keyed URL that throttles us (429) is held and the read goes on down the list; the next read skips it while held", async () => {
  const urls = LISTS.base.map(([, u]) => u as string);
  const asked: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    asked.push(url);
    if (url === urls[0]) return new Response("slow down", { status: 429, headers: { "retry-after": "20" } });
    return json({ jsonrpc: "2.0", id: 7, result: "0x2a" });
  };
  const c = clock();
  const r = createRpc(ENV, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(ENV) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 2; i++) assert.equal((await r.handle("base", "application/json", JSON.stringify(READ.base))).status, 200);
  assert.deepEqual(asked, [urls[0], urls[1], urls[1]]);
});

test("card rpc-keyed-lists: Solana's first key throttling us (429) moves this read and the next ones to its keyed spares while its hold lasts, never a 429 to the caller; the public endpoint is not asked", async () => {
  const urls = LISTS.solana.map(([, u]) => u as string);
  const env = Object.fromEntries(LISTS.solana.map(([n, u]) => [n, u]));
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    if (url === urls[0]) return new Response("slow down", { status: 429, headers: { "retry-after": "20" } });
    return json({ jsonrpc: "2.0", id: (JSON.parse(String(init.body)) as { id: unknown }).id, result: { value: "from-a-spare" } });
  };
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 3; i++) {
    const a = await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.7");
    assert.equal(a.status, 200, a.body);
    c.t.v += 1_000;
  }
  assert.deepEqual(asked, [urls[0], urls[1], urls[1], urls[1]], "the first key once, then its QuickNode spare for every read while held");
});

test("card rpc-keyed-lists: the list order is the existing name, QuickNode, dRPC, then the public spares (NEAR: FastNear, then its existing names); the swap reads and Solana's trade walks take the same keyed URLs ahead of their public lists", () => {
  assert.deepEqual(keyedSpares?.(ENV, "base"), [LISTS.base[1][1], LISTS.base[2][1]]);
  assert.deepEqual(keyedSpares?.(ENV, "near"), [LISTS.near[0][1]]);
  const sw = evmSwapRpcs?.(ENV, "base") ?? [];
  assert.deepEqual(sw.slice(0, 3), LISTS.base.map(([, u]) => u));
  assert.ok(sw.length > 3 && sw.slice(3).every((u) => u.startsWith("https://") && !u.includes("planted")), "then the public swap providers");
  // Robinhood's swap reads never took ROBINHOOD_RPC_URL (it is /v1/rpc's): its QuickNode and dRPC first
  assert.deepEqual((evmSwapRpcs?.(ENV, "robinhood") ?? []).slice(0, 2), [LISTS.robinhood[1][1], LISTS.robinhood[2][1]]);
  assert.deepEqual((solanaTradesRpcs?.({ ...ENV, SOLANA_TRADES_RPC_URL: "https://trades.test/k" }) ?? []).slice(0, 3), ["https://trades.test/k", LISTS.solana[1][1], LISTS.solana[2][1]]);
  // one key per company in each list, and each company's URLs share one pace (its account's limit, across chains)
  const paces = keyedPaces?.(ENV) ?? {};
  assert.equal(paces[LISTS.base[1][1]]?.group, "quicknode");
  assert.equal(paces[LISTS.solana[1][1]], paces[LISTS.base[1][1]]);
  assert.equal(paces[LISTS.robinhood[2][1]]?.group, "drpc");
  assert.equal(paces[LISTS.near[0][1]]?.group, "fastnear");
  assert.equal(paces[LISTS.base[0][1]], undefined, "the existing names keep the pace they had");
});

test("card rpc-keyed-lists: the company's one pace is shared by its URLs on every chain (QuickNode's Base and Solana endpoints draw one bucket)", () => {
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces?.(ENV) ?? {});
  const qnBase = LISTS.base[1][1];
  const qnSol = LISTS.solana[1][1];
  const burst = holds.paceOf(qnBase)?.burst ?? 0;
  assert.ok(burst > 0);
  assert.equal(holds.take(qnBase, burst, false), 0);
  assert.ok(holds.take(qnSol, 1, false) > 0, "Solana's QuickNode URL waits on the bucket Base's emptied");
});

test("card rpc-keyed-lists: a key planted in every keyed URL reaches no log line, no answer, no header and no /v1/health, whatever each provider does (429, 5xx, 401, the key echoed back, a wrong chain)", async () => {
  const lines: string[] = [];
  const out: string[] = [];
  let mode = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = String(init.body);
    switch (mode % 5) {
      case 0: return new Response(`slow down ${url}`, { status: 429, headers: { "retry-after": "1" } });
      case 1: return new Response(`upstream error at ${url}`, { status: 502 });
      case 2: return new Response(`bad key ${url}`, { status: 401 });
      case 3: return json({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: `your endpoint ${url} said no` } });
      default: return json({ jsonrpc: "2.0", id: JSON.parse(body).id ?? 1, result: body.includes("eth_chainId") ? "0x1" : body.includes("status") ? { chain_id: "testnet" } : "fine" });
    }
  };
  const c = clock();
  const r = createRpc(ENV, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(ENV) ?? {}), pinned: { base: ["https://p1.test"], robinhood: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: (l) => lines.push(l) }) as Rpc;
  for (mode = 0; mode < 10; mode++) {
    for (const chain of Object.keys(LISTS) as Chain[]) {
      const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]));
      out.push(a.body, JSON.stringify(a.headers ?? {}), String(a.why ?? ""), JSON.stringify(a.timing ?? []));
      c.t.v += 2_000;
    }
    await r.probe?.();
    out.push(JSON.stringify(r.keyed?.() ?? {}));
    // the spares' background reads (Solana's trade walks) and their throttles
    for (const [, u] of LISTS.solana) {
      r.background("solana", u, "getSignaturesForAddress");
      r.backgroundThrottled("solana", u, new Headers({ "retry-after": "1" }));
    }
  }
  // a refused URL names its variable, never its value
  for (const [n, u] of Object.values(LISTS).flat()) {
    try {
      createRpc({ [n]: `${u}#frag` });
      assert.fail(`${n} with a fragment was taken`);
    } catch (e) {
      out.push((e as Error).message);
    }
  }
  assert.ok(lines.some((l) => l.startsWith("rpc hold")), "the holds were logged (hosts only)");
  const all = [...lines, ...out].join("\n");
  for (const key of Object.values(K)) {
    for (const form of [key, Buffer.from(key).toString("base64").replace(/=+$/, ""), encodeURIComponent(key)]) assert.ok(!all.includes(form), `a form of a planted key leaked: ${form.slice(0, 12)}...`);
  }
  assert.ok(!/quiknode\.test\/|dkey=|apiKey=|api-key=/.test(all), "no keyed path or query in any line");
});

test("card rpc-keyed-lists: /v1/health's rpc lists each chain's keyed companies in order with the state of its identity read (its chain id, Solana's genesis, NEAR's chain_id), never a path or a key", async () => {
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const m = (JSON.parse(String(init.body)) as { method: string }).method;
    if (url === LISTS.robinhood[2][1]) return new Response("down", { status: 503 });
    if (url === LISTS.near[2][1]) return json({ jsonrpc: "2.0", id: "1", result: { chain_id: "testnet" } });
    if (m === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: url.includes("robinhood") ? "0x1237" : "0x2105" });
    if (m === "getGenesisHash") return json({ jsonrpc: "2.0", id: 1, result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
    if (m === "status") return json({ jsonrpc: "2.0", id: "1", result: { chain_id: "mainnet" } });
    return new Response("no", { status: 400 });
  };
  const c = clock();
  const r = createRpc(ENV, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(ENV) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined }) as Rpc;
  assert.deepEqual(r.keyed?.().base, ["alchemy.test unread", "quiknode.test unread", "drpc.test unread"]);
  await r.probe?.();
  assert.deepEqual(r.keyed?.(), {
    solana: ["helius-rpc.test answers", "quiknode.test answers", "drpc.test answers"],
    base: ["alchemy.test answers", "quiknode.test answers", "drpc.test answers"],
    robinhood: ["own.test answers", "quiknode.test answers", "drpc.test down"],
    near: ["fastnear.com answers", "keyed-own.test answers", "keyed-b.test wrong chain"],
  });
  // a host with none set: an empty list, never the public fallback
  assert.deepEqual((createRpc({}) as Rpc).keyed?.(), { solana: [], base: [], robinhood: [], near: [] });
});

test("card rpc-keyed-lists: /v1/health stays within its 1 KB (the kit's HELPER_V1_PATHS row) with every keyed slot set, every Solana slot named and the longest states", () => {
  const limit = HELPER_V1_PATHS.find((p) => p.path === "/v1/health")?.limitBytes ?? 0;
  assert.equal(limit, 1024);
  const real = { SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x", BASE_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/x", ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/x", NEAR_RPC_URL: "https://free.rpc.fastnear.com", NEAR_RPC_URL_B: "https://lava-endpoint.example" };
  const env: Record<string, string> = { ...real };
  for (const [n, u] of Object.values(LISTS).flat()) if (!(n in real)) env[n] = u.replace(/[a-z-]+\.quiknode\.test/, "sparkling-quiet-sunset-wave.base-mainnet.quiknode.pro").replace("drpc.test", "drpc.org");
  const listed = (createRpc(env) as Rpc).keyed?.() ?? {};
  const worst = Object.fromEntries(Object.entries(listed).map(([c, l]) => [c, l.map((e) => e.replace(/ \S+$/, " wrong chain"))]));
  assert.equal(Object.values(worst).flat().length, 12);
  const body = JSON.stringify(health("0123456789abcdef0123456789abcdef01234567", new Set(PARTS), 999_999_999, false, { rpc: "fallback", trades: "fallback", holders: "fallback", stream: "fallback" }, worst as never));
  assert.ok(Buffer.byteLength(body) <= limit, `${Buffer.byteLength(body)} bytes: ${body}`);
});

test("card rpc-keyed-lists: a company is its host's last two labels; an IP stays as it is", () => {
  const { companyOf } = rpcModule as unknown as { companyOf?: (h: string) => string };
  assert.equal(companyOf?.("sparkling-quiet-sun.base-mainnet.quiknode.pro"), "quiknode.pro");
  assert.equal(companyOf?.("lb.drpc.org"), "drpc.org");
  assert.equal(companyOf?.("rpc.mainnet.fastnear.com"), "fastnear.com");
  assert.equal(companyOf?.("127.0.0.1:8545"), "127.0.0.1");
});
