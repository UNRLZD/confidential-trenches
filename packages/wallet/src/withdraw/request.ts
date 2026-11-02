// One withdrawal from the vault, built and proved on the device (card wallet-withdraw-request; docs/plan1/wallet.md
// §2.3 Secrets l.175-192, "The held note" l.385-391, "Each attempt has its own context" l.214-217, §2.5 step 5 l.645,
// the §2.8 arming row l.907, W2.4 l.1107 and WU-06 l.1060; the relayer's checks 1-4, markets.md H3.4 l.1079-1110; the
// 16-byte salt, markets.md l.3271-3272; at research ffcba5e). Everything comes from the kit's public entry.
//
// - The note: the smallest UNSPENT note of the vault's scope whose value covers the amount plus the relay fee (§2.5
//   step 1's rule, l.720). A HELD, RESERVED or SPENT note is never picked (l.387). A spent note, a note too small and
//   no note at all are refused before anything is written or proved.
// - The change note is change note j of the spent note's label l, with j fixed by the spent note (keys.ts
//   changeIndex: a label's first note, any kind but change, makes change 0; change note k makes k + 1); its secrets
//   come from the seed (l.177-179). The refund note of the same (l, j) gives refund_precommitment (l.186-188).
// - The recipient is this note's own arming account A_{l,j} (markets.md l.989 and l.1534, "The kit makes every
//   withdrawal's `recipient` this note's `A_{l,j}` (W:671)"; wallet.md l.645 step 5, the l.907 row), derived here after the pick, never taken
//   from the caller, so no caller can pay another note's A or any other account. A's secret key is zeroed at once:
//   only its id is used. register_deposit is the caller's two-RPC read of A's registration (registerDepositOf,
//   arming/accounts.ts armingRegisterDepositOf), asked for A's id and this withdrawal's token after the pick and
//   before anything is written, so the read is refused when it would be made on another token.
// - The fee: relayFee is the relayer's quote, and the device refuses one above its own fee_max (./feemax.ts: LD5's
//   formula on the device's own reads of the gas price and the NEAR price, on two providers each, for this
//   withdrawal's register_deposit), before anything is written or proved (the §2.8 arming row, wallet.md l.915; §8
//   item 13, l.1333-1338: at any amount). No caller names the cap. The token is the network's own, the unit the cap is in.
// - The withdrawal and its context are the kit's vaultWithdrawRequest: a fresh 16-byte salt from the device, the
//   vault's own scope, the context the vault recomputes (vaultContextOf over vaultContextInput, the vault as processor).
//   The proof is the kit's vaultProveWithdraw, through the prover worker the caller passes; it refuses a worker answer
//   whose 8 public signals are not this input's. The proof's context is checked again against the request's here.
// - WU-06, nothing leaves before the store has it: the spent note goes UNSPENT -> HELD (its deadline_ms, this attempt
//   and its context, kept on the note for good) before the proof starts, and HELD -> RESERVED once the proof is made, before the request is handed back.
//   The change note's index needs no counter: j is a function of the spent note's ref, which that record holds, so the
//   RESERVED record is the stored index (keys.ts changeIndex, store.ts parentOf). Each write is the note store's
//   compare-and-set: a failed write, or another tab that took the note first, stops the request, and nothing is
//   returned, so nothing can be sent. A proof that fails or is dropped frees the note (HELD -> UNSPENT, this attempt).
// - deadline_ms is in block time, never the device clock (l.645). The vault checks it against its receipt's block,
//   env::block_timestamp_ms() = the block's timestamp in ns / 1e6, floored, block time <= deadline_ms inclusive. So
//   "now" is read from the newest final block's header.timestamp_nanosec, a decimal string (the lower of two RPCs), as
//   BigInt / 1,000,000: never header.timestamp, a JSON number past 2^53, and never Date.now(). withdrawDeadlineMs(that
//   read) gives T + 600,000 - r with a fresh r in [0, 65,536) (l.645). The request refuses a deadline_ms no more than
//   WITHDRAW_SEND_MARGIN_MS past that time (passed, or too late for the relayer's check 9: 30,000 ms, 120,000 when it
//   funds an arming account, markets.md H3.4 check 9; the larger always) and one more than 10 minutes out (WU-05,
//   l.1059).
// - The seed is copied before the first await and the copy zeroed on every path (key-zeroing.test.ts).
// Nothing here logs: the seed, the note's secrets and the circuit input never leave the device.
//
// Not here: the reads (the trees' leaves, the newest roots and the block time on two RPCs, register_deposit, the
// relayer's fee_min; fee_max's reads are feemax.ts's), the send to the relayer and its answers, the "own" check itself (a spends record whose context
// is in the note's contexts is this device's, l.224-227: the sync and arming cards), and a withdrawal across several
// notes (WM-06, l.716-760).
import {
  type HelperWithdrawRequest,
  vaultProof,
  type VaultProver,
  vaultProveWithdraw,
  vaultScopeOf,
  type VaultTree,
  vaultWithdrawRequest,
} from "@blindfill/kit";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NEAR_NETWORKS, type NearNetwork } from "../deposit/account.ts";
import { armAccount, changeIndex } from "../derive/index.ts";
import { noteSecrets, type NoteRef } from "../notes/secrets.ts";
import type { NoteRecord, NoteStore } from "../notes/store.ts";
import { type FeeRpc, readWithdrawFeeMax } from "./feemax.ts";

/** A change note's ref: change note j of label l. */
export type NoteRefChange = Extract<NoteRef, { kind: "change" }>;

/** The longest deadline_ms past the block time: T + 600,000 - r (wallet.md l.645), refused beyond (WU-05 l.1059). */
export const WITHDRAW_DEADLINE_MAX_MS = 600_000;
/** The relayer's check 9 margin when the withdrawal funds an arming account (markets.md H3.4; 30,000 otherwise). */
export const WITHDRAW_SEND_MARGIN_MS = 120_000;

/** What the device knows when it withdraws. Every read in it is the caller's, on two RPCs. */
export type WithdrawRequestArgs = {
  /** The 64-byte seed: copied, and the copy zeroed. */
  seed64: Uint8Array;
  notes: NoteStore;
  /** The prover worker's load and prove (the kit's startProver gives one on SIGN_HOST). */
  prover: VaultProver;
  /** The release's vault and its token, which give the vault's scope. */
  vaultId: string;
  token: string;
  /** The device's state and label trees, holding every leaf the vault has, and the vault's newest roots. */
  stateTree: VaultTree;
  labelTree: VaultTree;
  newestStateRoot: bigint;
  newestLabelRoot: bigint;
  /**
   * NEAR, in yocto, for A_{l,j}'s token registration, read on two RPCs for the id it is given: 0 when
   * storage_balance_of(A) is set, storage_balance_bounds.min when it is null (wallet.md l.907), on `token`: the
   * read refuses a token other than its own (armingRegisterDepositOf).
   */
  registerDepositOf: (accountId: string, token: string) => Promise<bigint>;
  /** The release's relayer fee recipient, never a helper's answer. */
  feeRecipient: string;
  /** The fee, in the token's base units, taken from the note on top of the amount: at most the device's own fee_max. */
  relayFee: bigint;
  /** The release's network, whose token `token` must be: its release pair reads the gas price of fee_max. */
  network: NearNetwork;
  rpcs: readonly [FeeRpc, FeeRpc];
  /** Mainnet's release pair, for fee_max's price pool (rpcs again on mainnet). */
  priceRpcs: readonly [FeeRpc, FeeRpc];
  /** What the recipient gets, in the token's base units. */
  amount: bigint;
  /** The withdrawal's deadline, in block time, ms (withdrawDeadlineMs). */
  deadlineMs: number;
  /** The newest final block's header.timestamp_nanosec, a decimal string: the lower of two RPCs'. */
  blockTimestampNanosec: string;
};

/** A request ready for POST /v1/withdraw, and what the device keeps of it. */
export type WithdrawRequest = {
  body: HelperWithdrawRequest;
  /** The spent note, now RESERVED in the store. */
  noteId: string;
  /** The withdrawal's recipient: A_{l,j} of the spent note's (l, j), a lowercase 64-hex implicit id. */
  recipient: string;
  /** The change note this withdrawal makes (value: the note's less amount and fee) and its refund note's ref. */
  change: NoteRefChange;
  refund: NoteRef;
  changeValue: bigint;
};

/** A block's time in ms as the vault reads it: header.timestamp_nanosec (a decimal string) / 1,000,000, floored. */
export function blockTimeMsOf(timestampNanosec: string): number {
  if (typeof timestampNanosec !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(timestampNanosec)) throw new Error("timestamp_nanosec: not a decimal string");
  const ms = BigInt(timestampNanosec) / 1_000_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER) - BigInt(WITHDRAW_DEADLINE_MAX_MS)) throw new Error("timestamp_nanosec: out of range");
  return Number(ms);
}

/** deadline_ms = T + 600,000 - r, T from the block header's timestamp_nanosec, r fresh in [0, 65,536) ms (l.645). */
export function withdrawDeadlineMs(blockTimestampNanosec: string): number {
  const r = globalThis.crypto.getRandomValues(new Uint16Array(1))[0]!;
  return blockTimeMsOf(blockTimestampNanosec) + WITHDRAW_DEADLINE_MAX_MS - r;
}

/** Picks a note, proves its withdrawal and stores the note RESERVED; refused with nothing proved or sent. */
export async function withdrawRequest(a: WithdrawRequestArgs): Promise<WithdrawRequest> {
  if (!(a.seed64 instanceof Uint8Array) || a.seed64.length !== 64) throw new Error("seed64: not 64 bytes");
  // The seed and every scalar are read before the first await; the seed's copy is zeroed on every path. A tree changed
  // while the store is written only makes a proof the kit refuses (its root is checked against the newest root).
  const seed = Uint8Array.from(a.seed64);
  try {
    const { notes, prover, vaultId, token, stateTree, labelTree, newestStateRoot, newestLabelRoot } = a;
    const { registerDepositOf, feeRecipient, relayFee, amount, deadlineMs } = a;
    const blockTimeMs = blockTimeMsOf(a.blockTimestampNanosec);
    for (const [k, v] of Object.entries({ relayFee, amount, newestStateRoot, newestLabelRoot })) {
      if (typeof v !== "bigint") throw new Error(`${k}: not a bigint`);
    }
    if (typeof registerDepositOf !== "function") throw new Error("registerDepositOf: not a function");
    const { network, rpcs, priceRpcs } = a;
    if (typeof network !== "string" || !Object.hasOwn(NEAR_NETWORKS, network)) throw new Error(`network: unknown ${String(network)}`);
    if (token !== NEAR_NETWORKS[network].usdc) throw new Error("token: not the network's own (fee_max is in its unit)");
    if (amount <= 0n) throw new Error("amount: 0 or less");
    if (relayFee < 0n) throw new Error("relayFee: below 0");
    if (relayFee >= amount) throw new Error("relayFee: at or above the amount"); // the §2.8 arming row, l.907
    if (!Number.isSafeInteger(deadlineMs)) throw new Error("deadlineMs: not a whole number");
    if (deadlineMs <= blockTimeMs + WITHDRAW_SEND_MARGIN_MS) throw new Error("deadlineMs: passed, or too close to send");
    if (deadlineMs > blockTimeMs + WITHDRAW_DEADLINE_MAX_MS) throw new Error("deadlineMs: more than 10 minutes out");
    const withdrawn = amount + relayFee;
    const scope = vaultScopeOf(keccak_256, vaultId, token);

    const note = pick(await notes.list(), scope, withdrawn);
    const leaf = note.leaf!;
    const j = note.ref.kind === "change" ? changeIndex({ kind: "change", j: note.ref.j }) : changeIndex({ kind: "deposit" });
    const change: NoteRefChange = { kind: "change", l: leaf.label, j };
    const refund: NoteRef = { kind: "refund", l: leaf.label, j };
    const arm = armAccount(seed, leaf.label, j);
    const recipient = arm.id;
    arm.secretKey.fill(0);
    const registerDeposit = await registerDepositOf(recipient, token);
    if (typeof registerDeposit !== "bigint") throw new Error("registerDepositOf: not a bigint");
    const feeMax = await readWithdrawFeeMax({ network, rpcs, priceRpcs, registerDeposit });
    if (relayFee > feeMax) throw new Error("relayFee: above the device's fee_max"); // §2.8 arming row, l.915; §8 item 13
    const spent = noteSecrets(seed, note.ref);
    const next = noteSecrets(seed, change);
    const req = vaultWithdrawRequest({
      vaultId,
      token,
      recipient,
      registerDeposit,
      feeRecipient,
      relayFee,
      refundPrecommitment: noteSecrets(seed, refund).precommitment,
      deadlineMs,
      withdrawn,
      nowMs: blockTimeMs,
    });

    // WU-06: the note is HELD by this attempt before the proof starts; a failed write stops here.
    // The attempt's context goes on the note in the same write (wallet.md l.214-217), so it is stored before its proof.
    const held = await notes.move(note.id, "UNSPENT", "HELD", { deadlineMs: BigInt(deadlineMs), context: req.context });
    const attempt = held.attempt!;
    const free = (): Promise<unknown> => notes.move(note.id, "HELD", "UNSPENT", { attempt }).catch(() => undefined);
    let body: HelperWithdrawRequest;
    try {
      const p = await vaultProveWithdraw(prover, {
        stateTree,
        labelTree,
        newestStateRoot,
        newestLabelRoot,
        note: { value: leaf.value, label: leaf.label, nullifier: spent.nullifier, secret: spent.secret },
        newNullifier: next.nullifier,
        newSecret: next.secret,
        withdrawn,
        withdrawal: req.withdrawal,
        vaultId,
        scope,
        nowMs: blockTimeMs,
      });
      if (p.publicSignals[7] !== req.context) throw new Error("proof: its context is not the request's");
      body = { withdrawal: req.withdrawal, proof: vaultProof(p.proof), public_signals: p.publicSignals, fund_recipient: true, token };
      // WU-06: RESERVED, with the spent note's ref and so the change index, before the request leaves this function.
      await notes.move(note.id, "HELD", "RESERVED", { attempt });
    } catch (e) {
      await free();
      throw e;
    }
    return { body, noteId: note.id, recipient, change, refund, changeValue: leaf.value - withdrawn };
  } finally {
    seed.fill(0);
  }
}

// §2.5 step 1 (l.720): the smallest UNSPENT note of this scope that covers the amount plus its fee.
function pick(all: NoteRecord[], scope: bigint, withdrawn: bigint): NoteRecord {
  const mine = all.filter((n) => n.scope === scope && n.leaf !== undefined);
  const open = mine.filter((n) => n.state === "UNSPENT");
  const fits = open.filter((n) => n.leaf!.value >= withdrawn);
  if (fits.length === 0) {
    if (open.length === 0) throw new Error("note: no unspent note in this vault");
    throw new Error("note: no unspent note covers the amount and its fee");
  }
  fits.sort((x, y) => (x.leaf!.value < y.leaf!.value ? -1 : x.leaf!.value > y.leaf!.value ? 1 : Number(x.leaf!.leafIndex - y.leaf!.leafIndex)));
  return fits[0]!;
}
