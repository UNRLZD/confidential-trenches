// Card signpage-reads-take-the-call-signal: a read the signing page stops waiting for (a fee walk's cut, a sign out, a
// bound) ends its request at the provider, so a hung provider never holds the host's slot or its pace token. Each of
// the page's RPC wrapper kinds hands the call's signal on: the laned client (lanedRpc, its fetch), the seat (seatRpc),
// the wrapped pairs (solanaWrappedRpc: read-waits, kindSwitched), the helper's routes (pageEvmWalletRpc,
// pageEvmShownRpc) and PoolRpc (keptTokenDecimals). The positions pass's gate and the preview's bound are held in
// positions-evm.test.ts and pool-sell-dry.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evmTwoOperators } from "../../kit/src/trade/evm/read-two.ts";
import type { SolanaRpc } from "../../kit/src/trade/solana/send.ts";
import { resetHostLanes } from "../../wallet/src/throttle.ts";
import { lanedRpc, seatRpc } from "../src/page-rpc.ts";
import { keptTokenDecimals, tokenDecimalsKept } from "../src/pool-kinds.ts";
import { kindSwitched, pageEvmFeeRpcs, pageEvmShownRpc, pageEvmWalletRpc } from "../src/pool-testnet.ts";
import { keptReads, youngReads } from "../src/read-waits.ts";

/** A fetch whose requests to `hung` hosts never answer until their signal aborts (each abort's reason kept), and whose
 *  others answer `result`; every request's host kept. */
function hangsAt(hung: readonly string[], result: unknown = "0x01") {
  const o = { asked: [] as string[], hung: 0, aborted: [] as unknown[] };
  const fetch = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const host = new URL(String(u instanceof Request ? u.url : u)).host;
    o.asked.push(host);
    const body = JSON.parse(String(init?.body)) as { id: unknown } | { id: unknown }[];
    if (hung.includes(host)) {
      o.hung++;
      const s = init?.signal;
      return new Promise<never>((_, no) => {
        if (s == null) return;
        if (s.aborted) return (o.aborted.push(s.reason), no(s.reason));
        s.addEventListener("abort", () => (o.aborted.push(s.reason), no(s.reason)), { once: true });
      });
    }
    const one = (b: { id: unknown }) => ({ jsonrpc: "2.0", id: b.id, result });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { "content-type": "application/json" } });
  };
  return Object.assign(o, { fetch });
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("the page's fee walk over its own clients: a hung operator's request ends at the walk's cut, at the provider", { timeout: 20_000 }, async (t) => {
  const real = globalThis.fetch;
  const fees = pageEvmFeeRpcs("robinhood");
  const hungHost = new URL(fees[0]!.url!).host;
  const f = hangsAt([hungHost]);
  globalThis.fetch = f.fetch as typeof fetch;
  t.after(() => ((globalThis.fetch = real), resetHostLanes()));
  const walk = evmTwoOperators(fees.map((rpc) => ({ url: rpc.url!, rpc })), { callMs: 300, budgetMs: 5_000 });
  const [a, b] = await walk.read("the chain fee", (rpc, cut) => rpc("eth_call", [{ to: "0x420000000000000000000000000000000000000f", data: "0x" }, "latest"], cut), (x, y) => x === y);
  await settle();
  assert.notEqual(a.host, hungHost);
  assert.notEqual(b.host, hungHost);
  assert.ok(f.hung >= 1, "the hung operator was asked");
  assert.equal(f.aborted.length, f.hung, "every hung request was aborted at the provider");
  assert.ok(f.aborted.every((e) => /no answer in 300 ms/.test(String((e as Error)?.message))), `the walk's own cut: ${f.aborted.map(String).join("; ")}`);
});

test("lanedRpc: the call's own signal reaches its fetch, beside the reader's", { timeout: 10_000 }, async (t) => {
  t.after(() => resetHostLanes());
  for (const reader of [undefined, new AbortController().signal]) {
    const f = hangsAt(["laned.example"]);
    const rpc = lanedRpc("https://laned.example/", { fetch: f.fetch as never, ...(reader ? { signal: reader } : {}) });
    const call = new AbortController();
    const p = rpc("getSlot", [], call.signal);
    p.catch(() => {});
    await settle();
    assert.equal(f.hung, 1);
    call.abort(new Error("the caller gave up"));
    await assert.rejects(p, /the caller gave up/);
    assert.deepEqual(f.aborted.map((e) => (e as Error).message), ["the caller gave up"], "the request in flight aborted with the call's reason");
    await settle();
    assert.equal(f.hung, 1, "never asked again after the call's stop");
  }
});

test("seatRpc: the call's signal reaches the member asked, and a stop is no member fault: no failover after it", { timeout: 10_000 }, async (t) => {
  const real = globalThis.fetch;
  const f = hangsAt(["seat-a.example"]);
  globalThis.fetch = f.fetch as typeof fetch;
  t.after(() => ((globalThis.fetch = real), resetHostLanes()));
  const seat = seatRpc(["https://seat-a.example/", "https://seat-b.example/"]);
  const call = new AbortController();
  const p = seat("getSlot", [], call.signal);
  p.catch(() => {});
  await settle();
  assert.deepEqual(f.asked, ["seat-a.example"]);
  call.abort(new Error("the caller gave up"));
  await assert.rejects(p, /the caller gave up/);
  await settle();
  assert.equal(f.aborted.length, 1, "the first member's request aborted");
  assert.deepEqual(f.asked, ["seat-a.example"], "the spare is never asked for a read the caller gave up");
});

test("the wrapped pairs hand each call's signal to their provider: keptReads, youngReads (a read no one shares) and kindSwitched", async () => {
  const got: (AbortSignal | undefined)[] = [];
  const rec = (n: number): SolanaRpc => Object.assign(async (_m: string, _p: readonly unknown[], s?: AbortSignal) => (got.push(s), n), { url: `https://wrapped-${n}.example/` });
  const pair = [rec(0), rec(1)] as const;
  const s = new AbortController().signal;
  const kept = keptReads(pair, (m) => m === "stable");
  await kept[0]("stable", [], s);
  await kept[1]("other", [], s);
  const young = youngReads(pair, (m) => m === "shared", 1_000, () => 0);
  await young[0]("other", [], s);
  const switched = kindSwitched({ trade: pair, pass: [rec(2), rec(3)] }, () => "pass");
  await switched[1]("getSlot", [], s);
  assert.equal(got.length, 4);
  assert.ok(got.every((x) => x === s), "every wrapper handed the call's signal on");
  // a shared read is every asker's: one asker's stop never ends the others' read, so it carries none
  got.length = 0;
  await young[1]("shared", [], s);
  assert.deepEqual(got, [undefined]);
});

test("the helper's routes (pageEvmWalletRpc, pageEvmShownRpc): the call's signal ends the route's request", { timeout: 10_000 }, async (t) => {
  const real = globalThis.fetch;
  t.after(() => ((globalThis.fetch = real), resetHostLanes()));
  for (const route of [pageEvmWalletRpc("base", false)!, pageEvmShownRpc("robinhood", false)!]) {
    const f = hangsAt([new URL(route.url!).host]);
    globalThis.fetch = f.fetch as typeof fetch;
    const call = new AbortController();
    const p = route("eth_blockNumber", [], call.signal);
    p.catch(() => {});
    await settle();
    assert.equal(f.hung, 1, route.url);
    call.abort(new Error("the caller gave up"));
    await assert.rejects(p);
    await settle();
    assert.equal(f.aborted.length, 1, `${route.url}: the request in flight aborted`);
  }
});

test("PoolRpc: keptTokenDecimals hands its read's signal to both providers", async () => {
  const got: (AbortSignal | undefined)[] = [];
  const word = "0x" + "12".padStart(64, "0");
  const rpc = async (_m: string, _p: readonly unknown[], s?: AbortSignal) => (got.push(s), word);
  const signal = new AbortController().signal;
  assert.equal(await keptTokenDecimals("base", "0x" + "ab".repeat(20), [rpc, rpc], { kept: tokenDecimalsKept(), signal }), 18);
  assert.deepEqual(got, [signal, signal]);
});
