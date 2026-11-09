// The exit tool's withdrawal of a note (vault paper 2.12 step 6, docs/plan1/vault.md l.944-958; V4.2 l.1243; SB-04's
// WM-10 vault leg, wallet.md l.1080): proved on the device and sent by the note's own one-use account A_{l,j}, with no
// server of ours, then A closed to the account the user types.
//
// - The note: one the restore found UNSPENT (its ref, scope and leaf). It goes out by withdraw, always, never by
//   ragequit: ragequit is the label's depositor's alone (contracts/vault/src/ragequit.rs l.84-87, OnlyOriginalDepositor),
//   and a note whose label's depositor is not U (a return, move or second-arrival note, deposited by a relayer) could
//   never leave by it. The whole value is withdrawn; the change note (value 0) is change j of the note's label l, j the
//   wallet's changeIndex (a change note k makes k + 1, any other note 0), and refund_precommitment is refund note (l, j)'s.
// - The request: the kit's vaultWithdrawRequest with relay_fee 0 and recipient and fee recipient the typed account, a
//   fresh salt and the vault's context. The proof: the kit's vaultProveWithdraw through the prover the caller passes (a
//   VaultProver: the browser worker, or snarkjs on the hash-checked setup files in Node), which refuses an answer whose
//   signals are not this input's; its context is checked against the request's again here.
// - The signatures: A's key, derived here from seed64 for each one and zeroed on every path, through the wallet's one
//   sealed signer (the kit's ./core): buildVaultWithdrawOut, exitBuildSettle (out.ts) and buildDeleteOut. Nothing here
//   sends: the signed bytes go to the caller's send.
// - The order (V:951-967): settle sends the spend's remaining reserve to its payer, A, so a DeleteAccount before it
//   would see A made again by that Transfer. exitWithdrawOne runs withdraw, then settle when the spend reads paid
//   (nobody else settled it), then A's DeleteAccount, each step only once the one before reads FINAL with every receipt
//   a success on both RPCs. A payout the token refused (refund_pending) stops it: the note is spent, and its value
//   waits in the vault as a refund note once settled (exitSettleDue). The DeleteAccount comes only on exitReadDelete's
//   read, at one block on both RPCs of the network's pair: the typed account exists (a DeleteAccount to a missing one
//   burns A's NEAR), the spend settled with reserve 0, the withdraw tx and A's own settle tx FINAL (their refunds ran),
//   or another's settle read SETTLE_BLOCKS back too, A's USDC held at 0 (a halted read is not a zero) and no token of
//   any kind under A in intents.near; the gate buildDeleteOut holds itself. One withdrawal at a time: the next note's A is funded by the typed account
//   (the first A's NEAR came back there), never by another account of the seed.
import {
  type VaultProver,
  vaultProveWithdraw,
  vaultProof,
  type VaultSpendRow,
  type VaultSyncRpc,
  type VaultTree,
  vaultWithdrawRequest,
} from "@blindfill/kit";
import {
  buildDeleteOut,
  buildVaultWithdrawOut,
  changeIndex,
  noteSecrets,
  readSettle,
  SETTLE_BLOCKS,
  type BuiltMove,
  type DeleteReadFor,
  type MoveOutRpc,
  type RestoredNote,
  type SettleReadFor,
} from "@blindfill/kit/core";
import { EXIT_NETWORKS, ExitRpcRefused } from "./rpc.ts";
import { EXIT_TOKENS } from "./scan.ts";
import { exitAccountAt, exitBuildSettle, exitHoldings, exitKey, ExitOutStopped, exitRecipientFor, type ExitRecipient } from "./out.ts";
import { nearPairNetwork, nearPairRule, type NearNetwork } from "@blindfill/kit";

/** A signed transaction of A: its withdrawal or settle (FunctionCall), or its DeleteAccount. */
export type ExitSigned = BuiltMove | ReturnType<typeof buildDeleteOut>;

/** Which withdrawal a note makes: its label l and change index j, so A_{l,j}, the change note (l, j) and refund note (l, j). */
export function exitWithdrawIndex(note: Pick<RestoredNote, "ref" | "leaf">): { l: bigint; j: number } {
  const ref = note.ref;
  const j = ref.kind === "change" ? changeIndex({ kind: "change", j: ref.j }) : changeIndex({ kind: "deposit" });
  return { l: note.leaf.label, j };
}

/** What exitBuildWithdraw needs, every read the caller's on two RPCs. */
export type ExitWithdrawArgs = {
  seed64: Uint8Array;
  network: NearNetwork;
  /** an UNSPENT note the restore found */
  note: RestoredNote;
  /** a typed account exitRecipient checked for `network` */
  to: ExitRecipient;
  prover: VaultProver;
  /** the trees from the vault's full leaf and label lists, and the vault's newest roots */
  stateTree: VaultTree;
  labelTree: VaultTree;
  newestStateRoot: bigint;
  newestLabelRoot: bigint;
  /** NEAR for the typed account's registration on the token: the token's storage minimum (exitStorageMin), exactly */
  registerDeposit: bigint;
  /** the vault's block time now and the deadline, ms (block time, never the device clock) */
  nowMs: number;
  deadlineMs: number;
  /** readSettle's read of A: its nonce and the block the transaction names */
  read: SettleReadFor;
};

/**
 * The note's withdrawal, proved and signed by A_{l,j}: withdraw on the network's vault with fee 0 to the typed account.
 * Refused (ExitRpcRefused) for an unknown network, a typed account exitRecipient did not check for it, or a note that
 * is not UNSPENT; the kit refuses a proof whose signals are not the request's, and the wallet's builder anything else
 * the vault would not take from A. A's key is zeroed before this returns, whichever way. `keyOf` is exitKey unless a
 * test says.
 */
export async function exitBuildWithdraw(a: ExitWithdrawArgs, keyOf: typeof exitKey = exitKey): Promise<{ built: BuiltMove; l: bigint; j: number; nullifierHash: bigint }> {
  const { network, note, to } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  if (note.state !== "UNSPENT") throw new ExitRpcRefused(`a ${String(note.state)} note has nothing to withdraw`);
  // the seed copied before the first await, the copy zeroed on every path
  const seed64 = new Uint8Array(a.seed64);
  try {
    const vault = EXIT_NETWORKS[network].vault;
    const { l, j } = exitWithdrawIndex(note);
    const own = noteSecrets(seed64, note.ref);
    const change = noteSecrets(seed64, { kind: "change", l, j });
    const refund = noteSecrets(seed64, { kind: "refund", l, j });
    if (own.precommitment !== note.precommitment) throw new ExitRpcRefused("the note's secrets are not its precommitment's");
    const withdrawn = note.leaf.value;
    const req = vaultWithdrawRequest({
      vaultId: vault,
      token: EXIT_TOKENS[network],
      recipient: to.account,
      registerDeposit: a.registerDeposit,
      feeRecipient: to.account,
      relayFee: 0n,
      refundPrecommitment: refund.precommitment,
      deadlineMs: a.deadlineMs,
      withdrawn,
      nowMs: a.nowMs,
    });
    const proved = await vaultProveWithdraw(a.prover, {
      stateTree: a.stateTree,
      labelTree: a.labelTree,
      newestStateRoot: a.newestStateRoot,
      newestLabelRoot: a.newestLabelRoot,
      note: { value: withdrawn, label: note.leaf.label, nullifier: own.nullifier, secret: own.secret },
      newNullifier: change.nullifier,
      newSecret: change.secret,
      withdrawn,
      withdrawal: req.withdrawal,
      vaultId: vault,
      scope: note.scope,
      nowMs: a.nowMs,
    });
    // before A's key is derived: a note read under another scope (another vault's or token's) proves another context
    if (proved.publicSignals[7] !== req.context) throw new ExitRpcRefused("the proof's context is not the request's: the note's scope is not this vault's");
    const key = keyOf(seed64, { kind: "A", l, j });
    try {
      const built = buildVaultWithdrawOut({ read: a.read, key, vault, to: to.account, withdrawal: req.withdrawal, proof: vaultProof(proved.proof), publicSignals: proved.publicSignals, storageMin: a.registerDeposit, nowMs: a.nowMs });
      return { built, l, j, nullifierHash: own.nullifierHash };
    } finally {
      key.secretKey.fill(0);
    }
  } finally {
    seed64.fill(0);
  }
}

/**
 * A_{l,j}'s DeleteAccount to the typed account, on `read` (exitReadDelete's): the wallet's builder refuses it unless
 * the spend of `nullifierHash` reads settled with reserve 0, A's USDC held at 0 and nothing under A in intents.near.
 * A's key is zeroed before this returns, whichever way.
 */
export function exitBuildDelete(a: { seed64: Uint8Array; network: NearNetwork; l: bigint; j: number; to: ExitRecipient; read: DeleteReadFor; nullifierHash: bigint }, keyOf: typeof exitKey = exitKey): ReturnType<typeof buildDeleteOut> {
  const { network, to } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  const key = keyOf(a.seed64, { kind: "A", l: a.l, j: a.j });
  try {
    return buildDeleteOut({ read: a.read, key, network, to: to.account, token: EXIT_TOKENS[network], nullifierHash: a.nullifierHash });
  } finally {
    key.secretKey.fill(0);
  }
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const DIGITS = /^(0|[1-9][0-9]*)$/;
const STATUSES = ["in_flight", "paid", "refund_pending", "settled"] as const;
const INTENTS = "intents.near";
const args64 = (o: Obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))));

/** A view's bytes on one RPC at block `at` (so the two RPCs compare byte for byte), or a stop. */
async function viewBytes(r: VaultSyncRpc, account: string, method: string, args: Obj, at: number): Promise<string> {
  const ans = await r.query({ request_type: "call_function", account_id: account, method_name: method, args_base64: args64(args), block_id: at }).catch(() => null);
  const res = isObj(ans) && ans.error === undefined ? ans.result : undefined;
  if (!isObj(res) || res.error !== undefined || res.block_height !== at || !Array.isArray(res.result) || !res.result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new ExitOutStopped(`${r.name}: no ${method} answer at block ${at}`);
  return new TextDecoder().decode(Uint8Array.from(res.result as number[]));
}
/** The same view on both RPCs at `at`, equal byte for byte, parsed. */
async function viewBoth(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], account: string, method: string, args: Obj, at: number): Promise<unknown> {
  const [x, y] = await Promise.all(rpcs.map((r) => viewBytes(r, account, method, args, at)));
  if (x !== y) throw new ExitOutStopped(`the two RPCs differ on ${method}`);
  try {
    return JSON.parse(x!);
  } catch {
    throw new ExitOutStopped(`${method}: not JSON`);
  }
}
/** The spends row at `index`, at block `at` on both RPCs: its status and reserve, checked to be the spend of `nullifierHash`. */
async function spendAt(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], vault: string, index: number, nullifierHash: bigint, at: number): Promise<DeleteReadFor["spend"]> {
  const row = await viewBoth(rpcs, vault, "spends", { from: index, limit: 1 }, at);
  const o = Array.isArray(row) && row.length === 1 && isObj(row[0]) ? row[0] : null;
  if (o === null || o.index !== index || typeof o.nullifier_hash !== "string" || !DIGITS.test(o.nullifier_hash) || typeof o.reserve !== "string" || !DIGITS.test(o.reserve) || !(STATUSES as readonly unknown[]).includes(o.status))
    throw new ExitOutStopped("the spend's row is not one the vault writes");
  if (BigInt(o.nullifier_hash) !== nullifierHash) throw new ExitOutStopped("the row at that index is another spend");
  return { nullifierHash, status: o.status as DeleteReadFor["spend"]["status"], reserve: BigInt(o.reserve) };
}
/**
 * A's tx read FINAL on both RPCs (final_execution_status FINAL, its hash and signer A): every receipt of it ran, its
 * refunds to A included (EXECUTED does not hold the refunds, nearcore views.rs l.2193-2199). Anything else is unread.
 */
async function txFinal(rpcs: readonly [MoveOutRpc, MoveOutRpc], hash: string, signer: string): Promise<"final" | "unread"> {
  const one = async (r: MoveOutRpc) => {
    try {
      const a = await r.tx({ tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
      const res = isObj(a) && a.error === undefined ? a.result : undefined;
      return isObj(res) && res.final_execution_status === "FINAL" && isObj(res.transaction) && res.transaction.hash === hash && res.transaction.signer_id === signer;
    } catch {
      return false;
    }
  };
  const [x, y] = await Promise.all(rpcs.map(one));
  return x && y ? "final" : "unread";
}
/** What intents.near holds under A at `at`: the pair reads no intents.near at all, no token of any kind, or something. */
async function intentsAt(rpcs: readonly [VaultSyncRpc, VaultSyncRpc], aId: string, at: number): Promise<DeleteReadFor["intents"]> {
  const there = await exitAccountAt(rpcs, INTENTS, at);
  if (there === "absent") return "no-intents";
  if (there !== "exists") throw new ExitOutStopped("intents.near is not read the same on both RPCs");
  const tokens = await viewBoth(rpcs, INTENTS, "mt_tokens_for_owner", { account_id: aId }, at);
  if (!Array.isArray(tokens)) throw new ExitOutStopped("mt_tokens_for_owner: not a list");
  return tokens.length === 0 ? "empty" : "holds";
}

/**
 * Everything A's close is gated on, at one block on both RPCs of `network`'s release pair: A's nonce and the block (the
 * wallet's readSettle, A's own key alone), then at that block whether the typed account exists, the spend's row (the
 * vault's spends(index, 1), equal byte for byte), A's USDC (exitHoldings: halted, never a zero, while USDC is halted)
 * and what intents.near holds under A (mt_tokens_for_owner, any token); the withdraw tx and, when A settled it, A's
 * settle tx read FINAL on both; when another settled it, the row read settled with reserve 0 SETTLE_BLOCKS back too.
 * Refused (ExitRpcRefused) for a pair that is not `network`'s; throws ExitOutStopped when a read fails or the two
 * differ, or the row at `spendIndex` is not the spend of `nullifierHash`.
 */
export async function exitReadDelete(a: {
  network: NearNetwork;
  aId: string;
  to: ExitRecipient;
  spendIndex: number;
  nullifierHash: bigint;
  /** the withdraw tx's hash, and A's own settle tx's, or null when another settled the spend */
  txs: { withdraw: string; settle: string | null };
  rpcs: readonly [VaultSyncRpc, VaultSyncRpc];
  moveRpcs: readonly [MoveOutRpc, MoveOutRpc];
}): Promise<DeleteReadFor> {
  const { network, aId, to } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  if (nearPairNetwork(a.rpcs) !== network || nearPairNetwork(a.moveRpcs) !== network) throw new ExitRpcRefused(nearPairRule(network));
  if (!Number.isSafeInteger(a.spendIndex) || a.spendIndex < 0) throw new ExitRpcRefused("spendIndex is a row index");
  const s = await readSettle(aId, a.moveRpcs);
  if (s === null) throw new ExitOutStopped(`A ${aId}: its nonce and block are not read equal on both RPCs`);
  const at = s.height;
  const vault = EXIT_NETWORKS[network].vault;
  const beneficiary = await exitAccountAt(a.rpcs, to.account, at);
  if (beneficiary === "unread") throw new ExitOutStopped(`the typed account ${to.account} is not read the same on both RPCs`);
  const spend = await spendAt(a.rpcs, vault, a.spendIndex, a.nullifierHash, at);
  const { holdings } = await exitHoldings({ network, ids: [aId], rpcs: a.rpcs, at });
  const intents = await intentsAt(a.rpcs, aId, at);
  const withdrawTx = await txFinal(a.moveRpcs, a.txs.withdraw, aId);
  let settle: DeleteReadFor["settle"];
  if (a.txs.settle !== null) settle = { by: "self", tx: await txFinal(a.moveRpcs, a.txs.settle, aId) };
  else {
    const back = at - SETTLE_BLOCKS;
    const then = back > 0 ? await spendAt(a.rpcs, vault, a.spendIndex, a.nullifierHash, back).catch(() => null) : null;
    settle = { by: "other", back: then !== null && then.status === "settled" && then.reserve === 0n ? back : null };
  }
  return { network, a: aId, to: to.account, token: EXIT_TOKENS[network], height: at, blockHash: s.blockHash, nonce: s.nonce, beneficiary, spend, usdc: holdings[0]!.token, intents, withdrawTx, settle };
}

/** How one signed transaction ended: FINAL on both RPCs with every receipt a success, or not (failed, or no equal word). */
export type ExitSent = "ok" | "failed" | "unread";
/** Where exitWithdrawOne stopped: done (A closed); the vault's payout refused (the note spent, its value a refund note once settled); or the step that did not land or was refused, with its why. */
export type ExitWithdrawOutcome =
  | { stage: "closed"; txs: string[] }
  | { stage: "refund" | "withdraw" | "settle" | "close"; why: string; txs: string[] };

/** What exitWithdrawOne runs on: each of its reads on both RPCs of the release pair, and the self-submit. */
export type ExitWithdrawSteps = {
  /** the withdrawal proved and signed (exitBuildWithdraw) */
  withdraw(): Promise<{ built: BuiltMove; l: bigint; j: number; nullifierHash: bigint }>;
  /** self-submits the signed bytes through a public RPC, then reads the tx on both RPCs */
  send(m: ExitSigned): Promise<ExitSent>;
  /** the spend's row of this nullifier hash in the vault's spends, read on both RPCs, or null when not there */
  spend(nullifierHash: bigint): Promise<VaultSpendRow | null>;
  /** readSettle's read of A */
  readA(aId: string): Promise<SettleReadFor | null>;
  /** exitReadDelete's read, given the withdraw tx and A's own settle tx (null when another settled the spend) */
  readDelete(aId: string, spendIndex: number, nullifierHash: bigint, txs: { withdraw: string; settle: string | null }): Promise<DeleteReadFor>;
};

const REFUND = "the vault's payout to the typed account was refused (refund_pending): the note is now spent, and its value waits in the vault as a refund note once the spend is settled (exitSettleDue settles it; the next restore finds the refund note)";

/**
 * One note out, in the order the vault paper sets (V:951-967): withdraw, then settle when the spend reads paid (nobody
 * settled it yet), then A's DeleteAccount to the typed account on exitReadDelete's read; each step only once the one
 * before read "ok". A spend that reads refund_pending stops it with the refund outcome (never "the withdrawal read
 * failed": the withdrawal landed, the token refused the payout). It stops at the first step that does not land or is
 * refused, naming it, and signs nothing after.
 */
export async function exitWithdrawOne(a: { seed64: Uint8Array; network: NearNetwork; to: ExitRecipient; steps: ExitWithdrawSteps }, keyOf: typeof exitKey = exitKey): Promise<ExitWithdrawOutcome> {
  const { network, to, steps } = a;
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  const txs: string[] = [];
  const w = await steps.withdraw();
  txs.push(w.built.hash);
  const sent = await steps.send(w.built);
  // the payout refused fails a receipt of the withdraw tx, yet the vault wrote the spend: read the row before naming it
  let row = sent === "unread" ? null : await steps.spend(w.nullifierHash);
  if (row !== null && row.status === "refund_pending") return { stage: "refund", why: REFUND, txs };
  if (sent !== "ok") return { stage: "withdraw", why: `the withdrawal read ${sent}`, txs };
  if (row === null) return { stage: "settle", why: "the spend is not read in the vault's spends", txs };
  const aKey = keyOf(a.seed64, { kind: "A", l: w.l, j: w.j });
  const aId = aKey.id;
  aKey.secretKey.fill(0);
  let settleTx: string | null = null;
  if (row.status === "paid") {
    const read = await steps.readA(aId);
    if (read === null) return { stage: "settle", why: "A is not read equal on both RPCs", txs };
    const s = exitBuildSettle({ seed64: a.seed64, network, spend: { l: w.l, j: w.j, note: "", spend: row }, read }, keyOf);
    txs.push(s.hash);
    settleTx = s.hash;
    const settled = await steps.send(s);
    if (settled !== "ok") return { stage: "settle", why: `the settle read ${settled}`, txs };
    row = await steps.spend(w.nullifierHash);
    if (row === null) return { stage: "settle", why: "the spend is not read in the vault's spends", txs };
  }
  if (row.status !== "settled" || row.reserve !== 0n) return { stage: "settle", why: `the spend reads ${row.status} with reserve ${row.reserve}`, txs };
  let d: ReturnType<typeof buildDeleteOut>;
  try {
    const read = await steps.readDelete(aId, row.index, w.nullifierHash, { withdraw: w.built.hash, settle: settleTx });
    d = exitBuildDelete({ seed64: a.seed64, network, l: w.l, j: w.j, to, read, nullifierHash: w.nullifierHash }, keyOf);
  } catch (e) {
    return { stage: "close", why: e instanceof Error ? e.message : String(e), txs };
  }
  txs.push(d.hash);
  const closed = await steps.send(d);
  if (closed !== "ok") return { stage: "close", why: `the DeleteAccount read ${closed}`, txs };
  return { stage: "closed", txs };
}
