// Card wallet-u-restore-exit: runs test/near-out-ids.cases.ts in its own node with module mocks on (node:test's
// mock.module needs --experimental-test-module-mocks, which the package's test command does not pass).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("near-out moves what the vault scope's deposit ids hold to the typed account, and stops naming an id it cannot read (test/near-out-ids.cases.ts)", () => {
  const cases = fileURLToPath(new URL("./near-out-ids.cases.ts", import.meta.url));
  // the child runs on its own: with this runner's NODE_TEST_CONTEXT it would report into this run and exit 0 whatever failed
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-reporter=spec", cases], { encoding: "utf8", timeout: 120_000, env });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
