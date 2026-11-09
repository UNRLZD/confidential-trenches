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
import { vaultCommitment, VaultTree, type VaultProver, type VaultSpendRow, type VaultSyncRpc } from "@blindfill/kit";
import { MoveOutRefused, noteSecrets, wordsToSeed64, type BuiltMove, type DeleteReadFor, type RestoredNote, type SettleReadFor } from "@blindfill/kit/core";
import { EXIT_NETWORKS } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { exitKey, ExitOutStopped, exitRecipient, type ExitRecipient } from "../src/out.ts";
import { exitBuildDelete, exitBuildWithdraw, exitReadDelete, exitWithdrawIndex, exitWithdrawOne, type ExitSent, type ExitWithdrawSteps } from "../src/withdraw.ts";

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

async function build(note: RestoredNote, o: { to?: ExitRecipient; tamper?: (s: string[]) => string[]; keys?: Uint8Array[] } = {}) {
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
  const out = await exitBuildWithdraw({ seed64: SEED, network: NET, note, to: o.to ?? (await typed()), prover: fakeProver(note, l, j, seen, o.tamper), stateTree: st, labelTree: lt, newestStateRoot: st.root!, newestLabelRoot: lt.root!, registerDeposit: REG, nowMs: NOW, deadlineMs: NOW + 500_000, read }, keyOf);
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

const NH = noteSecrets(SEED, { kind: "deposit", s: 1n, i: 0 }).nullifierHash;
const L = LABEL, J = 0;
const delRead = (o: Partial<DeleteReadFor> = {}): DeleteReadFor => ({ a: aOf(L, J), to: X, token: TOKEN, height: 100, blockHash: BH, nonce: 9n, spend: { nullifierHash: NH, status: "settled", reserve: 0n }, usdc: { state: "held", amount: 0n }, intents: null, ...o });

test("exitBuildDelete: A's DeleteAccount to the typed account once the spend reads settled with reserve 0; refused before settle, with reserve above 0, with USDC halted or left in A, or money under A in intents.near", async () => {
  const to = await typed();
  const m = exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: delRead(), nullifierHash: NH });
  assert.equal(m.receiver, aOf(L, J));
  assert.deepEqual(m.calls, [{ method: "DeleteAccount", beneficiary_id: X }]);
  for (const [why, r] of [
    ["before settle: in_flight", delRead({ spend: { nullifierHash: NH, status: "in_flight", reserve: 5n } })],
    ["before settle: paid", delRead({ spend: { nullifierHash: NH, status: "paid", reserve: 5n } })],
    ["before settle: refund_pending", delRead({ spend: { nullifierHash: NH, status: "refund_pending", reserve: 5n } })],
    ["reserve above 0", delRead({ spend: { nullifierHash: NH, status: "settled", reserve: 1n } })],
    ["USDC halted", delRead({ usdc: { state: "halted" } })],
    ["USDC left in A", delRead({ usdc: { state: "held", amount: 3n } })],
    ["money under A in intents.near", delRead({ intents: 2n })],
  ] as const)
    assert.throws(() => exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: r, nullifierHash: NH }), MoveOutRefused, why);
});

/** Fake steps: the spends row's states in turn, what each send reads, and the sends in order by their one action. */
function world(o: { rows: (Partial<VaultSpendRow> | null)[]; sent?: Partial<Record<string, ExitSent>>; del?: Partial<DeleteReadFor> }) {
  const order: string[] = [];
  const rows = [...o.rows];
  const steps: ExitWithdrawSteps = {
    withdraw: async () => {
      const note = noteOf({ kind: "deposit", s: 1n, i: 0 });
      const { out } = await build(note);
      return out;
    },
    send: async (m) => {
      const what = m.calls[0]!.method;
      order.push(what);
      return o.sent?.[what] ?? "ok";
    },
    spend: async () => {
      const r = rows.shift();
      return r === null || r === undefined ? null : ({ index: 3, nullifierHash: NH, status: "paid", reserve: 5n, ...r } as VaultSpendRow);
    },
    readA: async (a) => ({ height: 100, blockHash: BH, nonce: 8n, free: 10n ** 24n, gasPrice: 100_000_000n, a }),
    readDelete: async (a, index, nh) => {
      order.push(`read ${index}`);
      return { ...delRead({ a, spend: { nullifierHash: nh, status: "settled", reserve: 0n } }), ...o.del };
    },
  };
  return { steps, order };
}

test("exitWithdrawOne runs withdraw, then settle, then A's DeleteAccount, each once the one before landed; a spend someone else settled needs no settle", async () => {
  const to = await typed();
  const a = world({ rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }] });
  const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: a.steps });
  assert.equal(out.stage, "closed");
  assert.deepEqual(a.order, ["withdraw", "settle", "read 3", "DeleteAccount"]);
  assert.equal(out.txs.length, 3);
  const b = world({ rows: [{ status: "settled", reserve: 0n }] });
  assert.equal((await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: b.steps })).stage, "closed");
  assert.deepEqual(b.order, ["withdraw", "read 3", "DeleteAccount"]);
});

test("exitWithdrawOne never sends a DeleteAccount before the settle landed: a withdrawal or settle that did not land, a spend still paid or with reserve above 0 after it, USDC halted or left in A stop it", async () => {
  const to = await typed();
  const cases: [string, Parameters<typeof world>[0], string, string[]][] = [
    ["the withdrawal failed", { rows: [], sent: { withdraw: "failed" } }, "withdraw", ["withdraw"]],
    // a later row reading settled (another's settle, or a stale word) does not stand in for this settle's own landing
    ["the settle failed", { rows: [{ status: "paid", reserve: 5n }, { status: "settled", reserve: 0n }], sent: { settle: "failed" } }, "settle", ["withdraw", "settle"]],
    ["the settle unread", { rows: [{ status: "refund_pending", reserve: 5n }, { status: "settled", reserve: 0n }], sent: { settle: "unread" } }, "settle", ["withdraw", "settle"]],
    ["still paid after the settle", { rows: [{ status: "paid", reserve: 5n }, { status: "paid", reserve: 5n }] }, "settle", ["withdraw", "settle"]],
    ["settled with reserve above 0", { rows: [{ status: "settled", reserve: 1n }] }, "settle", ["withdraw"]],
    ["the payout still in flight", { rows: [{ status: "in_flight", reserve: 5n }] }, "settle", ["withdraw"]],
    ["the spend not read", { rows: [null] }, "settle", ["withdraw"]],
    ["USDC halted at the close", { rows: [{ status: "settled", reserve: 0n }], del: { usdc: { state: "halted" } } }, "close", ["withdraw", "read 3"]],
    ["USDC left in A at the close", { rows: [{ status: "settled", reserve: 0n }], del: { usdc: { state: "held", amount: 1n } } }, "close", ["withdraw", "read 3"]],
    ["reserve above 0 at the close read", { rows: [{ status: "settled", reserve: 0n }], del: { spend: { nullifierHash: NH, status: "settled", reserve: 2n } } }, "close", ["withdraw", "read 3"]],
  ];
  for (const [why, w, stage, order] of cases) {
    const x = world(w);
    const out = await exitWithdrawOne({ seed64: SEED, network: NET, to, steps: x.steps });
    assert.equal(out.stage, stage, why);
    assert.deepEqual(x.order, order, why);
    assert.ok(!x.order.includes("DeleteAccount"), `${why}: a DeleteAccount was sent`);
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
const view = (v: unknown, at: number) => ({ result: { block_height: at, result: [...new TextEncoder().encode(JSON.stringify(v))] } });
const PAUSED = { error: { cause: { name: "CONTRACT_EXECUTION_ERROR" }, data: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })' } };
type Side = { row?: Record<string, unknown>; usdc?: string | "halt"; final?: number };
/** One fake RPC of the release pair, answering readSettle's, the spends view's and exitHoldings' reads. */
function side(name: string, aId: string, pk: Uint8Array, o: Side = {}) {
  const row = { index: 3, nullifier_hash: NH.toString(), withdrawn: "1000000", new_leaf_index: 1, refund_precommitment: "7", refund_value: "0", refund_label: "0", refund_leaf_index: 0, status: "settled", payer: aId, reserve: "0", recipient: X, fee: "0", context: "9", ...o.row };
  return {
    name,
    block: async (p: unknown) => ({ result: { header: { height: (p as { finality?: string }).finality ? (o.final ?? 1000) : (p as { block_id: number }).block_id, hash: BH } } }),
    call: async () => ({ result: { gas_price: "100000000" } }),
    tx: async () => null,
    query: async (p: Record<string, unknown>) => {
      const at = p.block_id as number;
      if (p.request_type === "view_access_key_list") return { result: { block_height: at, keys: [{ public_key: `ed25519:${b58(pk)}`, access_key: { nonce: 9, permission: "FullAccess" } }] } };
      if (p.request_type === "view_account") return { result: { block_height: at, amount: "2000000000000000000000000", storage_usage: 182, code_hash: BH } };
      if (p.method_name === "spends") return view([row], at);
      if (p.method_name === "ft_balance_of") return o.usdc === "halt" ? PAUSED : view(o.usdc ?? "0", at);
      return null;
    },
  };
}
async function readDel(x: Side = {}, y: Side = {}) {
  const k = exitKey(SEED, { kind: "A", l: L, j: J });
  k.secretKey.fill(0);
  const [na, nb] = EXIT_NETWORKS[NET].rpcs;
  const r = [side(na, k.id, k.publicKey, x), side(nb, k.id, k.publicKey, y)] as const;
  return exitReadDelete({ network: NET, aId: k.id, to: await typed(), spendIndex: 3, nullifierHash: NH, rpcs: r as never, moveRpcs: r as never });
}

test("exitReadDelete reads A's nonce, the spend's row and A's USDC at one block on both RPCs; a split, a halt or another spend stops or gates it", async () => {
  const ok = await readDel();
  assert.equal(ok.height, 1000);
  assert.equal(ok.nonce, 9n);
  assert.deepEqual(ok.spend, { nullifierHash: NH, status: "settled", reserve: 0n });
  assert.deepEqual(ok.usdc, { state: "held", amount: 0n });
  assert.equal(ok.intents, null);
  exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to: await typed(), read: ok, nullifierHash: NH });
  // halted on both: read as halted, and the close is refused on it
  const halted = await readDel({ usdc: "halt" }, { usdc: "halt" });
  assert.deepEqual(halted.usdc, { state: "halted" });
  const to = await typed();
  assert.throws(() => exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: halted, nullifierHash: NH }), MoveOutRefused);
  // paid on both: read, and the close is refused on it
  const paid = await readDel({ row: { status: "paid", reserve: "5" } }, { row: { status: "paid", reserve: "5" } });
  assert.equal(paid.spend.status, "paid");
  assert.throws(() => exitBuildDelete({ seed64: SEED, network: NET, l: L, j: J, to, read: paid, nullifierHash: NH }), MoveOutRefused);
  await assert.rejects(readDel({ row: { status: "paid", reserve: "5" } }, {}), ExitOutStopped, "the RPCs differ on the row");
  await assert.rejects(readDel({ usdc: "halt" }, {}), ExitOutStopped, "a halt on one RPC only");
  await assert.rejects(readDel({ usdc: "4" }, {}), ExitOutStopped, "the RPCs differ on A's USDC");
  await assert.rejects(readDel({ row: { nullifier_hash: "5" } }, { row: { nullifier_hash: "5" } }), ExitOutStopped, "the row is another spend");
  await assert.rejects(readDel({ row: { status: "gone" } }, { row: { status: "gone" } }), ExitOutStopped, "a status the vault never writes");
});
