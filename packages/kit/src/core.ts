// The wallet core: for packages/ only (the signing page, the exit tool, a bot); an app never imports it
// (.dependency-cruiser.cjs kit-public-entry-only refuses it from apps/).
//
// It re-exports the wallet's own code, by relative path and unchanged, so a packages/ tool runs the wallet's rule
// itself and never a copy of it (card exit-note-scan: the exit tool runs the wallet's restore, vault paper 2.12 step 1,
// "This paper does not copy that walk"). The names are pinned in test/core-names.test.ts, so core never grows silently.
// The kit's public entry (./index.ts) never reaches this file.
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
