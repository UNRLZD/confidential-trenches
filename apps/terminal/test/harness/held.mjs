// Whether a live check the e2e list runs starts the harness browser (scripts/harness-sockets.mjs), read from source
// (test/harness/sockets.test.mjs). Everything is inside the function: pnpm test's default tests reach no browser
// (scripts/ci/default-tests.mjs reads a module's top level and test calls, and the names this matches are text here).
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Why `file`, a live check the e2e list runs, could open a browser that routes no socket, or null; `rel` names a file
 * in the answer. A check that launches a browser imports the harness one; a check that launches none of its own
 * (app-release-sri and words-nov8-final read files, app-chains-evm runs two other checks' collects) is held through
 * every local module it imports, statically or by import(), that does.
 */
export function harnessProblem(file, rel, read = (f) => readFileSync(f, "utf8")) {
  const importsHarness = /^import \{[^}]*\blaunchHarnessBrowser\b[^}]*\} from "\.\.\/harness-sockets\.mjs";$/m;
  const launches = /\blaunch(?:Harness)?Browser\b|from "(?:\.\.\/browsers\.mjs|playwright[^"]*)"/;
  const localImport = /(?:\bfrom\s+|\bimport\s*\(?\s*)"(\.\.?\/[^"]+\.mjs)"/g;
  const text = read(file);
  if (launches.test(text)) return importsHarness.test(text) ? null : `${rel(file)} runs with --harness and never starts the harness browser`;
  for (const [, dep] of text.matchAll(localImport)) {
    const d = path.resolve(path.dirname(file), dep);
    const t = read(d);
    if (launches.test(t) && !importsHarness.test(t)) return `${rel(file)} runs with --harness and imports ${rel(d)}, which launches a browser and never starts the harness browser`;
  }
  return null;
}
