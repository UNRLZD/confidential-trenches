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
/** Two RPCs (two providers: the page's deposit reads them as one evmPair, which refuses one provider twice) over an
 *  empty U: a block, U's nonce 0 and balance 0, and the calls both were asked. */
function rpcs() {
  const calls: string[] = [];
  const rpc = (url: string): EvmRpc => Object.assign(async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: `0x${"11".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0xf4240" };
    if (method === "eth_getTransactionCount" || method === "eth_getBalance") return "0x0";
    if (method === "eth_call") return "0x" + "0".repeat(64);
    throw new Error(`unmocked ${method} ${JSON.stringify(params)}`);
  }, { url });
  return { calls, pair: [rpc("https://a.example"), rpc("https://b.example")] as const };
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

test("pool-deposit-sent-end fold review 3: the page wires each deposit kind's host to its sign-out signal and its pass: a sign out aborts every follow's signal (a host made after it gets a live one), and a follow's settle starts the chain's pass", async () => {
  type SolHost = import("../src/pool-deposit.ts").PoolDepositHost;
  type EvmHost = import("../src/pool-deposit-evm.ts").PoolDepositEvmHost;
  const sol: { host: () => SolHost; ask: unknown }[] = [];
  const evm: { host: () => EvmHost; ask: unknown }[] = [];
  const refuse = { error: "not_allowed" } as const;
  const r = rpcs();
  const t = testnetPool(page(), {
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: () => r.pair,
    evmRound: () => async () => ({ events: [], finalBlock: 100n }),
    depositKinds: {
      solana: (host) => (ask) => (sol.push({ host, ask }), refuse),
      evm: (host) => (ask) => (evm.push({ host, ask }), refuse),
    },
  });
  t.flow({ ...ASK, chain: "solana", decimals: 9, amount: 10_000_000n }, ctx);
  t.flow(ASK, ctx);
  assert.equal(sol.length, 1, "the Solana ask reached its kind");
  assert.equal(evm.length, 1, "the Base ask reached its kind");
  const hs = sol[0]!.host();
  const he = evm[0]!.host();
  // the pass: each follow's settle starts its chain's pass (a run of the kind with no ask)
  hs.settle?.();
  he.settle?.();
  assert.deepEqual(sol.slice(1).map((x) => x.ask), [null], "the Solana follow's settle started the Solana pass");
  assert.deepEqual(evm.slice(1).map((x) => x.ask), [null], "the Base follow's settle started the Base pass");
  // the sign out: every follow's signal aborted
  assert.equal(hs.signal?.aborted, false);
  assert.equal(he.signal?.aborted, false);
  await t.signedOut();
  assert.equal(hs.signal?.aborted, true, "the Solana follow stops at sign out");
  assert.equal(he.signal?.aborted, true, "the Base follow stops at sign out");
  assert.equal(sol[0]!.host().signal?.aborted, false, "a follow after the next sign in reads on");
  assert.equal(evm[0]!.host().signal?.aborted, false);
});

test("pool-deposit-sent-end low 3: the page's deposit hosts read the notes read only (records): a record written to the page's store is returned, and no note store opens (no notes lock asked)", async () => {
  type SolHost = import("../src/pool-deposit.ts").PoolDepositHost;
  type EvmHost = import("../src/pool-deposit-evm.ts").PoolDepositEvmHost;
  const { NOTES_LOCK, openNoteStore } = await import("../../wallet/src/notes/store.ts");
  const idb = new IDBFactory();
  const store = async () => {
    const w = await openWalletStore({ indexedDB: idb });
    stores.push(w);
    return w;
  };
  // a note in the page's store (the record a pass rebuilt or restored, as the end's reads must see it)
  const ns = await openNoteStore(await store());
  const n = await ns.planDeposit(123n, () => 456n);
  ns.close();
  const sol: (() => SolHost)[] = [];
  const evm: (() => EvmHost)[] = [];
  const r = rpcs();
  const t = testnetPool({ store, seed64: async () => SEED.slice() }, {
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: () => r.pair,
    evmRound: () => async () => ({ events: [], finalBlock: 100n }),
    depositKinds: {
      solana: (host) => () => (sol.push(host), { error: "not_allowed" }),
      evm: (host) => () => (evm.push(host), { error: "not_allowed" }),
    },
  });
  t.flow({ ...ASK, chain: "solana", decimals: 9, amount: 10_000_000n }, ctx);
  t.flow(ASK, ctx);
  const locks = navigator.locks;
  const asked: string[] = [];
  const request = locks.request;
  locks.request = function (this: LockManager, name: string, ...rest: unknown[]) {
    asked.push(name);
    return (request as (...a: unknown[]) => Promise<unknown>).call(locks, name, ...rest);
  } as typeof locks.request;
  try {
    for (const [what, host] of [["Solana", sol[0]!], ["Base", evm[0]!]] as const) {
      const got = await host().records();
      assert.deepEqual(got.map((x) => [x.id, x.precommitment]), [[n.id, 456n]], `the ${what} host's records read the page's store`);
    }
  } finally {
    delete (locks as { request?: unknown }).request;
  }
  assert.equal(locks.request, request, "the spy is gone");
  assert.deepEqual(asked.filter((x) => x === NOTES_LOCK), [], "no note store opened: the notes lock never asked");
});

test("pool-deposit-follow review H1: depositFrom runs the Solana deposit kind with its fixed U_{s,i}, the request checked by the pool rule; any other chain or a bad amount is refused before the kind", async () => {
  type SolHost = import("../src/pool-deposit.ts").PoolDepositHost;
  type From = import("../src/pool-deposit.ts").PoolDepositFrom;
  const sol: { ask: unknown; from: From | undefined }[] = [];
  const evm: unknown[] = [];
  const refuse = { error: "not_allowed" } as const;
  const r = rpcs();
  const t = testnetPool(page(), {
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: () => r.pair,
    evmRound: () => async () => ({ events: [], finalBlock: 100n }),
    depositKinds: {
      solana: (_host: () => SolHost) => (ask, _ctx, from) => (sol.push({ ask, from }), refuse),
      evm: () => (ask) => (evm.push(ask), refuse),
    },
  });
  t.depositFrom({ chain: "solana", amount: "0.05" }, { s: 7n, i: 3, u: "U_X" }, ctx);
  assert.deepEqual(sol, [{ ask: { kind: "pool.deposit", chain: "solana", token: null, amount: 50_000_000n, slippageBps: 0, decimals: 9 }, from: { s: 7n, i: 3, u: "U_X" } }]);
  assert.deepEqual(t.depositFrom({ chain: "base", amount: "0.05" }, { s: 7n, i: 3, u: "U_X" }, ctx), refuse);
  assert.deepEqual(t.depositFrom({ chain: "solana", amount: "-1" }, { s: 7n, i: 3, u: "U_X" }, ctx), refuse);
  // a kind passed in is the rule's own: still a deposit
  t.depositFrom({ chain: "solana", amount: "0.05", kind: "pool.buy" }, { s: 7n, i: 3, u: "U_X" }, ctx);
  assert.equal(sol.length, 2);
  assert.equal((sol[1]!.ask as { kind: string }).kind, "pool.deposit");
  assert.equal(evm.length, 0, "no EVM kind runs from depositFrom");
});

// card evm-pool-leaves-any-source (review of evm-pool-lists-mainnet, P3-1): the deposit's reads and its round's sync are
// one evmPair, so no provider's answer stands on both sides of a read; the round gets the list's providers as sources,
// and the page's one hold per pool
test("card evm-pool-leaves-any-source: the EVM deposit and its round's sync read one evmPair; the round is given the list as sources", async () => {
  const { evmPair } = await import("../../wallet/src/pool/evm.ts");
  const r = rpcs();
  const got: { pair: readonly EvmRpc[]; list: readonly EvmRpc[] | undefined }[] = [];
  const flow = testnetPool(page(), { evmPin: (c) => (c === "base" ? PIN : undefined), evmRpcs: () => r.pair, evmRound: (_p, pair, list) => (got.push({ pair, list }), async () => ({ events: [], finalBlock: 100n })) }).flow;
  const run = flow(ASK, ctx) as { running: true; after: Promise<void>; answer(): unknown };
  await run.after;
  assert.equal(got.length, 1);
  const { pair, list } = got[0]!;
  assert.equal(evmPair(pair), pair, "a pair evmPair made: the deposit's reads bind its seats");
  assert.notEqual(pair[0], r.pair[0], "seats, never the bare providers");
  assert.deepEqual(list, r.pair, "the list's providers are the sync's sources");
});

test("card evm-pool-leaves-any-source: one hold per pool on the page; the helper's route a history source on mainnet only", async () => {
  const { pageEvmHold, pageEvmHistory } = await import("../src/pool-testnet.ts");
  assert.equal(pageEvmHold(PIN), pageEvmHold({ ...PIN, pool: PIN.pool.toUpperCase().replace("0X", "0x") }));
  assert.notEqual(pageEvmHold(PIN), pageEvmHold({ ...PIN, network: "robinhood-testnet" }));
  assert.deepEqual(pageEvmHistory(PIN), [], "no route for a testnet chain");
  const base = pageEvmHistory({ ...PIN, network: "base" });
  assert.equal(base.length, 1);
  assert.equal(pageEvmHistory({ ...PIN, network: "base" })[0], base[0], "one paced route, the same each time");
  // review of 0b379bf4, P1-1: the route in its keyed-only mode, never the public fallback, one operator "helper"
  const r = base[0] as unknown as { url: string; operator: string };
  assert.match(r.url, /\/v1\/rpc\/base\?keyed=only$/);
  assert.equal(r.operator, "helper");
  assert.match((pageEvmHistory({ ...PIN, network: "robinhood" })[0] as unknown as { url: string }).url, /\/v1\/rpc\/robinhood\?keyed=only$/);
});

test("review of 0b379bf4, P3-3: the page's hold never moves back; resetPageEvmHolds forgets every pool's", async () => {
  const { pageEvmHold, resetPageEvmHolds } = await import("../src/pool-testnet.ts");
  const at = (to: bigint) => ({ network: PIN.network, pool: PIN.pool, fromBlock: 1n, to, events: [] });
  const h = pageEvmHold(PIN);
  await h.write(at(100n));
  await h.write(at(40n));
  assert.equal((await h.read())?.to, 100n);
  resetPageEvmHolds();
  assert.notEqual(pageEvmHold(PIN), h);
  assert.equal(await pageEvmHold(PIN).read(), null);
});
