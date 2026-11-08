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
export { entropyToWords, wordsToSeed64 } from "../../wallet/src/derive/keys.ts";
