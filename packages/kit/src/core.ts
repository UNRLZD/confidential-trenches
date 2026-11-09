// The wallet core: for packages/ only (the signing page, the exit tool, a bot); an app never imports it
// (.dependency-cruiser.cjs kit-public-entry-only refuses it from apps/).
//
// It re-exports the wallet's own code, by relative path and unchanged, so a packages/ tool runs the wallet's rule
// itself and never a copy of it (card exit-note-scan: the exit tool runs the wallet's restore, vault paper 2.12 step 1,
// "This paper does not copy that walk"). The names are pinned in test/core-names.test.ts, so core never grows silently.
// No other file of the kit reaches this file or the wallet, by any path or by the kit's own name
// (.dependency-cruiser.cjs kit-entry-never-core), so the public entry (./index.ts) never holds the seed tools.
// Workspace only: the kit is never packed (every user takes it as workspace:*), so ../../wallet/src resolves in the tree.
export {
  restoreNotes,
  restorePages,
  walkLane,
  RESTORE_GAP,
  RESTORE_LANES,
  type NoteRestore,
  type RestoredNote,
  type RestoredSpend,
  type LaneWalk,
} from "../../wallet/src/notes/restore.ts";
export { noteSecrets, noteCommitment, type NoteRef } from "../../wallet/src/notes/secrets.ts";
export { refKey } from "../../wallet/src/notes/store.ts";
export { typedSeed } from "../../wallet/src/signin/words.ts";
export { armAccount, changeIndex, depositId, entropyToWords, refundId, returnId, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
// card exit-ids-out: the moves out of a one-time id or an arming account, each built and checked by the wallet's own
// payload rule before its private signer runs, and the reads they are built from (vault paper 2.12 step 5); and the
// settle of a spend of ours, signed by its own arming account (step 4)
export {
  buildMoveOut,
  buildRegisterOut,
  buildSettleOut,
  buildWithdrawOut,
  moveOutRpc,
  MoveOutRefused,
  readMoveOutFor,
  readSettle,
  readWithdrawOut,
  settleNeed,
  type BuiltMove,
  type MoveOutReadFor,
  type MoveOutRpc,
  type OwnKey,
  type RegisterOutReadFor,
  type SettleReadFor,
  type WithdrawOutReadFor,
  // card exit-withdraw: the withdrawal A sends itself (fee 0, to the typed account) and A's DeleteAccount to the typed
  // account once its spend reads settled with reserve 0 (vault paper 2.12 step 6), both through the same sealed signer
  buildVaultWithdrawOut,
  buildDeleteOut,
  SETTLE_BLOCKS,
  closeRefundsRan,
  keyNonceAt,
  type DeleteReadFor,
} from "../../wallet/src/deposit/moveout.ts";
// the token's storage minimum on both RPCs of the release pair: an unregistered typed account's registration deposit
export { readTokenStorageMin } from "../../wallet/src/arming/accounts.ts";
// the wallet's bound on two providers' final heights, which the exit tool's reads hold too
export { HEIGHT_SPREAD_MAX } from "../../wallet/src/deposit/account.ts";
// card exit-pool-notes: the Solana pool's restore from the 12 words, the wallet's own walk on two RPCs (its marks listed
// by one RPC and read by both when a lister is given, solanaMarksListed), with the pool's address and scope and the
// wallet's refusal of one provider twice
export { solanaRestoreNotes, type SolanaRestoredNote, type SolanaRestoredSpend } from "../../wallet/src/pool/solana-restore.ts";
export { solanaPoolOf, checkSolanaRpcs } from "../../wallet/src/pool/solana.ts";
