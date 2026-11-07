#!/usr/bin/env node
// The kit's settle on NEAR testnet (card vault-kit-settle): a withdrawal whose fee part fails leaves the spend
// refund_pending, and the kit's vaultSettleOwn, sent by the device's own NEAR account, makes the refund note of exactly
// the returned amount and writes it through a note store; a second settle is refused by the vault and the kit's second
// call sends nothing. On the keyless testnet vault of contracts/vault/deployments/testnet-v4.json (the final source,
// vault-final-sha) and the team's testnet USDC only; it refuses any other vault, token or network.
//
// Accounts:
//   P  the vault's parent (--parent, its key from --key-file, outside the repo): pays NEAR only. It funds D, registers D
//      on the token and makes B.
//   D  the device: a NEAR-implicit account whose key comes from the run's seed. It prepays, deposits, sends the
//      withdrawal (payer and recipient) and settles with its own gas.
//   B  the fee recipient: b-<run>.<P>, made with no key and never registered on the token, so the token refuses the fee
//      and the one payout receipt fails whole (vault review A-01): the whole withdrawal comes back.
// The seed and every note secret derived from it live in --state, outside the repo (mode 600), so a stopped run resumes
// at its next step; nothing secret is printed. Test notes on test USDC only.
//
//   node packages/kit/test/vault-settle-testnet.mjs --parent <P> --key-file <path> --state <path> --out <file>
//   <the holder's key text on stdin> node contracts/vault/scripts/testnet-t04.mjs fund --to <D>   (funds 3 USDC; this run uses 1)
import "../../../scripts/net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKey, repoRoots } from "../../../contracts/vault/scripts/deploy.mjs";
import { act } from "../../../contracts/vault/scripts/testnet-usdc.mjs";
import {
  RPCS, TOKEN, REGISTER, B_NEAR, D_NEAR, accountsOf, bounceProblems, keyOf, kitModules, loadState, nearOf, noteSecrets, prove,
  readBack, refusedProblems, send, successProblems, synced, view2,
} from "../../../contracts/vault/scripts/testnet-t04.mjs";
import { vaultSettleOwn } from "../src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOYMENT = path.join(ROOT, "contracts/vault/deployments/testnet-v4.json");
const TGAS = 10n ** 12n;
const GAS = { prepay: 30n * TGAS, deposit: 180n * TGAS, withdraw: 300n * TGAS, plain: 30n * TGAS };
const NOTE = 1_000_000n;
const FEE = 100_000n;

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const VAULT = dep.account_id;
  if (dep.network !== "testnet" || dep.asset !== TOKEN || !VAULT.endsWith(".testnet")) throw new Error("testnet-v4.json is not the testnet vault on the team's USDC");
  const k = await kitModules();
  const cfg = await view2(VAULT, "config", {});
  if (cfg.asset !== TOKEN || !/ testnet$/.test(cfg.version)) throw new Error(`the vault's config is not the testnet build on ${TOKEN}`);
  const scope = BigInt(cfg.scope);
  if (opt("--parent") !== dep.parent) throw new Error(`--parent must be the vault's parent ${dep.parent}`);
  if (!opt("--key-file") || !opt("--state") || !opt("--out")) throw new Error("--key-file, --state and --out are required");
  const roots = repoRoots();
  const P = { id: dep.parent, key: loadKey(opt("--key-file"), dep.parent, roots) };
  const st = loadState(opt("--state"), roots);
  const acc = accountsOf(st.seed, dep.parent);
  const D = { id: acc.D, key: keyOf(st.seed, "D") };
  const N = noteSecrets(k, st.seed, "kit-settle/note");
  const RF = noteSecrets(k, st.seed, "kit-settle/refund");
  const CH = noteSecrets(k, st.seed, "kit-settle/change");
  const log = (s) => console.log(`vault-kit-settle: ${s}`);
  log(`accounts: P ${acc.P}, D ${acc.D}, B ${acc.B}`);
  const balances = async () => ({
    at: new Date().toISOString(),
    D_usdc: await view2(TOKEN, "ft_balance_of", { account_id: acc.D }).catch(() => null),
    vault_usdc: await view2(TOKEN, "ft_balance_of", { account_id: VAULT }),
    B_registered: await view2(TOKEN, "storage_balance_of", { account_id: acc.B }),
    D_near: String(await nearOf(acc.D)),
    totals: await view2(VAULT, "totals", {}),
  });
  st.steps.before ??= await balances();
  st.save();

  const tx = async (step, signer, receiver, actions, { expect = "success", check = successProblems, method } = {}) => {
    const { hash, r } = await send(signer.id, signer.key, receiver, actions);
    const reads = await Promise.all(RPCS.map((_, i) => readBack(hash, signer.id, i)));
    const problems = reads.flatMap((x, i) => (x ? check(x).map((p) => `${RPCS[i]}: ${p}`) : [`${RPCS[i]}: not read`]));
    const vaultGas = (r.receipts_outcome ?? []).filter((o) => o.outcome.executor_id === VAULT).map((o) => o.outcome.gas_burnt);
    (st.steps[step] ??= { txs: [] }).txs.push({ step, method, hash, signer: signer.id, expect, vault_gas_burnt: vaultGas, problems });
    st.save();
    log(`${step}: ${method} ${hash} ${problems.length ? `PROBLEMS ${problems.join("; ")}` : "read back on both operators as expected"}`);
    if (problems.length) throw new Error(`${step}: ${method} ${hash} did not read back as expected`);
    return { hash, r: reads[0] };
  };
  const done = (s) => st.steps[s]?.done === true;
  const finish = (s, extra = {}) => {
    Object.assign((st.steps[s] ??= { txs: [] }), extra, { done: true });
    st.save();
  };

  if (!done("setup")) {
    if ((await nearOf(acc.D)) === null) await tx("setup", P, acc.D, [act.transfer(D_NEAR)], { method: "Transfer (D, implicit)" });
    if ((await view2(TOKEN, "storage_balance_of", { account_id: acc.D })) === null)
      await tx("setup", P, TOKEN, [act.call("storage_deposit", { account_id: acc.D, registration_only: true }, GAS.plain, REGISTER)], { method: "storage_deposit (D)" });
    if ((await nearOf(acc.B)) === null) await tx("setup", P, acc.B, [act.create(), act.transfer(B_NEAR)], { method: "CreateAccount (B, no key)" });
    finish("setup");
  }
  if (!done("funded")) {
    const have = BigInt(await view2(TOKEN, "ft_balance_of", { account_id: acc.D }));
    if (have < NOTE) {
      log(`D holds ${have} USDC units, needs ${NOTE}: the holder sends it with \`testnet-t04.mjs fund --to ${acc.D}\`, then run again`);
      process.exit(3);
    }
    finish("funded", { usdc: String(have) });
  }
  if (!done("deposit")) {
    await tx("deposit", D, VAULT, [act.call("storage_prepay", { precommitment: String(N.precommitment) }, GAS.prepay, k.vaultPrepayYocto(true))], { method: "storage_prepay" });
    const msg = k.vaultDepositMessage(N.precommitment, acc.D);
    await tx("deposit", D, TOKEN, [act.call("ft_transfer_call", { receiver_id: VAULT, amount: String(NOTE), msg }, GAS.deposit, 1n)], { method: "ft_transfer_call (deposit)" });
    const s = await synced(k, VAULT);
    const row = s.deposits.find((d) => d.precommitment === N.precommitment);
    if (!row || row.value !== NOTE || row.depositor !== acc.D) throw new Error("deposit: no deposit row of the note by D");
    finish("deposit", { label: String(row.label), leaf_index: String(row.leafIndex) });
  }
  if (!done("bounce")) {
    const s = await synced(k, VAULT);
    const note = { value: NOTE, label: BigInt(st.steps.deposit.label), nullifier: N.nullifier, secret: N.secret };
    const nowMs = Date.now();
    const { withdrawal, context } = k.vaultWithdrawRequest({
      vaultId: VAULT, token: TOKEN, recipient: acc.D, registerDeposit: 0n, feeRecipient: acc.B, relayFee: FEE,
      refundPrecommitment: RF.precommitment, deadlineMs: nowMs + 30 * 60_000, withdrawn: NOTE, nowMs,
    });
    const stateTree = new k.VaultTree(s.leaves);
    const labelTree = new k.VaultTree(s.labels);
    if (stateTree.root !== s.stateTree.root || labelTree.root !== s.labelTree.root) throw new Error("the synced trees' roots are not the vault's");
    const input = k.vaultWithdrawInput({
      stateTree, labelTree, newestStateRoot: s.stateTree.root, newestLabelRoot: s.labelTree.root,
      note, newNullifier: CH.nullifier, newSecret: CH.secret, withdrawn: NOTE, withdrawal, vaultId: VAULT, scope, nowMs,
    });
    const p = await prove(k, "withdraw", input);
    if (p.publicSignals[7] !== context) throw new Error("the proof's context is not the request's");
    // A-01: the fee recipient B is not registered, so the one payout receipt fails whole and all of NOTE comes back
    await tx("bounce", D, VAULT, [act.call("withdraw", { withdrawal, proof: p.proof, public_signals: p.publicSignals }, GAS.withdraw, k.vaultWithdrawYocto(0n, FEE, true))], {
      method: "withdraw (fee to B, bounces)", expect: "bounce", check: (r) => bounceProblems(r, { token: TOKEN, refunded: NOTE }),
    });
    finish("bounce", { nullifier_hash: String(N.nullifierHash), prove_ms: p.proveMs });
  }
  const rpcs = RPCS.map((u) => ({ name: u, query: (params, signal) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kit-settle", method: "query", params }), signal: signal ?? AbortSignal.timeout(60_000), redirect: "error" }).then((r) => r.json()) }));
  const mine = [{ nullifierHash: N.nullifierHash, refundPrecommitment: RF.precommitment, ref: { kind: "refund", l: BigInt(st.steps.deposit.label), j: 0 }, parent: "deposit-note" }];
  // the note store the run writes through: the wallet's NoteStore's list and add, held in memory and in --state
  const store = {
    async list() {
      return (st.steps.notes ?? []).map((n) => ({ precommitment: BigInt(n.precommitment) }));
    },
    async add(n) {
      if ((st.steps.notes ?? []).some((x) => x.precommitment === String(n.precommitment))) throw new Error("that precommitment is already in the store");
      (st.steps.notes ??= []).push(JSON.parse(JSON.stringify(n, (_, v) => (typeof v === "bigint" ? String(v) : v))));
      st.save();
      return n;
    },
  };
  // the device's own NEAR gas: D signs the kit's call
  const sendBy = (step, method) => async (c) => {
    if (c.receiverId !== VAULT) throw new Error("the kit's call is not to the vault");
    const { hash } = await tx(step, D, c.receiverId, [act.call(c.methodName, JSON.parse(c.args), c.gas, c.deposit)], { method });
    return hash;
  };
  if (!done("settle")) {
    const r = await vaultSettleOwn({ vault: VAULT, scope, rpcs, spends: mine, send: sendBy("settle", "settle (D, the kit's call)"), store });
    const o = r.outcomes[0];
    if (o?.state !== "refund_note" || o.leaf.value !== NOTE || !o.written) throw new Error(`settle: the kit's outcome ${JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v))}`);
    finish("settle", { height: r.height, refund_value: String(o.leaf.value), refund_label: String(o.leaf.label), refund_leaf_index: String(o.leaf.leafIndex), refund_commitment: String(o.leaf.commitment), refund_precommitment: String(RF.precommitment), tx: o.txHash });
  }
  if (!done("again")) {
    // the kit's second call sends nothing and writes nothing; the vault refuses a second settle sent by hand
    const r = await vaultSettleOwn({ vault: VAULT, scope, rpcs, spends: mine, send: async () => { throw new Error("the kit sent a second settle"); }, store });
    if (r.outcomes[0]?.state !== "refund_note" || r.outcomes[0].written !== false) throw new Error("again: the kit's second call wrote a note");
    await tx("again", D, VAULT, [act.call("settle", { nullifier_hash: String(N.nullifierHash) }, GAS.plain, 0n)], { method: "settle (D, again)", expect: "refused AlreadySettled", check: (x) => refusedProblems(x, "AlreadySettled", VAULT) });
    finish("again");
  }
  st.steps.after ??= await balances();
  st.save();
  const txs = Object.values(st.steps).flatMap((x) => x?.txs ?? []);
  const record = {
    card: "vault-kit-settle",
    network: "testnet",
    vault: VAULT,
    asset: TOKEN,
    accounts: { parent: acc.P, device: acc.D, fee_recipient: acc.B },
    amounts: { note: String(NOTE), fee: String(FEE), refund: String(NOTE) },
    bounce: { nullifier_hash: st.steps.bounce.nullifier_hash, prove_ms: st.steps.bounce.prove_ms },
    settle: Object.fromEntries(Object.entries(st.steps.settle).filter(([x]) => x !== "txs" && x !== "done")),
    note: st.steps.notes?.[0] ? { ...st.steps.notes[0], ref: undefined } : null,
    before: st.steps.before,
    after: st.steps.after,
    txs: txs.map(({ step, method, hash, signer, expect, vault_gas_burnt }) => ({ step, method, hash, signer, expect, vault_gas_burnt })),
  };
  writeFileSync(opt("--out"), JSON.stringify(record, null, 2) + "\n");
  console.log("Money path: yes");
  for (const t of record.txs) if (t.expect === "success") console.log(`Tx: near-testnet ${t.hash} ${t.signer}`);
  for (const t of record.txs) if (t.expect !== "success") console.log(`Expected refusal (${t.step}, ${t.expect}): near-testnet ${t.hash} ${t.signer}`);
}

main().then(() => process.exit(0), (e) => {
  console.error(`vault-kit-settle testnet: ERROR: ${String(e.message).split("\n")[0]}`);
  process.exit(1);
});
