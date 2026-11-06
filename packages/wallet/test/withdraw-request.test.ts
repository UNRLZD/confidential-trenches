// The device's withdrawal request (card wallet-withdraw-request; docs/plan1/wallet.md W2.4 l.1107, WU-06 l.1060, §2.3
// "The held note" l.385-391, §2.5 step 5 l.645; markets.md H3.4 checks 1-4 l.1079-1110, the salt l.3271-3272).
//   node --test test/withdraw-request.test.ts      (from packages/wallet)
// - The request, proved for real (snarkjs 0.7.5's fullProve over the kit's pinned withdraw.wasm and withdraw.zkey, the
//   call the prover worker makes), passes the relayer's own checks 1-4 (apps/helper/src/withdraw/checks.ts,
//   checkWithdraw) on the relayer's fixture config (test/withdraw-fixture.ts).
// - WU-06: the spent note is HELD before the proof and RESERVED before the request is handed back; a failed write of
//   either stops it, with nothing handed back.
// - Refused before proving, with nothing written: a note too small, a spent note, a deadline passed or too close to
//   send, one more than 10 minutes out, a fee at or above the amount.
// - The deadline is read from the block header's timestamp_nanosec string, as the vault reads its block time.
// IndexedDB is fake-indexeddb; Web Locks and WebCrypto are Node's own. Test values only, never money.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { VaultTree, vaultContextInput, vaultContextOf, vaultLabelOf, ZK_SETUP_FILES, type VaultProver, type VaultSnarkjsProof } from "@blindfill/kit";
import { checkWithdraw } from "../../../apps/helper/src/withdraw/checks.ts";
import { armingRegisterDepositOf } from "../src/arming/accounts.ts";
import { NEAR_NETWORKS, type NearNetwork, type NearRpc } from "../src/deposit/account.ts";
import { armAccount } from "../src/derive/index.ts";
import { noteCommitment, noteSecrets } from "../src/notes/secrets.ts";
import { blockTimeMsOf, withdrawDeadlineMs, withdrawRequest, WITHDRAW_SEND_MARGIN_MS } from "../src/withdraw/request.ts";
import { argsFor, BLOCK_MS, BLOCK_NS, closeVaults, FEE_RECIPIENT, REGISTER_DEPOSIT, registerAsked, RELAY_FEE, SCOPE, SEED, signalsProver, TOKEN, VAULT, vaultWith } from "./withdraw-fixture.ts";

// snarkjs is the kit's own (a dev dependency of packages/kit), as prove-e2e.test.ts runs it
const KIT = new URL("../../kit/", import.meta.url);
const snarkjs = createRequire(new URL("package.json", KIT))("snarkjs") as {
  groth16: {
    fullProve(input: unknown, wasm: Uint8Array, zkey: Uint8Array, l: undefined, w: undefined, o: { singleThread: boolean }): Promise<{ proof: VaultSnarkjsProof; publicSignals: string[] }>;
  };
};
after(closeVaults);
after(() => (globalThis as { curve_bn128?: { terminate?: () => void } }).curve_bn128?.terminate?.());
const zk = (f: "withdraw.wasm" | "withdraw.zkey"): Uint8Array => {
  const b = readFileSync(new URL(`zk/${f}`, KIT));
  assert.equal(createHash("sha256").update(b).digest("hex"), ZK_SETUP_FILES[f].sha256, `${f} is not the pinned file`);
  return new Uint8Array(b);
};
function snarkProver(log: string[] = []): VaultProver {
  const wasm = zk("withdraw.wasm");
  const zkey = zk("withdraw.zkey");
  return {
    async load(c) {
      log.push(`load ${c}`);
    },
    async prove(c, input) {
      log.push(`prove ${c}`);
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread: true });
      return { proof, publicSignals, proveMs: 0 };
    },
  };
}
const CFG = { vault: VAULT, token: TOKEN, scope: SCOPE, feeRecipient: FEE_RECIPIENT };
const feeMin = (fee = RELAY_FEE) => ({ feeMin: async () => fee });

test("a real proof of the request passes the relayer's checks 1-4 as written, and the note is RESERVED", async () => {
  const v = await vaultWith();
  registerAsked.length = 0;
  const r = await withdrawRequest(argsFor(v, snarkProver()));
  const verdict = await checkWithdraw(structuredClone(r.body), CFG, feeMin());
  assert.deepEqual(verdict.ok ? "ok" : verdict, "ok");
  // the smallest note covering 3 USDC plus the fee: the 5 USDC one, deposit note of label 2
  assert.equal(r.noteId, v.notes[1]!.id);
  assert.equal((await v.ns.get(r.noteId))?.state, "RESERVED");
  assert.equal(r.changeValue, 5_000_000n - 3_000_000n - RELAY_FEE);
  assert.deepEqual(r.change, { kind: "change", l: v.notes[1]!.leaf!.label, j: 0 });
  assert.equal(r.body.withdrawal.refund_precommitment, noteSecrets(SEED, { kind: "refund", l: v.notes[1]!.leaf!.label, j: 0 }).precommitment.toString());
  assert.match(r.body.withdrawal.salt, /^[0-9a-f]{32}$/);
  assert.equal(r.body.public_signals[7], vaultContextOf(keccak_256, vaultContextInput(VAULT, r.body.withdrawal), SCOPE).toString());
  assert.equal(r.body.public_signals[2], String(3_000_000n + RELAY_FEE));
  assert.equal(r.body.fund_recipient, true);
  // it pays this note's own A_{l,0}, and register_deposit was read for exactly that id
  const a = armAccount(SEED, v.notes[1]!.leaf!.label, 0);
  a.secretKey.fill(0);
  assert.equal(r.recipient, a.id);
  assert.equal(r.body.withdrawal.recipient, a.id);
  assert.deepEqual(registerAsked, [a.id]);
  assert.equal(r.body.withdrawal.register_deposit, REGISTER_DEPOSIT.toString());
  // the same checks refuse it once a field the proof binds moves: the salt, the recipient (another note's A), the
  // deadline and the fee recipient (check 2, the context); and a relayer whose fee recipient is another (check 3)
  const other = armAccount(SEED, v.notes[2]!.leaf!.label, 0);
  other.secretKey.fill(0);
  const moved: [string, (b: typeof r.body) => void, string][] = [
    ["salt", (b) => (b.withdrawal.salt = "0".repeat(32)), "bad_proof"],
    ["recipient", (b) => (b.withdrawal.recipient = other.id), "bad_proof"],
    ["deadline_ms", (b) => (b.withdrawal.deadline_ms += 1), "bad_proof"],
    ["fee_recipient", (b) => (b.withdrawal.fee_recipient = "other.near"), "bad_proof"],
  ];
  for (const [what, move, code] of moved) {
    const b = structuredClone(r.body);
    move(b);
    const no = await checkWithdraw(b, CFG, feeMin());
    assert.equal(no.ok ? "ok" : no.code, code, what);
  }
  const theirs = await checkWithdraw(structuredClone(r.body), { ...CFG, feeRecipient: "other.near" }, feeMin());
  assert.equal(theirs.ok ? "ok" : theirs.code, "bad_fee_recipient");
});

// card vault-refund-precommit-reserve's pin: a stranger's deposit on our refund precommitment R (the vault takes it:
// deposit.rs:109-110 refuses a repeated P among deposits only) costs the user nothing. Our refund note on R is picked
// and proved at its own leaf with its own value, and the stranger's larger leaf on R is never spent. A picker or prover
// that looked notes up by precommitment in the pages, or took the larger leaf on R, fails here.
test("our refund note is spendable after a stranger's deposit on its R: a real proof at our leaf, never the stranger's", async () => {
  const v = await vaultWith([2_000_000n]);
  const parent = v.notes[0]!;
  const refund = { kind: "refund", l: parent.leaf!.label, j: 0 } as const;
  const R = noteSecrets(SEED, refund).precommitment;
  // the stranger's 50 USDC deposit on R, then settle's 7 USDC refund note on R, each with its own label
  const theirLabel = vaultLabelOf(keccak_256, SCOPE, 2n);
  const ourLabel = vaultLabelOf(keccak_256, SCOPE, 3n);
  const theirs = noteCommitment(50_000_000n, theirLabel, R);
  const ours = noteCommitment(7_000_000n, ourLabel, R);
  const state = [...v.stateLeaves, theirs, ours];
  const labels = [...v.labelLeaves, theirLabel, ourLabel];
  const stateTree = new VaultTree(state);
  const labelTree = new VaultTree(labels);
  const note = await v.ns.add({ ref: refund, scope: SCOPE, precommitment: R, state: "UNSPENT", parent: parent.id, leaf: { value: 7_000_000n, label: ourLabel, commitment: ours, leafIndex: BigInt(state.length - 1) } });
  assert.equal((await v.ns.get(parent.id))?.state, "SPENT");
  const r = await withdrawRequest(argsFor(v, snarkProver(), { stateTree, labelTree, newestStateRoot: stateTree.root!, newestLabelRoot: labelTree.root! }));
  const verdict = await checkWithdraw(structuredClone(r.body), CFG, feeMin());
  assert.deepEqual(verdict.ok ? "ok" : verdict, "ok");
  assert.equal(r.noteId, note.id);
  assert.equal(r.changeValue, 7_000_000n - 3_000_000n - RELAY_FEE, "proved on our 7 USDC, not the stranger's 50");
  assert.equal(r.body.public_signals[1], noteSecrets(SEED, refund).nullifierHash.toString());
  assert.equal(r.body.public_signals[3], stateTree.root!.toString());
  assert.deepEqual(r.change, { kind: "change", l: ourLabel, j: 0 });
});

test("WU-06: HELD is written before the proof, RESERVED after it and before the request is handed back", async () => {
  const v = await vaultWith();
  const log: string[] = [];
  const states = new Map<string, string>();
  v.failPut.on = (rec) => {
    const s = (rec as { state?: string }).state;
    if (s === "HELD" || s === "RESERVED") log.push(`write ${s}`);
    return false;
  };
  const r = await withdrawRequest(argsFor(v, signalsProver(log)));
  log.push("handed back");
  assert.deepEqual(log, ["write HELD", "load withdraw", "prove withdraw", "write RESERVED", "handed back"]);
  states.set(r.noteId, (await v.ns.get(r.noteId))!.state);
  assert.equal(states.get(r.noteId), "RESERVED");
  // a second request never picks the RESERVED note: it takes the next that covers, the 10 USDC one
  const r2 = await withdrawRequest(argsFor(v, signalsProver()));
  assert.equal(r2.noteId, v.notes[2]!.id);
});

test("WU-06: a failed HELD write stops the request before any proof", async () => {
  const v = await vaultWith();
  const p = signalsProver();
  v.failPut.on = (rec) => (rec as { state?: string }).state === "HELD";
  await assert.rejects(withdrawRequest(argsFor(v, p)), /refused the write/);
  assert.deepEqual(p.log, []);
  assert.deepEqual((await v.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT", "UNSPENT"]);
});

test("WU-06: a failed RESERVED write stops the request: nothing is handed back and the note is freed", async () => {
  const v = await vaultWith();
  const p = signalsProver();
  v.failPut.on = (rec) => (rec as { state?: string }).state === "RESERVED";
  await assert.rejects(withdrawRequest(argsFor(v, p)), /refused the write/);
  assert.deepEqual(p.log, ["load withdraw", "prove withdraw"]);
  assert.equal((await v.ns.get(v.notes[1]!.id))?.state, "UNSPENT");
});

test("a proof that fails frees the note, and the failure reaches the caller", async () => {
  const v = await vaultWith();
  const broken: VaultProver = { load: async () => {}, prove: async () => Promise.reject(new Error("the prover died")) };
  await assert.rejects(withdrawRequest(argsFor(v, broken)), /the prover died/);
  assert.equal((await v.ns.get(v.notes[1]!.id))?.state, "UNSPENT");
});

test("refused before proving, with no note written: too small, spent, deadline passed or too far, fee at the amount", async () => {
  const cases: [string, (v: Awaited<ReturnType<typeof vaultWith>>) => Promise<unknown>, RegExp][] = [
    ["a note too small", (v) => withdrawRequest(argsFor(v, signalsProver(), { amount: 10_000_000n })), /no unspent note covers/],
    [
      "a spent note",
      async (v) => {
        await v.ns.move(v.notes[2]!.id, "UNSPENT", "SPENT");
        return withdrawRequest(argsFor(v, signalsProver(), { amount: 6_000_000n }));
      },
      /no unspent note covers/,
    ],
    ["a deadline in the past", (v) => withdrawRequest(argsFor(v, signalsProver(), { deadlineMs: BLOCK_MS - 1 })), /deadlineMs: passed/],
    ["a deadline at the block time", (v) => withdrawRequest(argsFor(v, signalsProver(), { deadlineMs: BLOCK_MS })), /deadlineMs: passed/],
    ["a deadline inside the send margin", (v) => withdrawRequest(argsFor(v, signalsProver(), { deadlineMs: BLOCK_MS + WITHDRAW_SEND_MARGIN_MS })), /too close to send/],
    ["a deadline more than 10 minutes out", (v) => withdrawRequest(argsFor(v, signalsProver(), { deadlineMs: BLOCK_MS + 600_001 })), /more than 10 minutes/],
    ["a fee at the amount", (v) => withdrawRequest(argsFor(v, signalsProver(), { amount: RELAY_FEE })), /at or above the amount/],
    ["a block time read as a number", (v) => withdrawRequest(argsFor(v, signalsProver(), { blockTimestampNanosec: 1793750000123999999 as unknown as string })), /timestamp_nanosec/],
  ];
  for (const [what, run, why] of cases) {
    const v = await vaultWith();
    const before = (await v.ns.list()).map((n) => n.state).join();
    let writes = 0;
    v.failPut.on = () => (writes++, false);
    const p = signalsProver();
    await assert.rejects(run(v) as Promise<unknown>, why, what);
    assert.equal(writes, what === "a spent note" ? 1 : 0, `${what}: no write by the request`);
    assert.ok(!p.log.length, `${what}: no proof`);
    if (what !== "a spent note") assert.equal((await v.ns.list()).map((n) => n.state).join(), before, what);
  }
});

test("the deadline comes from the header's timestamp_nanosec string, floored to ms as the vault reads its block time", () => {
  assert.equal(blockTimeMsOf(BLOCK_NS), BLOCK_MS);
  assert.equal(blockTimeMsOf("1793750000123000000"), BLOCK_MS);
  assert.notEqual(BigInt(Number(BLOCK_NS)), BigInt(BLOCK_NS), "the number form loses the nanoseconds past 2^53");
  for (let k = 0; k < 200; k++) {
    const d = withdrawDeadlineMs(BLOCK_NS);
    assert.ok(Number.isSafeInteger(d) && d > BLOCK_MS + 600_000 - 65_536 && d <= BLOCK_MS + 600_000, String(d));
  }
  for (const bad of ["", "01", "-1", "1.5", "0x10", " 1"]) assert.throws(() => blockTimeMsOf(bad), /timestamp_nanosec/);
});

test("the request's deadline from withdrawDeadlineMs passes, and is the one in its context", async () => {
  const v = await vaultWith();
  const deadlineMs = withdrawDeadlineMs(BLOCK_NS);
  const r = await withdrawRequest(argsFor(v, signalsProver(), { deadlineMs }));
  assert.equal(r.body.withdrawal.deadline_ms, deadlineMs);
  assert.equal((await v.ns.get(r.noteId))?.deadlineMs, BigInt(deadlineMs));
});

// The attempt's context on the note (wallet.md l.214-217: recorded before its proof, so "own" can be read from the
// vault's spends record later; an earlier attempt may land until its own deadline, so no entry is ever removed).
test("HELD writes the attempt's context on the note before the proof starts", async () => {
  const v = await vaultWith();
  let seen: unknown;
  const p = signalsProver();
  const prove = p.prove.bind(p);
  p.prove = async (c, input) => {
    seen = (await v.ns.get(v.notes[1]!.id))?.contexts;
    return prove(c, input);
  };
  const r = await withdrawRequest(argsFor(v, p));
  const want = [{ context: r.body.public_signals[7], deadlineMs: BigInt(r.body.withdrawal.deadline_ms) }];
  assert.deepEqual(seen, want, "the context was not stored before the proof");
  assert.deepEqual((await v.ns.get(r.noteId))?.contexts, want);
});

test("a freed attempt, never sent, leaves no context; a sent attempt's stays through RESERVED and back to UNSPENT", async () => {
  const v = await vaultWith();
  const broken: VaultProver = { load: async () => {}, prove: async () => Promise.reject(new Error("the prover died")) };
  await assert.rejects(withdrawRequest(argsFor(v, broken)), /the prover died/);
  const first = (await v.ns.get(v.notes[1]!.id))!;
  assert.equal(first.state, "UNSPENT");
  assert.equal(first.contexts, undefined, "a freed attempt was never sent: its context goes");
  const r = await withdrawRequest(argsFor(v, signalsProver()));
  assert.equal(r.noteId, v.notes[1]!.id);
  const n = (await v.ns.get(r.noteId))!;
  assert.deepEqual(n.contexts?.map((c) => c.context), [r.body.public_signals[7]]);
  const back = await v.ns.move(r.noteId, "RESERVED", "UNSPENT", { blockTimeMs: BigInt(r.body.withdrawal.deadline_ms) + 1n });
  assert.equal(back.contexts?.length, 1, "a sent attempt's context stays: it can land until its deadline");
  const spent = await v.ns.move(r.noteId, "UNSPENT", "SPENT");
  assert.equal(spent.contexts?.length, 1, "no move but a free of HELD removes an entry");
});

test("a move to HELD without a context, or with a bad or repeated one, is refused with nothing written", async () => {
  const v = await vaultWith();
  const id = v.notes[0]!.id;
  const deadlineMs = BigInt(BLOCK_MS + 590_000);
  await assert.rejects(v.ns.move(id, "UNSPENT", "HELD", { deadlineMs }), /context/);
  for (const bad of ["", "01", "-1", "0x1", 5n as unknown as string, String(21888242871839275222246405745257275088548364400416034343698204186575808495617n)])
    await assert.rejects(v.ns.move(id, "UNSPENT", "HELD", { deadlineMs, context: bad }), /context/, String(bad));
  assert.equal((await v.ns.get(id))?.state, "UNSPENT");
  assert.equal((await v.ns.get(id))?.contexts, undefined);
  const h = await v.ns.move(id, "UNSPENT", "HELD", { deadlineMs, context: "42" });
  await assert.rejects(v.ns.move(id, "HELD", "RESERVED", { attempt: h.attempt, context: "43" } as never), /context/);
  // a sent attempt's context stays, so it is never written again (a freed, unsent one leaves none, store.ts)
  await v.ns.move(id, "HELD", "RESERVED", { attempt: h.attempt });
  await v.ns.move(id, "RESERVED", "UNSPENT", { blockTimeMs: deadlineMs + 1n });
  await assert.rejects(v.ns.move(id, "UNSPENT", "HELD", { deadlineMs, context: "42" }), /written twice/);
});

test("a stored note with a bad context list is refused on read", async () => {
  const cases: [string, (n: Record<string, unknown>) => void, RegExp][] = [
    ["a context not below p", (n) => ((n.contexts as { context: string }[])[0]!.context = String(1n << 254n)), /context/],
    ["a context not canonical", (n) => ((n.contexts as { context: string }[])[0]!.context = "042"), /context/],
    ["a context written twice", (n) => (n.contexts = [...(n.contexts as unknown[]), ...(n.contexts as unknown[])]), /written twice/],
    ["an empty list", (n) => (n.contexts = []), /contexts/],
    ["a list on a note never HELD", (n) => ((n.state = "INCOMING"), delete n.leaf, delete n.deadlineMs, delete n.attempt, delete n.tab), /contexts/],
    ["a HELD note with no list", (n) => delete n.contexts, /contexts/],
    ["a HELD note whose last entry is another deadline", (n) => ((n.contexts as { deadlineMs: bigint }[])[0]!.deadlineMs = 1n), /contexts/],
    ["an entry with another field", (n) => ((n.contexts as Record<string, unknown>[])[0]!.salt = "00"), /may not hold salt/],
    ["an earlier entry's deadline not a u64", (n) => (n.contexts = [{ context: "6", deadlineMs: 5 }, ...(n.contexts as unknown[])]), /deadlineMs/],
  ];
  for (const [what, spoil, why] of cases) {
    const v = await vaultWith();
    const id = v.notes[0]!.id;
    await v.ns.move(id, "UNSPENT", "HELD", { deadlineMs: BigInt(BLOCK_MS + 590_000), context: "7" });
    const rec = structuredClone((await v.w.get("notes", id)) as Record<string, unknown>);
    spoil(rec);
    await v.w.put("notes", id, rec);
    await assert.rejects(v.ns.get(id), why, what);
  }
});

// A label's chain of notes: the deposit note, then change 0, 1 and 2, each landed as sync lands it (the child UNSPENT on
// its leaf, its parent SPENT), with the page dying during a proof in the middle and a retry from a new tab.
test("deposit -> change 0 -> change 1 -> change 2, a crash and retry in the middle: every (l, j) and secret its own", async () => {
  const v = await vaultWith([20_000_000n]);
  const seen = { lj: new Set<string>(), nullifierHash: new Set<string>(), refund: new Set<string>(), recipient: new Set<string>() };
  let spends = v.notes[0]!.id;
  for (let k = 0; k < 3; k++) {
    if (k === 1) {
      const dying: VaultProver = {
        load: async () => {},
        prove: async () => {
          v.ns.close(); // the page dies mid-proof: its tab lock goes, nothing more is written
          throw new Error("the page died");
        },
      };
      await assert.rejects(withdrawRequest(argsFor(v, dying, { amount: 1_000_000n })), /the page died/);
      await v.reopen();
      assert.equal((await v.ns.get(spends))?.state, "UNSPENT", "a new tab frees the dead tab's HELD note at once");
    }
    const r = await withdrawRequest(argsFor(v, signalsProver(), { amount: 1_000_000n }));
    assert.equal(r.noteId, spends, `spend ${k}: the label's newest note is the one picked`);
    assert.equal(r.change.j, k, `spend ${k}: change index`);
    for (const [set, x] of [
      [seen.lj, `${r.change.l}/${r.change.j}`],
      [seen.nullifierHash, r.body.public_signals[1]],
      [seen.refund, r.body.withdrawal.refund_precommitment],
      [seen.recipient, r.recipient],
    ] as const) {
      assert.ok(!set.has(x), `spend ${k}: a repeat`);
      set.add(x);
    }
    // the proof's newCommitmentHash is the commitment of the change note this device derives and lands
    const pc = noteSecrets(SEED, r.change).precommitment;
    const commitment = noteCommitment(r.changeValue, r.change.l, pc);
    assert.equal(r.body.public_signals[0], commitment.toString(), `spend ${k}: newCommitmentHash`);
    v.stateTree.append([commitment]);
    const child = await v.ns.add({ ref: r.change, scope: SCOPE, precommitment: pc, state: "UNSPENT", leaf: { value: r.changeValue, label: r.change.l, commitment, leafIndex: BigInt(v.stateTree.size - 1) } });
    assert.equal((await v.ns.get(spends))?.state, "SPENT", `spend ${k}: the parent is SPENT once its change lands`);
    if (k === 1) assert.equal((await v.ns.get(spends))?.contexts?.length, 1, "the dead tab's attempt was never sent: its context goes");
    spends = child.id;
  }
});

test("boundaries: an exact cover, the deadline at T + 600,000, another scope's note never picked, a negative fee refused", async () => {
  const v = await vaultWith();
  // exact cover: the 2 USDC note pays 2 USDC less the fee, leaving change 0
  const exact = await withdrawRequest(argsFor(v, signalsProver(), { amount: 2_000_000n - RELAY_FEE }));
  assert.equal(exact.noteId, v.notes[0]!.id);
  assert.equal(exact.changeValue, 0n);
  // the latest deadline the request takes: T + 600,000 exactly
  const late = await withdrawRequest(argsFor(v, signalsProver(), { deadlineMs: BLOCK_MS + 600_000 }));
  assert.equal(late.body.withdrawal.deadline_ms, BLOCK_MS + 600_000);
  // a 100 USDC note of another vault's scope in the same store: never picked
  const other = SCOPE + 1n;
  let n = await v.ns.planDeposit(other, (ref) => noteSecrets(SEED, ref).precommitment);
  n = await v.ns.move(n.id, "PLANNED", "INCOMING");
  await v.ns.move(n.id, "INCOMING", "UNSPENT", { leaf: { value: 100_000_000n, label: 99n, commitment: noteCommitment(100_000_000n, 99n, n.precommitment), leafIndex: 0n } });
  const p = signalsProver();
  await assert.rejects(withdrawRequest(argsFor(v, p, { amount: 50_000_000n })), /no unspent note covers/);
  assert.deepEqual(p.log, []);
  await assert.rejects(withdrawRequest(argsFor(v, p, { relayFee: -1n })), /relayFee: below 0/);
  assert.deepEqual(p.log, []);
});

// A's registration read on the network's two operators, from the recorded null answers and bounds
// (test/vectors/arming-accounts.json): the answers do not depend on the account asked.
const ARMING = JSON.parse(readFileSync(new URL("./vectors/arming-accounts.json", import.meta.url), "utf8")) as {
  answers: Record<string, { a: { json: unknown }; b: { json: unknown } }>;
};
function nullRegistration(net: NearNetwork, seen: unknown[]): [NearRpc, NearRpc] {
  const t = net === "testnet" ? "_testnet" : "";
  const side = (s: "a" | "b", name: string): NearRpc => ({
    name,
    async query(params) {
      seen.push(params);
      const m = (params as { method_name: string }).method_name === "storage_balance_of" ? "reg_null" : "bounds";
      return structuredClone(ARMING.answers[m + t]![s].json);
    },
  });
  return [side("a", NEAR_NETWORKS[net].fastnear[0]), side("b", NEAR_NETWORKS[net].drpc)];
}

test("A's registration is read on the withdrawal's own token: another network's read is refused, nothing read, written or proved", async () => {
  const v = await vaultWith();
  const seen: unknown[] = [];
  let writes = 0;
  v.failPut.on = () => (writes++, false);
  const p = signalsProver();
  // TOKEN is mainnet's: a read set up for testnet would read another token's registration
  await assert.rejects(withdrawRequest(argsFor(v, p, { registerDepositOf: armingRegisterDepositOf("testnet", nullRegistration("testnet", seen)) })), /token/);
  assert.equal(seen.length, 0, "no read");
  assert.equal(writes, 0, "no write");
  assert.deepEqual(p.log, [], "no proof");
  assert.deepEqual((await v.ns.list()).map((n) => n.state), ["UNSPENT", "UNSPENT", "UNSPENT"]);
  // on its own network the read is made for the request's own A, and its register_deposit is the one bound
  const r = await withdrawRequest(argsFor(v, signalsProver(), { registerDepositOf: armingRegisterDepositOf("mainnet", nullRegistration("mainnet", seen)) }));
  assert.equal(seen.length, 4);
  for (const q of seen as { account_id: string }[]) assert.equal(q.account_id, TOKEN);
  assert.equal(r.body.withdrawal.register_deposit, "1250000000000000000000");
});
