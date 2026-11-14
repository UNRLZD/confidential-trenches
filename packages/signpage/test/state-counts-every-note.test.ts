// Card portfolio-counts-every-note: one stored note record the note store's check refuses never zeroes the others'
// totals. The owner's Portfolio (14 Nov 11:06-11:09Z, release 137) read NEAR 0 USDC and Base 0 ETH while the vault held
// their 1.883113 USDC and the Base pool their 0.01 ETH: the state's one notes read (main.ts, shared by vault_balance and
// state.pools) is the wallet's readNotes, which threw on any record checkRecord refuses, so vault_balance stayed "0"
// (vault-balance.ts) and state.pools went absent (pools.ts withPools). The state's read now leaves a refused record out
// of every total and names its key; the note store's own reads (every spend, withdraw and Move) still refuse it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noteCommitment } from "../../wallet/src/notes/secrets.ts";
import { readNotes, type NoteRecord } from "../../wallet/src/notes/store.ts";
import { stateOf } from "../src/state.ts";
import { pagePoolsOf, withPools } from "../src/pools.ts";
import { withVaultBalance } from "../src/vault-balance.ts";
import { vaultScope } from "../src/withdraw/checks.ts";

const SIGNED_IN = stateOf(true, { source: "code", code_saved: true }, []);
const POOLS = pagePoolsOf("mainnet");
const scopeOf = (chain: string): bigint => POOLS.find((p) => p.chain === chain)!.scope;
const VAULT = vaultScope("mainnet")!;

const landed = (id: string, scope: bigint, value: bigint, pre: bigint): NoteRecord => ({
  id,
  ref: { kind: "deposit", s: scope, i: Number(pre) },
  scope,
  precommitment: pre,
  state: "UNSPENT",
  leaf: { value, label: 5n, commitment: noteCommitment(value, 5n, pre), leafIndex: pre },
});

// a store as the wallet store reads it back (get, keys), the records as they are stored
const storeOf = (records: Record<string, unknown>) => ({
  keys: async (s: string) => (s === "notes" ? Object.keys(records) : []),
  get: async (s: string, k: string) => (s === "notes" ? records[k] : undefined),
});

const good = {
  sol: landed("sol", scopeOf("solana"), 27_242_000n, 11n),
  base: landed("base", scopeOf("base"), 10_000_000_000_000_000n, 12n),
  near: landed("near", VAULT, 1_883_113n, 13n),
};
// a RESERVED Base note whose last attempt context is not its own deadline's: checkRecord refuses it ("HELD and RESERVED
// hold their attempt's contexts entry last"), so a read of the store that checks every record throws on it
const bad = {
  ...landed("bad", scopeOf("base"), 2_000_000_000_000_000n, 14n),
  state: "RESERVED",
  deadlineMs: 1_763_089_200_000n,
  attempt: "ab".repeat(16),
  contexts: [{ context: "7", deadlineMs: 1_763_089_100_000n }],
};

test("card portfolio-counts-every-note: one record the note store refuses is left out of the state's totals; the vault and every pool still count their readable notes", async () => {
  const store = storeOf({ sol: good.sol, bad, base: good.base, near: good.near });
  const refused: string[] = [];
  // the state's read (main.ts stateNotes): one read shared by vault_balance and state.pools
  let read: Promise<NoteRecord[]> | null = null;
  const shared = () => (read ??= readNotes(store, (key) => void refused.push(key)));
  const withVault = await withVaultBalance(SIGNED_IN, shared, VAULT);
  const out = await withPools(withVault, shared, POOLS);
  assert.equal(out.vault_balance, "1.883113", "the vault's USDC");
  const pools = Object.fromEntries((out.pools ?? []).map((p) => [p.chain, p.balance]));
  assert.equal(pools.solana, "0.027242", "Solana's note");
  assert.equal(pools.base, "0.01", "Base's readable note, the refused one left out");
  assert.deepEqual(refused, ["bad"], "the refused record named by its key");
});

test("card portfolio-counts-every-note: without the callback the read refuses the store as before (the note store's spends, withdraws and Moves never act on part of it)", async () => {
  await assert.rejects(readNotes(storeOf({ base: good.base, bad })), /contexts entry last/);
});

test("card portfolio-counts-every-note: a refused change note's parent still reads SPENT, so its money is never counted twice", async () => {
  const parent = landed("p", scopeOf("base"), 10_000_000_000_000_000n, 21n);
  const child = { id: "c", ref: { kind: "change", l: 5n, j: 0 }, scope: scopeOf("base"), parent: "p", state: "UNSPENT" };
  const refused: string[] = [];
  const notes = await readNotes(storeOf({ p: parent, c: child }), (key) => void refused.push(key));
  assert.deepEqual(refused, ["c"]);
  assert.deepEqual(notes.map((n) => [n.id, n.state]), [["p", "SPENT"]]);
});

test("card portfolio-counts-every-note: main.ts reads the state's notes with the refused callback, logging the record's key, and the note store's paths without it", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(src, /async function stateNotes\(\): Promise<NoteRecord\[\]> \{\n\s+return readNotes\(await open\(\), \(key, e\) =>/);
  assert.match(src, /const notesOrError = \(\): Promise<\{ v: NoteRecord\[\] \} \| \{ e: unknown \}> => stateNotes\(\)/);
  assert.match(src, /async function pageNotes\(\): Promise<NoteRecord\[\]> \{\n\s+return readNotes\(await open\(\)\);/);
});
