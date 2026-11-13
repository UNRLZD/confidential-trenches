// SIGN_HOST's build (Node's default network) carries the Base and Robinhood withdraw itself, not only its screen (card
// evm-deposit-on-mainnet, review P2-1 and P2-2): the screen's funds read reaches the EVM withdraw (src/pool-withdraw-evm.ts
// evmWithdrawFunds) and reads the pool's pair; the screen's run reaches runEvmPoolWithdraw and writes its op; an owed
// EVM part after a reload is finished on the chain's own path (finishEvmOnward), which reads the pool's pair. A build
// that folds any of them out of mainnet again keeps deposits open with no way out, so each is held here. And the one rule
// at each of its doors, with a build planted to carry no withdraw (TestnetOver.withdrawBuilt): the screen names no pool
// and hands no run, a Solana withdraw writes nothing, and an EVM chain's INCOMING notes are not settled.
//   node --test test/pool-withdraw-mainnet-reaches.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
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
const { oweSend, testnetPool } = await import("../src/pool-testnet.ts");
const { POOL_TESTNET } = await import("../../wallet/src/pool/network.ts");
const { EVM_CHAIN_IDS, EVM_POOLS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteCommitment, noteSecrets } = await import("../../wallet/src/notes/secrets.ts");
const { vaultLabelOf } = await import("../../kit/src/vault/shapes.ts");
assert.equal(POOL_TESTNET, false, "this file runs as SIGN_HOST's build");

const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const TO = "0x1111111111111111111111111111111111111111";
const stores: WalletStore[] = [];
after(() => stores.forEach((s) => s.close()));
const store = async () => {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  stores.push(w);
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  return w;
};
/** The pool's pair as fakes that answer nothing, and every call made on them. */
const pair = () => {
  const read: string[] = [];
  const evm = (url: string): EvmRpc => Object.assign(async (m: string) => (read.push(`${new URL(url).host} ${m}`), Promise.reject(new Error(`no answer to ${m}`))), { url });
  return { read, rpcs: [evm("https://a.example"), evm("https://b.example")] };
};
const pageOf = (w: WalletStore) => ({
  store: async () => w,
  seed64: async () => SEED.slice(),
  openWithdraw: () => ({ running: true, after: Promise.resolve(), answer: () => ({ result: { stage: "sent" } }) }) as never,
});
const overOf = (p: ReturnType<typeof pair>, extra: Record<string, unknown> = {}) => ({
  evmRpcs: () => p.rpcs,
  evmRound: () => async () => ({ events: [], finalBlock: 100n }),
  evmSync: () => ({ events: async () => assert.fail("no sync read") }),
  fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch,
  ...extra,
});
/** A landed note of the chain's mainnet pool, in the store, UNSPENT. */
const landed = async (w: WalletStore, chain: "base" | "robinhood", i = 0) => {
  const scope = evmPoolScopeOf(EVM_POOLS[chain]!.pool, EVM_CHAIN_IDS[chain]);
  const ref = { kind: "deposit" as const, s: scope, i };
  const { precommitment } = noteSecrets(SEED, ref);
  const label = vaultLabelOf(keccak_256, scope, BigInt(i + 1));
  const value = 10n ** 15n;
  const ns = await openNoteStore(w);
  const n = await ns.add({ ref, scope, precommitment, state: "UNSPENT", leaf: { value, label, commitment: noteCommitment(value, label, precommitment), leafIndex: BigInt(i) } });
  return { ns, n, scope };
};

for (const chain of ["base", "robinhood"] as const) {
  test(`review P2-1: on the mainnet build a ${chain} withdraw screen's funds read reaches the EVM withdraw and reads the pool's pair`, async () => {
    const p = pair();
    const t = testnetPool(pageOf(await store()), overOf(p));
    const deps = t.withdrawDeps(chain, `op-${chain}`);
    assert.equal(deps.keys.pool, EVM_POOLS[chain]!.pool, "the screen names the pinned pool");
    assert.equal(typeof deps.handoff, "function", "the screen hands a run");
    const err = await deps.funds().then(() => null, (e: unknown) => e as Error);
    assert.doesNotMatch(String(err?.message), /no pool for this chain|no flow for this chain/, "the funds read went past the rule");
    assert.ok(p.read.length > 0, "the funds read reached the pool's pair");
    await t.signedOut();
  });

  test(`review P2-1: on the mainnet build a ${chain} withdraw run reaches runEvmPoolWithdraw: its op written, the pool's pair read`, async () => {
    const p = pair();
    const w = await store();
    const { ns } = await landed(w, chain);
    ns.close();
    const t = testnetPool(pageOf(w), overOf(p));
    await t.withdraw({ chain, to: TO, amount: 10n ** 14n, maxFee: 10n ** 15n }, `run-${chain}`);
    const op = (await w.get("ops", `run-${chain}`)) as { kind?: string; stage?: string } | undefined;
    assert.equal(op?.kind, "withdraw", "the run wrote its op");
    assert.equal(op?.stage, "stopped", "the pair answers nothing: the run stops, nothing moved");
    assert.ok(p.read.length > 0, "the run read the pool's pair");
    await t.signedOut();
  });

  test(`review P2-2: on the mainnet build an owed ${chain} part after a reload is finished on the chain's own path: finishEvmOnward reads the pool's pair (a build planted to carry no ${chain} withdraw reads nothing and keeps it owed)`, async () => {
    for (const built of [false, true]) await owedAfterReload(chain, built);
  });
}

async function owedAfterReload(chain: "base" | "robinhood", built: boolean) {
  {
    const p = pair();
    const w = await store();
    const { ns, n } = await landed(w, chain);
    const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: BigInt(Date.now() + 600_000), context: "7" });
    const attempt = held.attempt!;
    await ns.move(n.id, "HELD", "RESERVED", { attempt });
    ns.close();
    await w.put("ops", "owed-op", { kind: "withdraw", stage: "in_transit", txs: [], created_ms: 1, owed: n.id });
    const pending = { noteId: n.id, attempt, context: "7", to: TO, last: true, feeCap: "1000", chain, part: "100000000000000", nullifier: "1", from: "1", deadlineMs: String(Date.now() + 600_000), chunk: "100000000000000", fee: "1000" };
    await oweSend(w, "owed-op", pending as never);
    // a reload: a new page on the same store; its state read runs the owed finish
    const t = testnetPool(pageOf(w), overOf(p, { withdrawBuilt: { solana: true, base: true, robinhood: true, [chain]: built } }));
    await t.stateRead();
    assert.equal(p.read.length > 0, built, `withdraw built ${built}: the owed part's finish read the pool's pair (${p.read.join(", ")})`);
    assert.equal(((await w.get("ops", "owed-op")) as { stage?: string }).stage, "in_transit", "the pair answers nothing: still owed, never dropped");
    await t.signedOut();
  }
}

test("the one rule at its doors: a build planted to carry no Base withdraw names no pool on the screen and hands no run; its funds read refuses", async () => {
  const p = pair();
  const t = testnetPool(pageOf(await store()), overOf(p, { withdrawBuilt: { solana: true, base: false, robinhood: true } }));
  const deps = t.withdrawDeps("base", "op-planted");
  assert.equal(deps.keys.pool, "", "no pool named");
  assert.equal(deps.handoff, undefined, "no run handed");
  await assert.rejects(deps.funds(), /no flow for this chain/);
  assert.deepEqual(p.read, [], "nothing read");
  assert.equal(t.withdrawDeps("robinhood", "op-rh").keys.pool, EVM_POOLS.robinhood!.pool, "the other chain's screen as before");
  await t.signedOut();
});

test("the one rule at its doors: a build planted to carry no Solana withdraw writes no op for a Solana withdraw", async () => {
  const w = await store();
  const t = testnetPool(pageOf(w), overOf(pair(), { withdrawBuilt: { solana: false, base: true, robinhood: true } }));
  await t.withdraw({ chain: "solana", to: "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx", amount: 10n ** 7n, maxFee: 10n ** 7n }, "sol-planted");
  assert.equal(await w.get("ops", "sol-planted"), undefined, "no run, no op");
  await t.signedOut();
});

test("review P3-1, the one rule at its doors: a build planted to carry no Base withdraw does not settle Base's INCOMING notes (no deposit run, nothing read)", async () => {
  for (const [built, reads] of [[false, false], [true, true]] as const) {
    const p = pair();
    const w = await store();
    const scope = evmPoolScopeOf(EVM_POOLS.base!.pool, EVM_CHAIN_IDS.base);
    const ns = await openNoteStore(w);
    const planned = await ns.planDeposit(scope, (r) => noteSecrets(SEED, r).precommitment);
    await ns.move(planned.id, "PLANNED", "INCOMING", { evmSend: { hash: `0x${"ab".repeat(32)}`, nonce: 0n, value: 10n ** 15n } } as never);
    ns.close();
    const t = testnetPool(pageOf(w), overOf(p, { withdrawBuilt: { solana: true, base: built, robinhood: true } }));
    await t.stateRead();
    for (let i = 0; i < 50 && reads && p.read.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.read.length > 0, reads, `withdraw built ${built}: ${p.read.join(", ")}`);
    await t.signedOut();
  }
});
