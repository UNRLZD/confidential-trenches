// Card exit-withdraw: the exit tool's withdrawal of a note (src/withdraw.ts; vault paper 2.12 step 6), offline, with a
// fake prover and fake steps. The withdrawal is A_{l,j}'s own, fee 0, recipient and fee recipient the typed account,
// always withdraw and never ragequit (a note whose label's depositor is not U too); A's DeleteAccount comes only after
// the spend reads settled with reserve 0, A's USDC held at 0 and nothing under A in intents.near; and exitWithdrawOne
// runs withdraw, then settle, then the DeleteAccount, each only once the one before landed.
//   node --test test/withdraw.test.ts      (from packages/exit)
// Test secrets come from the published all-zero BIP-39 vector (packages/wallet/test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { vaultCommitment, VaultTree, vaultWithdrawYocto, type VaultProver, type VaultSpendRow, type VaultSyncRpc } from "@blindfill/kit";
import { MoveOutRefused, noteSecrets, SETTLE_BLOCKS, wordsToSeed64, type BuiltMove, type DeleteReadFor, type RestoredNote, type SettleReadFor } from "@blindfill/kit/core";
import { EXIT_NETWORKS } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { exitKey, ExitOutStopped, exitReadStorage, exitRecipient, type ExitRecipient, type ExitStorage } from "../src/out.ts";
import { ExitRpcRefused } from "../src/rpc.ts";
import {
  EXIT_CLOSE_SEND_BLOCKS,
  EXIT_CLOSE_WAITS_MS,
  EXIT_REFUND_WHY,
  exitBuildDelete,
  exitBuildWithdraw,
  exitCloseOne,
  exitReadDelete,
  exitWithdrawIndex,
  exitWithdrawOne,
  type ExitSent,
  type ExitTxRecord,
  type ExitWithdrawSteps,
} from "../src/withdraw.ts";

const SEED = wordsToSeed64("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const NET = "testnet" as const;
const VAULT = EXIT_NETWORKS[NET].vault;
const TOKEN = EXIT_TOKENS[NET];
// the testnet vault's scope (contracts/vault/deployments/testnet-v1.json "scope"; not read from there: packages/exit reaches
// nothing outside itself and the kit). Self-checking: the wallet's builder recomputes the vault's scope from (vault, token)
// and refuses a context made with any other, so a wrong value here fails the builds below.
const SCOPE = 1535477060801825460881825272651648228733961995907927460809153251087997597629n;
const X = "c".repeat(64); // the typed account: an implicit one, so exitRecipient reads nothing
const BH = "11111111111111111111111111111111";
const LABEL = 987654321987654321n;
const VALUE = 1_000_000n;
const REG = 1_250_000_000_000_000_000_000n;
const NOW = 1_800_000_000_000;
const PROOF = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] };

const pair = (): readonly [VaultSyncRpc, VaultSyncRpc] => EXIT_NETWORKS[NET].rpcs.map((name) => ({ name, query: async () => null })) as unknown as readonly [VaultSyncRpc, VaultSyncRpc];
async function typed(): Promise<ExitRecipient> {
  const r = await exitRecipient(X, NET, pair());
  assert.ok(r.ok);
  return r.recipient;
}
const aOf = (l: bigint, j: number) => {
  const k = exitKey(SEED, { kind: "A", l, j });
  k.secretKey.fill(0);
  return k.id;
};

const view = (v: unknown, at: number) => ({ result: { block_height: at, result: [...new TextEncoder().encode(JSON.stringify(v))] } });
/** The release pair as exitReadStorage reads it: the token's bounds, its final height 1000 and storage_balance_of(typed) on each. */
const storagePair = (reg: readonly [unknown, unknown], names: readonly [string, string] = EXIT_NETWORKS[NET].rpcs): readonly [VaultSyncRpc, VaultSyncRpc] =>
  names.map((name, k) => ({
    name,
    query: async (p: Record<string, unknown>) => {
      if (p.request_type === "view_account") return { result: { block_height: 1000, amount: "1", code_hash: BH } };
      if (p.method_name === "storage_balance_bounds") return view({ min: REG.toString(), max: null }, 1000);
      if (p.method_name === "storage_balance_of") return view(reg[k], p.block_id as number);
      return null;
    },
  })) as unknown as readonly [VaultSyncRpc, VaultSyncRpc];
const BAL = { total: REG.toString(), available: "0" };
const storageOf = async (registered: boolean, to?: ExitRecipient) => exitReadStorage(NET, to ?? (await typed()), storagePair(registered ? [BAL, BAL] : [null, null]));

/** A note the restore found: its ref, scope, precommitment and leaf (index 0 of a one-leaf tree). */
function noteOf(ref: RestoredNote["ref"]): RestoredNote {
  const s = noteSecrets(SEED, ref);
  return { ref, scope: SCOPE, precommitment: s.precommitment, leaf: { value: VALUE, label: LABEL, commitment: vaultCommitment(VALUE, LABEL, s.precommitment), leafIndex: 0n }, state: "UNSPENT" };
}

/** A prover that answers this input's 8 signals, computed apart from the circuit from the note's known secrets. */
function fakeProver(note: RestoredNote, l: bigint, j: number, seen: Record<string, unknown>[], tamper?: (s: string[]) => string[]): VaultProver {
  return {
    load: async () => {},
    prove: async (_c, input) => {
      const i = input as Record<string, string>;
      seen.push({ ...i });
      const change = noteSecrets(SEED, { kind: "change", l, j });
      const own = noteSecrets(SEED, note.ref);
      const signals = [vaultCommitment(BigInt(i.existingValue!) - BigInt(i.withdrawnValue!), BigInt(i.label!), change.precommitment), own.nullifierHash, i.withdrawnValue, i.stateRoot, i.stateTreeDepth, i.ASPRoot, i.ASPTreeDepth, i.context].map(String);
      return { proof: PROOF as never, publicSignals: tamper ? tamper(signals) : signals, proveMs: 1 };
    },
  };
}

async function build(note: RestoredNote, o: { to?: ExitRecipient; tamper?: (s: string[]) => string[]; keys?: Uint8Array[]; storage?: ExitStorage } = {}) {
  const { l, j } = exitWithdrawIndex(note);
  const seen: Record<string, unknown>[] = [];
  const st = new VaultTree([note.leaf.commitment]);
  const lt = new VaultTree([LABEL]);
  const read: SettleReadFor = { height: 100, blockHash: BH, nonce: 7n, free: 10n ** 24n, gasPrice: 100_000_000n, a: aOf(l, j) };
  const keyOf: typeof exitKey = (s, a) => {
    const k = exitKey(s, a);
    o.keys?.push(k.secretKey);
    return k;
  };
  const out = await exitBuildWithdraw({ seed64: SEED, network: NET, note, to: o.to ?? (await typed()), prover: fakeProver(note, l, j, seen, o.tamper), stateTree: st, labelTree: lt, newestStateRoot: st.root!, newestLabelRoot: lt.root!, storage: o.storage ?? (await storageOf(false)), nowMs: NOW, deadlineMs: NOW + 500_000, read }, keyOf);
  return { out, seen, l, j };
}
const txText = (m: BuiltMove) => Buffer.from(m.signed, "base64").toString("latin1");

test("exitWithdrawIndex: change note k makes change k + 1; any other note of a label makes change 0, under the note's own label", () => {
  assert.deepEqual(exitWithdrawIndex(noteOf({ kind: "deposit", s: 1n, i: 0 })), { l: LABEL, j: 0 });
  assert.deepEqual(exitWithdrawIndex(noteOf({ kind: "change", l: LABEL, j: 4 })), { l: LABEL, j: 5 });
  assert.deepEqual(exitWithdrawIndex(noteOf({ kind: "refund", l: LABEL, j: 2 })), { l: LABEL, j: 0 });
  assert.deepEqual(exitWithdrawIndex(noteOf({ kind: "return", c: "sol", l: 5n, j: 1 })), { l: LABEL, j: 0 });
});

test("exitBuildWithdraw: A_{l,j} signs withdraw on the release vault, relay_fee 0, recipient and fee recipient the typed account, the whole note out; the change and refund are note (l, j)'s; A's key is zeroed", async () => {
  const keys: Uint8Array[] = [];
  const note = noteOf({ kind: "change", l: LABEL, j: 1 });
  const { out, seen, l, j } = await build(note, { keys });
  assert.equal(j, 2);
  const m = out.built;
  assert.equal(m.receiver, VAULT);
  assert.equal(m.nonce, 8n);
  assert.equal(m.amount, VALUE);
  assert.equal(m.calls[0]!.method, "withdraw");
  const w = (m.calls[0]!.args as { withdrawal: Record<string, unknown> }).withdrawal;
  assert.equal(w.relay_fee, "0");
  assert.equal(w.recipient, X);
  assert.equal(w.fee_recipient, X);
  assert.equal(w.register_deposit, REG.toString(), "the typed account's registration is the token's storage minimum, exactly");
  assert.equal(w.refund_precommitment, noteSecrets(SEED, { kind: "refund", l, j }).precommitment.toString());
  const text = txText(m);
  assert.ok(text.startsWith(`${String.fromCharCode(64, 0, 0, 0)}${aOf(l, j)}`), "the signer is A_{l,j}");
  assert.ok(text.includes(`"relay_fee":"0"`) && !text.includes("ragequit"));
  assert.equal(seen[0]!.newNullifier, noteSecrets(SEED, { kind: "change", l, j }).nullifier.toString());
  assert.equal(seen[0]!.withdrawnValue, VALUE.toString());
  assert.equal(out.nullifierHash, noteSecrets(SEED, note.ref).nullifierHash);
  assert.ok(keys.length > 0 && keys.every((k) => k.every((b) => b === 0)), "A's key was left in memory");
});

test("a note whose label's depositor is not U (a return note a relayer deposited) goes out by withdraw, never ragequit: the tool builds no ragequit at all", async () => {
  const { out } = await build(noteOf({ kind: "return", c: "sol", l: 5n, j: 1 }));
  assert.equal(out.built.calls[0]!.method, "withdraw");
  const src = readFileSync(new URL("../src/withdraw.ts", import.meta.url), "utf8").split("\n").filter((x) => !x.trim().startsWith("//") && !x.trim().startsWith("*"));
  assert.ok(!src.some((x) => /ragequit|RAGEQUIT/.test(x)), "withdraw.ts's code names no ragequit");
});

test("exitBuildWithdraw refuses: a typed account exitRecipient did not check, a SPENT note, a prover answer with another context", async () => {
  await assert.rejects(build(noteOf({ kind: "deposit", s: 1n, i: 0 }), { to: Object.freeze({ account: X, network: NET }) }), /not one exitRecipient checked/);
  await assert.rejects(build({ ...noteOf({ kind: "deposit", s: 1n, i: 0 }), state: "SPENT" }), /SPENT note has nothing to withdraw/);
  await assert.rejects(build(noteOf({ kind: "deposit", s: 1n, i: 0 }), { tamper: (s) => s.map((x, i) => (i === 7 ? "5" : x)) }), /context/);
});

test("P3-3/P3-4: register_deposit comes from exitReadStorage's own reads on both RPCs: 0 for a typed account already registered (NEP-145 would refund it into the keyless vault), the storage minimum for one that is not; a registration from anywhere else is refused", async () => {
  const note = noteOf({ kind: "deposit", s: 1n, i: 0 });
  const reg = await storageOf(true);
  assert.deepEqual({ ...reg }, { network: NET, account: X, storageMin: REG, registered: true });
  const { out } = await build(note, { storage: reg });
  const w = (out.built.calls[0]!.args as { withdrawal: Record<string, unknown> }).withdrawal;
  assert.equal(w.register_deposit, "0");
  assert.equal(out.built.calls[0]!.deposit, vaultWithdrawYocto(0n, 0n, true));
  // the same facts, not read by exitReadStorage: refused, so no caller's number reaches register_deposit
  await assert.rejects(build(note, { storage: { network: NET, account: X, storageMin: REG, registered: true } }), /not one exitReadStorage read/);
  const other = await exitRecipient("d".repeat(64), NET, pair());
  assert.ok(other.ok);
  await assert.rejects(build(note, { storage: await storageOf(true, other.recipient) }), /not one exitReadStorage read for this typed account/);
  await assert.rejects(exitReadStorage(NET, await typed(), storagePair([null, BAL])), ExitOutStopped, "the RPCs differ on the registration");
  await assert.rejects(exitReadStorage(NET, await typed(), storagePair([null, { total: "x" }])), ExitOutStopped, "a balance that is not one");
  await assert.rejects(exitReadStorage(NET, await typed(), storagePair([{ total: "x" }, { total: "x" }])), /neither null nor a storage balance/, "the same balance that is not one on both");
  await assert.rejects(exitReadStorage(NET, await typed(), storagePair([null, null], EXIT_NETWORKS.mainnet.rpcs)), ExitRpcRefused, "another network's pair");
});

test("a note read under another scope is refused by the exit's own context check, before A's key is ever derived", async () => {
  const keys: Uint8Array[] = [];
  await assert.rejects(build({ ...noteOf({ kind: "deposit", s: 1n, i: 0 }), scope: SCOPE + 1n }, { keys }), /the note's scope is not this vault's/);
  assert.equal(keys.length, 0, "A's key was derived for a note of another scope");
});

const NH = noteSecrets(SEED, { kind: "deposit", s: 1n, i: 0 }).nullifierHash;
const L = LABEL, J = 0;
const delRead = (o: Partial<DeleteReadFor> = {}): DeleteReadFor => ({
  network: NET, a: aOf(L, J), to: X, token: TOKEN, height: 1000, blockHash: BH, nonce: 9n, beneficiary: "exists", spend: { nullifierHash: NH, status: "settled", reserve: 0n },
  usdc: { state: "held", amount: 0n }, intents: "no-intents", withdrawTx: "final", settleTx: "final", settledBack: null, ...o,
});
const fires = (re: RegExp) => (e: unknown) => e instanceof MoveOutRefused && re.test(e.message);

test("exitBuildDelete: A's DeleteAccount to the typed account on a read with nothing left behind; refused to a missing typed account, before settle or its refunds, with USDC halted or left, or a token under A in intents.near", async () => {
  const to = await typed();
  const m = exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: delRead(), nullifierHash: NH });
  assert.equal(m.receiver, aOf(L, J));
  assert.deepEqual(m.calls, [{ action: "DeleteAccount", beneficiary_id: X }]);
  // P1-S fix 3: settled SETTLE_BLOCKS back, the withdraw (before the settle) needs no FINAL read: a reload lost its hash
  exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: delRead({ withdrawTx: "unread", settleTx: "none", settledBack: 1000 - SETTLE_BLOCKS }), nullifierHash: NH });
  for (const [why, r, re] of [
    ["the typed account missing (its NEAR would burn)", delRead({ beneficiary: "absent" }), /fund the typed account first/],
    ["before settle: in_flight", delRead({ spend: { nullifierHash: NH, status: "in_flight", reserve: 5n } }), /settled with reserve 0/],
    ["before settle: paid", delRead({ spend: { nullifierHash: NH, status: "paid", reserve: 5n } }), /settled with reserve 0/],
    ["before settle: refund_pending", delRead({ spend: { nullifierHash: NH, status: "refund_pending", reserve: 5n } }), /settled with reserve 0/],
    ["reserve above 0", delRead({ spend: { nullifierHash: NH, status: "settled", reserve: 1n } }), /settled with reserve 0/],
    ["the withdraw tx not FINAL, no lookback", delRead({ withdrawTx: "unread" }), /not read past their refunds/],
    ["A's settle not FINAL, no lookback", delRead({ settleTx: "unread" }), /not read past their refunds/],
    ["settled too recently, no tx read", delRead({ withdrawTx: "unread", settleTx: "none", settledBack: 1001 - SETTLE_BLOCKS }), /not read past their refunds/],
    ["USDC halted", delRead({ usdc: { state: "halted" } }), /USDC is not read at zero/],
    ["USDC left in A", delRead({ usdc: { state: "held", amount: 3n } }), /USDC is not read at zero/],
    ["a token under A in intents.near", delRead({ intents: "holds" }), /stranded/],
  ] as const)
    assert.throws(() => exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: r, nullifierHash: NH }), fires(re), why);
});

/**
 * Fake steps: the spends row's states in turn (the last one stays), A's existence, the close reads in turn (the last one
 * stays), the head after each, and every call in order: "record <step>" before each send, the sends by their one action.
 */
function world(o: { rows: (Partial<VaultSpendRow> | null)[]; sent?: Partial<Record<string, ExitSent>>; del?: Partial<DeleteReadFor>[]; account?: "exists" | "absent" | "unread"; heads?: (number | null)[]; recordThrows?: boolean }) {
  const order: string[] = [];
  const asked: { withdraw: string | null; settle: string | null }[] = [];
  const records: ExitTxRecord[] = [];
  const slept: number[] = [];
  const rows = [...o.rows], dels = [...(o.del ?? [{}])], heads = [...(o.heads ?? [1000])];
  const next = <T,>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]!);
  const steps: ExitWithdrawSteps = {
    withdraw: async () => (await build(noteOf({ kind: "deposit", s: 1n, i: 0 }))).out,
    send: async (m) => {
      const c = m.calls[0]!;
      const what = "action" in c ? c.action : c.method;
      order.push(what);
      return o.sent?.[what] ?? "ok";
    },
    record: async (r) => {
      if (o.recordThrows) throw new Error("the store is full");
      order.push(`record ${r.step}`);
      records.push(r);
    },
    spend: async () => {
      const r = rows.length === 0 ? null : next(rows);
      return r === null ? null : ({ index: 3, nullifierHash: NH, status: "paid", reserve: 5n, ...r } as VaultSpendRow);
    },
    account: async () => o.account ?? "exists",
    readA: async (a) => ({ height: 100, blockHash: BH, nonce: 8n, free: 10n ** 24n, gasPrice: 100_000_000n, a }),
    readDelete: async (a, index, nh, txs) => {
      order.push(`read ${index}`);
      asked.push({ ...txs });
      return { ...delRead({ a, spend: { nullifierHash: nh, status: "settled", reserve: 0n }, withdrawTx: txs.withdraw === null ? "unread" : "final", settleTx: txs.settle === null ? "none" : "final" }), ...next(dels) };
    },
    head: async () => next(heads),
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { steps, order, asked, records, slept };
}
const BACK = { settledBack: 1000 - SETTLE_BLOCKS };
const closeOne = async (w: ReturnType<typeof world>, txs?: { withdraw?: string | null; settle?: string | null }) => exitCloseOne({ seed64: SEED, network: NET, to: await typed(), l: L, j: J, nullifierHash: NH, txs, steps: w.steps });

test("exitWithdrawOne: withdraw, then settle, then A's DeleteAccount, each hash kept before its send and each step once the one before landed; the close read gets both hashes", async () => {
  const to = await typed();
  const a = world({ rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }] });
  const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: a.steps });
  assert.equal(out.stage, "closed");
  assert.equal(out.refund, false);
  assert.deepEqual(a.order, ["record withdraw", "withdraw", "record settle", "settle", "read 3", "record close", "DeleteAccount"]);
  assert.equal(out.txs.length, 3);
  assert.deepEqual(a.records.map((r) => [r.step, r.hash, r.l, r.j, r.nullifierHash]), [["withdraw", out.txs[0], L, J, NH], ["settle", out.txs[1], L, J, NH], ["close", out.txs[2], L, J, NH]]);
  assert.deepEqual(a.asked, [{ withdraw: out.txs[0], settle: out.txs[1] }]);
  // another settled the spend: no settle, and the close read has the withdraw's hash alone
  const b = world({ rows: [{ status: "settled", reserve: 0n }], del: [BACK] });
  assert.equal((await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: b.steps })).stage, "closed");
  assert.deepEqual(b.order, ["record withdraw", "withdraw", "read 3", "record close", "DeleteAccount"]);
  assert.deepEqual(b.asked[0], { withdraw: b.records[0]!.hash, settle: null });
});

test("P1-S fix 2: a hash that cannot be kept sends nothing", async () => {
  const x = world({ rows: [{ status: "paid", reserve: 5n }], recordThrows: true });
  await assert.rejects(exitWithdrawOne({ seed64: SEED, network: NET, to: await typed(), steps: x.steps }), /the store is full/);
  assert.deepEqual(x.order, []);
});

test("a payout the token refused (refund_pending): A settles it (the value becomes a refund note) and closes, the outcome says refund; a withdraw tx read failed goes on only when the vault wrote the spend", async () => {
  const to = await typed();
  for (const sent of ["failed", "ok"] as const) {
    const x = world({ rows: [{ status: "refund_pending", reserve: 5n }, { status: "refund_pending", reserve: 5n }, { status: "settled", reserve: 0n }].slice(sent === "ok" ? 1 : 0) as Partial<VaultSpendRow>[], sent: { withdraw: sent } });
    const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: x.steps });
    assert.equal(out.stage, "closed", sent);
    assert.equal(out.refund, true, sent);
    assert.deepEqual(x.order, ["record withdraw", "withdraw", "record settle", "settle", "read 3", "record close", "DeleteAccount"], sent);
  }
  assert.match(EXIT_REFUND_WHY, /the note is spent/);
  const lost = world({ rows: [], sent: { withdraw: "failed" } });
  const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: lost.steps });
  assert.equal(out.stage, "withdraw");
  assert.deepEqual(lost.order, ["record withdraw", "withdraw"]);
});

test("exitWithdrawOne never sends a DeleteAccount before the settle landed: a withdrawal or settle that did not land, a spend still paid or with reserve above 0 after it, USDC halted or left in A stop it", async () => {
  const to = await typed();
  const cases: [string, Parameters<typeof world>[0], string, string[]][] = [
    ["the withdrawal failed, no spend", { rows: [], sent: { withdraw: "failed" } }, "withdraw", ["record withdraw", "withdraw"]],
    ["the withdrawal unread, no spend", { rows: [], sent: { withdraw: "unread" } }, "withdraw", ["record withdraw", "withdraw"]],
    // a later row reading settled (another's settle, or a stale word) does not stand in for this settle's own landing
    ["the settle failed", { rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }], sent: { settle: "failed" } }, "settle", ["record withdraw", "withdraw", "record settle", "settle"]],
    ["the settle unread", { rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }], sent: { settle: "unread" } }, "settle", ["record withdraw", "withdraw", "record settle", "settle"]],
    ["still paid after the settle", { rows: [{ status: "paid", reserve: 5n }, { status: "paid", reserve: 5n }] }, "settle", ["record withdraw", "withdraw", "record settle", "settle"]],
    ["settled with reserve above 0", { rows: [{ status: "settled", reserve: 1n }] }, "settle", ["record withdraw", "withdraw"]],
    ["the payout still in flight", { rows: [{ status: "in_flight", reserve: 5n }] }, "settle", ["record withdraw", "withdraw"]],
    ["the spend not read", { rows: [null] }, "settle", ["record withdraw", "withdraw"]],
    ["USDC halted at the close", { rows: [{ status: "settled", reserve: 0n }], del: [{ ...BACK, usdc: { state: "halted" } }] }, "close", ["record withdraw", "withdraw", "read 3"]],
    ["USDC left in A at the close", { rows: [{ status: "settled", reserve: 0n }], del: [{ ...BACK, usdc: { state: "held", amount: 1n } }] }, "close", ["record withdraw", "withdraw", "read 3"]],
    ["the typed account missing at the close", { rows: [{ status: "settled", reserve: 0n }], del: [{ ...BACK, beneficiary: "absent" }] }, "close", ["record withdraw", "withdraw", "read 3"]],
    ["reserve above 0 at the close read", { rows: [{ status: "settled", reserve: 0n }], del: [{ ...BACK, spend: { nullifierHash: NH, status: "settled", reserve: 2n } }] }, "close", ["record withdraw", "withdraw", "read 3"]],
    ["the DeleteAccount failed", { rows: [{ status: "settled", reserve: 0n }], del: [BACK], sent: { DeleteAccount: "failed" } }, "close", ["record withdraw", "withdraw", "read 3", "record close", "DeleteAccount"]],
  ];
  for (const [why, w, stage, order] of cases) {
    const x = world(w);
    const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: x.steps });
    assert.equal(out.stage, stage, why);
    assert.deepEqual(x.order, order, why);
  }
});

test("P1-S fix 1: exitCloseOne resumes any A after a reload, no hash kept: a paid or refund_pending spend is settled first, then A closes; a settled one closes; an A already gone is closed; in_flight waits", async () => {
  // the withdraw's hash is lost: A's own settle reads FINAL, yet the close waits for the spend settled SETTLE_BLOCKS back
  const paid = world({ rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }], del: [{}, BACK] });
  const p = await closeOne(paid);
  assert.equal(p.stage, "closed");
  assert.deepEqual(paid.order, ["record settle", "settle", "read 3", "read 3", "record close", "DeleteAccount"]);
  assert.deepEqual(paid.asked[0], { withdraw: null, settle: paid.records[0]!.hash });
  assert.equal(paid.slept.length, 1);
  const refund = world({ rows: [{ status: "refund_pending", reserve: 5n }, { status: "settled", reserve: 0n }], del: [BACK] });
  const r = await closeOne(refund);
  assert.deepEqual([r.stage, r.refund], ["closed", true]);
  const settled = world({ rows: [{ status: "settled", reserve: 0n }], del: [BACK] });
  assert.equal((await closeOne(settled)).stage, "closed");
  assert.deepEqual(settled.order, ["read 3", "record close", "DeleteAccount"]);
  // the hashes a run kept go to the close read
  const kept = world({ rows: [{ status: "settled", reserve: 0n }] });
  assert.equal((await closeOne(kept, { withdraw: "W1", settle: "S1" })).stage, "closed");
  assert.deepEqual(kept.asked, [{ withdraw: "W1", settle: "S1" }]);
  const gone = world({ rows: [{ status: "settled", reserve: 0n }], account: "absent" });
  assert.deepEqual(await closeOne(gone), { stage: "closed", txs: [], refund: false });
  assert.deepEqual(gone.order, []);
  for (const [why, w, stage, re] of [
    ["A gone with its spend unsettled", world({ rows: [{ status: "paid", reserve: 5n }], account: "absent" }), "settle", /is not on chain, and its spend reads paid/],
    ["A not read the same", world({ rows: [{ status: "settled", reserve: 0n }], account: "unread" }), "close", /not read the same/],
    ["in_flight", world({ rows: [{ status: "in_flight", reserve: 5n }] }), "settle", /callback has not run yet/],
    ["no spend", world({ rows: [null] }), "settle", /not read in the vault's spends/],
  ] as const) {
    const out = await closeOne(w);
    assert.equal(out.stage, stage, why);
    assert.ok("why" in out && re.test(out.why), why);
    assert.deepEqual(w.order, [], why);
  }
});

test("P1-S fix 4: a settle too recent (another's, just after the withdraw) is waited out and read again, then A closes; past the waits it stops, nothing sent", async () => {
  const late = world({ rows: [{ status: "settled", reserve: 0n }], del: [{ settledBack: null }, { settledBack: null }, BACK] });
  const out = await exitWithdrawOne({ seed64: SEED, network: NET, to: await typed(), steps: late.steps });
  assert.equal(out.stage, "closed");
  assert.deepEqual(late.slept, [EXIT_CLOSE_WAITS_MS[0], EXIT_CLOSE_WAITS_MS[1]]);
  assert.deepEqual(late.order, ["record withdraw", "withdraw", "read 3", "read 3", "read 3", "record close", "DeleteAccount"]);
  const never = world({ rows: [{ status: "settled", reserve: 0n }], del: [{ settledBack: null }] });
  const n = await closeOne(never);
  assert.equal(n.stage, "close");
  assert.ok("why" in n && /run the close again/.test(n.why));
  assert.equal(never.slept.length, EXIT_CLOSE_WAITS_MS.length);
  assert.ok(!never.order.includes("DeleteAccount"));
});

test("P3-2: a DeleteAccount is sent within EXIT_CLOSE_SEND_BLOCKS of its read, else dropped unsent and signed again on a new read; never sent late", async () => {
  const once = world({ rows: [{ status: "settled", reserve: 0n }], del: [BACK], heads: [1000 + EXIT_CLOSE_SEND_BLOCKS + 1, 1000 + EXIT_CLOSE_SEND_BLOCKS] });
  assert.equal((await closeOne(once)).stage, "closed");
  assert.deepEqual(once.order, ["read 3", "read 3", "record close", "DeleteAccount"]);
  for (const head of [1000 + EXIT_CLOSE_SEND_BLOCKS + 1, null]) {
    const x = world({ rows: [{ status: "settled", reserve: 0n }], del: [BACK], heads: [head] });
    const out = await closeOne(x);
    assert.equal(out.stage, "close", String(head));
    assert.ok(!x.order.includes("DeleteAccount") && !x.order.includes("record close"), String(head));
  }
});

// ---------- exitReadDelete: every fact of A's close at one block on both RPCs ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b: Uint8Array) => {
  let n = BigInt(`0x${Buffer.from(b).toString("hex")}`), s = "";
  while (n > 0n) (s = B58[Number(n % 58n)] + s), (n /= 58n);
  for (const x of b) if (x === 0) s = "1" + s; else break;
  return s;
};
const PAUSED = { error: { cause: { name: "CONTRACT_EXECUTION_ERROR" }, data: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })' } };
const MISSING = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } } };
const WTX = "W".repeat(44), STX = "S".repeat(44);
type Side = { row?: Record<string, unknown>; back?: Record<string, unknown>; usdc?: string | "halt"; to?: "exists" | "absent"; intents?: unknown[] | "absent" | "unread"; tx?: Record<string, string> };
/** One fake RPC of the release pair, answering readSettle's, view_account's, the spends view's, exitHoldings', intents.near's and the tx reads. */
function side(name: string, aId: string, pk: Uint8Array, o: Side = {}) {
  const row = (at: number) => ({ index: 3, nullifier_hash: NH.toString(), withdrawn: "1000000", new_leaf_index: 1, refund_precommitment: "7", refund_value: "0", refund_label: "0", refund_leaf_index: 0, status: "settled", payer: aId, reserve: "0", recipient: X, fee: "0", context: "9", ...(at === 1000 ? o.row : (o.back ?? o.row)) });
  return {
    name,
    block: async (p: unknown) => ({ result: { header: { height: (p as { finality?: string }).finality ? 1000 : (p as { block_id: number }).block_id, hash: BH } } }),
    call: async () => ({ result: { gas_price: "100000000" } }),
    tx: async (p: { tx_hash: string; sender_account_id: string }) => ({ result: { final_execution_status: o.tx?.[p.tx_hash] ?? "FINAL", transaction: { hash: p.tx_hash, signer_id: p.sender_account_id }, status: { SuccessValue: "" }, receipts_outcome: [] } }),
    query: async (p: Record<string, unknown>) => {
      const at = p.block_id as number;
      if (p.request_type === "view_access_key_list") return { result: { block_height: at, keys: [{ public_key: `ed25519:${b58(pk)}`, access_key: { nonce: 9, permission: "FullAccess" } }] } };
      if (p.request_type === "view_account") {
        if (p.account_id === "intents.near" && o.intents === "unread") return null;
        const missing = p.account_id === "intents.near" ? (o.intents ?? "absent") === "absent" : p.account_id === X ? o.to === "absent" : false;
        return missing ? MISSING : { result: { block_height: at, amount: "2000000000000000000000000", storage_usage: 182, code_hash: BH } };
      }
      if (p.method_name === "spends") return view([row(at)], at);
      if (p.method_name === "ft_balance_of") return o.usdc === "halt" ? PAUSED : view(o.usdc ?? "0", at);
      if (p.method_name === "mt_tokens_for_owner") return view(o.intents, at);
      return null;
    },
  };
}
async function readDel(x: Side = {}, y: Side = x, o: { txs?: { withdraw: string | null; settle: string | null }; names?: readonly [string, string] } = {}) {
  const k = exitKey(SEED, { kind: "A", l: L, j: J });
  k.secretKey.fill(0);
  const [na, nb] = EXIT_NETWORKS[NET].rpcs;
  const r = [side(na, k.id, k.publicKey, x), side(nb, k.id, k.publicKey, y)] as const;
  const m = o.names ? ([side(o.names[0], k.id, k.publicKey, x), side(o.names[1], k.id, k.publicKey, y)] as const) : r;
  return exitReadDelete({ network: NET, aId: k.id, to: await typed(), spendIndex: 3, nullifierHash: NH, txs: o.txs ?? { withdraw: WTX, settle: STX }, rpcs: r as never, moveRpcs: m as never });
}
const closeOn = async (r: DeleteReadFor) => exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to: await typed(), read: r, nullifierHash: NH });

test("exitReadDelete reads at one block on both RPCs: A's nonce, the typed account, the spend's row now and SETTLE_BLOCKS back, A's USDC, intents.near and both kept txs FINAL; the close goes only on that read", async () => {
  const ok = await readDel();
  assert.equal(ok.height, 1000);
  assert.equal(ok.nonce, 9n);
  assert.equal(ok.network, NET);
  assert.equal(ok.beneficiary, "exists");
  assert.deepEqual(ok.spend, { nullifierHash: NH, status: "settled", reserve: 0n });
  assert.deepEqual(ok.usdc, { state: "held", amount: 0n });
  assert.equal(ok.intents, "no-intents", "testnet's pair reads no intents.near (UNKNOWN_ACCOUNT on both, 9 Nov 17:25Z)");
  assert.deepEqual([ok.withdrawTx, ok.settleTx, ok.settledBack], ["final", "final", 1000 - SETTLE_BLOCKS]);
  await closeOn(ok);
});

test("P1: a typed account that does not exist (an implicit one too) reads absent, and the close is refused with its next step; its NEAR is never sent to burn", async () => {
  const r = await readDel({ to: "absent" });
  assert.equal(r.beneficiary, "absent");
  await assert.rejects(closeOn(r), fires(/fund the typed account first/));
  await assert.rejects(readDel({ to: "absent" }, {}), ExitOutStopped, "the RPCs differ on the typed account");
});

test("P2-2 / P1-S fix 3: a tx read EXECUTED is unread and a hash not kept is unread or none; the close goes on them only when the spend read settled SETTLE_BLOCKS back", async () => {
  const recent = { back: { status: "paid", reserve: "5" } };
  const w = await readDel({ ...recent, tx: { [WTX]: "EXECUTED" } });
  assert.deepEqual([w.withdrawTx, w.settledBack], ["unread", null]);
  await assert.rejects(closeOn(w), fires(/not read past their refunds/));
  const s = await readDel({ ...recent, tx: { [STX]: "EXECUTED" } }, recent);
  assert.equal(s.settleTx, "unread");
  await assert.rejects(closeOn(s), fires(/not read past their refunds/));
  // a reload: no hash kept, settled long ago (fix 3)
  const none = await readDel({}, {}, { txs: { withdraw: null, settle: null } });
  assert.deepEqual([none.withdrawTx, none.settleTx, none.settledBack], ["unread", "none", 1000 - SETTLE_BLOCKS]);
  await closeOn(none);
  // another settled just now: the row SETTLE_BLOCKS back is not settled
  const now = await readDel(recent, recent, { txs: { withdraw: WTX, settle: null } });
  assert.deepEqual([now.withdrawTx, now.settleTx, now.settledBack], ["final", "none", null]);
  await assert.rejects(closeOn(now), fires(/not read past their refunds/));
  // the RPCs differ on the row back there: no lookback
  assert.equal((await readDel({}, recent, { txs: { withdraw: null, settle: null } })).settledBack, null);
});

test("intents.near: any token under A gates the close, an empty list passes; a split or unread read of intents.near itself is a stop, never 'no intents.near'", async () => {
  const holds = await readDel({ intents: [{ token_id: "nep141:wrap.near" }] });
  assert.equal(holds.intents, "holds");
  await assert.rejects(closeOn(holds), fires(/stranded/));
  const empty = await readDel({ intents: [] });
  assert.equal(empty.intents, "empty");
  await closeOn(empty);
  await assert.rejects(readDel({ intents: [] }, { intents: [{ token_id: "nep141:wrap.near" }] }), ExitOutStopped, "the RPCs differ on the tokens");
  // P3-1: one RPC reads intents.near missing, the other there; or neither answers
  await assert.rejects(readDel({ intents: "absent" }, { intents: [] }), /intents.near is not read the same/, "a split on intents.near");
  await assert.rejects(readDel({ intents: "unread" }), /intents.near is not read the same/, "intents.near unread on both");
  await assert.rejects(readDel({ intents: "unread" }, { intents: "absent" }), /intents.near is not read the same/, "unread on one, absent on the other");
});

test("P2-1: a pair that is not the network's is refused before any read; a halt, a split or another spend stops or gates the close", async () => {
  await assert.rejects(readDel({}, {}, { names: EXIT_NETWORKS.mainnet.rpcs }), /the RPCs must be one of/);
  const halted = await readDel({ usdc: "halt" });
  assert.deepEqual(halted.usdc, { state: "halted" });
  await assert.rejects(closeOn(halted), fires(/USDC is not read at zero/));
  const paid = await readDel({ row: { status: "paid", reserve: "5" } });
  assert.equal(paid.spend.status, "paid");
  await assert.rejects(closeOn(paid), fires(/settled with reserve 0/));
  await assert.rejects(readDel({ row: { status: "paid", reserve: "5" } }, {}), ExitOutStopped, "the RPCs differ on the row");
  await assert.rejects(readDel({ usdc: "halt" }, {}), ExitOutStopped, "a halt on one RPC only");
  await assert.rejects(readDel({ usdc: "4" }, {}), ExitOutStopped, "the RPCs differ on A's USDC");
  await assert.rejects(readDel({ row: { nullifier_hash: "5" } }), ExitOutStopped, "the row is another spend");
  await assert.rejects(readDel({ row: { status: "gone" } }), ExitOutStopped, "a status the vault never writes");
});
