// Restore of notes from the vault's pages (card wallet-restore-notes, lane W2.5; docs/plan1/wallet.md §2.3 "Restore"
// steps 2-3 l.263-276, Secrets l.176-192, the deposit index rule l.346-356, device lanes l.245-254, the held note
// l.392; P-03 l.1067). A model vault takes the events of P-03 in random orders and serves its pages in the vault's own
// serde form (contracts/vault/src/lib.rs DepositView, SpendView, TreeView) on two fake RPCs; the restore reads them
// through the kit's vaultSync and must find every note the device owns, byte for byte, in its right state.
//   node --test test/note-restore.test.ts      (from packages/wallet)
// Test secrets come from published BIP-39 vectors (all-zero entropy: the user; 0x7f entropy: another user), never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { VAULT_CONSTANTS, VAULT_SYNC_LAG_MAX, VaultSyncStopped, vaultLabelOf, vaultScopeOf, type VaultSyncRpc } from "@blindfill/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as d from "../src/derive/index.ts";
import { noteCommitment, noteSecrets, type NoteRef } from "../src/notes/secrets.ts";
import { openNoteStore, refKey, type Leaf, type NoteRecord } from "../src/notes/store.ts";
import { RESTORE_GAP, RESTORE_LANES, restoreNotes, restorePages, walkLane, writeRestored, type NoteRestore } from "../src/notes/restore.ts";
import type { VaultDepositRow, VaultSpendRow } from "@blindfill/kit";
import { openWalletStore } from "../src/store/index.ts";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";

const VAULT = "vault.bf-restore.testnet";
const TOKEN = "usdc.fakes.testnet";
const SCOPE = vaultScopeOf(keccak_256, VAULT, TOKEN);
const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16)));
const OTHER = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16).fill(0x7f)));
const TEST_GAP = 64; // the property's walk; every generated lane gap is checked to be below it (RESTORE_GAP is tested below)
// card fresh-run-margin: the default run keeps the property's first seeded cases and the gap rule at a gap of TEST_GAP;
// FULL_RUNS=1 (the package's test:mutants script, CI's test-wallet job) runs every case and the rule at RESTORE_GAP
const FULL = process.env.FULL_RUNS === "1";
const CHAIN_TAGS = Object.keys(d.CHAINS) as d.Chain[];

// ---------- a seeded PRNG ----------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]!, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;
const hex64 = (s: string) => Array.from(sha256(new TextEncoder().encode(s)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- the model vault (its rows as lib.rs's views write them) ----------
type SpendStatus = "in_flight" | "paid" | "refund_pending" | "settled";
type Spend = {
  nh: bigint; withdrawn: bigint; newLeaf: number; refundP: bigint; refundValue: bigint; refundLabel: bigint; refundLeaf: number;
  status: SpendStatus; recipient: string; fee: bigint; context: bigint;
};
class Vault {
  nonce = 0n;
  deposits: { P: bigint; label: bigint; value: bigint; leaf: number; depositor: string }[] = [];
  spends: Spend[] = [];
  leaves: bigint[] = [];
  labels: bigint[] = [];
  usedP = new Set<bigint>();
  spent = new Set<bigint>();
  deposit(P: bigint, value: bigint, depositor: string): Leaf | null {
    if (this.usedP.has(P)) return null; // the vault refuses a precommitment it holds (§2.4 points 7 and 9)
    this.usedP.add(P);
    this.nonce += 1n;
    const label = vaultLabelOf(keccak_256, SCOPE, this.nonce);
    const commitment = noteCommitment(value, label, P);
    const leaf = this.leaves.push(commitment) - 1;
    this.labels.push(label);
    this.deposits.push({ P, label, value, leaf, depositor });
    return { value, label, commitment, leafIndex: BigInt(leaf) };
  }
  // 2.5.2 rows 11-12: spent, the change inserted even when 0; a ragequit (2.5.3) inserts no change, context 0
  withdraw(nh: bigint, withdrawn: bigint, change: { P: bigint; value: bigint; label: bigint } | null, refundP: bigint, ctx: bigint): { spend: number; leaf: Leaf | null } {
    assert.ok(!this.spent.has(nh), "the model never double-spends");
    this.spent.add(nh);
    let leaf: Leaf | null = null;
    let newLeaf = 0;
    if (change) {
      const commitment = noteCommitment(change.value, change.label, change.P);
      newLeaf = this.leaves.push(commitment) - 1;
      leaf = { value: change.value, label: change.label, commitment, leafIndex: BigInt(newLeaf) };
    }
    const spend = this.spends.push({ nh, withdrawn, newLeaf, refundP, refundValue: 0n, refundLabel: 0n, refundLeaf: 0, status: "in_flight", recipient: hex64(`rcp${nh}`), fee: change ? 30_000n : 0n, context: ctx }) - 1;
    return { spend, leaf };
  }
  payout(spend: number, returned: bigint): void {
    const s = this.spends[spend]!;
    if (returned > 0n) (s.status = "refund_pending"), (s.refundValue = returned);
    else s.status = "paid";
  }
  settle(spend: number): Leaf | null {
    const s = this.spends[spend]!;
    assert.ok(s.status === "paid" || s.status === "refund_pending");
    let leaf: Leaf | null = null;
    if (s.status === "refund_pending") {
      this.nonce += 1n;
      const label = vaultLabelOf(keccak_256, SCOPE, this.nonce);
      const commitment = noteCommitment(s.refundValue, label, s.refundP);
      s.refundLeaf = this.leaves.push(commitment) - 1;
      this.labels.push(label);
      s.refundLabel = label;
      leaf = { value: s.refundValue, label, commitment, leafIndex: BigInt(s.refundLeaf) };
    }
    s.status = "settled";
    return leaf;
  }
  views() {
    const tree = (n: number, root: string) => ({ size: n, depth: n <= 1 ? 0 : Math.ceil(Math.log2(n)), root });
    return {
      state_tree: tree(this.leaves.length, "7"),
      label_tree: tree(this.labels.length, "9"),
      deposits: this.deposits.map((x, index) => ({ index, precommitment: String(x.P), label: String(x.label), value: String(x.value), leaf_index: x.leaf, depositor: x.depositor })),
      spends: this.spends.map((s, index) => ({
        index, nullifier_hash: String(s.nh), withdrawn: String(s.withdrawn), new_leaf_index: s.newLeaf, refund_precommitment: String(s.refundP),
        refund_value: String(s.refundValue), refund_label: String(s.refundLabel), refund_leaf_index: s.refundLeaf, status: s.status,
        payer: "relayer.bf-restore.testnet", reserve: "0", recipient: s.recipient, fee: String(s.fee), context: String(s.context),
      })),
      leaves: this.leaves.map(String),
      labels: this.labels.map(String),
    };
  }
}

// ---------- two fake RPCs serving the views at one block, as near RPC answers ----------
type View = ReturnType<Vault["views"]>;
type Sent = { rpc: string; params: Record<string, unknown> };
type Lie = (method: string, view: unknown) => unknown;
const H = 275_800_000;
// the testnet release pair, named by URL as nearRpc names a provider (restore refuses any other pair)
const RPC_A = NEAR_NETWORKS.testnet.fastnear[0];
const RPC_B = NEAR_NETWORKS.testnet.drpc;
// config() as lib.rs's Config writes it (the fields restore reads: asset and scope)
const config = (token = TOKEN, scope = SCOPE) => ({ version: "blindfill-vault 0.1.0 testnet", asset: token, scope: String(scope), max_tree_depth: 32, min_deposit: "1000000", max_relay_fee_bps: 5000, page_max: VAULT_CONSTANTS.PAGE_MAX });
function rpcs(v: View, opts: { sent?: Sent[]; lie?: Lie; lieA?: Lie; finals?: [number, number]; config?: object; configFinalB?: number } = {}): [VaultSyncRpc, VaultSyncRpc] {
  const one = (name: string, final: number, lie?: Lie): VaultSyncRpc => ({
    name,
    async query(p) {
      opts.sent?.push({ rpc: name, params: p });
      const method = p.method_name as string;
      const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
      const at = p.finality === "final" ? (p.method_name === "config" && name === RPC_B && opts.configFinalB !== undefined ? opts.configFinalB : final) : (p.block_id as number);
      let view: unknown;
      if (method === "config") view = opts.config ?? config();
      else if (method === "state_tree" || method === "label_tree") view = v[method];
      else {
        const list = v[method as "deposits" | "spends" | "leaves" | "labels"] as unknown[];
        const start = Math.min(args.from!, list.length);
        view = list.slice(start, Math.min(start + Math.min(args.limit!, VAULT_CONSTANTS.PAGE_MAX), list.length));
      }
      if (lie) view = lie(method, view);
      return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
    },
  });
  const [fa, fb] = opts.finals ?? [H, H];
  return [one(RPC_A, fa, opts.lieA), one(RPC_B, fb, opts.lie)];
}

// ---------- the device's truth: every note it owns in the vault, as it wrote them ----------
type Truth = { ref: NoteRef; precommitment: bigint; leaf: Leaf; spent: boolean; parent?: string };
const sec = (ref: NoteRef) => noteSecrets(SEED, ref);
const jOf = (ref: NoteRef) => (ref.kind === "change" ? ref.j + 1 : 0); // keys.ts changeIndex, with every first note of a label at 0

class World {
  v = new Vault();
  own = new Map<string, Truth>(); // refKey -> note
  lanePos = new Map<number, number>(); // lane -> next position (index = lane + 8 * position)
  laneMiss = new Map<number, number>(); // lane -> misses in a row since its last note (for the gap precondition)
  laneMaxGap = 0;
  laneHigh = new Map<number, number>();
  seconds = new Map<string, number>(); // second-arrival id key -> next n
  pending: { spend: number; l: bigint; j: number }[] = [];
  pendingOwn: number[] = []; // spends of ours left refund_pending at the end
  withdrawals: { spend: number; l: bigint; j: number; note: string }[] = [];
  arms: { l: bigint; j: number }[] = [];
  otherN = 0;
  r: Rng;
  constructor(r: Rng) {
    this.r = r;
  }

  land(ref: NoteRef, leaf: Leaf | null, parent?: string): string | null {
    if (!leaf) return null;
    const key = refKey(ref);
    assert.ok(!this.own.has(key), `the model lands ${key} once`);
    this.own.set(key, { ref, precommitment: sec(ref).precommitment, leaf, spent: false, ...(parent ? { parent } : {}) });
    return key;
  }
  // a deposit index of the lane: "note" lands a note (maybe split into second arrivals), "miss" leaves no note
  index(lane: number, what: "note" | "miss" | "dust"): number {
    const pos = this.lanePos.get(lane) ?? 0;
    this.lanePos.set(lane, pos + 1);
    const i = lane + RESTORE_LANES * pos;
    if (what === "miss") {
      const m = (this.laneMiss.get(lane) ?? 0) + 1;
      this.laneMiss.set(lane, m);
      return i;
    }
    this.laneMaxGap = Math.max(this.laneMaxGap, this.laneMiss.get(lane) ?? 0);
    this.laneMiss.set(lane, 0);
    this.laneHigh.set(lane, i);
    const ref: NoteRef = { kind: "deposit", s: SCOPE, i };
    const U = hex64(`U${i}`);
    if (what === "dust") {
      // a dust front-run on our P (§2.4 point 7): the attacker's dust is a note on our secrets; our money goes on n = 0
      this.land(ref, this.v.deposit(sec(ref).precommitment, 1n, hex64("attacker")));
      this.second({ id: "U", s: SCOPE, i }, this.value());
    } else {
      this.land(ref, this.v.deposit(sec(ref).precommitment, this.value(), U));
      for (let k = this.r.int(3); k > 0; k--) this.second({ id: "U", s: SCOPE, i }, this.value()); // the split (§2.4)
    }
    return i;
  }
  // the next arrival under an id (§2.3 Secrets: n counts from 0, n + 1 only once n has landed)
  second(id: d.SecondId, value: bigint): void {
    const k = JSON.stringify(id, (_, x) => (typeof x === "bigint" ? String(x) : x));
    const n = this.seconds.get(k) ?? 0;
    this.seconds.set(k, n + 1);
    const ref: NoteRef = { kind: "second", id, n };
    this.land(ref, this.v.deposit(sec(ref).precommitment, value, hex64(`id${k}`)));
  }
  value(): bigint {
    return BigInt(1_000_000 + this.r.int(500_000_000));
  }
  unspent(): Truth[] {
    return [...this.own.values()].filter((n) => !n.spent && n.leaf.value >= 2n);
  }
  // a withdrawal of ours on note n: its change, maybe a refund, and what the arm brings back
  withdraw(n: Truth, how: { ragequit?: boolean } = {}): { l: bigint; j: number } {
    const l = n.leaf.label;
    const j = jOf(n.ref);
    const key = refKey(n.ref);
    const refundP = sec({ kind: "refund", l, j }).precommitment;
    n.spent = true;
    if (how.ragequit) {
      const w = this.v.withdraw(sec(n.ref).nullifierHash, n.leaf.value, null, refundP, 0n);
      this.withdrawals.push({ spend: w.spend, l, j, note: key });
      this.v.payout(w.spend, 0n);
      return { l, j };
    }
    const withdrawn = 1n + BigInt(this.r.int(Number(n.leaf.value - 1n))) + (this.r.chance(0.15) ? n.leaf.value - 1n : 0n);
    const take = withdrawn > n.leaf.value ? n.leaf.value : withdrawn; // sometimes all of it: a change of 0
    const cref: NoteRef = { kind: "change", l, j };
    const w = this.v.withdraw(sec(n.ref).nullifierHash, take, { P: sec(cref).precommitment, value: n.leaf.value - take, label: l }, refundP, BigInt(1 + this.r.int(1e9)));
    this.withdrawals.push({ spend: w.spend, l, j, note: key });
    this.land(cref, w.leaf, key);
    const out = this.r.int(10);
    if (out < 6) this.v.payout(w.spend, 0n);
    else if (out < 9) this.v.payout(w.spend, BigInt(1 + this.r.int(Number(take))));
    if (out < 9) this.pending.push({ spend: w.spend, l, j });
    // else in flight: the payout's callback has not run
    this.arms.push({ l, j });
    return { l, j };
  }
  settleOne(): void {
    if (this.pending.length === 0) return;
    const k = this.r.int(this.pending.length);
    const p = this.pending.splice(k, 1)[0]!;
    const leaf = this.v.settle(p.spend);
    if (leaf) {
      const parent = this.withdrawals.find((w) => w.spend === p.spend)!.note;
      this.land({ kind: "refund", l: p.l, j: p.j }, leaf, parent);
    }
  }
  // what an arm brings back into the vault, each on its own id: a return under R, a refund moved under V, WM-11 under A
  armBack(a: { l: bigint; j: number }, what: "return" | "move" | "wm11" | "second-return" | "second-move"): void {
    if (what === "return" || what === "second-return") {
      const c = this.r.pick(CHAIN_TAGS);
      const ref: NoteRef = { kind: "return", c, l: a.l, j: a.j };
      if (!this.own.has(refKey(ref))) this.land(ref, this.v.deposit(sec(ref).precommitment, this.value(), hex64(`R${c}${a.l}${a.j}`)));
      if (what === "second-return") this.second({ id: "R", c, l: a.l, j: a.j }, this.value());
    } else if (what === "move" || what === "second-move") {
      const ref: NoteRef = { kind: "move", l: a.l, j: a.j };
      if (!this.own.has(refKey(ref))) this.land(ref, this.v.deposit(sec(ref).precommitment, this.value(), hex64(`V${a.l}${a.j}`)));
      if (what === "second-move") this.second({ id: "V", l: a.l, j: a.j }, this.value());
    } else this.second({ id: "A", l: a.l, j: a.j }, this.value());
  }
  // another user's activity: deposits and withdrawals on their own secrets
  other(): void {
    const ref: NoteRef = { kind: "deposit", s: SCOPE, i: this.otherN++ };
    const s = noteSecrets(OTHER, ref);
    const leaf = this.v.deposit(s.precommitment, this.value(), hex64(`o${this.otherN}`))!;
    if (this.r.chance(0.5)) {
      const c = noteSecrets(OTHER, { kind: "change", l: leaf.label, j: 0 });
      const w = this.v.withdraw(s.nullifierHash, leaf.value / 2n, { P: c.precommitment, value: leaf.value - leaf.value / 2n, label: leaf.label }, 99n, 5n);
      this.v.payout(w.spend, this.r.chance(0.5) ? 7n : 0n);
      this.v.settle(w.spend);
    }
  }
  finish(): void {
    this.pendingOwn = this.pending.filter((p) => this.v.spends[p.spend]!.status === "refund_pending").map((p) => p.spend);
    for (const n of this.own.values()) n.spent = this.v.spent.has(sec(n.ref).nullifierHash);
  }
}

// P-03's own list, in the Verifier's order (l.1067), on the notes the vault can show
function verifierOrder(r: Rng): World {
  const w = new World(r);
  const [A, B, C] = [2, 5, 7]; // three device lanes; the rest are empty
  for (let k = 0; k < 21; k++) w.index(A, "note"); // 21 finished deposits
  for (let k = 0; k < 25; k++) w.index(A, "miss"); // 25 quotes refunded by 1Click to their one-time id
  w.index(A, "note"); // ... and the next index lands
  const stuck = w.withdraw(w.unspent()[0]!); // a stuck return under R: nothing in the vault from it
  void stuck;
  for (let k = 0; k < 19; k++) w.armBack(w.withdraw(w.unspent()[k]!), "return"); // 19 returns, refunded to W, then landed
  w.second({ id: "U", s: SCOPE, i: A + 8 * 3 }, w.value()); // money under the U of an index with a note
  w.index(A, "dust"); // a dust front-run
  w.withdraw(w.unspent()[1]!); // an id withdrawn out to the user
  for (let k = 0; k < 6; k++) w.settleOne(); // the arm refund notes
  w.armBack(w.withdraw(w.unspent()[2]!), "wm11"); // an arm whose A kept the USDC: WM-11 back on A's n = 0
  for (let k = 0; k < 25; k++) w.withdraw(w.unspent()[k]!); // 25 arms in a row that stopped
  for (let k = 0; k < 4; k++) w.index(B, "note");
  w.index(B, "miss"); // a restore's skip in its lane (step 7) ...
  w.index(B, "note"); // ... and the late send to the lost store's quote
  w.index(B, "miss");
  w.index(B, "miss");
  w.index(B, "note");
  w.index(C, "note");
  w.armBack(w.withdraw(w.unspent()[3]!), "second-return"); // a second return from one wallet
  w.armBack(w.withdraw(w.unspent()[4]!), "second-move"); // a 1Click refund to V moved in, twice
  const two = w.withdraw(w.unspent()[5]!); // (a2): the losing device's WM-11, then the winner's next
  w.armBack(two, "wm11");
  w.armBack(two, "wm11");
  w.second({ id: "U", s: SCOPE, i: B }, w.value()); // (c): two deposits in one lane on one id
  w.withdraw(w.unspent().find((n) => n.ref.kind === "deposit")!, { ragequit: true });
  for (let k = 0; k < 6; k++) w.other();
  const refund = [...w.own.values()].find((n) => n.ref.kind === "refund" && !n.spent);
  if (refund) w.withdraw(refund); // a refund note's own chain
  for (let k = 0; k < 3; k++) {
    const ch = w.unspent().find((n) => n.ref.kind === "change");
    if (ch) w.withdraw(ch); // change of change
  }
  for (let k = 0; k < 4; k++) w.settleOne();
  w.finish();
  return w;
}

// a random interleaving of the same kinds of events
function randomOrder(r: Rng): World {
  const w = new World(r);
  const lanes = [r.int(8), r.int(8), r.int(8)];
  const steps = 40 + r.int(60);
  for (let s = 0; s < steps; s++) {
    const roll = r.int(100);
    const un = w.unspent();
    if (roll < 25 || un.length === 0) w.index(r.pick(lanes), r.chance(0.1) ? "dust" : "note");
    else if (roll < 35) {
      const lane = r.pick(lanes);
      // refunded quotes, skips, an index another device took: runs of up to 25, kept below the walk's gap
      for (let k = Math.min(1 + r.int(25), TEST_GAP - 1 - (w.laneMiss.get(lane) ?? 0)); k > 0; k--) w.index(lane, "miss");
    } else if (roll < 60) w.withdraw(r.pick(un));
    else if (roll < 63 && un.some((n) => n.ref.kind !== "change")) w.withdraw(r.pick(un.filter((n) => n.ref.kind !== "change")), { ragequit: true });
    else if (roll < 75) w.settleOne();
    else if (roll < 90 && w.arms.length > 0) w.armBack(r.pick(w.arms), r.pick(["return", "move", "wm11", "second-return", "second-move"] as const));
    else w.other();
  }
  w.finish();
  return w;
}

// ---------- what the restore must give ----------
const SPEND_LIST = (w: World) => w.withdrawals.map((x) => ({ spend: x.spend, l: x.l, j: x.j, note: x.note })).sort((a, b) => a.spend - b.spend);
function check(w: World, got: NoteRestore, what: string): void {
  const want = [...w.own.entries()].map(([key, n]) => ({ key, precommitment: n.precommitment, leaf: n.leaf, state: n.spent ? "SPENT" : "UNSPENT", parent: n.parent }));
  const have = got.notes.map((n) => ({ key: refKey(n.ref), precommitment: n.precommitment, leaf: n.leaf, state: n.state, parent: n.parent }));
  const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1);
  assert.deepEqual(have.slice().sort(byKey), want.slice().sort(byKey), `${what}: every note, byte for byte, in its state`);
  for (const n of got.notes) {
    assert.equal(n.scope, SCOPE);
    assert.equal(n.precommitment, sec(n.ref).precommitment, `${what}: ${refKey(n.ref)} is the device's own precommitment`);
    assert.equal(n.leaf.commitment, noteCommitment(n.leaf.value, n.leaf.label, n.precommitment));
  }
  // parents come before their children, so the store can take them in order
  const seen = new Set<string>();
  for (const n of got.notes) {
    if (n.parent) assert.ok(seen.has(n.parent), `${what}: ${refKey(n.ref)} before its parent`);
    seen.add(refKey(n.ref));
  }
  assert.deepEqual(got.spends.map((x) => ({ spend: x.spend.index, l: x.l, j: x.j, note: x.note })).sort((a, b) => a.spend - b.spend), SPEND_LIST(w), `${what}: every withdrawal of ours`);
  assert.deepEqual(got.pendingRefunds.map((x) => x.spend.index).sort((a, b) => a - b), w.pendingOwn.slice().sort((a, b) => a - b), `${what}: every refund still to settle`);
  const lanes = Array.from({ length: RESTORE_LANES }, (_, k) => w.laneHigh.get(k) ?? null);
  assert.deepEqual(got.laneHighest, lanes, `${what}: each lane's highest deposit index with a note`);
}

// The reads: whole pages only (2.5.6), each page once per RPC, and no argument but a page's from and limit.
function checkReads(sent: Sent[], v: View): void {
  const pages = (n: number) => Math.floor(n / VAULT_CONSTANTS.PAGE_MAX) + 1;
  const want = 3 + pages(v.deposits.length) + pages(v.spends.length) + pages(v.leaves.length); // labels are not needed
  assert.equal(sent.length, 2 * want + 2, "each page read once on each RPC, and config once on each");
  for (const { params } of sent) {
    assert.deepEqual(Object.keys(params).sort(), ["account_id", "args_base64", params.finality ? "finality" : "block_id", "method_name", "request_type"].sort());
    assert.ok(["state_tree", "label_tree", "deposits", "spends", "leaves", "config"].includes(params.method_name as string));
    const a = JSON.parse(atob(params.args_base64 as string));
    assert.ok(Object.keys(a).every((k) => k === "from" || k === "limit"), "no argument names a note");
  }
}

test("P-03 in the Verifier's order: every note, change note, refund note, return, move and second arrival, in its state", async () => {
  const w = verifierOrder(rng(1));
  assert.ok(w.laneMaxGap < TEST_GAP && w.laneMaxGap >= 25, `the case's longest lane gap is ${w.laneMaxGap}`);
  const v = w.v.views();
  const sent: Sent[] = [];
  const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { sent }), gap: TEST_GAP });
  check(w, got, "the Verifier's order");
  checkReads(sent, v);
  const kinds = new Set(got.notes.map((n) => (n.ref.kind === "second" ? `second/${n.ref.id.id}` : n.ref.kind)));
  for (const k of ["deposit", "change", "refund", "return", "move", "second/U", "second/V", "second/A", "second/R"]) assert.ok(kinds.has(k), `the case holds a ${k} note`);
  assert.ok(got.notes.some((n) => n.leaf.value === 0n), "a change note of 0 is a note");
  assert.ok(got.pendingRefunds.length + got.notes.filter((n) => n.ref.kind === "refund").length > 0);
});

const CASES = FULL ? 24 : 4;
test(`P-03 as a property: ${CASES} random orders of the same events, every note found in its state`, async () => {
  for (let c = 0; c < CASES; c++) {
    const w = randomOrder(rng(1000 + c));
    assert.ok(w.laneMaxGap < TEST_GAP, `case ${c}: lane gap ${w.laneMaxGap}`);
    const v = w.v.views();
    const sent: Sent[] = [];
    const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { sent }), gap: TEST_GAP });
    check(w, got, `case ${c}`);
    checkReads(sent, v);
  }
});

test("the gap rule counts within one lane: a lane's note after gap - 1 misses is found, after gap misses it is not", () => {
  // walkLane is the rule itself; the property above runs it on every lane with TEST_GAP, this one at RESTORE_GAP
  // (walkLane's own default, 30,000 derivations) under FULL_RUNS=1 and at TEST_GAP by default
  assert.equal(RESTORE_GAP, 10_000);
  assert.equal(RESTORE_LANES, 8);
  const lane = 3;
  const GAP = FULL ? RESTORE_GAP : TEST_GAP;
  const walk = (has: (p: bigint) => boolean) => (FULL ? walkLane(SEED, SCOPE, lane, has) : walkLane(SEED, SCOPE, lane, has, GAP));
  const at = (pos: number) => sec({ kind: "deposit", s: SCOPE, i: lane + 8 * pos }).precommitment;
  const near = new Set([at(0), at(1 + GAP - 1)]); // GAP - 1 misses between: found
  assert.deepEqual(walk((p) => near.has(p)).found, [lane, lane + 8 * GAP]);
  const far = new Set([at(0), at(1 + GAP)]); // GAP misses between: the walk has stopped
  const stop = walk((p) => far.has(p));
  assert.deepEqual(stop.found, [lane]);
  // it read exactly GAP indices of the lane past its last note, and names the last one's precommitment
  assert.equal(stop.last, lane + 8 * GAP);
  assert.equal(stop.lastPrecommitment, at(GAP));
  // another lane's notes never reset this lane's count, and this lane never reads another's indices
  const mixed = new Set([at(0), sec({ kind: "deposit", s: SCOPE, i: 4 + 8 * 5 }).precommitment, at(9)]);
  assert.deepEqual(walkLane(SEED, SCOPE, lane, (p) => mixed.has(p), 9).found, [lane, lane + 8 * 9]); // 8 misses, then the note
  assert.deepEqual(walkLane(SEED, SCOPE, lane, (p) => mixed.has(p), 8).found, [lane]);
});

test("an empty vault: no note, every lane empty", async () => {
  const v = new Vault().views();
  const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP });
  assert.deepEqual([got.notes, got.spends, got.pendingRefunds], [[], [], []]);
  assert.deepEqual(got.laneHighest, Array(8).fill(null));
});

test("one RPC that differs stops the restore with nothing returned", async () => {
  const w = verifierOrder(rng(2));
  const v = w.v.views();
  const drop = (method: string, view: unknown) => (method === "deposits" && Array.isArray(view) ? view.slice(1) : view);
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { lie: drop }), gap: TEST_GAP }), (e) => e instanceof VaultSyncStopped && e.code === "disagree");
});

test("a deposit row whose leaf is not in the state tree is refused, never written as a note", async () => {
  const w = new World(rng(3));
  w.index(0, "note");
  w.finish();
  const v = w.v.views();
  v.leaves[0] = "12345"; // both RPCs agree on a tree that does not hold the deposit
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP }), /not the state tree's leaf/);
});

test("the restored store equals the store the device wrote as it went, after a wipe (HELD lives only on the lost device)", async () => {
  // the device lives through deposits, a split, a withdrawal with change, a refund note and a second arrival
  const idb = new IDBFactory();
  const ws = await openWalletStore({ indexedDB: idb });
  const ns = await openNoteStore(ws);
  const vault = new Vault();
  const lived: NoteRecord[] = [];
  try {
    const dep = async () => {
      const n = await ns.planDeposit(SCOPE, (ref) => sec(ref).precommitment);
      await ns.move(n.id, "PLANNED", "INCOMING");
      const U = hex64(`U${(n.ref as { i: number }).i}`);
      return ns.move(n.id, "INCOMING", "UNSPENT", { leaf: vault.deposit(n.precommitment, 50_000_000n, U)! });
    };
    const a = await dep();
    const b = await dep();
    // a's split: second arrival 0 of U
    const sref: NoteRef = { kind: "second", id: { id: "U", s: SCOPE, i: (a.ref as { i: number }).i }, n: 0 };
    const s0 = await ns.add({ ref: sref, scope: SCOPE, precommitment: sec(sref).precommitment, state: "PLANNED" });
    await ns.move(s0.id, "PLANNED", "INCOMING");
    await ns.move(s0.id, "INCOMING", "UNSPENT", { leaf: vault.deposit(s0.precommitment, 7_000_000n, hex64("U-split"))! });
    // b's withdrawal: HELD, RESERVED, then landed with a change note and, after a refused payout, a refund note
    const h = await ns.move(b.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: "42" });
    await ns.move(b.id, "HELD", "RESERVED", { attempt: h.attempt });
    const l = b.leaf!.label;
    const cref: NoteRef = { kind: "change", l, j: 0 };
    const wd = vault.withdraw(sec(b.ref).nullifierHash, 20_000_000n, { P: sec(cref).precommitment, value: 30_000_000n, label: l }, sec({ kind: "refund", l, j: 0 }).precommitment, 42n);
    await ns.add({ ref: cref, scope: SCOPE, precommitment: sec(cref).precommitment, state: "UNSPENT", leaf: wd.leaf!, parent: b.id });
    vault.payout(wd.spend, 5_000_000n);
    const rleaf = vault.settle(wd.spend)!;
    const rref: NoteRef = { kind: "refund", l, j: 0 };
    await ns.add({ ref: rref, scope: SCOPE, precommitment: sec(rref).precommitment, state: "UNSPENT", leaf: rleaf });
    // c: ragequit by its depositor, which inserts no change note (2.5.3); the device marks it SPENT by hand
    const c = await dep();
    const hc = await ns.move(c.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: "44" });
    await ns.move(c.id, "HELD", "RESERVED", { attempt: hc.attempt });
    vault.payout(vault.withdraw(sec(c.ref).nullifierHash, c.leaf!.value, null, sec({ kind: "refund", l: c.leaf!.label, j: 0 }).precommitment, 0n).spend, 0n);
    await ns.move(c.id, "RESERVED", "SPENT");
    // a proof started on a's note and not sent: HELD on this device only
    await ns.move(a.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: "43" });
    lived.push(...(await ns.list()));
  } finally {
    ns.close();
    ws.close();
  }

  // the wipe: a new browser, the same 12 words
  const ws2 = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns2 = await openNoteStore(ws2);
  try {
    const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(vault.views()), gap: TEST_GAP });
    await writeRestored(ns2, got);
    const restored = await ns2.list();
    const keyOf = new Map([...lived, ...restored].map((n) => [n.id, refKey(n.ref)]));
    // the chain's fields, byte for byte; HELD and the attempt fields are this device's alone (wallet.md l.392)
    const chainSide = (n: NoteRecord) => ({
      key: refKey(n.ref), ref: n.ref, scope: n.scope, precommitment: n.precommitment, leaf: n.leaf,
      state: n.state === "HELD" || n.state === "RESERVED" ? "UNSPENT" : n.state, parent: n.parent === undefined ? undefined : keyOf.get(n.parent),
    });
    const sort = (xs: ReturnType<typeof chainSide>[]) => xs.sort((x, y) => (x.key < y.key ? -1 : 1));
    assert.deepEqual(sort(restored.map(chainSide)), sort(lived.map(chainSide)));
    assert.ok(restored.every((n) => n.state !== "HELD" && n.contexts === undefined && n.attempt === undefined));
    // a second restore over the same store adds nothing and changes nothing (step 7's second scan)
    await writeRestored(ns2, got);
    assert.deepEqual((await ns2.list()).map(chainSide).sort((x, y) => (x.key < y.key ? -1 : 1)), sort(restored.map(chainSide)));
  } finally {
    ns2.close();
    ws2.close();
  }
});

test("pages the vault could never write stop the restore: a precommitment or a nullifier hash held twice, a change at another leaf", async () => {
  const w = new World(rng(4));
  w.index(0, "note");
  w.withdraw(w.unspent()[0]!);
  w.finish();
  const pages = () => {
    const v = w.v.views();
    return {
      deposits: v.deposits.map((r) => ({ index: r.index, precommitment: BigInt(r.precommitment), label: BigInt(r.label), value: BigInt(r.value), leafIndex: BigInt(r.leaf_index), depositor: r.depositor })),
      spends: w.v.spends.map((x, index) => ({ index, nullifierHash: x.nh, withdrawn: x.withdrawn, newLeafIndex: BigInt(x.newLeaf), refundPrecommitment: x.refundP, refundValue: x.refundValue, refundLabel: x.refundLabel, refundLeafIndex: BigInt(x.refundLeaf), status: x.status, payer: "p.testnet", reserve: 0n, recipient: x.recipient, fee: x.fee, context: x.context })),
      leaves: [...w.v.leaves],
    };
  };
  assert.equal(restorePages(SEED, SCOPE, pages(), { gap: TEST_GAP }).notes.length, 2, "the honest pages: the deposit and its change");
  const twiceP = pages();
  twiceP.deposits.push({ ...twiceP.deposits[0]!, index: 1 });
  assert.throws(() => restorePages(SEED, SCOPE, twiceP, { gap: TEST_GAP }), /precommitment .* twice/);
  const twiceNh = pages();
  twiceNh.spends.push({ ...twiceNh.spends[0]!, index: 1 });
  assert.throws(() => restorePages(SEED, SCOPE, twiceNh, { gap: TEST_GAP }), /nullifier hash .* twice/);
  const moved = pages();
  moved.spends[0]!.newLeafIndex = 0n;
  assert.throws(() => restorePages(SEED, SCOPE, moved, { gap: TEST_GAP }), /its change is at leaf 1, not 0/);
});

// ---------- the independent review's cases (card wallet-restore-notes, review of 740fba4) ----------
// The model vault's pages as restorePages takes them (the rows vaultSync parses).
function pagesOf(v: Vault): { deposits: VaultDepositRow[]; spends: VaultSpendRow[]; leaves: bigint[] } {
  return {
    deposits: v.deposits.map((r, index) => ({ index, precommitment: r.P, label: r.label, value: r.value, leafIndex: BigInt(r.leaf), depositor: r.depositor })),
    spends: v.spends.map((x, index) => ({ index, nullifierHash: x.nh, withdrawn: x.withdrawn, newLeafIndex: BigInt(x.newLeaf), refundPrecommitment: x.refundP, refundValue: x.refundValue, refundLabel: x.refundLabel, refundLeafIndex: BigInt(x.refundLeaf), status: x.status, payer: "p.testnet", reserve: 0n, recipient: x.recipient, fee: x.fee, context: x.context })),
    leaves: [...v.leaves],
  };
}
const dep0: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };

test("R2a: a withdraw of ours (context not 0) whose new leaf is not our change commitment stops the restore", () => {
  const v = new Vault();
  const leaf = v.deposit(sec(dep0).precommitment, 50_000_000n, hex64("U0"))!;
  // the change made on another change index: a drift between the withdrawal and the restore
  const drift = { P: sec({ kind: "change", l: leaf.label, j: 1 }).precommitment, value: 30_000_000n, label: leaf.label };
  v.withdraw(sec(dep0).nullifierHash, 20_000_000n, drift, sec({ kind: "refund", l: leaf.label, j: 0 }).precommitment, 77n);
  assert.throws(() => restorePages(SEED, SCOPE, pagesOf(v), { gap: TEST_GAP }), /change note .*not the state tree's leaf/);
  // a ragequit (context 0) inserts no change: no error, and the note is SPENT
  const q = new Vault();
  const ql = q.deposit(sec(dep0).precommitment, 50_000_000n, hex64("U0"))!;
  q.withdraw(sec(dep0).nullifierHash, ql.value, null, sec({ kind: "refund", l: ql.label, j: 0 }).precommitment, 0n);
  assert.deepEqual(restorePages(SEED, SCOPE, pagesOf(q), { gap: TEST_GAP }).notes.map((n) => [n.ref.kind, n.state]), [["deposit", "SPENT"]]);
});

test("R2b: a refund of value on a refund precommitment that is not refundNote(l, j) stops the restore, settled or pending", () => {
  for (const settle of [true, false]) {
    const v = new Vault();
    const leaf = v.deposit(sec(dep0).precommitment, 50_000_000n, hex64("U0"))!;
    const change = { P: sec({ kind: "change", l: leaf.label, j: 0 }).precommitment, value: 30_000_000n, label: leaf.label };
    const w = v.withdraw(sec(dep0).nullifierHash, 20_000_000n, change, sec({ kind: "refund", l: leaf.label, j: 1 }).precommitment, 77n);
    v.payout(w.spend, 20_000_000n);
    if (settle) v.settle(w.spend);
    assert.throws(() => restorePages(SEED, SCOPE, pagesOf(v), { gap: TEST_GAP }), /refund is on a precommitment that is not refund note/, settle ? "settled" : "refund_pending");
  }
  // a paid spend (refund_value 0) on any refund precommitment is no refund: no error
  const v = new Vault();
  const leaf = v.deposit(sec(dep0).precommitment, 50_000_000n, hex64("U0"))!;
  const w = v.withdraw(sec(dep0).nullifierHash, 20_000_000n, { P: sec({ kind: "change", l: leaf.label, j: 0 }).precommitment, value: 30_000_000n, label: leaf.label }, 99n, 77n);
  v.payout(w.spend, 0n);
  v.settle(w.spend);
  assert.equal(restorePages(SEED, SCOPE, pagesOf(v), { gap: TEST_GAP }).notes.length, 2);
});

test("the walk handed in from outside (the proof pool's workers) gives the same restore; another lane's index is refused", async () => {
  const w = verifierOrder(rng(5));
  const v = w.v.views();
  const inline = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP });
  const lanesAsked: number[] = [];
  const outside = await restoreNotes({
    seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP,
    walk: async (lane, scope, gap, ps) => (lanesAsked.push(lane), assert.equal(scope, SCOPE), assert.equal(gap, TEST_GAP), walkLane(SEED, scope, lane, (p) => ps.has(p), gap)),
  });
  assert.deepEqual(lanesAsked.sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(outside, inline);
  const pages = pagesOf(w.v);
  const has = (p: bigint) => pages.deposits.some((r) => r.precommitment === p);
  const lanes = Array.from({ length: 8 }, (_, lane) => walkLane(SEED, SCOPE, lane, has, TEST_GAP));
  const copy = () => lanes.map((x) => ({ ...x, found: [...x.found] }));
  const wrong = copy();
  wrong[0]!.found.push(1); // lane 1's index in lane 0's walk
  assert.throws(() => restorePages(SEED, SCOPE, pages, { gap: TEST_GAP, lanes: wrong }), /not this lane's/);
  assert.throws(() => restorePages(SEED, SCOPE, pages, { gap: TEST_GAP, lanes: lanes.slice(1) }), /one walk per lane/);
  assert.equal(restorePages(SEED, SCOPE, pages, { gap: TEST_GAP, lanes }).notes.length, inline.notes.length);
});

test("a walk handed in that stopped early, or walked another scope or seed, stops the restore (never fewer notes quietly)", async () => {
  const w = verifierOrder(rng(7));
  const v = w.v.views();
  const pages = pagesOf(w.v);
  const used = w.laneHigh.keys().next().value!;
  // a lane handed in empty (D1b): it ends at the lane's first index, not gap past its notes
  const honest = Array.from({ length: 8 }, (_, lane) => walkLane(SEED, SCOPE, lane, (p) => pages.deposits.some((r) => r.precommitment === p), TEST_GAP));
  const emptied = honest.map((x, lane) => (lane === used ? { found: [], last: lane, lastPrecommitment: sec({ kind: "deposit", s: SCOPE, i: lane }).precommitment } : x));
  assert.throws(() => restorePages(SEED, SCOPE, pages, { gap: TEST_GAP, lanes: emptied }), /the walk ended at/);
  // a walk with a smaller gap than the restore's stops before gap misses past its last note
  await assert.rejects(
    restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP, walk: async (lane, scope, _gap, ps) => walkLane(SEED, scope, lane, (p) => ps.has(p), TEST_GAP - 1) }),
    /the walk ended at/,
  );
  // a walk wired to another token's scope (D1c), or to another seed: no note, a whole walk, the wrong last precommitment
  const otherScope = vaultScopeOf(keccak_256, VAULT, "usdc.other.testnet");
  await assert.rejects(
    restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP, walk: async (lane, _scope, gap, ps) => walkLane(SEED, otherScope, lane, (p) => ps.has(p), gap) }),
    /last precommitment is not this seed's and scope's/,
  );
  await assert.rejects(
    restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v), gap: TEST_GAP, walk: async (lane, scope, gap, ps) => walkLane(OTHER, scope, lane, (p) => ps.has(p), gap) }),
    /last precommitment is not this seed's and scope's/,
  );
});

test("the vault's config on both RPCs: a wrong token or scope is refused, the two final heights come back", async () => {
  const w = verifierOrder(rng(6));
  const v = w.v.views();
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: "usdc.other.testnet", rpcs: rpcs(v), gap: TEST_GAP }), /scope .* is not the one computed/);
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { config: config(TOKEN, SCOPE + 1n) }), gap: TEST_GAP }), /scope .* is not the one computed/);
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { config: config("usdc.other.testnet") }), gap: TEST_GAP }), /asset usdc.other.testnet is not/);
  const one = (m: string, view: unknown) => (m === "config" ? { ...(view as object), version: "other" } : view);
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { lie: one }), gap: TEST_GAP }), /config: the RPCs' answers differ/);
  const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { finals: [H + 3, H] }), gap: TEST_GAP });
  assert.equal(got.height, H);
  assert.deepEqual(got.finalHeights, [H + 3, H]);
  // final heights further apart than VAULT_SYNC_LAG_MAX (D3): one RPC is stuck or lying; refused, as vaultSync's probe
  const far = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { finals: [H + VAULT_SYNC_LAG_MAX, H] }), gap: TEST_GAP });
  assert.deepEqual(far.finalHeights, [H + VAULT_SYNC_LAG_MAX, H]);
  // config read after the pages: rpc-b's config final far ahead of its page reads
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { configFinalB: H + VAULT_SYNC_LAG_MAX + 1 }), gap: TEST_GAP }), /over 120 blocks apart/);
  // an abort while config is read ends the restore at once, even with an RPC that never answers
  const ctl = new AbortController();
  const hang = rpcs(v);
  const b0 = hang[1];
  hang[1] = { name: b0.name, query: (p, sig) => (p.method_name === "config" ? (setTimeout(() => ctl.abort(new Error("stopped by the user")), 10), new Promise(() => {})) : b0.query(p, sig)) };
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: hang, gap: TEST_GAP, signal: ctl.signal }), /stopped by the user/);
  // an RPC whose final block, read after the pages, is below the block the pages were read at: refused
  await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v, { configFinalB: H - 1 }), gap: TEST_GAP }), /near-testnet\.drpc\.org: config: its final height .* is below the pages'/);
});

test("restore reads only a release pair: two hosts of one operator, or unnamed providers, are refused before any read", async () => {
  const v = verifierOrder(rng(6)).v.views();
  const sent: Sent[] = [];
  const [a, b] = rpcs(v, { sent });
  const as = (r: VaultSyncRpc, name: string): VaultSyncRpc => ({ name, query: r.query });
  const net = NEAR_NETWORKS.testnet;
  for (const pair of [[as(a, net.fastnear[0]), as(b, net.fastnear[1])], [as(a, "rpc-a"), as(b, "rpc-b")], [as(a, net.drpc), as(b, net.drpc)], [as(a, NEAR_NETWORKS.mainnet.fastnear[0]), b]] as [VaultSyncRpc, VaultSyncRpc][])
    await assert.rejects(restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: pair, gap: TEST_GAP }), /exactly/);
  assert.equal(sent.length, 0);
});

async function liveStore() {
  const ws = await openWalletStore({ indexedDB: new IDBFactory() });
  const ns = await openNoteStore(ws);
  return { ns, close: () => (ns.close(), ws.close()) };
}

test("R3a: HELD and RESERVED notes the vault shows spent by ragequit (no child) go to SPENT", async () => {
  const v = new Vault();
  const { ns, close } = await liveStore();
  try {
    const land = async () => {
      const n = await ns.planDeposit(SCOPE, (ref) => sec(ref).precommitment);
      await ns.move(n.id, "PLANNED", "INCOMING");
      return ns.move(n.id, "INCOMING", "UNSPENT", { leaf: v.deposit(n.precommitment, 9_000_000n, hex64(n.id))! });
    };
    const a = await land();
    const b = await land();
    await ns.move(a.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: "1" });
    const hb = await ns.move(b.id, "UNSPENT", "HELD", { deadlineMs: 1_800_000_000_000n, context: "2" });
    await ns.move(b.id, "HELD", "RESERVED", { attempt: hb.attempt });
    for (const n of [a, b]) v.withdraw(sec(n.ref).nullifierHash, n.leaf!.value, null, sec({ kind: "refund", l: n.leaf!.label, j: 0 }).precommitment, 0n);
    const out = await writeRestored(ns, await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v.views()), gap: TEST_GAP }));
    const after = new Map(out.notes.map((n) => [n.id, n.state]));
    assert.equal(after.get(a.id), "SPENT");
    assert.equal(after.get(b.id), "SPENT");
    assert.deepEqual(out.leftAlone, []);
  } finally {
    close();
  }
});

test("R3b: a store note on the same ref with another precommitment stops writeRestored", async () => {
  const v = new Vault();
  const { ns, close } = await liveStore();
  try {
    const n = await ns.planDeposit(SCOPE, () => 12345n); // a broken record: ref deposit i, a precommitment that is not its
    v.deposit(sec(n.ref).precommitment, 3_000_000n, hex64("U"));
    const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v.views()), gap: TEST_GAP });
    assert.equal(got.notes.length, 1);
    await assert.rejects(writeRestored(ns, got), /another precommitment/);
  } finally {
    close();
  }
});

test("R3c, R3d and D5: a TAKEN index and an INCOMING note the vault holds come back in leftAlone; notes below TAKEN are written, notes below INCOMING wait", async () => {
  const v = new Vault();
  const { ns, close } = await liveStore();
  try {
    const t = await ns.planDeposit(SCOPE, (ref) => sec(ref).precommitment);
    await ns.move(t.id, "PLANNED", "TAKEN"); // the other device used the index
    const tl = v.deposit(t.precommitment, 40_000_000n, hex64("other device"))!; // its 40 USDC on this seed's P
    // that device's withdrawal from it: a change note below the TAKEN record
    const cref: NoteRef = { kind: "change", l: tl.label, j: 0 };
    v.withdraw(sec(t.ref).nullifierHash, 10_000_000n, { P: sec(cref).precommitment, value: 30_000_000n, label: tl.label }, sec({ kind: "refund", l: tl.label, j: 0 }).precommitment, 9n);
    const n = await ns.planDeposit(SCOPE, (ref) => sec(ref).precommitment);
    await ns.move(n.id, "PLANNED", "INCOMING");
    const nl = v.deposit(n.precommitment, 8_000_000n, hex64("U"))!;
    // spent elsewhere, with a change note below the INCOMING record
    const nref: NoteRef = { kind: "change", l: nl.label, j: 0 };
    v.withdraw(sec(n.ref).nullifierHash, 3_000_000n, { P: sec(nref).precommitment, value: 5_000_000n, label: nl.label }, sec({ kind: "refund", l: nl.label, j: 0 }).precommitment, 8n);
    const got = await restoreNotes({ seed64: SEED, vault: VAULT, token: TOKEN, rpcs: rpcs(v.views()), gap: TEST_GAP });
    const out = await writeRestored(ns, got);
    const left = out.leftAlone.map((x) => [x.key, x.stored, x.vault, x.why]).sort();
    assert.deepEqual(left, [
      [refKey(t.ref), "TAKEN", "SPENT", "taken"],
      [refKey(n.ref), "INCOMING", "SPENT", "incoming"],
      [refKey(nref), null, "UNSPENT", "parent"],
    ].sort());
    const states = new Map(out.notes.map((x) => [x.id, x.state]));
    assert.equal(states.get(t.id), "TAKEN");
    assert.equal(states.get(n.id), "INCOMING");
    // TAKEN is terminal: the other device's 30 USDC change is written, spendable, with no parent (D5)
    const ch = out.notes.find((x) => refKey(x.ref) === refKey(cref));
    assert.ok(ch && ch.state === "UNSPENT" && ch.parent === undefined && ch.leaf?.value === 30_000_000n, "the change below TAKEN is written UNSPENT");
    // INCOMING still lands by the deposit's own confirm: nothing below it is written yet
    assert.equal(out.notes.find((x) => refKey(x.ref) === refKey(nref)), undefined);
    assert.equal(out.notes.length, 3);
  } finally {
    close();
  }
});
