// The one way a live check's record names a folder it read or wrote (card recordings-no-local-paths): a folder inside
// the repo by its repo path (apps/terminal/dist), the repo itself as ".", and any other folder by its own name alone
// (dist, tmp.cI2pD1U4Ff), so a recorded answer never holds the recording machine's folders. A screenshot is named by
// its file name in each check; scripts/ci/answers-no-local-paths.mjs refuses a recorded answer that holds either.
// Runs: once, no check of its own: the folder namer the recorders share (record-names.test.mjs holds it)
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A folder as a record names it: its path from `repo` when inside it, else its own name. */
export function named(dir, repo = REPO) {
  const abs = path.resolve(dir);
  const rel = path.relative(repo, abs);
  if (rel === "") return ".";
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : path.basename(abs);
}
