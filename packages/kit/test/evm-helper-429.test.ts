// Card evm-helper-429-waits-its-retry-after: a 429 our own helper's /v1/rpc route answers holds that reader for its
// Retry-After (at least EVM_HELPER_HOLD_MIN_MS), never the 30 s provider hold; every other provider keeps its 30 s.
// The pool index's end-to-end case is H429 in evm-pool-index.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evmJsonRpc, evmProviders, evmRanked, evmRpcHeldMs, evmSpeedReset } from "../src/checks/evm/quote.ts";
import { evmPaceReset } from "../src/checks/evm/pace.ts";
import * as pace from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";

// read off the module, so this file still loads (and each test fails on its own) on a build without it
const evmHelperRoute = (pace as { evmHelperRoute?: (url: string) => boolean }).evmHelperRoute;

const HELPER = "https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=only";
const THIRD = "https://robinhood.drpc.org";
const answer429 = (retry: string | null) =>
  (async () => new Response("", { status: 429, headers: retry === null ? {} : { "retry-after": retry } })) as unknown as typeof fetch;
const call = [{ method: "eth_blockNumber", params: [] }] as const;
const fresh = () => {
  evmPaceReset();
  evmSpeedReset();
};

test("a 429 from our helper's route with Retry-After 2 holds it about 2 s, never 30 s", async () => {
  fresh();
  try {
    const rpc = evmJsonRpc(HELPER, answer429("2"));
    await assert.rejects(rpc(call), /429/);
    const held = evmRpcHeldMs(rpc);
    assert.ok(held > 1_000 && held <= 2_000, `the helper's route is held ${Math.round(held)} ms`);
  } finally {
    fresh();
  }
});

test("a 429 from our helper's route with no Retry-After, or 0, holds it the least hold, 1 s", async () => {
  for (const retry of [null, "0"]) {
    fresh();
    try {
      const rpc = evmJsonRpc(HELPER, answer429(retry));
      await assert.rejects(rpc(call), /429/);
      const held = evmRpcHeldMs(rpc);
      assert.ok(held > 0 && held <= 1_000, `${retry}: the helper's route is held ${Math.round(held)} ms`);
    } finally {
      fresh();
    }
  }
});

test("a third party's 429 with Retry-After 2 still holds it 30 s", async () => {
  fresh();
  try {
    const rpc = evmJsonRpc(THIRD, answer429("2"));
    await assert.rejects(rpc(call), /429/);
    const held = evmRpcHeldMs(rpc);
    assert.ok(held > 29_000 && held <= 30_000, `the third party is held ${Math.round(held)} ms`);
  } finally {
    fresh();
  }
});

test("a quote's providers: past the helper's Retry-After it is asked first again, the third party still held", { timeout: 10_000 }, async () => {
  fresh();
  try {
    const [third, helper] = evmProviders([THIRD, HELPER], answer429("2"));
    await assert.rejects(third!(call), /429/);
    await assert.rejects(helper!(call), /429/);
    assert.deepEqual(evmRanked([THIRD, HELPER]), [THIRD, HELPER], "both held, in the list's order");
    await new Promise((r) => setTimeout(r, 2_100));
    assert.deepEqual(evmRanked([THIRD, HELPER]), [HELPER, THIRD], "the helper's route is no longer held, the third party is");
  } finally {
    fresh();
  }
});

// The helper's origin, written once in the kit's EVM reads: pace.ts EVM_HELPER_ORIGIN. A quoted copy anywhere else
// under checks/evm/ or trade/evm/ (a reader URL written out again) is refused, so the route the venues give the kit and
// the route its hold rule names never drift apart. The sign page's TRADE_HELPER is held to it in its own test
// (packages/signpage/test/helper-origin-one.test.ts).
const ORIGIN_QUOTED = /["'`]https:\/\/ct-api\.unrealized\.trade(?=[/:"'`])/g;
const copiesIn = (src: string): number => (src.match(ORIGIN_QUOTED) ?? []).length;
test("the helper's origin is written once in the kit's EVM reads, in pace.ts; a copy put back is refused", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const files = ["checks/evm", "trade/evm"].flatMap((d) => readdirSync(src + d).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`));
  assert.ok(files.includes("trade/evm/buy-unpinned.ts") && files.includes("checks/evm/pace.ts"), files.join(", "));
  const found = files.map((f) => [f, copiesIn(readFileSync(src + f, "utf8"))] as const).filter(([, n]) => n > 0);
  assert.deepEqual(found, [["checks/evm/pace.ts", 1]]);
  // the plants: the reader written out again, single-quoted, with a port; the constant's own use is no copy
  assert.equal(copiesIn('readers: ["https://rpc.example", "https://ct-api.unrealized.trade/v1/rpc/robinhood?keyed=only"]'), 1);
  assert.equal(copiesIn("const h = 'https://ct-api.unrealized.trade';"), 1);
  assert.equal(copiesIn('"https://ct-api.unrealized.trade:443/v1/rpc/base"'), 1);
  assert.equal(copiesIn("`${EVM_HELPER_ORIGIN}/v1/rpc/robinhood?keyed=only`"), 0);
});

test("only our helper's own /v1/rpc route is the helper's: the venue's reader is, a lookalike is not", () => {
  assert.ok(evmHelperRoute, "pace.ts names the helper's route");
  const readers = evmPoolVenues().robinhood.index?.readers ?? assert.fail("robinhood: no index readers");
  assert.deepEqual(readers.map((u) => evmHelperRoute(u)), [false, true]);
  for (const u of [
    "https://ct-api.unrealized.trade.example.com/v1/rpc/robinhood",
    "https://example.com/ct-api.unrealized.trade/v1/rpc/robinhood",
    "http://ct-api.unrealized.trade/v1/rpc/robinhood",
    "https://ct-api.unrealized.trade/v1/quote",
    Object.assign(new URL(HELPER), { port: "8443" }).href,
    THIRD,
    "not a url",
  ])
    assert.equal(evmHelperRoute(u), false, u);
});
