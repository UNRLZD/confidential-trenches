// node --test apps/helper/src/rpc/keyed.test.ts (card rpc-keyed-lists): each chain's reads walk an ordered list of keyed
// providers (its existing name, QuickNode, dRPC; NEAR's FastNear first) before the public spares, so one provider's
// outage never stops a read; no key reaches a log line, an answer or /v1/health; each keyed host's identity read is
// in the health. Every URL here is made up; the keys are planted strings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rpcModule from "./rpc.ts";
import { createRpc } from "./rpc.ts";
import { PROVIDER_PACE, providerHolds, type Pace } from "../limits/limits.ts";
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
/** Each chain's first three keyed URLs in the order a read must ask them, in each provider's own URL shape: QuickNode's
 *  token in the path, dRPC's key in the path (lb.drpc.live/<network>/<key>, drpc.org/docs/gettingstarted/firstrequest),
 *  FastNear's apiKey query, Helius's api-key query. dRPC's keys 2 and 3: DRPC_MORE. */
const LISTS = {
  solana: [["SOLANA_RPC_URL", `https://mainnet.helius-rpc.test/?api-key=${K.solOwn}`], ["SOLANA_RPC_URL_QUICKNODE", `https://name-one.solana-mainnet.quiknode.test/${K.solQn}/`], ["SOLANA_RPC_URL_DRPC_1", `https://lb.drpc.test/solana/${K.solDr}`]],
  base: [["BASE_RPC_URL", `https://base-mainnet.alchemy.test/v2/${K.baseOwn}`], ["BASE_RPC_URL_QUICKNODE", `https://name-two.base-mainnet.quiknode.test/${K.baseQn}/`], ["BASE_RPC_URL_DRPC_1", `https://lb.drpc.test/base/${K.baseDr}`]],
  robinhood: [["ROBINHOOD_RPC_URL", `https://robinhood.own.test/${K.rhOwn}`], ["ROBINHOOD_RPC_URL_QUICKNODE", `https://name-three.robinhood-mainnet.quiknode.test/${K.rhQn}/`], ["ROBINHOOD_RPC_URL_DRPC_1", `https://lb.drpc.test/robinhood/${K.rhDr}`]],
  // FastNear's own host (scripts/ci/near-rpc-operators.mjs holds it); the other two made-up hosts no NEAR RPC scan reads
  near: [["NEAR_RPC_URL_FASTNEAR", `https://rpc.mainnet.fastnear.com?apiKey=${K.nearFn}`], ["NEAR_RPC_URL", `https://keyed-own.test/${K.nearOwn}`], ["NEAR_RPC_URL_B", `https://keyed-b.test/?key=${K.nearB}`]],
} as const;
type Chain = keyof typeof LISTS;
/** dRPC's keys 2 and 3 on each chain they serve (three accounts, one key each: the owner, 7 Nov 09:16Z). */
const DRPC_MORE: Record<"solana" | "base" | "robinhood", [string, string][]> = {
  solana: [["SOLANA_RPC_URL_DRPC_2", "https://lb.drpc.test/solana/plantedSOLdr2key0123456789abcd"], ["SOLANA_RPC_URL_DRPC_3", "https://lb.drpc.test/solana/plantedSOLdr3key0123456789abcd"]],
  base: [["BASE_RPC_URL_DRPC_2", "https://lb.drpc.test/base/plantedBASEdr2key123456789abcd"], ["BASE_RPC_URL_DRPC_3", "https://lb.drpc.test/base/plantedBASEdr3key123456789abcd"]],
  robinhood: [["ROBINHOOD_RPC_URL_DRPC_2", "https://lb.drpc.test/robinhood/plantedRHdr2key123456789abcd"], ["ROBINHOOD_RPC_URL_DRPC_3", "https://lb.drpc.test/robinhood/plantedRHdr3key123456789abcd"]],
};
/** A chain's URLs in order, typed for destructuring. */
const urlsOf = (chain: Chain): [string, string, string] => LISTS[chain].map(([, u]) => u as string) as [string, string, string];
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
  // one pace per account: each QuickNode endpoint its own (the owner, 09:27Z), each dRPC key its own (09:16Z)
  const paces = keyedPaces?.(ENV) ?? {};
  assert.equal(paces[LISTS.base[1][1]]?.group, "quicknode-base");
  assert.equal(paces[LISTS.solana[1][1]]?.group, "quicknode-solana");
  assert.equal(paces[LISTS.robinhood[2][1]]?.group, "drpc-1");
  assert.equal(paces[LISTS.near[0][1]]?.group, "fastnear");
  assert.equal(paces[LISTS.base[0][1]], undefined, "the existing names keep the pace they had");
});

test("owner 09:27Z: each QuickNode endpoint is its own account: Base's emptied bucket leaves Solana's; a dRPC key's URLs on every chain draw one bucket", () => {
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces?.(ENV) ?? {});
  const qnBase = LISTS.base[1][1];
  const qnSol = LISTS.solana[1][1];
  const burst = holds.paceOf(qnBase)?.burst ?? 0;
  assert.ok(burst > 0);
  assert.equal(holds.take(qnBase, burst, false), 0);
  assert.equal(holds.take(qnSol, 1, false), 0, "Solana's QuickNode endpoint has its own bucket");
  const [drBase, drSol] = [LISTS.base[2][1], LISTS.solana[2][1]];
  assert.equal(holds.take(drBase, holds.paceOf(drBase)?.burst ?? 0, false), 0);
  assert.ok(holds.take(drSol, 1, false) > 0, "dRPC key 1's Solana URL waits on the bucket its Base URL emptied");
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
  assert.deepEqual(r.keyed?.().base, ["alchemy.test unread", "quiknode.test unread", "drpc.test key1 unread"]);
  await r.probe?.();
  assert.deepEqual(r.keyed?.(), {
    solana: ["helius-rpc.test answers", "quiknode.test answers", "drpc.test key1 answers"],
    base: ["alchemy.test answers", "quiknode.test answers", "drpc.test key1 answers"],
    robinhood: ["own.test answers", "quiknode.test answers", "drpc.test key1 down"],
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
  for (const [n, u] of [...Object.values(LISTS).flat(), ...Object.values(DRPC_MORE).flat()]) if (!(n in real)) env[n] = u.replace(/[a-z-]+\.quiknode\.test/, "sparkling-quiet-sunset-wave.base-mainnet.quiknode.pro").replace("drpc.test", "drpc.live");
  const listed = (createRpc(env) as Rpc).keyed?.() ?? {};
  const worst = Object.fromEntries(Object.entries(listed).map(([c, l]) => [c, l.map((e) => e.replace(/ \S+$/, " wrong chain"))]));
  assert.equal(Object.values(worst).flat().length, 18);
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

// ---- the independent review's fold on 79ce2ab7 (M1-M3, L1-L5) ----
const idsOf = (init: RequestInit): unknown[] => {
  const b = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
  return Array.isArray(b) ? b.map((r) => r.id) : [b.id];
};
const answer = (init: RequestInit, result: unknown) => {
  const b = JSON.parse(String(init.body)) as { id: unknown } | { id: unknown }[];
  return json(Array.isArray(b) ? b.map((r) => ({ jsonrpc: "2.0", id: r.id, result })) : { jsonrpc: "2.0", id: b.id, result });
};
/** dRPC free's refusal of a batch past 3 (HTTP 400, code 31, read live on base.drpc.org 2026-11-07 08:59Z). */
const drpcBatchRefusal = (init: RequestInit) =>
  json(idsOf(init).map((id) => ({ id, jsonrpc: "2.0", error: { message: "Batch of more than 3 requests are not allowed on free plan, to use this feature register paid account at drpc.org", code: 31 } })), 400);
const batchOf = (chain: Chain, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ ...(READ[chain] as object), id: i + 1 })));
const hostsOf = (asked: string[]) => asked.map((u) => new URL(u).host);

test("review M1: Base, BASE_RPC_URL down (503), QuickNode throttling (429), a batch of 4 dRPC free refuses (400 code 31): the public spare answers 200, and dRPC is not sent the batch", async () => {
  const [own, qn, dr] = urlsOf("base");
  const env = Object.fromEntries(LISTS.base.map(([n, u]) => [n, u]));
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    if (url === own) return new Response("down", { status: 503 });
    if (url === qn) return new Response("slow", { status: 429, headers: { "retry-after": "20" } });
    if (url === dr && idsOf(init).length > 3) return drpcBatchRefusal(init);
    return answer(init, "0x1");
  };
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://public-spare.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
  const a = await r.handle("base", "application/json", batchOf("base", 4), "198.51.100.9");
  assert.equal(a.status, 200, a.body);
  assert.deepEqual((JSON.parse(a.body) as { result: string }[]).map((x) => x.result), ["0x1", "0x1", "0x1", "0x1"]);
  assert.ok(!asked.includes(dr), `dRPC was sent a batch past its plan: ${hostsOf(asked).join(" -> ")}`);
  assert.equal(asked.at(-1), "https://public-spare.test");
});

test("review M1: a keyed URL's other 4xx (400 with a JSON body) is that URL down for the read on every chain: the next in the list answers", async () => {
  for (const chain of Object.keys(LISTS) as Chain[]) {
    const urls = LISTS[chain].map(([, u]) => u as string);
    const env = Object.fromEntries(LISTS[chain].map(([n, u]) => [n, u]));
    const asked: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(url);
      if (url === urls[0] || url === urls[1]) return json({ jsonrpc: "2.0", id: idsOf(init)[0], error: { code: -32600, message: "plan refuses this" } }, 400);
      return answer(init, "from-the-third");
    };
    const c = clock();
    const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test"], robinhood: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]));
    assert.equal(a.status, 200, `${chain}: ${a.body}`);
    assert.equal(JSON.parse(a.body).result, "from-the-third", chain);
    assert.deepEqual(asked, urls, chain);
  }
});

test("review M1: Solana, first key 429, QuickNode 429, a batch of 4 dRPC free refuses: the public endpoint answers 200", async () => {
  const [own, qn, dr] = urlsOf("solana");
  const env = Object.fromEntries(LISTS.solana.map(([n, u]) => [n, u]));
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    if (url === own || url === qn) return new Response("slow", { status: 429, headers: { "retry-after": "20" } });
    if (url === dr && idsOf(init).length > 3) return drpcBatchRefusal(init);
    return answer(init, { value: "public" });
  };
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
  const a = await r.handle("solana", "application/json", batchOf("solana", 4), "198.51.100.9");
  assert.equal(a.status, 200, a.body);
  assert.equal(asked.at(-1), rpcModule.SOLANA_PUBLIC, hostsOf(asked).join(" -> "));
  assert.ok(!asked.includes(dr), "dRPC was sent a batch past its plan");
});

test("review M1 (call path): Solana's first key refusing a read with a 400 sends it on to its keyed spares, and a lone key's 400 to the public endpoint, never to the caller", async () => {
  const [own, qn] = urlsOf("solana");
  for (const env of [Object.fromEntries(LISTS.solana.map(([n, u]) => [n, u])) as Record<string, string>, { SOLANA_RPC_URL: own } as Record<string, string>]) {
    const asked: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(url);
      if (url === own) return json({ jsonrpc: "2.0", id: 7, error: { code: -32600, message: "batch requests are not on your plan" } }, 400);
      return answer(init, { value: url === qn ? "spare" : "public" });
    };
    const c = clock();
    const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.9");
    assert.equal(a.status, 200, a.body);
    assert.equal(JSON.parse(a.body).result.value, env.SOLANA_RPC_URL_QUICKNODE === undefined ? "public" : "spare");
  }
});

test("review L3: a batch larger than a company's bucket (QuickNode's 7) never goes to it in one post: it is asked of the next that takes it", async () => {
  const env = { BASE_RPC_URL_QUICKNODE: LISTS.base[1][1] };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), answer(init, "0x1"));
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
  assert.equal((await r.handle("base", "application/json", batchOf("base", 7), "198.51.100.9")).status, 200);
  c.t.v += 2_000;
  assert.equal((await r.handle("base", "application/json", batchOf("base", 10), "198.51.100.10")).status, 200);
  assert.deepEqual(asked, [env.BASE_RPC_URL_QUICKNODE, "https://p1.test"], "7 to QuickNode, 10 to the spare");
});

test("review M2: past a company's daily budget nothing more is sent to it that UTC day, on any chain or path, and the spares serve; the next day it is asked again", async () => {
  const qnBase = LISTS.base[1][1];
  const qnSol = LISTS.solana[1][1];
  // 60 credits a day: three EVM calls at 20
  const env = { BASE_RPC_URL_QUICKNODE: qnBase, SOLANA_RPC_URL: LISTS.solana[0][1], SOLANA_RPC_URL_QUICKNODE: qnSol, RPC_DAY_QUICKNODE: "60" };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    if (url === LISTS.solana[0][1]) return new Response("slow", { status: 429, headers: { "retry-after": "20" } });
    const m = (JSON.parse(String(init.body)) as { method: string }).method;
    return answer(init, m === "eth_chainId" ? "0x2105" : m === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : "0x1");
  };
  const c = clock();
  // the start of a UTC day, so the run stays inside one
  c.t.v = Math.ceil(c.t.v / 86_400_000) * 86_400_000 + 1_000;
  const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
  const r = createRpc(env, { fetch: fetch as never, holds, pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined }) as Rpc;
  for (let i = 0; i < 6; i++) {
    const a = await r.handle("base", "application/json", JSON.stringify(READ.base), "198.51.100.9");
    assert.equal(a.status, 200, a.body);
    c.t.v += 1_000;
  }
  assert.equal(asked.filter((u) => u === qnBase).length, 3, "three calls of 20 credits, then none");
  assert.equal(asked.filter((u) => u === "https://p1.test").length, 3, "the spare served the rest");
  // Solana's QuickNode endpoint is another account (the owner, 09:27Z): its own day, so it still serves
  const s = await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.9");
  assert.equal(s.status, 200, s.body);
  assert.equal(asked.at(-1), qnSol);
  // the probe sends the spent one nothing; the swap reads see no room there
  c.t.v += 2_000;
  const before = asked.length;
  await r.probe?.();
  assert.ok(!asked.slice(before).includes(qnBase), "the probe read a URL past its day");
  assert.ok(asked.slice(before).includes(qnSol));
  assert.equal(holds.room(qnBase), 0);
  // Solana's endpoint has spent its 60 too (the read and the probe, 30 credits each): its background reads are refused
  assert.ok(r.background("solana", qnSol, "getSignaturesForAddress") > 0, "past its day");
  // the next UTC day: asked again
  c.t.v += 86_400_000;
  await r.handle("base", "application/json", JSON.stringify(READ.base), "198.51.100.9");
  assert.equal(asked.at(-1), qnBase);
});

test("card helper-live-red: a keyed URL whose callers spent its day is still probed from the day's probe share, so /v1/health names its state, never unread; the probe never passes the plan's day", async () => {
  // live 17:15Z: Base's QuickNode day spent (the box's day files summed 322,580 credits, KEYED_DAY), so the probe skipped
  // it after the deploy and rpc-keyed-lists read "quiknode.pro unread" for 180 s; the key answered 0x2105 (18:07Z)
  const qnBase = LISTS.base[1][1];
  // 2,000 credits a day: callers stop at 1,980, the probe's 1% keeps one EVM call of 20
  const env = { BASE_RPC_URL_QUICKNODE: qnBase, RPC_DAY_QUICKNODE: "2000" };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), answer(init, "0x2105"));
  const c = clock();
  c.t.v = Math.ceil(c.t.v / 86_400_000) * 86_400_000 + 1_000;
  const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
  const r = createRpc(env, { fetch: fetch as never, holds, now: c.now, sleep: c.sleep, log: () => undefined }) as Rpc;
  assert.equal(holds.take(qnBase, 99, false), 0, "callers spend 1,980");
  c.t.v += 2_000; // the pace's bucket full again: what refuses below is the day alone
  assert.ok(holds.take(qnBase, 1, false) > 3_600_000, "a caller's 1,981st to 2,000th credit is the probe's");
  assert.ok(holds.take(qnBase, 1, true) > 3_600_000, "and a background read's");
  assert.ok(holds.dayOut(qnBase, 1));
  assert.equal(holds.room(qnBase), 0, "the swap reads see no room there");
  await r.probe?.();
  assert.equal(asked.filter((u) => u === qnBase).length, 1, "the probe read it from its share");
  assert.deepEqual(r.keyed?.().base, ["quiknode.test answers"]);
  // the share spent: the next probe sends nothing past the plan's day and the last state stands
  c.t.v += 600_001;
  await r.probe?.();
  assert.equal(asked.filter((u) => u === qnBase).length, 1, "the probe read past the plan's day");
  assert.deepEqual(r.keyed?.().base, ["quiknode.test answers"]);
});

test("card helper-live-red: a day spent whole, the probe's share too, before a helper starts leaves its keyed URL unread only until 00:00Z: the next day's probe reads it", async () => {
  // live run 42694130536 (20:34Z, helper fc76a9fb): Base's QuickNode day files summed 322,580 of 322,580 credits, spent
  // by helpers that ran before the probe share (PROBE_DAY_SHARE) existed, so the share was gone with the rest and the
  // probe of every helper started after it could not draw: "quiknode.pro unread" until the day turns
  const qnBase = LISTS.base[1][1];
  const env = { BASE_RPC_URL_QUICKNODE: qnBase, RPC_DAY_QUICKNODE: "2000" };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), answer(init, "0x2105"));
  const c = clock();
  c.t.v = Math.ceil(c.t.v / 86_400_000) * 86_400_000 + 1_000;
  const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
  assert.equal(holds.take(qnBase, 99, false), 0, "callers spend 1,980");
  c.t.v += 2_000; // the pace's bucket full again: what refuses below is the day alone
  assert.equal(holds.take(qnBase, 1, true, false, true), 0, "and the last 20, the probe's share, as before the share was kept");
  c.t.v += 2_000;
  const r = createRpc(env, { fetch: fetch as never, holds, now: c.now, sleep: c.sleep, log: () => undefined }) as Rpc;
  await r.probe?.();
  assert.equal(asked.filter((u) => u === qnBase).length, 0, "nothing is sent past the plan's day");
  assert.deepEqual(r.keyed?.().base, ["quiknode.test unread"]);
  c.t.v = Math.ceil(c.t.v / 86_400_000) * 86_400_000 + 1_000; // 00:00:01Z the next day
  await r.probe?.();
  assert.equal(asked.filter((u) => u === qnBase).length, 1, "the next day's probe reads it");
  assert.deepEqual(r.keyed?.().base, ["quiknode.test answers"]);
});

test("review M2: each account's daily budget is its plan's month over 31 days (dRPC's 30-day period over 30), in its own unit, overridable by RPC_DAY_<COMPANY>; a pool sender's read is never refused by it", () => {
  const { KEYED_DAY } = rpcModule as unknown as { KEYED_DAY?: unknown };
  void KEYED_DAY;
  const paces = keyedPaces?.(ENV) ?? {};
  assert.deepEqual([paces[LISTS.base[1][1]]?.day, paces[LISTS.base[1][1]]?.cost, paces[LISTS.solana[1][1]]?.cost], [322_580, 20, 30], "QuickNode: 10M credits / 31, EVM 20, Solana 30");
  assert.deepEqual([paces[LISTS.base[2][1]]?.day, paces[LISTS.base[2][1]]?.cost], [7_000_000, 20], "dRPC: 210M CU a 30-day period / 30, per key, 20 CU a call");
  assert.deepEqual([paces[LISTS.near[0][1]]?.day, paces[LISTS.near[0][1]]?.cost], [322_580, 1], "FastNear: Dev's 10M requests / 31");
  assert.equal(keyedPaces?.({ ...ENV, RPC_DAY_DRPC: "1000" })[LISTS.base[2][1]]?.day, 1000);
  assert.throws(() => keyedPaces?.({ ...ENV, RPC_DAY_FASTNEAR: "10M" }), /RPC_DAY_FASTNEAR must be a whole number/);
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces?.({ ...ENV, RPC_DAY_QUICKNODE: "20" }) ?? {});
  assert.equal(holds.take(LISTS.base[1][1], 1, false), 0);
  assert.ok(holds.take(LISTS.base[1][1], 1, false) > 0, "the day is spent");
  assert.equal(holds.take(LISTS.base[1][1], 1, false, true), 0, "a sender's read still goes");
});

test("review M2: a keyed URL that answers its chain is probed once in 10 min, one that did not once a minute", async () => {
  assert.equal(rpcModule.KEYED_PROBE_MS, 600_000);
  const env = { BASE_RPC_URL_QUICKNODE: LISTS.base[1][1], BASE_RPC_URL_DRPC_1: LISTS.base[2][1] };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), url === env.BASE_RPC_URL_DRPC_1 ? new Response("down", { status: 503 }) : answer(init, "0x2105"));
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined }) as Rpc;
  for (let i = 0; i <= 10; i++) {
    await r.probe?.();
    c.t.v += 61_000;
  }
  assert.equal(asked.filter((u) => u === env.BASE_RPC_URL_QUICKNODE).length, 2, "at 0 and past 10 min");
  assert.equal(asked.filter((u) => u === env.BASE_RPC_URL_DRPC_1).length, 11, "the down one every minute");
});

test("review M3: /v1/health marks a keyed list's URL with no key in it (a company's public endpoint) as keyless", () => {
  const env = { NEAR_RPC_URL_FASTNEAR: LISTS.near[0][1], NEAR_RPC_URL: "https://free.rpc.fastnear.com", NEAR_RPC_URL_B: LISTS.near[2][1] };
  assert.deepEqual((createRpc(env) as Rpc).keyed?.().near, ["fastnear.com unread", "fastnear.com keyless unread", "keyed-b.test unread"]);
});

test("review L1: a hold's log line names the company, never the keyed host", async () => {
  const lines: string[] = [];
  const fetch = async (): Promise<Response> => new Response("slow", { status: 429, headers: { "retry-after": "1" } });
  const c = clock();
  const r = createRpc(ENV, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(ENV) ?? {}), now: c.now, sleep: c.sleep, log: (l) => lines.push(l) });
  await r.handle("base", "application/json", JSON.stringify(READ.base));
  r.backgroundThrottled("solana", LISTS.solana[1][1], new Headers({ "retry-after": "1" }));
  assert.ok(lines.some((l) => / quiknode\.test (caller|background) /.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /name-(one|two)|base-mainnet\.alchemy|lb\.drpc/.test(l)), lines.join("\n"));
});

test("review L2: QuickNode as Solana's key (SOLANA_RPC_URL unset) draws its company's one bucket, never the chain's pacer", async () => {
  const env = { SOLANA_RPC_URL_QUICKNODE: LISTS.solana[1][1], SOLANA_RPC_URL_DRPC_1: LISTS.solana[2][1], BASE_RPC_URL_QUICKNODE: LISTS.base[1][1] };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), answer(init, { value: 1 }));
  const c = clock();
  const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
  const r = createRpc(env, { fetch: fetch as never, holds, now: c.now, sleep: c.sleep, log: () => undefined });
  // the endpoint's own bucket emptied (by other reads of it)
  assert.equal(holds.take(env.SOLANA_RPC_URL_QUICKNODE, holds.paceOf(env.SOLANA_RPC_URL_QUICKNODE)?.burst ?? 0, false), 0);
  const a = await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.9");
  assert.equal(a.status, 200, a.body);
  assert.deepEqual(asked, [env.SOLANA_RPC_URL_DRPC_1], "QuickNode's bucket is empty: the read goes to dRPC");
});

test("review L2: with NEAR_RPC_URL_FASTNEAR set, NEAR_RPC_URL keeps its chain's pacer (RPC_BUDGET_NEAR's total a second) on the walk", async () => {
  const env = { NEAR_RPC_URL_FASTNEAR: LISTS.near[0][1], NEAR_RPC_URL: LISTS.near[1][1] };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), url === env.NEAR_RPC_URL_FASTNEAR ? new Response("down", { status: 503 }) : answer(init, { ok: 1 }));
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 15; i++) await r.handle("near", "application/json", JSON.stringify(READ.near), `198.51.100.${i}`);
  const own = asked.filter((u) => u === env.NEAR_RPC_URL).length;
  assert.ok(own <= 10, `NEAR_RPC_URL was sent ${own} reads in one second, past the chain's 10`);
});

test("review L4: a Solana read the first key throttled, whose spares are held a moment, is served by a spare after the wait, not refused on the first key's held budget", async () => {
  const [own, qn, dr] = urlsOf("solana");
  const env = Object.fromEntries(LISTS.solana.map(([n, u]) => [n, u]));
  const seen = new Map<string, number>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.set(url, (seen.get(url) ?? 0) + 1);
    if (url === own) return new Response("slow", { status: 429, headers: { "retry-after": "20" } });
    if ((url === qn || url === dr) && seen.get(url) === 1) return new Response("slow", { status: 429, headers: { "retry-after": "1" } });
    return answer(init, { value: url === qn ? "spare" : "other" });
  };
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
  const a = await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.9");
  assert.equal(a.status, 200, a.body);
  assert.equal(JSON.parse(a.body).result.value, "spare", "the spare after its wait, not the public endpoint");
});

test("review L5: no probe reads Solana's first URL while its chain's 429 hold lasts", async () => {
  const own = LISTS.solana[0][1];
  const env = { SOLANA_RPC_URL: own };
  const asked: string[] = [];
  const fetch = async (url: string): Promise<Response> => (asked.push(url), new Response("slow", { status: 429, headers: { "retry-after": "20" } }));
  const c = clock();
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, {}), now: c.now, sleep: c.sleep, log: () => undefined, publicFallback: false }) as Rpc;
  await r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.9");
  const n = asked.length;
  await r.probe?.();
  assert.equal(asked.length, n, "the probe read the first URL inside its hold");
});

test("owner 09:16Z: dRPC's key 1 past its own daily budget is sent nothing more, and key 2 serves; key 2's budget is its own", async () => {
  const [, , dr1] = urlsOf("base");
  const [[n2, dr2], [n3, dr3]] = DRPC_MORE.base as [[string, string], [string, string]];
  // 40 CU a day each: two calls of 20 per key
  const env: Record<string, string> = { BASE_RPC_URL_DRPC_1: dr1, [n2!]: dr2!, [n3!]: dr3!, RPC_DAY_DRPC: "40" };
  const asked: string[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => (asked.push(url), answer(init, "0x1"));
  const c = clock();
  c.t.v = Math.ceil(c.t.v / 86_400_000) * 86_400_000 + 1_000;
  const holds = providerHolds(c.now, keyedPaces?.(env) ?? {});
  assert.notEqual(holds.paceOf(dr1)?.group, holds.paceOf(dr2!)?.group, "each key its own account");
  const r = createRpc(env, { fetch: fetch as never, holds, pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
  for (let i = 0; i < 4; i++) {
    assert.equal((await r.handle("base", "application/json", JSON.stringify(READ.base), "198.51.100.9")).status, 200);
    c.t.v += 1_000;
  }
  assert.deepEqual(asked, [dr1, dr1, dr2, dr2], "key 1 twice, then nothing on key 1; key 2 serves");
});

test("owner 09:16Z: with dRPC's three keys all held, the public spares serve, on Base and on Solana", async () => {
  for (const chain of ["base", "solana"] as const) {
    const [own, qn, dr1] = urlsOf(chain);
    const keys = [dr1, ...DRPC_MORE[chain].map(([, u]) => u)];
    const env: Record<string, string> = Object.fromEntries([...LISTS[chain].map(([n, u]) => [n, u as string]), ...DRPC_MORE[chain]]);
    const asked: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(url);
      if (url === own || url === qn || keys.includes(url)) return new Response("slow", { status: 429, headers: { "retry-after": "20" } });
      return answer(init, chain === "base" ? "0x1" : { value: "public" });
    };
    const c = clock();
    const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]), "198.51.100.9");
    assert.equal(a.status, 200, `${chain}: ${a.body}`);
    assert.ok(keys.every((k) => asked.includes(k)), `${chain}: each dRPC key asked once before the spares`);
    assert.ok(!keys.includes(asked.at(-1)!) && asked.at(-1) !== own && asked.at(-1) !== qn, `${chain}: a public spare served (${hostsOf(asked).join(" -> ")})`);
    // the next read skips every held key and goes straight to the spares
    const n = asked.length;
    assert.equal((await r.handle(chain, "application/json", JSON.stringify(READ[chain]), "198.51.100.9")).status, 200);
    assert.ok(!asked.slice(n).some((u) => keys.includes(u)), `${chain}: a held key was asked again`);
  }
});

test("owner 09:16Z: /v1/health names each dRPC key as its own entry (key1, key2, key3), in order after QuickNode", () => {
  const env: Record<string, string> = Object.fromEntries([...LISTS.base.map(([n, u]) => [n, u as string]), ...DRPC_MORE.base]);
  assert.deepEqual((createRpc(env) as Rpc).keyed?.().base, ["alchemy.test unread", "quiknode.test unread", "drpc.test key1 unread", "drpc.test key2 unread", "drpc.test key3 unread"]);
});

// ---- the delta review of 424dce1e (H1, M2, M3, L2, L3, L4) ----

/** The keyed accounts' shared daily spend (review H1), read off the module so this file loads at a base without it. */
const daySpend = (await import("../limits/day-spend.ts").catch(() => ({}))) as { dayFiles?: (dir: string, id: string) => unknown };
const dayStart = () => Math.ceil((performance.timeOrigin + performance.now()) / 86_400_000) * 86_400_000 + 1_000;
const holdsOn = (now: () => number, pace: Record<string, Pace>, peers: unknown) => (providerHolds as unknown as (n: () => number, p: Record<string, Pace>, d?: unknown) => ReturnType<typeof providerHolds>)(now, pace, peers);

test("review H1: a helper restart (a deploy) resumes the day's spend from the helper's store: two starts on one store send one day's budget, not two", () => {
  const qn = LISTS.base[1][1];
  const env = { BASE_RPC_URL_QUICKNODE: qn, RPC_DAY_QUICKNODE: "200" }; // 10 Base calls of 20 credits a day
  const dir = mkdtempSync(join(tmpdir(), "ct-rpc-day-"));
  const t = { v: dayStart() };
  let sent = 0;
  for (let start = 0; start < 2; start++) {
    const holds = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, `0000000${start}-aaaa-bbbb-cccc-000000000000`));
    for (let i = 0; i < 20; i++) {
      t.v += 1_000;
      if (holds.take(qn, 1, false) === 0) sent++;
    }
  }
  assert.equal(sent, 10, `${sent} calls sent in one UTC day against a budget of 10: each start spent the day again`);
  // the next UTC day: a full budget again
  t.v += 86_400_000;
  const next = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "00000009-aaaa-bbbb-cccc-000000000000"));
  assert.equal(next.take(qn, 1, false), 0);
});

test("review H1: during a deploy's handover the old and the new helper draw one day's budget between them", () => {
  const dr = LISTS.base[2][1];
  const env = { BASE_RPC_URL_DRPC_1: dr, RPC_DAY_DRPC: "200" }; // 10 calls of 20 CU
  const dir = mkdtempSync(join(tmpdir(), "ct-rpc-day-"));
  const t = { v: dayStart() };
  const old = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "0000000a-aaaa-bbbb-cccc-000000000000"));
  const neu = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "0000000b-aaaa-bbbb-cccc-000000000000"));
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    t.v += 1_100; // past the peers' re-read and the write's pace each step
    if ((i % 2 === 0 ? old : neu).take(dr, 1, false) === 0) sent++;
  }
  assert.ok(sent <= 10, `${sent} calls sent by the two helpers against one budget of 10`);
  assert.equal(holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "0000000c-aaaa-bbbb-cccc-000000000000")).room(dr), 0, "a third start sees the day spent");
});

test("review H1: the day files are hostile input: a file that does not parse, a negative or non-number spend, another day's file or a stranger's name counts nothing; an old day's file is removed", () => {
  const qn = LISTS.base[1][1];
  const env = { BASE_RPC_URL_QUICKNODE: qn, RPC_DAY_QUICKNODE: "200" };
  const dir = mkdtempSync(join(tmpdir(), "ct-rpc-day-"));
  const t = { v: dayStart() };
  const day = Math.floor(t.v / 86_400_000);
  const first = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "0000000d-aaaa-bbbb-cccc-000000000000"));
  assert.equal(first.take(qn, 1, false), 0); // makes the folder
  const sub = readdirSync(dir).find((n) => !n.startsWith("."))!;
  const group = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, undefined).paceOf(qn)!.group!;
  writeFileSync(join(dir, sub, "0000000e-aaaa-bbbb-cccc-000000000000.json"), "{not json");
  writeFileSync(join(dir, sub, "0000000f-aaaa-bbbb-cccc-000000000000.json"), JSON.stringify({ day, units: { [group]: -1e9 } }));
  writeFileSync(join(dir, sub, "00000010-aaaa-bbbb-cccc-000000000000.json"), JSON.stringify({ day, units: { [group]: "180" } }));
  writeFileSync(join(dir, sub, "00000011-aaaa-bbbb-cccc-000000000000.json"), JSON.stringify({ day: day - 1, units: { [group]: 180 } }));
  writeFileSync(join(dir, sub, "notahelper.json"), JSON.stringify({ day, units: { [group]: 180 } }));
  t.v += 1_100;
  const second = holdsOn(() => t.v, keyedPaces?.(env) ?? {}, daySpend.dayFiles?.(dir, "00000012-aaaa-bbbb-cccc-000000000000"));
  let sent = 0;
  for (let i = 0; i < 12; i++) if ((t.v += 1_100), second.take(qn, 1, false) === 0) sent++;
  assert.equal(sent, 9, "the first start's one call counts, nothing else");
  assert.ok(!readdirSync(join(dir, sub)).includes("00000011-aaaa-bbbb-cccc-000000000000.json"), "yesterday's file is removed");
});

test("review H1: the server keeps each account's daily spend in its store (HELPER_STORE_DIR), shared with the helper it replaces", () => {
  const main = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(main, /providerHolds\(undefined, \{ \.\.\.PROVIDER_PACE, \.\.\.keyedPaces\(process\.env\) \}, dayFiles\(storeDir, /);
});

for (const chain of ["solana", "base"] as const) {
  test(`review M2 (${chain}): a keyed URL whose plan is spent, answering HTTP 200 with a JSON-RPC error naming its credits, is down for the read: the next provider answers`, async () => {
    const qn = chain === "solana" ? LISTS.solana[1][1] : LISTS.base[1][1];
    const dr = chain === "solana" ? LISTS.solana[2][1] : LISTS.base[2][1];
    const env: Record<string, string> = chain === "solana" ? { SOLANA_RPC_URL_QUICKNODE: qn, SOLANA_RPC_URL_DRPC_1: dr } : { BASE_RPC_URL_QUICKNODE: qn, BASE_RPC_URL_DRPC_1: dr };
    const asked: string[] = [];
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      asked.push(url);
      const id = (JSON.parse(String(init.body)) as { id: unknown }).id;
      if (url === qn) return json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Your monthly API credits are exhausted. Upgrade your plan." } });
      return json({ jsonrpc: "2.0", id, result: "from-drpc" });
    };
    const c = clock();
    const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]), "198.51.100.4");
    assert.equal(a.status, 200, a.body);
    assert.equal(JSON.parse(a.body).result, "from-drpc", `the caller got the spent key's answer: ${a.body}`);
    assert.deepEqual(asked, [qn, dr]);
  });
}

test("review M3: a key past its day with every other provider down answers 503 (the device reads its own), never a 429 wait", async () => {
  const qn = LISTS.base[1][1];
  const env = { BASE_RPC_URL_QUICKNODE: qn, RPC_DAY_QUICKNODE: "20" };
  const c = clock();
  c.t.v = dayStart();
  let down = false;
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => (down ? new Response("down", { status: 503 }) : answer(init, "0x1"));
  const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test", "https://p2.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
  assert.equal((await r.handle("base", "application/json", JSON.stringify(READ.base), "198.51.100.1")).status, 200); // QuickNode's 20 credits
  down = true;
  c.t.v += 2_000;
  const a = await r.handle("base", "application/json", JSON.stringify(READ.base), "198.51.100.2");
  assert.equal(a.status, 503, `${a.status} ${a.body} ${JSON.stringify(a.headers ?? {})}`);
});

test("review L3: a keyed URL that echoes its key in an answer is down for the read: the next provider answers, and the echo is never forwarded", async () => {
  for (const chain of ["base", "near"] as const) {
    const [first, second, third] = urlsOf(chain);
    const env = Object.fromEntries(LISTS[chain].map(([n, u]) => [n, u as string]));
    const fetch = async (url: string, init: RequestInit): Promise<Response> => answer(init, url === first ? `echo ${url}` : url === second ? "clean" : "third");
    const c = clock();
    const r = createRpc(env, { fetch: fetch as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), pinned: { base: ["https://p1.test"] }, now: c.now, sleep: c.sleep, log: () => undefined });
    const a = await r.handle(chain, "application/json", JSON.stringify(READ[chain]), "198.51.100.5");
    assert.equal(a.status, 200, `${chain}: ${a.status} ${a.body}`);
    assert.equal(JSON.parse(a.body).result, "clean");
    assert.ok(!a.body.includes(first.slice(-20)) && !a.body.includes(third.slice(-20)));
  }
});

/** Runs `f` with each AbortSignal.timeout's ms recorded (the last one is the send in flight's timeout). */
async function timeouts<T>(f: (last: () => number) => Promise<T>): Promise<T> {
  const orig = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => (seen.push(ms), orig.call(AbortSignal, ms))) as typeof AbortSignal.timeout;
  try {
    return await f(() => seen.at(-1) ?? Infinity);
  } finally {
    AbortSignal.timeout = orig;
  }
}
/** A provider that never answers: each send takes its whole timeout on the fake clock and half a ms more (a timer fires
 *  late), then aborts, so the walk's time left is never a whole number of ms. */
const hangs = (c: ReturnType<typeof clock>, last: () => number, asked: string[]) => async (url: string): Promise<Response> => {
  asked.push(url);
  c.t.v += last() + 0.5;
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

test("review L4: a walk ends inside the server's 15 s request timeout however its providers hang: each send's timeout ends by the read's WALK_MS, and none starts past it", async () => {
  const { WALK_MS } = rpcModule as unknown as { WALK_MS?: number };
  assert.ok(typeof WALK_MS === "number" && WALK_MS < 15_000, "rpc.ts WALK_MS, under the server's requestTimeout");
  // NEAR's list: FastNear, NEAR_RPC_URL, NEAR_RPC_URL_B, then the public one, every one hanging
  const env = Object.fromEntries(LISTS.near.map(([n, u]) => [n, u as string]));
  const c = clock();
  c.t.v += 0.37; // the monotonic clock's fractional ms: each send's timeout is still a whole number of ms
  const begun = c.t.v;
  const asked: string[] = [];
  const a = await timeouts((last) => {
    const r = createRpc(env, { fetch: hangs(c, last, asked) as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
    return r.handle("near", "application/json", JSON.stringify(READ.near), "198.51.100.6");
  });
  assert.equal(a.status, 503, a.body);
  assert.ok(asked.length >= 2, `${asked.length} sends: the first keeps its whole timeout, the next the walk's rest`);
  assert.ok(c.t.v - begun <= WALK_MS + 1, `the walk ran ${Math.round(c.t.v - begun)} ms against WALK_MS ${WALK_MS}`);
});

test("review L4: Solana's first key hanging leaves its spares and the public endpoint only the rest of the read's WALK_MS, not a walk of their own", async () => {
  const { WALK_MS } = rpcModule as unknown as { WALK_MS?: number };
  assert.ok(typeof WALK_MS === "number");
  const env: Record<string, string> = { ...Object.fromEntries(LISTS.solana.map(([n, u]) => [n, u as string])), ...Object.fromEntries(DRPC_MORE.solana) };
  const c = clock();
  const begun = c.t.v;
  const asked: string[] = [];
  const a = await timeouts((last) => {
    const r = createRpc(env, { fetch: hangs(c, last, asked) as never, holds: providerHolds(c.now, keyedPaces?.(env) ?? {}), now: c.now, sleep: c.sleep, log: () => undefined });
    return r.handle("solana", "application/json", JSON.stringify(READ.solana), "198.51.100.7");
  });
  assert.equal(a.status, 503, a.body);
  assert.ok(c.t.v - begun <= WALK_MS + 1, `the read ran ${Math.round(c.t.v - begun)} ms against WALK_MS ${WALK_MS}`);
  assert.ok(!asked.includes("https://api.mainnet-beta.solana.com"), "the public endpoint was sent the read past the walk's time");
});

test("review L2: every dRPC URL the helper paces (the three keys and its keyless robinhood.drpc.org, one IP) fits dRPC's free floor of 50,400 CU a minute in the worst minute", () => {
  const env: Record<string, string> = { ...ENV, ...Object.fromEntries(DRPC_MORE.base) };
  const keyless = PROVIDER_PACE["https://robinhood.drpc.org"]!;
  // one bucket per account: each key's group once (its URLs on every chain share it)
  const keys = new Map<string, Pace>();
  for (const [u, p] of Object.entries(keyedPaces?.(env) ?? {})) if (/drpc/.test(new URL(u).host)) keys.set(p.group ?? u, p);
  assert.equal(keys.size, 3, "three dRPC accounts");
  const all = [...keys.values(), keyless];
  const worstMinute = all.reduce((s, p) => s + (p.perS * 60 + p.burst) * 20, 0); // 20 CU a call (KEYED_COST)
  assert.ok(worstMinute <= 50_400, `${worstMinute} CU in the worst minute from the helper's IP`);
});
