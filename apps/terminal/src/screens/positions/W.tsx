import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";

/** One word from WORDS; a draft is drawn with data-draft-copy (the card's report lists them). */
export function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={w.text}>{w.text}</span> : <>{w.text}</>;
}
