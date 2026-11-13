// card evm-money-shows-and-spends-at-once (review G): the page's state read runs the EVM heal (evmSettleReserved) for a
// tail note with no RESERVED note on the chain, so a reorg that drops a fresh deposit's leaf backs it out of the balance.
// Harness as test/pool-testnet-evm-queue.test.ts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { VaultTree } from "../../kit/src/vault/inputs.ts";
import { vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, type NoteStore } from "../../wallet/src/notes/store.ts";
import type { Pool } from "../../wallet/src/pool/pool.ts";
import { signalsProver } from "../../wallet/test/withdraw-fixture.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const { testnetPool } = await import("../src/pool-testnet.ts");
const { EVM_EPOCH_MS, EVM_LADDER, EVM_LIFE_MS, EVM_SEND_MARGIN_MS, evmPoolScopeOf } = await import("../../wallet/src/pool/evm.ts");
type EvmPoolPin = import("../../wallet/src/pool/evm.ts").EvmPoolPin;
type EvmRpc = import("../../wallet/src/pool/evm.ts").EvmRpc;

const SEED64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const PIN: EvmPoolPin = Object.freeze({ network: "base-sepolia", pool: "0x00000000000000000000000000000000000F0011", feeRecipient: "0x0000000000000000000000000000000000000fee", fromBlock: 1n });
const SCOPE = evmPoolScopeOf(PIN.pool, 84532n);
const RUNG = EVM_LADDER.min;
const NOW = 1_800_000_000_000n + 1_000n;
const D0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
const L0 = vaultLabelOf(keccak_256, SCOPE, 1n);
const P = (ref: NoteRef) => noteSecrets(SEED64, ref).precommitment;

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
async function wallet(): Promise<{ w: WalletStore; ns: NoteStore }> {
  const w = await openWalletStore({ indexedDB: new IDBFactory() });
  closers.push(() => w.close());
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16), source: "code", code_saved: true, created_ms: 1 });
  const ns = await openNoteStore(w);
  closers.push(() => ns.close());
  return { w, ns };
}
/** A pool whose trees hold a stranger's leaf only: the chain after the reorg (deposit 0's leaf gone). */
function reorgedPool(): Pool<{ w: string }> {
  return {
    id: `evm:base-sepolia:${PIN.pool.toLowerCase()}`, chain: "evm", scope: SCOPE, ladder: EVM_LADDER, epochMs: EVM_EPOCH_MS, lifeMs: EVM_LIFE_MS, sendMarginMs: EVM_SEND_MARGIN_MS,
    now: async () => NOW,
    trees: async () => {
      const s = new VaultTree([5n]), l = new VaultTree([7n]);
      return { stateTree: s, labelTree: l, stateRoot: s.root!, labelRoot: l.root! };
    },
    bind: async (b) => ({ context: 1n, feeCap: 10n ** 12n, request: { w: b.wallet.address } }),
  };
}
const unread = (): readonly EvmRpc[] => ["https://a.example", "https://b.example"].map((url) => Object.assign(async () => assert.fail("no RPC read"), { url }));
const page = (w: WalletStore) => ({ store: async () => w, seed64: async () => SEED64.slice() });

test("evm-money-shows-and-spends-at-once: a state read backs out a tail note whose leaf a reorg dropped, with no RESERVED note on the chain", async () => {
  const { w, ns } = await wallet();
  // deposit 0 landed at leaf 0 in block 10, the finalized block at 5: kept in the tail
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P(D0)), leafIndex: 0n }, landed: { block: 10n, fin: 5n } });
  assert.equal((await ns.landings()).get(n.id), 10n);
  let syncs = 0;
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    hardwareConcurrency: 2,
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    // the chain after the reorg: head 41, finalized 5, block 10 holds a stranger's deposit only
    evmSync: () => ({ events: async () => (syncs++, { fin: { number: 5n, hash: "", timestamp: 1_800_000_000n, baseFeePerGas: null }, anchor: { number: 41n, hash: "", timestamp: 1_800_000_001n, baseFeePerGas: null }, events: [{ block: 10n, blockHash: `0x${"11".repeat(32)}`, logIndex: 0n, bytes: "", kind: "deposit", state: 5n, label: 7n, value: RUNG, precommitment: 9n, nullifier: null, recipient: null, token: null }] }) }),
    evmQueuePool: () => reorgedPool(),
  });
  await t.stateRead();
  await t.stateRead();
  await new Promise((r) => setTimeout(r, 50));
  await t.stateRead();
  assert.ok(syncs > 0, "the state read reads a round for the tail note");
  assert.equal((await ns.get(n.id))!.state, "INCOMING", "backed out: out of the balance");
});

test("evm-money-shows-and-spends-at-once: a sale's return note, landed at the head and taken by a buy at once: a state read on a lagging provider leaves it RESERVED, a reorg that drops it backs it out, and the chain alone lands it again at its new leaf", async () => {
  const { w, ns } = await wallet();
  const R: NoteRef = { kind: "return", c: "evm", l: vaultLabelOf(keccak_256, SCOPE, 9n), j: 0 };
  const Lr = vaultLabelOf(keccak_256, SCOPE, 2n);
  const cr = noteCommitment(RUNG, Lr, P(R));
  // the sale's return note landed at leaf 1 in block 20 (finalized 5), then the buy took it at once: RESERVED
  const n = await ns.add({ ref: R, scope: SCOPE, precommitment: P(R), state: "UNSPENT", leaf: { value: RUNG, label: Lr, commitment: cr, leafIndex: 1n }, landed: { block: 20n, fin: 5n } });
  const held = await ns.move(n.id, "UNSPENT", "HELD", { deadlineMs: NOW + 3_600_000n, context: "5" });
  await ns.move(n.id, "HELD", "RESERVED", { attempt: held.attempt! });
  const ev = (block: number, state: bigint, label: bigint, pre: bigint) => ({ block: BigInt(block), blockHash: `0x${block.toString(16).padStart(64, "0")}`, logIndex: 0n, bytes: "", kind: "deposit" as const, state, label, value: RUNG, precommitment: pre, nullifier: null, recipient: null, token: null });
  const stranger = ev(10, 5n, vaultLabelOf(keccak_256, SCOPE, 1n), 9n);
  let round = { anchor: 19n, events: [stranger] as unknown[] };
  const t = testnetPool(page(w), {
    prover: { vault: signalsProver(), stop: () => {} },
    hardwareConcurrency: 2,
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => ({ fin: { number: 5n, hash: "", timestamp: 1_800_000_000n, baseFeePerGas: null }, anchor: { number: round.anchor, hash: "", timestamp: 1_800_000_001n, baseFeePerGas: null }, events: round.events as never }) }),
    evmQueuePool: () => reorgedPool(),
  });
  const settled = async () => {
    await t.stateRead();
    await new Promise((r) => setTimeout(r, 50));
    return (await ns.get(n.id))!;
  };
  // one provider lags: the newest block both agree on is 19, short of the note's block 20: it says nothing of it
  assert.equal((await settled()).state, "RESERVED", "a round short of the note's block backs nothing out");
  // the reorg: head 41, block 20 gone with the return note's leaf
  round = { anchor: 41n, events: [stranger] };
  assert.equal((await settled()).state, "INCOMING", "backed out: out of the balance");
  // the sale's send lands again in block 30 at leaf 1: the chain alone lands the note again, no sale record read
  round = { anchor: 41n, events: [stranger, ev(30, cr, Lr, P(R))] };
  const again = await settled();
  assert.equal(again.state, "UNSPENT", "landed again from the chain");
  assert.equal(again.leaf?.leafIndex, 1n);
  assert.equal((await ns.landings()).get(n.id), 30n, "kept at its new block until final");
});

test("evm-money-shows-and-spends-at-once (re-review): a state read on a chain whose notes are all settled (final, nothing kept, nothing RESERVED) reads no seed and no round: the wallet's rule is asked before the seed", async () => {
  const { w, ns } = await wallet();
  // deposit 0 final at leaf 0 and spent long since: a note of the scope, nothing open
  const n = await ns.add({ ref: D0, scope: SCOPE, precommitment: P(D0), state: "UNSPENT", leaf: { value: RUNG, label: L0, commitment: noteCommitment(RUNG, L0, P(D0)), leafIndex: 0n } });
  await ns.move(n.id, "UNSPENT", "SPENT");
  assert.equal((await ns.landings()).size, 0);
  let seeds = 0;
  let syncs = 0;
  const t = testnetPool({ store: async () => w, seed64: async () => (seeds++, SEED64.slice()) }, {
    prover: { vault: signalsProver(), stop: () => {} },
    hardwareConcurrency: 2,
    evmPin: (c) => (c === "base" ? PIN : undefined),
    evmRpcs: unread,
    evmSync: () => ({ events: async () => (syncs++, assert.fail("no round read")) }),
    evmQueuePool: () => reorgedPool(),
  });
  await t.stateRead();
  await t.stateRead();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seeds, 0, "no seed read: nothing open");
  assert.equal(syncs, 0, "no round read");
  assert.equal((await ns.get(n.id))!.state, "SPENT");
});
