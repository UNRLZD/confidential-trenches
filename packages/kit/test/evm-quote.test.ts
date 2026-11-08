// The device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote) on the answers Base and Robinhood
// Chain mainnet gave the chains' two pinned providers, recorded by test/evm-quote-record.ts into
// fixtures/evm-quote.json with the device's clock. A planted case edits recorded answers, found by the quote each read
// asks for: a provider that lies, a quoter that reports a partial fill as complete, a hook that keeps more, a standard
// pool better than the route. test/evm-quote-attacks.test.ts holds the review's attacks on a modelled chain;
// test/evm-quote-mutants.mjs removes each check and runs the test named for it.
import { mock, test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import * as kit from "../src/index.ts";
import { EVM_NOOP_HOOK_CODE, evmPoolBuildQuoted, EvmPoolBuyError, evmPoolSignBuy, EvmQuoteError, type EvmPoolBuyQuote, type EvmPoolBuyQuoteRequest } from "../src/index.ts";
import { evmPoolBuyQuoteWith, evmProviders, evmReadsPerCall, type EvmRpc, type EvmRpcCall } from "../src/checks/evm/quote.ts";
import { evmPoolVenues, pinnedBuild } from "../src/trade/evm/buy-unpinned.ts";
import { asRecorded, gasRoundAnswers } from "./evm-quote-gas-fx.ts";
// the recordings (fixtures/evm-quote.json) were made at 6 reads an aggregate3 call, and their exchanges are matched call
// for call: these replays send 6 a call (Robinhood's venue sends 64, card evm-buy-quote-in-window: QE9)
evmReadsPerCall(6);
// the module path as a string: the red run before card evm-buy-hookdata-fee's fold 1 reads it where quoted.ts is not there yet
const QUOTED_TS: string = "../src/trade/evm/quoted.ts";

type Answer = { result?: string; error?: { code: number; message: string; data?: string } } & Record<string, unknown>;
type Exchange = { calls: EvmRpcCall[]; answers: Answer[] };
type Case = { request: Record<string, unknown>; now: number; outcome: { code: string; detail: string }; exchanges: [Exchange[], Exchange[]] };
const F: Record<string, Case> = JSON.parse(readFileSync(new URL("./fixtures/evm-quote.json", import.meta.url), "utf8"));
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const ZERO = "0x0000000000000000000000000000000000000000";
const CLANKER_HOOK = "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc";

/** The answers a provider gave to exactly these calls; `edit` changes a copy of them. */
type Edit = (answers: Answer[], calls: readonly EvmRpcCall[]) => void;
// A batch the recording holds as sent, or else each call answered as the recording answered that same call (the kit
// cuts a Base batch at its venue's 24,000 request bytes, review of 2c02f7df: a call holding a hook's code override goes
// alone where the recording sent it with two others; every call is still matched byte for byte).
const byCall = (ex: Exchange[], calls: readonly EvmRpcCall[]): Answer[] | undefined => {
  const out: Answer[] = [];
  for (const c of calls) {
    const k = JSON.stringify(c);
    let found: Answer | undefined;
    for (const x of ex) {
      const j = x.calls.findIndex((y) => JSON.stringify(y) === k);
      if (j >= 0 && x.answers[j] !== undefined) {
        found = x.answers[j];
        break;
      }
    }
    if (found === undefined) return undefined;
    out.push(found);
  }
  return out;
};
const replay = (ex: Exchange[], edit?: Edit): EvmRpc => async (sent) => {
  const calls = asRecorded(sent);
  const e = ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls));
  const a = e !== undefined ? structuredClone(e.answers) : (structuredClone(byCall(ex, calls)) ?? (gasRoundAnswers(ex, calls) as Answer[] | undefined));
  if (a === undefined) throw new Error("no recorded answer for these calls");
  if (edit !== undefined) edit(a, calls);
  return a;
};
// the fixture keeps the request's token as "buys" (see evm-quote-record.ts)
const request = (name: string): EvmPoolBuyQuoteRequest => {
  const { buys, amountIn, ...rest } = F[name]!.request;
  return { ...(rest as Omit<EvmPoolBuyQuoteRequest, "token" | "amountIn">), token: buys as string, amountIn: BigInt(amountIn as string) };
};
const quote = (name: string, edit1?: Edit, edit2?: Edit, now = F[name]!.now): Promise<EvmPoolBuyQuote> =>
  evmPoolBuyQuoteWith(request(name), [replay(F[name]!.exchanges[0], edit1), replay(F[name]!.exchanges[1], edit2)], now);
const refused = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError, `an EvmQuoteError, not ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
};

// One quoter read, from its calldata: venue, start, the currencies after it, fees, tick spacings, hooks, amount
const W = (v: bigint) => v.toString(16).padStart(64, "0");
type Read = { venue: "v3" | "v4"; from: string; to: string[]; fees: number[]; spacings: number[]; hooks: string[]; amount: bigint };
function readOf(data: string): Read {
  const sel = data.slice(0, 8);
  const h = data.slice(8);
  const w = (i: number) => BigInt("0x" + h.slice(64 * i, 64 * i + 64));
  const addr = (i: number) => "0x" + h.slice(64 * i + 24, 64 * i + 64);
  if (sel === "cdca1753") {
    const path = h.slice(64 * 3, 64 * 3 + 2 * Number(w(2)));
    const n = (path.length / 2 - 20) / 23;
    return {
      venue: "v3",
      from: "0x" + path.slice(0, 40),
      to: Array.from({ length: n }, (_, i) => "0x" + path.slice(46 + 46 * i, 86 + 46 * i)),
      fees: Array.from({ length: n }, (_, i) => parseInt(path.slice(40 + 46 * i, 46 + 46 * i), 16)),
      spacings: [],
      hooks: [],
      amount: w(1),
    };
  }
  assert.equal(sel, "ca253dc9");
  const n = Number(w(4));
  const r: Read = { venue: "v4", from: addr(1), to: [], fees: [], spacings: [], hooks: [], amount: w(3) };
  for (let i = 0; i < n; i++) {
    const at = 5 + Number(w(5 + i)) / 32;
    r.to.push(addr(at));
    r.fees.push(Number(w(at + 1)));
    r.spacings.push(Number(w(at + 2)));
    r.hooks.push(addr(at + 3));
  }
  return r;
}
/** aggregate3's calldata: each read's calldata, in order. */
function callsOf(data: string): string[] {
  const h = data.slice(10);
  const w = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  return Array.from({ length: w(32) }, (_, i) => {
    const e = 64 + w(64 + 32 * i);
    return h.slice(2 * (e + 128), 2 * (e + 128 + w(e + 96)));
  });
}
type El = { ok: boolean; data: string };
function decode(r: string): El[] {
  const h = r.slice(2);
  const at = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  return Array.from({ length: at(32) }, (_, i) => {
    const e = 64 + at(64 + 32 * i);
    return { ok: at(e) === 1, data: h.slice(2 * (e + 96), 2 * (e + 96 + at(e + 64))) };
  });
}
function encode(els: El[]): string {
  const body = els.map((x) => W(x.ok ? 1n : 0n) + W(0x40n) + W(BigInt(x.data.length / 2)) + x.data.padEnd(Math.ceil(x.data.length / 64) * 64, "0"));
  let at = 32 * els.length;
  const offs = body.map((b) => {
    const o = W(BigInt(at));
    at += b.length / 2;
    return o;
  });
  return "0x" + W(0x20n) + W(BigInt(els.length)) + offs.join("") + body.join("");
}
/** Edits every multicall read `f` names: f returns the new answer, or undefined to keep it. */
const plant = (f: (r: Read, el: El) => El | undefined): Edit => (a, calls) => {
  calls.forEach((c, i) => {
    const p = c.params[0] as { to?: string; data?: string };
    if (c.method !== "eth_call" || p.to?.toLowerCase() !== MULTICALL3 || a[i]?.result === undefined) return;
    const reads = callsOf(p.data!).map(readOf);
    const els = decode(a[i]!.result!);
    a[i]!.result = encode(els.map((el, k) => f(reads[k]!, el) ?? el));
  });
};
/** Edits the hookless read (the one call with a state override but the swap-gas read, the pool's own buySwap). */
const hookless = (f: (a: Answer) => Answer): Edit => (a, calls) => {
  calls.forEach((c, i) => {
    if (c.method === "eth_call" && c.params.length === 3 && !String((c.params[0] as { data?: unknown }).data).startsWith("0x25faf2a3")) a[i] = f(a[i]!);
  });
};
const outOf = (x: El) => BigInt("0x" + x.data.slice(0, 64));
const out = (v: bigint): El => ({ ok: true, data: W(v) + W(0n) });
const REVERT: El = { ok: false, data: "" };
const same = (r: Read, name: string) => {
  const route = request(name).route;
  if (route.venue === "uniswap-v3") return r.venue === "v3" && r.from === route.tokens[0]!.toLowerCase() && r.fees.join() === route.fees.join() && r.to.join() === route.tokens.slice(1).join().toLowerCase();
  return r.venue === "v4" && r.from === route.currencyIn.toLowerCase() && r.fees.join() === route.hops.map((h) => h.fee).join() && r.hooks.join() === route.hops.map((h) => h.hooks.toLowerCase()).join() && r.to.join() === route.hops.map((h) => h.currency.toLowerCase()).join();
};
const isRoute = (name: string, times: bigint) => (r: Read) => same(r, name) && r.amount === times * request(name).amountIn;

test("Q1 the device quotes a route both providers agree on, at one block both hold", async () => {
  for (const name of ["base-ok", "robinhood-ok", "base-hook"]) {
    const q = await quote(name);
    const req = request(name);
    assert.equal(F[name]!.outcome.code, "ok");
    assert.ok(q.amountOut > 0n);
    assert.equal(q.minOut, (q.amountOut * BigInt(10000 - req.slippageBps)) / 10000n, `${name}: minOut from Q`);
    assert.ok(q.reference !== null && q.amountOut >= q.reference.amountOut, `${name}: Q at least R`);
    // the lower head, confirmed by number on the other provider, its time within 30 s of the device's clock
    const heads = F[name]!.exchanges.map((ex) => BigInt((ex[0]!.answers[0]!.result as unknown as { number: string }).number));
    assert.equal(q.block.number, heads[0]! <= heads[1]! ? heads[0] : heads[1]);
    assert.ok(F[name]!.now - Number(q.block.timestamp) * 1000 <= 30_000);
    for (const ex of F[name]!.exchanges) {
      for (const e of ex) for (const c of e.calls) if (c.method === "eth_call") assert.deepEqual(c.params[1], { blockHash: q.block.hash, requireCanonical: true });
    }
  }
});

test("Q2 two providers that disagree refuse", async () => {
  const main = isRoute("base-ok", 1n);
  // the route's quote, one more on provider 2
  await refused(quote("base-ok", undefined, plant((r, el) => (main(r) ? out(outOf(el) + 1n) : undefined))), "rpc_disagree");
  // every standard pool lower on provider 2 (it would hide the device's reference)
  await refused(quote("base-ok", undefined, plant((r, el) => (!main(r) && el.ok ? out(outOf(el) - 1n) : undefined))), "rpc_disagree");
  // provider 2 fakes a revert of every standard pool
  await refused(quote("base-ok", undefined, plant((r) => (!same(r, "base-ok") ? REVERT : undefined))), "rpc_disagree");
  // the hookless read, more on provider 2
  await refused(quote("base-hook", undefined, hookless((a) => ({ ...a, result: "0x" + W(BigInt(a.result!.slice(0, 66)) + 1n) + a.result!.slice(66) }))), "rpc_disagree");
  // a partial fill on one provider only: a quote on the other, or a plain revert
  await refused(quote("base-partial-v4", undefined, plant((r) => (isRoute("base-partial-v4", 1n)(r) ? out(1n) : undefined))), "rpc_disagree");
  await refused(quote("base-partial-v4", undefined, plant((r) => (isRoute("base-partial-v4", 1n)(r) ? REVERT : undefined))), "rpc_disagree");
});

test("Q3 a partial-fill quote refuses", async () => {
  // V4Quoter's own refusal: 100 ETH into a pool that runs out (NotEnoughLiquidity, recorded)
  assert.equal(F["base-partial-v4"]!.outcome.code, "partial_fill");
  await refused(quote("base-partial-v4"), "partial_fill");
  // a quoter that reports a partial fill as complete (QuoterV2 does): twice the amount quotes no more, on both
  const flat: Edit = (a, c) => {
    let once = 0n;
    plant((r, el) => (isRoute("base-ok", 1n)(r) ? ((once = outOf(el)), undefined) : undefined))(a, c);
    plant((r) => (isRoute("base-ok", 2n)(r) ? out(once) : undefined))(a, c);
  };
  await refused(quote("base-ok", flat, flat), "partial_fill");
  // a v3 route whose quote at twice the amount reverts
  const v3twice = plant((r) => (isRoute("base-below", 2n)(r) ? REVERT : undefined));
  await refused(quote("base-below", v3twice, v3twice), "partial_fill");
  // a standard pool whose output does not grow with its input is no reference, though it quotes far more
  const ranOut = plant((r) => (r.venue === "v4" && r.to.length === 1 && r.fees[0] === 100 && r.spacings[0] === 1 && r.from === ZERO && !same(r, "base-ok") ? out(10n ** 30n) : undefined));
  const q = await quote("base-ok", ranOut, ranOut);
  assert.ok(q.reference !== null && q.reference.amountOut < 10n ** 30n, "a standard pool whose output does not grow is not the reference");
  // nor a v3 pool whose quote at twice the amount reverts (a v3 pool has no hook to revert it)
  const v3ranOut = plant((r) => (r.venue === "v3" && r.to.length === 1 && r.fees[0] === 10000 && !same(r, "base-ok") ? (r.amount === request("base-ok").amountIn ? out(10n ** 30n) : REVERT) : undefined));
  const q3 = await quote("base-ok", v3ranOut, v3ranOut);
  assert.ok(q3.reference !== null && q3.reference.amountOut < 10n ** 30n, "a v3 pool that cannot fill twice the amount is not the reference");
});

test("Q4 a launchpad hook's take is shown and bounded by minOut", async () => {
  const q = await quote("base-hook");
  assert.ok(q.hook !== null && q.hook.hookless !== null && q.hook.take !== null);
  assert.equal(q.hook.take, q.hook.hookless - q.amountOut);
  assert.ok(q.hook.take > 0n, "Clanker's hook keeps part of the buy");
  assert.equal(q.hook.takeBps, Number((q.hook.take * 10000n) / q.hook.hookless));
  // minOut comes from the route the hook runs in, so the hook cannot keep more than shown and the slippage
  assert.equal(q.minOut, (q.amountOut * 9700n) / 10000n);
  assert.ok(q.minOut < q.amountOut && q.amountOut < q.hook.hookless);
  // the hookless read is the same route with the pinned hook's code replaced by the no-op hook
  const lone = F["base-hook"]!.exchanges[0]!.flatMap((e) => e.calls).find((c) => c.params.length === 3)!;
  assert.deepEqual(lone.params[2], { [CLANKER_HOOK]: { code: EVM_NOOP_HOOK_CODE } });
  // a planted hook that keeps more: the take grows, minOut stays the route's
  const more = hookless((a) => ({ ...a, result: "0x" + W(BigInt(a.result!.slice(0, 66)) * 3n) + a.result!.slice(66) }));
  const p = await quote("base-hook", more, more);
  assert.equal(p.hook!.take, p.hook!.hookless! - p.amountOut);
  assert.ok(p.hook!.takeBps! > 6000);
  assert.equal(p.minOut, q.minOut);
  // a hook that gives more than its pool: no take
  const less = hookless((a) => ({ ...a, result: "0x" + W(1n) + a.result!.slice(66) }));
  assert.equal((await quote("base-hook", less, less)).hook!.take, 0n);
  // a hookless read that reverts on both: the take is unknown, the quote stands
  const gone = hookless((a) => ({ jsonrpc: "2.0", id: a.id, error: { code: 3, message: "execution reverted" } }));
  const u = await quote("base-hook", gone, gone);
  assert.deepEqual(u.hook, { hookless: null, take: null, takeBps: null });
  // a route with no hooked hop has no take
  assert.equal((await quote("base-ok")).hook, null);
});

test("Q5 a helper route below the device's standard-pool reference refuses", async () => {
  assert.equal(F["base-below"]!.outcome.code, "below_reference");
  await assert.rejects(quote("base-below"), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference");
    assert.ok(e.reference !== null && e.reference.amountOut > 0n);
    return true;
  });
  // a standard v4 pool one unit better than the route, on both providers
  const Q = (await quote("base-ok")).amountOut;
  const better = plant((r) =>
    r.venue === "v4" && r.to.length === 1 && r.fees[0] === 10000 && r.from === ZERO && r.hooks[0] === ZERO ? out(r.amount === request("base-ok").amountIn ? Q + 1n : 3n * Q) : undefined,
  );
  await refused(quote("base-ok", better, better), "below_reference");
  // and a standard v3 pool
  const betterV3 = plant((r) => (r.venue === "v3" && r.to.length === 1 && r.fees[0] === 500 ? out(r.amount === request("base-ok").amountIn ? Q + 1n : 3n * Q) : undefined));
  await assert.rejects(quote("base-ok", betterV3, betterV3), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference", String(e));
    assert.equal(e.reference?.route.venue, "uniswap-v3");
    return true;
  });
});

test("Q6 the Robinhood native-first rule picks native when it quotes at least as much", async () => {
  // recorded: the WETH v4 route quotes below the native route, so it refuses and names the native route
  assert.equal(F["robinhood-weth-v4"]!.outcome.code, "native_first");
  await assert.rejects(quote("robinhood-weth-v4"), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "native_first", String(e));
    const r = e.reference?.route;
    assert.ok(r?.venue === "uniswap-v4" && r.currencyIn === ZERO, "the device's own route starts native");
    return true;
  });
  // recorded: at its block the WETH v3 route quotes strictly more than every native route, so it is bought
  assert.equal(F["robinhood-weth-v3"]!.outcome.code, "ok");
  const v3 = await quote("robinhood-weth-v3");
  assert.deepEqual(v3.route, request("robinhood-weth-v3").route);
  // the WETH route planted at x on both providers, against the recorded native routes at the same block
  const at = (x: bigint) => plant((r) => (same(r, "robinhood-weth-v3") ? out(r.amount === request("robinhood-weth-v3").amountIn ? x : 2n * x) : undefined));
  let native = 0n;
  await assert.rejects(quote("robinhood-weth-v3", at(1n), at(1n)), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "native_first", String(e));
    native = e.reference!.amountOut;
    return true;
  });
  assert.ok(native > 0n && native < v3.amountOut, `the native route ${native} quotes less than the WETH route ${v3.amountOut}`);
  // equal to the best native route: native_first; one unit more: bought through WETH
  await refused(quote("robinhood-weth-v3", at(native), at(native)), "native_first");
  assert.equal((await quote("robinhood-weth-v3", at(native + 1n), at(native + 1n))).amountOut, native + 1n);
  // a WETH pool planted as strictly better than every native route on both providers: the WETH route is bought
  const wethBest = plant((r) => (r.venue === "v3" && r.to.length === 1 ? out(r.amount * 10n ** 9n) : undefined));
  const viaWeth = await quote("robinhood-weth-v3", wethBest, wethBest);
  assert.deepEqual(viaWeth.route, request("robinhood-weth-v3").route, "bought through the WETH route");
  // the native route quotes
  const q = await quote("robinhood-ok");
  assert.ok(q.route.venue === "uniswap-v4" && q.route.currencyIn === ZERO);
  // with no native pool answering, a WETH route is not refused for its start
  const noNative = plant((r) => (r.venue === "v4" && r.from === ZERO ? REVERT : undefined));
  const w = await quote("robinhood-weth-v3", noNative, noNative).then((x) => x.route.venue, (e: unknown) => (e as EvmQuoteError).code);
  assert.equal(w, "uniswap-v3");
});

test("Q7 only a quote the device made builds a buy, and only within 30 s, and W signs only that build", async () => {
  const q = await quote("base-ok");
  const at = Number(q.block.timestamp) * 1000;
  const ADAPTER = "0x0000000000000000000000000000000000000001";
  const clock = mock.method(Date, "now", () => at);
  try {
    assert.throws(() => evmPoolBuildQuoted(ADAPTER, { ...q }), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
    assert.throws(() => evmPoolBuildQuoted(ADAPTER, { ...q, minOut: 1n }), (e: unknown) => e instanceof EvmQuoteError);
    // the device's quote passes to the pinned builder: Base's pins (card pool-evm-deploy-mainnet) refuse any other
    // adapter, and its pinned adapter for the route's venue builds
    assert.throws(() => evmPoolBuildQuoted(ADAPTER, q), (e: unknown) => e instanceof EvmPoolBuyError && e.code === "not_pinned");
    const own = evmPoolVenues().base.adapters![q.route.venue === "uniswap-v3" ? "v3" : "v4"]!;
    assert.equal(evmPoolBuildQuoted(own, q).adapter.toLowerCase(), own.toLowerCase());
    // 31 s after its block, the same quote builds nothing
    clock.mock.mockImplementation(() => at + 31_000);
    assert.throws(() => evmPoolBuildQuoted(ADAPTER, q), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
  } finally {
    clock.mock.restore();
  }
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.route) && Object.isFrozen(q.block));
  // W signs no buy built another way: here the pinned builder W's own build would call, on a testnet it pins
  const venues = evmPoolVenues();
  const other = pinnedBuild(venues, "base-sepolia", venues["base-sepolia"].adapters![q.route.venue === "uniswap-v3" ? "v3" : "v4"]!, q.route, 1n, q.token);
  const proof = { nullifier: 1n, context: 2n, value: 3n };
  assert.throws(() => evmPoolSignBuy(new Uint8Array(32).fill(1), "base-sepolia", venues["base-sepolia"].pool!, other, proof), (e: unknown) => e instanceof EvmPoolBuyError && e.code === "not_built");
  // the kit exports no builder that takes its caller's minOut
  assert.equal("evmPoolBuild" in kit, false);
  assert.equal("evmPoolBuyQuoteWith" in kit, false);
  // the pins the signing page holds (quoted.ts evmQuotedBuy, card evm-buy-hookdata-fee M1): the device's quote builds
  // through them at the page's clock, and only that build is a quoted one; the index exports neither
  const { evmQuotedBuy, evmIsQuotedBuy } = await import(QUOTED_TS);
  const pins = Object.freeze({ base: Object.freeze({ ...venues.base, pool: "0x00000000000000000000000000000000000000b0", adapters: Object.freeze({ v3: ADAPTER }) }) });
  const qb = evmQuotedBuy(pins, ADAPTER, q, at);
  assert.ok(evmIsQuotedBuy(qb) && !evmIsQuotedBuy({ ...qb }) && !evmIsQuotedBuy(Object.create(qb)));
  assert.equal(evmIsQuotedBuy(pinnedBuild(pins, "base", ADAPTER, q.route, q.minOut, q.token)), false, "an unquoted pinned build is not a quoted one");
  assert.throws(() => evmQuotedBuy(pins, ADAPTER, { ...q }, at), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
  assert.throws(() => evmQuotedBuy(pins, ADAPTER, q, at + 31_000), (e: unknown) => e instanceof EvmQuoteError && e.code === "stale_quote");
  assert.equal("evmQuotedBuy" in kit || "evmIsQuotedBuy" in kit, false);
});

test("Q8 a bad request refuses before any read", async () => {
  const none: EvmRpc = async () => assert.fail("no read");
  const other: EvmRpc = async () => assert.fail("no read");
  const r = request("base-ok");
  const now = F["base-ok"]!.now;
  for (const [bad, code] of [
    [{ ...r, amountIn: 0n }, "bad_request"],
    [{ ...r, amountIn: 1n << 127n }, "bad_request"],
    [{ ...r, slippageBps: 10000 }, "bad_request"],
    [{ ...r, slippageBps: -1 }, "bad_request"],
    [{ ...r, slippageBps: 1.5 }, "bad_request"],
    [{ ...r, token: "0x4200000000000000000000000000000000000006" }, "token_mismatch"],
  ] as const) {
    await refused(evmPoolBuyQuoteWith(bad as EvmPoolBuyQuoteRequest, [none, other], now), code);
  }
  await refused(evmPoolBuyQuoteWith(r, [none, none], now), "bad_request");
  // Robinhood testnet pins a V4Quoter and no QuoterV2 (no v3 there, M365; card evm-sell-device-quote): a v3 route is
  // refused before any read, on any providers and on the pinned ones
  const rhV3 = { ...r, chain: "robinhood-testnet" as const, route: { venue: "uniswap-v3" as const, tokens: [kit.evmPoolVenues()["robinhood-testnet"].weth, r.token], fees: [3000] } };
  await refused(evmPoolBuyQuoteWith(rhV3, [none, other], now), "no_quoter");
  await refused(kit.evmPoolBuyQuote(rhV3), "no_quoter");
  // two providers on one host, or not https, are refused
  assert.throws(() => evmProviders(["https://a.example.org/x", "https://A.example.org/y"], fetch), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
  assert.throws(() => evmProviders(["http://a.example.org", "https://b.example.org"], fetch), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
});

test("Q9 a provider error or a malformed answer refuses", async () => {
  const limited: Edit = (a, c) => {
    c.forEach((x, i) => {
      if (x.method === "eth_call") a[i] = { jsonrpc: "2.0", id: i, error: { code: -32007, message: "25/second request limit reached" } };
    });
  };
  await refused(quote("base-ok", undefined, limited), "rpc_error");
  // a multicall answer cut short, one with an offset past its end, and a batch with one answer missing
  const short: Edit = (a, c) => {
    c.forEach((x, i) => {
      if (x.method === "eth_call" && a[i]!.result) a[i]!.result = a[i]!.result!.slice(0, 2 + 64 * 3);
    });
  };
  await refused(quote("base-ok", short, undefined), "rpc_error");
  // the first result's offset past the answer's end
  const outside: Edit = (a, c) => {
    c.forEach((x, i) => {
      const p = x.params[0] as { to?: string };
      if (x.method === "eth_call" && p.to?.toLowerCase() === MULTICALL3 && a[i]!.result) a[i]!.result = a[i]!.result!.slice(0, 2 + 128) + W(0x10000n) + a[i]!.result!.slice(2 + 192);
    });
  };
  await refused(quote("base-ok", outside, outside), "rpc_error");
  // the first result's length past the answer's end
  const longer: Edit = (a, c) => {
    c.forEach((x, i) => {
      const p = x.params[0] as { to?: string };
      if (x.method !== "eth_call" || p.to?.toLowerCase() !== MULTICALL3 || !a[i]!.result) return;
      const r = a[i]!.result!;
      const e = 2 + 2 * (64 + Number(BigInt("0x" + r.slice(2 + 128, 2 + 192))));
      a[i]!.result = r.slice(0, e + 128) + W(0x10000n) + r.slice(e + 192);
    });
  };
  await refused(quote("base-ok", longer, longer), "rpc_error");
  const fewer: Edit = (a, c) => {
    if (c.length > 1) a.pop();
  };
  await refused(quote("base-ok", fewer, undefined), "rpc_error");
  // a batch answered with one answer too many (a copy of its first): the head's, the confirmation's and the last
  // batch of reads (base-ok's 5 calls go in batches of 3 and 2), where the extra answer would otherwise go unread
  const more: Edit = (a, c) => {
    if (c.length < 3) a.push(structuredClone(a[0]!));
  };
  await refused(quote("base-ok", more, undefined), "rpc_error");
  const down: EvmRpc = async () => {
    throw new Error("offline");
  };
  await refused(evmPoolBuyQuoteWith(request("base-ok"), [replay(F["base-ok"]!.exchanges[0]), down], F["base-ok"]!.now), "rpc_error");
});

test("Q10 a quote too small for a minimum above 0 refuses", async () => {
  // the route and its pinned launchpad pool are the same read: 1 unit, which 3% slippage floors to 0
  const one = plant((r) => (same(r, "base-hook") ? out(r.amount === request("base-hook").amountIn ? 1n : 2n) : undefined));
  await refused(quote("base-hook", one, one), "no_quote");
});

test("Q11 a v4 two-hop route through the listed middle is held to every standard route", async () => {
  assert.equal(F["base-two-hop"]!.outcome.code, "below_reference");
  await refused(quote("base-two-hop"), "below_reference");
  // a v3 two-hop through USDC planted as the best: the v4 route is held to it too
  const v3best = plant((r) => (r.venue === "v3" && r.to.length === 2 && r.fees.join() === "100,100" ? out(r.amount) : undefined));
  await assert.rejects(quote("base-two-hop", v3best, v3best), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference");
    const r = e.reference?.route;
    assert.ok(r?.venue === "uniswap-v3" && r.tokens.length === 3 && r.fees.join() === "100,100", JSON.stringify(r));
    return true;
  });
});

test("Q12 a v3 two-hop route through the listed middle is held to every standard route", async () => {
  assert.equal(F["base-two-hop-v3"]!.outcome.code, "below_reference");
  await refused(quote("base-two-hop-v3"), "below_reference");
  const v4best = plant((r) => (r.venue === "v4" && r.to.length === 2 && r.fees.join() === "100,100" ? out(r.amount) : undefined));
  await assert.rejects(quote("base-two-hop-v3", v4best, v4best), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference");
    const r = e.reference?.route;
    assert.ok(r?.venue === "uniswap-v4" && r.hops.length === 2 && r.hops[0]!.fee === 100, JSON.stringify(r));
    return true;
  });
});

test("Q13 a token whose only pool sits behind a hook the device has not pinned refuses", async () => {
  assert.equal(F["base-unknown-hook"]!.outcome.code, "no_reference");
  // card evm-buy-hook-converge: its route through a hook the venue does not list is quoted (its sell leaves through it,
  // as the sale takes such a route), and refused as recorded: no pool but the route's own holds it (no_reference)
  await refused(quote("base-unknown-hook"), "no_reference");
  // a pinned launchpad pool is a reference: Clanker's pool for the Clanker token answers, so its route quotes
  assert.ok((await quote("base-hook")).reference !== null);
});

test("Q14 a block more than 30 s behind the device's clock refuses", async () => {
  const q = await quote("base-ok");
  await refused(quote("base-ok", undefined, undefined, Number(q.block.timestamp) * 1000 + 30_001), "stale_quote");
  // and a device clock that is no number
  await refused(quote("base-ok", undefined, undefined, Number.NaN), "bad_request");
});
