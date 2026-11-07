// node --test packages/kit/test/evm-buy-route-of.test.ts: evmBuyRouteOf (src/trade/evm/buy-unpinned.ts, exported by the
// kit's index; card helper-evm-sender-2) reads a signed Buy's adapter and data back as the route the device's builder
// made, or refuses it: the helper's sender pays the gas of every buy W signs, so it sends only a buy through a pinned
// adapter along a route the device's own builder would make. Each good case is the builder's own output read back
// (pinnedBuildQuoted, what evmPoolBuildQuoted runs); each refusal one change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EvmPoolBuyError, evmBuyRouteOf, evmPoolRouteData, evmPoolVenues, type EvmSignedBuy } from "../src/index.ts";
import { pinnedBuildQuoted, type EvmRoute } from "../src/trade/evm/buy-unpinned.ts";

const BS = evmPoolVenues()["base-sepolia"];
const RT = evmPoolVenues()["robinhood-testnet"];
const NATIVE = "0x0000000000000000000000000000000000000000";
const X = "0x0000000000000000000000000000000000007070";
const MID = "0x000000000000000000000000000000000000b1d0"; // on no venue list: a quoted v4 route may pass through it
const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof EvmPoolBuyError ? e.code : `not-EvmPoolBuyError: ${(e as Error).message}`;
  }
  return "ok";
};
const hop = (currency: string) => ({ currency, fee: 3000, tickSpacing: 60, hooks: NATIVE, hookData: "0x" });
const v3: EvmRoute = { venue: "uniswap-v3", tokens: [BS.weth, X], fees: [500] };
const v4: EvmRoute = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [hop(MID), hop(X)] };
const signed = (chain: "base-sepolia" | "robinhood-testnet", adapter: string, route: EvmRoute): EvmSignedBuy => {
  const b = pinnedBuildQuoted(evmPoolVenues(), chain, adapter, route, 10n ** 6n, X);
  return { adapter: b.adapter, data: b.data, minOut: b.minOut, token: b.token };
};

test("evmBuyRouteOf: the device's own quoted v3 and v4 buys read back to their routes, byte for byte", () => {
  assert.deepEqual(evmBuyRouteOf("base-sepolia", signed("base-sepolia", BS.adapters!.v3!, v3)), { venue: "uniswap-v3", tokens: [BS.weth.toLowerCase(), X], fees: [500] });
  assert.deepEqual(evmBuyRouteOf("base-sepolia", signed("base-sepolia", BS.adapters!.v4!, v4)), v4);
  assert.deepEqual(evmBuyRouteOf("robinhood-testnet", signed("robinhood-testnet", RT.adapters!.v4!, v4)), v4);
  // the adapter in any case
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...signed("base-sepolia", BS.adapters!.v4!, v4), adapter: BS.adapters!.v4!.toUpperCase().replace("0X", "0x") })), "ok");
  // the non-quoted encoder the index also exports refuses the unlisted middle: a re-encode through it would refuse this
  assert.equal(code(() => evmPoolRouteData("base-sepolia", v4)), "middle_not_listed");
});

test("evmBuyRouteOf refuses a foreign adapter, the other venue's adapter, another chain's adapter, another token, one changed byte", () => {
  const good4 = signed("base-sepolia", BS.adapters!.v4!, v4);
  const good3 = signed("base-sepolia", BS.adapters!.v3!, v3);
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good4, adapter: "0x5b6ee2e1c3ec4c6e5bb1d1b4b0f4b8b9d8c2a1f0" })), "not_pinned");
  // another chain's pinned adapter is foreign here
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good4, adapter: RT.adapters!.v4! })), "not_pinned");
  // the v3 adapter with v4 data, and the v4 adapter with v3 data
  assert.notEqual(code(() => evmBuyRouteOf("base-sepolia", { ...good4, adapter: BS.adapters!.v3! })), "ok");
  assert.notEqual(code(() => evmBuyRouteOf("base-sepolia", { ...good3, adapter: BS.adapters!.v4! })), "ok");
  // Base mainnet's pins (card pool-evm-deploy-mainnet; every chain the kit lists pins its adapters now): Base Sepolia's
  // adapter is foreign there
  assert.equal(code(() => evmBuyRouteOf("base", good4)), "not_pinned");
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good4, token: MID })), "token_mismatch");
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good3, token: BS.weth })), "token_mismatch");
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good4, minOut: 0n })), "bad_amount");
  // every byte of the data, changed one at a time: refused, or read back as another route (a fee, a tick spacing, a
  // hook or a middle W signed), never as the same one; the bytes no route holds (an offset, a length, a padding) refused
  const flip = (data: string, i: number) => `${data.slice(0, 2 + 2 * i)}${(parseInt(data.slice(2 + 2 * i, 4 + 2 * i), 16) ^ 0x01).toString(16).padStart(2, "0")}${data.slice(4 + 2 * i)}`;
  for (const g of [good3, good4]) {
    const was = evmBuyRouteOf("base-sepolia", g);
    const n = (g.data.length - 2) / 2;
    for (let i = 0; i < n; i++) {
      let same = false;
      try {
        same = JSON.stringify(evmBuyRouteOf("base-sepolia", { ...g, data: flip(g.data, i) })) === JSON.stringify(was);
      } catch (e) {
        assert.ok(e instanceof EvmPoolBuyError, `byte ${i}: ${(e as Error).message}`);
      }
      assert.equal(same, false, `byte ${i} of ${g.adapter} reads back as the same route`);
    }
    // a trailing byte or word, one byte short
    for (const data of [`${g.data}00`, `${g.data}${"00".repeat(32)}`, g.data.slice(0, -2)]) assert.notEqual(code(() => evmBuyRouteOf("base-sepolia", { ...g, data })), "ok");
  }
  // v4's structural words: currencyIn's padding, the path's offset (0x40), its length, a hop's offset, a hook data offset
  // (0xa0) and length, each refused
  for (const byte of [0, 63, 64 + 31, 96 + 31, 128 + 31, 160 + 4 * 32 + 31, 160 + 5 * 32 + 31]) assert.notEqual(code(() => evmBuyRouteOf("base-sepolia", { ...good4, data: flip(good4.data, byte) })), "ok", `v4 byte ${byte}`);
  // hook data the device never makes
  const hooked = { venue: "uniswap-v4", currencyIn: NATIVE, hops: [{ ...hop(X), hookData: "0xab" }] } as const;
  assert.equal(code(() => evmBuyRouteOf("base-sepolia", { ...good4, data: `0x${Buffer.from(evmPoolRouteData("base-sepolia", hooked).data).toString("hex")}` })), "bad_route");
});
