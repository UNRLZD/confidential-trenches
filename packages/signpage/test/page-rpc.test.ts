// The signing page's RPCs (card signpage-rpc-throttle-retry): every pool read and send the page makes, testnet and
// mainnet, goes through the kit's client with the page's retry, so a throttle once is a read that lands, never a kind
// that answers failed (run 6: a devnet provider's 429 burst).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOLANA_RPC_RETRY, SolanaRpcTransportError, solanaPacedRpc, solanaSameProvider, type SolanaFetch } from "../../kit/src/trade/solana/send.ts";
import { lanedRpc, pageHelperRpc, pageHelperRpcStopped, pageRpc, seatHosts } from "../src/page-rpc.ts";
import { pageEvmPoolRpcs, pageSolanaLister, pageSolanaRpcs, pageSolanaSettleRpcs, pageSolanaTokenRpcs, SOLANA_TOKEN_SEAT, SOLANA_TOKEN_SEAT_LIMIT, testnetPool, testnetPoolDeps } from "../src/pool-testnet.ts";
import { SOLANA_PROVIDER_A, SOLANA_PUBLIC_SEAT, TRADE_HELPER, releaseTradeDeps } from "../src/trade.ts";
import { closeHostLanes, hostLane, PROBE_HELD_MAX_MS, resetHostLanes, TRADE_TURN_MAX_MS } from "../../wallet/src/throttle.ts";
import { onTestClock } from "../../kit/test/test-clock.ts";
import { readdirSync, readFileSync } from "node:fs";
import { HELPER_RPC_METHODS } from "../../kit/src/helper/v1.ts";

/** globalThis.fetch for one test: each URL answers 429 (Retry-After 0) on its first call, then the call's result. */
async function withThrottledOnce(run: (seen: Map<string, number>) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const seen = new Map<string, number>();
  resetHostLanes();
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
test("the mainnet build's pool RPCs (src/pool-testnet.ts on SIGN_HOST's build): Solana's pair, provider A and the helper's route, reads through a 429 once; Base and Robinhood the pool list's two seats (card evm-pools-on-mainnet)", async () => {
  await withThrottledOnce(async (seen) => {
    const deps = testnetPoolDeps();
    for (const r of deps.rpcs("solana")!) assert.equal(await (r as unknown as (m: string, p: unknown[]) => Promise<unknown>)("getSlot", []), 42);
    // the public seat: provider A's 429 sends the read to its spare at once, the next one's too, the last asked again once
    assert.equal(seen.get(SOLANA_PROVIDER_A), 1);
    assert.equal(seen.get(SOLANA_PUBLIC_SEAT[1]!), 1);
    assert.equal(seen.get(SOLANA_PUBLIC_SEAT.at(-1)!), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
    for (const chain of ["base", "robinhood"] as const)
      assert.deepEqual(deps.rpcs(chain)!.map((r) => (r as unknown as { url: string }).url), pageEvmPoolRpcs(chain)!.slice(0, 2).map((r) => (r as unknown as { url: string }).url));
  });
});

// A found W's token accounts on mainnet (card found-wallet-sweep-reads-on-a-pair-that-answers): the public seat
// answers no getTokenAccountsByOwner (publicnode -32602, Pocket -32010), so these reads go to SOLANA_TOKEN_SEAT, device-direct
// and paced at its limit, and the helper's /v1/rpc/solana, another company's; the sell host hands the rent back that pair.
test("the mainnet build's found W token-account pair: SOLANA_TOKEN_SEAT then the helper's route, no member of the public seat, the seat one call each 1.25 s, and the sell host's rent back reads on it", async () => {
  await withThrottledOnce(async (seen) => {
    const [a, b] = pageSolanaTokenRpcs("pass");
    assert.equal((a as unknown as { url: string }).url, `${SOLANA_TOKEN_SEAT}/`);
    assert.equal((b as unknown as { url: string }).url, `${TRADE_HELPER}/v1/rpc/solana`);
    // never the seat's members that refuse these reads (publicnode and Pocket), nor a seat that may fail over to them
    for (const r of [a, b]) assert.ok(![SOLANA_PROVIDER_A, SOLANA_PUBLIC_SEAT[1]!].some((u) => (r as unknown as { url: string }).url.startsWith(u)), "never publicnode or Pocket");
    for (const r of [a, b]) assert.deepEqual(seatHosts(r), [(r as unknown as { url: string }).url], "one provider each, no seat");
    assert.deepEqual(SOLANA_TOKEN_SEAT_LIMIT, { windowMs: 1_250, total: 1, perMethod: 1 });
    // both read through a 429 once
    assert.equal(await a("getSlot", []), 42);
    assert.equal(await b("getSlot", []), 42);
    assert.equal(seen.get(SOLANA_TOKEN_SEAT), 2);
  });
  // the seat's calls start a window apart, however many are asked at once
  const real = globalThis.fetch;
  const starts: number[] = [];
  resetHostLanes();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (String(u) === SOLANA_TOKEN_SEAT) starts.push(performance.now());
    const id = (JSON.parse(String(init?.body)) as { id: string }).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const [seat] = pageSolanaTokenRpcs("trade");
    await Promise.all([0, 1, 2].map(() => seat("getTokenAccountsByOwner", [W, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "base64" }])));
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
  assert.equal(starts.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(starts[i]! - starts[i - 1]! >= 1_200, `call ${i} started ${Math.round(starts[i]! - starts[i - 1]!)} ms after the one before`);
  const src = readFileSync(new URL("../src/pool-testnet.ts", import.meta.url), "utf8");
  assert.equal(src.split("tokenRpcs: tokenRpcs(),").length, 2, "the sell host hands its rent backs the token pair, once");
  assert.match(src, /const tokenRpcs = \(kind: ReadKind = "trade"\): readonly \[SolanaRpc, SolanaRpc\] => over\.tokenRpcs \?\? over\.rpcs \?\? pageSolanaTokenRpcs\(kind\);/);
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
  "sendPieces", // signpage pool-buy.ts: the buy host's helper call for a buy of several pieces
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
    assert.equal(seen.get(SOLANA_PROVIDER_A), 1);
    assert.equal(seen.get(SOLANA_PUBLIC_SEAT[1]!), 1);
    assert.equal(seen.get(SOLANA_PUBLIC_SEAT.at(-1)!), 2);
    assert.equal(seen.get(`${TRADE_HELPER}/v1/rpc/solana`), 2);
  });
});

// Card signpage-throttled-provider-has-a-spare: the mainnet page's public seat is a list, provider A and Pocket's
// gateway (src/trade.ts SOLANA_PUBLIC_SEAT). These run on fake providers on the test clock: each host answers as told
// after 20 ms, and every request is logged with its host, method, params and its send's and answer's order.
type SeatLog = { host: string; method: string; params: string; start: number; end: number; status: number; endAt: number };
type SeatAnswer = { status: number; result?: unknown; error?: unknown; down?: "throw" | "stall" };
const onSeat = (answer: (host: string, n: number) => SeatAnswer, run: (log: SeatLog[]) => Promise<void>): Promise<void> =>
  onTestClock(() => onSeatNow(answer, run));
let order = 0;
async function onSeatNow(answer: (host: string, n: number) => SeatAnswer, run: (log: SeatLog[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  const log: SeatLog[] = [];
  const per = new Map<string, number>();
  resetHostLanes();
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(u)).host;
    const n = (per.get(host) ?? 0) + 1;
    per.set(host, n);
    const q = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown };
    const row: SeatLog = { host, method: q.method, params: JSON.stringify(q.params), start: order++, end: 0, status: 0, endAt: 0 };
    log.push(row);
    const a = answer(host, n);
    // no connection (a browser's TypeError, as a 429 with no CORS header reads), or no answer until the read's own stop
    if (a.down === "throw") throw new TypeError("Failed to fetch");
    if (a.down === "stall")
      return new Promise<Response>((_, no) => {
        if (init?.signal?.aborted) return no(init.signal.reason);
        init?.signal?.addEventListener("abort", () => ((row.end = order++), no(init.signal!.reason)), { once: true });
      });
    await new Promise((r) => setTimeout(r, 20));
    row.end = order++;
    row.endAt = performance.now();
    row.status = a.status;
    if (a.status !== 200) return new Response("Too Many Requests", { status: a.status });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, ...(a.error === undefined ? { result: a.result ?? host } : { error: a.error }) }), { status: 200 });
  }) as typeof fetch;
  try {
    await run(log);
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
}
const A_HOST = new URL(SOLANA_PROVIDER_A).host;
const SPARE = SOLANA_PUBLIC_SEAT[1]!;
const SPARE_HOST = new URL(SPARE).host;
const W = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb";

test("a public seat whose first provider throttles reads on its spare at once: one ask of provider A, the same request on the spare after A's answer, never both at once", async () => {
  // each pair made on the test's fresh lanes (a page RPC holds its host's lane from its making)
  for (const make of [() => pageSolanaRpcs("trade"), () => pageSolanaSettleRpcs("pass"), () => releaseTradeDeps().providers]) {
    await onSeat((host) => (host === A_HOST ? { status: 429 } : { status: 200 }), async (log) => {
      const pair = make();
      assert.equal(await pair[0]("getAccountInfo", [W, { encoding: "base64" }]), SPARE_HOST);
      // on the test clock, which jumps over any wait: the spare answered inside A's 1 s pause, never after waiting it out
      assert.ok(performance.now() - log[0]!.endAt < 1_000, `the spare answered ${Math.round(performance.now() - log[0]!.endAt)} ms after A's 429`);
      assert.ok(hostLane(SOLANA_PROVIDER_A).gate.left() > 0, "A's pause still on");
      assert.deepEqual(log.map((r) => r.host), [A_HOST, SPARE_HOST]);
      assert.equal(log[1]!.params, log[0]!.params, "the spare is asked the same request, one wallet in it");
      assert.ok(log[1]!.start >= log[0]!.end, "the spare is asked only after A answered");
      // A's host is paused now: the next read goes to the spare alone
      assert.equal(await pair[0]("getSlot", []), SPARE_HOST);
      assert.deepEqual(log.map((r) => r.host), [A_HOST, SPARE_HOST, SPARE_HOST], "a paused provider is not asked");
      assert.ok(hostLane(SOLANA_PROVIDER_A).gate.left() > 0);
    });
  }
});

test("a seat's answer is the read's: a provider that answers, whatever it answers, is never asked past to the spare", async () => {
  // A answers bytes of its own: they are the seat's answer (the check, which holds them to the helper's, fails on them)
  await onSeat(() => ({ status: 200 }), async (log) => {
    assert.equal(await pageSolanaRpcs("trade")[0]("getAccountInfo", [W]), A_HOST);
    assert.deepEqual(log.map((r) => r.host), [A_HOST]);
  });
  // A answers a JSON-RPC error that is no throttle: the read's fault, the spare not asked
  await onSeat((host) => (host === A_HOST ? { status: 200, error: { code: -32602, message: "invalid params" } } : { status: 200 }), async (log) => {
    await assert.rejects(pageSolanaRpcs("trade")[0]("getAccountInfo", [W]));
    assert.deepEqual(log.map((r) => r.host), [A_HOST]);
  });
});

test("the seat is one provider to its pair: the helper is no member, the pair still two providers, and a trade's hosts are every member's", () => {
  for (const pair of [pageSolanaRpcs("trade"), pageSolanaSettleRpcs("trade"), releaseTradeDeps().providers]) {
    assert.equal(pair[0].url, new URL(SOLANA_PROVIDER_A).href);
    assert.deepEqual(seatHosts(pair[0]), SOLANA_PUBLIC_SEAT.map((u) => new URL(u).href));
    assert.ok(!seatHosts(pair[0]).some((u) => u.startsWith(TRADE_HELPER)), "the helper is never a public seat's member");
    assert.equal(solanaSameProvider(pair[0], pair[1]), false);
    assert.deepEqual(seatHosts(pair[1]), [pair[1].url]);
  }
});

test("every public provider throttled: the read rejects with the throttle in its bound, each provider asked at most twice", async () => {
  await onSeat((host) => (host === TRADE_HELPER.slice(8) ? { status: 200 } : { status: 429 }), async (log) => {
    const e = await pageSolanaRpcs("trade")[0]("getAccountInfo", [W]).catch((x: unknown) => x);
    assert.ok(e instanceof SolanaRpcTransportError && e.fault === "http_429", String(e));
    assert.equal(log.filter((r) => r.host === A_HOST).length, 1);
    assert.ok(log.filter((r) => r.host === SPARE_HOST).length <= 2);
  });
});

// The review of 507431c0, item 4: provider A with no connection, or stalled to the read's bound, fails the read over to
// the spare once (a browser reads a 429 with no CORS header as no connection); A is not asked again by the read.
test("a public seat whose first provider has no connection, or stalls to the read's bound, reads on its spare: A asked once", async () => {
  for (const down of ["throw", "stall"] as const) {
    await onSeat((host) => (host === A_HOST ? { status: 0, down } : { status: 200 }), async (log) => {
      const t0 = performance.now();
      assert.equal(await pageSolanaRpcs("trade")[0]("getAccountInfo", [W]), SPARE_HOST, down);
      assert.deepEqual(log.map((r) => r.host), [A_HOST, SPARE_HOST], `${down}: A once, then the spare`);
      assert.equal(log[1]!.params, log[0]!.params);
      assert.ok(log[1]!.start > log[0]!.end || down === "throw", "never both at once");
      // a stall fails over at A's try's bound (3.5 s), a dropped connection at once
      const ms = performance.now() - t0;
      assert.ok(down === "throw" ? ms < 100 : ms >= 3_400 && ms < 3_700, `${down}: the spare answered at ${Math.round(ms)} ms`);
    });
  }
});

// Card move-sends-or-says-why (142): the owner's Firefox page read "CORS request did not succeed" from publicnode and
// Pocket, no answer at all, so the Move's reads had one provider left, the helper, and the device signs on none alone.
// With both silent at the network level, every read of the page's Solana pairs answers from the seat's next member,
// device-direct, inside the read's bound, and the helper stays the pair's other provider.
test("(card move-sends-or-says-why) publicnode and Pocket both give no answer: the seat reads on its next device-direct member, the helper still the pair's second", async () => {
  assert.ok(SOLANA_PUBLIC_SEAT.length >= 3, `the seat has a member past publicnode and Pocket: ${SOLANA_PUBLIC_SEAT.join(", ")}`);
  const NEXT_HOST = new URL(SOLANA_PUBLIC_SEAT[2]!).host;
  const silent = new Set([A_HOST, SPARE_HOST]);
  for (const down of ["throw", "stall"] as const)
    for (const [name, make] of [["pageSolanaRpcs", () => pageSolanaRpcs("trade")], ["pageSolanaSettleRpcs", () => pageSolanaSettleRpcs("pass")], ["releaseTradeDeps", () => releaseTradeDeps().providers]] as const) {
      await onSeat((host) => (silent.has(host) ? { status: 0, down } : { status: 200 }), async (log) => {
        const pair = make();
        assert.equal(pair.length, 2, `${name}: a pair`);
        assert.ok(!seatHosts(pair[0]).some((u) => u.startsWith(TRADE_HELPER)), `${name}: the helper is no member of the seat`);
        assert.ok(seatHosts(pair[1])[0]!.startsWith(TRADE_HELPER), `${name}: the helper is the pair's second`);
        const t0 = performance.now();
        assert.equal(await pair[0]("getAccountInfo", [W, { encoding: "base64" }]), NEXT_HOST, `${name} ${down}`);
        assert.deepEqual(log.map((r) => r.host), [A_HOST, SPARE_HOST, NEXT_HOST], `${name} ${down}: publicnode once, Pocket once, then the next member`);
        assert.ok(new Set(log.map((r) => r.params)).size === 1, "one request, one wallet in it, on each");
        // a dropped connection fails over at once, a stall at each member's try's bound (3.5 s each)
        const ms = performance.now() - t0;
        assert.ok(down === "throw" ? ms < 200 : ms >= 6_900 && ms < 7_400, `${name} ${down}: answered at ${Math.round(ms)} ms`);
      });
    }
});

// Card move-sends-or-says-why (142): Base's pool pair was exactly publicnode and Pocket, so a page where both give no
// answer at all (the owner's Firefox) could not read Base: no balance, no restore, no Move's Base reads. Its list now
// walks on to mainnet.base.org (every read but eth_getLogs) and the helper's keyed-only route: two operators still.
test("(card move-sends-or-says-why) Base with publicnode and Pocket both giving no answer: the pool pair and the trade deps read on mainnet.base.org and the helper's keyed route, and no eth_getLogs goes to mainnet.base.org", async () => {
  const { evmPair } = await import("../../wallet/src/pool/evm.ts");
  // and bloXroute, the pool list's second seat since card first-sign-in-reads-fast-on-live: the whole list silent
  const silent = new Set(["base-rpc.publicnode.com", "base.rpc.blxrbdn.com", "base.api.pocket.network"]);
  const want = ["mainnet.base.org", new URL(TRADE_HELPER).host];
  for (const down of ["throw", "stall"] as const) {
    await onSeat((host) => (silent.has(host) ? { status: 0, down } : { status: 200 }), async (log) => {
      const list = pageEvmPoolRpcs("base")!;
      assert.ok(list.length >= 4, `the Base list walks past publicnode and Pocket: ${list.map((r) => (r as unknown as { url: string }).url).join(", ")}`);
      for (const [name, pair] of [["evmPair(pageEvmPoolRpcs)", evmPair(list)], ["testnetPoolDeps().rpcs", testnetPoolDeps().rpcs("base")!]] as const) {
        log.length = 0;
        const got = await Promise.all([0, 1].map((k) => (pair as unknown as ((m: string, p: unknown[]) => Promise<unknown>)[])[k]!("eth_blockNumber", [])));
        assert.deepEqual([...got].sort(), [...want].sort(), `${name} ${down}: each seat answers, one on each operator`);
      }
      // a log page on the pair: never asked of mainnet.base.org (it answers every one 429), so its host is never paused
      log.length = 0;
      const pair = evmPair(pageEvmPoolRpcs("base")!);
      await Promise.allSettled([0, 1].map((k) => (pair as unknown as ((m: string, p: unknown[]) => Promise<unknown>)[])[k]!("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x10", address: "0x" + "11".repeat(20) }])));
      assert.ok(!log.some((r) => r.host === "mainnet.base.org" && r.method === "eth_getLogs"), `${down}: no eth_getLogs to mainnet.base.org`);
    });
  }
});

// The review of 507431c0, item 5: with no member open, the seat asks the member whose host opens first.
test("a public seat with every member paused asks the one whose pause ends first", async () => {
  await onSeat(() => ({ status: 200 }), async (log) => {
    const pair = pageSolanaRpcs("trade");
    const a = hostLane(SOLANA_PROVIDER_A);
    const sp = hostLane(SPARE);
    a.throttled(a.gate.epoch(), 3_000);
    sp.throttled(sp.gate.epoch(), null);
    // every member past the spare paused longest (card move-sends-or-says-why: the seat's third)
    for (const u of SOLANA_PUBLIC_SEAT.slice(2)) hostLane(u).throttled(hostLane(u).gate.epoch(), 5_000);
    assert.ok(sp.gate.left() < a.gate.left());
    const t0 = performance.now();
    assert.equal(await pair[0]("getSlot", []), SPARE_HOST);
    assert.deepEqual(log.map((r) => r.host), [SPARE_HOST], "the spare alone, A never asked");
    const ms = performance.now() - t0;
    assert.ok(ms >= 1_000 && ms < 1_200, `asked at the spare's 1 s, not A's 3 s: ${Math.round(ms)} ms`);
  });
  // the other way round: A opens first
  await onSeat(() => ({ status: 200 }), async (log) => {
    const pair = pageSolanaRpcs("trade");
    const a = hostLane(SOLANA_PROVIDER_A);
    const sp = hostLane(SPARE);
    a.throttled(a.gate.epoch(), null);
    sp.throttled(sp.gate.epoch(), 3_000);
    for (const u of SOLANA_PUBLIC_SEAT.slice(2)) hostLane(u).throttled(hostLane(u).gate.epoch(), 5_000);
    assert.equal(await pair[0]("getSlot", []), A_HOST);
    assert.deepEqual(log.map((r) => r.host), [A_HOST]);
  });
});

// The review of 507431c0, item 5: a trade holds every member of the public seat, not only its first.
test("the mainnet buy and sell hosts hold every host of the public seat, and the helper's, until their end", async () => {
  await onSeat(() => ({ status: 200 }), async () => {
    const made: { buy?: () => { end?(): void }; sell?: () => { end?(): void } } = {};
    testnetPool(
      { store: async () => assert.fail("no store read"), seed64: async () => assert.fail("no seed read") },
      {
        evmPin: () => undefined,
        tradeKinds: {
          buy: ((h: () => { end?(): void }) => ((made.buy = h), () => ({ error: "not_allowed" }))) as never,
          sell: ((h: () => { end?(): void }) => ((made.sell = h), () => ({ error: "not_allowed" }))) as never,
        },
      },
    );
    const hosts = [...SOLANA_PUBLIC_SEAT, `${TRADE_HELPER}/v1/rpc/solana`];
    for (const [name, make] of [["buy", made.buy], ["sell", made.sell]] as const) {
      for (const u of hosts) assert.equal(hostLane(u).trading(), false, `${name} ${u}`);
      const h = make!();
      for (const u of hosts) assert.equal(hostLane(u).trading(), true, `${name}: ${u} held`);
      h.end?.();
      for (const u of hosts) assert.equal(hostLane(u).trading(), false, `${name}: ${u} given back`);
    }
  });
});

// The review of 3d0d131b, item 2: one 429, then the host stalls, with 8 trade reads parked on its pause. Each read
// parked ahead may be one probe that stalls to its try's 3.5 s timeout, so a held wait with no bound of its own grew one
// try per read ahead (the last read ended at 29 s). A trade's turn ends TRADE_TURN_MAX_MS + PROBE_HELD_MAX_MS from its
// start at most: every read has left or been refused by then, and ends within its own try's bound after.
test("a host that answers one 429 and then stalls: 8 trade reads parked on its pause each end within the turn's bound and one try", async () => {
  const real = globalThis.fetch;
  const sent: number[] = [];
  let n = 0;
  globalThis.fetch = ((_u: string | URL | Request, init?: RequestInit) => {
    sent.push(performance.now());
    if (++n === 1) return new Promise<Response>((ok) => setTimeout(() => ok(new Response("", { status: 429, headers: { "retry-after": "1" } })), 100));
    return new Promise<Response>((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true }));
  }) as typeof fetch;
  try {
    await onTestClock(async () => {
      resetHostLanes();
      const t0 = performance.now();
      const rpc = pageHelperRpc("https://stall-after-429.example", SOLANA_RPC_RETRY, "trade");
      const one = (delay: number) => new Promise((r) => setTimeout(r, delay)).then(() => rpc("getAccountInfo", [W])).then(() => assert.fail("a stalled host answers nothing"), () => performance.now() - t0);
      const ended = await Promise.all([one(0), ...Array.from({ length: 8 }, () => one(105))]);
      const turn = 105 + TRADE_TURN_MAX_MS + PROBE_HELD_MAX_MS;
      assert.ok(sent.every((at) => at - t0 <= turn + 50), `a request left past the turn's bound: ${sent.map((at) => Math.round(at - t0)).join(", ")}`);
      const last = Math.max(...ended);
      assert.ok(last <= turn + SOLANA_RPC_RETRY.deadlineMs + 50, `the last read ended at ${Math.round(last)} ms`);
    });
  } finally {
    globalThis.fetch = real;
    resetHostLanes();
  }
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

test("pageHelperRpcStopped: a call the stop came before is never sent, whether it waited its turn in the route's queue or a try again after a throttle", async () => {
  const real = globalThis.fetch;
  const sent: string[] = [];
  let throttle = true;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const q = JSON.parse(String(init?.body)) as { id: number; params: unknown[] };
    sent.push(String(q.params[0]));
    if (throttle) return new Response("slow", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: null }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    // a try again: the first answer is a 429, the stop comes before the page's retry
    const a = new AbortController();
    const p = pageHelperRpcStopped("https://stop-retry.example", a.signal)("getAccountInfo", ["RETRIED"]);
    await new Promise((r) => setTimeout(r, 0));
    a.abort();
    await assert.rejects(p);
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(sent, ["RETRIED"], "no try again after the stop");
    // a queued call: one call a window on the route's queue, the second waits its turn and is stopped while it does
    throttle = false;
    sent.length = 0;
    const b = new AbortController();
    const limit = { windowMs: 1_000, total: 1, perMethod: 1 };
    const first = solanaPacedRpc(pageHelperRpcStopped("https://stop-queue.example", new AbortController().signal), limit)("getAccountInfo", ["FIRST"]);
    const queued = solanaPacedRpc(pageHelperRpcStopped("https://stop-queue.example", b.signal), limit)("getAccountInfo", ["QUEUED"]);
    await first;
    b.abort();
    await assert.rejects(queued);
    await new Promise((r) => setTimeout(r, 1_200));
    assert.deepEqual(sent, ["FIRST"], "the queued call is not sent after its stop");
  } finally {
    globalThis.fetch = real;
  }
});

// card sign-out-stops-the-pages-reads: a page RPC's call in flight at a sign out (this tab's once its store holds the seed
// lock, or another's: both closeHostLanes) is never asked again after it. The answer that comes after the sign out, a 503 (the host's pause,
// then the re-ask) or one that is no JSON (the backoff, then the re-ask), ends the call with no second request; the
// call's own stop is the lanes' stop as it stood when the call began. Calls counted only, no clock read.
test("card sign-out-stops-the-pages-reads: a page RPC's call in flight at a sign out is never asked again after it, on a 503 or an answer that is no JSON", { timeout: 20_000 }, async () => {
  for (const fail of ["503", "not-json"] as const) {
    resetHostLanes();
    let sent = 0;
    let free!: () => void;
    const gate = new Promise<void>((r) => (free = r));
    const fetch: SolanaFetch = async (_u, init) => {
      sent++;
      if (sent === 1) {
        await gate;
        return fail === "503" ? new Response("busy", { status: 503 }) : new Response("<html>", { status: 200 });
      }
      const id = (JSON.parse(String(init.body)) as { id: number }).id;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 1 }), { status: 200 });
    };
    const call = lanedRpc(`https://signout-${fail}.example`, { retry: { deadlineMs: 10_000, backoffMs: 1 }, fetch })("eth_blockNumber", []);
    while (sent === 0) await new Promise((r) => setTimeout(r, 1));
    closeHostLanes(new Error("signed out"));
    const atSignOut = sent;
    free();
    await call.catch(() => {});
    assert.equal(sent - atSignOut, 0, `${fail}: no request after the sign out`);
  }
  resetHostLanes();
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
