// The vault's USDC in the top-level page's state (card signpage-state-holdings, src/vault-balance.ts): withVaultBalance
// sets state.vault_balance from the device's own notes of the vault's scope, UNSPENT and HELD only, and never throws,
// as the API's state() must not. And the page's state step (src/main.ts) builds it from one notes read shared with
// state.pools.
//   node --test test/vault-balance.test.ts      (from packages/signpage)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Operation, SignpageState } from "../../kit/src/signpage/messages.ts";
import { SIGNPAGE_MAX_ANSWER_BYTES, SIGNPAGE_RESULT_SCHEMAS } from "../../kit/src/signpage/schema.ts";
import { NOTE_STATES, type NoteRecord, type NoteState } from "../../wallet/src/notes/store.ts";
import { signedOutState } from "../src/api.ts";
import { ANSWER_ROOM, pickOps, stateOf } from "../src/state.ts";
import { vaultBalanceOf, withVaultBalance } from "../src/vault-balance.ts";

const VAULT = 7n;
const POOL = 11n;
const SIGNED_IN = stateOf(true, { source: "code", code_saved: true }, []);
const note = (id: string, scope: bigint, value: bigint, state: NoteState = "UNSPENT"): NoteRecord => ({
  id,
  ref: { kind: "deposit", s: scope, i: 0 },
  scope,
  precommitment: 1n,
  state,
  leaf: { value, label: 1n, commitment: 1n, leafIndex: 0n },
});

test("signed in: vault_balance is the USDC of the vault's UNSPENT and HELD notes, other scopes left out, valid for the kit's schema", async () => {
  let reads = 0;
  const notes = [note("a", VAULT, 12_500_000n), note("b", VAULT, 250_001n, "HELD"), note("c", POOL, 9_000_000_000n)];
  const out = await withVaultBalance(SIGNED_IN, async () => (reads++, notes), VAULT);
  assert.deepEqual(out, { ...SIGNED_IN, vault_balance: "12.750001" });
  assert.equal(reads, 1);
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
  assert.equal(SIGNED_IN.vault_balance, "0", "the state handed in is not changed");
});

/** A RESERVED note whose stored request withdraws `withdrawn` (public_signals[2], as withdraw/handoff.ts storedRequest reads it). */
const reserved = (id: string, value: bigint, withdrawn: unknown): NoteRecord => ({
  ...note(id, VAULT, value, "RESERVED"),
  request: JSON.stringify({ proof: {}, public_signals: ["1", "2", withdrawn, "4"], withdrawal: { recipient: "r.near" } }),
});

test("a note spent, taken or not landed is never counted; a reserved one counts its change only", async () => {
  const counted: NoteState[] = ["UNSPENT", "HELD"];
  for (const s of NOTE_STATES) {
    if (s === "RESERVED") continue;
    const v = vaultBalanceOf([note("x", VAULT, 1_000_000n, s)], VAULT);
    assert.equal(v, counted.includes(s) ? 1_000_000n : 0n, s);
  }
  const out = await withVaultBalance(SIGNED_IN, async () => [note("s", VAULT, 5_000_000n, "SPENT"), reserved("r", 3_000_000n, "3000000"), note("u", VAULT, 1n)], VAULT);
  assert.equal(out.vault_balance, "0.000001", "a reserved note withdrawing all of it leaves no change");
});

test("review P2-1: a 100 USDC note reserved for a 10 USDC withdrawal reads 90 while the withdrawal is in flight", async () => {
  const out = await withVaultBalance(SIGNED_IN, async () => [reserved("r", 100_000_000n, "10000000")], VAULT);
  assert.equal(out.vault_balance, "90");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
  // its change note landed: the parent reads SPENT (readNotes), so the 90 is counted once, as the change
  const landed = [{ ...reserved("r", 100_000_000n, "10000000"), state: "SPENT" as const }, { ...note("c", VAULT, 90_000_000n), parent: "r" }];
  assert.equal((await withVaultBalance(SIGNED_IN, async () => landed, VAULT)).vault_balance, "90");
  // the withdrawal expired: the note is UNSPENT again at its full value
  assert.equal((await withVaultBalance(SIGNED_IN, async () => [note("r", VAULT, 100_000_000n)], VAULT)).vault_balance, "100");
});

test("a reserved note whose request is present but malformed or withdraws more than the note: the state as it is, as a failed read", async () => {
  const bad: NoteRecord[] = [
    { ...note("r", VAULT, 100_000_000n, "RESERVED"), request: "" },
    { ...note("r", VAULT, 100_000_000n, "RESERVED"), request: "{not json" },
    { ...note("r", VAULT, 100_000_000n, "RESERVED"), request: JSON.stringify({ public_signals: "x" }) },
    { ...note("r", VAULT, 100_000_000n, "RESERVED"), request: "null" },
    reserved("r", 100_000_000n, 10_000_000),
    reserved("r", 100_000_000n, "-1"),
    reserved("r", 100_000_000n, "010"),
    reserved("r", 100_000_000n, "100000001"),
  ];
  for (const r of bad) assert.equal(await withVaultBalance(SIGNED_IN, async () => [note("u", VAULT, 5_000_000n), r], VAULT), SIGNED_IN, String(r.request));
});

test("whole and small amounts read as exact decimals: no float, no trailing zeros", async () => {
  const at = async (v: bigint) => (await withVaultBalance(SIGNED_IN, async () => [note("a", VAULT, v)], VAULT)).vault_balance;
  assert.equal(await at(0n), "0");
  assert.equal(await at(1n), "0.000001");
  assert.equal(await at(5_000_000n), "5");
  assert.equal(await at(123_456_789_012_345_678_901n), "123456789012345.678901");
});

test("signed out, or no vault on the page's network: the state as it is, the notes never read", async () => {
  let reads = 0;
  const read = async () => (reads++, [note("a", VAULT, 1n)]);
  const out = signedOutState();
  assert.equal(await withVaultBalance(out, read, VAULT), out);
  assert.equal(await withVaultBalance(SIGNED_IN, read, null), SIGNED_IN);
  assert.equal(reads, 0);
});

test("a notes read that fails, or a counted note with no leaf value: the state as it is, never a guessed sum, never a throw", async () => {
  const sync = () => {
    throw new Error("IndexedDB blocked");
  };
  assert.equal(await withVaultBalance(SIGNED_IN, sync as never, VAULT), SIGNED_IN);
  assert.equal(await withVaultBalance(SIGNED_IN, () => Promise.reject(new Error("closed")), VAULT), SIGNED_IN);
  const broken = [note("a", VAULT, 1_000_000n), { ...note("b", VAULT, 1n), leaf: undefined }];
  assert.equal(await withVaultBalance(SIGNED_IN, async () => broken, VAULT), SIGNED_IN);
  const negative = [note("a", VAULT, -1n)];
  assert.equal(await withVaultBalance(SIGNED_IN, async () => negative, VAULT), SIGNED_IN);
});

test("a state whose ops fill the answer: the oldest ops give way to the longer balance, so the answer still fits", async () => {
  const rows = Array.from({ length: 9_000 }, (_, i) => ({
    op: { id: `op-${String(i).padStart(5, "0")}-${"x".repeat(450)}`, kind: "deposit" as const, stage: "done" as const, txs: [] } as Operation,
    t: i,
  }));
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  const room = (s: SignpageState) => SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM - bytes(s);
  let full: SignpageState = { ...SIGNED_IN, ops: pickOps(SIGNED_IN, rows) };
  // pickOps leaves up to one op's bytes free: a held entry takes all but 10 of them ({"id":"","asset":"usdc","amount":"1"} is 36)
  if (room(full) > 10) full = { ...full, held: [{ id: "h".repeat(room(full) - 36 - 10), asset: "usdc", amount: "1" }] };
  assert.ok(room(full) >= 0 && room(full) <= 10, `the ops fill the cap: ${room(full)} bytes free`);
  const out = await withVaultBalance(full, async () => [note("a", VAULT, 123_456_789_012_345_678_901n)], VAULT);
  assert.equal(out.vault_balance, "123456789012345.678901");
  assert.ok(bytes(out) <= SIGNPAGE_MAX_ANSWER_BYTES - ANSWER_ROOM, `${bytes(out)} bytes`);
  assert.ok(out.ops.length < full.ops.length && out.ops.length > 0);
  assert.equal(out.ops.at(-1)!.id, full.ops.at(-1)!.id, "the newest op kept");
  assert.equal(SIGNPAGE_RESULT_SCHEMAS.state(out), true);
});

test("main.ts: the shell's state sets vault_balance from the vault's scope, on the same notes read as state.pools", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const step = src.slice(src.indexOf("    state: () =>"), src.indexOf("    // a store change, a new price read"));
  assert.match(step, /withVaultBalance\(s, shared, pageScope\(\)\)/);
  assert.match(step, /withPools\(withVault, shared,/);
  assert.match(step, /const shared = \(\) => \(read \?\?= notes\(\)\)/);
  // the frame keeps no note data: its state step adds neither
  const framed = src.slice(src.lastIndexOf("if (framed) {"));
  assert.doesNotMatch(framed, /withVaultBalance|withPools/);
});

test("review P3: a reserved note with no request (checkRecord allows it; withdrawSettle never settles it) counts 0 for that note, the rest still read", async () => {
  const noRequest = note("r", VAULT, 100_000_000n, "RESERVED");
  assert.equal(noRequest.request, undefined);
  const out = await withVaultBalance(SIGNED_IN, async () => [note("u", VAULT, 5_000_000n), noRequest, reserved("q", 20_000_000n, "5000000")], VAULT);
  assert.equal(out.vault_balance, "20", "5 unspent, 0 for the note with no request, 15 change of the other");
  assert.equal(vaultBalanceOf([noRequest], VAULT), 0n);
});
