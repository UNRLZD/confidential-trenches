// The top-level page's private balance per chain's pool (card balances-per-chain, src/pools.ts): withPools adds
// state.pools from the device's own notes for a signed-in state and never throws, as the API's state() must not.
//   node --test test/pools.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import type { NoteRecord } from "../../wallet/src/notes/store.ts";
import type { BalancePool } from "../../wallet/src/pool/balances.ts";
import { EVM_POOLS } from "../../wallet/src/pool/evm.ts";
import { SOL_POOLS } from "../../wallet/src/pool/solana.ts";
import { signedOutState } from "../src/api.ts";
import { PAGE_POOLS, withPools } from "../src/pools.ts";
import { ANSWER_ROOM, pickOps, stateOf } from "../src/state.ts";

const SOL: BalancePool = { id: "sol:p", chain: "solana", scope: 11n, asset: "SOL" };
const BASE: BalancePool = { id: "evm:p", chain: "base", scope: 22n, asset: "ETH" };
const SIGNED_IN = stateOf(true, { source: "code", code_saved: true }, []);
const note = (id: string, scope: bigint, value: bigint): NoteRecord => ({
  id,
  ref: { kind: "deposit", s: scope, i: 0 },
  scope,
  precommitment: 1n,
  state: "UNSPENT",
  leaf: { value, label: 1n, commitment: 1n, leafIndex: 0n },
});

test("signed in: pools from the notes read, one entry per chain of the table, valid for the kit's state schema", async () => {
  let reads = 0;
  const read = async () => (reads++, [note("a", SOL.scope, 12_500_000_000n)]);
  const out = await withPools(SIGNED_IN, read, [SOL, BASE]);
  assert.deepEqual(out, { ...SIGNED_IN, pools: [{ chain: "solana", asset: "SOL", balance: "12.5" }, { chain: "base", asset: "ETH", balance: "0" }] });
  assert.equal(reads, 1);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
  assert.equal(Object.hasOwn(SIGNED_IN, "pools"), false, "the state handed in is not changed");
});

test("signed out: the state is returned as it is, and the notes are never read", async () => {
  const out = signedOutState();
  let reads = 0;
  assert.equal(await withPools(out, async () => (reads++, []), [SOL]), out);
  assert.equal(reads, 0);
});

test("a notes read that throws or rejects, or notes that fail the sum: the state without pools, never a throw", async () => {
  const sync = () => {
    throw new Error("IndexedDB blocked");
  };
  assert.deepEqual(await withPools(SIGNED_IN, sync as never, [SOL]), SIGNED_IN);
  assert.deepEqual(await withPools(SIGNED_IN, () => Promise.reject(new Error("no Web Locks")), [SOL]), SIGNED_IN);
  const broken = [{ ...note("b", SOL.scope, 1n), leaf: undefined }];
  assert.deepEqual(await withPools(SIGNED_IN, async () => broken, [SOL]), SIGNED_IN);
  assert.deepEqual(await withPools(SIGNED_IN, async () => [], [{ ...SOL, asset: "BTC" as never }]), SIGNED_IN, "a bad pool table");
});

test("an empty pool table: pools [] and the notes never read", async () => {
  let reads = 0;
  assert.deepEqual(await withPools(SIGNED_IN, async () => (reads++, []), []), { ...SIGNED_IN, pools: [] });
  assert.equal(reads, 0);
});

test("ready: passed through when given, absent when not", async () => {
  const held: NoteRecord = { ...note("h", SOL.scope, 20_000_000_000n), state: "HELD", attempt: "a1", deadlineMs: 1n };
  const ready = [{ noteId: "h", attempt: "a1", poolId: SOL.id, chunk: 20_000_000_000n }];
  assert.deepEqual((await withPools(SIGNED_IN, async () => [held], [SOL], ready)).pools, [{ chain: "solana", asset: "SOL", balance: "20", ready: "20" }]);
  assert.deepEqual((await withPools(SIGNED_IN, async () => [held], [SOL])).pools, [{ chain: "solana", asset: "SOL", balance: "20" }]);
});

test("a state whose ops already fill the answer cap: the oldest ops give way to pools, so the answer still fits", async () => {
  const rows = Array.from({ length: 9_000 }, (_, i) => ({
    op: { id: `op-${String(i).padStart(5, "0")}-${"x".repeat(450)}`, kind: "deposit" as const, stage: "done" as const, txs: [] },
    t: i,
  }));
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const room = (s: SignpageState) => SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM - bytes(s);
  let full: SignpageState = { ...SIGNED_IN, ops: pickOps(SIGNED_IN, rows) };
  // pickOps leaves up to one op's bytes free: a held entry takes all but 10 of them ({"id":"","asset":"usdc","amount":"1"} is 36)
  if (room(full) > 50) full = { ...full, held: [{ id: "h".repeat(room(full) - 36 - 10), asset: "usdc", amount: "1" }] };
  assert.ok(room(full) >= 0 && room(full) <= 50, `the ops fill the cap: ${room(full)} bytes free`);
  const out = await withPools(full, async () => [note("a", SOL.scope, 1n)], [SOL, BASE]);
  assert.ok(bytes(out) <= SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM, `${bytes(out)} bytes`);
  assert.equal(out.pools?.length, 2);
  assert.ok(out.ops.length < full.ops.length && out.ops.length > 0);
  assert.equal(out.ops.at(-1)!.id, full.ops.at(-1)!.id, "the newest op stays");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
});

test("the page's pool table is empty while no pool is pinned on mainnet: a mainnet pin must be added to it", () => {
  // the pool pin tables: SOL_POOLS (wallet/src/pool/solana.ts) and EVM_POOLS (wallet/src/pool/evm.ts)
  assert.equal(SOL_POOLS.mainnet, undefined, "a Solana pool is pinned on mainnet: add it to PAGE_POOLS and this test");
  assert.equal(EVM_POOLS.base, undefined, "an EVM pool is pinned on Base: add it to PAGE_POOLS and this test");
  assert.equal(EVM_POOLS.robinhood, undefined, "an EVM pool is pinned on Robinhood: add it to PAGE_POOLS and this test");
  assert.deepEqual(PAGE_POOLS, []);
  assert.ok(Object.isFrozen(PAGE_POOLS));
});
