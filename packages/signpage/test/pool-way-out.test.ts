// The one rule (card evm-deposit-on-mainnet, src/pool-testnet.ts poolWayOut): a pool's deposit address, its deposit and
// its every trade open only on a chain whose withdraw is in the same build. A build planted with no withdraw on a chain
// refuses that chain's deposit, deposit from U, buy and sell not_allowed and reaches no runner; and on this build the
// rule's table says exactly where pool.withdraw reaches the page's withdraw screen, so main.ts's deposit addresses
// (pageAddressPools, the same rule) are never offered where the page cannot take the money out.
//   node --test test/pool-way-out.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { EvmRpc } from "../../wallet/src/pool/evm.ts";

const BC = globalThis.BroadcastChannel;
(globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};
const { testnetPool, poolWayOut, POOL_WITHDRAW_BUILT } = await import("../src/pool-testnet.ts");
const { SOL_POOLS } = await import("../../wallet/src/pool/solana.ts");
type Ask = import("../src/rules/pool.ts").PoolAsk;

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const ctx = { id: "r1", sha: "00", progress: () => {} };
const stores: WalletStore[] = [];
after(() => stores.forEach((s) => s.close()));
const store = async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  stores.push(w);
  return w;
};
const TOKENS = { solana: "So11111111111111111111111111111111111111112", base: "0xF111111111111111111111111111111111111111", robinhood: "0xF111111111111111111111111111111111111111" } as const;
const asks = (chain: "solana" | "base" | "robinhood"): Ask[] => {
  const d = chain === "solana" ? 9 : 18;
  return [
    { kind: "pool.deposit", chain, token: null, amount: 10n ** 15n, slippageBps: 0, decimals: d },
    { kind: "pool.buy", chain, token: TOKENS[chain], amount: 10n ** 15n, slippageBps: 100, decimals: d },
    { kind: "pool.sell", chain, token: TOKENS[chain], amount: 10n ** 6n, slippageBps: 100, decimals: 6 },
  ];
};
/** A page whose every runner and read is recorded: the Solana and EVM deposit, buy and sale kinds, every RPC call and
 *  the withdraw screen. */
function world(withdrawBuilt?: Readonly<Partial<Record<"solana" | "base" | "robinhood", boolean>>>) {
  const ran: string[] = [];
  const read: string[] = [];
  const evm = (url: string): EvmRpc => Object.assign(async (m: string) => (read.push(`${url} ${m}`), assert.fail(`no read: ${m}`)), { url });
  const sol = (url: string) => Object.assign(async (m: string) => (read.push(`${url} ${m}`), assert.fail(`no read: ${m}`)), { url });
  const kind = (name: string) => () => () => (ran.push(name), { error: "not_allowed" as const });
  const t = testnetPool(
    { store, seed64: async () => SEED.slice(), openWithdraw: (c: string) => (ran.push(`withdraw ${c}`), { running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent" } }) }) as never },
    {
      ...(withdrawBuilt ? { withdrawBuilt } : {}),
      pin: SOL_POOLS.mainnet!,
      rpcs: [sol("https://s1.example"), sol("https://s2.example")] as never,
      tables: { "pump-curve": ["11111111111111111111111111111111"] },
      evmRpcs: () => [evm("https://a.example"), evm("https://b.example")],
      evmRound: () => async () => (ran.push("round"), { events: [], finalBlock: 100n }),
      evmSync: () => ({ events: async () => assert.fail("no sync read") }),
      depositKinds: { solana: kind("deposit solana") as never, evm: kind("deposit evm") as never },
      tradeKinds: { buy: kind("buy solana") as never, sell: kind("sell solana") as never, evmBuy: kind("buy evm") as never, evmSell: kind("sell evm") as never },
    },
  );
  return { t, ran, read };
}

test("a build with no withdraw on a chain refuses its deposit, a deposit from U, its buy and its sale not_allowed: no runner reached, nothing read", async () => {
  for (const chain of ["solana", "base", "robinhood"] as const) {
    const { t, ran, read } = world({ [chain]: false });
    for (const ask of asks(chain)) assert.deepEqual(t.flow(ask, ctx), { error: "not_allowed" }, `${chain}: ${ask.kind} refused`);
    assert.deepEqual(t.depositFrom({ chain, token: null, amount: "0.001", slippage_bps: 0 }, { s: "1", i: 0, u: "x" } as never, ctx), { error: "not_allowed" }, `${chain}: a deposit from U refused`);
    assert.deepEqual(t.flow({ kind: "pool.withdraw", chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, ctx), { error: "not_allowed" }, `${chain}: no withdraw in the build`);
    assert.deepEqual(ran, [], `${chain}: no runner reached`);
    assert.deepEqual(read, [], `${chain}: nothing read`);
    await t.signedOut();
  }
});

test("Solana's withdraw is in this build and its deposit runs (the plant above is what refuses it)", async () => {
  const { t, ran } = world();
  t.flow(asks("solana")[0]!, ctx);
  assert.deepEqual(ran, ["deposit solana"]);
  await t.signedOut();
});

test("this build's rule is its withdraw: for each pool chain, poolWayOut says exactly whether pool.withdraw reaches the page's withdraw screen", async () => {
  for (const chain of ["solana", "base", "robinhood"] as const) {
    const { t, ran } = world();
    const got = t.flow({ kind: "pool.withdraw", chain, token: null, amount: 0n, slippageBps: 0, decimals: 18 }, ctx);
    const reached = ran.includes(`withdraw ${chain}`);
    assert.equal(reached, poolWayOut(chain), `${chain}: the withdraw screen ${reached ? "opens" : "is refused"} (${JSON.stringify(got)}), the rule says ${poolWayOut(chain)}`);
    assert.equal(poolWayOut(chain), POOL_WITHDRAW_BUILT[chain]);
    await t.signedOut();
  }
});
