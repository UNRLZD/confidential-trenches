// node --test apps/helper/src/data/solana/token.test.ts: the token page's Solana reads (token.ts) on answers recorded
// 2 Nov 13:52Z through the helper's proxy and RPC paths and from GeckoTerminal (fixtures/token-page.json): the page,
// holders and candles in 06b's field lists, every hostile value refused, and the three routes on a real server.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { start } from "../../server.ts";
import { geckoBudget, PAGE_RESERVE, WINDOW_MS } from "../gecko.ts";
import { createProxy } from "../../proxy/proxy.ts";
import { createRpc } from "../../rpc/rpc.ts";
import { pumpCurveAddress, ROW_FIELDS, toRow } from "./lists.ts";
import {
  CANDLES_FIELDS, createSolanaToken, GT_PER_MIN, HOLDERS_FIELDS, JUP_GAP_MS, PAGE_FIELDS, RISK_FIELDS, toCandles, toHolders, toMint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, topPool,
} from "./token.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/token-page.json", import.meta.url), "utf8"));
const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"; // Token-2022, graduated long ago, no launchpad curve
const CURVE = "Q1vecEMQEgDyrw1txmBgFwUrkeQurqkEe1bGMzFpump"; // pump.fun, on its curve
const NOW = Date.parse("2026-11-02T13:53:00Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const APP = "https://confidential.unrealized.trade";
const clone = <T>(v: T): T => structuredClone(v);

type RpcCall = { method: string; params: unknown[] };
/** A fake RPC path answering from the recording; `largest` and `owners` answer getTokenLargestAccounts. */
function fakeRpc(opts: { accounts?: (mint: string) => unknown; largest?: unknown; owners?: unknown; down?: boolean } = {}) {
  const calls: RpcCall[] = [];
  return {
    calls,
    async handle(_chain: string, _ct: string | undefined, body: string) {
      const r = JSON.parse(body) as RpcCall;
      calls.push(r);
      if (opts.down) return { status: 503, body: '{"error":{"code":"upstream"}}' };
      if (r.method === "getTokenLargestAccounts") return opts.largest === undefined ? { status: 503, body: '{"error":{"code":"upstream"}}' } : { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: opts.largest }) };
      const keys = r.params[0] as string[];
      if ((r.params[1] as { encoding?: string }).encoding === "base64") {
        // the launch read (origin.ts): each recorded token's pump.fun curve account where it is asked, else none
        const curves = new Map(Object.keys(FX.tokens).map((m) => [pumpCurveAddress(m), FX.tokens[m].accounts.result.value[1]]));
        return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: keys.map((k) => (opts.accounts ? null : (curves.get(k) ?? null))) } }) };
      }
      if (keys.length === 2 && keys[1] === pumpCurveAddress(keys[0]!)) {
        const rec = FX.tokens[keys[0]!]?.accounts ?? { jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value: [null, null] } };
        return { status: 200, body: JSON.stringify(opts.accounts ? opts.accounts(keys[0]!) : rec) };
      }
      if (keys.length === 1) {
        const rec = FX.tokens[keys[0]!]?.accounts;
        const v = rec ? { ...rec, result: { ...rec.result, value: [rec.result.value[0]] } } : { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [null] } };
        // an `accounts` answer is recorded for the mint and its curve: the mint read takes its first account
        const o = opts.accounts?.(keys[0]!) as { result?: { value?: unknown[] } } | undefined;
        const one = o?.result?.value ? { ...o, result: { ...o.result, value: o.result.value.slice(0, 1) } } : o;
        return { status: 200, body: JSON.stringify(opts.accounts ? one : v) };
      }
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: opts.owners }) };
    },
  };
}
function fakeProxy(opts: { down?: boolean; search?: (mint: string) => unknown } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async handle(vendor: string, path: string, q: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
      calls.push(`${vendor}${path}?${q}`);
      if (opts.down) return { status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' };
      // Jupiter's search takes mints joined by commas and answers a row for each it knows
      const mints = new URLSearchParams(q).get("query")!.split(",");
      const body = mints.flatMap((m) => (opts.search ? opts.search(m) : (FX.tokens[m]?.search ?? [])) as unknown[]);
      return { status: 200, headers: { "X-Fetched-At": FX.tokens[mints[0]!]?.fetched_at ?? "2026-11-02T13:52:51.287Z" }, body: JSON.stringify(body) };
    },
  };
}
function fakeGecko(opts: { status?: number; headers?: Record<string, string> } = {}) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    if (opts.status !== undefined) return new Response("{}", { status: opts.status, headers: opts.headers });
    const body = url.includes("/ohlcv/") ? FX.gt_ohlcv : FX.gt_token;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { urls, fetch };
}

// ---- the page ------------------------------------------------------------------------------------------------

test("fold 6 (R5c): Jupiter's batched search draws on the helper's own reserve, so a page is served with every caller's part of Jupiter spent", async () => {
  const searched: string[] = [];
  const proxy = createProxy({}, {
    now: () => NOW,
    fetch: (async (url: string) => {
      const u = new URL(url);
      if (u.pathname !== "/tokens/v2/search") return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
      const mints = u.searchParams.get("query")!.split(",");
      searched.push(...mints);
      return new Response(JSON.stringify(mints.flatMap((m) => FX.tokens[m]?.search ?? [])), { status: 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  let callers = 0;
  for (let a = 0; a < 20; a++) for (let i = 0; i < 4; i++) if ((await proxy.handle("jupiter", "/swap/v2/build", `q=${a}-${i}`, "", `198.51.100.${a}`)).status === 200) callers++;
  assert.equal(callers, 60 - 34, "callers' part of Jupiter Free is spent");
  const a = await createSolanaToken(proxy, fakeRpc(), { now: () => NOW }).page(PUMP);
  assert.equal(a.status, 200, "the page is served");
  assert.deepEqual(searched, [PUMP], "its search reached Jupiter");
  assert.equal(JSON.parse(a.body).row.symbol, "PUMP");
});

test("fold 6 (re-check 4 P5b): the token page's chain reads draw the share of the caller who opened it; a hit draws nothing", async () => {
  const seen: (string | undefined)[] = [];
  const rpc = fakeRpc();
  const spy = { handle: (c: string, ct: string | undefined, body: string, client?: string) => (seen.push(client), rpc.handle(c, ct, body)) };
  const t = createSolanaToken(fakeProxy(), spy, { now: () => NOW });
  assert.equal((await t.page(PUMP, "198.51.100.9")).status, 200);
  assert.deepEqual(seen, ["198.51.100.9", "198.51.100.9"], "the mint read and the launch read carried the caller");
  assert.equal((await t.page(PUMP, "198.51.100.10")).status, 200);
  assert.equal(seen.length, 2, "a cache hit reaches no provider and draws nothing");
  await t.holders(PUMP, "198.51.100.11");
  assert.deepEqual(seen.slice(2), ["198.51.100.11"], "the holders' mint read carries its caller too");
});

test("page: a Token-2022 mint off any curve, in 06b's TokenPage fields, the chain's authorities and fee, Jupiter's row", async () => {
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => NOW });
  const a = await t.page(PUMP);
  assert.equal(a.status, 200);
  const p = JSON.parse(a.body);
  assert.deepEqual(Object.keys(p), [...PAGE_FIELDS]);
  assert.deepEqual(Object.keys(p.row), [...ROW_FIELDS]);
  assert.deepEqual(Object.keys(p.risk), [...RISK_FIELDS]);
  for (const k of RISK_FIELDS) assert.deepEqual(Object.keys(p.risk[k]), ["v", "src", "as_of_ms"], k);
  assert.equal(p.row.token, PUMP);
  assert.equal(p.row.symbol, "PUMP");
  assert.equal(p.decimals, 6);
  assert.equal(p.route, "unknown");
  assert.equal(p.pool, "GLZRp9CSaLeVUf9y3BKfv8b4QnivkL7sY7jTfQk8waQS"); // Jupiter's first pool, not the mint
  assert.deepEqual(p.risk.mint_auth, { v: false, src: "chain", as_of_ms: NOW });
  assert.deepEqual(p.risk.freeze_auth, { v: false, src: "chain", as_of_ms: NOW });
  assert.deepEqual(p.risk.tax.v, { buy_bps: 0, sell_bps: 0 }); // a transfer hook, no TransferFeeConfig
  assert.equal(p.risk.lp.v, null);
  assert.equal(p.risk.holders.v, FX.tokens[PUMP].search[0].holderCount);
  assert.equal(p.risk.holders.src, "jupiter");
  assert.equal(p.risk.top10_bps.v, 5935);
  assert.equal(p.risk.snipers_bps.v, null);
  assert.equal(p.risk.snipers_bps.src, "none");
  assert.equal(p.risk.honeypot.v, null);
  assert.equal(a.asOfMs, Math.min(NOW, Date.parse(FX.tokens[PUMP].fetched_at)));
});

test("page: a pump.fun token on its curve: curve_bps from the curve account, lp curve, the curve as its pool", async () => {
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => NOW });
  const p = JSON.parse((await t.page(CURVE)).body);
  assert.equal(p.row.launchpad, "pump.fun");
  assert.ok(Number.isInteger(p.row.curve_bps) && p.row.curve_bps > 0 && p.row.curve_bps < 10_000, String(p.row.curve_bps));
  assert.deepEqual(p.risk.lp.v, { class: "curve", bps: null });
  assert.equal(p.pool, pumpCurveAddress(CURVE));
  assert.equal(p.decimals, 6);
});

test("page: not a mint (no account, a system account, a token account, a third program) and not on Jupiter answer 404", async () => {
  const noAcct = createSolanaToken(fakeProxy(), fakeRpc({ accounts: () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [null, null] } }) }), { now: () => NOW });
  assert.equal((await noAcct.page(PUMP)).status, 404);
  const rec = FX.tokens[PUMP].accounts;
  for (const bad of [
    { ...rec.result.value[0], owner: "11111111111111111111111111111111" },
    { ...rec.result.value[0], data: { ...rec.result.value[0].data, parsed: { ...rec.result.value[0].data.parsed, type: "account" } } },
    { ...rec.result.value[0], owner: "BPFLoaderUpgradeab1e11111111111111111111111" },
  ]) {
    const t = createSolanaToken(fakeProxy(), fakeRpc({ accounts: () => ({ ...rec, result: { ...rec.result, value: [bad, null] } }) }), { now: () => NOW });
    assert.equal((await t.page(PUMP)).status, 404);
  }
  const notListed = createSolanaToken(fakeProxy({ search: () => [] }), fakeRpc(), { now: () => NOW });
  assert.equal((await notListed.page(PUMP)).status, 404);
  // Jupiter answering a different token for the query is not this token
  const other = createSolanaToken(fakeProxy({ search: () => FX.tokens[CURVE].search }), fakeRpc(), { now: () => NOW });
  assert.equal((await other.page(PUMP)).status, 404);
  // not an address at all: refused before any read
  const proxy = fakeProxy();
  const t = createSolanaToken(proxy, fakeRpc(), { now: () => NOW });
  for (const m of ["", "x", `${PUMP}1`, "0OIl" + PUMP.slice(4), "../../etc"]) assert.equal((await t.page(m)).status, 404, m);
  assert.equal(proxy.calls.length, 0);
});

test("page: an upstream down answers 503; the last good page serves up to 60 s, then 503; reads are cached 5 s", async () => {
  let now = NOW;
  let down = false;
  const proxy = fakeProxy();
  const rpc = fakeRpc();
  const t = createSolanaToken({ handle: (v, p, q, b) => (down ? fakeProxy({ down: true }).handle(v, p, q) : proxy.handle(v, p, q)) }, rpc, { now: () => now });
  assert.equal((await t.page(PUMP)).status, 200);
  assert.equal((await t.page(PUMP)).status, 200);
  assert.equal(proxy.calls.length, 1, "one read within 5 s");
  down = true;
  now += 10_000;
  assert.equal((await t.page(PUMP)).status, 200, "stale but under 60 s");
  now += 60_000;
  assert.equal((await t.page(PUMP)).status, 503);
  const cold = createSolanaToken(fakeProxy({ down: true }), fakeRpc(), { now: () => NOW });
  assert.equal((await cold.page(PUMP)).status, 503);
  const rpcDown = createSolanaToken(fakeProxy(), fakeRpc({ down: true }), { now: () => NOW });
  assert.equal((await rpcDown.page(PUMP)).status, 503);
});

test("page: Jupiter's search is batched: mints asked together share one call; one asked within JUP_GAP_MS of the last waits it out; a row is kept 12 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = NOW;
  const proxy = fakeProxy();
  const tok = createSolanaToken(proxy, fakeRpc(), { now: () => now });
  const flush = () => new Promise((ok) => setImmediate(ok));
  // the reads reach the search a few promise steps after they are asked: let them, then move the clock
  const advance = async (ms: number) => {
    await flush();
    t.mock.timers.tick(ms);
    await flush();
  };
  const first = Promise.all([tok.page(PUMP), tok.page(CURVE), tok.holders(PUMP)]);
  await advance(0);
  assert.deepEqual((await first).map((a) => a.status), [200, 200, 200]);
  assert.deepEqual(proxy.calls, [`jupiter/tokens/v2/search?query=${PUMP},${CURVE}`]);
  // 13 s on (past the 12 s row and the page's 5 s cache), PUMP is asked: sent at once, the gap is long past
  now += 13_000;
  const p2 = tok.page(PUMP);
  await advance(0);
  assert.equal((await p2).status, 200);
  assert.equal(proxy.calls.length, 2);
  // 1 s after that search, CURVE (read 14 s ago) is due: it waits until JUP_GAP_MS after the last search
  now += 1_000;
  const p3 = tok.page(CURVE);
  await advance(JUP_GAP_MS - 1_000 - 1);
  assert.equal(proxy.calls.length, 2, "held inside the gap");
  await advance(1);
  assert.equal((await p3).status, 200);
  assert.equal(proxy.calls.length, 3);
  assert.equal(proxy.calls[2], `jupiter/tokens/v2/search?query=${CURVE}`);
});

test("page and holders: a token on Discover's lists takes its row from there, with no Jupiter call", async () => {
  const proxy = fakeProxy();
  const row = toRow(FX.tokens[CURVE].search[0], Date.parse(FX.tokens[CURVE].fetched_at))!;
  const snapshot = { chain: "solana", lists: { new: [row], trending: [], trending_5m: [], trending_1h: [], graduating: [] }, as_of_ms: 1793627000000 };
  const listed = async () => ({ status: 200, body: JSON.stringify(snapshot), asOfMs: snapshot.as_of_ms });
  const tok = createSolanaToken(proxy, fakeRpc(), { now: () => NOW, listed });
  const p = JSON.parse((await tok.page(CURVE)).body);
  assert.deepEqual(Object.keys(p.row), [...ROW_FIELDS]);
  assert.equal(p.row.symbol, row.symbol);
  assert.equal(p.row.as_of_ms, row.as_of_ms);
  assert.equal(p.pool, pumpCurveAddress(CURVE), "on its curve: the curve account");
  assert.equal(p.risk.holders.as_of_ms, snapshot.as_of_ms);
  const h = JSON.parse((await tok.holders(CURVE)).body);
  assert.equal(h.src, "jupiter");
  assert.equal(h.total, row.holders);
  assert.equal(proxy.calls.length, 0);
  // a token off the lists still goes to Jupiter
  assert.equal((await tok.page(PUMP)).status, 200);
  assert.deepEqual(proxy.calls, [`jupiter/tokens/v2/search?query=${PUMP}`]);
});

test("page: one search failing fails every mint in it with 503, and the next search is a new call", async () => {
  let down = true;
  const ok = fakeProxy();
  const proxy = { calls: ok.calls, handle: (v: string, p: string, q: string) => (down ? fakeProxy({ down: true }).handle(v, p, q) : ok.handle(v, p, q)) };
  let now = NOW;
  const tok = createSolanaToken(proxy, fakeRpc(), { now: () => now });
  assert.deepEqual((await Promise.all([tok.page(PUMP), tok.page(CURVE)])).map((a) => a.status), [503, 503]);
  down = false;
  now += 5_000;
  assert.equal((await tok.page(PUMP)).status, 200);
});

test("toMint: decimals, supply, authorities and the Token-2022 fee in force at the slot's epoch; malformed is null", () => {
  const base = { owner: TOKEN_2022_PROGRAM, data: { parsed: { type: "mint", info: { decimals: 9, supply: "1000", mintAuthority: null, freezeAuthority: PUMP } } } };
  const fee = (older: number, newer: number, epoch: number) => ({
    ...base,
    data: { parsed: { type: "mint", info: { ...base.data.parsed.info, extensions: [{ extension: "transferFeeConfig", state: { olderTransferFee: { epoch: 0, transferFeeBasisPoints: older, maximumFee: 1 }, newerTransferFee: { epoch, transferFeeBasisPoints: newer, maximumFee: 1 } } }] } } },
  });
  assert.deepEqual(toMint(base, 1), { decimals: 9, supply: 1000n, mintAuth: false, freezeAuth: true, feeBps: 0 });
  assert.equal(toMint(fee(100, 250, 1075), 1075 * 432_000)!.feeBps, 250, "the newer fee from its epoch");
  assert.equal(toMint(fee(100, 250, 1076), 1075 * 432_000)!.feeBps, 100, "the older fee before it");
  assert.equal(toMint({ ...base, owner: TOKEN_PROGRAM }, 1)!.feeBps, 0);
  for (const bad of [
    fee(100, 10_001, 0),
    fee(-1, 0, 0),
    { ...base, data: { parsed: { type: "mint", info: { ...base.data.parsed.info, decimals: 256 } } } },
    { ...base, data: { parsed: { type: "mint", info: { ...base.data.parsed.info, supply: "18446744073709551616" } } } },
    { ...base, data: { parsed: { type: "mint", info: { ...base.data.parsed.info, supply: 1000 } } } },
    { ...base, data: { parsed: { type: "mint", info: { ...base.data.parsed.info, mintAuthority: "not an address" } } } },
    { ...base, data: { parsed: { type: "mint", info: { ...base.data.parsed.info, extensions: "x" } } } },
    { ...base, data: ["AAAA", "base64"] },
    null,
  ]) assert.equal(toMint(bad, 1), null, JSON.stringify(bad));
});

// ---- holders -------------------------------------------------------------------------------------------------

// getTokenLargestAccounts is answered only by a keyed provider (D-S11; the public endpoints refused it 2 Nov 13:52Z:
// api.mainnet-beta 429, publicnode 403), so these rows are written in its documented shape, not recorded.
const ACCT = ["8hT1Yhd8x3xKMtV9Ue4BoGpvdsxVrz5V6V8Brp7NbB7B", "6t8nGMxjKCFbBf4KQ6YsgpAvWdzfPUSSa8UpKQfr5Ft5", "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"];
const OWNER = ["7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "1nc1nerator11111111111111111111111111111111"];
const largest = { context: { slot: 1 }, value: [{ address: ACCT[0], amount: "500000" }, { address: ACCT[1], amount: "300000" }, { address: ACCT[2], amount: "100000" }] };
const tokenAcct = (owner: string) => ({ owner: TOKEN_2022_PROGRAM, data: { parsed: { type: "account", info: { owner } } } });
const owners = { context: { slot: 1 }, value: [tokenAcct(OWNER[1]!), tokenAcct(OWNER[0]!), tokenAcct(OWNER[1]!)] };

test("holders: 20 rows at most, merged per owner, bps of the supply, the burn address marked, Jupiter's count as total", async () => {
  const supplyAccounts = (mint: string) => {
    const rec = FX.tokens[mint].accounts;
    const m = structuredClone(rec.result.value[0]);
    m.data.parsed.info.supply = "1000000";
    return { ...rec, result: { ...rec.result, value: [m] } };
  };
  const shared = fakeRpc({ accounts: supplyAccounts });
  const keyed = fakeRpc({ largest, owners });
  const t = createSolanaToken(fakeProxy(), shared, { now: () => NOW, holdersRpc: keyed });
  const a = await t.holders(PUMP);
  assert.deepEqual(shared.calls.map((c) => c.method), ["getMultipleAccounts"], "the mint on the shared path");
  assert.deepEqual(keyed.calls.map((c) => c.method), ["getTokenLargestAccounts", "getMultipleAccounts"], "the holders on their own provider");
  assert.equal(a.status, 200);
  const h = JSON.parse(a.body);
  assert.deepEqual(Object.keys(h), [...HOLDERS_FIELDS]);
  assert.deepEqual(h.holders, [
    { addr: OWNER[1], amt: "600000", bps: 6000, kind: "burn" },
    { addr: OWNER[0], amt: "300000", bps: 3000 },
  ]);
  assert.equal(h.top_bps, 9000);
  assert.equal(h.total, FX.tokens[PUMP].search[0].holderCount);
  assert.equal(h.src, "chain");
});

test("holders: no holders provider: the shared RPC path never sees getTokenLargestAccounts (its 429 would pause the device's reads and sends); Jupiter's fallback", async () => {
  const shared = fakeRpc({ largest, owners });
  const t = createSolanaToken(fakeProxy(), shared, { now: () => NOW });
  const a = await t.holders(PUMP);
  assert.deepEqual(shared.calls.map((c) => c.method), ["getMultipleAccounts"]);
  assert.equal(a.status, 200);
  assert.equal(JSON.parse(a.body).src, "jupiter");
});

test("holders: the holders provider refuses getTokenLargestAccounts: no rows, Jupiter's count and top-10 share, src jupiter", async () => {
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => NOW, holdersRpc: fakeRpc() });
  const a = await t.holders(PUMP);
  assert.equal(a.status, 200);
  assert.deepEqual(JSON.parse(a.body), { holders: [], total: FX.tokens[PUMP].search[0].holderCount, top_bps: 5935, src: "jupiter", as_of_ms: Date.parse(FX.tokens[PUMP].fetched_at) });
  assert.equal(a.src, "jupiter");
});

test("toHolders: a row with a bad amount, a bad owner, an account no token program owns, or a count mismatch is refused", () => {
  assert.equal(toHolders(largest.value, owners.value.slice(0, 2), 1000n), null);
  assert.equal(toHolders([{ ...largest.value[0], amount: "-1" }], [owners.value[0]], 1000n), null);
  assert.equal(toHolders([{ ...largest.value[0], amount: 5 }], [owners.value[0]], 1000n), null);
  assert.equal(toHolders([largest.value[0]], [tokenAcct("x")], 1000n), null);
  assert.equal(toHolders([largest.value[0]], [{ ...tokenAcct(OWNER[0]!), owner: "11111111111111111111111111111111" }], 1000n), null);
  assert.equal(toHolders(Array(21).fill(largest.value[0]), Array(21).fill(owners.value[0]), 1000n), null);
  assert.deepEqual(toHolders([largest.value[0]], [owners.value[1]], 0n), [{ addr: OWNER[0], amt: "500000", bps: null }]);
});

// ---- candles -------------------------------------------------------------------------------------------------

test("candles: the token's top pool on GeckoTerminal, bars oldest first in USD decimal strings, cut to the limit", async () => {
  const g = fakeGecko();
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => NOW, fetch: g.fetch });
  const a = await t.candles(CURVE, "1m", null, 10);
  assert.equal(a.status, 200);
  const c = JSON.parse(a.body);
  assert.deepEqual(Object.keys(c), [...CANDLES_FIELDS]);
  assert.equal(c.tf, "1m");
  assert.equal(c.src, "geckoterminal");
  assert.equal(c.candles.length, 10);
  for (const bar of c.candles) {
    assert.equal(bar.length, 6);
    assert.ok(Number.isSafeInteger(bar[0]) && bar[0] % 60 === 0);
    for (const v of bar.slice(1)) assert.match(v, /^\d+(\.\d+)?$/);
  }
  assert.ok(c.candles.every((b: number[], i: number) => i === 0 || b[0]! > c.candles[i - 1][0]));
  const newest = FX.gt_ohlcv.data.attributes.ohlcv_list[0];
  assert.equal(c.candles.at(-1)[0], newest[0]);
  assert.equal(g.urls[0], `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${CURVE}`);
  assert.equal(g.urls[1], `https://api.geckoterminal.com/api/v2/networks/solana/pools/${topPool(FX.gt_token)}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${CURVE}`);
  // the pool and the bars are shared: another read within 60 s calls nobody
  await t.candles(CURVE, "1m", null, 500);
  assert.equal(g.urls.length, 2);
  await t.candles(CURVE, "4h", 1793620800, 500);
  assert.equal(g.urls[2], `https://api.geckoterminal.com/api/v2/networks/solana/pools/${topPool(FX.gt_token)}/ohlcv/hour?aggregate=4&limit=1000&currency=usd&token=${CURVE}&before_timestamp=1793620800`);
});

test("candles: 1s and unknown timeframes 404; a 429 pauses GeckoTerminal and answers 429 with the pause left; at most GT_PER_MIN calls a minute, past it 429 with the wait to the next call", async () => {
  const g = fakeGecko();
  let now = NOW;
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => now, fetch: g.fetch });
  for (const tf of ["1s", "2m", "", "__proto__", "constructor"]) assert.equal((await t.candles(CURVE, tf, null, 10)).status, 404, tf);
  assert.equal(g.urls.length, 0);
  const tfs = ["1m", "5m", "15m", "1h", "4h", "1d"];
  let ok = 0;
  for (let i = 0; i < 20; i++) if ((await t.candles(CURVE, tfs[i % 6]!, 1793620800 - i * 86_400, 10)).status === 200) ok++;
  assert.equal(g.urls.length, GT_PER_MIN);
  assert.equal(ok, GT_PER_MIN - 1, "one token read, then bars until the minute's calls are spent");
  const full = await t.candles(CURVE, "1m", 1793620800 - 21 * 86_400, 10);
  assert.deepEqual([full.status, JSON.parse(full.body), full.retryAfterS], [429, { error: { code: "rate_limited" } }, WINDOW_MS / 1000], "the queue's first call frees in WINDOW_MS, the wait named exactly");
  now += WINDOW_MS + 1_000;
  const limited = fakeGecko({ status: 429, headers: { "retry-after": "30" } });
  const t2 = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => now, fetch: limited.fetch });
  const first = await t2.candles(CURVE, "1m", null, 10);
  assert.deepEqual([first.status, JSON.parse(first.body), first.retryAfterS], [429, { error: { code: "rate_limited" } }, 30], "the code only, GeckoTerminal's wait");
  now += 10_000;
  assert.deepEqual([(await t2.candles(CURVE, "5m", null, 10)).status, (await t2.candles(CURVE, "15m", null, 10)).retryAfterS], [429, 20], "the paused queue answers the pause left");
  assert.equal(limited.urls.length, 1, "paused after the 429");
});

test("candles: the server's one GeckoTerminal budget: the page takes what the lists left, and past the minute a throttle naming the wait to its oldest call's minute", async () => {
  const g = fakeGecko();
  const now = NOW;
  const shared = geckoBudget(() => now);
  for (let i = 0; i < GT_PER_MIN - PAGE_RESERVE; i++) assert.equal(shared.take("lists"), true);
  assert.equal(shared.take("lists"), false, "the lists leave PAGE_RESERVE free");
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => now, fetch: g.fetch, gecko: shared });
  const tfs = ["1m", "5m", "15m", "1h", "4h", "1d"];
  for (let i = 0; i < 6; i++) await t.candles(CURVE, tfs[i % 6]!, 1793620800 - i * 86_400, 10);
  assert.equal(g.urls.length, PAGE_RESERVE, "the page's calls: the reserve the lists left");
  const over = await t.candles(CURVE, "1d", 1793620800 - 40 * 86_400, 10);
  assert.deepEqual([over.status, over.retryAfterS], [429, WINDOW_MS / 1000], "a call past the window is a throttle naming the exact wait to its oldest call leaving it");
});
test("review F-E: a GeckoTerminal 429 (and the paused queue after it) answers 429 with a wait, not 503", async () => {
  let gt = 0;
  const proxy = { handle: async () => ({ status: 503, headers: {}, body: '{"error":{"code":"upstream"}}' }) };
  const rpc = { handle: async () => ({ status: 503, body: '{"error":{"code":"upstream"}}' }) };
  const t = createSolanaToken(proxy as never, rpc as never, { fetch: (async () => (gt++, new Response("slow", { status: 429, headers: { "retry-after": "30" } }))) as never });
  const mint = "So11111111111111111111111111111111111111112";
  await t.candles(mint, "1h", null, 10);
  const second = await t.candles(mint, "1h", null, 10);
  assert.equal(second.status, 429, "the helper's own paused GT queue is a throttle");
});

test("page and holders: a throttled RPC or Jupiter read with nothing good to serve answers 429 with the throttle's wait; the last good page still serves", async () => {
  const throttledRpc = { handle: async () => ({ status: 429, headers: { "Retry-After": "7" }, body: '{"error":{"code":"rate_limited"}}' }) };
  const a = await createSolanaToken(fakeProxy(), throttledRpc, { now: () => NOW }).page(PUMP);
  assert.deepEqual([a.status, JSON.parse(a.body), a.retryAfterS], [429, { error: { code: "rate_limited" } }, 7]);
  const throttledProxy = { handle: async () => ({ status: 429, headers: { "Retry-After": "12" }, body: '{"error":{"code":"rate_limited"}}' }) };
  const b = await createSolanaToken(throttledProxy, fakeRpc(), { now: () => NOW }).page(PUMP);
  assert.deepEqual([b.status, b.retryAfterS], [429, 12]);
  let now = NOW;
  let throttle = false;
  const rpc = fakeRpc();
  const t = createSolanaToken(fakeProxy(), { handle: (c, ct, body) => (throttle ? throttledRpc.handle() : rpc.handle(c, ct, body)) }, { now: () => now });
  assert.equal((await t.page(PUMP)).status, 200);
  throttle = true;
  now += 10_000;
  assert.equal((await t.page(PUMP)).status, 200, "the last good page, under 60 s old");
});

test("toCandles: bars off the grid, from the future, with a zero, negative or non-finite price, or low above high are dropped", () => {
  const T = 1793627520;
  const good = [T, 1, 2, 0.5, 1.5, 10];
  const ans = (list: unknown[]) => ({ data: { attributes: { ohlcv_list: list } } });
  assert.deepEqual(toCandles(ans([good]), "1m", 10, NOW), [[T, "1", "2", "0.5", "1.5", "10"]]);
  for (const bad of [[T + 1, 1, 2, 0.5, 1.5, 10], [T + 3_600, 1, 2, 0.5, 1.5, 10], [T, 0, 2, 0.5, 1.5, 10], [T, -1, 2, 0.5, 1.5, 10], [T, 1, 2, 3, 1.5, 10], [T, 1, 2, 0.5, 3, 10], [T, 1, 2, 0.5, 1.5, -1], [T, 1, Infinity, 0.5, 1.5, 10], [T, "1", 2, 0.5, 1.5, 10], [T, 1, 2, 0.5]])
    assert.deepEqual(toCandles(ans([bad]), "1m", 10, NOW), [], JSON.stringify(bad));
  assert.deepEqual(toCandles(ans([good, good]), "1m", 10, NOW)!.length, 1, "one bar per open time");
  assert.equal(toCandles({ data: {} }, "1m", 10, NOW), null);
  assert.equal(topPool({ data: { relationships: { top_pools: { data: [{ id: "base_0xabc" }] } } } }), null);
  assert.equal(topPool({ data: { relationships: { top_pools: { data: [] } } } }), null);
});

// ---- the routes ----------------------------------------------------------------------------------------------

const good = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => NOW, fetch: fakeGecko().fetch });
const servers = [start(COMMIT, 0, undefined, undefined, undefined, undefined, undefined, undefined, good)];
const ports: number[] = [];
before(() => Promise.all(servers.map((s, i) => new Promise<void>((ok) => s.on("listening", () => ((ports[i] = (s.address() as AddressInfo).port), ok()))))));
after(() => Promise.all(servers.map((s) => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))))));

function call(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: ports[0], method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d)).on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", fail).end();
  });
}

test("GET /v1/market/token, /holders and /candles with chain=solana: 200 in the field lists, commit, source, read time, CORS", async () => {
  for (const [path, fields, src] of [
    [`/v1/market/token?chain=solana&token=${PUMP}`, PAGE_FIELDS, "jupiter"],
    [`/v1/market/holders?chain=solana&token=${PUMP}`, HOLDERS_FIELDS, "jupiter"],
    [`/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&limit=5`, CANDLES_FIELDS, "geckoterminal"],
  ] as const) {
    const r = await call("GET", path, { origin: APP });
    assert.equal(r.status, 200, path);
    assert.deepEqual(Object.keys(JSON.parse(r.body)), [...fields], path);
    assert.equal(r.headers["x-helper-commit"], COMMIT);
    assert.equal(r.headers["x-helper-source"], src);
    assert.ok(Number.isFinite(Date.parse(String(r.headers["x-fetched-at"]))));
    assert.equal(r.headers["access-control-allow-origin"], APP);
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    const h = await call("HEAD", path);
    assert.equal(h.status, 200);
    assert.equal(h.body, "");
  }
});

test("the routes refuse: another method 405; no, two or another chain, no or two tokens, a bad tf, to or limit 404", async () => {
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await call(m, `/v1/market/token?chain=solana&token=${PUMP}`)).status, 405, m);
  for (const q of [
    `/v1/market/token?token=${PUMP}`,
    `/v1/market/token?chain=base&token=${PUMP}`,
    `/v1/market/token?chain=solana&chain=solana&token=${PUMP}`,
    `/v1/market/token?chain=solana`,
    `/v1/market/token?chain=solana&token=${PUMP}&token=${PUMP}`,
    `/v1/market/token?chain=solana&token=nope`,
    `/v1/market/holders?chain=near&token=${PUMP}`,
    `/v1/market/candles?chain=solana&token=${CURVE}`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1s`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&to=-1`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&to=1e9`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&limit=0`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&limit=501`,
    `/v1/market/candles?chain=solana&token=${CURVE}&tf=1m&limit=5&limit=5`,
    `/v1/market/token/x?chain=solana&token=${PUMP}`,
  ]) {
    const r = await call("GET", q);
    assert.equal(r.status, 404, q);
  }
});

// card helper-launchpad-origin: the page's launchpad and pool are the chain's, on the launch reads recorded 2026-11-03
// 16:49Z (fixtures/solana-origins.json, origin.test.ts)
test("page: a LaunchLab token on its curve trades in its LaunchLab pool, read on chain; a token Jupiter tags with no launch on chain is untagged", async () => {
  const OX = JSON.parse(readFileSync(new URL("./fixtures/solana-origins.json", import.meta.url), "utf8")) as { tokens: { case: string; mint: string; origin: { pad: string; pool: string; curveBps: number | null } | null; jupiter: Record<string, unknown> }[]; accounts: Record<string, unknown> };
  const mintAcct = FX.tokens[PUMP].accounts.result.value[0];
  const rpc = {
    async handle(_c: string, _t: string | undefined, body: string) {
      const r = JSON.parse(body) as RpcCall;
      const keys = r.params[0] as string[];
      const base64 = (r.params[1] as { encoding?: string }).encoding === "base64";
      const value = base64 ? keys.map((k) => OX.accounts[k] ?? null) : keys.map(() => mintAcct);
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 464517653 }, value } }) };
    },
  };
  const ll = OX.tokens.find((t) => t.case === "raydium-launchlab" && t.origin!.curveBps! < 10_000)!;
  const md = OX.tokens.find((t) => t.jupiter.launchpad === "metadao")!;
  const t = createSolanaToken(fakeProxy({ search: (m) => OX.tokens.filter((x) => x.mint === m).map((x) => x.jupiter) }), rpc, { now: () => NOW });
  const p = JSON.parse((await t.page(ll.mint)).body);
  assert.equal(p.row.launchpad, "raydium-launchlab");
  assert.equal(p.row.curve_bps, ll.origin!.curveBps);
  assert.equal(p.pool, ll.origin!.pool, "on its curve: the LaunchLab pool");
  assert.equal(p.risk.lp.v.class, "curve");
  const q = JSON.parse((await t.page(md.mint)).body);
  assert.equal(q.row.launchpad, null, "Jupiter's metadao tag with no launch read on chain");
});

test("candles: a GeckoTerminal 429 after one good read serves the last good bars of that mint and tf (cut at `to`), read time the good read's; with no good read, 429, never an empty 200", async () => {
  // app live run 41787804457 (4 Nov 06:49Z): wNEAR's chart drew no bars while GeckoTerminal was throttled
  let now = NOW;
  let refuse = false;
  const g = fakeGecko();
  const fetchFn = async (url: string) => (refuse ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : g.fetch(url));
  const t = createSolanaToken(fakeProxy(), fakeRpc(), { now: () => now, fetch: fetchFn as never });
  const good = await t.candles(CURVE, "1m", null, 500);
  assert.equal(good.status, 200);
  const bars = JSON.parse(good.body).candles as [number, ...string[]][];
  assert.ok(bars.length > 2);
  now += 10 * 60_000; // past the cache and its stale window
  refuse = true;
  const kept = await t.candles(CURVE, "1m", null, 500);
  assert.equal(kept.status, 200, kept.body);
  assert.deepEqual(JSON.parse(kept.body).candles, bars);
  assert.equal(kept.src, "geckoterminal");
  assert.equal(kept.asOfMs, NOW, "the good read's time, not now");
  const to = bars.at(-2)![0];
  const cut = await t.candles(CURVE, "1m", to, 500);
  assert.equal(cut.status, 200);
  assert.deepEqual(JSON.parse(cut.body).candles, bars.filter((b) => b[0] < to));
  const none = await t.candles(CURVE, "15m", null, 500); // never read: nothing kept
  assert.equal(none.status, 429);
  assert.ok((none.retryAfterS ?? 0) > 0);
});

test("card helper-ready-gate: under a walk at full draw all along, a burst of 15 callers opening token pages and holders answers 200 every time, never 429", async () => {
  // one public provider for every read the helper makes: 100 requests per 10 s from our address, then 429 Retry-After 5
  // (4 Nov 06:24-06:30Z and the 07:50Z live run 41794726819); the clock stands still, so nothing leaves its window
  const PUBLIC = "https://api.mainnet-beta.solana.com";
  const fr = fakeRpc();
  let sent = 0;
  const provider = (async (_url: string, init: RequestInit) => {
    sent++;
    if (sent > 100) return new Response("", { status: 429, headers: { "retry-after": "5" } });
    const a = await fr.handle("solana", "application/json", String(init.body));
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as never;
  const rpc = createRpc({}, { now: () => NOW, fetch: provider });
  const r = rpc as unknown as { background?: (chain: string, url: string, method: string) => number };
  // the trade walks (trades.ts: signature pages, transactions, pools and the SOL price): every request they can take,
  // each one to the provider; a helper with no budget for them (before this card) takes as many as its tokens need,
  // here 200 a round
  const METHODS = ["getTransaction", "getSignaturesForAddress", "getAccountInfo"];
  const walk = () => {
    let n = 0;
    while (n < 200 && (r.background?.("solana", PUBLIC, METHODS[n % 3]!) ?? 0) === 0) n++;
    sent += n;
    return n;
  };
  assert.ok(walk() > 0, "the walk draws");
  // fifteen callers, each a token page and its holders of a token no one opened yet (a token page each: no shared cache)
  const statuses: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = createSolanaToken(fakeProxy(), rpc, { now: () => NOW });
    const mint = i % 2 === 0 ? PUMP : CURVE;
    const [page, holders] = await Promise.all([t.page(mint, `198.51.100.${i}`), t.holders(mint, `198.51.100.${i}`)]);
    statuses.push(page.status, holders.status);
    walk(); // the walk takes whatever is left after each caller
  }
  assert.deepEqual(statuses, Array(30).fill(200), "every caller's read answered");
  assert.ok(sent <= 100, `the provider was sent ${sent}, never past its limit`);
});
