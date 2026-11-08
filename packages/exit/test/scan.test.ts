// Card exit-note-scan: the exit tool's note scan (src/scan.ts) from the 12 words alone. A model vault takes the events of
// the wallet's P-03 (docs/plan1/wallet.md l.1061-1067; the wallet's own run is packages/wallet/test/note-restore.test.ts)
// and serves its pages in the vault's serde form (contracts/vault/src/lib.rs DepositView, SpendView, TreeView) on the
// release's two testnet RPCs; the scan must find every note the device owns, byte for byte, in its right state, and take
// no stranger's leaf on one of our precommitments.
//   node --test test/scan.test.ts      (from packages/exit)
// The model is rebuilt here from the kit's ./core (the wallet's own noteSecrets and noteCommitment): packages/exit may
// import only its own files and the kit's entries. Test secrets come from published BIP-39 vectors (all-zero entropy:
// the user, the wallet's A.8 seed, packages/wallet/test/vectors/a8.json; 0x7f entropy: another user), never money.
// The model's labels are distinct field values made with sha256: restore reads each label off its row and never
// recomputes one, so they need not be the vault's keccak labels.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VAULT_CONSTANTS, VAULT_FIELD_P, VaultSyncStopped, type VaultSyncRpc } from "@blindfill/kit";
import { entropyToWords, noteCommitment, noteSecrets, refKey, RESTORE_LANES, typedSeed, wordsToSeed64, type NoteRef } from "@blindfill/kit/core";
import { EXIT_NETWORKS, ExitRpcRefused } from "../src/rpc.ts";
import { EXIT_TOKENS, exitScan, withSeed64, type ExitScan } from "../src/scan.ts";

const ROOT = new URL("../../../", import.meta.url);
const record = (n: string) => JSON.parse(readFileSync(new URL(`contracts/vault/deployments/${n}`, ROOT), "utf8")) as { account_id: string; asset: string; scope: string };
const TESTNET = record("testnet-v1.json");
const VAULT = EXIT_NETWORKS.testnet.vault;
const TOKEN = EXIT_TOKENS.testnet;
const SCOPE = BigInt(TESTNET.scope); // restore checks it against the scope it computes from (vault, token)
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SEED = wordsToSeed64(WORDS);
const OTHER = wordsToSeed64(entropyToWords(new Uint8Array(16).fill(0x7f)));
const TEST_GAP = 64; // the walk's gap here; every generated lane gap is checked to be below it
const CASES = process.env.FULL_RUNS === "1" ? 24 : 6;
// the wallet's six chain tags (packages/wallet/src/derive/constants.ts CHAINS): restore walks a return on each
const CHAIN_TAGS: readonly Extract<NoteRef, { kind: "return" }>["c"][] = ["sol", "evm", "near", "hop-sol", "hop-evm", "hop-near"];

type Leaf = { value: bigint; label: bigint; commitment: bigint; leafIndex: bigint };

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
  return { int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]!, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hex64 = (s: string) => sha(s);
const fieldOf = (s: string) => BigInt(`0x${sha(s)}`) % VAULT_FIELD_P;

// ---------- the model vault (its rows as lib.rs's views write them) ----------
type Spend = {
  nh: bigint; withdrawn: bigint; newLeaf: number; refundP: bigint; refundValue: bigint; refundLabel: bigint; refundLeaf: number;
  status: "in_flight" | "paid" | "refund_pending" | "settled"; recipient: string; fee: bigint; context: bigint;
};
class Vault {
  nonce = 0;
  deposits: { P: bigint; label: bigint; value: bigint; leaf: number; depositor: string }[] = [];
  spends: Spend[] = [];
  leaves: bigint[] = [];
  labels: bigint[] = [];
  usedP = new Set<bigint>();
  spent = new Set<bigint>();
  label(): bigint {
    return fieldOf(`label ${++this.nonce}`);
  }
  deposit(P: bigint, value: bigint, depositor: string): Leaf | null {
    if (this.usedP.has(P)) return null; // the vault refuses a precommitment it holds as a deposit
    this.usedP.add(P);
    const label = this.label();
    const commitment = noteCommitment(value, label, P);
    const leaf = this.leaves.push(commitment) - 1;
    this.labels.push(label);
    this.deposits.push({ P, label, value, leaf, depositor });
    return { value, label, commitment, leafIndex: BigInt(leaf) };
  }
  // 2.5.2 rows 11-12: spent, the change inserted even when 0; a ragequit (2.5.3) inserts none and writes context 0
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
      const label = this.label();
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
        payer: "relayer.bf-exit.testnet", reserve: "0", recipient: s.recipient, fee: String(s.fee), context: String(s.context),
      })),
      leaves: this.leaves.map(String),
      labels: this.labels.map(String),
    };
  }
}

// ---------- the release's two testnet RPCs, serving the views at one block as near RPC answers ----------
type View = ReturnType<Vault["views"]>;
const H = 275_800_000;
const CONFIG = { version: "blindfill-vault 0.1.0 testnet", asset: TOKEN, scope: String(SCOPE), max_tree_depth: 32, min_deposit: "1000000", max_relay_fee_bps: 5000, page_max: VAULT_CONSTANTS.PAGE_MAX };
function rpcs(v: View, lie?: (method: string, view: unknown) => unknown, urls: readonly [string, string] = EXIT_NETWORKS.testnet.rpcs): [VaultSyncRpc, VaultSyncRpc] {
  const one = (name: string, liar: boolean): VaultSyncRpc => ({
    name,
    async query(p) {
      const method = p.method_name as string;
      const args = JSON.parse(atob(p.args_base64 as string)) as { from?: number; limit?: number };
      const at = p.finality === "final" ? H : (p.block_id as number);
      let view: unknown;
      if (method === "config") view = CONFIG;
      else if (method === "state_tree" || method === "label_tree") view = v[method];
      else {
        const list = v[method as "deposits" | "spends" | "leaves" | "labels"] as unknown[];
        const start = Math.min(args.from!, list.length);
        view = list.slice(start, Math.min(start + Math.min(args.limit!, VAULT_CONSTANTS.PAGE_MAX), list.length));
      }
      if (liar && lie) view = lie(method, view);
      return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${at}`, block_height: at, logs: [], result: [...new TextEncoder().encode(JSON.stringify(view))] } };
    },
  });
  return [one(urls[0], false), one(urls[1], true)];
}
const scan = (v: Vault, words = WORDS) => exitScan({ words, network: "testnet", rpcs: rpcs(v.views()), gap: TEST_GAP });

// ---------- the device's truth: every note it owns in the vault, as it wrote them ----------
type Truth = { ref: NoteRef; precommitment: bigint; leaf: Leaf; spent: boolean; parent?: string };
const sec = (ref: NoteRef) => noteSecrets(SEED, ref);
const jOf = (ref: NoteRef) => (ref.kind === "change" ? ref.j + 1 : 0); // the change index: a label's first note is 0
type SecondId = Extract<NoteRef, { kind: "second" }>["id"];

class World {
  v = new Vault();
  own = new Map<string, Truth>();
  lanePos = new Map<number, number>();
  laneMiss = new Map<number, number>();
  laneMaxGap = 0;
  laneHigh = new Map<number, number>();
  seconds = new Map<string, number>();
  pending: { spend: number; l: bigint; j: number }[] = [];
  pendingOwn: number[] = [];
  withdrawals: { spend: number; l: bigint; j: number; note: string }[] = [];
  arms: { l: bigint; j: number }[] = [];
  otherN = 0;
  r: Rng;
  constructor(r: Rng) {
    this.r = r;
  }

  land(ref: NoteRef, leaf: Leaf | null, parent?: string): void {
    if (!leaf) return;
    const key = refKey(ref);
    assert.ok(!this.own.has(key), `the model lands ${key} once`);
    this.own.set(key, { ref, precommitment: sec(ref).precommitment, leaf, spent: false, ...(parent ? { parent } : {}) });
  }
  index(lane: number, what: "note" | "miss" | "dust"): void {
    const pos = this.lanePos.get(lane) ?? 0;
    this.lanePos.set(lane, pos + 1);
    const i = lane + RESTORE_LANES * pos;
    if (what === "miss") return void this.laneMiss.set(lane, (this.laneMiss.get(lane) ?? 0) + 1);
    this.laneMaxGap = Math.max(this.laneMaxGap, this.laneMiss.get(lane) ?? 0);
    this.laneMiss.set(lane, 0);
    this.laneHigh.set(lane, i);
    const ref: NoteRef = { kind: "deposit", s: SCOPE, i };
    if (what === "dust") {
      // a dust front-run on our P: the attacker's dust is a note on our secrets; our money goes on n = 0
      this.land(ref, this.v.deposit(sec(ref).precommitment, 1n, hex64("attacker")));
      this.second({ id: "U", s: SCOPE, i }, this.value());
    } else {
      this.land(ref, this.v.deposit(sec(ref).precommitment, this.value(), hex64(`U${i}`)));
      for (let k = this.r.int(3); k > 0; k--) this.second({ id: "U", s: SCOPE, i }, this.value());
    }
  }
  second(id: SecondId, value: bigint): void {
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
    const take = withdrawn > n.leaf.value ? n.leaf.value : withdrawn;
    const cref: NoteRef = { kind: "change", l, j };
    const w = this.v.withdraw(sec(n.ref).nullifierHash, take, { P: sec(cref).precommitment, value: n.leaf.value - take, label: l }, refundP, BigInt(1 + this.r.int(1e9)));
    this.withdrawals.push({ spend: w.spend, l, j, note: key });
    this.land(cref, w.leaf, key);
    const out = this.r.int(10);
    if (out < 6) this.v.payout(w.spend, 0n);
    else if (out < 9) this.v.payout(w.spend, BigInt(1 + this.r.int(Number(take))));
    if (out < 9) this.pending.push({ spend: w.spend, l, j });
    this.arms.push({ l, j });
    return { l, j };
  }
  settleOne(): void {
    if (this.pending.length === 0) return;
    const p = this.pending.splice(this.r.int(this.pending.length), 1)[0]!;
    const leaf = this.v.settle(p.spend);
    if (leaf) this.land({ kind: "refund", l: p.l, j: p.j }, leaf, this.withdrawals.find((w) => w.spend === p.spend)!.note);
  }
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

// P-03's own list, in the Verifier's order (wallet.md l.1067), as the wallet's run has it
function verifierOrder(r: Rng): World {
  const w = new World(r);
  const [A, B, C] = [2, 5, 7];
  for (let k = 0; k < 21; k++) w.index(A, "note");
  for (let k = 0; k < 25; k++) w.index(A, "miss");
  w.index(A, "note");
  w.withdraw(w.unspent()[0]!); // a stuck return under R: nothing in the vault from it
  for (let k = 0; k < 19; k++) w.armBack(w.withdraw(w.unspent()[k]!), "return");
  w.second({ id: "U", s: SCOPE, i: A + 8 * 3 }, w.value());
  w.index(A, "dust");
  w.withdraw(w.unspent()[1]!);
  for (let k = 0; k < 6; k++) w.settleOne();
  w.armBack(w.withdraw(w.unspent()[2]!), "wm11");
  for (let k = 0; k < 25; k++) w.withdraw(w.unspent()[k]!);
  for (let k = 0; k < 4; k++) w.index(B, "note");
  w.index(B, "miss");
  w.index(B, "note");
  w.index(B, "miss");
  w.index(B, "miss");
  w.index(B, "note");
  w.index(C, "note");
  w.armBack(w.withdraw(w.unspent()[3]!), "second-return");
  w.armBack(w.withdraw(w.unspent()[4]!), "second-move");
  const two = w.withdraw(w.unspent()[5]!);
  w.armBack(two, "wm11");
  w.armBack(two, "wm11");
  w.second({ id: "U", s: SCOPE, i: B }, w.value());
  w.withdraw(w.unspent().find((n) => n.ref.kind === "deposit")!, { ragequit: true });
  for (let k = 0; k < 6; k++) w.other();
  const refund = [...w.own.values()].find((n) => n.ref.kind === "refund" && !n.spent);
  if (refund) w.withdraw(refund);
  for (let k = 0; k < 3; k++) {
    const ch = w.unspent().find((n) => n.ref.kind === "change");
    if (ch) w.withdraw(ch);
  }
  for (let k = 0; k < 4; k++) w.settleOne();
  w.finish();
  return w;
}

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

// ---------- what the scan must give ----------
function check(w: World, got: ExitScan, what: string): void {
  assert.deepEqual([got.network, got.vault, got.token], ["testnet", VAULT, TOKEN]);
  const want = [...w.own.entries()].map(([key, n]) => ({ key, precommitment: n.precommitment, leaf: n.leaf, state: n.spent ? "SPENT" : "UNSPENT", parent: n.parent }));
  const have = got.notes.map((n) => ({ key: refKey(n.ref), precommitment: n.precommitment, leaf: n.leaf, state: n.state, parent: n.parent }));
  const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : 1);
  assert.deepEqual(have.slice().sort(byKey), want.slice().sort(byKey), `${what}: every note, byte for byte, in its state`);
  for (const n of got.notes) {
    assert.equal(n.scope, SCOPE);
    assert.equal(n.precommitment, sec(n.ref).precommitment, `${what}: ${refKey(n.ref)} is the device's own precommitment`);
    assert.equal(n.leaf.commitment, noteCommitment(n.leaf.value, n.leaf.label, n.precommitment));
  }
  const seen = new Set<string>();
  for (const n of got.notes) {
    if (n.parent) assert.ok(seen.has(n.parent), `${what}: ${refKey(n.ref)} before its parent`);
    seen.add(refKey(n.ref));
  }
  const spends = (xs: { spend: number; l: bigint; j: number; note: string }[]) => xs.slice().sort((a, b) => a.spend - b.spend);
  assert.deepEqual(spends(got.spends.map((x) => ({ spend: x.spend.index, l: x.l, j: x.j, note: x.note }))), spends(w.withdrawals), `${what}: every withdrawal of ours`);
  assert.deepEqual(got.pendingRefunds.map((x) => x.spend.index).sort((a, b) => a - b), w.pendingOwn.slice().sort((a, b) => a - b), `${what}: every refund still to settle`);
  assert.deepEqual(got.laneHighest, Array.from({ length: RESTORE_LANES }, (_, k) => w.laneHigh.get(k) ?? null), `${what}: each lane's highest deposit index`);
}

test("the scan reads the release's vault and token: each network's deploy record", () => {
  for (const n of ["mainnet", "testnet"] as const) {
    const r = record(`${n}-v1.json`);
    assert.equal(EXIT_NETWORKS[n].vault, r.account_id, n);
    assert.equal(EXIT_TOKENS[n], r.asset, n);
  }
  assert.ok(Object.isFrozen(EXIT_TOKENS));
});

test("P-03 in the Verifier's order: the 12 words find every note kind, each followed through its spends", async () => {
  const w = verifierOrder(rng(1));
  assert.ok(w.laneMaxGap < TEST_GAP && w.laneMaxGap >= 25, `the case's longest lane gap is ${w.laneMaxGap}`);
  const got = await scan(w.v);
  check(w, got, "the Verifier's order");
  const kinds = new Set(got.notes.map((n) => (n.ref.kind === "second" ? `second/${n.ref.id.id}` : n.ref.kind)));
  for (const k of ["deposit", "change", "refund", "return", "move", "second/U", "second/V", "second/A", "second/R"]) assert.ok(kinds.has(k), `the case holds a ${k} note`);
  assert.ok(got.notes.some((n) => n.ref.kind === "change" && n.state === "SPENT"), "a change of change");
  assert.ok(got.notes.some((n) => n.ref.kind === "refund" && n.state === "SPENT"), "a refund note's own chain");
  assert.ok(got.notes.some((n) => n.leaf.value === 0n), "a change note of 0 is a note");
});

test(`P-03 as a property: ${CASES} random orders of the same events, every note found in its state`, async () => {
  for (let c = 0; c < CASES; c++) {
    const w = randomOrder(rng(1000 + c));
    assert.ok(w.laneMaxGap < TEST_GAP, `case ${c}: lane gap ${w.laneMaxGap}`);
    check(w, await scan(w.v), `case ${c}`);
  }
});

test("typed words as a person types them (case, spaces) find the same notes; words that are not 12 valid ones are refused", async () => {
  const w = verifierOrder(rng(1));
  const typed = `  ${WORDS.toUpperCase().split(" ").join("   ")}\n`;
  check(w, await scan(w.v, typed), "typed");
  for (const bad of [WORDS.replace(/about$/, "abandon"), WORDS.split(" ").slice(0, 11).join(" "), `${WORDS} abandon`, ""])
    await assert.rejects(scan(w.v, bad), (e: Error) => e.name === "WordsRefused", JSON.stringify(bad));
});

// The card's planted case: our withdrawal bounces, and the vault writes a refund F of 500 USDC on R = refund(l, j). A
// stranger reads R off the spend row and deposits 1 USDC on it: a second leaf on R, with F's nullifier. Taken as the
// refund, its spend would mark that nullifier spent and burn F. The scan takes F only, and once F is spent it follows F.
test("a stranger's 1 USDC on our refund R next to a bounced refund F of 500 is never taken: F is spent, never burned by the twin", async () => {
  for (const when of ["pending", "stranger first", "stranger after"] as const) {
    const v = new Vault();
    const dep: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
    const leaf0 = v.deposit(sec(dep).precommitment, 800_000_000n, hex64("U0"))!;
    const l = leaf0.label;
    const cref: NoteRef = { kind: "change", l, j: 0 };
    const rref: NoteRef = { kind: "refund", l, j: 0 };
    const R = sec(rref).precommitment;
    const w = v.withdraw(sec(dep).nullifierHash, 500_000_000n, { P: sec(cref).precommitment, value: 300_000_000n, label: l }, R, 77n);
    v.payout(w.spend, 500_000_000n); // the whole payout bounced
    let twin: Leaf | null = null;
    let F: Leaf | null = null;
    if (when !== "stranger after") twin = v.deposit(R, 1_000_000n, hex64("stranger"));
    if (when !== "pending") F = v.settle(w.spend);
    if (when === "stranger after") twin = v.deposit(R, 1_000_000n, hex64("stranger"));
    assert.ok(twin, `${when}: the vault takes the stranger's deposit on R`);
    assert.equal(sec(rref).nullifierHash, noteSecrets(SEED, rref).nullifierHash, "one nullifier for every leaf on R");

    const r1 = await scan(v);
    const onR = r1.notes.filter((n) => n.precommitment === R);
    assert.ok(!r1.notes.some((n) => n.leaf.leafIndex === twin!.leafIndex), `${when}: the twin's leaf is never a note`);
    if (when === "pending") {
      assert.deepEqual(onR, [], "a pending refund is no note yet, and the twin is not it");
      assert.deepEqual(r1.pendingRefunds.map((x) => x.spend.index), [w.spend], "the pending refund is handed back to be settled");
      continue;
    }
    assert.deepEqual(onR.map((n) => [refKey(n.ref), n.state, n.leaf]), [[refKey(rref), "UNSPENT", F]], `${when}: one note on R, F at the leaf the spend row names`);
    assert.equal(onR[0]!.leaf.value, 500_000_000n);

    // the exit spends F: 450 out, its change of 50 inserted on F's own change precommitment
    const fChange: NoteRef = { kind: "change", l: F!.label, j: 0 };
    const spendF = v.withdraw(sec(rref).nullifierHash, 450_000_000n, { P: sec(fChange).precommitment, value: 50_000_000n, label: F!.label }, sec({ kind: "refund", l: F!.label, j: 0 }).precommitment, 78n);
    v.payout(spendF.spend, 0n);
    const r2 = await scan(v);
    const at = (ref: NoteRef) => r2.notes.find((n) => refKey(n.ref) === refKey(ref));
    assert.equal(at(rref)?.state, "SPENT", `${when}: F is spent`);
    assert.deepEqual(at(rref)?.leaf, F, `${when}: the note spent is F`);
    assert.deepEqual([at(fChange)?.leaf, at(fChange)?.state, at(fChange)?.parent], [spendF.leaf, "UNSPENT", refKey(rref)], `${when}: F's change of 50 is found`);
    assert.ok(!r2.notes.some((n) => n.leaf.leafIndex === twin!.leafIndex), `${when}: the twin's leaf is never a note`);
    assert.deepEqual(r2.notes.map((n) => refKey(n.ref)).sort(), [dep, cref, rref, fChange].map(refKey).sort(), `${when}: ours only`);
  }
});

test("pages the vault could never write stop the scan: our refund of value on a precommitment that is not refund(l, j)", async () => {
  const v = new Vault();
  const dep: NoteRef = { kind: "deposit", s: SCOPE, i: 0 };
  const leaf0 = v.deposit(sec(dep).precommitment, 800_000_000n, hex64("U0"))!;
  const X = sec({ kind: "deposit", s: SCOPE, i: 9 }).precommitment; // one of ours, not this spend's refund precommitment
  const w = v.withdraw(sec(dep).nullifierHash, 500_000_000n, { P: sec({ kind: "change", l: leaf0.label, j: 0 }).precommitment, value: 300_000_000n, label: leaf0.label }, X, 77n);
  v.payout(w.spend, 500_000_000n);
  v.settle(w.spend);
  await assert.rejects(scan(v), /not refund note/);
});

test("the scan is refused before any read: an unknown network, a pair that is not the release's", async () => {
  const v = new Vault().views();
  await assert.rejects(exitScan({ words: WORDS, network: "devnet" as "testnet", rpcs: rpcs(v) }), ExitRpcRefused);
  const sent: string[] = [];
  const spy = (name: string): VaultSyncRpc => ({ name, query: async () => void sent.push(name) });
  await assert.rejects(exitScan({ words: WORDS, network: "testnet", rpcs: [spy("https://test.rpc.fastnear.com"), spy("https://rpc.testnet.fastnear.com")] }), ExitRpcRefused);
  await assert.rejects(exitScan({ words: WORDS, network: "mainnet", rpcs: rpcs(v) }), ExitRpcRefused);
  assert.deepEqual(sent, []);
});

test("one RPC that differs by a byte stops the scan with nothing returned", async () => {
  const w = verifierOrder(rng(2));
  const drop = (method: string, view: unknown) => (method === "deposits" && Array.isArray(view) ? view.slice(1) : view);
  await assert.rejects(exitScan({ words: WORDS, network: "testnet", rpcs: rpcs(w.v.views(), drop), gap: TEST_GAP }), (e) => e instanceof VaultSyncStopped && e.code === "disagree");
});

test("the entropy is zeroed once seed64 is made, and seed64 once the scan ends, on every path", async () => {
  const seeds: { entropy: Uint8Array }[] = [];
  const seedOf: typeof typedSeed = (t) => {
    const s = typedSeed(t);
    seeds.push(s);
    return s;
  };
  const zero = (b: Uint8Array) => b.length > 0 && b.every((x) => x === 0);
  // a8's seed is all-zero entropy, so the entropy is checked on 0x7f words, whose entropy is not zero
  const otherWords = entropyToWords(new Uint8Array(16).fill(0x7f));
  let held: Uint8Array | undefined;
  const got = await withSeed64(otherWords, async (s64) => {
    assert.ok(zero(seeds[0]!.entropy), "the entropy is zero while seed64 is in use");
    assert.deepEqual(s64, OTHER, "seed64 is the wallet's for the words");
    held = s64;
    return "done";
  }, seedOf);
  assert.equal(got, "done");
  assert.ok(zero(held!), "seed64 is zero after the scan");
  // the same when the scan throws
  await assert.rejects(withSeed64(otherWords, async (s64) => {
    held = s64;
    throw new Error("the read stopped");
  }, seedOf), /the read stopped/);
  assert.ok(zero(seeds[1]!.entropy) && zero(held!), "zeroed when the scan throws");
  // and when seed64 cannot be made, the entropy is still zeroed
  const broken: typeof typedSeed = (t) => {
    const s = typedSeed(t);
    seeds.push(s);
    return { ...s, entropy: s.entropy.subarray(0, 15) }; // entropyToWords refuses 15 bytes
  };
  await assert.rejects(withSeed64(otherWords, async () => "never", broken));
  assert.ok(zero(seeds[2]!.entropy.subarray(0, 15)), "the entropy is zeroed when seed64 fails");
});

test("scan.ts runs the wallet's restore through the kit's ./core and holds no walk of its own", () => {
  const src = readFileSync(new URL("../src/scan.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /import \{[^}]*\brestoreNotes\b[^}]*\} from "@blindfill\/kit\/core";/);
  // exitScan makes seed64 only through withSeed64, the zeroing path the test above holds
  assert.match(src, /await withSeed64\(a\.words, \(seed64\) =>\s*restoreNotes\(\{ seed64,/);
  assert.equal(src.match(/wordsToSeed64\(/g)?.length, 1, "seed64 is made in one place");
  for (const copy of [/poseidon/i, /\bnoteSecrets\b/, /\bwalkLane\b/, /\brestorePages\b/, /\bprecommitments?\s*\.(has|get)\b/, /@noble\/hashes/])
    assert.doesNotMatch(src, copy, `scan.ts holds ${copy}`);
});
