// node --test packages/kit/test/evm-sell-route-of.test.ts: evmSellRouteOf (src/trade/evm/sell-unpinned.ts, exported
// by the kit's index; card helper-evm-sender) reads a signed Sell's target and data back as the route the sell
// builder made, or refuses it: the helper's sell sender pays the gas of every call W signs, so it sends only a call
// the device's own builder would make. Each good case is the builder's own output read back; each refusal a change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EvmPoolSellError, evmPoolVenues, evmSellRouteOf, type EvmSignedSellCall } from "../src/index.ts";
import { evmPoolBuildSellUnpinned, type EvmPoolSellUnpinnedRequest } from "../src/trade/evm/sell-unpinned.ts";

const B = evmPoolVenues().base;
const BS = evmPoolVenues()["base-sepolia"];
const W = "0x00000000000000000000000000000000000a11ce";
const X = "0x0000000000000000000000000000000000007070";
const USDC = B.middles[0]!;
const NATIVE = "0x0000000000000000000000000000000000000000";
const CLANKER = B.hookedPools![0]!;
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof EvmPoolSellError ? e.code : `not-EvmPoolSellError: ${(e as Error).message}`;
  }
  return "ok";
};
const hop = (currency: string, o: Partial<{ fee: number; tickSpacing: number; hooks: string; hookData: string }> = {}) => ({ currency, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x", ...o });
const built = (chain: "base" | "base-sepolia", o: Partial<EvmPoolSellUnpinnedRequest>) =>
  evmPoolBuildSellUnpinned(chain, {
    w: W, token: X, amount: 10n ** 18n, target: B.routers[0]!, route: { venue: "uniswap-v3", tokens: [X, USDC, B.weth], fees: [500, 3000] }, minOut: 10n ** 15n,
    pool: "0x00000000000000000000000000000000b1f1f001", precommitment: 1n, feeCap: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: 0n, ...o,
  });
const call = (b: ReturnType<typeof built>): EvmSignedSellCall => ({ w: b.w, token: b.token, amount: b.amount, minOut: b.minOut, target: b.target, data: b.data });

test("evmSellRouteOf: the builder's own v3, v4 and hooked v4 sells read back to their routes", () => {
  const v3 = built("base", {});
  assert.deepEqual(evmSellRouteOf("base", call(v3)), { venue: "uniswap-v3", tokens: [X, USDC.toLowerCase(), B.weth.toLowerCase()], fees: [500, 3000] });
  const v4 = built("base", { target: B.poolManager!, route: { venue: "uniswap-v4", hops: [hop(NATIVE)] } });
  assert.deepEqual(evmSellRouteOf("base", call(v4)), { venue: "uniswap-v4", hops: [hop(NATIVE)] });
  const hooked = built("base", { target: B.poolManager!, route: { venue: "uniswap-v4", hops: [hop(B.weth.toLowerCase(), { fee: CLANKER.fee, tickSpacing: CLANKER.tickSpacing, hooks: CLANKER.hooks })] } });
  assert.equal(code(() => evmSellRouteOf("base", call(hooked))), "ok");
  // a target in any case
  assert.equal(code(() => evmSellRouteOf("base", { ...call(v3), target: v3.target.toUpperCase().replace("0X", "0x") })), "ok");
  const ts = built("base-sepolia", { target: BS.poolManager!, route: { venue: "uniswap-v4", hops: [hop(NATIVE)] } });
  assert.equal(code(() => evmSellRouteOf("base-sepolia", call(ts))), "ok");
});

test("evmSellRouteOf refuses: another target, a changed byte, a word more, a v3 call through the PoolManager, another recipient, amount or minOut, an unlisted hook, hook data", () => {
  const v3 = call(built("base", {}));
  const v4 = call(built("base", { target: B.poolManager!, route: { venue: "uniswap-v4", hops: [hop(NATIVE)] } }));
  const flip = (d: string, i: number) => `${d.slice(0, i)}${d[i] === "0" ? "1" : "0"}${d.slice(i + 1)}`;
  const cases: [string, EvmSignedSellCall, string][] = [
    ["a target that is neither (0x…dead, token 0x…deadbeef)", { ...v3, target: "0x000000000000000000000000000000000000dead", token: "0x00000000000000000000000000000000deadbeef", data: `0x${"ff".repeat(32)}` }, "bad_target"],
    ["a v4 path to a listed router", { ...v4, target: B.routers[0]! }, "bad_route"],
    ["a v3 call to the PoolManager", { ...v3, target: B.poolManager! }, "bad_route"],
    ["another chain's PoolManager", { ...v4, target: BS.poolManager! }, "bad_target"],
    ["v3: a word more", { ...v3, data: `${v3.data}${"00".repeat(32)}` }, "bad_route"],
    ["v3: the path's padding", { ...v3, data: flip(v3.data, v3.data.length - 1) }, "bad_route"],
    ["v3: another recipient", { ...v3, w: "0x00000000000000000000000000000000000b0b00" }, "bad_route"],
    ["v3: another amount", { ...v3, amount: v3.amount + 1n }, "bad_route"],
    ["v3: another minOut", { ...v3, minOut: v3.minOut - 1n }, "bad_route"],
    ["v3: another token", { ...v3, token: "0x0000000000000000000000000000000000007071" }, "token_mismatch"],
    ["v4: a word more", { ...v4, data: `${v4.data}${"00".repeat(32)}` }, "bad_route"],
    ["v4: the path's offset", { ...v4, data: flip(v4.data, 2 + 63) }, "bad_route"],
    ["v4: a fee over a u24", { ...v4, data: flip(v4.data, 2 + 64 * 4) }, "bad_route"],
    ["v4: a currency word with high bytes", { ...v4, data: flip(v4.data, 2 + 64 * 3) }, "bad_route"],
    ["v4: empty", { ...v4, data: "0x" }, "bad_route"],
  ];
  // a v4 path through an unlisted hook, or with hook data, as abi.encode writes it
  const w = (n: bigint | string) => (typeof n === "string" ? n.slice(2).toLowerCase().padStart(64, "0") : n.toString(16).padStart(64, "0"));
  const path = (hooks: string, hookData: string) => {
    const hd = hookData.slice(2);
    const padded = hd.padEnd(Math.ceil(hd.length / 64) * 64, "0");
    return `0x${w(0x20n)}${w(1n)}${w(0x20n)}${w(NATIVE)}${w(3000n)}${w(60n)}${w(hooks)}${w(0xa0n)}${w(BigInt(hd.length / 2))}${padded}`;
  };
  assert.equal(path(NATIVE, "0x"), v4.data, "the test's encoder is the builder's");
  cases.push(["v4: an unlisted hook", { ...v4, data: path("0x00000000000000000000000000000000000000cc", "0x") }, "bad_route"]);
  cases.push(["v4: hook data", { ...v4, data: path(NATIVE, "0x01") }, "bad_route"]);
  for (const [name, c, want] of cases) assert.equal(code(() => evmSellRouteOf("base", c)), want, name);
  assert.equal(code(() => evmSellRouteOf("nowhere" as "base", v3)), "bad_route", "a chain the kit does not list");
});
