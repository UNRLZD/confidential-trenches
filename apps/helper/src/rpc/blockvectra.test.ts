// Fixture-only regressions through the registry, server assembly and shared provider holds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as server from "../server.ts";
import { createRpc, keyedAccountOf, keyedPaces, readUpstreams, RPC_UPSTREAMS, KEYED_PROVIDER } from "./rpc.ts";
import { providerHolds, KEYED_COST, type ProviderHolds } from "../limits/limits.ts";
import { INDEX_RPCS, SWAP_RPCS } from "../data/evm/swaps.ts";
import { fakeChain, CURVE_TOKEN, REC } from "../../test/evm-swaps/robinhood.ts";
import { blockvectraFromEnv, blockvectraHeaders, blockvectraLeaks } from "./blockvectra.ts";
import { health } from "../health.ts";

const URL_ = "https://api.blockvectra.com/v1/robinhood_mainnet";
const KEY = "fixture-only-blockvectra-header-key";
const ENV = { ROBINHOOD_RPC_URL_BLOCKVECTRA: URL_, ROBINHOOD_RPC_KEY_BLOCKVECTRA: KEY, RPC_DAY_BLOCKVECTRA: "1000000" };
const methods = ["eth_getBlockByNumber", "eth_getLogs", "eth_call", "eth_getTransactionReceipt", "eth_getTransactionByHash"];
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const take = (h: ProviderHolds, url: string, ms: string[]) => (h.take as (u: string, n: number, bg: boolean, sender: boolean, methods: string[]) => number)(url, ms.length, false, false, ms);

test("reflected header fixtures containing quotes and backslashes are rejected after JSON escaping", () => {
  for (const key of ['fixture-only-"quoted"-key', "fixture-only-\\backslash-key"]) {
    const config = blockvectraFromEnv({ ...ENV, ROBINHOOD_RPC_KEY_BLOCKVECTRA: key });
    assert.equal(blockvectraLeaks(config, JSON.stringify({ result: key })), true);
    assert.equal(blockvectraLeaks(config, JSON.stringify({ [key]: "reflected property" })), true);
  }
});

test("BlockVectra is a distinct Robinhood-only opt-in; partial or unsafe config is refused without its value", () => {
  assert.ok(RPC_UPSTREAMS.robinhood.keyed.includes("ROBINHOOD_RPC_URL_BLOCKVECTRA"));
  assert.equal(KEYED_PROVIDER.ROBINHOOD_RPC_URL_BLOCKVECTRA, "blockvectra");
  assert.equal(keyedAccountOf("ROBINHOOD_RPC_URL_BLOCKVECTRA"), "blockvectra");
  assert.deepEqual(server.evmSwapRpcs({}, "robinhood"), SWAP_RPCS.robinhood);
  assert.deepEqual(server.evmSwapRpcs({ ROBINHOOD_RPC_URL_BLOCKVECTRA: "", ROBINHOOD_RPC_KEY_BLOCKVECTRA: "", RPC_DAY_BLOCKVECTRA: "", RPC_BLOCKVECTRA_PRICING_PROFILE: "" }, "robinhood"), SWAP_RPCS.robinhood);
  assert.ok(!readUpstreams({}).robinhood.keyed.some((k) => k.url === URL_));
  assert.ok(server.evmSwapRpcs(ENV, "robinhood").includes(URL_));
  assert.ok(!server.evmSwapRpcs(ENV, "base").includes(URL_));
  assert.equal(readUpstreams(ENV).robinhood.keyed.find((k) => k.url === URL_)?.keyless, false);
  for (const name of Object.keys(ENV)) {
    const env: Record<string, string> = { ...ENV };
    delete env[name];
    assert.throws(() => readUpstreams(env), /BlockVectra/);
  }
  for (const bad of ["0", "-1", "1.5", "30M", "", "9007199254740992"]) assert.throws(() => keyedPaces({ ...ENV, RPC_DAY_BLOCKVECTRA: bad }), /BlockVectra/);
  for (const url of [URL_ + "/public", URL_ + "/", URL_ + "?key=x", URL_ + "#x", URL_.replace("https:", "http:"), URL_.replace(".com/", ".com:443/"), URL_.replace("api.", "evil."), URL_.replace("api.", "user:pass@api.")]) {
    assert.throws(() => readUpstreams({ ...ENV, ROBINHOOD_RPC_URL_BLOCKVECTRA: url }), /BlockVectra/);
  }
  for (const key of ["", "\nfixture", "fixture key"]) assert.throws(() => readUpstreams({ ...ENV, ROBINHOOD_RPC_KEY_BLOCKVECTRA: key }), /BlockVectra/);
  assert.throws(() => readUpstreams({ ROBINHOOD_RPC_URL: URL_ }), /BlockVectra/);
  assert.throws(() => readUpstreams({ ...ENV, BASE_RPC_URL: URL_ }), /BlockVectra/);
  for (const url of [URL_ + "/public", URL_ + "/", URL_ + "?x=1", URL_ + "#x", URL_.replace("https:", "http:"), URL_.replace(".com/", ".com:443/"), URL_.replace("api.", "evil."), URL_.replace("api.", "user:pass@api.")]) {
    assert.deepEqual(blockvectraHeaders(blockvectraFromEnv(ENV), url), {});
  }
});

test("refreshable client Plans profile uses exact > longest prefix > wildcard and refuses zero, duplicate or unknown prices", () => {
  const profile = { asOf: "2026-11-09T00:00:00Z", method_weights: [{ method: "*", cu_weight: 11 }, { method: "eth_*", cu_weight: 22 }, { method: "eth_get*", cu_weight: 33 }, { method: "eth_getLogs", cu_weight: 44 }] };
  const env = { ...ENV, RPC_BLOCKVECTRA_PRICING_PROFILE: JSON.stringify(profile) };
  const price = keyedPaces(env)[URL_]!.methodCost!;
  assert.deepEqual(["other", "eth_call", "eth_getTransactionByHash", "eth_getLogs"].map(price), [11, 22, 33, 44]);
  for (const rows of [[], [{ method: "eth_call", cu_weight: 15 }], [{ method: "*", cu_weight: 0 }], [{ method: "*", cu_weight: -1 }], [{ method: "*", cu_weight: 1.5 }], [{ method: "*", cu_weight: 10 }, { method: "*", cu_weight: 11 }], [{ method: "eth_*Logs", cu_weight: 10 }]]) {
    assert.throws(() => keyedPaces({ ...env, RPC_BLOCKVECTRA_PRICING_PROFILE: JSON.stringify({ ...profile, method_weights: rows }) }), /BlockVectra/);
  }
  assert.throws(() => keyedPaces({ ...env, RPC_BLOCKVECTRA_PRICING_PROFILE: "invalid fixture JSON" }), /BlockVectra/);
  assert.equal(keyedPaces(ENV)[URL_]!.methodCost!("unlisted_method"), 10);
  const h = providerHolds(() => 100000, keyedPaces(ENV));
  assert.ok(h.take(URL_, 1, false) > 0, "missing method must fail closed");
  assert.ok(h.take(URL_, 1, false, true) > 0, "sender flag cannot bypass method budget");
});

test("shared DayPeers account charges five-method sum 70 CU, each retry, and denies before the send; other providers keep prices", () => {
  const paces = keyedPaces({ ...ENV, RPC_DAY_BLOCKVECTRA: "140" });
  assert.equal(paces[URL_]?.group, "blockvectra");
  assert.equal(paces[URL_]?.batch, 1);
  assert.equal(paces[URL_]?.perS, 100);
  assert.equal(paces[URL_]?.burst, 400);
  let saved = new Map<string, number>();
  const peers = { read: () => new Map<string, number>(), write: (_day: number, units: Map<string, number>) => { saved = new Map(units); } };
  const h = providerHolds(() => 100000, paces, peers);
  assert.equal(take(h, URL_, methods), 0);
  assert.equal(saved.get("blockvectra"), 70);
  const restarted = providerHolds(() => 102000, { ...paces, "https://alias.test": paces[URL_]! }, { read: () => saved, write: () => undefined });
  assert.equal(take(restarted, "https://alias.test", methods), 0);
  assert.ok(take(restarted, URL_, ["eth_chainId"]) > 0, "same account across named routes/restarts");
  assert.equal(KEYED_COST.drpc.evm, 20);
  assert.equal(KEYED_COST.quicknode.evm, 20);
  assert.equal(KEYED_COST.quicknode.solana, 30);
  const legacy = providerHolds(() => 100000, keyedPaces({ BASE_RPC_URL_DRPC_1: "https://lb.drpc.test/fixture", RPC_DAY_DRPC: "40" }));
  assert.equal(legacy.take("https://lb.drpc.test/fixture", 2, false), 0);
  assert.ok(legacy.take("https://lb.drpc.test/fixture", 1, false) > 0);
});

test("real RPC sends and failed retries spend their individual method CU and stop before daily budget, sharing with reader holds", async () => {
  const env = { ...ENV, RPC_DAY_BLOCKVECTRA: "140" };
  let now = 100000;
  let saved = new Map<string, number>();
  const holds = providerHolds(() => now, keyedPaces(env), { read: () => new Map(), write: (_d, units) => { saved = new Map(units); } });
  let sends = 0;
  const rpc = createRpc(env, { holds, now: () => now, publicFallback: false, log: () => undefined, fetch: (async (url: string) => {
    assert.equal(url, URL_); sends++; return json({}, 503);
  }) as never });
  for (let round = 0; round < 2; round++) for (const method of methods) {
    now += 2000;
    const result = await rpc.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }));
    assert.equal(result.status, 503);
  }
  assert.equal(sends, 10);
  assert.equal(saved.get("blockvectra"), 140, "failed transmissions charged, not HTTP packet count");
  now += 2000;
  assert.equal((await rpc.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }))).status, 503);
  assert.equal(sends, 10, "budget refused before fetch");
  assert.ok(take(holds, URL_, ["eth_getLogs"]) > 0, "reader/index cannot spend the RPC route's exhausted account");
});

test("actual RPC path never sends a header to configured alternate host/path/port and never follows keyed redirect", async () => {
  for (const url of [URL_ + "/public", URL_ + "/other", URL_.replace("api.", "evil."), URL_.replace(".com/", ".com:443/")]) {
    let sent = false;
    const rpc = createRpc({ ...ENV, ROBINHOOD_RPC_URL: url }, { log: () => undefined, fetch: (async (target: string, init: RequestInit) => {
      assert.equal(target, url); assert.equal(new Headers(init.headers).get("x-api-key"), null); assert.equal(init.redirect, "error"); sent = true;
      return json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    }) as never });
    assert.equal((await rpc.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }))).status, 200);
    assert.ok(sent);
  }
});

test("actual RPC walk and identity probe send header only to exact configured target, reject reflected secrets and redirects", async () => {
  const asked: { url: string; init: RequestInit; method: string }[] = [];
  const lines: string[] = [];
  let mode = "ok";
  const r = createRpc(ENV, { fetch: (async (url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    const q = Array.isArray(req) ? req[0] : req;
    asked.push({ url, init, method: q.method });
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("x-api-key"), url === URL_ ? KEY : null);
    if (url === URL_ && mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
    if (url === URL_ && mode === "escaped") return new Response('{"jsonrpc":"2.0","id":1,"result":"' + [...KEY].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"}', { headers: { "content-type": "application/json" } });
    return json({ jsonrpc: "2.0", id: q.id, result: url === URL_ && mode === "echo" ? KEY : q.method === "eth_chainId" ? "0x1237" : "0x1" });
  }) as never, log: (l) => lines.push(l) });
  const call = () => r.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }));
  await r.probe();
  assert.equal((await call()).status, 200);
  assert.equal(asked[0]?.url, URL_);
  assert.ok(asked.some((a) => a.url === URL_ && a.method === "eth_chainId"));
  for (mode of ["echo", "escaped", "redirect"]) {
    const a = await call();
    assert.ok(!a.body.includes(KEY));
    assert.ok(!asked.some((a) => a.url.includes("evil.test")));
  }
  assert.ok(!JSON.stringify([lines, r.keyed()]).includes(KEY));
});

test("server's actual swap and chainwide index assembly selects keyed reader and retains 1000/500 spans and agreement", async (t) => {
  const chain = fakeChain();
  chain.st.head = REC.firstHead + 600;
  const peer = SWAP_RPCS.robinhood[0]!;
  chain.st.faults.set(URL_, { span: 1000 });
  chain.st.faults.set(peer, { span: 1000 });
  const asked: { url: string; method: string; filter?: { address?: string; topics: unknown[][]; fromBlock: string; toBlock: string } }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("x-api-key"), input === URL_ ? KEY : null);
    const body = JSON.parse(String(init.body));
    if (input === URL_) assert.equal(body.length, 1);
    for (const q of body) asked.push({ url: input, method: q.method, filter: q.method === "eth_getLogs" ? q.params[0] : undefined });
    if (input !== URL_ && input !== peer) return json({}, 503);
    // A bundle lookup exercises the real receipt path. Missing receipts leave trader unknown.
    const answers = await (await chain.fetch(input, init)).json() as { result?: Record<string, unknown> }[];
    for (let i = 0; i < body.length; i++) {
      if (body[i].method === "eth_getTransactionByHash" && answers[i]?.result) answers[i]!.result!.to = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
      if (body[i].method === "eth_getTransactionReceipt") answers[i] = { ...answers[i], result: undefined };
    }
    return json(answers);
  });
  const paces = keyedPaces(ENV);
  // Keep the method pricing and shared account; remove clock waits from this assembly test.
  let clock = 1000000;
  let peerSpend = 0;
  let written = new Map<string, number>();
  const holds = providerHolds(() => (clock += 2000), Object.fromEntries(Object.entries(paces).map(([u, p]) => [u, { ...p, perS: 100000, burst: 100000 }])), {
    read: () => new Map([["blockvectra", peerSpend]]), write: (_day, units) => { written = new Map(units); },
  });
  const lists = { robinhood: { listed: async () => true, get: async () => ({ status: 200, body: JSON.stringify({ lists: {}, pools: {} }), asOfMs: 1 }) } };
  const swaps = server.evmSwapsFromEnv(ENV, lists as never, undefined, holds);
  try {
    const a = await swaps.robinhood!.trades(CURVE_TOKEN, 10);
    assert.equal(a.status, 200, a.body);
    assert.ok(JSON.parse(a.body).trades.length > 0);
    assert.ok(asked.some((a) => a.url === URL_ && a.method === "eth_call"), "real pool discovery uses keyed calls");
    assert.ok(asked.some((a) => a.url === URL_ && a.method === "eth_getTransactionByHash"), "real trader lookup uses keyed singleton posts");
    assert.ok(asked.some((a) => a.url === URL_ && a.method === "eth_getTransactionReceipt"), "real bundle lookup uses keyed receipts");
    const logs = asked.filter((a) => a.url === URL_ && a.filter !== undefined);
    assert.ok(logs.some((a) => a.filter!.address === undefined), "server's index selected keyed provider");
    assert.ok(logs.some((a) => a.filter!.address !== undefined), "pool read selected keyed provider");
    for (const a of logs) {
      const f = a.filter!;
      assert.ok(parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) + 1 <= (f.address === undefined ? 500 : 1000));
      if (f.address === undefined) assert.equal(f.topics[0]!.length, 8);
    }
    await swaps.robinhood!.follow();
    const spent = asked.filter((a) => a.url === URL_).reduce((n, a) => n + paces[URL_]!.methodCost!(a.method), 0);
    assert.equal(written.get("blockvectra"), spent, "actual pool, index, call and trader sends all reach DayPeers in method CU");
    // A handover peer spends the remainder. The very same holds used by both readers must refuse /v1/rpc.
    peerSpend = Number(ENV.RPC_DAY_BLOCKVECTRA) - spent;
    const rpc = createRpc(ENV, { holds, publicFallback: false, log: () => undefined, fetch: (async () => { assert.fail("exhausted account must not send"); }) as never });
    const refused = await rpc.handle("robinhood", "application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [] }));
    assert.equal(refused.status, 503);
  } finally { Object.values(swaps).forEach((s) => s?.stop()); }
  const indexRpcs = (server as unknown as { evmIndexRpcs?: (env: typeof ENV | {}, chain: "robinhood") => readonly string[] }).evmIndexRpcs;
  assert.deepEqual(indexRpcs?.({}, "robinhood"), INDEX_RPCS.robinhood);
});

for (const fault of ["down", "missing-time", "disagree", "incomplete", "bad-hash", "redirect", "reflected"] as const) {
  test(`assembled reader refuses ${fault} from keyed provider when only one other company answers`, async (t) => {
    const chain = fakeChain();
    chain.st.head = REC.firstHead + 600;
    const peer = SWAP_RPCS.robinhood[0]!;
    chain.st.faults.set(URL_, { span: 1000, ...(fault === "down" ? { down: true } : fault === "missing-time" ? { zeroTime: true } : fault === "disagree" ? { skewTime: true } : {}) });
    chain.st.faults.set(peer, { span: 1000 });
    let keyedLogs = 0;
    t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
      if (input !== URL_ && input !== peer) return json({}, 503);
      const req = JSON.parse(String(init.body)) as { method: string }[];
      if (input === URL_) keyedLogs += req.filter((q) => q.method === "eth_getLogs").length;
      if (input === URL_ && fault === "redirect") {
        assert.equal(init.redirect, "error");
        return new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
      }
      if (input === URL_ && fault === "reflected") return json({ result: KEY });
      const r = await chain.fetch(input, init);
      if (input !== URL_ || (fault !== "incomplete" && fault !== "bad-hash")) return r;
      const answers = await r.json() as { id: number; result?: { transactionHash: string }[] }[];
      if (fault === "incomplete" && req.some((q) => q.method === "eth_getLogs")) return json([]);
      if (fault === "bad-hash") for (let i = 0; i < req.length; i++) if (req[i]!.method === "eth_getLogs" && Array.isArray(answers[i]?.result)) for (const log of answers[i]!.result!) log.transactionHash = "invalid-fixture-hash";
      return json(answers);
    });
    const paces = keyedPaces(ENV);
    const holds = providerHolds(() => Date.now(), Object.fromEntries(Object.entries(paces).map(([u, p]) => [u, { ...p, perS: 100000, burst: 100000 }])));
    const lists = { robinhood: { listed: async () => true, get: async () => ({ status: 200, body: "{}" }) } };
    const swaps = server.evmSwapsFromEnv(ENV, lists as never, undefined, holds);
    try {
      const answer = await swaps.robinhood!.trades(CURVE_TOKEN, 10);
      assert.equal(answer.status, 503, answer.body);
      if (!["down", "redirect", "reflected"].includes(fault)) assert.ok(keyedLogs > 0);
      assert.ok(!answer.body.includes(KEY));
    } finally { Object.values(swaps).forEach((s) => s?.stop()); }
  });
}


test("env-check CLI refuses a partial keyed config before startup and prints only variable names", () => {
  const r = spawnSync(process.execPath, [new URL("../env-check.ts", import.meta.url).pathname], { env: { ...ENV, RPC_DAY_BLOCKVECTRA: "0" }, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /BlockVectra RPC_DAY_BLOCKVECTRA/);
  assert.ok(!r.stderr.includes(KEY));
});

test("nineteen real registry slots in wrong-chain state still fit the 1KB health contract; default labels stay unchanged", async () => {
  const env: Record<string, string> = { ...ENV };
  for (const [chain, config] of Object.entries(RPC_UPSTREAMS)) {
    if (chain === "solana-devnet") continue;
    for (const name of config.keyed) {
      if (name.endsWith("_BLOCKVECTRA")) continue;
      const host = name.includes("QUICKNODE") ? "quiknode.pro" : name.includes("DRPC") ? "drpc.live" : chain === "near" ? "fastnear.com" : chain === "solana" ? "helius-rpc.com" : "alchemy.com";
      env[name] = `https://${host}/fixture-token-for-${name.toLowerCase()}`;
    }
  }
  env.NEAR_RPC_URL = "https://rpc.mainnet.fastnear.com";
  env.NEAR_RPC_URL_B = "https://near.lava.build";
  for (const enabled of [true, false]) {
    const configured = { ...env };
    if (!enabled) for (const name of Object.keys(ENV)) delete configured[name];
    const rpc = createRpc(configured, { log: () => undefined, fetch: (async () => json({ jsonrpc: "2.0", id: 1, result: "fixture-wrong-chain" })) as never });
    await rpc.probe();
    const keyed = rpc.keyed();
    assert.equal(Object.values(keyed).flat().length, enabled ? 19 : 18);
    assert.ok(Object.values(keyed).flat().every((v) => v.endsWith(enabled ? " wrong" : " wrong chain")));
    const body = JSON.stringify(health("0".repeat(40), new Set(), 999999999, false, { rpc: "fallback", holders: "fallback", trades: "fallback", stream: "fallback" }, keyed, { mainnet: "a".repeat(64), testnet: "b".repeat(64) }));
    assert.ok(Buffer.byteLength(body) <= 1024, `${Buffer.byteLength(body)} bytes`);
    assert.ok(!body.includes(KEY));
  }
});
