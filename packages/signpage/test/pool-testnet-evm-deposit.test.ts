// The testnet flow's EVM pool.deposit (card pool-deposits, slice 3): src/pool-testnet.ts routes a Base or Robinhood
// pool.deposit to src/pool-deposit-evm.ts only when that chain's EVM pin exists on the page's network; with none (the
// wallet's EVM_POOLS is empty today) it is refused not_allowed and nothing is read.
//   node --test test/pool-testnet-evm-deposit.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import type { EvmPoolPin, EvmRpc } from "../../wallet/src/pool/evm.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_POOLS } = await import("../../wallet/src/pool/evm.ts");
type Ask = import("../src/rules/pool.ts").PoolAsk;

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000f0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const ASK: Ask = { kind: "pool.deposit", chain: "base", token: null, amount: 10n ** 15n, slippageBps: 0, decimals: 18 };
const ctx = { id: "r1", sha: "00", progress: () => {} };
const stores: WalletStore[] = [];
after(() => stores.forEach((s) => s.close()));
const page = () => ({
  store: async () => {
    const w = await openWalletStore({ indexedDB: new IDBFactory() });
    stores.push(w);
    return w;
  },
  seed64: async () => SEED.slice(),
});
/** Two RPCs over an empty U: a block, U's nonce 0 and balance 0, and the calls each was asked. */
function rpcs() {
  const calls: string[] = [];
  const rpc: EvmRpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0xf4240" };
    if (method === "eth_getTransactionCount" || method === "eth_getBalance") return "0x0";
    if (method === "eth_call") return "0x" + "0".repeat(64);
    throw new Error(`unmocked ${method} ${JSON.stringify(params)}`);
  };
  return { calls, pair: [rpc, rpc] as const };
}

test("with the chain's EVM pin, an EVM pool.deposit reaches the EVM deposit runner (its reads made, an empty U answered not_funded)", async () => {
  const r = rpcs();
  let rounds = 0;
  const flow = testnetPool(page(), { evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: () => r.pair, evmRound: () => async () => (rounds++, { events: [], finalBlock: 100n }) }).flow;
  const run = flow(ASK, ctx) as { running: true; after: Promise<void>; answer(): unknown };
  assert.equal(run.running, true, "a run of the runner");
  await run.after;
  assert.deepEqual(run.answer(), { error: "not_funded" });
  assert.ok(rounds > 0 && r.calls.includes("eth_getBalance"), "the runner read the pool and U");
  // Robinhood has no pin here: refused, nothing read
  const before = r.calls.length;
  assert.deepEqual(flow({ ...ASK, chain: "robinhood" }, ctx), { error: "not_allowed" });
  assert.equal(r.calls.length, before);
});

test("without the chain's EVM pin (the page's EVM_POOLS today), an EVM pool.deposit is refused not_allowed and nothing is read", async () => {
  assert.deepEqual({ ...EVM_POOLS }, {}, "no EVM pool pinned yet");
  const r = rpcs();
  const flow = testnetPool(page(), { evmRpcs: () => r.pair }).flow;
  for (const chain of ["base", "robinhood"] as const) assert.deepEqual(flow({ ...ASK, chain }, ctx), { error: "not_allowed" });
  assert.deepEqual(r.calls, []);
  // the other EVM kinds stay refused
  assert.deepEqual(flow({ ...ASK, kind: "pool.buy", token: "0xF111111111111111111111111111111111111111", slippageBps: 100 }, ctx), { error: "not_allowed" });
});

test("an EVM note left INCOMING settles with no request: on the signed-in load (settle) and on a state read (stateRead), never waiting for an ask", async () => {
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const { noteCommitment, noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
  const { evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
  const { vaultLabelOf } = await import("../../kit/src/vault/shapes.ts");
  const scope = evmPoolScopeOf(PIN.pool, 84532n);
  for (const pass of ["settle", "stateRead"] as const) {
    const idb = new IDBFactory();
    const store = async () => {
      const w = await openWalletStore({ indexedDB: idb });
      stores.push(w);
      return w;
    };
    const ns = await openNoteStore(await store());
    const n = await ns.planDeposit(scope, (ref) => noteSecrets(SEED, ref).precommitment);
    await ns.move(n.id, "PLANNED", "INCOMING", { evmSend: { hash: "0x" + "ab".repeat(32), nonce: 0n, value: ASK.amount, sentMs: 1n } });
    ns.close();
    // its Deposited, final on both RPCs
    const label = vaultLabelOf(keccak_256, scope, 1n);
    const events = [{ block: 50n, blockHash: `0x${"ab".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit", state: noteCommitment(ASK.amount, label, n.precommitment), label, value: ASK.amount, precommitment: n.precommitment, nullifier: null, recipient: null, token: null }];
    const r = rpcs();
    const t = testnetPool({ store, seed64: async () => SEED.slice() }, { evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: () => r.pair, evmRound: () => async () => ({ events: events as never, finalBlock: 100n }) });
    await t[pass]();
    const back = await openNoteStore(await store());
    const now = await back.get(n.id);
    back.close();
    assert.equal(now!.state, "UNSPENT", `${pass}: settled`);
    assert.equal(now!.leaf!.value, ASK.amount, pass);
  }
});

test("a load's EVM pass that meets a take not final yet (EvmNotFinalError) ends the settle, with no unhandled rejection on the page", async () => {
  const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const { noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
  const { evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
  const { EvmNotFinalError } = await import("../../wallet/src/pool/evm-restore.ts");
  const scope = evmPoolScopeOf(PIN.pool, 84532n);
  const idb = new IDBFactory();
  const store = async () => {
    const w = await openWalletStore({ indexedDB: idb });
    stores.push(w);
    return w;
  };
  const ns = await openNoteStore(await store());
  const n = await ns.planDeposit(scope, (ref) => noteSecrets(SEED, ref).precommitment);
  await ns.move(n.id, "PLANNED", "INCOMING", { evmSend: { hash: "0x" + "ab".repeat(32), nonce: 0n, value: ASK.amount, sentMs: 1n } });
  ns.close();
  const unhandled: unknown[] = [];
  const on = (e: unknown) => void unhandled.push(e);
  process.on("unhandledRejection", on);
  try {
    const r = rpcs();
    const t = testnetPool({ store, seed64: async () => SEED.slice() }, { evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: () => r.pair, evmRound: () => async () => Promise.reject(new EvmNotFinalError("a take not final yet")) });
    await t.settle();
    await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    process.off("unhandledRejection", on);
  }
  assert.deepEqual(unhandled, [], "no unhandled rejection");
  const back = await openNoteStore(await store());
  assert.equal((await back.get(n.id))!.state, "INCOMING", "left open for the next load");
  back.close();
});
