// The signing page's RPCs (card signpage-rpc-throttle-retry): every pool read and send the page makes, testnet and
// mainnet, goes through the kit's client with the page's retry, so a throttle once is a read that lands, never a kind
// that answers failed (run 6: a devnet provider's 429 burst).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SolanaRpcTransportError, solanaPacedRpc } from "../../kit/src/trade/solana/send.ts";
import { pageHelperRpc, pageRpc } from "../src/page-rpc.ts";
import { pageSolanaLister, pageSolanaRpcs, testnetPoolDeps } from "../src/pool-testnet.ts";
import { SOLANA_PROVIDER_A, TRADE_HELPER, releaseTradeDeps } from "../src/trade.ts";
import { readdirSync, readFileSync } from "node:fs";
import { HELPER_RPC_METHODS } from "../../kit/src/helper/v1.ts";

/** globalThis.fetch for one test: each URL answers 429 (Retry-After 0) on its first call, then the call's result. */
async function withThrottledOnce(run: (seen: Map<string, number>) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const seen = new Map<string, number>();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    if (n === 1) return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }), { status: 200 });
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = real;
  }
}

// the testnet build's pool RPCs read through a 429 once in test/pool-testnet.test.ts, which runs as that build
test("the mainnet build's pool RPCs (src/pool-testnet.ts on SIGN_HOST's build): Solana's pair, provider A and the helper's route, reads through a 429 once; Base and Robinhood have no pair yet", async () => {
  await withThrottledOnce(async (seen) => {
    const deps = testnetPoolDeps();
    for (const r of deps.rpcs("solana")!) assert.equal(await (r as unknown as (m: string, p: unknown[]) => Promise<unknown>)("getSlot", []), 42);
    assert.equal(seen.get(SOLANA_PROVIDER_A), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
    assert.equal(deps.rpcs("base"), null);
    assert.equal(deps.rpcs("robinhood"), null);
  });
});

// The page's Solana reads and sends (pool buy, sell, deposit, withdraw, restore and the trade path) each go to both of
// its providers, and the second is the helper's /v1/rpc/solana (main.ts, trade.ts) or /v1/rpc/solana-devnet
// (TESTNET_RPCS), which forwards only HELPER_RPC_METHODS.solana. Card helper-rpc-sell-methods: the files scanned are
// every file the page's source reaches by import, never a hand list (one missed trade.ts and the kit's
// trade/solana/flow.ts and build.ts), and a quoted name of an RPC method's shape is either on the helper's list or on
// NOT_RPC below, never passed over (a filter of known methods passed over any method it did not name).
const SRC = new URL("../src/", import.meta.url);
const PACKAGES = new URL("../../", import.meta.url);
/** A bare @blindfill/<package>[/<entry>] import, through that package's exports map. */
function bareEntry(spec: string): URL | undefined {
  const m = /^@blindfill\/([a-z-]+)(\/.+)?$/.exec(spec);
  if (!m) return undefined;
  const pkg = new URL(`${m[1]}/`, PACKAGES);
  const exp = (JSON.parse(readFileSync(new URL("package.json", pkg), "utf8")) as { exports: Record<string, { default: string }> }).exports[`.${m[2] ?? ""}`];
  assert.ok(exp, `${spec}: on its package's exports map`);
  return new URL(exp.default, pkg);
}
/** Every .ts file the page's src/ reaches by import, export-from or dynamic import, src/ itself included. */
function pageFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const todo = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => new URL(f, SRC));
  for (let u = todo.pop(); u; u = todo.pop()) {
    if (files.has(u.href)) continue;
    const src = readFileSync(u, "utf8");
    files.set(u.href, src);
    for (const [, spec] of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = spec!.startsWith(".") ? new URL(spec!, u) : bareEntry(spec!);
      if (next && next.pathname.endsWith(".ts")) todo.push(next);
    }
  }
  return files;
}
/** Every name of a Solana JSON-RPC method's shape quoted in a file: a get*, is*, simulate*, send* or request* name. */
const solanaMethodsIn = (src: string): string[] => [...src.matchAll(/["'`]((?:get|is|simulate|send|request)[A-Z][A-Za-z]+)["'`]/g)].map((m) => m[1]!);
/** The quoted names of that shape in the page's files that are not RPC methods, each with where it is. */
const NOT_RPC: ReadonlySet<string> = new Set([
  "sendMarginMs", // wallet pool/pool.ts: a field of the pool's timing
]);

/** The methods the files name, each with a file naming it, and those of them off the helper's list. */
function scan(files: ReadonlyMap<string, string>): { used: Map<string, string>; off: string[] } {
  const used = new Map<string, string>();
  for (const [f, src] of files) for (const m of solanaMethodsIn(src)) if (!NOT_RPC.has(m)) used.set(m, f.slice(PACKAGES.href.length));
  return { used, off: [...used].filter(([m]) => !(HELPER_RPC_METHODS.solana as readonly string[]).includes(m)).map(([m, f]) => `${m} (${f})`) };
}

test("card helper-rpc-sell-methods: every Solana method the page's files name is on the helper's list, so its second provider never refuses a read or send of a pool buy, sell, deposit, withdraw or the trade path", () => {
  const files = pageFiles();
  const { used, off } = scan(files);
  for (const f of ["signpage/src/trade.ts", "signpage/src/pool-sell.ts", "signpage/src/pool-buy.ts", "signpage/src/pool-deposit.ts", "kit/src/trade/solana/flow.ts", "kit/src/trade/solana/build.ts", "kit/src/trade/solana/send.ts", "wallet/src/pool/solana.ts", "wallet/src/pool/solana-restore.ts"]) assert.ok(files.has(new URL(f, PACKAGES).href), `the scan reaches ${f}`);
  for (const m of ["getSlot", "getEpochInfo", "getFeeForMessage", "getSignaturesForAddress", "getBlockTime", "getProgramAccounts", "getMultipleAccounts", "simulateTransaction", "getBlockHeight", "sendTransaction"]) assert.ok(used.has(m), `the scan finds ${m}`);
  assert.deepEqual(off, [], `named by the page, refused by the helper (or add a name that is no RPC method to NOT_RPC): ${off.join(", ")}`);
});

test("card helper-rpc-sell-methods: a planted call the hand list and its filter passed over goes red (a file it did not name, a method it did not know)", () => {
  const files = pageFiles();
  for (const [f, m] of [["signpage/src/trade.ts", "getTokenAccountBalance"], ["kit/src/trade/solana/flow.ts", "getRecentPrioritizationFees"], ["signpage/src/pool-sell.ts", "getTokenSupply"]] as const) {
    const href = new URL(f, PACKAGES).href;
    const planted = new Map(files).set(href, `${files.get(href)}\nawait rpc("${m}", []);\n`);
    assert.deepEqual(scan(planted).off, [`${m} (${f})`]);
  }
});

test("the page's direct and helper RPCs (the mainnet pool reads) read through a 429 once", async () => {
  await withThrottledOnce(async (seen) => {
    assert.equal(await pageRpc("https://solana-rpc.publicnode.com")("getSlot", []), 42);
    assert.equal(await pageHelperRpc("https://helper.example")("getSlot", []), 42);
    assert.equal(seen.get("https://solana-rpc.publicnode.com"), 2);
    assert.equal(seen.get("https://helper.example/v1/rpc/solana"), 2);
  });
});

test("the page's trade path (src/trade.ts releaseTradeDeps): both providers read through a 429 once", async () => {
  await withThrottledOnce(async (seen) => {
    const d = releaseTradeDeps();
    for (const p of d.providers) assert.equal(await p("getSlot", []), 42);
    assert.equal(seen.get(SOLANA_PROVIDER_A), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
  });
});

test("a page RPC that stays throttled rejects naming the fault and the host, never a bare failure", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch;
  try {
    const e = await pageRpc("https://api.devnet.solana.com")("getSlot", []).catch((x: unknown) => x);
    assert.ok(e instanceof SolanaRpcTransportError);
    assert.equal(e.fault, "http_429");
    assert.equal(e.host, "api.devnet.solana.com");
  } finally {
    globalThis.fetch = real;
  }
});

// Card solana-release-reads-paced: the page's Solana pair is paced where it is made (the release's trade deps and
// pageSolanaRpcs, which every pool buy, sell, withdraw, settle and restore read takes), so each call waits its turn in
// the provider's one queue (the kit's solanaPacedRpc), never goes out past a full pace. Last in this file: the tight
// limit named here stays on these providers for the rest of the process.
test("card solana-release-reads-paced: the page's Solana pair waits its turn behind a full pace, on both providers", async () => {
  const real = globalThis.fetch;
  const sent: { url: string; at: number }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: u instanceof Request ? u.url : String(u), at: performance.now() });
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 42 }), { status: 200 });
  }) as typeof fetch;
  const tight = { windowMs: 400, total: 1, perMethod: 1 };
  try {
    for (const [name, pair] of [["releaseTradeDeps", () => releaseTradeDeps().providers], ["pageSolanaRpcs", pageSolanaRpcs]] as const) {
      for (const p of [0, 1] as const) {
        const rpc = pair()[p];
        // the pace full: a caller holding this provider under 1 call in any 400 ms has made its call
        await solanaPacedRpc(rpc, tight)("getSlot", []);
        const full = sent.at(-1)!;
        assert.equal(await rpc("getHealth", []), 42);
        const next = sent.at(-1)!;
        assert.equal(next.url, full.url, `${name} ${p}: the same provider`);
        assert.ok(next.at - full.at >= 390, `${name} provider ${p}: went out ${Math.round(next.at - full.at)} ms after the full pace's call, inside its 400 ms window`);
      }
    }
  } finally {
    globalThis.fetch = real;
  }
});

// card sol-pools-mainnet-pin: no keyless mainnet provider answers the mark list (publicnode 403 "Indexed requests
// require a personal token", api.mainnet-beta 403, read 9 Nov 17:23Z), so on the mainnet build the page's lister is the
// helper's marks route (/v1/rpc/solana-marks). The pair reads each listed mark by address, and provider A's reads go to
// provider A alone, never through the helper: a mark the helper makes up is no account there (review of 369a87a8, P1).
test("the mainnet build's Solana reads: the lister is the helper's marks route; the pair's reads go to provider A directly and to the helper's solana route", async () => {
  const real = globalThis.fetch;
  const sent: [string, string][] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: string; method: string };
    sent.push([String(u), b.method]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: 42 }), { status: 200 });
  }) as typeof fetch;
  try {
    const [a, b] = pageSolanaRpcs();
    const lister = pageSolanaLister();
    assert.ok(lister !== undefined, "the mainnet build names a lister");
    const scanParams = ["EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", { commitment: "finalized", encoding: "base64", withContext: true, filters: [{ dataSize: 13 }, { memcmp: { offset: 9, bytes: "1112" } }] }];
    const byAddress = [["11111111111111111111111111111111"], { commitment: "finalized", encoding: "base64" }];
    await lister("getProgramAccounts", scanParams);
    for (const r of [a, b]) {
      await r("getProgramAccounts", scanParams);
      await r("getMultipleAccounts", byAddress);
    }
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(sent, [
    [`${TRADE_HELPER}/v1/rpc/solana-marks`, "getProgramAccounts"],
    [SOLANA_PROVIDER_A, "getProgramAccounts"],
    [SOLANA_PROVIDER_A, "getMultipleAccounts"],
    [`${TRADE_HELPER}/v1/rpc/solana`, "getProgramAccounts"],
    [`${TRADE_HELPER}/v1/rpc/solana`, "getMultipleAccounts"],
  ]);
});
