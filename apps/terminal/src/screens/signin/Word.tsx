import { WORDS } from "./words.ts";
import type { WordId } from "./words.ts";

/** One word of the table; a draft carries data-draft-copy, so a test and a reviewer can find every one on screen. */
export function W({ id }: { id: WordId }) {
  const w = WORDS[id];
  return w.draft ? <span data-draft-copy={id}>{w.text}</span> : <>{w.text}</>;
}

export const text = (id: WordId) => WORDS[id].text;
