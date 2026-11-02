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
type Answer = { jsonrpc: "2.0"; id: string; result: { block_hash: unknown; block_height: unknown; logs: unknown[]; result: number[] } };
type FakeOpts = { tamper?: Tamper; hash?: (h: number) => string; down?: boolean; gcBelow?: number; answer?: (p: Record<string, unknown>, honest: Answer) => unknown };
const rpcError = (cause: string) => ({ jsonrpc: "2.0", id: "blindfill", error: { name: "HANDLER_ERROR", cause: { name: cause } } });

function fake(name: string, chain: Chain, final: number, opts: FakeOpts = {}): Fake {
  const calls: Fake["calls"] = [];
  return {
    name,
    calls,
    async query(p) {
      if (opts.down) throw new Error("HTTP 503");
      assert.equal(p.request_type, "call_function");
      assert.equal(p.account_id, VAULT);
      const at = p.finality === "final" ? final : (p.block_id as number);
      assert.ok(Number.isSafeInteger(at), `block_id ${String(at)}`);
      if (at > final) return rpcError("UNKNOWN_BLOCK");
      if (opts.gcBelow !== undefined && at < opts.gcBelow) return rpcError("GARBAGE_COLLECTED_BLOCK");
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
      const honest: Answer = { jsonrpc: "2.0", id: "blindfill", result: { block_hash: (opts.hash ?? hashOf)(at), block_height: at, logs: [], result: enc(view) } };
      return opts.answer ? opts.answer(p, honest) : honest;
    },
  };
}

const base: Snap = { state_tree: SET.state_tree, label_tree: SET.label_tree, deposits: SET.deposits, spends: SET.spends, leaves: SET.leaves, labels: SET.labels };
const H: number = SET.height;
const one = (s: Snap = base): Chain => new Map([[H, s]]);
const pair = (chain: Chain, a: FakeOpts = {}, b: FakeOpts = {}, finals: [number, number] = [H, H]) =>
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

// ---------- the review's attacks (independent Opus review of 6e81df1: PROBE and WANT ids kept) ----------
const P_NEW = "424242424242424242424242424242";
// The vault at H+50: one more deposit (precommitment P_NEW), its leaf and its label.
const landed: Snap = {
  ...base,
  deposits: [...SET.deposits, { ...SET.deposits[2], index: 3, precommitment: P_NEW, leaf_index: 6 }],
  leaves: [...SET.leaves, "777"],
  labels: [...SET.labels, "888"],
  state_tree: { ...SET.state_tree, size: 7 },
  label_tree: { ...SET.label_tree, size: 5 },
};
const withLanded = (): Chain =>
  new Map([
    [H, base],
    [H + 50, landed],
  ]);
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "returned";
  } catch (e) {
    assert.ok(e instanceof VaultSyncStopped, String(e));
    return e.code;
  }
}

test("A1 + G: within W the lower RPC's block is read, and a caller's floor in cursor.height refuses a block below it", async () => {
  const chain = withLanded();
  // A gap of 100 blocks is inside W: the read is at the lower height, where P_NEW has not landed yet.
  const r = await vaultSync({ vault: VAULT, rpcs: [fake("low", chain, H), fake("high", chain, H + 100)], cursor: vaultSyncStart(VAULT) });
  assert.equal(r.height, H);
  assert.equal(r.deposits.some((d) => d.precommitment === BigInt(P_NEW)), false);
  // A caller that must see the vault at or after H+55 (max_block_height H+50, + 5) sets the floor: below it, behind.
  const floor = { ...vaultSyncStart(VAULT), height: H + 55 };
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("low", chain, H + 40), fake("high", chain, H + 100)], cursor: floor })), "behind");
  const ok = await vaultSync({ vault: VAULT, rpcs: [fake("a", chain, H + 60), fake("b", chain, H + 100)], cursor: floor });
  assert.equal(ok.deposits.some((d) => d.precommitment === BigInt(P_NEW)), true);
});

test("A2: a stuck RPC cannot hold the sync at an old block: once the other is over W ahead, every sync stops (lag)", async () => {
  const chain = withLanded();
  const cursor = vaultSyncStart(VAULT);
  for (let i = 1; i <= 3; i++) {
    assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("stuck", chain, H), fake("honest", chain, H + 1_000 * i)], cursor })), "lag");
    assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("honest", chain, H + 1_000 * i), fake("stuck", chain, H)], cursor })), "lag");
  }
  assert.deepEqual(cursor, vaultSyncStart(VAULT));
});

test("A3: a 10,000-block gap between the final heights stops (lag); W exactly is read, W + 1 is not", async () => {
  const chain = withLanded();
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("liar", chain, H), fake("honest", chain, H + 10_000)], cursor: vaultSyncStart(VAULT) })), "lag");
  assert.equal(Kit.VAULT_SYNC_LAG_MAX, 120);
  const at = await vaultSync({ vault: VAULT, rpcs: [fake("a", chain, H), fake("b", chain, H + 120)], cursor: vaultSyncStart(VAULT) });
  assert.equal(at.height, H);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("a", chain, H), fake("b", chain, H + 121)], cursor: vaultSyncStart(VAULT) })), "lag");
});

test("A4: the pinned block garbage-collected on one RPC stops the sync (rpc), no rows", async () => {
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: [fake("a", one(), H), fake("b", one(), H + 10, { gcBelow: H + 1 })], cursor: vaultSyncStart(VAULT) })), "rpc");
});

test("B: another fork's hash, no block_hash, no block_height, another height, a result.error, a byte over 255: each stops", async () => {
  const cases: [string, NonNullable<FakeOpts["answer"]>][] = [
    ["fork", (_p, a) => ({ ...a, result: { ...a.result, block_hash: "fork" } })],
    ["no hash", (_p, a) => ({ ...a, result: { ...a.result, block_hash: undefined } })],
    ["no height", (_p, a) => ({ ...a, result: { ...a.result, block_height: undefined } })],
    ["height+1", (p, a) => (p.block_id ? { ...a, result: { ...a.result, block_height: H + 1 } } : a)],
    ["height as string", (_p, a) => ({ ...a, result: { ...a.result, block_height: String(H) } })],
    ["result.error", (p, a) => (p.method_name === "deposits" ? { ...a, result: { error: "wasm execution failed", block_height: H, block_hash: hashOf(H), logs: [] } } : a)],
    ["bytes over 255", (p, a) => (p.method_name === "deposits" ? { ...a, result: { ...a.result, result: [...a.result.result, 256] } } : a)],
  ];
  for (const [what, answer] of cases) assert.notEqual(await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer }), cursor: vaultSyncStart(VAULT) })), "returned", what);
});

test("C1: exactly PAGE_MAX rows then an empty page; one RPC's empty second page while the other has rows stops", async () => {
  const chain: Chain = new Map([[H, grown(1_500, 1_500)]]);
  const cut: Tamper = (m, a, v) => (m === "deposits" && a.from === 1_000 ? [] : v);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(chain, { tamper: cut }), cursor: vaultSyncStart(VAULT) })), "disagree");
  const ok = await vaultSync({ vault: VAULT, rpcs: pair(new Map([[H, grown(1_000, 1_000)]])), cursor: vaultSyncStart(VAULT) });
  assert.deepEqual([ok.cursor.deposits, ok.cursor.leaves], [1_000, 1_000]);
});

test("C2: a page longer than asked (1,001 rows) on one RPC disagrees; on both it is refused as a page", async () => {
  const chain: Chain = new Map([[H, grown(1_001, 1_001)]]);
  const long: Tamper = (m, a, v) => (m === "deposits" && a.from === 0 ? grown(1_001, 1_001).deposits : v);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(chain, { tamper: long }), cursor: vaultSyncStart(VAULT), lists: ["deposits"] })), "disagree");
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(chain, { tamper: long }, { tamper: long }), cursor: vaultSyncStart(VAULT), lists: ["deposits"] })), "row");
});

test("D1, D2: the spends cursor stops at the first spend not settled, whatever comes after; every other status holds it", async () => {
  const sp = [
    { ...SET.spends[1], index: 0 }, // paid
    { ...SET.spends[0], index: 1 }, // settled
  ];
  const r = await vaultSync({ vault: VAULT, rpcs: pair(one({ ...base, spends: sp })), cursor: vaultSyncStart(VAULT), lists: ["spends"] });
  assert.deepEqual([r.cursor.spends, r.spends.length], [0, 2]);
  for (const status of ["in_flight", "refund_pending", "paid"]) {
    const s2 = [SET.spends[0], { ...SET.spends[1], status }];
    const r2 = await vaultSync({ vault: VAULT, rpcs: pair(one({ ...base, spends: s2 })), cursor: vaultSyncStart(VAULT), lists: ["spends"] });
    assert.equal(r2.cursor.spends, 1, status);
  }
});

test("E2: a deposits or spends cursor past the list's end stops (count); a cursor at the end reads row c - 1 and goes on", async () => {
  for (const list of ["deposits", "spends"] as const) {
    assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(one()), cursor: { ...vaultSyncStart(VAULT), [list]: 10 }, lists: [list] })), "count", list);
  }
  // At the end (3 deposits, cursor 3): no row, the cursor stays, and the rows written later all come.
  const chain: Chain = new Map([
    [H, base],
    [H + 10, grown(5, 6)],
  ]);
  const rpcs = pair(chain);
  const r = await vaultSync({ vault: VAULT, rpcs, cursor: { ...vaultSyncStart(VAULT), deposits: 3 }, lists: ["deposits"] });
  assert.deepEqual([r.deposits.length, r.cursor.deposits], [0, 3]);
  for (const f of rpcs) assert.deepEqual(f.calls.filter((c) => c.method === "deposits").map((c) => c.args), [{ from: 3, limit: 1_000 }, { from: 2, limit: 1 }]);
  const r2 = await vaultSync({ vault: VAULT, rpcs: pair(chain, {}, {}, [H + 10, H + 10]), cursor: r.cursor, lists: ["deposits"] });
  assert.deepEqual(r2.deposits.map((d) => d.index), [3, 4]);
});

test("F: rows the vault cannot write, served by both RPCs, are refused (row)", async () => {
  const dep = (f: (r: Record<string, unknown>) => unknown): Tamper => (m, _a, v) => (m === "deposits" ? (v as Record<string, unknown>[]).map((r, k) => (k === 0 ? f(r) : r)) : v);
  const spd = (f: (r: Record<string, unknown>) => unknown): Tamper => (m, _a, v) => (m === "spends" ? (v as Record<string, unknown>[]).map((r, k) => (k === 0 ? f(r) : r)) : v);
  const P = Kit.VAULT_FIELD_P.toString();
  const cases: [string, Tamper][] = [
    ["value 2^128", dep((r) => ({ ...r, value: (1n << 128n).toString() }))],
    ["value as number", dep((r) => ({ ...r, value: 10 }))],
    ["value 01", dep((r) => ({ ...r, value: "01" }))],
    ["extra field", dep((r) => ({ ...r, extra: 1 }))],
    ["missing field", dep(({ depositor: _d, ...r }) => r)],
    ["depositor uppercase", dep((r) => ({ ...r, depositor: "Alice.testnet" }))],
    ["depositor 65 chars", dep((r) => ({ ...r, depositor: "a".repeat(65) }))],
    ["leaf_index -1", dep((r) => ({ ...r, leaf_index: -1 }))],
    ["leaf_index 2^53", dep((r) => ({ ...r, leaf_index: 2 ** 53 }))],
    ["leaf_index 1.5", dep((r) => ({ ...r, leaf_index: 1.5 }))],
    ["index as string", dep((r) => ({ ...r, index: "0" }))],
    ["status Settled", spd((r) => ({ ...r, status: "Settled" }))],
    ["status unknown", spd((r) => ({ ...r, status: "done" }))],
    ["fee 2^128", spd((r) => ({ ...r, fee: (1n << 128n).toString() }))],
    ["context = p", spd((r) => ({ ...r, context: P }))],
    ["payer uppercase (M23)", spd((r) => ({ ...r, payer: "Relayer.testnet" }))],
    ["recipient empty", spd((r) => ({ ...r, recipient: "" }))],
    ["leaf = p", (m, _a, v) => (m === "leaves" ? (v as string[]).map((x, k) => (k === 0 ? P : x)) : v)],
    ["tree depth 33", (m, _a, v) => (m === "state_tree" ? { ...(v as object), depth: 33 } : v)],
    ["tree root = p", (m, _a, v) => (m === "label_tree" ? { ...(v as object), root: P } : v)],
    ["page not an array", (m, _a, v) => (m === "labels" ? { 0: "1" } : v)],
  ];
  const missed: string[] = [];
  for (const [what, t] of cases) if ((await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: t }, { tamper: t }), cursor: vaultSyncStart(VAULT) }))) !== "row") missed.push(what);
  assert.deepEqual(missed, []);
});

test("F2, F3: fields out of the vault's order, a repeated field, spacing or another number form, served by both, are refused", async () => {
  const text = (f: (t: string, p: Record<string, unknown>) => string): NonNullable<FakeOpts["answer"]> => (p, a) => {
    const t = f(new TextDecoder().decode(Uint8Array.from(a.result.result)), p);
    return { ...a, result: { ...a.result, result: [...new TextEncoder().encode(t)] } };
  };
  const onDep = (f: (t: string) => string) => text((t, p) => (p.method_name === "deposits" ? f(t) : t));
  const cases: [string, NonNullable<FakeOpts["answer"]>][] = [
    ["reversed fields", onDep((t) => JSON.stringify((JSON.parse(t) as object[]).map((r) => Object.fromEntries(Object.entries(r).reverse()))))],
    ["repeated field", onDep((t) => t.replace('"value":"5000000"', '"value":"1","value":"5000000"'))],
    ["spacing", onDep((t) => JSON.stringify(JSON.parse(t), null, 1))],
    ["index 1e0", onDep((t) => t.replace('"index":1,', '"index":1e0,'))],
    ["tree size 6.0", text((t, p) => (p.method_name === "state_tree" ? t.replace('"size":6', '"size":6.0') : t))],
  ];
  for (const [what, answer] of cases) {
    const c = await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer }, { answer }), cursor: vaultSyncStart(VAULT) }));
    assert.equal(c, "row", what);
  }
});

test("M28: a page that is not UTF-8, served by both, is refused as not UTF-8", async () => {
  const answer: NonNullable<FakeOpts["answer"]> = (p, a) => (p.method_name === "labels" ? { ...a, result: { ...a.result, result: [0x5b, 0x22, 0xff, 0x22, 0x5d] } } : a);
  await assert.rejects(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer }, { answer }), cursor: vaultSyncStart(VAULT) }), (e: unknown) => {
    assert.ok(e instanceof VaultSyncStopped);
    assert.equal(e.code, "row");
    assert.match(e.message, /not UTF-8/);
    return true;
  });
});

test("a page with a leading byte-order mark, served by both, is refused: the BOM is kept, never dropped", async () => {
  const answer: NonNullable<FakeOpts["answer"]> = (p, a) => (p.method_name === "labels" ? { ...a, result: { ...a.result, result: [0xef, 0xbb, 0xbf, ...a.result.result] } } : a);
  await assert.rejects(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer }, { answer }), cursor: vaultSyncStart(VAULT) }), (e: unknown) => {
    assert.ok(e instanceof VaultSyncStopped);
    assert.equal(e.code, "row");
    return true;
  });
});

test("H: an abort ends a read one RPC never answers, and the RPCs get the signal", async () => {
  const seen: unknown[] = [];
  const hang: Rpc = {
    name: "hang",
    query: (_p, signal) => {
      seen.push(signal);
      return new Promise<unknown>(() => {});
    },
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const t0 = Date.now();
  await assert.rejects(vaultSync({ vault: VAULT, rpcs: [hang, fake("b", one(), H)], cursor: vaultSyncStart(VAULT), signal: ac.signal }), (e: unknown) => {
    assert.ok(!(e instanceof VaultSyncStopped));
    assert.equal((e as Error).name, "AbortError");
    return true;
  });
  assert.ok(Date.now() - t0 < 300, "ended within 300 ms of the abort");
  assert.deepEqual(seen, [ac.signal]);
});

test("the mutants the review's set left alive (M2, M21, M22, M32): each now has a test", async () => {
  // M2: both RPCs agree on a later read's block hash, but it is not the block the first reads named.
  const moved: NonNullable<FakeOpts["answer"]> = (p, a) => (p.method_name === "deposits" ? { ...a, result: { ...a.result, block_hash: "moved" } } : a);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer: moved }, { answer: moved }), cursor: vaultSyncStart(VAULT) })), "disagree");
  // M21: an answer that carries an error beside its bytes, on both, is not a view result.
  const errBytes: NonNullable<FakeOpts["answer"]> = (p, a) => (p.method_name === "deposits" ? { ...a, result: { ...a.result, error: "wasm execution failed" } } : a);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer: errBytes }, { answer: errBytes }), cursor: vaultSyncStart(VAULT) })), "rpc");
  // M22: a byte over 255 on both RPCs is not a view result (it would wrap to 0 in a Uint8Array).
  const wide: NonNullable<FakeOpts["answer"]> = (p, a) => (p.method_name === "labels" ? { ...a, result: { ...a.result, result: [...a.result.result.slice(0, -1), 93 + 256] } } : a);
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { answer: wide }, { answer: wide }), cursor: vaultSyncStart(VAULT) })), "rpc");
  // M32: the row before an at-the-end cursor, served by both with another index, is refused.
  const offBy: Tamper = (m, a, v) => (m === "deposits" && a.from === 2 && a.limit === 1 ? [{ ...SET.deposits[2], index: 7 }] : v);
  const c = { ...vaultSyncStart(VAULT), deposits: 3 };
  assert.equal(await code(vaultSync({ vault: VAULT, rpcs: pair(one(), { tamper: offBy }, { tamper: offBy }), cursor: c, lists: ["deposits"] })), "row");
});
