// node --test packages/kit/test/vault-settle.test.ts: the device's own settle (src/vault/settle.ts, card vault-kit-settle;
// the vault paper V4.1 and 2.5.5), reached only through the kit's public entry. A fake vault on two RPCs serves its
// views as contracts/vault/src/lib.rs pages them, and applies a settle the way contracts/vault/src/settle.rs does (the
// refund note's commitment, then its label, appended; refund_label and refund_leaf_index written; settled, reserve 0)
// one block after the sender hands it the call. Test values only, never money.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Kit from "../src/index.ts";

const { VAULT_CONSTANTS, VAULT_SETTLE_GAS, VAULT_SETTLE_REFUND_ATTACH, vaultCommitment, vaultSettleCall, vaultSettleOwn } = Kit;
type Call = Kit.VaultSettleCall;

const VAULT = "vault.bf-test.testnet";
const SCOPE = 4242n;
const H0 = 1000;
const NOOP_WAITS = [0, 0, 0];

type Row = {
  index: number; nullifier_hash: string; withdrawn: string; new_leaf_index: number; refund_precommitment: string; refund_value: string;
  refund_label: string; refund_leaf_index: number; status: string; payer: string; reserve: string; recipient: string; fee: string; context: string;
};
type Snap = { leaves: string[]; labels: string[]; spends: Row[] };

function row(index: number, nf: bigint, rP: bigint, status: string, refund: bigint, more: Partial<Row> = {}): Row {
  return {
    index, nullifier_hash: String(nf), withdrawn: "7000000", new_leaf_index: index + 2, refund_precommitment: String(rP), refund_value: String(refund),
    refund_label: "0", refund_leaf_index: 0, status, payer: "relayer.bf-test.testnet", reserve: "3890000000000000000000", recipient: "alice.bf-test.testnet",
    fee: "100000", context: String(900n + BigInt(index)), ...more,
  };
}

/** A vault: snapshots by height; final the newest. `settle` applies the vault's own step 2 and 3 one block later. */
function vault(first: Snap) {
  const snaps = new Map<number, Snap>([[H0, structuredClone(first)]]);
  let final = H0;
  let nonce = 50n;
  const calls: Call[] = [];
  const at = (h: number) => snaps.get([...snaps.keys()].filter((k) => k <= h).sort((a, b) => b - a)[0] as number) as Snap;
  const view = (s: Snap, method: string, args: { from?: number; limit?: number }) => {
    const tree = (l: string[]) => ({ size: l.length, depth: l.length <= 1 ? 0 : Math.ceil(Math.log2(l.length)), root: String(l.length) });
    if (method === "state_tree") return tree(s.leaves);
    if (method === "label_tree") return tree(s.labels);
    const list = s[method as "leaves" | "labels" | "spends"];
    const start = Math.min(args.from as number, list.length);
    return list.slice(start, Math.min(start + Math.min(args.limit as number, VAULT_CONSTANTS.PAGE_MAX), list.length));
  };
  const rpc = (name: string): Kit.VaultSyncRpc => ({
    name,
    async query(p) {
      const h = p.finality === "final" ? final : (p.block_id as number);
      const v = view(at(h), p.method_name as string, JSON.parse(atob(p.args_base64 as string)));
      return { jsonrpc: "2.0", id: "x", result: { block_hash: `hash-${h}`, block_height: h, logs: [], result: [...new TextEncoder().encode(JSON.stringify(v))] } };
    },
  });
  /** The vault's settle on the newest state, one block on. */
  const settle = (nf: bigint) => {
    const s = structuredClone(at(final));
    const r = s.spends.find((x) => x.nullifier_hash === String(nf));
    if (r === undefined) throw new Error("UnknownSpend");
    if (r.status === "settled") throw new Error("AlreadySettled");
    if (r.status === "in_flight") throw new Error("SpendInFlight");
    if (r.status === "refund_pending") {
      nonce += 1n;
      const label = 7_000_000_000n + nonce;
      r.refund_label = String(label);
      r.refund_leaf_index = s.leaves.length;
      s.leaves.push(String(vaultCommitment(BigInt(r.refund_value), label, BigInt(r.refund_precommitment))));
      s.labels.push(String(label));
    }
    r.status = "settled";
    r.reserve = "0";
    final += 1;
    snaps.set(final, s);
  };
  const send = async (c: Call) => {
    calls.push(c);
    settle(BigInt(JSON.parse(c.args).nullifier_hash));
    return `tx-${calls.length}`;
  };
  const bump = (f: (s: Snap) => void) => {
    const s = structuredClone(at(final));
    f(s);
    final += 1;
    snaps.set(final, s);
  };
  return { rpcs: [rpc("rpc-a"), rpc("rpc-b")] as const, send, calls, settle, bump, now: () => at(final) };
}

/** The wallet's note store, as far as settle writes through it: add refuses a second note on one precommitment. */
function store(held: bigint[] = []) {
  const notes: { ref: unknown; scope: bigint; precommitment: bigint; state: string; parent: string; leaf: Kit.VaultSettleLeaf }[] = [];
  return {
    notes,
    async list() {
      return [...held.map((precommitment) => ({ precommitment })), ...notes];
    },
    async add(n: (typeof notes)[number]) {
      if (held.includes(n.precommitment) || notes.some((x) => x.precommitment === n.precommitment)) throw new Error("that precommitment is already in the store");
      notes.push(n);
      return n;
    },
  };
}

const NF = 111n; // the device's spend: its fee part failed, so the whole withdrawal came back (vault review A-01)
const R = 222n; // its refund precommitment
const REFUND = 7_000_000n;
const ME = { nullifierHash: NF, refundPrecommitment: R, ref: { kind: "refund", l: 31n, j: 0 }, parent: "note-1" };
const deposits = (n: number) => Array.from({ length: n }, (_, i) => String(10_000n + BigInt(i)));

test("vaultSettleCall: the frozen shape's call, 150 Tgas, 148 B x 1e19 for a refund, nothing for a paid spend", () => {
  const c = vaultSettleCall(VAULT, NF, "refund_pending");
  assert.deepEqual({ ...c }, { receiverId: VAULT, methodName: "settle", args: '{"nullifier_hash":"111"}', gas: 150_000_000_000_000n, deposit: 1_480_000_000_000_000_000_000n });
  assert.equal(c.gas, VAULT_SETTLE_GAS);
  assert.equal(c.deposit, VAULT_SETTLE_REFUND_ATTACH);
  assert.ok(Object.isFrozen(c));
  assert.equal(vaultSettleCall(VAULT, NF, "paid").deposit, 0n);
  assert.throws(() => vaultSettleCall(VAULT, NF, "settled" as "paid"), /status/);
  assert.throws(() => vaultSettleCall(VAULT, -1n, "paid"), /nullifierHash/);
  assert.throws(() => vaultSettleCall(VAULT, Kit.VAULT_FIELD_P, "paid"), /nullifierHash/);
  assert.throws(() => vaultSettleCall("Vault..x", NF, "paid"), /vault/);
});

test("a refund-pending spend of the device's: one settle sent, the refund note exactly the returned amount, written once; a second call sends nothing and writes nothing", async () => {
  const v = vault({ leaves: deposits(8), labels: deposits(6), spends: [row(0, 99n, 98n, "paid", 0n), row(1, NF, R, "refund_pending", REFUND)] });
  const st = store();
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: st, waitsMs: NOOP_WAITS });
  assert.equal(v.calls.length, 1);
  assert.deepEqual({ ...v.calls[0] }, { ...vaultSettleCall(VAULT, NF, "refund_pending") });
  const label = BigInt(v.now().spends[1]!.refund_label);
  const leaf = { value: REFUND, label, commitment: vaultCommitment(REFUND, label, R), leafIndex: 8n };
  assert.deepEqual(r.outcomes, [{ nullifierHash: NF, state: "refund_note", leaf, written: true, txHash: "tx-1" }]);
  assert.deepEqual(st.notes, [{ ref: ME.ref, scope: SCOPE, precommitment: R, state: "UNSPENT", parent: "note-1", leaf }]);
  assert.equal(BigInt(v.now().leaves[8]!), leaf.commitment, "the note is the tree's leaf at its index");
  // again: the spend reads settled, so no settle is sent and the store keeps its one note
  const again = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: st, waitsMs: NOOP_WAITS });
  assert.equal(v.calls.length, 1, "a second settle was sent");
  assert.deepEqual(again.outcomes, [{ nullifierHash: NF, state: "refund_note", leaf, written: false }]);
  assert.equal(st.notes.length, 1);
  // and the vault itself refuses a second settle
  assert.throws(() => v.settle(NF), /AlreadySettled/);
});

test("a spend anyone settled first (the relayer's own settle): nothing sent, its refund note written from the row", async () => {
  const v = vault({ leaves: deposits(5), labels: deposits(5), spends: [row(0, NF, R, "refund_pending", REFUND)] });
  v.settle(NF);
  const st = store();
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: st, waitsMs: NOOP_WAITS });
  assert.equal(v.calls.length, 0);
  assert.equal(r.outcomes[0]!.state, "refund_note");
  assert.equal(st.notes[0]!.leaf.value, REFUND);
  assert.equal(st.notes[0]!.leaf.leafIndex, 5n);
});

test("in_flight, paid, settled with no refund and unknown spends: nothing sent, nothing written", async () => {
  const spends = [row(0, 1n, 11n, "in_flight", 0n), row(1, 2n, 12n, "paid", 0n), row(2, 3n, 13n, "settled", 0n)];
  const v = vault({ leaves: deposits(4), labels: deposits(4), spends });
  const st = store();
  const mk = (n: bigint, r: bigint) => ({ nullifierHash: n, refundPrecommitment: r, ref: { n }, parent: `p${n}` });
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [mk(1n, 11n), mk(2n, 12n), mk(3n, 13n), mk(4n, 14n)], send: v.send, store: st, waitsMs: NOOP_WAITS });
  assert.equal(v.calls.length, 0);
  assert.deepEqual(r.outcomes.map((o) => o.state), ["in_flight", "paid", "settled", "unknown"]);
  assert.equal(st.notes.length, 0);
});

test("a spend whose callback runs while the call waits is sent once it turns refund_pending", async () => {
  const v = vault({ leaves: deposits(3), labels: deposits(3), spends: [row(0, NF, R, "in_flight", 0n)] });
  const st = store();
  const rpcs = v.rpcs;
  let reads = 0;
  const watched: Kit.VaultSyncRpc = {
    name: "rpc-a",
    async query(p) {
      if (p.method_name === "state_tree" && p.finality === "final" && ++reads === 1)
        v.bump((s) => Object.assign(s.spends[0]!, { status: "in_flight" })); // a block passes, still in flight
      if (p.method_name === "state_tree" && p.finality === "final" && reads === 2) v.bump((s) => Object.assign(s.spends[0]!, { status: "refund_pending", refund_value: String(REFUND) }));
      return rpcs[0].query(p);
    },
  };
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: [watched, rpcs[1]], spends: [ME], send: v.send, store: st, waitsMs: NOOP_WAITS });
  assert.equal(v.calls.length, 1);
  assert.equal(r.outcomes[0]!.state, "refund_note");
  assert.equal(st.notes[0]!.leaf.value, REFUND);
});

test("a sent settle not read settled within the waits is reported sent, with nothing written", async () => {
  const v = vault({ leaves: deposits(3), labels: deposits(3), spends: [row(0, NF, R, "refund_pending", REFUND)] });
  const st = store();
  const lost = async (c: Call) => (v.calls.push(c), "tx-lost"); // the sender's answer, never applied on chain
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: lost, store: st, waitsMs: NOOP_WAITS });
  assert.deepEqual(r.outcomes, [{ nullifierHash: NF, state: "sent", txHash: "tx-lost" }]);
  assert.equal(v.calls.length, 1, "sent once, not once per read");
  assert.equal(st.notes.length, 0);
});

// ---- refund by leaf: a second note on R never takes the refund's place (card wallet-refund-note-by-leaf, PR #413) ----

test("refund by leaf: a stranger's spends on R, one before the device's row and one with a lower leaf, never replace the spend row's own leaf", async () => {
  // S1 front-ran with a proof binding R: its row is before ours, its refund leaf after ours. S2 bound R later and was
  // settled before ours: its row is after ours, its refund leaf below ours. Each is 1 USDC on R, the refund's nullifier.
  const v = vault({ leaves: deposits(6), labels: deposits(6), spends: [row(0, 501n, R, "refund_pending", 1_000_000n), row(1, NF, R, "refund_pending", REFUND), row(2, 502n, R, "refund_pending", 1_000_000n)] });
  v.settle(502n); // S2's refund leaf: 6
  const st = store();
  const sendThenS1 = async (c: Call) => {
    const tx = await v.send(c); // ours: leaf 7
    v.settle(501n); // S1's: leaf 8
    return tx;
  };
  const r = await vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: sendThenS1, store: st, waitsMs: NOOP_WAITS });
  const mineRow = v.now().spends[1]!;
  assert.deepEqual([v.now().spends[0]!.refund_leaf_index, mineRow.refund_leaf_index, v.now().spends[2]!.refund_leaf_index], [8, 7, 6]);
  assert.equal(r.outcomes[0]!.state, "refund_note");
  assert.deepEqual(st.notes.map((n) => n.leaf), [{ value: REFUND, label: BigInt(mineRow.refund_label), commitment: BigInt(v.now().leaves[7]!), leafIndex: 7n }]);
});

test("refund by leaf: a row whose refund_leaf_index names a leaf that is not its note is refused, even with the note at another index", async () => {
  const v = vault({ leaves: deposits(4), labels: deposits(4), spends: [row(0, NF, R, "refund_pending", REFUND)] });
  v.settle(NF);
  // the vault's pages name leaf 2 for the refund, while the note's commitment sits at 4 (a lie both RPCs tell)
  v.bump((s) => {
    s.spends[0]!.refund_leaf_index = 2;
  });
  const st = store();
  await assert.rejects(vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: st, waitsMs: NOOP_WAITS }), /leaf 2 is not its refund note/);
  assert.equal(st.notes.length, 0);
});

test("a row of the device's whose refund precommitment is not the one it bound stops the call, before anything is sent", async () => {
  const v = vault({ leaves: deposits(3), labels: deposits(3), spends: [row(0, NF, 333n, "refund_pending", REFUND)] });
  await assert.rejects(vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: store(), waitsMs: NOOP_WAITS }), /not the one this device bound/);
  assert.equal(v.calls.length, 0);
});

test("hostile arguments are refused before any read", async () => {
  const v = vault({ leaves: [], labels: [], spends: [] });
  const base = { vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: v.send, store: store(), waitsMs: NOOP_WAITS };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["vault", { vault: "UPPER.near" }, /vault/],
    ["scope", { scope: Kit.VAULT_FIELD_P }, /scope/],
    ["two of one nullifier", { spends: [ME, { ...ME, refundPrecommitment: 9n }] }, /named twice/],
    ["two of one R", { spends: [ME, { ...ME, nullifierHash: 9n }] }, /named twice/],
    ["R 0", { spends: [{ ...ME, refundPrecommitment: 0n }] }, /0 is no note's/],
    ["no parent", { spends: [{ ...ME, parent: "" }] }, /parent/],
    ["no sender", { send: null }, /send/],
    ["no store", { store: {} }, /store/],
    ["another vault's cursor", { cursor: Kit.vaultSyncStart("other.testnet") }, /cursor/],
  ];
  for (const [name, change, want] of cases) await assert.rejects(vaultSettleOwn({ ...base, ...change } as never), want, name);
});

test("a sender that answers no transaction hash stops the call", async () => {
  const v = vault({ leaves: deposits(3), labels: deposits(3), spends: [row(0, NF, R, "refund_pending", REFUND)] });
  await assert.rejects(vaultSettleOwn({ vault: VAULT, scope: SCOPE, rpcs: v.rpcs, spends: [ME], send: async () => "", store: store(), waitsMs: NOOP_WAITS }), /no transaction hash/);
});
