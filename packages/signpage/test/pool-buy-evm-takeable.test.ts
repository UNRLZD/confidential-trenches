// node --test packages/signpage/test/pool-buy-evm-takeable.test.ts: the EVM buy's pick reads the queue's ready list
// through its host (src/pool-buy-evm.ts evmBuyHost), which offers only what the take hands out (card
// buy-spends-several-pieces, packages/wallet/src/pool/queue.ts proofLate): a newest-root proof past its epoch + 15 s,
// its remake not done, is never handed to the pick, so the buy is never built on a proof its take then refuses. The
// queue runs on the wallet's fixture vault (the all-zero test seed); the prover answers the signals without proving.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { EvmPoolPin, EvmPoolRequest } from "../../wallet/src/pool/evm.ts";
import type { ProofQueue } from "../../wallet/src/pool/queue.ts";
import type { WalletStore } from "@blindfill/wallet/store";
import { closeVaults } from "../../wallet/test/withdraw-fixture.ts";
import { E, START, lateSetup } from "../../wallet/test/queue-late-fixture.ts";
import { evmBuyHost, type EvmBuyPage } from "../src/pool-buy-evm.ts";

after(closeVaults);

test("EVM host: the pick's ready list leaves out a newest-root proof past the boundary + 15 s while its remake runs; the rested one stays", async () => {
  const { pool, q, fresh, clock, shut, open } = await lateSetup(undefined, "evm");
  const page: EvmBuyPage = {
    queue: async () => q as unknown as ProofQueue<EvmPoolRequest>,
    seed64: async () => new Uint8Array(64),
    held: async () => ({}) as WalletStore,
    settle: () => {},
    marks: async () => new Map(),
    testnet: false,
  };
  const host = evmBuyHost("base", {} as EvmPoolPin, [async () => null, async () => null], new Set(), page);
  assert.ok((await host.ready()).some((r) => r.noteId === fresh.id && r.root === "newest"), "the fresh note's newest-root proof is offered in its own epoch");
  shut();
  pool.t.now = START + E + 1_000n;
  const pass = q.refresh();
  try {
    for (let k = 0; k < 50; k++) await new Promise((ok) => setTimeout(ok, 1));
    clock.ms += 15_000;
    pool.t.now = START + E + 16_000n;
    const list = await host.ready();
    assert.ok(!list.some((r) => r.noteId === fresh.id && r.root === "newest"), "the EVM pick is offered a proof its take refuses late");
    assert.equal(list.filter((r) => r.noteId !== fresh.id).length, 1, "the rested note's proof stays");
  } finally {
    open();
    await pass.catch(() => {});
    await q.close();
  }
});
