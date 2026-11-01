// node --test packages/kit/test/vault-sync.test.ts: the vault's pages read on two RPCs and matched on the device
// (src/vault/sync.ts, card vault-kit-sync; the vault paper 2.5.6, 2.10 (c) and V4.1), reached only through the kit's
// public entry. The recorded set (fixtures/vault-sync-pages.json) holds the testnet vault's real answers on two RPCs
// and a page set in the vault's own serde form; the fake RPCs below serve that set as the vault's views do
// (contracts/vault/src/lib.rs `page`: rows from..from+min(limit, PAGE_MAX), clamped to the list's length). Test values
// only, never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Kit from "../src/index.ts";

const { VAULT_CONSTANTS, VaultSyncStopped, vaultSync, vaultSyncStart } = Kit;
type Cursor = Kit.VaultSyncCursor;
type Rpc = Kit.VaultSyncRpc;

const FIX = JSON.parse(readFileSync(new URL("./fixtures/vault-sync-pages.json", import.meta.url), "utf8"));
const SET = FIX.pageSet;
const VAULT: string = SET.vault;

// ---------- a fake chain and its RPCs ----------
type Snap = { state_tree: object; label_tree: object; deposits: object[]; spends: object[]; leaves: string[]; labels: string[] };
type Chain = Map<number, Snap>; // height -> the vault's state from that height on
const snapAt = (chain: Chain, h: number): Snap => {
  const hs = [...chain.keys()].filter((k) => k <= h).sort((a, b) => b - a);
  const s = hs[0] === undefined ? undefined : chain.get(hs[0]);
  if (!s) throw new Error(`no block ${h}`);
  return s;
};
const hashOf = (h: number) => `hash-${h}`;
const enc = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];
type Tamper = (method: string, args: { from?: number; limit?: number }, view: unknown) => unknown;
type Fake = Rpc & { calls: { method: string; args: { from?: number; limit?: number }; at: unknown }[] };

function fake(name: string, chain: Chain, final: number, opts: { tamper?: Tamper; hash?: (h: number) => string; down?: boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  return {
    name,
    calls,
    async query(p) {
      if (opts.down) throw new Error("HTTP 503");
      assert.equal(p.request_type, "call_function");
      assert.equal(p.account_id, VAULT);
      const at = p.finality === "final" ? final : (p.block_id as number);
      assert.ok(Number.isSafeInteger(at) && at <= final, `block_id ${String(at)} is past this RPC's final ${final}`);
      const method = p.method_name as string;
      const args = JSON.parse(atob(p.args_base64 as string));
      calls.push({ method, args, at: p.finality === "final" ? "final" : p.block_id });
      const s = snapAt(chain, at);
      let view: unknown;
      if (method === "state_tree" || method === "label_tree") view = s[method];
      else {
        const list = s[method as "deposits" | "spends" | "leaves" | "labels"];
        const start = Math.min(args.from, list.length);
        view = list.slice(start, Math.min(start + Math.min(args.limit, VAULT_CONSTANTS.PAGE_MAX), list.length));
      }
      if (opts.tamper) view = opts.tamper(method, args, view);
      return { jsonrpc: "2.0", id: "blindfill", result: { block_hash: (opts.hash ?? hashOf)(at), block_height: at, logs: [], result: enc(view) } };
    },
  };
}

const base: Snap = { state_tree: SET.state_tree, label_tree: SET.label_tree, deposits: SET.deposits, spends: SET.spends, leaves: SET.leaves, labels: SET.labels };
const H: number = SET.height;
const one = (s: Snap = base): Chain => new Map([[H, s]]);
const pair = (chain: Chain, a: Partial<Parameters<typeof fake>[3]> = {}, b: Partial<Parameters<typeof fake>[3]> = {}, finals: [number, number] = [H, H]) =>
  [fake("rpc-a", chain, finals[0], a), fake("rpc-b", chain, finals[1], b)] as const;

async function stopped(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VaultSyncStopped, `not a VaultSyncStopped: ${String(e)}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}

// ---------- the recorded testnet answers ----------
test("the recorded testnet answers on two RPCs: both agree at the lower final height, every list empty", async () => {
  const rec = FIX.recorded;
  const rpcs = rec.rpcs.map((url: string) => ({
    name: url,
    async query(p: Record<string, unknown>) {
      const hit = rec.answers.find(
        (a: { rpc: string; params: Record<string, unknown> }) =>
          a.rpc === url && a.params.method_name === p.method_name && a.params.args_base64 === p.args_base64 && a.params.block_id === p.block_id && a.params.finality === p.finality,
      );
      if (!hit) throw new Error(`not recorded: ${JSON.stringify(p)}`);
      return hit.answer;
    },
  }));
  const r = await vaultSync({ vault: rec.vault, rpcs: [rpcs[0], rpcs[1]], cursor: vaultSyncStart(rec.vault) });
  assert.equal(r.height, 275762775);
  assert.equal(r.blockHash, "Enn61H1z6MAAihjUJSp16sgNryD8qdQn55SQYaAQqGNj");
  assert.deepEqual(r.stateTree, { size: 0, depth: 0, root: 0n });
  assert.deepEqual([r.deposits, r.spends, r.leaves, r.labels], [[], [], [], []]);
  assert.deepEqual(r.cursor, { vault: rec.vault, height: 275762775, deposits: 0, spends: 0, leaves: 0, labels: 0 });
});

// ---------- two agreeing RPCs ----------
test("two agreeing RPCs give every row, parsed, and the cursor past them (spends from the first not settled)", async () => {
  const rpcs = pair(one());
  const r = await vaultSync({ vault: VAULT, rpcs, cursor: vaultSyncStart(VAULT) });
  assert.equal(r.height, H);
  assert.equal(r.deposits.length, 3);
  assert.deepEqual(r.deposits[1], {
    index: 1,
    precommitment: 123456789012345678901234567891n,
    label: 9876543210987654321098765432109876543211n,
    value: 10_000_000n,
    leafIndex: 1n,
    depositor: SET.deposits[1].depositor,
  });
  assert.equal(r.spends.length, 2);
  assert.equal(r.spends[0]!.status, "settled");
  assert.equal(r.spends[1]!.status, "paid");
  assert.equal(r.spends[1]!.reserve, 3890000000000000000000n);
  assert.equal(r.spends[1]!.recipient, "bob.testnet");
  assert.deepEqual(r.leaves, SET.leaves.map(BigInt));
  assert.deepEqual(r.labels, SET.labels.map(BigInt));
  assert.deepEqual(r.labelTree, { size: 4, depth: 2, root: BigInt(SET.label_tree.root) });
  assert.deepEqual(r.cursor, { vault: VAULT, height: H, deposits: 3, spends: 1, leaves: 6, labels: 4 });
  // Every read after the probe is at one block on both RPCs.
  for (const f of rpcs) for (const c of f.calls.slice(1)) assert.equal(c.at, H);
});

test("an RPC ahead of the other is read at the lower final height: its newer rows wait for the next sync", async () => {
  const more: Snap = { ...base, deposits: [...SET.deposits, { ...SET.deposits[2], index: 3, leaf_index: 6 }] };
  const chain: Chain = new Map([
    [H, base],
    [H + 5, more],
  ]);
  const r = await vaultSync({ vault: VAULT, rpcs: pair(chain, {}, {}, [H, H + 5]), cursor: vaultSyncStart(VAULT) });
  assert.equal(r.height, H);
  assert.equal(r.deposits.length, 3);
  assert.equal(r.cursor.deposits, 3);
  const next = await vaultSync({ vault: VAULT, rpcs: pair(chain, {}, {}, [H + 5, H + 5]), cursor: r.cursor });
  assert.deepEqual(next.deposits.map((d) => d.index), [3]);
});

// ---------- one RPC disagrees: the sync stops ----------
const onDeposits = (f: (rows: object[]) => object[]): Tamper => (m, _a, v) => (m === "deposits" ? f(v as object[]) : v);

test("one RPC with an extra row stops the sync", async () => {
  const extra = onDeposits((rows) => [...rows, { ...SET.deposits[2], index: 3, leaf_index: 6 }]);
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { tamper: extra }), cursor: vaultSyncStart(VAULT) }), "disagree");
});

test("one RPC with a missing row stops the sync", async () => {
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: onDeposits((rows) => rows.slice(0, 2)) }), cursor: vaultSyncStart(VAULT) }), "disagree");
});

test("one RPC with a changed row stops the sync (value, depositor, a spend's status, a leaf)", async () => {
  const cases: Tamper[] = [
    onDeposits((rows) => rows.map((r, k) => (k === 1 ? { ...r, value: "10000001" } : r))),
    onDeposits((rows) => rows.map((r, k) => (k === 0 ? { ...r, depositor: SET.deposits[1].depositor } : r))),
    (m, _a, v) => (m === "spends" ? (v as object[]).map((r, k) => (k === 1 ? { ...r, status: "settled" } : r)) : v),
    (m, _a, v) => (m === "leaves" ? (v as string[]).map((x, k) => (k === 5 ? "1" : x)) : v),
  ];
  for (const tamper of cases) await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { tamper }), cursor: vaultSyncStart(VAULT) }), "disagree");
});

test("the same bytes in another form (key order, spacing) are a disagreement too: the pages match byte for byte", async () => {
  const reorder = onDeposits((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).reverse())));
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { tamper: reorder }), cursor: vaultSyncStart(VAULT) }), "disagree");
});

test("two RPCs at the same height on different blocks stop the sync", async () => {
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { hash: (h) => `other-${h}` }), cursor: vaultSyncStart(VAULT) }), "disagree");
});

test("one RPC down stops the sync, and so does one RPC given twice", async () => {
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { down: true }), cursor: vaultSyncStart(VAULT) }), "rpc");
  const a = fake("rpc-a", one(), H);
  await stopped(vaultSync({ vault: VAULT, rpcs: [a, a], cursor: vaultSyncStart(VAULT) }), "input");
  await stopped(vaultSync({ vault: VAULT, rpcs: [a, fake("rpc-a", one(), H)], cursor: vaultSyncStart(VAULT) }), "input");
});

test("a row both RPCs agree on but the vault could not write stops the sync (index off its place, a field over p)", async () => {
  const off = onDeposits((rows) => rows.map((r, k) => (k === 2 ? { ...r, index: 7 } : r)));
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: off }, { tamper: off }), cursor: vaultSyncStart(VAULT) }), "row");
  const big = onDeposits((rows) => rows.map((r, k) => (k === 0 ? { ...r, label: Kit.VAULT_FIELD_P.toString() } : r)));
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: big }, { tamper: big }), cursor: vaultSyncStart(VAULT) }), "row");
});

// ---------- the cursor ----------
function grown(nDeposits: number, nLeaves: number): Snap {
  const deposits = Array.from({ length: nDeposits }, (_, i) => ({ ...SET.deposits[i % 3], index: i, leaf_index: i }));
  const leaves = Array.from({ length: nLeaves }, (_, i) => String(1000n + BigInt(i)));
  return { ...base, deposits, leaves, state_tree: { ...SET.state_tree, size: nLeaves } };
}

test("a cursor resume reads only the new rows, across a page boundary", async () => {
  const chain: Chain = new Map([
    [H, grown(1_000, 1_000)],
    [H + 10, grown(1_502, 1_502)],
  ]);
  const firstRpcs = pair(chain);
  const first = await vaultSync({ vault: VAULT, rpcs: firstRpcs, cursor: vaultSyncStart(VAULT) });
  // A full page is never the end: the next page is read, and it is empty.
  for (const f of firstRpcs) assert.deepEqual(f.calls.filter((c) => c.method === "deposits").map((c) => c.args.from), [0, 1_000]);
  assert.equal(first.cursor.deposits, 1_000);
  assert.equal(first.cursor.leaves, 1_000);
  const rpcs = pair(chain, {}, {}, [H + 10, H + 10]);
  const next = await vaultSync({ vault: VAULT, rpcs, cursor: first.cursor });
  assert.deepEqual(next.deposits.map((d) => d.index), Array.from({ length: 502 }, (_, i) => 1_000 + i));
  assert.equal(next.leaves.length, 502);
  assert.equal(next.leaves[0], 2000n);
  assert.deepEqual(next.cursor, { vault: VAULT, height: H + 10, deposits: 1_502, spends: 1, leaves: 1_502, labels: 4 });
  for (const f of rpcs) {
    const froms = (m: string) => f.calls.filter((c) => c.method === m).map((c) => c.args.from);
    assert.deepEqual(froms("deposits"), [1_000]); // 502 rows: one page, short, so the end
    assert.deepEqual(froms("leaves"), [1_000]);
    assert.deepEqual(froms("labels"), [4]);
    assert.deepEqual(froms("spends"), [1]); // from the first spend not settled, which can still change
  }
});

test("only the lists asked for are read; the others keep their place", async () => {
  const rpcs = pair(one());
  const r = await vaultSync({ vault: VAULT, rpcs, cursor: vaultSyncStart(VAULT), lists: ["deposits"] });
  assert.deepEqual(r.cursor, { vault: VAULT, height: H, deposits: 3, spends: 0, leaves: 0, labels: 0 });
  assert.deepEqual([r.spends, r.leaves, r.labels], [[], [], []]);
  for (const f of rpcs) assert.deepEqual([...new Set(f.calls.map((c) => c.method))].sort(), ["deposits", "label_tree", "state_tree"]);
});

test("a lying count cannot skip a row: the cursor moves only past rows both RPCs gave", async () => {
  // One RPC claims a larger tree: stop, and the caller's cursor is untouched.
  const cursor = vaultSyncStart(VAULT);
  const before = structuredClone(cursor);
  const big: Tamper = (m, _a, v) => (m === "state_tree" ? { ...(v as object), size: 2_000 } : v);
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), {}, { tamper: big }), cursor }), "disagree");
  assert.deepEqual(cursor, before);
  // Both claim a tree larger than the leaves they page: stop, never a cursor past the rows read.
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: big }, { tamper: big }), cursor }), "count");
  // The higher RPC's newer rows never move the cursor: it is bounded by the lower final height's rows.
  const chain: Chain = new Map([
    [H, base],
    [H + 3, grown(9, 9)],
  ]);
  const r = await vaultSync({ vault: VAULT, rpcs: pair(chain, {}, {}, [H + 3, H]), cursor });
  assert.deepEqual([r.cursor.deposits, r.cursor.leaves], [3, 6]);
  // A cursor ahead of the rows the RPCs hold is refused, not taken as read.
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: { ...r.cursor, leaves: 7 } }), "count");
});

test("RPCs behind the cursor's height, a cursor for another vault or a malformed cursor are refused", async () => {
  const r = await vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: vaultSyncStart(VAULT) });
  const lagging: Chain = new Map([[H - 1, base]]);
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(lagging, {}, {}, [H - 1, H]), cursor: r.cursor }), "behind");
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: vaultSyncStart("other.testnet") }), "input");
  const bad: Cursor[] = [
    { ...r.cursor, deposits: -1 },
    { ...r.cursor, leaves: 1.5 },
    { ...r.cursor, height: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const c of bad) await stopped(vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: c }), "input");
  await stopped(vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: vaultSyncStart(VAULT), lists: ["deposits", "nullifiers" as "deposits"] }), "input");
});
