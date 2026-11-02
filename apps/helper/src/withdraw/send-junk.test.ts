// The review's junk repro, held (card relayer-withdraw-send, F1): three proofs, each over a one-leaf tree of the
// sender's own that the vault never had, proved for the fixture's vault and scope with the kit's own inputs and zk files.
// Each passes checks 1-4 (a real Groth16 proof) and is a fresh nullifier, so before check 5's root views every one was
// signed and sent and burnt the relayer's gas at the vault's row 5 without bound. Check 5 answers unknown_root now,
// with nothing signed.
//   node --test apps/helper/src/withdraw/send-junk.test.ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { VAULT_CONSTANTS, VAULT_FIELD_P, vaultProof } from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import type { Relayer, RelayerAction, Rpc, TxOutcome, TxRef } from "../bind/send.ts";
import { USDC_CODE_HASH, type TokenStatus } from "../token-status/status.ts";
import type { WithdrawConfig } from "./checks.ts";
import { createWithdrawSendStore, type LeavesIndex, type SpendsIndex } from "./index.ts";
import { carryWithdraw, type WithdrawSendDeps } from "./send.ts";

const KIT = join(import.meta.dirname, "../../../../packages/kit");
const ZK = join(KIT, "zk");
const req = createRequire(join(KIT, "package.json"));
const snarkjs = await import(pathToFileURL(req.resolve("snarkjs")).href);
const { poseidon1 } = await import(pathToFileURL(req.resolve("poseidon-lite/poseidon1")).href);
const { poseidon2 } = await import(pathToFileURL(req.resolve("poseidon-lite/poseidon2")).href);
const { poseidon3 } = await import(pathToFileURL(req.resolve("poseidon-lite/poseidon3")).href);
const { VaultTree, vaultWithdrawInput } = await import(pathToFileURL(join(KIT, "src/vault/inputs.ts")).href);

// snarkjs keeps its curve's worker threads alive after the last proof
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/withdraw-request.json"), "utf8"));
const CFG: WithdrawConfig = { vault: fixture.vault, token: VAULT_CONSTANTS.TOKEN, scope: BigInt(fixture.scope), feeRecipient: fixture.fee_recipient };
const DEADLINE = BigInt(fixture.request.withdrawal.deadline_ms);
const rnd = () => BigInt(`0x${randomBytes(31).toString("hex")}`) % VAULT_FIELD_P;
const hashOf = (h: number) => base58(createHash("sha256").update(`block ${h}`).digest());

const asked: string[] = [];
/** A vault that never had the junk's roots: both root views false; the pool, the token and the recipient all pass. */
function provider(ms: bigint): Rpc {
  return async (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === "block") {
      const h = p.finality === "final" ? 1000 : Number(p.block_id);
      return { header: { height: h, hash: hashOf(h), prev_height: h - 1, gas_price: "100000000", timestamp_nanosec: (ms * 1_000_000n).toString() } };
    }
    if (method === "query" && p.request_type === "call_function") {
      asked.push(String(p.method_name));
      let v: unknown;
      if (p.method_name === "storage_balance_of") v = { total: "1250000000000000000000", available: "0" };
      else if (p.method_name === "storage_balance_bounds") v = { min: "1250000000000000000000", max: "1250000000000000000000" };
      else if (p.method_name === "is_known_state_root" || p.method_name === "is_known_label_root") v = false;
      else if (p.method_name === "totals") v = { deposited: "1000000000000", spent: "0", returned: "0" };
      else throw new Error(`no view ${String(p.method_name)}`);
      return { result: [...Buffer.from(JSON.stringify(v))], block_height: Number(p.block_id), block_hash: hashOf(Number(p.block_id)), logs: [] };
    }
    throw new Error(`no method ${method} ${String(p.request_type)}`);
  };
}

/** A note the vault never had, in a one-leaf tree of the sender's own, proved for the fixture's vault and scope. */
async function junk() {
  const value = 1_000_000n;
  const label = rnd();
  const nullifier = rnd();
  const secret = rnd();
  const commitment = poseidon3([value, label, poseidon2([nullifier, secret])]);
  const stateTree = new VaultTree([commitment]);
  const labelTree = new VaultTree([label]);
  const withdrawal = {
    recipient: "attacker.near",
    register_deposit: "0",
    fee_recipient: CFG.feeRecipient,
    relay_fee: fixture.request.withdrawal.relay_fee,
    refund_precommitment: rnd().toString(),
    deadline_ms: Number(DEADLINE),
    salt: randomBytes(16).toString("hex"),
  };
  const input = vaultWithdrawInput({
    stateTree, labelTree, newestStateRoot: stateTree.root, newestLabelRoot: labelTree.root,
    note: { value, label, nullifier, secret }, newNullifier: rnd(), newSecret: rnd(), withdrawn: value,
    withdrawal, vaultId: CFG.vault, scope: CFG.scope, nowMs: Number(DEADLINE) - 120_000,
  });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(ZK, "withdraw.wasm"), join(ZK, "withdraw.zkey"));
  return { body: { withdrawal, proof: vaultProof(proof), public_signals: publicSignals, fund_recipient: false, token: VAULT_CONSTANTS.TOKEN }, nfh: poseidon1([nullifier]) };
}

test("junk: three proofs over trees the vault never had answer unknown_root, nothing signed, the root views asked", async () => {
  const sent: { action: RelayerAction; tx: TxRef }[] = [];
  let n = 1n;
  const relayer: Relayer = {
    account: "relay.test.near",
    key: "relay.test.near/ed25519:test",
    balance: async () => 10n ** 24n,
    async send<C extends string>(action: RelayerAction, guard: () => Promise<C | null>, before: (tx: TxRef) => void) {
      const code = await guard();
      if (code !== null) return { kind: "guarded" as const, code };
      const tx: TxRef = { tx_hash: base58(createHash("sha256").update(`t ${n}`).digest()), nonce: (n++).toString(), height: "999", block_hash: hashOf(999), signed_tx: Buffer.from(`t ${n}`).toString("base64") };
      before(tx);
      sent.push({ action, tx });
      return { kind: "unknown" as const, tx_hash: tx.tx_hash, why: "sent" };
    },
    resolve: async (tx: TxRef) => ({ kind: "unknown", tx_hash: tx.tx_hash, why: "" }) as TxOutcome,
  };
  const ms = DEADLINE - 90_000n;
  const index: SpendsIndex = { finalHeight: async () => 1000n, reach: async () => true, holds: () => false, at: () => 1000n, indexOf: () => null };
  const leaves: LeavesIndex = { reach: async () => true, has: () => false, count: () => 0n };
  const open: TokenStatus = { token: VAULT_CONSTANTS.TOKEN, caught_up: true, halted: false, vault_blocked: false, code_hash_ok: true, code_hash: USDC_CODE_HASH, block_height: 1000, last_event: null };
  const deps: WithdrawSendDeps = {
    cfg: CFG,
    rpcs: [provider(ms), provider(ms)],
    reads: { feeMin: async () => BigInt(fixture.request.withdrawal.relay_fee) },
    index,
    leaves,
    store: createWithdrawSendStore(mkdtempSync(join(tmpdir(), "junk-")), { release: 1, keys: { nonceNext: () => n } }),
    relayers: [relayer],
    tokenStatus: async () => open,
    now: () => Number(ms),
  };
  for (let i = 0; i < 3; i++) {
    const j = await junk();
    const a = await carryWithdraw(j.body, deps);
    assert.deepEqual([a.status, a.body], [400, { error: { code: "unknown_root" } }], `junk ${i}`);
  }
  assert.equal(sent.length, 0, "nothing signed");
  assert.ok(asked.includes("is_known_state_root") && asked.includes("is_known_label_root") && asked.includes("totals"));
  deps.store.close();
});
