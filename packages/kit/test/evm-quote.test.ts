// The device's EVM buy quote (src/checks/evm/quote.ts; card evm-pool-buy-quote) on the answers Base and Robinhood
// Chain mainnet gave two public providers, recorded by test/evm-quote-record.ts into fixtures/evm-quote.json. A planted
// case edits one recorded answer: a provider that lies, a quoter that reports a partial fill as complete, a hook that
// keeps more, a standard pool better than the route. test/evm-quote-mutants.mjs removes each check and runs the test
// named for it.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  EVM_NOOP_HOOK_CODE,
  evmPoolBuildQuoted,
  evmPoolBuyQuote,
  EvmPoolBuyError,
  EvmQuoteError,
  type EvmPoolBuyQuote,
  type EvmPoolBuyQuoteRequest,
  type EvmRpc,
  type EvmRpcCall,
} from "../src/index.ts";

type Answer = { result?: string; error?: { code: number; message: string; data?: string } } & Record<string, unknown>;
type Exchange = { calls: EvmRpcCall[]; answers: Answer[] };
type Case = { request: Record<string, unknown>; outcome: { code: string; detail: string }; exchanges: [Exchange[], Exchange[]] };
const F: Record<string, Case> = JSON.parse(readFileSync(new URL("./fixtures/evm-quote.json", import.meta.url), "utf8"));

/** The answers a provider gave to exactly these calls; `edit` changes a copy of them. */
type Edit = (answers: Answer[], calls: readonly EvmRpcCall[]) => void;
const replay = (ex: Exchange[], edit?: Edit): EvmRpc => async (calls) => {
  const e = ex.find((x) => JSON.stringify(x.calls) === JSON.stringify(calls));
  if (e === undefined) throw new Error("no recorded answer for these calls");
  const a = structuredClone(e.answers);
  if (edit !== undefined && calls[0]!.method === "eth_call") edit(a, calls);
  return a;
};
// the fixture keeps the request's token as "buys" (see evm-quote-record.ts)
const request = (name: string): EvmPoolBuyQuoteRequest => {
  const { buys, amountIn, ...rest } = F[name]!.request;
  return { ...(rest as Omit<EvmPoolBuyQuoteRequest, "token" | "amountIn">), token: buys as string, amountIn: BigInt(amountIn as string) };
};
const quote = (name: string, edit1?: Edit, edit2?: Edit): Promise<EvmPoolBuyQuote> =>
  evmPoolBuyQuote(request(name), [replay(F[name]!.exchanges[0], edit1), replay(F[name]!.exchanges[1], edit2)]);
const refused = async (p: Promise<unknown>, code: string) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError, `an EvmQuoteError, not ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
};

// The multicall's answer: (bool success, bytes returnData)[], read and written back
const W = (v: bigint) => v.toString(16).padStart(64, "0");
type El = { ok: boolean; data: string };
function decode(r: string): El[] {
  const h = r.slice(2);
  const at = (o: number) => Number(BigInt("0x" + h.slice(2 * o, 2 * o + 64)));
  const n = at(32);
  return Array.from({ length: n }, (_, i) => {
    const e = 64 + at(64 + 32 * i);
    const dl = at(e + 64);
    return { ok: at(e) === 1, data: h.slice(2 * (e + 96), 2 * (e + 96 + dl)) };
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
/** Edits read `i` of the multicall (the route at 0, at twice the amount at 1, then each standard pool at the amount and
 *  at twice it: v3 at fees 100, 500, 3000, 10000, then v4 at (100, 1), (500, 10), (3000, 60), (10000, 200)). */
const read = (i: number, f: (x: El) => El): Edit => (a) => {
  const els = decode(a[0]!.result!);
  els[i] = f(els[i]!);
  a[0]!.result = encode(els);
};
const outOf = (x: El) => BigInt("0x" + x.data.slice(0, 64));
const withOut = (x: El, v: bigint): El => ({ ok: true, data: W(v) + x.data.slice(64) });
const both = (...edits: Edit[]): Edit => (a, c) => edits.forEach((e) => e(a, c));

test("Q1 the device quotes a route both providers agree on, at one block hash", async () => {
  for (const name of ["base-ok", "robinhood-ok", "base-hook"]) {
    const q = await quote(name);
    const req = request(name);
    assert.equal(F[name]!.outcome.code, "ok");
    assert.ok(q.amountOut > 0n);
    assert.equal(q.minOut, (q.amountOut * BigInt(10000 - req.slippageBps)) / 10000n, `${name}: minOut from Q`);
    if (q.reference !== null) assert.ok(q.amountOut >= q.reference.amountOut, `${name}: Q at least R`);
    // every eth_call on both providers is at the block both hold, the lower of their heads
    const heads = F[name]!.exchanges.map((ex) => BigInt((ex[0]!.answers[0]!.result as unknown as { number: string }).number));
    assert.equal(q.block.number, heads[0]! <= heads[1]! ? heads[0] : heads[1]);
    for (const ex of F[name]!.exchanges) {
      for (const c of ex[1]!.calls) assert.deepEqual(c.params[1], { blockHash: q.block.hash, requireCanonical: true });
    }
  }
});

test("Q2 two providers that disagree refuse", async () => {
  // the route's quote, one more on provider 2
  await refused(quote("base-ok", undefined, read(0, (x) => withOut(x, outOf(x) + 1n))), "rpc_disagree");
  // the standard pool that is the reference, lower on provider 2 (it would hide the device's reference)
  await refused(quote("base-ok", undefined, read(2, (x) => withOut(x, outOf(x) - 1n))), "rpc_disagree");
  // provider 2 fakes a revert of a standard pool
  await refused(quote("base-ok", undefined, read(2, () => ({ ok: false, data: "" }))), "rpc_disagree");
  // the hookless read, more on provider 2
  await refused(
    quote("base-hook", undefined, (a) => {
      a[1]!.result = "0x" + W(BigInt(a[1]!.result!.slice(0, 66)) + 1n) + a[1]!.result!.slice(66);
    }),
    "rpc_disagree",
  );
  // a partial fill on one provider only
  await refused(
    quote("base-partial-v4", undefined, read(0, () => ({ ok: false, data: "" }))),
    "rpc_disagree",
  );
});

test("Q3 a partial-fill quote refuses", async () => {
  // V4Quoter's own refusal: 100 ETH into a pool that runs out (NotEnoughLiquidity, recorded)
  assert.equal(F["base-partial-v4"]!.outcome.code, "partial_fill");
  await refused(quote("base-partial-v4"), "partial_fill");
  // a quoter that reports a partial fill as complete (QuoterV2 does): twice the amount quotes no more, on both
  const same: Edit = (a) => {
    const els = decode(a[0]!.result!);
    els[1] = withOut(els[1]!, outOf(els[0]!));
    a[0]!.result = encode(els);
  };
  await refused(quote("base-ok", same, same), "partial_fill");
  const less: Edit = (a) => {
    const els = decode(a[0]!.result!);
    els[1] = withOut(els[1]!, outOf(els[0]!) - 1n);
    a[0]!.result = encode(els);
  };
  await refused(quote("robinhood-ok", less, less), "partial_fill");
  // a standard pool whose output does not grow with its input is no reference, though it quotes more than the route
  const ranOut = both(
    read(10, (x) => withOut(x, 10n ** 30n)),
    read(11, (x) => withOut(x, 10n ** 30n)),
  );
  const q = await quote("base-ok", ranOut, ranOut);
  assert.equal(q.reference?.route.venue, "uniswap-v3", "a standard pool whose output does not grow is not the reference");
});

test("Q4 a planted hook's take is shown and bounded by minOut", async () => {
  const q = await quote("base-hook");
  assert.ok(q.hook !== null && q.hook.hookless !== null && q.hook.take !== null);
  assert.equal(q.hook.take, q.hook.hookless - q.amountOut);
  assert.ok(q.hook.take > 0n, "the recorded hook keeps part of the buy");
  assert.equal(q.hook.takeBps, Number((q.hook.take * 10000n) / q.hook.hookless));
  // minOut comes from the route the hook runs in, so the hook cannot keep more than shown and the slippage
  assert.equal(q.minOut, (q.amountOut * 9700n) / 10000n);
  assert.ok(q.minOut < q.amountOut && q.amountOut < q.hook.hookless);
  // the hookless read is the same route with the hook's code replaced by the no-op hook
  const lone = F["base-hook"]!.exchanges[0]![1]!.calls[1]!;
  assert.deepEqual(lone.params[2], { "0xcd5198de17bd95f9c5cdaa761e61f0e569ee2444": { code: EVM_NOOP_HOOK_CODE } });
  // a planted hook that keeps more: the take grows, minOut stays the route's
  const more: Edit = (a) => {
    a[1]!.result = "0x" + W(BigInt(a[1]!.result!.slice(0, 66)) * 3n) + a[1]!.result!.slice(66);
  };
  const p = await quote("base-hook", more, more);
  assert.equal(p.hook!.take, p.hook!.hookless! - p.amountOut);
  assert.ok(p.hook!.takeBps! > 6000);
  assert.equal(p.minOut, q.minOut);
  // a hook that gives more than its pool: no take
  const less: Edit = (a) => {
    a[1]!.result = "0x" + W(1n) + a[1]!.result!.slice(66);
  };
  assert.equal((await quote("base-hook", less, less)).hook!.take, 0n);
  // a hookless read that reverts on both: the take is unknown, the quote stands
  const gone: Edit = (a) => {
    a[1] = { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } };
  };
  const u = await quote("base-hook", gone, gone);
  assert.deepEqual(u.hook, { hookless: null, take: null, takeBps: null });
  // a route with no hooked hop has no take
  assert.equal((await quote("base-ok")).hook, null);
});

test("Q5 a helper route below the device's standard-pool reference refuses", async () => {
  assert.equal(F["base-below"]!.outcome.code, "below_reference");
  await assert.rejects(quote("base-below"), (e: unknown) => {
    assert.ok(e instanceof EvmQuoteError && e.code === "below_reference");
    assert.deepEqual(e.reference?.route, { venue: "uniswap-v3", tokens: ["0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], fees: [100] });
    return true;
  });
  // a standard v4 pool one unit better than the route, on both providers
  const Q = (await quote("base-ok")).amountOut;
  const better = both(read(10, (x) => withOut(x, Q + 1n)), read(11, (x) => withOut(x, 2n * Q)));
  await refused(quote("base-ok", better, better), "below_reference");
});

test("Q6 the Robinhood native-first rule picks native", async () => {
  for (const name of ["robinhood-weth-v4", "robinhood-weth-v3"]) {
    assert.equal(F[name]!.outcome.code, "native_first");
    await assert.rejects(quote(name), (e: unknown) => {
      assert.ok(e instanceof EvmQuoteError && e.code === "native_first", String(e));
      const r = e.reference?.route;
      assert.ok(r?.venue === "uniswap-v4" && r.currencyIn === "0x0000000000000000000000000000000000000000", "the device's own route starts native");
      return true;
    });
  }
  // the native route quotes
  const q = await quote("robinhood-ok");
  assert.ok(q.route.venue === "uniswap-v4" && q.route.currencyIn === "0x0000000000000000000000000000000000000000");
  // with no native pool answering, a WETH route is no longer refused for its start (v4 reads 10 to 17 revert)
  const noNative: Edit = (a) => {
    const els = decode(a[0]!.result!);
    for (let i = 10; i < 18; i++) els[i] = { ok: false, data: "" };
    a[0]!.result = encode(els);
  };
  const w = await quote("robinhood-weth-v3", noNative, noNative);
  assert.ok(w.route.venue === "uniswap-v3", "the WETH route quotes when no native pool answers");
});

test("Q7 only a quote the device made builds a buy", async () => {
  const q = await quote("base-ok");
  assert.throws(() => evmPoolBuildQuoted("0x0000000000000000000000000000000000000001", { ...q }), (e: unknown) => e instanceof EvmQuoteError && e.code === "bad_request");
  assert.throws(() => evmPoolBuildQuoted("0x0000000000000000000000000000000000000001", { ...q, minOut: 1n }), (e: unknown) => e instanceof EvmQuoteError);
  // the device's quote passes to the pinned builder, which refuses Base until pool-evm-deploy pins its adapters
  assert.throws(() => evmPoolBuildQuoted("0x0000000000000000000000000000000000000001", q), (e: unknown) => e instanceof EvmPoolBuyError && e.code === "not_deployed");
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.route));
});

test("Q8 a bad request refuses before any read", async () => {
  const none: EvmRpc = async () => assert.fail("no read");
  const other: EvmRpc = async () => assert.fail("no read");
  const r = request("base-ok");
  for (const [bad, code] of [
    [{ ...r, amountIn: 0n }, "bad_request"],
    [{ ...r, amountIn: 1n << 127n }, "bad_request"],
    [{ ...r, slippageBps: 10000 }, "bad_request"],
    [{ ...r, slippageBps: -1 }, "bad_request"],
    [{ ...r, slippageBps: 1.5 }, "bad_request"],
    [{ ...r, token: "0x4200000000000000000000000000000000000006" }, "token_mismatch"],
  ] as const) {
    await refused(evmPoolBuyQuote(bad as EvmPoolBuyQuoteRequest, [none, other]), code);
  }
  await refused(evmPoolBuyQuote(r, [none, none]), "bad_request");
  await refused(evmPoolBuyQuote({ ...r, chain: "base-sepolia" }, [none, other]), "no_quoter");
});

test("Q9 a provider error or a malformed answer refuses", async () => {
  const limited: Edit = (a) => {
    a[0] = { jsonrpc: "2.0", id: 0, error: { code: -32007, message: "25/second request limit reached" } };
  };
  await refused(quote("base-ok", undefined, limited), "rpc_error");
  const short: Edit = (a) => {
    a[0]!.result = a[0]!.result!.slice(0, 2 + 64 * 3);
  };
  await refused(quote("base-ok", short, undefined), "rpc_error");
  const outside: Edit = (a) => {
    a[0]!.result = "0x" + W(0x20n) + W(1n) + W(1n << 200n);
  };
  await refused(quote("base-ok", outside, outside), "rpc_error");
  const down: EvmRpc = async () => {
    throw new Error("offline");
  };
  await refused(evmPoolBuyQuote(request("base-ok"), [replay(F["base-ok"]!.exchanges[0]), down]), "rpc_error");
});
