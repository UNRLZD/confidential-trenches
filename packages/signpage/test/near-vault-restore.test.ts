// The NEAR vault's notes back on a restored device (card signpage-restores-near-vault-notes, src/pool-restore.ts
// pagePools' vault entry and nearVaultRestoreNotes): a model vault served by two fake RPCs of the page's release pair at
// one block, a device's notes in it, and a new store restored from the same words through the page's restore kind.
// Every note of the vault's scope comes back with its state and nothing else; a provider that lies about a page, or
// serves a page past the list's length, writes none of the vault's notes (the next run does); a note the store holds in
// flight is never written over.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { IDBFactory } from "fake-indexeddb";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { resetPaces } from "../../wallet/src/pace.ts";
import { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../../wallet/src/notes/secrets.ts";
import { openNoteStore, refKey } from "../../wallet/src/notes/store.ts";
import { NEAR_NETWORKS } from "../../kit/src/near/networks.ts";
import { VAULT_CONSTANTS, vaultLabelOf } from "../../kit/src/vault/shapes.ts";
import type { VaultSyncRpc } from "../../kit/src/vault/sync.ts";
import * as restoreKind from "../src/pool-restore.ts";
import type { PoolRestoreHost, RestorePool } from "../src/pool-restore.ts";
import { PAGE_NETWORK } from "../src/withdraw/handoff.ts";
import { vaultScope } from "../src/withdraw/checks.ts";
import { vaultBalanceOf } from "../src/vault-balance.ts";

beforeEach(() => resetPaces());

const NET = NEAR_NETWORKS[PAGE_NETWORK];
const SCOPE = vaultScope(PAGE_NETWORK)!;
const OTHER_SCOPE = SCOPE + 1n;
// the published all-zero test seed (packages/wallet/test/vectors/a8.json's entropy) and another user's
const SEED = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const OTHER = wordsToSeed64(entropyToWords(new Uint8Array(16).fill(0x7f)));
const GAP = 16;
const H = 190_000_000;

// ---------- the vault, as its lists and views write them ----------
class Vault {
  nonce = 0n;
  deposits: { P: bigint; label: bigint; value: bigint; leaf: number }[] = [];
  spends: { nh: bigint; withdrawn: bigint; newLeaf: number }[] = [];
  leaves: bigint[] = [];
  deposit(P: bigint, value: bigint) {
    this.nonce += 1n;
    const label = vaultLabelOf(keccak_256, SCOPE, this.nonce);
    const commitment = noteCommitment(value, label, P);
    const leaf = this.leaves.push(commitment) - 1;
    this.deposits.push({ P, label, value, leaf });
    return { value, label, commitment, leafIndex: BigInt(leaf) };
  }
  withdraw(nh: bigint, withdrawn: bigint, change: { P: bigint; value: bigint; label: bigint }) {
    const commitment = noteCommitment(change.value, change.label, change.P);
    const newLeaf = this.leaves.push(commitment) - 1;
    this.spends.push({ nh, withdrawn, newLeaf });
    return { value: change.value, label: change.label, commitment, leafIndex: BigInt(newLeaf) };
  }
  views() {
    const tree = (n: number) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root: "7" });
    return {
      state_tree: tree(this.leaves.length),
      label_tree: tree(Number(this.nonce)),
      deposits: this.deposits.map((x, index) => ({ index, precommitment: String(x.P), label: String(x.label), value: String(x.value), leaf_index: x.leaf, depositor: "a".repeat(64) })),
      spends: this.spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: "1",
        refund_value: "0", refund_label: "0", refund_leaf_index: 0, status: "settled",
        payer: "relayer.near", reserve: "0", recipient: "b".repeat(64), fee: "30000", context: "5",
      })),
      leaves: this.leaves.map(String),
      labels: [] as string[],
    };
  }
}
type Lie = (method: string, view: unknown) => unknown;
const config = () => ({ version: "blindfill-vault 0.1.0", asset: NET.usdc, scope: String(SCOPE), max_tree_depth: 32, min_deposit: "1000000", max_relay_fee_bps: 5000, page_max: VAULT_CONSTANTS.PAGE_MAX });
/** The page's release pair (one FastNEAR URL and dRPC, by URL), answering the vault's views at one block. */
function pair(v: Vault, lieB?: Lie): [VaultSyncRpc, VaultSyncRpc] {
  const one = (name: string, lie?: Lie): VaultSyncRpc => ({
    name,
    async query(p) {
      const method = p.method_name as string;
      const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
      const at = p.finality === "final" ? H : (p.block_id as number);
      const views = v.views();
      let view: unknown;
      if (method === "config") view = config();
      else if (method === "state_tree" || method === "label_tree") view = views[method];
      else {
        const list = views[method as "deposits" | "spends" | "leaves" | "labels"] as unknown[];
        const start = Math.min(args.from!, list.length);
        view = list.slice(start, Math.min(start + Math.min(args.limit!, VAULT_CONSTANTS.PAGE_MAX), list.length));
      }
      if (lie) view = lie(method, view);
      return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
    },
  });
  return [one(NET.fastnear[0]), one(NET.drpc, lieB)];
}

/** A device's life in the vault: two deposits in lanes 0 and 1, the first spent with its change, a deposit of these
 *  words under another scope, and another user's deposit. What the device owns in the vault's scope, by refKey. */
function lived() {
  const v = new Vault();
  const own = new Map<string, { ref: NoteRef; state: "UNSPENT" | "SPENT"; value: bigint; parent?: string }>();
  const d0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
  const d1: NoteRef = { kind: "deposit", s: SCOPE, i: 1 };
  const l0 = v.deposit(noteSecrets(SEED, d0).precommitment, 9_000_000n);
  v.deposit(noteSecrets(OTHER, { kind: "deposit", s: SCOPE, i: 0 }).precommitment, 4_000_000n);
  v.deposit(noteSecrets(SEED, d1).precommitment, 2_000_000n);
  // these words' note of another scope: never this vault's
  v.deposit(noteSecrets(SEED, { kind: "deposit", s: OTHER_SCOPE, i: 2 }).precommitment, 3_000_000n);
  const change: NoteRef = { kind: "change", l: l0.label, j: 0 };
  v.withdraw(noteSecrets(SEED, d0).nullifierHash, 6_000_000n, { P: noteSecrets(SEED, change).precommitment, value: 3_000_000n, label: l0.label });
  own.set(refKey(d0), { ref: d0, state: "SPENT", value: 9_000_000n });
  own.set(refKey(d1), { ref: d1, state: "UNSPENT", value: 2_000_000n });
  own.set(refKey(change), { ref: change, state: "UNSPENT", value: 3_000_000n, parent: refKey(d0) });
  return { v, own, d1 };
}

const closers: (() => void)[] = [];
after(() => closers.forEach((f) => f()));
let db = 0;
async function device(): Promise<WalletStore> {
  const st = await openWalletStore({ name: `vault-restore-${db++}`, indexedDB: new IDBFactory() });
  closers.push(() => st.close());
  return st;
}
/** The page's restore over its own pool list, with only the vault entry kept and its pair the model's. */
function hostOf(st: WalletStore, rpcs: () => [VaultSyncRpc, VaultSyncRpc], ends: { stage: string; why: readonly string[] }[]): PoolRestoreHost {
  const nearVault = (restoreKind as { nearVaultRestoreNotes?: (a: object) => Promise<unknown> }).nearVaultRestoreNotes;
  return {
    store: async () => st,
    seed64: async () => Uint8Array.from(SEED),
    signedIn: async () => true,
    pools: () => restoreKind.pagePools().flatMap((p: RestorePool) => ((p.chain as string) === "near" ? [{ ...p, rpcs }] : [])) as RestorePool[],
    ids: null,
    pausesMs: [],
    ended: (stage, why) => void ends.push({ stage, why }),
    ...(nearVault ? { vault: ((a: object) => nearVault({ ...a, gap: GAP })) as never } : {}),
  };
}
async function notesIn(st: WalletStore) {
  const ns = await openNoteStore(st);
  try {
    const all = await ns.list();
    // a parent by its refKey (the store keeps its id)
    return all.map((n) => ({ key: refKey(n.ref), scope: n.scope, state: n.state, value: n.leaf?.value, parent: n.parent === undefined ? undefined : refKey(all.find((x) => x.id === n.parent)!.ref) }));
  } finally {
    ns.close();
  }
}
const want = (own: ReturnType<typeof lived>["own"]) =>
  [...own].map(([key, n]) => ({ key, scope: SCOPE, state: n.state, value: n.value, parent: n.parent })).sort((a, b) => a.key.localeCompare(b.key));
const sorted = <T extends { key: string }>(xs: T[]) => xs.sort((a, b) => a.key.localeCompare(b.key));

test("a new store restored from the same words holds every note of the NEAR vault with its state (UNSPENT, SPENT) and nothing else", async () => {
  const { v, own } = lived();
  const st = await device();
  const ends: { stage: string; why: readonly string[] }[] = [];
  const r = restoreKind.poolRestore(hostOf(st, () => pair(v), ends));
  await r.auto();
  const got = sorted(await notesIn(st));
  assert.deepEqual(got, want(own));
  // Cash: the vault's balance the page tells the app, from these notes alone (src/vault-balance.ts)
  const ns = await openNoteStore(st);
  assert.equal(vaultBalanceOf(await ns.list(), SCOPE), 5_000_000n);
  ns.close();
  assert.deepEqual(ends.at(-1)?.why, []);
});

test("a provider that lies about a page, or serves one past the list's length: none of the vault's notes is written, the run is stalled by name, and the next run writes them", async () => {
  for (const [name, lie] of [
    ["a deposit's value changed on one provider", (m: string, view: unknown) => (m === "deposits" && Array.isArray(view) && view.length > 0 ? view.map((r, k) => (k === 0 ? { ...(r as object), value: "1" } : r)) : view)],
    ["a page past the list's length", (m: string, view: unknown) => (m === "spends" && Array.isArray(view) ? [...view, ...view] : view)],
  ] as const) {
    const { v, own } = lived();
    const st = await device();
    const ends: { stage: string; why: readonly string[] }[] = [];
    await restoreKind.poolRestore(hostOf(st, () => pair(v, lie), ends)).auto();
    assert.deepEqual(await notesIn(st), [], name);
    assert.equal(ends.at(-1)?.stage, "stalled", name);
    assert.match(ends.at(-1)!.why.join(" | "), /^near vault: /, name);
    // the next run, the pair honest
    const again: { stage: string; why: readonly string[] }[] = [];
    await restoreKind.poolRestore(hostOf(st, () => pair(v), again)).auto();
    assert.deepEqual(sorted(await notesIn(st)).map((n) => [n.key, n.state]), want(own).map((n) => [n.key, n.state]), name);
  }
});

test("a note the store holds in flight is never written over; the others come back; the vault's deposit counter goes past the restored notes", async () => {
  const { v, d1 } = lived();
  const st = await device();
  // restored once, then this device holds d1 in a payout (a withdraw asked, RESERVED, not yet spent in the vault)
  await restoreKind.poolRestore(hostOf(st, () => pair(v), [])).auto();
  const ns = await openNoteStore(st);
  const held = (await ns.list()).find((x) => refKey(x.ref) === refKey(d1))!;
  await ns.move(held.id, "UNSPENT", "HELD", { deadlineMs: BigInt(Date.now() + 3_600_000), context: "7" }).then((x) => ns.move(x.id, "HELD", "RESERVED", { attempt: x.attempt!, request: "{}" }));
  ns.close();
  // a restore the user asks again (a Sync): the store holds notes, so no auto run
  const r = restoreKind.poolRestore(hostOf(st, () => pair(v), []));
  r.kind({}, { id: crypto.randomUUID(), sha: "0".repeat(64), progress: () => {} } as never);
  await new Promise((ok) => setTimeout(ok, 0));
  await r.idle();
  const got = sorted(await notesIn(st));
  assert.deepEqual(got.find((x) => x.key === refKey(d1))?.state, "RESERVED", "kept as this device holds it");
  assert.equal(got.length, 3);
  // the next deposit this store plans in its own lane is past every restored deposit index of that lane
  const ns2 = await openNoteStore(st);
  const next = await ns2.planDeposit(SCOPE, (ref) => noteSecrets(SEED, ref).precommitment);
  ns2.close();
  // (step 7's raise: its lane's highest restored index plus two of the lane, or past the lane's first in an empty lane)
  const lane = st.lane;
  assert.deepEqual(next.ref.kind === "deposit" ? next.ref.i : null, lane <= 1 ? lane + 16 : lane + 8, `lane ${lane}`);
});
