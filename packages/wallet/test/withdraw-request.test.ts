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
import { vaultContextInput, vaultContextOf, ZK_SETUP_FILES, type VaultProver, type VaultSnarkjsProof } from "@blindfill/kit";
import { checkWithdraw } from "../../../apps/helper/src/withdraw/checks.ts";
import { noteSecrets } from "../src/notes/secrets.ts";
import { blockTimeMsOf, withdrawDeadlineMs, withdrawRequest, WITHDRAW_SEND_MARGIN_MS } from "../src/withdraw/request.ts";
import { argsFor, BLOCK_MS, BLOCK_NS, closeVaults, FEE_RECIPIENT, RELAY_FEE, SCOPE, SEED, signalsProver, TOKEN, VAULT, vaultWith } from "./withdraw-fixture.ts";

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
  // the same checks refuse it once a field the proof binds moves: the salt (check 2), and the fee recipient (check 3)
  const salted = structuredClone(r.body);
  salted.withdrawal.salt = "0".repeat(32);
  assert.equal((await checkWithdraw(salted, CFG, feeMin())).ok, false);
  assert.equal((await checkWithdraw(structuredClone(r.body), { ...CFG, feeRecipient: "other.near" }, feeMin())).ok, false);
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
