// SPDX-License-Identifier: Apache-2.0
// The Solana pool program's pinned code hash: the one "Program sha256:" line of contracts/pool-review-2.md, written
// from a build of the deploy sha, never carried over by reasoning (pool review round 2: a comment that added one line
// moved seven panic line numbers in the code, and its bytes with them). deploy.mjs refuses a public cluster's code
// whose sha256 is not the pin, and CI's pool-solana job holds its own build to it, so a source change that moves the
// bytes fails until the pin is moved by a build.
//   node contracts/pool-solana/scripts/pin.mjs <file.so>   exit 0 when the file's sha256 is the pin
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PIN_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pool-review-2.md");

/** The one pinned sha256 in `text` (the findings file's "Program sha256: `<64 hex>`" line); throws unless exactly one. */
export function pinnedSha(text) {
  const m = [...text.matchAll(/^Program sha256: `([0-9a-f]{64})`/gm)];
  if (m.length !== 1) throw new Error(`contracts/pool-review-2.md has ${m.length} "Program sha256:" lines, not one`);
  return m[0][1];
}

export const readPin = () => pinnedSha(readFileSync(PIN_FILE, "utf8"));

/** null when `sha` is the pin, else why the code is refused. */
export function pinRefusal(sha, pin) {
  return sha === pin ? null : `the code's sha256 ${sha} is not the pinned ${pin} (contracts/pool-review-2.md); a pin moves only with a build of the deploy sha`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const so = process.argv[2];
  if (!so) throw new Error("usage: node contracts/pool-solana/scripts/pin.mjs <file.so>");
  const sha = createHash("sha256").update(readFileSync(so)).digest("hex");
  const why = pinRefusal(sha, readPin());
  console.log(why ?? `pool-solana code: sha256 ${sha} is the pinned code (contracts/pool-review-2.md)`);
  process.exit(why ? 1 : 0);
}
