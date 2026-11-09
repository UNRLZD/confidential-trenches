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
//   would see A made again by that Transfer. exitWithdrawOne runs the withdraw, then hands the spend to exitCloseOne:
//   settle when the spend reads paid or refund_pending (a payout the token refused: the note is spent and its value
//   becomes a refund note in the vault, which the next scan finds), then A's DeleteAccount. exitCloseOne is also the
//   resume (delta review P1-S): any A whose spend is due or settled, after a reload, an interrupted run or another's
//   settle, is settled and closed by it alone. Each tx hash is kept (steps.record) before its send.
// - The close: only on exitReadDelete's read, at one block on both RPCs of the network's pair, through buildDeleteOut's
//   gate: the typed account exists (a DeleteAccount to a missing one burns A's NEAR), the spend settled with reserve 0,
//   every receipt that can pay A has run (closeRefundsRan: the spend settled SETTLE_BLOCKS back, or the withdraw tx and
//   A's own settle tx FINAL; a settle too recent is waited out and read again), A's USDC held at 0 (a halted read is
//   not a zero) and no token of any kind under A in intents.near. A signed DeleteAccount is sent within
//   EXIT_CLOSE_SEND_BLOCKS of its read or dropped and signed again on a new read: it stays valid on chain about a day,
//   and a late send could find the typed account deleted. One withdrawal at a time: the next note's A is funded by the
//   typed account (the first A's NEAR came back there), never by another account of the seed.
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
  closeRefundsRan,
  keyNonceAt,
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
import { exitAccountAt, exitBuildSettle, exitHoldings, exitKey, ExitOutStopped, exitRecipientFor, exitStorageTake, type ExitRecipient, type ExitStorage } from "./out.ts";
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
  /** the typed account's registration on the token, exitReadStorage's read: register_deposit 0 when registered, else the token's storage minimum */
  storage: ExitStorage;
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
  if (!exitStorageTake(a.storage, to)) throw new ExitRpcRefused("the registration is not one exitReadStorage read for this typed account");
  const { storageMin, registered } = a.storage;
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
      registerDeposit: registered ? 0n : storageMin,
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
      const built = buildVaultWithdrawOut({ read: a.read, key, vault, to: to.account, withdrawal: req.withdrawal, proof: vaultProof(proved.proof), publicSignals: proved.publicSignals, storageMin, registered, nowMs: a.nowMs });
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
 * refunds to A included (EXECUTED does not hold the refunds, nearcore views.rs l.2193-2199), with its nonce as both
 * read it. Anything else is unread, its nonce null.
 */
async function txFinal(rpcs: readonly [MoveOutRpc, MoveOutRpc], hash: string, signer: string): Promise<{ tx: "final" | "unread"; nonce: bigint | null }> {
  const one = async (r: MoveOutRpc): Promise<bigint | null> => {
    try {
      const a = await r.tx({ tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
      const res = isObj(a) && a.error === undefined ? a.result : undefined;
      if (!isObj(res) || res.final_execution_status !== "FINAL" || !isObj(res.transaction) || res.transaction.hash !== hash || res.transaction.signer_id !== signer) return null;
      const n = res.transaction.nonce;
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : typeof n === "string" && DIGITS.test(n) ? BigInt(n) : null;
    } catch {
      return null;
    }
  };
  const [x, y] = await Promise.all(rpcs.map(one));
  return x !== null && x === y ? { tx: "final", nonce: x } : { tx: "unread", nonce: null };
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
 * and what intents.near holds under A (mt_tokens_for_owner, any token); the withdraw tx and A's own settle tx, when
 * their hashes were kept, read FINAL on both; and the row SETTLE_BLOCKS back, settled with reserve 0 or not.
 * Refused (ExitRpcRefused) for a pair that is not `network`'s; throws ExitOutStopped when a read fails or the two
 * differ, or the row at `spendIndex` is not the spend of `nullifierHash`.
 */
export async function exitReadDelete(a: {
  network: NearNetwork;
  aId: string;
  to: ExitRecipient;
  spendIndex: number;
  nullifierHash: bigint;
  /** the withdraw tx's hash and A's own settle tx's as kept, each null when not kept (or another settled the spend) */
  txs: { withdraw: string | null; settle: string | null };
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
  const withdrawTx = a.txs.withdraw === null ? "unread" : (await txFinal(a.moveRpcs, a.txs.withdraw, aId)).tx;
  const settled = a.txs.settle === null ? null : await txFinal(a.moveRpcs, a.txs.settle, aId);
  const settleTx = settled === null ? "none" : settled.tx;
  const settleNonce = settled === null ? null : settled.nonce;
  // the row SETTLE_BLOCKS back: settled with reserve 0 there, every receipt of the withdraw and the settle has run
  // (a row not there yet, a split or a failed read: null, and the close waits or is refused)
  const back = at - SETTLE_BLOCKS;
  const then = back > 0 ? await spendAt(a.rpcs, vault, a.spendIndex, a.nullifierHash, back).catch(() => null) : null;
  const settledBack = then !== null && then.status === "settled" && then.reserve === 0n ? back : null;
  // A's key nonce there (delta review P3-2): equal to its nonce now, no tx of A (a settle of its own held back) since
  const nonceBack = settledBack === null ? null : await keyNonceAt(aId, settledBack, a.moveRpcs);
  return { network, a: aId, to: to.account, token: EXIT_TOKENS[network], height: at, blockHash: s.blockHash, nonce: s.nonce, beneficiary, spend, usdc: holdings[0]!.token, intents, withdrawTx, settleTx, settledBack, nonceBack, settleNonce };
}

/** How one signed transaction ended: FINAL on both RPCs with every receipt a success, or not (failed, or no equal word). */
export type ExitSent = "ok" | "failed" | "unread";
/** A tx hash the tool keeps before it sends that tx (delta review P1-S): after a reload, the resume reads it FINAL. */
export type ExitTxRecord = { l: bigint; j: number; nullifierHash: bigint; step: "withdraw" | "settle" | "close"; hash: string };
/**
 * Where a run stopped: closed (A deleted, its NEAR at the typed account), or the step that did not land or was refused,
 * with its why. `refund`: the vault's payout was refused (refund_pending), so the note is spent and its value is a
 * refund note in the vault once settled (EXIT_REFUND_WHY); the next scan finds it.
 */
export type ExitWithdrawOutcome =
  | { stage: "closed"; txs: string[]; refund: boolean }
  | { stage: "withdraw" | "settle" | "close"; why: string; txs: string[]; refund: boolean };

/** What exitCloseOne runs on: each read on both RPCs of the release pair, the hash keeper and the self-submit. */
export type ExitCloseSteps = {
  /** self-submits the signed bytes once through a public RPC, then reads the tx on both RPCs; never sends them again */
  send(m: ExitSigned): Promise<ExitSent>;
  /** keeps a tx's hash where a reload finds it; called before that tx is sent, and a throw sends nothing */
  record(r: ExitTxRecord): Promise<void>;
  /** the spend's row of this nullifier hash in the vault's spends, read on both RPCs, or null when not there */
  spend(nullifierHash: bigint): Promise<VaultSpendRow | null>;
  /** whether A exists, read at one final block on both RPCs (exitAccountAt) */
  account(aId: string): Promise<"exists" | "absent" | "unread">;
  /** readSettle's read of A */
  readA(aId: string): Promise<SettleReadFor | null>;
  /** exitReadDelete's read, given the tx hashes kept (null when not kept) */
  readDelete(aId: string, spendIndex: number, nullifierHash: bigint, txs: { withdraw: string | null; settle: string | null }): Promise<DeleteReadFor>;
  /** the final height, the lower of both RPCs', or null */
  head(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
};
/** What exitWithdrawOne runs on: the withdrawal proved and signed (exitBuildWithdraw), then exitCloseOne's steps. */
export type ExitWithdrawSteps = ExitCloseSteps & { withdraw(): Promise<{ built: BuiltMove; l: bigint; j: number; nullifierHash: bigint }> };

/** The waits before the close reads again while a settle is too recent (closeRefundsRan): 9 of 20 s, past SETTLE_BLOCKS of blocks. */
export const EXIT_CLOSE_WAITS_MS: readonly number[] = Object.freeze(Array<number>(9).fill(20_000));
/** A signed DeleteAccount is sent at most this many blocks past its read, else dropped and signed again on a new read. */
export const EXIT_CLOSE_SEND_BLOCKS = 30;
export const EXIT_REFUND_WHY = "the vault's payout to the typed account was refused (refund_pending): the note is spent, and its value is now a refund note in the vault, settled here; scan again to withdraw it";

/**
 * A_{l,j}'s close, for the spend of `nullifierHash` (delta review P1-S): the resume for any A whose spend is due or
 * settled, and exitWithdrawOne's tail. On a fresh read of the spend: an A already deleted with its spend settled is
 * closed; in_flight waits for its callback (run again); paid or refund_pending is settled by A first (its hash kept, then
 * sent) and read again; then, on a spend settled with reserve 0, exitReadDelete's read until every receipt that can pay
 * A has run (EXIT_CLOSE_WAITS_MS), and A's DeleteAccount, its hash kept, sent within EXIT_CLOSE_SEND_BLOCKS of its read.
 * `txs` are the hashes a run kept before (exitTxRecord), when it has them. Signs nothing past a step that did not land.
 */
export async function exitCloseOne(
  a: { seed64: Uint8Array; network: NearNetwork; to: ExitRecipient; l: bigint; j: number; nullifierHash: bigint; txs?: { withdraw?: string | null; settle?: string | null }; steps: ExitCloseSteps },
  keyOf: typeof exitKey = exitKey,
): Promise<ExitWithdrawOutcome> {
  const { network, to, steps, l, j, nullifierHash } = a;
  if (!Object.hasOwn(EXIT_NETWORKS, network)) throw new ExitRpcRefused(`no NEAR network named ${JSON.stringify(network)}`);
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  const txs: string[] = [];
  const kept = { withdraw: a.txs?.withdraw ?? null, settle: a.txs?.settle ?? null };
  let refund = false;
  const stop = (stage: "settle" | "close", why: string): ExitWithdrawOutcome => ({ stage, why, txs, refund });
  const aKey = keyOf(a.seed64, { kind: "A", l, j });
  const aId = aKey.id;
  aKey.secretKey.fill(0);
  let row = await steps.spend(nullifierHash);
  if (row === null) return stop("settle", "the spend is not read in the vault's spends");
  // refund_value > 0 exactly when the payout was refused (on_payout, payout.rs l.146-147): kept after the settle too
  refund = row.status === "refund_pending" || row.refundValue > 0n;
  const there = await steps.account(aId);
  if (there === "unread") return stop("close", `A ${aId} is not read the same on both RPCs`);
  if (there === "absent") return row.status === "settled" ? { stage: "closed", txs, refund } : stop("settle", `A ${aId} is not on chain, and its spend reads ${row.status}`);
  if (row.status === "in_flight") return stop("settle", "the payout's callback has not run yet (in_flight): run the close again once it has");
  if (row.status === "paid" || row.status === "refund_pending") {
    const read = await steps.readA(aId);
    if (read === null) return stop("settle", "A is not read equal on both RPCs");
    const s = exitBuildSettle({ seed64: a.seed64, network, spend: { l, j, note: "", spend: row }, read }, keyOf);
    await steps.record({ l, j, nullifierHash, step: "settle", hash: s.hash });
    txs.push(s.hash);
    kept.settle = s.hash;
    const settled = await steps.send(s);
    row = await steps.spend(nullifierHash);
    // A's settle that did not land while the spend reads settled: another settled it first (delta review P3-4); the
    // close's own read decides when A's txs can no longer pay it
    if (settled !== "ok" && (row === null || row.status !== "settled" || row.reserve !== 0n)) return stop("settle", `the settle read ${settled}`);
    if (row === null) return stop("settle", "the spend is not read in the vault's spends");
  }
  if (row.status !== "settled" || row.reserve !== 0n) return stop("settle", `the spend reads ${row.status} with reserve ${row.reserve}`);
  for (let i = 0; ; i++) {
    const wait = EXIT_CLOSE_WAITS_MS[i];
    let read: DeleteReadFor;
    try {
      read = await steps.readDelete(aId, row.index, nullifierHash, kept);
    } catch (e) {
      return stop("close", e instanceof Error ? e.message : String(e));
    }
    if (!closeRefundsRan(read)) {
      // a settle too recent (another's, just after the withdraw, or a run whose hashes were lost): read again later
      if (wait === undefined) return stop("close", `the settle is not yet ${SETTLE_BLOCKS} blocks old and the txs are not read FINAL: run the close again`);
      await steps.sleep(wait);
      continue;
    }
    let d: ReturnType<typeof buildDeleteOut>;
    try {
      d = exitBuildDelete({ seed64: a.seed64, network, l, j, to, read, nullifierHash }, keyOf);
    } catch (e) {
      return stop("close", e instanceof Error ? e.message : String(e));
    }
    await steps.record({ l, j, nullifierHash, step: "close", hash: d.hash });
    // the head after the record, right before the send (delta review P3-3): a slow record cannot carry it past the window
    const now = await steps.head();
    if (now === null || now - read.height > EXIT_CLOSE_SEND_BLOCKS) {
      // the signed bytes are dropped unsent (the kept hash reads unread on a resume): signed again on a new read
      if (wait === undefined) return stop("close", `the DeleteAccount could not be sent within ${EXIT_CLOSE_SEND_BLOCKS} blocks of its read: run the close again`);
      continue;
    }
    txs.push(d.hash);
    const closed = await steps.send(d);
    if (closed !== "ok") return stop("close", `the DeleteAccount read ${closed}`);
    return { stage: "closed", txs, refund };
  }
}

/**
 * One note out, in the order the vault paper sets (V:951-967): the withdraw (its hash kept, then sent), then
 * exitCloseOne: settle when the spend reads paid or refund_pending, then A's DeleteAccount to the typed account. A
 * withdraw tx that read failed or unread goes on only when the vault wrote its spend (a payout the token refused fails a
 * receipt of the withdraw tx, yet the spend is there). It stops at the first step that does not land or is refused,
 * naming it, and signs nothing after.
 */
export async function exitWithdrawOne(a: { seed64: Uint8Array; network: NearNetwork; to: ExitRecipient; steps: ExitWithdrawSteps }, keyOf: typeof exitKey = exitKey): Promise<ExitWithdrawOutcome> {
  const { network, to, steps } = a;
  if (!exitRecipientFor(to, network)) throw new ExitRpcRefused(`the typed account is not one exitRecipient checked for ${network}`);
  const w = await steps.withdraw();
  await steps.record({ l: w.l, j: w.j, nullifierHash: w.nullifierHash, step: "withdraw", hash: w.built.hash });
  const sent = await steps.send(w.built);
  if (sent !== "ok" && (await steps.spend(w.nullifierHash)) === null) return { stage: "withdraw", why: `the withdrawal read ${sent}`, txs: [w.built.hash], refund: false };
  const out = await exitCloseOne({ seed64: a.seed64, network, to, l: w.l, j: w.j, nullifierHash: w.nullifierHash, txs: { withdraw: w.built.hash }, steps }, keyOf);
  return { ...out, txs: [w.built.hash, ...out.txs] };
}
