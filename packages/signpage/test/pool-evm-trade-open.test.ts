// SIGN_HOST's build (this test sets no network: POOL_TESTNET is false) opens the EVM pool buy on each chain whose
// withdraw is in the same build (src/pool-testnet.ts poolWayOut), with no other gate: a refused buy's ETH on W goes back
// into the pool by the chain's carry (src/pool-carry-evm.ts), so nothing a buy leaves needs a testnet build.
//   node --test test/pool-evm-trade-open.test.ts      (from packages/signpage)
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
const { testnetPool } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
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
const TOKEN = "0xF111111111111111111111111111111111111111";
const trades = (chain: "base" | "robinhood"): Ask[] => [
  { kind: "pool.buy", chain, token: TOKEN, amount: 10n ** 15n, slippageBps: 100, decimals: 18 },
  { kind: "pool.sell", chain, token: TOKEN, amount: 10n ** 6n, slippageBps: 100, decimals: 6 },
];
function world(withdrawBuilt: Readonly<Partial<Record<"solana" | "base" | "robinhood", boolean>>>) {
  const ran: string[] = [];
  const evm = (url: string): EvmRpc => Object.assign(async (m: string) => assert.fail(`no read: ${m}`), { url });
  const kind = (name: string) => () => () => (ran.push(name), { error: "not_allowed" as const });
  const t = testnetPool(
    { store, seed64: async () => SEED.slice() },
    {
      withdrawBuilt,
      evmRpcs: () => [evm("https://a.example"), evm("https://b.example")],
      evmRound: () => async () => ({ events: [], finalBlock: 100n }),
      evmSync: () => ({ events: async () => assert.fail("no sync read") }),
      tradeKinds: { buy: kind("buy solana") as never, sell: kind("sell solana") as never, evmBuy: kind("buy evm") as never, evmSell: kind("sell evm") as never },
    } as Parameters<typeof testnetPool>[1],
  );
  return { t, ran };
}

test("SIGN_HOST's build: the EVM buy reaches its runner on a chain whose withdraw is built, and nowhere else", async () => {
  assert.equal(POOL_TESTNET, false, "this test runs SIGN_HOST's build");
  for (const chain of ["base", "robinhood"] as const) {
    const open = world({ [chain]: true });
    open.t.flow(trades(chain)[0]!, ctx);
    assert.deepEqual(open.ran, ["buy evm"], `${chain}: the buy runs`);
    await open.t.signedOut();
    const shut = world({ [chain]: false });
    assert.deepEqual(shut.t.flow(trades(chain)[0]!, ctx), { error: "not_allowed" });
    assert.deepEqual(shut.ran, [], `${chain}: no withdraw built, no buy`);
    await shut.t.signedOut();
  }
});
